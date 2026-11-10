import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { L } from './i18n.js';
import { currentOrg, LIMIT_RE, orgAt, orgInfo } from './accounts.js';
import { clipSentence, kindIcon, kindWord, lastTurn, notifySettings, summarize } from './summary.js';

// Notices: what is worth telling you without looking at a screen, decided once here and shown by every
// channel the same way (desktop toasts from the widget, phone push, the lists): each says which
// terminal, what kind of thing happened, and for a finished turn a summary of its answer.
//   permit / question       a dialog waits on you (approval vs a question or choice), told at once
//   done / ask              a turn ended: its summary; "ask" when the answer asks you something. Told as
//                           soon as the transcript says the turn is over (end_turn, interrupted, an API
//                           error), after at most 15 s for the model's summary; idle 20 s otherwise
//   interrupted / error     a turn stopped by you (Esc, a tool use turned down) or by an API error
//   never_ran               an order of the master's that never ran (from the master's turns)
//   overload / alert        context nearly full (hourly per session), quota low
//   sysload                 memory short / CPU busy for a minute (server/sysload.js), once per shortage
// Nothing that was already pending when the server started is told (no burst after an update).

const READY_AFTER = 20_000; // without word from the transcript: idle this long before a turn counts as done
const MODEL_WAIT = 15_000; // a finished turn waits this long at most for the model's summary
const OVERLOAD_EVERY = 3_600_000;
const KEEP_MS = 15 * 60_000;

let notices = []; // newest last: { key, kind, at, unit fields..., title, result, needs, by }
const told = new Set();
let primed = false;
const overloadAt = new Map();

function add(n) {
  if (told.has(n.key)) return;
  told.add(n.key);
  if (told.size > 2000) told.delete(told.values().next().value);
  const at = Date.now();
  notices.push({ ...n, at });
  remember({ ...n, at });
}

// The recent notices list (command center and phone): the last HISTORY_MAX notices, kept in the data folder
// so a restart or an update does not lose them. Only what a list shows is kept (no prompt texts).
const HISTORY_MAX = 100;
const HISTORY_FILE = path.join(DATA_DIR, 'notice-history.json');
let history = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(list) ? list.slice(-HISTORY_MAX) : [];
  } catch {
    return [];
  }
})();
let saveTimer = null;
function remember(n) {
  const keep = ['key', 'kind', 'at', 'agentId', 'sessionId', 'name', 'project', 'owned', 'org', 'title', 'result', 'needs'];
  history.push(Object.fromEntries(keep.filter((k) => n[k] != null && n[k] !== '').map((k) => [k, n[k]])));
  history = history.slice(-HISTORY_MAX);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
    } catch {
      // the list stays in memory; the next notice tries again
    }
  }, 1000);
}
/** The recent notices, newest first, for the lists. */
export const noticeHistory = () => [...history].reverse();

/** For the master's turns that never ran (index.js): the same channels as the others. */
export function noticeNeverRan({ agentId, sessionId, name, project, text, since }) {
  add({ key: `never:${agentId}:${since}`, kind: 'never_ran', agentId, sessionId, name, project, title: L('指令没有执行：{0}', 'The order did not run: {0}', '指示が実行されませんでした：{0}').replace('{0}', clipSentence(text, 30)), result: L('会话记录里没有这条指令的任何动作，多半是指令前弹出的对话框被取消了。', 'Nothing of it is in the transcript: most likely a dialog before it was cancelled.', '会話記録に動きがありません。直前のダイアログがキャンセルされた可能性があります。'), needs: L('看一下屏幕，需要的话重新派。', 'Check the screen and send it again if needed.', '画面を確認し、必要なら再送してください。') });
}

/** Memory running short or the CPU busy for a minute (server/sysload.js): once per shortage, naming what takes it. */
export function noticeSystem({ kind, avail, total, cpu, top }) {
  const gb = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';
  const mb = (b) => (b >= 1024 ** 3 ? gb(b) : Math.round(b / 1024 ** 2) + ' MB');
  const title =
    kind === 'mem'
      ? L('内存只剩 {0}', 'Only {0} of memory left', 'メモリ残り {0}').replace('{0}', gb(avail))
      : L('CPU 已经满载 1 分钟（{0}%）', 'CPU fully busy for a minute ({0}%)', 'CPU が 1 分間フル稼働（{0}%）').replace('{0}', cpu);
  const result = top ? L('{0} 的 {1} 占 {2}', "{0}'s {1} takes {2}", '{0} の {1} が {2} 使用').replace('{0}', top.unit).replace('{1}', top.label).replace('{2}', mb(top.mem)) : '';
  add({ key: `sys:${kind}:${Date.now()}`, kind: 'sysload', name: L('电脑', 'This computer', 'このパソコン'), title, result, needs: L('在总指令台的「系统负荷」里看是谁占的。', 'See who takes it in the command desk\'s "System load".', '総指令台の「システム負荷」で確認。') });
}

/**
 * Called on every publish.
 * @param {object[]} units live sessions (state.units)
 * @param {object[]} quests state.quests (for the quota alert)
 * @param {Map<string, object>} prompts sessionId -> the dialog read off our agents' screens
 * @param {{ quotaLow?: boolean }} [o]
 */
export function updateNotices(units, quests, prompts, o = {}) {
  const now = Date.now();
  for (const u of units) {
    const who = { agentId: u.agentId || null, sessionId: u.sessionId, name: u.name || u.project, project: u.project, owned: Boolean(u.owned) };
    if (u.permission) {
      const p = prompts.get(u.sessionId);
      let kind = p?.kind === 'question' ? 'question' : 'permit';
      const opts = p?.options?.length ? p.options.map((x) => `${x.key}. ${x.label}`).join(' / ') : '';
      const q = (p?.text || u.permission.message || '').split('\n').map((l) => l.trim()).filter(Boolean);
      // a dialog about the quota ("… now uses usage credits"): whose quota
      const quota = LIMIT_RE.test(q.join(' ')) ? orgInfo(currentOrg())?.name || L('组织未知', 'unknown organization', '組織不明') : '';
      if (quota) kind = 'limit'; // "… now uses usage credits": the quota's business, its choices still answer it
      prime(`ask:${u.sessionId}:${u.permission.at}`, () => ({ kind, ...who, org: quota || undefined, title: (quota ? `[${quota}] ` : '') + clipSentence(q[0] || '', 50), result: clipSentence(q.slice(1).join(' '), 120), needs: opts ? clipSentence(opts, 120) : '' }));
      continue;
    }
    if (u.contextPct != null && u.contextPct >= config.thresholds.contextWarnPct && now - (overloadAt.get(u.sessionId) || 0) > OVERLOAD_EVERY) {
      overloadAt.set(u.sessionId, now);
      prime(`ctx:${u.sessionId}:${Math.floor(now / OVERLOAD_EVERY)}`, () => ({ kind: 'overload', ...who, title: L('记忆负载 {0}%', 'Context at {0}%', 'コンテキスト {0}%').replace('{0}', Math.round(u.contextPct)), result: L('再打几轮就会自动压缩。', 'A few more rounds and it auto-compacts.', 'あと数回で自動圧縮されます。'), needs: L('可以先 /compact 或开新会话。', '/compact first, or start a new session.', '先に /compact か新しいセッションを。') }));
    }
    if (u.status !== 'idle') continue;
    const key = `ready:${u.sessionId}:${u.statusSince}`;
    if (told.has(key)) continue;
    if (!primed) {
      told.add(key);
      continue;
    }
    const turn = lastTurn(u.sessionId);
    // over by its transcript: at once; else only after a while idle (the pauses between steps are not "done")
    const wait = turn?.ended ? 0 : READY_AFTER;
    if (now - (u.statusSince || now) < wait) continue;
    // no transcript yet (a brand-new session): look again, give up after two minutes
    if (!turn) {
      if (now - (u.statusSince || now) > 120_000) told.add(key);
      continue;
    }
    // nothing new: a resumed session shows up idle with its old answer, which is no news
    if (!turn.lastAt || turn.lastAt < (u.statusSince || 0) - 120_000) {
      told.add(key);
      continue;
    }
    // the model summarizes our own agents' turns; outside sessions only when you chose so (it costs quota)
    const s = summarize(key, turn, { useModel: u.owned || notifySettings().modelExternal, quotaLow: o.quotaLow });
    const late = now - (u.statusSince || now) > wait + MODEL_WAIT;
    if (!s.done && !late) continue; // the model's summary is on its way
    let kind = turn.error ? 'error' : turn.interrupted ? 'interrupted' : s.summary.needs ? 'ask' : 'done';
    let { title, result, needs, by } = s.summary;
    let org;
    if (kind === 'error') {
      [title, result, needs] = [clipSentence(turn.error, 50), title ? L('出错前：', 'Before it: ', 'エラー前：') + title : '', ''];
      // the quota ran out: a kind of its own, saying whose (the organization signed in when it happened)
      if (LIMIT_RE.test(turn.error)) {
        kind = 'limit';
        org = orgInfo(orgAt(turn.lastAt) || currentOrg())?.name || L('组织未知', 'unknown organization', '組織不明');
        // short enough for a phone's title line: whose, and when it comes back ("resets 6pm")
        const back = turn.error.match(/resets?\s+(?:at\s+)?([^·(（\n]+?)\s*(?:[·(（]|$)/i)?.[1];
        title = L('「{0}」额度用完', '{0} quota used up', '「{0}」の利用枠を使い切り').replace('{0}', org) + (back ? L('，{0} 重置', ', back {0}', '、{0} にリセット').replace('{0}', back) : '');
        result = turn.error + (result ? '\n' + result : '');
        needs = L('等额度重置，或 /login 换到另一个组织。', 'Wait for the reset, or /login to the other organization.', 'リセットを待つか、/login で別の組織へ。');
      }
    }
    if (kind === 'interrupted') [result, needs] = [turn.lastTool ? L('停在：', 'Stopped at: ', '停止位置：') + turn.lastTool : result, L('等你的新指示。', 'Waiting for what to do instead.', '次の指示を待っています。')];
    if (!title) title = clipSentence(turn.prompt, 40);
    add({ key, kind, ...who, org, title, result, needs, by, order: clipSentence(turn.prompt, 60) });
  }
  // quota low
  for (const q of quests) if (q.kind === 'ALERT') prime(q.key, () => ({ kind: 'alert', name: L('额度', 'Quota', '利用枠'), title: q.title, result: q.goal || '', needs: '' }));
  primed = true;
  notices = notices.filter((n) => now - n.at < KEEP_MS).slice(-30);
}

// what was already pending when we started is not news
function prime(key, make) {
  if (told.has(key)) return;
  if (!primed) return void told.add(key);
  add({ key, ...make() });
}

export const recentNotices = () => notices;

/* ---------- each channel's text ---------- */

const head = (n) => `${kindIcon(n.kind)} ${n.name || ''} ${kindWord(n.kind)}`.trim();

/** Desktop toast: a short title, the result and what it needs of you (about 4 lines). */
export function toastText(n) {
  const title = clipSentence(`${head(n)}${n.title ? '：' + n.title : ''}`, 60);
  const body = [n.result && n.result !== n.title ? n.result : '', n.needs ? L('需要你：', 'For you: ', '対応：') + n.needs : ''].filter(Boolean).join('\n');
  return { title, body: clipSentence(body, 150).replace(/ (需要你：|For you: |対応：)/, '\n$1') };
}

/** Phone push: with content (it passes through the ntfy server) or only what happened where. */
export function pushText(n, withContent) {
  // whose quota ran out is no content: it is told even then
  if (!withContent) return { title: head(n) + (n.org ? ` · ${n.org}` : ''), body: L('打开手机页查看。', 'Open the phone page to see it.', 'スマホページで確認してください。') };
  // the title: icon, project, conclusion ("🟡 monitor：手机版按钮只在触屏设备上显示"); the body: what it
  // needs of you first, then what came out of it; 250 characters at most, never the answer itself
  const title = n.title ? clipSentence(`${kindIcon(n.kind)} ${n.name || ''}：${n.title}`, 60) : head(n);
  const needs = n.needs ? clipSentence(L('需要你：', 'For you: ', '対応：') + n.needs, 130) : '';
  const room = 250 - needs.length - 1;
  const result = n.result && n.result !== n.title && room > 20 ? clipSentence(n.result, room) : '';
  return { title, body: [needs, result].filter(Boolean).join('\n') || L('打开手机页查看。', 'Open the phone page to see it.', 'スマホページで確認してください。') };
}

/** One line for lists (task list, widget, phone page cards). */
export const lineText = (n) => clipSentence(`${kindIcon(n.kind)} ${n.title || kindWord(n.kind)}`, 80);
