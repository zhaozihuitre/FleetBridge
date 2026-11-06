import { config } from './config.js';
import { L } from './i18n.js';
import { clipSentence, kindIcon, kindWord, lastTurn, notifySettings, summarize } from './summary.js';

// Notices: what is worth telling you without looking at a screen, decided once here and shown by every
// channel the same way (desktop toasts from the widget, phone push, the lists): each says which
// terminal, what kind of thing happened, and for a finished turn a summary of its answer.
//   permit / question       a dialog waits on you (approval vs a question or choice), told at once
//   done / ask              a turn ended (idle 20 s): its summary; "ask" when the answer asks you something
//   interrupted / error     a turn stopped by you (Esc, a tool use turned down) or by an API error
//   never_ran               an order of the master's that never ran (from the master's turns)
//   overload / alert        context nearly full (hourly per session), quota low
// Nothing that was already pending when the server started is told (no burst after an update).

const READY_AFTER = 20_000; // idle this long before a turn counts as done (not the pauses between steps)
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
  notices.push({ ...n, at: Date.now() });
}

/** For the master's turns that never ran (index.js): the same channels as the others. */
export function noticeNeverRan({ agentId, sessionId, name, project, text, since }) {
  add({ key: `never:${agentId}:${since}`, kind: 'never_ran', agentId, sessionId, name, project, title: L('指令没有执行：{0}', 'The order did not run: {0}', '指示が実行されませんでした：{0}').replace('{0}', clipSentence(text, 30)), result: L('会话记录里没有这条指令的任何动作，多半是指令前弹出的对话框被取消了。', 'Nothing of it is in the transcript: most likely a dialog before it was cancelled.', '会話記録に動きがありません。直前のダイアログがキャンセルされた可能性があります。'), needs: L('看一下屏幕，需要的话重新派。', 'Check the screen and send it again if needed.', '画面を確認し、必要なら再送してください。') });
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
      const kind = p?.kind === 'question' ? 'question' : 'permit';
      const opts = p?.options?.length ? p.options.map((x) => `${x.key}. ${x.label}`).join(' / ') : '';
      const q = (p?.text || u.permission.message || '').split('\n').map((l) => l.trim()).filter(Boolean);
      prime(`ask:${u.sessionId}:${u.permission.at}`, () => ({ kind, ...who, title: clipSentence(q[0] || '', 50), result: clipSentence(q.slice(1).join(' '), 120), needs: opts ? clipSentence(opts, 120) : '' }));
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
    if (now - (u.statusSince || now) < READY_AFTER) continue; // the pauses between steps are not "done"
    const turn = lastTurn(u.sessionId);
    // nothing new: a resumed session shows up idle with its old answer, which is no news
    if (!turn || !turn.lastAt || turn.lastAt < (u.statusSince || 0) - 120_000) {
      told.add(key);
      continue;
    }
    // the model summarizes our own agents' turns; outside sessions only when you chose so (it costs quota)
    const s = summarize(key, turn, { useModel: u.owned || notifySettings().modelExternal, quotaLow: o.quotaLow });
    const late = now - (u.statusSince || now) > READY_AFTER + MODEL_WAIT;
    if (!s.done && !late) continue; // the model's summary is on its way
    let kind = turn.error ? 'error' : turn.interrupted ? 'interrupted' : s.summary.needs ? 'ask' : 'done';
    let { title, result, needs, by } = s.summary;
    if (kind === 'error') [title, result, needs] = [clipSentence(turn.error, 50), title ? L('出错前：', 'Before it: ', 'エラー前：') + title : '', ''];
    if (kind === 'interrupted') [result, needs] = [turn.lastTool ? L('停在：', 'Stopped at: ', '停止位置：') + turn.lastTool : result, L('等你的新指示。', 'Waiting for what to do instead.', '次の指示を待っています。')];
    if (!title) title = clipSentence(turn.prompt, 40);
    add({ key, kind, ...who, title, result, needs, by, order: clipSentence(turn.prompt, 60) });
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
  if (!withContent) return { title: head(n), body: L('打开手机页查看。', 'Open the phone page to see it.', 'スマホページで確認してください。') };
  const t = toastText(n);
  return { title: t.title, body: clipSentence([n.result, n.needs ? L('需要你：', 'For you: ', '対応：') + n.needs : ''].filter(Boolean).join(' '), 250) };
}

/** One line for lists (task list, widget, phone page cards). */
export const lineText = (n) => clipSentence(`${kindIcon(n.kind)} ${n.title || kindWord(n.kind)}`, 80);
