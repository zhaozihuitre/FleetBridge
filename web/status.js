// One vocabulary for a terminal's state, used by every page (unit cards, the agents list, pane title
// bars, the popped-out terminal, the widget, the phone): a status light (lamp.css: a color per state, a
// breathing rate per urgency), a shape and a word, so states read apart without relying on color or motion
// alone. A dialog on screen is told apart: a permission dialog (Yes / No) is "waiting for approval", a
// question or choice (AskUserQuestion, plan approval, a picker) is "waiting for an answer". Hovering (or
// focusing, or tapping on the phone) a light shows what it is about and for how long (tip.js).
import { L } from './i18n.js';

// lamp: [style, seconds per breath]; breathe = soft, sharp = urgent, once = flashes when it begins then holds,
// flash = flashes then dims, static = steady, off = hollow
export const STATES = {
  error: { icon: '✕', color: 'var(--lamp-error)', label: () => L('出错'), lamp: ['sharp', 0.55], what: () => L('额度到限、API 出错、终端异常退出') },
  permit: { icon: '⚠', color: 'var(--lamp-permit)', label: () => L('等授权'), lamp: ['sharp', 0.9], what: () => L('弹出了权限对话框，终端停在那里等你') },
  question: { icon: '?', color: 'var(--lamp-question)', label: () => L('等回答'), lamp: ['breathe', 1.4], what: () => L('在问你问题、让你选方案') },
  warn: { icon: '!', color: 'var(--lamp-warn)', label: () => L('警告'), lamp: ['breathe', 1.2], what: () => L('额度快用完、上下文快满（还没出错）') },
  done: { icon: '✓', color: 'var(--lamp-done)', label: () => L('完成待查看'), lamp: ['once', 0], what: () => L('一轮做完了，你还没点开看') },
  git: { icon: '⎇', color: 'var(--lamp-git)', label: () => L('提醒'), lamp: ['breathe', 4], what: () => L('git 卡在合并中途、改动很久没提交、提交没推送') },
  sys: { icon: 'i', color: 'var(--lamp-sys)', label: () => L('系统消息'), lamp: ['flash', 0], what: () => L('账号切换、上下文压缩、会话结束、额度回充') },
  busy: { icon: '▶', color: 'var(--lamp-busy)', label: () => L('作战中'), lamp: ['breathe', 2.4], what: () => L('正在执行指令') },
  idle: { icon: '◆', color: 'var(--lamp-idle)', label: () => L('待命'), lamp: ['breathe', 6], what: () => L('空闲，做完的结果你已经看过') },
  standby: { icon: '◇', color: 'var(--lamp-standby)', label: () => L('休眠'), lamp: ['static', 0], what: () => L('很久没有动静') },
  boot: { icon: '…', color: 'var(--lamp-boot)', label: () => L('启动中'), lamp: ['breathe', 1.2], what: () => L('终端刚开，还没连上会话') },
  shell: { icon: '›', color: 'var(--lamp-shell)', label: () => L('终端'), lamp: ['static', 0], what: () => L('普通终端（不是 Claude Code）') },
  exited: { icon: '■', color: 'var(--lamp-exited)', label: () => L('已退出'), lamp: ['off', 0], what: () => L('终端已经退出') },
  offline: { icon: '○', color: 'var(--lamp-exited)', label: () => L('未出击'), lamp: ['off', 0], what: () => L('会话没有在运行') },
};
// the order of the legend (most urgent first)
export const LEGEND = ['error', 'permit', 'question', 'warn', 'done', 'git', 'sys', 'busy', 'idle', 'standby', 'exited'];
const RATE = { breathe: (p) => L('{0} 秒一次', p), sharp: (p) => L('{0} 秒一次', p), once: () => L('闪一次后常亮'), flash: () => L('闪一次后变暗'), static: () => L('不呼吸'), off: () => L('空心') };
export const lampRate = (key) => {
  const [style, p] = STATES[key].lamp;
  return RATE[style](p);
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Waiting on a person: which kind ('permit' / 'question'), or null. */
export function waitingKind(u) {
  if (!u?.permission) return null;
  return u.permission.prompt?.kind === 'question' ? 'question' : 'permit';
}

// an agent that ended on its own with an error code (not closed by you, not lost with the PTY host: -1)
const crashed = (a) => a && a.alive === false && a.exitCode > 0 && !a.endedByUser;

/**
 * The state key of a unit (a session) and/or one of our agents.
 * @param {object | null} u unit from the state (may be missing while an agent starts)
 * @param {{ agent?: object, standbyMs?: number, now?: number }} [o]
 */
export function stateKey(u, o = {}) {
  const a = o.agent;
  if (a && a.alive === false) return crashed(a) ? 'error' : 'exited';
  if (a?.kind === 'shell') return 'shell';
  if (u?.offline) return 'offline';
  if (!u) return a ? 'boot' : 'offline';
  const w = waitingKind(u);
  if (w) return w;
  if (u.status === 'busy') return 'busy';
  if (u.limit || u.apiError) return 'error';
  // a turn that ended after you last opened its terminal (seenAt from the server; first sight counts as seen)
  if (u.seenAt && (u.statusSince || 0) > u.seenAt) return 'done';
  const now = o.now || Date.now();
  if (o.standbyMs && now - (u.statusSince || now) > o.standbyMs) return 'standby';
  return 'idle';
}

export const stateOf = (u, o) => {
  const key = stateKey(u, o);
  const s = STATES[key];
  return { key, icon: s.icon, color: s.color, label: s.label() };
};

/** When the state began, and what the tooltip says about it. */
export function lampDetail(key, u, a) {
  const p = u?.permission;
  switch (key) {
    case 'permit':
      return { text: L('要授权：') + (p?.message || L('需要你确认')), since: p?.at };
    case 'question':
      return { text: L('在问：') + (p?.message || p?.prompt?.text?.split('\n')[0] || L('需要你选择')), since: p?.at };
    case 'error':
      if (u?.limit) return { text: L('额度到限：') + u.limit.text, since: u.limit.at };
      if (u?.apiError) return { text: L('API 出错：') + u.apiError.text, since: u.apiError.at };
      return { text: L('终端异常退出（退出码 {0}）', a?.exitCode ?? '?'), since: a?.exitedAt };
    case 'busy':
      return { text: u?.lastPrompt ? L('执行：') + u.lastPrompt : STATES.busy.what(), since: u?.statusSince };
    case 'done':
      return { text: L('做完了：') + (u?.summary || u?.lastText || L('（没有文字汇报）')), since: u?.statusSince };
    case 'idle':
    case 'standby':
      return { text: u?.summary || u?.lastText ? L('最后汇报：') + (u.summary || u.lastText) : STATES[key].what(), since: u?.statusSince };
    case 'exited':
      return { text: a?.exitCode != null && a.exitCode >= 0 ? L('已退出（退出码 {0}）', a.exitCode) : STATES.exited.what(), since: a?.exitedAt };
    default:
      return { text: STATES[key].what(), since: null };
  }
}

/**
 * The light alone. since: when the state began (a light that flashes once plays when it begins, not on every
 * re-render); a breathing light takes its phase from the clock, so re-rendering never restarts it.
 */
export function lamp(key, since) {
  const [style, p] = STATES[key].lamp;
  // the markup holds nothing that changes with time (pages compare it to skip re-rendering): the phase is set
  // when the element appears (syncLamp)
  const at = p ? ` data-lp="${p}"` : style === 'once' || style === 'flash' ? ` data-at="${Number(since) || 0}"` : '';
  return `<i class="lamp ${style}" style="--lc:${STATES[key].color};${p ? `--lp:${p}s` : ''}"${at} aria-hidden="true"></i>`;
}

// A light's place in its cycle: a breathing one by the clock (re-created on a re-render, it carries on where it
// was), one that flashes once by how long ago its state began (it doesn't flash again on a re-render)
function syncLamp(el) {
  if (el.style.getPropertyValue('--ph')) return;
  const p = Number(el.dataset.lp);
  const now = Date.now();
  if (p) el.style.setProperty('--ph', `-${((now % (p * 1000)) / 1000).toFixed(2)}s`);
  else if (el.dataset.at !== undefined) el.style.setProperty('--ph', `-${Math.max(0, (now - Number(el.dataset.at)) / 1000).toFixed(1)}s`);
}
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  new MutationObserver((list) => {
    for (const m of list)
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('.lamp')) syncLamp(n);
        n.querySelectorAll('.lamp').forEach(syncLamp);
      }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/** Attributes that make an element show the light's tooltip (tip.js) on hover / focus / tap (focusable: not
 * inside a button or a link, which has its own focus). */
export function lampAttrs(key, u, a, focusable = true) {
  const d = lampDetail(key, u, a);
  return ` data-lamp="${key}" data-lamp-text="${esc(d.text)}"${d.since ? ` data-lamp-since="${d.since}"` : ''}${focusable ? ' tabindex="0"' : ''}`;
}

/** The state as a small chip: light + shape + word in the state's color, with its tooltip. */
export function stateChip(u, o = {}, extra = '') {
  const s = stateOf(u, o);
  const d = lampDetail(s.key, u, o.agent);
  return `<span class="st-chip st-${s.key}" style="--sc:${s.color}"${lampAttrs(s.key, u, o.agent)}>${lamp(s.key, d.since)}<i aria-hidden="true">${s.icon}</i>${esc(s.label)}${extra}</span>`;
}

/** The legend: every light, what it means and how it breathes. */
export function legendHtml() {
  return `<ul class="lamp-legend">${LEGEND.map((k) => `<li style="--lc:${STATES[k].color}" title="">${lamp(k, 0)}<b>${esc(STATES[k].label())}</b><span>${esc(lampRate(k))} · ${esc(STATES[k].what())}</span></li>`).join('')}</ul><p class="lamp-legend-note">${esc(L('呼吸越快越急。开了「减少动态效果」时灯不呼吸，只看颜色和图标。悬停在灯上可以看详细说明。'))}</p>`;
}
