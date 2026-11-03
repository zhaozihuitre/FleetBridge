import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';

const run = promisify(execFile);
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.venv', 'venv']);
// Read-only status must never take the index lock while the user is committing.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

// Starting a process blocks the thread that starts it: 20-40 ms each on Windows inside Electron.
// A scan runs 6 git commands per repo, and on the server's thread that held up the keystrokes sent
// to the terminals for seconds. So the git processes are started from a worker thread; the server
// thread only gets the output back. Inline code (eval) so it also runs from the packaged asar.
const WORKER = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const queue = [];
let running = 0;
function next() {
  while (running < 4 && queue.length) {
    const { id, file, args, opts } = queue.shift();
    running++;
    execFile(file, args, opts, (err, stdout) => {
      running--;
      parentPort.postMessage({ id, stdout, error: err ? String(err.message || err) : null });
      next();
    });
  }
}
parentPort.on('message', (m) => { queue.push(m); next(); });`;
const OPTS = { env: ENV, timeout: 15_000, maxBuffer: 8 << 20, windowsHide: true };
let worker = null;
let nextId = 0;
const calls = new Map();

function spawner() {
  if (worker) return worker;
  try {
    worker = new Worker(WORKER, { eval: true });
    worker.unref(); // never keeps the process alive on its own
    worker.on('message', ({ id, stdout, error }) => {
      const c = calls.get(id);
      calls.delete(id);
      if (c) error ? c.reject(new Error(error)) : c.resolve(stdout);
    });
    worker.on('error', () => {
      for (const c of calls.values()) c.reject(new Error('git worker failed'));
      calls.clear();
      worker = null;
    });
  } catch {
    worker = null;
  }
  return worker;
}

async function git(repo, args) {
  const w = spawner();
  if (!w) return (await run('git', ['-C', repo, ...args], OPTS)).stdout; // no worker threads: plain spawn
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    calls.set(id, { resolve, reject });
    w.postMessage({ id, file: 'git', args: ['-C', repo, ...args], opts: OPTS });
  });
}

export function findRepos(dir, depth = config.git.scanDepth) {
  if (fs.existsSync(path.join(dir, '.git'))) return [dir];
  if (depth <= 0) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .flatMap((e) => findRepos(path.join(dir, e.name), depth - 1));
}

function parseStatus(out) {
  const r = { branch: null, upstream: null, ahead: 0, behind: 0, changed: [], untracked: 0, conflicts: 0 };
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('# branch.head ')) r.branch = t.slice(14);
    else if (t.startsWith('# branch.upstream ')) r.upstream = t.slice(18);
    else if (t.startsWith('# branch.ab ')) {
      const [a, b] = t.slice(12).split(' ');
      r.ahead = Math.abs(parseInt(a, 10));
      r.behind = Math.abs(parseInt(b, 10));
    } else if (t.startsWith('1 ')) r.changed.push(t.split(' ').slice(8).join(' '));
    else if (t.startsWith('2 ')) {
      r.changed.push(t.split(' ').slice(9).join(' '));
      i++; // rename entries are followed by the original path
    } else if (t.startsWith('u ')) {
      r.conflicts++;
      r.changed.push(t.split(' ').slice(10).join(' '));
    } else if (t.startsWith('? ')) {
      r.untracked++;
      r.changed.push(t.slice(2));
    }
  }
  return r;
}

// How long the oldest uncommitted change has been sitting, from file mtimes.
// Async: up to 300 stats per repo, for every repo, used to stall the server's thread.
async function oldestChange(repo, files) {
  let oldest = null;
  const times = await Promise.all(files.slice(0, 300).map((f) => fs.promises.stat(path.join(repo, f)).then((s) => s.mtimeMs, () => null))); // deleted files have no mtime
  for (const m of times) if (m !== null && (oldest === null || m < oldest)) oldest = m;
  return oldest;
}

// "https://user:token@github.com/owner/repo.git" or "git@github.com:owner/repo.git"
// -> { host, slug: "owner/repo", web }. Credentials embedded in the URL are dropped, never shown.
function describeRemote(name, raw) {
  const url = raw.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
  const m = url.match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/);
  if (!m) return { name, url, host: null, slug: url, web: null };
  const [, host, slug] = m;
  return { name, url, host, slug, web: /^[\w.-]+$/.test(host) ? `https://${host}/${slug}` : null };
}

function parseRemotes(out) {
  const seen = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (m && (m[3] === 'push' || !seen.has(m[1]))) seen.set(m[1], describeRemote(m[1], m[2])); // the push URL is where commits go
  }
  return [...seen.values()];
}

async function inspect(repo) {
  const st = parseStatus(await git(repo, ['status', '--porcelain=v2', '--branch', '-z']));
  const [logOut, statOut, stashOut, gitDir, remoteOut] = await Promise.all([
    git(repo, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%ct']).catch(() => ''),
    git(repo, ['diff', '--shortstat', 'HEAD']).catch(() => ''),
    git(repo, ['stash', 'list']).catch(() => ''),
    git(repo, ['rev-parse', '--absolute-git-dir']).catch(() => ''),
    git(repo, ['remote', '-v']).catch(() => ''),
  ]);
  const remotes = parseRemotes(remoteOut);
  // where a plain `git push` goes: the upstream's remote, else origin, else the only one
  const upstreamRemote = st.upstream?.split('/')[0];
  const remote = remotes.find((r) => r.name === upstreamRemote) || remotes.find((r) => r.name === 'origin') || (remotes.length === 1 ? remotes[0] : null);
  const [hash, subject, author, ct] = logOut.trim().split('\x1f');
  const dir = gitDir.trim();
  const has = (f) => dir && fs.existsSync(path.join(dir, f));
  let fetchedAt = null;
  try {
    fetchedAt = fs.statSync(path.join(dir, 'FETCH_HEAD')).mtimeMs;
  } catch {
    // never fetched
  }
  return {
    path: repo,
    name: path.basename(repo),
    branch: st.branch,
    upstream: st.upstream,
    ahead: st.ahead,
    behind: st.behind,
    changedCount: st.changed.length,
    untracked: st.untracked,
    conflicts: st.conflicts,
    insertions: +(statOut.match(/(\d+) insertion/)?.[1] || 0),
    deletions: +(statOut.match(/(\d+) deletion/)?.[1] || 0),
    oldestChangeAt: st.changed.length ? await oldestChange(repo, st.changed) : null,
    stash: stashOut.split('\n').filter(Boolean).length,
    operation: has('MERGE_HEAD') ? 'merge' : has('rebase-merge') || has('rebase-apply') ? 'rebase' : has('CHERRY_PICK_HEAD') ? 'cherry-pick' : null,
    head: hash ? { hash, subject, author, at: +ct * 1000 } : null,
    fetchedAt,
    remote: remote && { name: remote.name, slug: remote.slug, host: remote.host, web: remote.web },
    remotes: remotes.map(({ name, slug, host, web }) => ({ name, slug, host, web })),
  };
}

export async function collectGit(cwds) {
  const result = {};
  await Promise.all(
    [...new Set(cwds)].map(async (cwd) => {
      const repos = findRepos(cwd);
      result[cwd] = (
        await Promise.all(
          repos.map((r) =>
            (config.git.autoFetch ? git(r, ['fetch', '--quiet']).catch(() => {}) : Promise.resolve())
              .then(() => inspect(r))
              .catch((e) => ({ path: r, name: path.basename(r), error: e.message.split('\n')[0] })),
          ),
        )
      ).sort((a, b) => a.name.localeCompare(b.name));
    }),
  );
  return result;
}
