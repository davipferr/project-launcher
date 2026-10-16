// Renderer: plain DOM, no framework. Everything privileged goes through
// window.api (see preload.js).
// `api` is the global that preload.js exposes. (Re-declaring it with
// `const api = window.api` would throw: contextBridge globals are non-configurable.)

const state = {
  root: '',
  projects: [],
  byPath: new Map(),
  git: new Map(), // path -> status object | undefined while loading
  runs: new Map(), // runId -> meta
  logs: new Map(), // runId -> lines[] (only for runs we've opened)
  selected: null, // project path
  selectedRun: new Map(), // project path -> runId shown in the log view
  filter: 'all',
  query: '',
  portfolio: { path: null, entries: {} }, // entries: projectPath -> slug
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const units = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return `${s}s ago`;
}

function duration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function call(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    // ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: msg"
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    throw err;
  }
}

// ---- data loading ----------------------------------------------------------
async function scan() {
  $('#project-list').innerHTML = '<div class="loading">Scanning…</div>';
  const res = await call(api.scan);
  state.root = res.root;
  state.projects = res.projects;
  state.byPath = new Map(res.projects.map((p) => [p.path, p]));
  $('#root-label').textContent = res.error || `${res.projects.length} projects in ${res.root}`;
  $('#root-label').classList.toggle('error', !!res.error);
  if (state.selected && !state.byPath.has(state.selected)) state.selected = null;
  state.portfolio = await api.portfolioInfo();
  renderList();
  renderDetail();
  refreshGit();
}

let lastGitRefresh = 0;
let gitPass = 0;
/**
 * Re-reads git status for every repo. Each repo costs a git process, and on Windows starting
 * ~50 of them at once stalls the whole app for seconds. So with `gentle`, the `first` paths are
 * done right away and the rest one at a time with a pause in between.
 */
async function refreshGit({ gentle = false, first = [] } = {}) {
  lastGitRefresh = Date.now();
  const pass = ++gitPass;
  const repos = state.projects.filter((p) => p.isGit);
  if (!gentle) return Promise.all(repos.map(updateGit));
  await Promise.all(repos.filter((p) => first.includes(p.path)).map(updateGit));
  for (const p of repos.filter((p) => !first.includes(p.path))) {
    if (pass !== gitPass) return; // a newer refresh took over
    await updateGit(p);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function updateGit(p) {
  return api.gitStatus(p.path).then((s) => {
    state.git.set(p.path, s);
    updateRow(p.path);
    if (state.selected === p.path) renderGit();
  });
}

function replaceProject(updated) {
  const i = state.projects.findIndex((p) => p.path === updated.path);
  if (i !== -1) state.projects[i] = updated;
  state.byPath.set(updated.path, updated);
  updateRow(updated.path);
  if (state.selected === updated.path) renderDetail();
}

// ---- project list ----------------------------------------------------------
const runsFor = (p) => [...state.runs.values()].filter((r) => r.projectPath === p);
const isRunning = (p) => runsFor(p).some((r) => r.status === 'running');

function matches(p) {
  const g = state.git.get(p.path);
  if (state.filter === 'favorites' && !p.favorite) return false;
  if (state.filter === 'running' && !isRunning(p.path)) return false;
  if (state.filter === 'dirty' && !(g?.ok && g.dirty)) return false;
  if (!state.query) return true;
  const hay = `${p.name} ${p.category} ${p.types.join(' ')} ${g?.branch || ''}`.toLowerCase();
  return state.query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function visibleProjects() {
  const list = state.projects.filter(matches);
  // Favorites float to the top of their category.
  return list.sort((a, b) => a.category.localeCompare(b.category) || b.favorite - a.favorite || a.name.localeCompare(b.name));
}

function gitSummary(p) {
  if (!p.isGit) return '<span class="muted">no git</span>';
  const g = state.git.get(p.path);
  if (!g) return '<span class="muted">…</span>';
  if (!g.ok) return '<span class="warn" title="' + esc(g.error) + '">git error</span>';
  const bits = [`<span class="branch">${esc(g.branch)}</span>`];
  if (g.ahead) bits.push(`<span class="ahead" title="${g.ahead} commit(s) to push">↑${g.ahead}</span>`);
  if (g.behind) bits.push(`<span class="behind" title="${g.behind} commit(s) to pull">↓${g.behind}</span>`);
  if (g.dirty) bits.push(`<span class="dirty" title="${g.dirty} uncommitted change(s)">●${g.dirty}</span>`);
  return bits.join('');
}

function rowHtml(p) {
  const running = isRunning(p.path);
  const g = state.git.get(p.path);
  const quick = running
    ? `<button class="row-btn stop" data-action="stop-project" title="Stop">■</button>`
    : p.defaultCommandId
      ? `<button class="row-btn play" data-action="run-default" title="${esc(p.commands.find((c) => c.id === p.defaultCommandId)?.label)}">▶</button>`
      : '';
  return `
    <div class="row-main">
      <span class="status-dot ${running ? 'running' : ''}"></span>
      <span class="name">${p.favorite ? '<span class="star">★</span>' : ''}${esc(p.name)}${state.portfolio.entries[p.path] ? '<span class="in-pf" title="In your portfolio">✦</span>' : ''}</span>
      <span class="types">${p.types.slice(0, 3).map((t) => `<span class="badge t-${t}">${t}</span>`).join('')}</span>
      ${quick}
    </div>
    <div class="row-sub">
      ${gitSummary(p)}
      ${g?.lastCommit ? `<span class="muted when">${ago(g.lastCommit.time)}</span>` : ''}
    </div>`;
}

function renderList() {
  const list = visibleProjects();
  const el = $('#project-list');
  if (!list.length) {
    el.innerHTML = `<div class="loading">${state.projects.length ? 'No matches' : 'No projects found'}</div>`;
    return;
  }
  let html = '';
  let cat = null;
  for (const p of list) {
    if (p.category !== cat) {
      cat = p.category;
      html += `<div class="category">${esc(cat)}</div>`;
    }
    html += `<div class="project-row ${p.path === state.selected ? 'selected' : ''}" data-path="${esc(p.path)}" tabindex="0">${rowHtml(p)}</div>`;
  }
  el.innerHTML = html;
}

function updateRow(path) {
  const p = state.byPath.get(path);
  const row = [...document.querySelectorAll('.project-row')].find((r) => r.dataset.path === path);
  // A git/run change can move a project in or out of the current filter.
  if (!p || !row || !matches(p)) {
    if ((row && !(p && matches(p))) || (!row && p && matches(p))) renderList();
    return;
  }
  row.innerHTML = rowHtml(p);
}

// ---- detail pane -----------------------------------------------------------
function renderDetail() {
  const p = state.byPath.get(state.selected);
  const el = $('#detail');
  if (!p) {
    el.innerHTML = '<div class="empty">Select a project</div>';
    return;
  }
  el.innerHTML = `
    <div class="d-header">
      <div>
        <h1>${esc(p.name)} <button class="fav ${p.favorite ? 'on' : ''}" data-action="favorite" title="Favorite">${p.favorite ? '★' : '☆'}</button></h1>
        <div class="path" title="${esc(p.path)}">${esc(p.path)}</div>
      </div>
      <div class="actions">
        ${portfolioButton(p)}
        <button data-action="editor" title="Open in editor (E)">⌨ Editor</button>
        <button data-action="folder" title="Open in Explorer">🗀 Folder</button>
        <button data-action="terminal" title="Open a terminal here (T)">›_ Terminal</button>
      </div>
    </div>
    <div class="d-grid">
      <section class="card" id="d-commands"></section>
      <section class="card" id="d-git"></section>
    </div>
    <section class="card runs" id="d-runs"></section>`;
  renderCommands();
  renderGit();
  renderRuns();
}

function portfolioButton(p) {
  if (!state.portfolio.path || p.path === state.portfolio.path) return '';
  return state.portfolio.entries[p.path]
    ? '<button data-action="portfolio" title="Edit this project’s entry in your portfolio">✦ Portfolio entry</button>'
    : '<button data-action="portfolio" class="primary" title="Write a portfolio entry for this project">✦ Add to portfolio</button>';
}

function renderCommands() {
  const p = state.byPath.get(state.selected);
  const el = $('#d-commands');
  if (!p || !el) return;
  const runningIds = new Set(runsFor(p.path).filter((r) => r.status === 'running').map((r) => r.commandId));
  const items = p.commands.map((c) => `
    <li class="cmd ${c.id === p.defaultCommandId ? 'default' : ''}" data-command="${esc(c.id)}">
      <button class="play-sm" data-action="run" title="Run">${c.open ? '↗' : '▶'}</button>
      <span class="cmd-label" title="${esc(c.cmd || c.open)}">${esc(c.label)}</span>
      ${runningIds.has(c.id) ? '<span class="pill running">running</span>' : ''}
      ${c.custom ? '<button class="ghost" data-action="remove-command" title="Remove">✕</button>' : ''}
      <button class="ghost pin" data-action="set-default" title="Make this the ▶ default">${c.id === p.defaultCommandId ? '●' : '○'}</button>
    </li>`).join('');
  el.innerHTML = `
    <h2>Commands</h2>
    ${p.commands.length ? `<ul class="cmds">${items}</ul>` : '<p class="muted">Nothing detected. Add your own below.</p>'}
    <form class="add-cmd" data-action="add-command">
      <input name="cmd" placeholder="Custom command, e.g. npm run dev -- --port 4000" spellcheck="false" required />
      <button>Add</button>
    </form>`;
}

function renderGit() {
  const p = state.byPath.get(state.selected);
  const el = $('#d-git');
  if (!p || !el) return;
  if (!p.isGit) {
    el.innerHTML = '<h2>Git</h2><p class="muted">Not a git repository.</p>';
    return;
  }
  const g = state.git.get(p.path);
  if (!g) {
    el.innerHTML = '<h2>Git</h2><p class="muted">Loading…</p>';
    return;
  }
  if (!g.ok) {
    el.innerHTML = `<h2>Git</h2><p class="warn">${esc(g.error)}</p>`;
    return;
  }
  const sync = !g.upstream
    ? '<span class="muted">no upstream</span>'
    : g.ahead || g.behind
      ? `${g.ahead ? `<span class="ahead">↑${g.ahead} to push</span>` : ''} ${g.behind ? `<span class="behind">↓${g.behind} to pull</span>` : ''}`
      : `<span class="ok">in sync with ${esc(g.upstream)}</span>`;
  const counts = [
    g.staged && `${g.staged} staged`,
    g.modified && `${g.modified} modified`,
    g.untracked && `${g.untracked} untracked`,
    g.conflicts && `<span class="warn">${g.conflicts} conflicts</span>`,
  ].filter(Boolean).join(' · ');
  el.innerHTML = `
    <h2>Git <button class="ghost" data-action="refresh-git" title="Refresh">⟳</button></h2>
    <div class="kv"><span>Branch</span><span class="branch">${esc(g.branch)}</span></div>
    <div class="kv"><span>Remote</span><span>${sync}</span></div>
    ${g.lastCommit ? `<div class="kv"><span>Last commit</span><span title="${esc(new Date(g.lastCommit.time).toLocaleString())}">${esc(g.lastCommit.subject)} <span class="muted">— ${esc(g.lastCommit.author)}, ${ago(g.lastCommit.time)}</span></span></div>` : ''}
    <div class="kv"><span>Working tree</span><span>${g.dirty ? counts : '<span class="ok">clean</span>'}</span></div>
    ${g.files.length ? `<ul class="files">${g.files.map((f) => `<li><code class="xy">${esc(f.xy)}</code>${esc(f.path)}</li>`).join('')}</ul>` : ''}`;
}

function renderRuns() {
  const p = state.byPath.get(state.selected);
  const el = $('#d-runs');
  if (!p || !el) return;
  const runs = runsFor(p.path).sort((a, b) => b.startedAt - a.startedAt);
  if (!runs.length) {
    el.innerHTML = '<h2>Output</h2><p class="muted">Run a command to see its output here.</p>';
    return;
  }
  let current = state.runs.get(state.selectedRun.get(p.path));
  if (!current || current.projectPath !== p.path) {
    current = runs[0];
    state.selectedRun.set(p.path, current.id);
  }
  const tabs = runs.map((r) => `
    <button class="tab ${r.id === current.id ? 'active' : ''}" data-action="select-run" data-run="${r.id}">
      <span class="status-dot ${r.status}"></span>${esc(r.label)}
    </button>`).join('');
  const elapsed = (r) => duration((r.endedAt || Date.now()) - r.startedAt);
  const statusText = current.status === 'running'
    ? `running · pid ${current.pid} · <span data-elapsed>${elapsed(current)}</span>`
    : current.status === 'failed'
      ? `<span class="warn">failed (exit ${current.exitCode ?? '?'})</span> · ran ${elapsed(current)}`
      : `exited · ran ${elapsed(current)}`;
  el.innerHTML = `
    <div class="runs-head">
      <div class="tabs">${tabs}</div>
      <div class="run-actions">
        <span class="muted run-status">${statusText}</span>
        ${current.url && current.status === 'running' ? `<button data-action="open-url" class="link" title="${esc(current.url)}">↗ ${esc(current.url.replace(/^https?:\/\//, ''))}</button>` : ''}
        ${current.status === 'running'
          ? `<button data-action="stop-run" class="danger">■ Stop</button>`
          : `<button data-action="restart-run">↻ Run again</button><button data-action="remove-run" class="ghost" title="Close">✕</button>`}
      </div>
    </div>
    <pre class="log" id="log"></pre>`;
  loadLog(current.id);
}

async function loadLog(runId) {
  if (!state.logs.has(runId)) state.logs.set(runId, await api.getLogs(runId));
  const pre = $('#log');
  if (!pre || state.selectedRun.get(state.selected) !== runId) return;
  pre.innerHTML = state.logs.get(runId).map(lineHtml).join('');
  pre.scrollTop = pre.scrollHeight;
}

function lineHtml(l) {
  const text = esc(l.text).replace(/(https?:\/\/[^\s&<]+)/g, '<a data-action="open-link" href="#">$1</a>');
  return `<div class="l ${l.s}">${text || ' '}</div>`;
}

// ---- process events from main ---------------------------------------------
api.onRunUpdate((meta) => {
  const prev = state.runs.get(meta.id);
  state.runs.set(meta.id, meta);
  if (!prev) state.selectedRun.set(meta.projectPath, meta.id); // jump to new runs
  updateRow(meta.projectPath);
  if (state.selected === meta.projectPath) {
    renderCommands();
    renderRuns();
  }
  if (prev?.status === 'running' && meta.status === 'failed') toast(`${meta.projectName}: ${meta.label} failed (exit ${meta.exitCode})`);
});

api.onRunLogs((batch) => {
  const pre = $('#log');
  const shownRun = state.selectedRun.get(state.selected);
  const stick = pre && pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  let html = '';
  for (const [id, line] of batch) {
    const lines = state.logs.get(id);
    if (!lines) continue; // not loaded yet; loadLog will fetch the full buffer
    // A batch can overlap with what getLogs already returned.
    if (lines.length && line.n <= lines[lines.length - 1].n) continue;
    lines.push(line);
    if (lines.length > 3000) lines.splice(0, lines.length - 3000);
    if (id === shownRun) html += lineHtml(line);
  }
  if (pre && html) {
    pre.insertAdjacentHTML('beforeend', html);
    while (pre.childElementCount > 3000) pre.firstElementChild.remove();
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
});

api.onRunRemoved((id) => {
  const meta = state.runs.get(id);
  state.runs.delete(id);
  state.logs.delete(id);
  if (meta) {
    updateRow(meta.projectPath);
    if (state.selected === meta.projectPath) renderRuns();
  }
});

api.onToast(toast);

// Coming back to the launcher after committing in another window: refresh, starting with the
// selected project and the portfolio, and gently for the rest so switching back stays smooth.
api.onFocus(() => {
  if (Date.now() - lastGitRefresh > 5000) refreshGit({ gentle: true, first: [state.selected, state.portfolio.path] });
});

// Tick the "running for 3m 12s" label.
setInterval(() => {
  const el = document.querySelector('[data-elapsed]');
  const r = state.runs.get(state.selectedRun.get(state.selected));
  if (el && r?.status === 'running') el.textContent = duration(Date.now() - r.startedAt);
}, 1000);

// ---- user actions ----------------------------------------------------------
function select(path) {
  state.selected = path;
  document.querySelectorAll('.project-row').forEach((r) => r.classList.toggle('selected', r.dataset.path === path));
  renderDetail();
}

async function startCommand(p, commandId) {
  const run = await call(api.start, p.path, commandId);
  if (!run) toast('Opened in browser');
}

const actions = {
  'run-default': (p) => startCommand(p, p.defaultCommandId),
  'stop-project': (p) => runsFor(p.path).filter((r) => r.status === 'running').forEach((r) => api.stop(r.id)),
  run: (p, el) => startCommand(p, el.closest('[data-command]').dataset.command),
  'set-default': async (p, el) => replaceProject(await call(api.setDefaultCommand, p.path, el.closest('[data-command]').dataset.command)),
  'remove-command': async (p, el) => replaceProject(await call(api.removeCommand, p.path, el.closest('[data-command]').dataset.command)),
  favorite: async (p) => {
    replaceProject(await call(api.toggleFavorite, p.path));
    renderList();
  },
  editor: (p) => call(api.openEditor, p.path),
  folder: (p) => call(api.openFolder, p.path),
  terminal: (p) => call(api.openTerminal, p.path),
  'refresh-git': async (p) => {
    state.git.set(p.path, await api.gitStatus(p.path));
    renderGit();
    updateRow(p.path);
  },
  'select-run': (p, el) => {
    state.selectedRun.set(p.path, el.dataset.run);
    renderRuns();
  },
  'stop-run': (p) => api.stop(state.selectedRun.get(p.path)),
  'restart-run': (p) => startCommand(p, state.runs.get(state.selectedRun.get(p.path)).commandId),
  'remove-run': (p) => api.removeRun(state.selectedRun.get(p.path)),
  'open-url': (p) => api.openUrl(state.runs.get(state.selectedRun.get(p.path)).url),
  'open-link': (_p, el) => api.openUrl(el.textContent),
  portfolio: (p) => openPortfolioForm(p),
};

document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  const row = e.target.closest('.project-row');
  const path = row ? row.dataset.path : state.selected;
  if (actionEl && actionEl.tagName !== 'FORM') {
    e.preventDefault();
    e.stopPropagation();
    const p = state.byPath.get(path);
    if (p && actions[actionEl.dataset.action]) actions[actionEl.dataset.action](p, actionEl);
    return;
  }
  if (row) select(row.dataset.path);
});

document.addEventListener('submit', async (e) => {
  if (e.target.dataset.action !== 'add-command') return;
  e.preventDefault();
  const p = state.byPath.get(state.selected);
  const cmd = new FormData(e.target).get('cmd');
  if (p && cmd) replaceProject(await call(api.addCommand, p.path, '', cmd));
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  renderList();
});

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.filter = chip.dataset.filter;
    renderList();
  }),
);

$('#refresh').addEventListener('click', scan);

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.key === '/' && !typing) || (e.ctrlKey && e.key === 'f')) {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  } else if (e.ctrlKey && e.key === 'r') {
    e.preventDefault();
    scan();
  } else if (e.key === 'Escape' && document.activeElement === $('#search')) {
    $('#search').value = '';
    state.query = '';
    renderList();
    $('#search').blur();
  } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const list = visibleProjects();
    const i = list.findIndex((p) => p.path === state.selected);
    const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      select(next.path);
      document.querySelector('.project-row.selected')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (!typing && state.selected) {
    const p = state.byPath.get(state.selected);
    if (e.key === 'Enter' && p.defaultCommandId && !isRunning(p.path)) actions['run-default'](p);
    else if (e.key === 'e') actions.editor(p);
    else if (e.key === 't') actions.terminal(p);
  }
});

// ---- settings --------------------------------------------------------------
const dlg = $('#settings-dialog');
$('#settings-btn').addEventListener('click', async () => {
  const s = await api.getSettings();
  $('#settings-root').textContent = s.root;
  $('#settings-editor').value = s.editor;
  showPortfolioSetting(s);
  dlg.showModal();
});
function showPortfolioSetting(s) {
  $('#settings-portfolio').textContent = s.portfolio || (state.portfolio.path ? `${state.portfolio.path} (auto-detected)` : 'not found');
}
$('#choose-portfolio').addEventListener('click', async () => {
  const s = await call(api.choosePortfolio);
  if (!s) return;
  showPortfolioSetting(s);
  state.portfolio = await api.portfolioInfo();
  renderList();
  renderDetail();
});
$('#choose-root').addEventListener('click', async () => {
  const s = await call(api.chooseRoot);
  if (s) {
    $('#settings-root').textContent = s.root;
    scan();
  }
});
$('#save-settings').addEventListener('click', () => call(api.setEditor, $('#settings-editor').value));

// ---- add to portfolio --------------------------------------------------------
// The form edits one content/projects/<slug>.json in the portfolio clone. Main
// writes it and runs the site's `npm run validate`; nothing is committed.
const pfDialog = $('#portfolio-dialog');
const pfForm = $('#portfolio-form');
let pf = null; // { project, portfolio, entry, existing, options }

async function openPortfolioForm(p) {
  const data = await call(api.portfolioPrefill, p.path);
  pf = { project: p, ...data };
  renderPortfolioForm();
  pfDialog.showModal();
  pfForm.querySelector(pf.existing ? '[name="tagline.pt"]' : '[name="title"]').focus();
}

function renderPortfolioForm() {
  const { entry: e, options: o, existing, portfolio } = pf;
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const constellations = o.constellations.map((z) => {
    const mine = e.constellation === z.id;
    const used = z.used - (mine && existing ? 1 : 0);
    const full = used >= z.stars;
    return opt(z.id, `${z.name.en} · ${used}/${z.stars} stars taken${full ? ' (full: shown by category)' : ''}`, mine);
  }).join('');
  const lang = (code, title) => `
    <fieldset class="pf-lang">
      <legend>${title}</legend>
      <label><span>Tagline <span class="hint">one line, shown on cards</span></span>
        <input name="tagline.${code}" value="${esc(e.tagline?.[code])}" required />
      </label>
      <label><span>Description <span class="hint">blank line = new paragraph</span></span>
        <textarea name="description.${code}" rows="7" required>${esc(e.description?.[code])}</textarea>
      </label>
    </fieldset>`;
  pfForm.innerHTML = `
    <h2>${existing ? 'Edit portfolio entry' : 'Add to portfolio'} <span class="muted">${esc(pf.project.name)}</span></h2>
    <p class="hint">Writes <code>content/projects/<span data-slug>${esc(e.slug)}</span>.json</code> in <code>${esc(portfolio)}</code>, then runs <code>npm run validate</code>. Nothing is committed.</p>
    <div class="pf-grid">
      <label>Title <input name="title" value="${esc(e.title)}" maxlength="60" required /></label>
      <label>Slug <input name="slug" value="${esc(e.slug)}" pattern="[a-z0-9]+(-[a-z0-9]+)*" ${existing ? 'readonly title="An existing entry keeps its file name"' : ''} required /></label>
      <label>Category <select name="category">${o.categories.map((c) => opt(c, c, c === e.category)).join('')}</select></label>
      <label>Constellation <select name="constellation">${opt('', 'None (grouped by category)', !e.constellation)}${constellations}</select></label>
      <label>Started <input name="date" type="date" value="${esc(e.date)}" required /></label>
      <label>Status <select name="status">${opt('', '—', !e.status)}${o.statuses.map((s) => opt(s, s, s === e.status)).join('')}</select></label>
      <label class="wide"><span>Tags <span class="hint">comma separated</span></span><input name="tags" value="${esc((e.tags || []).join(', '))}" spellcheck="false" /></label>
      <label class="wide">Repository <input name="repoUrl" type="url" value="${esc(e.repoUrl)}" placeholder="https://github.com/…" spellcheck="false" /></label>
      <label class="wide">Live demo <input name="liveUrl" type="url" value="${esc(e.liveUrl)}" placeholder="https://…" spellcheck="false" /></label>
      <label class="wide check"><input name="featured" type="checkbox" ${e.featured ? 'checked' : ''} /> Featured <span class="hint">listed first, bigger star, first pick of constellation stars</span></label>
    </div>
    <div class="pf-langs">${lang('en', 'English')}${lang('pt', 'Português')}</div>
    <pre class="pf-output" hidden></pre>
    <div class="row end">
      ${existing ? '<button type="button" data-pf="remove" class="danger pf-remove">Remove from portfolio</button>' : ''}
      <button type="button" data-pf="close">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>`;
}

function readPortfolioForm() {
  const f = new FormData(pfForm);
  const get = (k) => String(f.get(k) ?? '').trim();
  return {
    ...pf.entry, // keeps fields the form doesn't edit (cover, images)
    slug: get('slug'),
    title: get('title'),
    tagline: { en: get('tagline.en'), pt: get('tagline.pt') },
    description: { en: get('description.en'), pt: get('description.pt') },
    category: get('category'),
    constellation: get('constellation'),
    tags: get('tags').split(',').map((t) => t.trim()).filter(Boolean),
    repoUrl: get('repoUrl'),
    liveUrl: get('liveUrl'),
    featured: f.get('featured') === 'on',
    date: get('date'),
    status: get('status'),
  };
}

function showPortfolioResult(text, kind) {
  const out = pfForm.querySelector('.pf-output');
  out.hidden = false;
  out.className = `pf-output ${kind}`;
  out.textContent = text;
  out.scrollIntoView({ block: 'nearest' });
}

pfForm.addEventListener('input', (e) => {
  if (e.target.name === 'slug') pfForm.querySelector('[data-slug]').textContent = e.target.value;
});

pfForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pfForm.reportValidity()) return;
  const entry = readPortfolioForm();
  const saveBtn = pfForm.querySelector('[type="submit"]');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Validating…';
  try {
    const res = await call(api.portfolioSave, pf.project.path, entry);
    if (!res.ok) {
      showPortfolioResult(`Not saved: npm run validate failed.\n\n${res.output}`, 'error');
      return;
    }
    pf.entry = entry;
    pf.existing = true;
    state.portfolio = await api.portfolioInfo();
    renderList();
    renderDetail();
    refreshPortfolioGit();
    const pp = state.byPath.get(state.portfolio.path);
    pfForm.innerHTML = `
      <h2>✦ ${res.created ? 'Added to' : 'Updated in'} your portfolio</h2>
      <p>Wrote <code>content/projects/${esc(res.slug)}.json</code>. <span class="ok">npm run validate passed.</span></p>
      ${res.warnings.length ? `<pre class="pf-output warn">${esc(res.warnings.join('\n'))}</pre>` : ''}
      <p class="hint">Nothing was committed. Review the change, then commit and push the portfolio to publish it.</p>
      <div class="row end">
        ${pp?.defaultCommandId ? '<button type="button" data-pf="preview">▶ Preview site</button>' : ''}
        <button type="button" data-pf="close" class="primary">Done</button>
      </div>`;
  } catch {
    // call() already showed the error
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
});

pfForm.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-pf]')?.dataset.pf;
  if (action === 'close') pfDialog.close();
  if (action === 'remove') {
    const res = await call(api.portfolioRemove, pf.project.path, pf.entry.slug);
    if (!res) return; // cancelled in the confirmation box
    pfDialog.close();
    state.portfolio = await api.portfolioInfo();
    renderList();
    renderDetail();
    refreshPortfolioGit();
    toast(`Removed ${res.slug} from your portfolio. Nothing was committed.`);
  }
  if (action === 'preview') {
    const pp = state.byPath.get(state.portfolio.path);
    pfDialog.close();
    if (!pp) return;
    if (!isRunning(pp.path)) startCommand(pp, pp.defaultCommandId);
    select(pp.path);
    document.querySelector('.project-row.selected')?.scrollIntoView({ block: 'nearest' });
  }
});

function refreshPortfolioGit() {
  const pp = state.byPath.get(state.portfolio.path);
  if (pp?.isGit) actions['refresh-git'](pp);
}


// ---- boot ------------------------------------------------------------------
(async () => {
  for (const r of await api.listRuns()) state.runs.set(r.id, r);
  await scan();
})();
