// Process manager: starts project commands as child processes, captures their
// output, detects dev-server URLs, and — the tricky part — kills the *whole*
// process tree when you press Stop or close the launcher.
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MAX_LINES = 3000; // per run; older lines are dropped
const IS_WIN = process.platform === 'win32';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d+)?(?:\/[^\s'"<>)]*)?/i;

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map(); // id -> run
    this.seq = 0;
  }

  /** Public, serialisable view of a run (no ChildProcess handle). */
  meta(run) {
    const { child, lines, partial, seq, ...rest } = run;
    return rest;
  }

  list() {
    return [...this.runs.values()].map((r) => this.meta(r));
  }

  logs(id) {
    return this.runs.get(id)?.lines ?? [];
  }

  start(project, command) {
    const id = `run${++this.seq}`;
    const run = {
      id,
      projectPath: project.path,
      projectName: project.name,
      commandId: command.id,
      label: command.label,
      cmd: command.cmd,
      cwd: command.cwd,
      status: 'running',
      pid: null,
      exitCode: null,
      url: null,
      startedAt: Date.now(),
      endedAt: null,
      lines: [],
      seq: 0, // line counter, lets the UI de-duplicate
      partial: '',
      child: null,
    };
    this.runs.set(id, run);

    this.appendLine(run, `$ ${command.cmd}`, 'sys');
    this.appendLine(run, `  in ${command.cwd}`, 'sys');

    // shell: true lets us run "npm run dev" or "docker compose up" exactly as
    // typed in a terminal (npm is npm.cmd on Windows, which needs a shell).
    // detached on POSIX puts the child in its own process group so we can
    // kill the group later; on Windows it would open a new console instead,
    // so there we rely on `taskkill /T` to walk the tree.
    const child = spawn(command.cmd, {
      cwd: command.cwd,
      shell: true,
      detached: !IS_WIN,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    run.pid = child.pid ?? null;

    const onData = (stream) => (buf) => this.onOutput(run, buf.toString('utf8'), stream);
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    child.on('error', (err) => {
      this.appendLine(run, `failed to start: ${err.message}`, 'sys');
      this.finish(run, null);
    });
    child.on('exit', (code, signal) => {
      this.flushPartial(run);
      const how = run.stopping ? 'stopped' : signal ? `killed by ${signal}` : `exited with code ${code}`;
      this.appendLine(run, `[process ${how}]`, 'sys');
      this.finish(run, code);
    });

    this.emitUpdate(run);
    return this.meta(run);
  }

  onOutput(run, text, stream) {
    // Output arrives in arbitrary chunks; only emit complete lines and keep
    // the trailing fragment for the next chunk.
    const parts = (run.partial + text.replace(ANSI, '')).split(/\r?\n/);
    run.partial = parts.pop();
    for (const line of parts) this.appendLine(run, line.replace(/\r/g, ''), stream);
    // Progress bars use bare \r and may never send \n; don't hold them forever.
    if (run.partial.length > 4096) this.flushPartial(run);
  }

  flushPartial(run) {
    if (run.partial) this.appendLine(run, run.partial, 'out');
    run.partial = '';
  }

  appendLine(run, text, stream) {
    const line = { n: ++run.seq, t: Date.now(), s: stream, text };
    run.lines.push(line);
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
    if (!run.url && stream !== 'sys') {
      const m = text.match(LOCAL_URL);
      if (m) {
        run.url = m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
        this.emitUpdate(run);
      }
    }
    this.emit('log', run.id, line);
  }

  finish(run, code) {
    if (run.status !== 'running') return;
    run.status = run.stopping || code === 0 ? 'exited' : 'failed';
    run.exitCode = code;
    run.endedAt = Date.now();
    run.child = null;
    this.emitUpdate(run);
  }

  emitUpdate(run) {
    this.emit('update', this.meta(run));
  }

  /** Kill a run and every process it spawned (npm -> node -> vite ...). */
  stop(id) {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running' || !run.pid) return false;
    run.stopping = true;
    killTree(run.pid);
    return true;
  }

  remove(id) {
    const run = this.runs.get(id);
    if (!run || run.status === 'running') return false;
    this.runs.delete(id);
    this.emit('removed', id);
    return true;
  }

  /** Synchronous so it completes before the app process exits. */
  stopAll() {
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.pid) {
        run.stopping = true;
        killTree(run.pid, { sync: true });
      }
    }
  }

  runningCount() {
    return [...this.runs.values()].filter((r) => r.status === 'running').length;
  }
}

function killTree(pid, { sync = false } = {}) {
  if (IS_WIN) {
    // Killing just the shell's PID would orphan the real server (e.g. node
    // running vite) and keep its port busy. /T = whole tree, /F = force.
    const args = ['/pid', String(pid), '/T', '/F'];
    if (sync) spawnSync('taskkill', args, { windowsHide: true });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // negative pid = the whole process group
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

module.exports = { ProcessManager, LOCAL_URL };
