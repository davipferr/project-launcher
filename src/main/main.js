// Electron main process: owns the window, the filesystem, git and child
// processes. The renderer (the UI) can only reach these through the small IPC
// API exposed in preload.js.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { Settings } = require('./settings');
const projects = require('./projects');
const git = require('./git');
const portfolio = require('./portfolio');
const { ProcessManager } = require('./processes');

const IS_WIN = process.platform === 'win32';

let win = null;
let settings = null;
const pm = new ProcessManager();
/** Last scan result, keyed by path. IPC calls are validated against this so
 *  the renderer can only act on projects we actually discovered. */
let known = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#15171c',
    title: 'Project Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never let the UI navigate away or open new Electron windows; send links
  // to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (!confirmQuit()) e.preventDefault();
  });
  win.on('focus', () => send('window:focus'));
  win.on('closed', () => (win = null));
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Closing with servers still running asks first — otherwise you'd silently
// lose them (or worse, leave orphans holding ports).
let quitConfirmed = false;
function confirmQuit() {
  const n = pm.runningCount();
  if (quitConfirmed || n === 0 || !win || win.isDestroyed()) return true;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    buttons: ['Stop all and quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `${n} process${n > 1 ? 'es are' : ' is'} still running.`,
    detail: 'Quitting will stop them.',
  });
  quitConfirmed = choice === 0;
  return quitConfirmed;
}

// ---- process events -> renderer -------------------------------------------
// A chatty dev server can print thousands of lines per second; batch log
// lines and ship them every 50 ms instead of one IPC message per line.
let pendingLogs = [];
let flushTimer = null;
pm.on('log', (id, line) => {
  pendingLogs.push([id, line]);
  flushTimer ??= setTimeout(() => {
    send('run:logs', pendingLogs);
    pendingLogs = [];
    flushTimer = null;
  }, 50);
});
pm.on('update', (meta) => send('run:update', meta));
pm.on('removed', (id) => send('run:removed', id));

// ---- helpers ---------------------------------------------------------------
function project(p) {
  const proj = known.get(p);
  if (!proj) throw new Error(`Unknown project: ${p}`);
  return proj;
}

function withCustom(proj) {
  const s = settings.get();
  const custom = (s.customCommands[proj.path] || []).map((c) => ({
    id: c.id, label: c.label || c.cmd, cmd: c.cmd, cwd: proj.path, custom: true,
  }));
  const commands = [...custom, ...proj.commands];
  // The user's chosen default goes first; that's what the ▶ button runs.
  const defId = s.defaultCommand[proj.path];
  const def = commands.find((c) => c.id === defId);
  return {
    ...proj,
    commands,
    defaultCommandId: def ? def.id : projects.pickDefault(commands),
    favorite: s.favorites.includes(proj.path),
  };
}

/** The portfolio clone: the one chosen in settings, else the first scanned project that looks like one. */
async function portfolioDir() {
  const chosen = settings.get().portfolio;
  if (chosen) return (await portfolio.isPortfolio(chosen)) ? chosen : null;
  for (const p of known.values()) if (await portfolio.isPortfolio(p.path)) return p.path;
  return null;
}

async function requirePortfolio() {
  const dir = await portfolioDir();
  if (!dir) throw new Error('No portfolio folder found. Choose it in Settings.');
  return dir;
}

function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.on('error', (err) => send('toast', `Could not run ${cmd}: ${err.message}`));
  child.unref(); // don't keep the launcher tied to apps it opened
}

function openTerminal(dir) {
  if (IS_WIN) {
    // Prefer Windows Terminal; fall back to a classic PowerShell console.
    const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    if (fs.existsSync(wt)) return detached(wt, ['-d', dir]);
    return detached('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit'], { cwd: dir });
  }
  if (process.platform === 'darwin') return detached('open', ['-a', 'Terminal', dir]);
  return detached('x-terminal-emulator', [], { cwd: dir });
}

// ---- IPC -------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('settings:get', () => settings.get());

  ipcMain.handle('settings:chooseRoot', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose your projects folder',
      defaultPath: settings.get().root,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return settings.update((s) => (s.root = res.filePaths[0]));
  });

  ipcMain.handle('settings:setEditor', (_e, editor) => {
    if (typeof editor !== 'string' || !editor.trim()) throw new Error('Editor command required');
    return settings.update((s) => (s.editor = editor.trim()));
  });

  ipcMain.handle('settings:choosePortfolio', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose your portfolio folder',
      defaultPath: settings.get().portfolio || settings.get().root,
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    if (!(await portfolio.isPortfolio(res.filePaths[0]))) {
      throw new Error('That folder has no content/project.schema.json, so it is not the portfolio.');
    }
    return settings.update((s) => (s.portfolio = res.filePaths[0]));
  });

  ipcMain.handle('projects:scan', async () => {
    const { root } = settings.get();
    if (!fs.existsSync(root)) return { root, projects: [], error: `Folder not found: ${root}` };
    const found = await projects.scan(root);
    known = new Map(found.map((p) => [p.path, p]));
    return { root, projects: found.map(withCustom) };
  });

  ipcMain.handle('projects:git', (_e, p) => git.status(project(p).path));

  ipcMain.handle('projects:toggleFavorite', (_e, p) => {
    project(p);
    settings.update((s) => {
      s.favorites = s.favorites.includes(p) ? s.favorites.filter((f) => f !== p) : [...s.favorites, p];
    });
    return withCustom(project(p));
  });

  ipcMain.handle('projects:setDefault', (_e, p, commandId) => {
    project(p);
    settings.update((s) => (s.defaultCommand[p] = commandId));
    return withCustom(project(p));
  });

  ipcMain.handle('projects:addCommand', (_e, p, label, cmd) => {
    project(p);
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('Command required');
    const id = `custom:${Date.now().toString(36)}`;
    settings.update((s) => {
      (s.customCommands[p] ||= []).push({ id, label: (label || '').trim() || cmd.trim(), cmd: cmd.trim() });
      s.defaultCommand[p] = id;
    });
    return withCustom(project(p));
  });

  ipcMain.handle('projects:removeCommand', (_e, p, id) => {
    project(p);
    settings.update((s) => {
      s.customCommands[p] = (s.customCommands[p] || []).filter((c) => c.id !== id);
      if (s.defaultCommand[p] === id) delete s.defaultCommand[p];
    });
    return withCustom(project(p));
  });

  // ---- portfolio ----
  /** Where the portfolio is and which scanned projects already have an entry in it. */
  ipcMain.handle('portfolio:info', async () => {
    const dir = await portfolioDir();
    if (!dir) return { path: null, entries: {} };
    const slugs = new Set((await portfolio.listEntries(dir)).map((e) => e.slug));
    const remembered = settings.get().portfolioEntries;
    const entries = {};
    for (const p of known.values()) {
      const slug = [remembered[p.path], portfolio.slugify(p.name)].find((s) => s && slugs.has(s));
      if (slug) entries[p.path] = slug;
    }
    return { path: dir, entries };
  });

  ipcMain.handle('portfolio:prefill', async (_e, p) => {
    const proj = project(p);
    const dir = await requirePortfolio();
    const { entry, existing } = await portfolio.prefill(dir, proj, settings.get().portfolioEntries[p]);
    return { portfolio: dir, entry, existing, options: await portfolio.options(dir) };
  });

  ipcMain.handle('portfolio:save', async (_e, p, entry) => {
    project(p);
    const dir = await requirePortfolio();
    const result = await portfolio.save(dir, entry);
    if (result.ok) settings.update((s) => (s.portfolioEntries[p] = result.slug));
    return result;
  });

  ipcMain.handle('portfolio:remove', async (_e, p, slug) => {
    project(p);
    const dir = await requirePortfolio();
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove "${slug}" from your portfolio?`,
      detail: `Deletes content/projects/${slug}.json and public/projects/${slug}/ in ${dir}. Nothing is committed, so you can still restore it with git.`,
    });
    if (choice.response !== 0) return null;
    const result = await portfolio.remove(dir, slug);
    settings.update((s) => delete s.portfolioEntries[p]);
    return result;
  });

  ipcMain.handle('open:editor', (_e, p) => {
    const dir = project(p).path;
    // `code` is code.cmd on Windows, so it needs a shell; quote the path.
    detached(settings.get().editor, [`"${dir}"`], { shell: true, windowsHide: true });
  });
  ipcMain.handle('open:folder', (_e, p) => shell.openPath(project(p).path));
  ipcMain.handle('open:terminal', (_e, p) => openTerminal(project(p).path));
  ipcMain.handle('open:url', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
  });

  ipcMain.handle('run:start', async (_e, p, commandId) => {
    const proj = withCustom(project(p));
    const command = proj.commands.find((c) => c.id === commandId);
    if (!command) throw new Error(`Unknown command ${commandId}`);
    if (command.open) {
      const err = await shell.openPath(command.open);
      if (err) throw new Error(err);
      return null;
    }
    return pm.start(proj, command);
  });
  ipcMain.handle('run:stop', (_e, id) => pm.stop(id));
  ipcMain.handle('run:remove', (_e, id) => pm.remove(id));
  ipcMain.handle('run:list', () => pm.list());
  ipcMain.handle('run:logs', (_e, id) => pm.logs(id));
}

// ---- lifecycle -------------------------------------------------------------
// One launcher at a time: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    registerIpc();
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  // Covers Cmd+Q / app.quit(); closing the window is handled in createWindow.
  app.on('before-quit', (e) => {
    if (!confirmQuit()) e.preventDefault();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Last line of defence: whatever path got us here, kill child trees.
  app.on('will-quit', () => pm.stopAll());
}
