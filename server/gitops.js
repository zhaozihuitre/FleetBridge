import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Review and commit from the command center: the changed files of a repo, a file's diff, and
// commit / push. Only repos the git collector has found are accepted (checked by the caller).
const run = promisify(execFile);
const ENV = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
const MAX_DIFF = 400 * 1024;

async function git(repo, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { env: ENV, maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60_000 });
    return stdout;
  } catch (e) {
    if (allowFail && typeof e.stdout === 'string') return e.stdout; // e.g. diff --no-index exits 1 when files differ
    throw new Error((e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' ') || 'git failed');
  }
}

const STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' };

/** Changed files with their status and +/- line counts. */
export async function changes(repo) {
  const porcelain = await git(repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const files = [];
  const parts = porcelain.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const xy = p.slice(0, 2);
    const file = p.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the rename source follows as its own entry
    const code = xy === '??' ? '?' : (xy[0] !== ' ' ? xy[0] : xy[1]);
    files.push({ file, status: STATUS[code] || 'modified', staged: xy[0] !== ' ' && xy[0] !== '?' });
  }
  const numstat = await git(repo, ['diff', 'HEAD', '--numstat'], { allowFail: true }).catch(() => '');
  const counts = new Map();
  for (const line of numstat.split('\n')) {
    const [ins, del, ...rest] = line.split('\t');
    if (rest.length) counts.set(rest.join('\t'), { ins: ins === '-' ? null : +ins, del: del === '-' ? null : +del });
  }
  return files.map((f) => ({ ...f, ...(counts.get(f.file) || { ins: null, del: null }) }));
}

/** The diff of one file against HEAD (new files against nothing), capped in size. */
export async function diff(repo, file, status) {
  let out = status === 'untracked'
    ? await git(repo, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { allowFail: true })
    : await git(repo, ['diff', '--no-color', 'HEAD', '--', file], { allowFail: true });
  if (out.length > MAX_DIFF) out = out.slice(0, MAX_DIFF) + '\n… (truncated)';
  return out;
}

/** Stage everything, commit with the message, and optionally push to the upstream. */
export async function commit(repo, message, push) {
  const log = [];
  await git(repo, ['add', '-A']);
  log.push((await git(repo, ['commit', '-m', message])).trim());
  if (push) log.push((await pushRepo(repo)).trim());
  return log.join('\n');
}

/** Push the current branch: to its upstream, or set one on origin the first time. */
export async function pushRepo(repo) {
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true }).catch(() => '');
  if (upstream.trim()) return git(repo, ['push']);
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return git(repo, ['push', '-u', 'origin', branch]);
}
