import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Building an approved proposal, and installing it once the user says so (docs/self-improve-design.md §4):
//   start    a git worktree of the FleetBridge checkout on a new branch improve/p-007 (never the checkout's own
//            working tree: the user may be changing things there), node_modules joined to the checkout's,
//            and a development agent started in it with the proposal and the rules (its settings deny
//            git push, npm publish, update.mjs and the installer; edits are only accepted inside its folder)
//   finish   when its turn is over: the checkout's own working tree must be as it was, the changes must be in
//            the worktree, its tests are run here again; built / needs-installer / failed
//   install  tools/update.mjs --from <worktree> (in place; the app rolls back by itself if the new version
//            doesn't start), its output in a log read on the next ticks; rollback the same with --rollback
//   discard  the worktree and its branch removed
// Nothing here pushes, publishes or runs an installer.

const MAX_RUN = 4 * 3_600_000; // a development turn longer than this is stopped and failed
const INSTALL_WAIT = 5 * 60_000;
const TEST_TIMEOUT = 5 * 60_000;

export const DENY = ['Bash(git push:*)', 'Bash(git push)', 'Bash(npm publish:*)', 'Bash(*update.mjs*)', 'Bash(*FleetBridge-Setup*)', 'Bash(git worktree remove:*)', 'Bash(git branch -D:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf /*)'];
export const ALLOW = ['Bash(npm test:*)', 'Bash(npm test)', 'Bash(node --test:*)', 'Bash(node --check:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git show:*)'];

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Whether a folder is a FleetBridge checkout (a git work tree whose package.json is fleet-bridge's). */
export function isFleetRepo(dir) {
  try {
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return false;
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'fleet-bridge';
  } catch {
    return false;
  }
}

/** The checkout to build in: the setting, else the running code's own folder, else a known project folder. */
export function findRepo(setting, candidates = []) {
  for (const d of [setting, ...candidates]) if (d && isFleetRepo(d)) return path.resolve(d);
  return null;
}

export const branchOf = (id) => `improve/${String(id).toLowerCase()}`;

/** The first order of the development agent. */
export function devPrompt(p, o) {
  const ev = (p.evidence || []).map((e) => `- ${e.ref || e.metric}${e.value ? ' = ' + e.value : ''}${e.quote ? '：' + e.quote : ''}`).join('\n');
  return `你是舰桥（Fleet Bridge）的开发 agent，负责实现一条用户已经同意的改善提案。

## 提案 ${p.id}：${p.title}
- 现象：${p.finding}
- 证据：
${ev || '- （无）'}
- 建议改动：${p.change}
- 预期收益：${p.benefit}
- 工作量：${p.effort}；风险：${p.risk}

## 工作环境
- 当前目录是舰桥源码的一个独立 git worktree，分支 ${o.branch}，基线 ${o.base.slice(0, 7)}${o.dirtyBase ? '（注意：主仓库工作区有未提交的改动，基线不包含它们）' : ''}。node_modules 已链接好。
- 先读 docs/project-docs/ 和相关源码，弄清现状再动手；改动尽量小、聚焦在这条提案上。

## 规则（必须遵守）
1. 只修改当前目录（这个 worktree）里的文件；不要碰主仓库目录 ${o.repo}、其他项目或用户目录下的任何文件。
2. 不要 git push、npm publish，不要运行 tools/update.mjs 或安装包，不要打包发布。更新安装由舰桥在用户确认后进行。
3. 为改动补充或更新测试（test/*.test.mjs，node:test），运行 \`npm test\` 并保证全部通过；对改过的 .js/.mjs/.cjs 运行 \`node --check\`。
4. 按 project-docs 的约定更新文档（docs/project-docs/sections/*.md，并用 pdoc 记一条变更）。
5. 完成后在这个分支上本地提交（git add + git commit），提交说明写清楚改了什么。
6. 最后用下面的格式汇报（这是舰桥读取的正式汇报）：
[[FLEET-REPORT]]
- 结论：做完了 / 没做完（原因）
- 改了哪些文件、各自做了什么
- 测试：运行了什么，结果
- 风险与回滚方式
- 需要用户注意的事
[[/FLEET-REPORT]]`;
}

/**
 * Sets up the worktree and starts the development agent.
 * @param {object} p the proposal
 * @param {{ repo: string, dataDir: string, baseSettings?: object, spawnAgent: Function, runGit?: Function, now?: number }} d
 * @returns {object} impl: what the proposal remembers of it
 */
export function startImpl(p, d) {
  const run = d.runGit || git;
  if (!isFleetRepo(d.repo)) throw new Error('not_fleet_repo');
  const branch = branchOf(p.id);
  const worktree = path.join(d.dataDir, 'improve', p.id);
  const base = p.impl?.base || run(['rev-parse', 'HEAD'], d.repo);
  const snapshot = run(['status', '--porcelain'], d.repo);
  if (!fs.existsSync(path.join(worktree, '.git'))) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const exists = run(['branch', '--list', branch], d.repo);
    run(exists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, base], d.repo);
  }
  // node_modules: the checkout's, joined (a junction on Windows: no admin rights needed)
  const mods = path.join(d.repo, 'node_modules');
  const link = path.join(worktree, 'node_modules');
  if (fs.existsSync(mods) && !fs.existsSync(link)) {
    try {
      fs.symlinkSync(mods, link, 'junction');
    } catch {
      // tests that need modules will say so
    }
  }
  // its settings: ours, plus what it may never do (and the usual commands it needn't ask about)
  const settingsFile = path.join(d.dataDir, 'improve', `${p.id}.settings.json`);
  const s = { ...(d.baseSettings || {}) };
  s.permissions = { ...(s.permissions || {}), deny: [...new Set([...(s.permissions?.deny || []), ...DENY])], allow: [...new Set([...(s.permissions?.allow || []), ...ALLOW])] };
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  const prompt = devPrompt(p, { branch, base, dirtyBase: Boolean(snapshot), repo: d.repo });
  const agent = d.spawnAgent({ cwd: worktree, name: `改善 ${p.id}`, prompt, settingsFile, extraArgs: ['--permission-mode', 'acceptEdits'] });
  const now = d.now || Date.now();
  return { repo: d.repo, worktree, branch, base, dirtyBase: Boolean(snapshot), snapshot, agentId: agent.id, sessionId: agent.sessionId, startedAt: now, seenBusy: false, settingsFile };
}

/**
 * Follows the development agent on each publish.
 * @returns {'running' | 'done' | 'gone' | 'timeout'}
 */
export function followImpl(impl, unit, d) {
  const now = d.now || Date.now();
  if (!d.alive(impl.agentId)) return 'gone';
  if (now - impl.startedAt > MAX_RUN) return 'timeout';
  if (!unit) return 'running';
  if (unit.status === 'busy') impl.seenBusy = true;
  if (!impl.seenBusy || unit.status !== 'idle' || d.waiting) return 'running';
  return d.turnOver(impl.sessionId, impl.startedAt) === false ? 'running' : 'done';
}

const INSTALLER_PATHS = /^(desktop\/|package-lock\.json$|bin\/)/;

/** Which changed files mean the installer is needed (the shell, dependencies), not an in-place update. */
export function needsInstaller(files, pkgDiff = '') {
  if (files.some((f) => INSTALLER_PATHS.test(f))) return true;
  // package.json: only the version or scripts changed is fine; dependencies or the shell API are not
  return files.includes('package.json') && /^[+-]\s*"(dependencies|devDependencies|optionalDependencies|fleetShellApi|electron|main|build)"/m.test(pkgDiff);
}

function runTests(dir) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_TEST_CONTEXT; // a run started from inside a test run would skip its files
  return new Promise((resolve) => {
    const p = execFile(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: dir, windowsHide: true, timeout: TEST_TIMEOUT, env, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      const text = `${out || ''}${errOut || ''}`;
      const pass = text.match(/ℹ pass (\d+)/)?.[1];
      const fail = text.match(/ℹ fail (\d+)/)?.[1];
      resolve({ ok: !err && fail === '0', pass: Number(pass || 0), fail: Number(fail || 0), tail: text.split('\n').slice(-25).join('\n') });
    });
    p.on('error', () => resolve({ ok: false, pass: 0, fail: 0, tail: 'could not run the tests' }));
  });
}

/**
 * Checks what the development agent did. Never trusts its report alone.
 * @returns {Promise<{ status: 'built'|'needs-installer'|'failed', reason?: string, files: string[], stat: string, tests: object, reply: string }>}
 */
export async function finishImpl(impl, d) {
  const run = d.runGit || git;
  const reply = d.reply || '';
  // the user's own checkout: exactly as it was
  const now = run(['status', '--porcelain'], impl.repo);
  if (now !== impl.snapshot) return { status: 'failed', reason: 'main-repo-changed', files: [], stat: '', tests: null, reply, detail: now };
  const uncommitted = run(['status', '--porcelain'], impl.worktree);
  const files = run(['diff', '--name-only', impl.base], impl.worktree).split('\n').filter(Boolean);
  const untracked = uncommitted.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
  const all = [...new Set([...files, ...untracked])].filter((f) => f !== 'node_modules');
  if (!all.length) return { status: 'failed', reason: 'no-changes', files: [], stat: '', tests: null, reply };
  const stat = run(['diff', '--stat', impl.base], impl.worktree);
  const pkgDiff = all.includes('package.json') ? run(['diff', impl.base, '--', 'package.json'], impl.worktree) : '';
  const tests = await (d.runTests || runTests)(impl.worktree);
  if (!tests.ok) return { status: 'failed', reason: 'tests-failed', files: all, stat, tests, reply, uncommitted: Boolean(uncommitted.trim()) };
  return { status: needsInstaller(all, pkgDiff) ? 'needs-installer' : 'built', files: all, stat, tests, reply, uncommitted: Boolean(uncommitted.trim()) };
}

/** Starts tools/update.mjs (detached: it outlives this server, which it restarts) with its output in a log. */
export function startUpdate(impl, d, { rollback = false } = {}) {
  const log = path.join(d.dataDir, 'improve', `${d.id}-${rollback ? 'rollback' : 'install'}-${Date.now()}.log`);
  const script = path.join(rollback ? impl.repo : impl.worktree, 'tools', 'update.mjs');
  const args = [script, ...(rollback ? ['--rollback'] : ['--from', impl.worktree]), '--data-dir', d.dataDir, '--port', String(d.port)];
  const fd = fs.openSync(log, 'a');
  const child = (d.spawn || spawn)(d.node || process.execPath, args, { cwd: impl.worktree, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.unref?.();
  fs.closeSync(fd);
  return log;
}

/** What an update's log says so far. */
export function updateResult(log, startedAt, now = Date.now()) {
  let text = '';
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch {
    // not written yet
  }
  const tail = text.split('\n').filter(Boolean).slice(-8).join('\n');
  const ok = text.match(/✔ (?:now running|rolled back to) ([^\s;]+)(?:; terminals still running: (\d+)\/(\d+))?/);
  if (ok) return { done: true, ok: true, version: ok[1], kept: ok[2] ? `${ok[2]}/${ok[3]}` : null, tail };
  if (/✖/.test(text)) return { done: true, ok: false, tail };
  if (now - startedAt > INSTALL_WAIT) return { done: true, ok: false, tail: tail || 'no answer from tools/update.mjs' };
  return { done: false, tail };
}

/** Removes the worktree and its branch. */
export function discardImpl(impl, d = {}) {
  const run = d.runGit || git;
  const out = [];
  // the node_modules junction first, never what it points to (the checkout's own); if it can't be taken out,
  // nothing is removed: removing the worktree could go through it
  const link = path.join(impl.worktree, 'node_modules');
  try {
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    // checked below
  }
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return `node_modules link could not be removed: ${link} (nothing removed)`;
  for (const args of [['worktree', 'remove', '--force', impl.worktree], ['branch', '-D', impl.branch], ['worktree', 'prune']]) {
    try {
      run(args, impl.repo);
      out.push(args.slice(0, 2).join(' ') + ' ✓');
    } catch (e) {
      out.push(args.slice(0, 2).join(' ') + ' ✖ ' + String(e.message).split('\n')[0]);
    }
  }
  try {
    if (impl.settingsFile) fs.rmSync(impl.settingsFile, { force: true });
  } catch {
    // only a settings file
  }
  return out.join('\n');
}
