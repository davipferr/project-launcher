const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseStatus } = require('../src/main/git');
const { scan, orderedScripts } = require('../src/main/projects');
const { ProcessManager } = require('../src/main/processes');

test('parseStatus reads branch, ahead/behind and file states', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.js',
    '1 A. N... 000000 100644 100644 000 ccc new file.txt',
    '2 R. N... 100644 100644 100644 ddd eee R100 renamed.js\told.js',
    '? notes.md',
    '',
  ].join('\n');
  const s = parseStatus(out);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual([s.staged, s.modified, s.untracked, s.dirty], [2, 1, 1, 4]);
  assert.deepEqual(s.files.map((f) => f.path), ['src/app.js', 'new file.txt', 'renamed.js', 'notes.md']);
});

test('orderedScripts puts dev/start first and hides lifecycle hooks', () => {
  assert.deepEqual(orderedScripts({ build: '', lint: '', dev: '', prebuild: '', prepare: '', start: '' }), ['dev', 'start', 'build', 'lint']);
});

test('scan finds projects inside category folders and detects commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const mk = (rel, content = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  mk('react/app/package.json', JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }));
  mk('python/bot/main.py');
  mk('rust/engine/Cargo.toml');
  mk('js/page/index.html');
  mk('fullstack/shop/.git/HEAD');
  mk('fullstack/shop/client/package.json', JSON.stringify({ scripts: { start: 'ng serve' } }));
  mk('react/app/node_modules/x/package.json', '{}'); // must not be scanned
  fs.mkdirSync(path.join(root, 'empty-category'));

  const found = await scan(root);
  const by = Object.fromEntries(found.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['app', 'bot', 'engine', 'page', 'shop']);
  assert.equal(by.app.category, 'react');
  // app has node_modules, so no "install" entry; shop/client doesn't, so it gets one
  assert.deepEqual(by.app.commands.map((c) => c.cmd), ['npm run dev', 'npm run build']);
  assert.ok(by.shop.commands.some((c) => c.label === 'client: npm install'));
  assert.match(by.bot.commands[0].cmd, /python3? main\.py/);
  assert.equal(by.engine.commands[0].cmd, 'cargo run');
  assert.ok(by.page.commands[0].open.endsWith('index.html'));
  assert.ok(by.shop.isGit);
  assert.equal(by.shop.commands.find((c) => c.id === 'node:client: start').cwd, path.join(root, 'fullstack/shop/client'));
  fs.rmSync(root, { recursive: true, force: true });
});

function waitFor(pm, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    const check = (m) => {
      if (pred(m)) {
        clearTimeout(t);
        pm.off('update', check);
        resolve(m);
      }
    };
    pm.on('update', check);
  });
}

test('ProcessManager captures output, detects URLs and reports exit codes', async () => {
  const pm = new ProcessManager();
  const script = "console.log('ready at http://localhost:5173/'); console.error('oops'); process.exit(3)";
  const run = pm.start({ path: '/p', name: 'p' }, { id: 'x', label: 'x', cmd: `node -e "${script}"`, cwd: process.cwd() });
  const done = await waitFor(pm, (m) => m.id === run.id && m.status !== 'running');
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  assert.equal(done.url, 'http://localhost:5173/');
  const lines = pm.logs(run.id);
  assert.ok(lines.some((l) => l.s === 'err' && l.text === 'oops'));
});

test('stop() kills the whole tree, not just the shell', async () => {
  const pm = new ProcessManager();
  // shell -> node (parent) -> node (grandchild) that would otherwise live forever
  const grandchild = "setInterval(()=>{},1000)";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e','${grandchild}'],{stdio:'inherit'});console.log('GC'+c.pid);setInterval(()=>{},1000)`;
  const file = path.join(os.tmpdir(), `pl-tree-${process.pid}.js`);
  fs.writeFileSync(file, parent);
  const run = pm.start({ path: '/p', name: 'p' }, { id: 'x', label: 'x', cmd: `node "${file}"`, cwd: process.cwd() });

  const gcPid = await new Promise((resolve) => {
    pm.on('log', (id, l) => {
      const m = l.text.match(/^GC(\d+)/);
      if (id === run.id && m) resolve(Number(m[1]));
    });
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(gcPid));
  const exited = waitFor(pm, (m) => m.id === run.id && m.status !== 'running');
  pm.stop(run.id);
  const done = await exited;
  assert.equal(done.status, 'exited'); // a user stop is not a failure
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!alive(gcPid), 'grandchild should be dead');
  fs.rmSync(file, { force: true });
});

test('scan works on the real projects folder (smoke)', { skip: !fs.existsSync(path.join(os.homedir(), 'Documents', 'projetos')) }, async () => {
  const found = await scan(path.join(os.homedir(), 'Documents', 'projetos'));
  assert.ok(found.length > 0);
  execFileSync('git', ['--version']);
});
