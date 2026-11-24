// Shared working trees (improvement P-007): which live agents work on the same files.
//
// Two terminals in one working tree overwrite each other and commit each other's changes (11-23: one
// committed real changes while the other was putting line endings back), and the master could only write
// "both of you are in here, mind the following" into its orders by hand. Here the agents are grouped by
// the working tree their folder belongs to, so that
// - the command center marks them ("共用仓库" at the terminal's title),
// - fleet_status tells the master before it gives an order, and
// - an order of the master's that may change files gets the standing rules after it, once per situation.
//
// What counts as the same: the same working tree, found by walking up from the agent's folder to the
// nearest ".git". A linked worktree (git worktree add) has a ".git" of its own, a file, so it is a tree of
// its own: agents in separate worktrees of one repository are NOT marked, that is what worktrees are for.
// A folder above several repositories counts for each repository under it. Outside any repository, only
// exactly the same folder counts.
import fs from 'node:fs';
import path from 'node:path';
import { findRepos } from './collectors/git.js';
import { L } from './i18n.js';

const TTL = 30_000; // a folder becomes a repository (git init, clone) rarely: looked at again after this long
const cache = new Map(); // cwd -> { at, trees }

/** A path as a key: absolute, forward slashes, no trailing slash; case does not tell folders apart on Windows. */
export function treeKey(p) {
  const s = path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** The working tree a folder belongs to: the nearest folder at or above it that has a ".git" (a folder, or a worktree's file). */
export function treeRoot(dir) {
  let d = path.resolve(String(dir || ''));
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The working trees an agent in this folder works on: the one it is in, else the repositories under it. */
export function treesOf(cwd, now = Date.now()) {
  if (!cwd) return [];
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL) return hit.trees;
  let trees = [];
  try {
    const root = treeRoot(cwd);
    trees = root ? [root] : findRepos(cwd);
  } catch {
    // unreadable: no tree known, the folder itself is compared
  }
  cache.set(cwd, { at: now, trees });
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= TTL) cache.delete(k);
  return trees;
}

/**
 * Who can change files right now: our live Claude agents (no shell pane, not the master) and the Claude Code
 * sessions outside Fleet Bridge.
 * @param {{ agents: object[], units: object[], skip?: (cwd: string) => boolean }} o agents and units as in the
 *   published state; skip: folders of outside sessions that do not count (the master's own)
 */
export function sharedMembers({ agents = [], units = [], skip = () => false }) {
  const base = (p) => path.basename(String(p || ''));
  const at = (p) => treeKey(p);
  const ours = agents.filter((a) => a.alive && (a.kind || 'claude') === 'claude' && a.cwd);
  const bound = new Set(units.map((u) => u.agentId).filter(Boolean));
  // an agent of ours whose session is not bound to it yet shows as an outside session in its folder for a
  // moment: not a second agent
  const unbound = new Set(ours.filter((a) => !bound.has(a.id)).map((a) => at(a.cwd)));
  return [
    ...ours.map((a) => ({ id: a.id, name: a.name || units.find((u) => u.agentId === a.id)?.name || base(a.cwd) || String(a.id).slice(0, 8), cwd: a.cwd })),
    ...units
      .filter((u) => !u.owned && !u.agentId && u.cwd && !skip(u.cwd) && !unbound.has(at(u.cwd)))
      .map((u) => ({ id: `session:${u.sessionId}`, name: u.name || u.project || base(u.cwd), cwd: u.cwd, outside: true })),
  ];
}

/**
 * @param {{ id: string, name: string, cwd: string, outside?: boolean }[]} members live agents (ours, and
 *   Claude Code sessions outside Fleet Bridge: they change files just the same)
 * @param {(cwd: string) => string[]} trees
 * @returns {{ root: string, kind: 'repo' | 'folder', members: object[] }[]} only where two or more meet
 */
export function sharedGroups(members = [], trees = treesOf) {
  const groups = new Map();
  for (const m of members) {
    if (!m?.cwd) continue;
    const ts = trees(m.cwd) || [];
    const places = ts.length ? ts.map((root) => ({ root, kind: 'repo' })) : [{ root: path.resolve(m.cwd), kind: 'folder' }];
    for (const p of places) {
      const key = `${p.kind}:${treeKey(p.root)}`;
      if (!groups.has(key)) groups.set(key, { ...p, members: [] });
      const g = groups.get(key);
      if (!g.members.some((x) => x.id === m.id)) g.members.push({ id: m.id, name: m.name, cwd: m.cwd, outside: Boolean(m.outside) });
    }
  }
  return [...groups.values()].filter((g) => g.members.length > 1).sort((a, b) => treeKey(a.root).localeCompare(treeKey(b.root)));
}

/** Per member: where it meets others and whom. id -> { roots, kind, with: [{ id, name, outside }] } */
export function sharedOf(groups = []) {
  const out = new Map();
  for (const g of groups)
    for (const m of g.members) {
      const s = out.get(m.id) || { roots: [], kind: g.kind, with: [] };
      s.roots.push(g.root);
      if (g.kind === 'repo') s.kind = 'repo';
      for (const o of g.members) if (o.id !== m.id && !s.with.some((x) => x.id === o.id)) s.with.push({ id: o.id, name: o.name, outside: o.outside });
      out.set(m.id, s);
    }
  return out;
}

/** How the rules are marked in an order: looked for so they are never added twice. */
export const SHARED_MARK = '【共用仓库】';

const who = (s) => s.with.map((x) => (x.outside ? L(`${x.name}（舰桥外的会话）`, `${x.name} (a session outside Fleet Bridge)`, `${x.name}（Fleet Bridge 外のセッション）`) : x.name)).join(L('、', ', ', '、'));

/** The standing rules for an agent that is not alone in its working tree. */
export function sharedNote(s) {
  const root = s.roots.join(L('、', ', ', '、'));
  return `${SHARED_MARK}${L(
    `舰桥提示：${who(s)} 也在同一个工作区（${root}）里工作，你们改的是同一份文件。只改这条指令范围内的文件；别人改过的文件（包括只差换行符或格式的）不要还原、格式化或覆盖；提交时只 git add 自己改的文件，不要用 git add -A 或 git commit -a；不要 stash、reset、checkout 掉不是自己做的改动。发现要改的文件别人也在改，先停下，在汇报里说明。`,
    `Note from Fleet Bridge: ${who(s)} also work(s) in this same working tree (${root}); you are changing the same files. Change only the files this order is about; do not revert, reformat or overwrite files someone else changed (also those that differ only in line endings or formatting); when committing, git add only the files you changed yourself, never git add -A or git commit -a; do not stash, reset or check out changes that are not yours. If a file you need to change is being changed by someone else, stop and say so in your report.`,
    `Fleet Bridge からの注意：${who(s)} も同じ作業ツリー（${root}）で作業しており、同じファイルを変更しています。この指示の範囲のファイルだけを変更すること。他の人が変更したファイル（改行コードや書式だけの差も含む）を元に戻したり、整形したり、上書きしたりしないこと。コミットでは自分が変更したファイルだけを git add し、git add -A や git commit -a は使わないこと。自分のものではない変更を stash・reset・checkout しないこと。変更したいファイルを他の人も変更している場合は、手を止めて報告に書くこと。`,
  )}`;
}

// What each agent was last told (its trees and whom it meets there): the rules go out again only when that changes.
const told = new Map();
const signature = (s) => [...s.roots.map(treeKey).sort(), '|', ...s.with.map((x) => x.id).sort()].join('\n');

/**
 * An order with the rules after it, when the agent shares its working tree and has not been told about
 * exactly these others yet (the order's own words stay first, as the log shows them).
 * @param {string} id the agent the order goes to
 * @param {string} text
 * @param {{ roots: string[], with: object[] } | null | undefined} s its entry of sharedOf()
 */
export function sharedOrder(id, text, s) {
  const t = String(text ?? '');
  if (!s?.with?.length) {
    told.delete(id); // alone again: told anew the next time it is not
    return t;
  }
  if (!t.trim() || t.includes(SHARED_MARK)) return t;
  const sig = signature(s);
  if (told.get(id) === sig) return t;
  told.set(id, sig);
  return `${t.trim()}\n\n${sharedNote(s)}`;
}

/** A new agent got the rules with its first order, under the id it has now. */
export function noteTold(id, s) {
  if (s?.with?.length) told.set(id, signature(s));
}

/** For the tests. */
export function resetShared() {
  told.clear();
  cache.clear();
}
