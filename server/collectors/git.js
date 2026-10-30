import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.venv', 'venv']);
// Read-only status must never take the index lock while the user is committing.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

async function git(repo, args) {
  const { stdout } = await run('git', ['-C', repo, ...args], { env: ENV, timeout: 15_000, maxBuffer: 8 << 20, windowsHide: true });
  return stdout;
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
function oldestChange(repo, files) {
  let oldest = null;
  for (const f of files.slice(0, 300)) {
    try {
      const m = fs.statSync(path.join(repo, f)).mtimeMs;
      if (oldest === null || m < oldest) oldest = m;
    } catch {
      // deleted files have no mtime
    }
  }
  return oldest;
}

async function inspect(repo) {
  const st = parseStatus(await git(repo, ['status', '--porcelain=v2', '--branch', '-z']));
  const [logOut, statOut, stashOut, gitDir] = await Promise.all([
    git(repo, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%ct']).catch(() => ''),
    git(repo, ['diff', '--shortstat', 'HEAD']).catch(() => ''),
    git(repo, ['stash', 'list']).catch(() => ''),
    git(repo, ['rev-parse', '--absolute-git-dir']).catch(() => ''),
  ]);
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
    oldestChangeAt: st.changed.length ? oldestChange(repo, st.changed) : null,
    stash: stashOut.split('\n').filter(Boolean).length,
    operation: has('MERGE_HEAD') ? 'merge' : has('rebase-merge') || has('rebase-apply') ? 'rebase' : has('CHERRY_PICK_HEAD') ? 'cherry-pick' : null,
    head: hash ? { hash, subject, author, at: +ct * 1000 } : null,
    fetchedAt,
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
