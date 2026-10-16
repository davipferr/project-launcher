// Read-only git status via the git CLI. Nothing here touches the network:
// ahead/behind is relative to the last time *you* fetched.
const { execFile } = require('node:child_process');

function git(cwd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Run at most `n` async jobs at once, so scanning 30 repos doesn't spawn
// 60 git processes simultaneously.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

/** Parse `git status --porcelain=v2 --branch` output. */
function parseStatus(out) {
  const s = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, files: [] };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) s.oid = line.slice(13);
    else if (line.startsWith('# branch.head ')) s.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [s.ahead, s.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY ..." — X = index (staged), Y = worktree (unstaged)
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') s.staged++;
      if (xy[1] !== '.') s.modified++;
      // ordinary entries have 8 fields before the path, renames 9 (+ "\torig")
      const fields = line.split(' ');
      const p = fields.slice(line.startsWith('1 ') ? 8 : 9).join(' ').split('\t')[0];
      s.files.push({ xy: xy.replace(/\./g, ' '), path: p });
    } else if (line.startsWith('? ')) {
      s.untracked++;
      s.files.push({ xy: '??', path: line.slice(2) });
    } else if (line.startsWith('u ')) {
      s.conflicts++;
      s.files.push({ xy: 'UU', path: line.split(' ').slice(10).join(' ') });
    }
  }
  if (s.branch === '(detached)') s.branch = 'detached HEAD';
  s.dirty = s.staged + s.modified + s.untracked + s.conflicts;
  s.files = s.files.slice(0, 200);
  return s;
}

const limit = limiter(6);

// Last commit per repo, keyed by the HEAD commit it was read for. Starting a process is the
// slow part on Windows, so `git log` only runs again when `git status` reports a new HEAD.
const lastCommits = new Map(); // dir -> { oid, lastCommit }

async function status(dir) {
  return limit(async () => {
    try {
      const out = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
      const s = parseStatus(out);
      const cached = lastCommits.get(dir);
      if (cached && s.oid && cached.oid === s.oid) {
        s.lastCommit = cached.lastCommit;
      } else {
        try {
          const log = await git(dir, ['log', '-1', '--format=%ct%x1f%an%x1f%s']);
          const [ts, author, subject] = log.trim().split('\x1f');
          s.lastCommit = { time: Number(ts) * 1000, author, subject };
        } catch {
          s.lastCommit = null; // repo with no commits yet
        }
        lastCommits.set(dir, { oid: s.oid, lastCommit: s.lastCommit });
      }
      return { ok: true, ...s };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { status, parseStatus };
