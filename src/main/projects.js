// Project discovery: walk the root folder, decide which directories are
// "projects", and work out what kind of project each one is and how to run it.
const fs = require('node:fs/promises');
const path = require('node:path');

const MARKER_FILES = new Set([
  '.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'angular.json', 'index.html', 'docker-compose.yml', 'compose.yaml',
  'compose.yml', 'CLAUDE.md', 'README.md',
]);
const MARKER_EXTS = new Set(['.sln', '.csproj', '.py', '.mq5', '.mqh']);
const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', 'target', 'bin', 'obj', 'dist', 'build', '__pycache__']);
// Common names for sub-apps inside a monorepo-ish project (client/server etc.)
const SUBAPP_DIRS = ['client', 'server', 'frontend', 'front-end', 'backend', 'back-end', 'web', 'api', 'app', 'worker'];
// Which npm scripts are worth surfacing first, in this order.
const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview', 'watch', 'test', 'build'];

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function looksLikeProject(entries) {
  return entries.some((e) => MARKER_FILES.has(e.name) || (e.isFile() && MARKER_EXTS.has(path.extname(e.name))));
}

/**
 * Walk `root` up to `maxDepth` levels. A directory with a marker (.git,
 * package.json, ...) is a project and we stop descending; otherwise it is a
 * grouping folder (like "react/" or "python/") and we look inside it.
 */
async function scan(root, maxDepth = 3) {
  const found = [];

  async function walk(dir, depth) {
    const entries = await readdirSafe(dir);
    if (depth > 0 && looksLikeProject(entries)) {
      found.push(await describe(root, dir, entries));
      return;
    }
    if (depth >= maxDepth) return;
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name));
    await Promise.all(subdirs.map((e) => walk(path.join(dir, e.name), depth + 1)));
  }

  await walk(root, 0);
  found.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return found;
}

async function describe(root, dir, entries) {
  const rel = path.relative(root, dir);
  const parent = path.dirname(rel);
  const names = new Set(entries.map((e) => e.name));
  const { types, commands } = await detectCommands(dir, entries);
  return {
    path: dir,
    name: path.basename(dir),
    category: parent === '.' ? 'other' : parent.split(path.sep).join('/'),
    isGit: names.has('.git'),
    types,
    commands,
  };
}

function packageManager(names) {
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  return 'npm';
}

function orderedScripts(scripts) {
  const keys = Object.keys(scripts || {});
  const rank = (k) => {
    // "dev:react" ranks like "dev"
    const i = SCRIPT_PRIORITY.indexOf(k.split(':')[0]);
    return i === -1 ? SCRIPT_PRIORITY.length : i;
  };
  // Hide npm lifecycle hooks; they are not things you "start".
  return keys
    .filter((k) => !/^(pre|post)/.test(k) && k !== 'prepare')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

async function nodeCommands(dir, prefix) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg) return [];
  const names = new Set((await readdirSafe(dir)).map((e) => e.name));
  const pm = packageManager(names);
  const out = [];
  if (!names.has('node_modules')) {
    out.push({ id: `node:${prefix}install`, label: `${prefix}${pm} install`, cmd: `${pm} install`, cwd: dir });
  }
  for (const s of orderedScripts(pkg.scripts)) {
    out.push({ id: `node:${prefix}${s}`, label: `${prefix}${pm} run ${s}`, cmd: `${pm} run ${s}`, cwd: dir });
  }
  return out;
}

async function findFiles(dir, ext, maxDepth, depth = 0, acc = []) {
  for (const e of await readdirSafe(dir)) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(ext)) acc.push(full);
    else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
      await findFiles(full, ext, maxDepth, depth + 1, acc);
    }
  }
  return acc;
}

async function pythonExe(dir) {
  for (const venv of ['.venv', 'venv', 'env']) {
    const win = path.join(dir, venv, 'Scripts', 'python.exe');
    const nix = path.join(dir, venv, 'bin', 'python');
    if (await exists(win)) return { exe: `"${win}"`, venv };
    if (await exists(nix)) return { exe: `"${nix}"`, venv };
  }
  return { exe: process.platform === 'win32' ? 'python' : 'python3', venv: null };
}

/** Entry points from pyproject's [project.scripts] table, e.g. mdd = "src.cli:app". */
async function pyprojectScripts(dir) {
  let text;
  try {
    text = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8');
  } catch {
    return [];
  }
  const m = text.match(/^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*"?([\w.-]+)"?\s*=\s*"([^"]+)"/gm)].map(([, name, target]) => ({ name, target }));
}

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);

async function detectCommands(dir, entries) {
  const names = new Set(entries.map((e) => e.name));
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const types = [];
  const commands = [];

  // Node / JS
  if (names.has('package.json')) {
    types.push(names.has('angular.json') ? 'angular' : 'node');
    commands.push(...(await nodeCommands(dir, '')));
  }
  for (const sub of SUBAPP_DIRS) {
    if (names.has(sub) && (await exists(path.join(dir, sub, 'package.json')))) {
      if (!types.includes('node')) types.push('node');
      commands.push(...(await nodeCommands(path.join(dir, sub), `${sub}: `)));
    }
  }

  // Rust
  if (names.has('Cargo.toml')) {
    types.push('rust');
    for (const c of ['run', 'test', 'build']) {
      commands.push({ id: `cargo:${c}`, label: `cargo ${c}`, cmd: `cargo ${c}`, cwd: dir });
    }
  }

  // .NET: offer `dotnet run` for each project file we can find nearby.
  if (files.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
    types.push('dotnet');
    const csprojs = (await findFiles(dir, '.csproj', 3)).filter((p) => !/test/i.test(path.basename(p)));
    for (const p of csprojs) {
      const rel = path.relative(dir, p);
      commands.push({
        id: `dotnet:run:${rel}`,
        label: `dotnet run ${path.basename(p, '.csproj')}`,
        cmd: `dotnet run --project ${quote(rel)}`,
        cwd: dir,
      });
    }
    commands.push({ id: 'dotnet:build', label: 'dotnet build', cmd: 'dotnet build', cwd: dir });
  }

  // Python: every top-level script, run with the project's venv if it has one.
  const pyFiles = files.filter((f) => f.endsWith('.py'));
  if (pyFiles.length || names.has('pyproject.toml') || names.has('requirements.txt') || files.some((f) => f.endsWith('.ipynb'))) {
    types.push('python');
    const { exe, venv } = await pythonExe(dir);
    const preferred = ['main.py', 'app.py', 'run.py', 'server.py'];
    pyFiles.sort((a, b) => {
      const ra = preferred.indexOf(a), rb = preferred.indexOf(b);
      return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
    });
    for (const f of pyFiles) {
      commands.push({ id: `py:${f}`, label: `python ${f}${venv ? ` (${venv})` : ''}`, cmd: `${exe} ${quote(f)}`, cwd: dir });
    }
    // Installed console scripts live next to the venv's python.
    for (const { name, target } of await pyprojectScripts(dir)) {
      const bin = venv && path.join(dir, venv, process.platform === 'win32' ? 'Scripts' : 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
      const cmd = bin && (await exists(bin)) ? `"${bin}"` : name;
      commands.push({ id: `py:script:${name}`, label: `${name} (${target})`, cmd, cwd: dir });
    }
    if (files.some((f) => f.endsWith('.ipynb'))) {
      commands.push({ id: 'py:jupyter', label: 'jupyter lab', cmd: `${exe} -m jupyter lab`, cwd: dir });
    }
    if (names.has('tests') || names.has('test')) {
      commands.push({ id: 'py:pytest', label: 'pytest', cmd: `${exe} -m pytest`, cwd: dir });
    }
  }

  if (names.has('go.mod')) {
    types.push('go');
    commands.push({ id: 'go:run', label: 'go run .', cmd: 'go run .', cwd: dir });
  }

  const compose = ['docker-compose.yml', 'compose.yaml', 'compose.yml'].find((f) => names.has(f));
  if (compose) {
    types.push('docker');
    commands.push({ id: 'compose:up', label: 'docker compose up', cmd: 'docker compose up', cwd: dir });
  }

  if (files.some((f) => f.endsWith('.mq5') || f.endsWith('.mqh')) || names.has('SDK_MAP.md')) types.push('mql5');

  // A plain static page: nothing to run, just open it in the browser.
  if (names.has('index.html') && !names.has('package.json')) {
    types.push('static');
    commands.push({ id: 'open:index', label: 'open index.html', open: path.join(dir, 'index.html'), cwd: dir });
  }

  return { types, commands };
}

/** Best guess at what "start this project" means: dev servers first, then
 *  "run" style commands; never install/test/build/lint. */
function pickDefault(commands) {
  const score = (c) => {
    const t = `${c.id} ${c.cmd || ''}`;
    if (/install|test|lint|build|check|typecheck|format|bench/.test(c.id)) return 99;
    if (/run (dev|start|serve)\b/.test(t)) return 0;
    if (/cargo:run|dotnet:run|go:run|py:script|py:main|compose:up/.test(c.id)) return 1;
    return 2;
  };
  const best = [...commands].sort((a, b) => score(a) - score(b))[0];
  return best && score(best) < 99 ? best.id : null;
}

module.exports = { scan, detectCommands, orderedScripts, pickDefault };
