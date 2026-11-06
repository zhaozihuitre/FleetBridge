// One vocabulary for a terminal's state, used by every page (unit cards, the agents list, pane title
// bars, the popped-out terminal, the widget, the phone): a shape, a color and a word, so states read
// apart without relying on color alone. A dialog on screen is told apart: a permission dialog
// (Yes / No) is "waiting for approval", a question or choice (AskUserQuestion, plan approval, a
// picker) is "waiting for an answer".
import { L } from './i18n.js';

export const STATES = {
  permit: { icon: '⚠', color: 'var(--red)', label: () => L('等授权') },
  question: { icon: '?', color: 'var(--red)', label: () => L('等回答') },
  busy: { icon: '▶', color: 'var(--cyan)', label: () => L('作战中') },
  idle: { icon: '◆', color: 'var(--amber)', label: () => L('待命') },
  standby: { icon: '◇', color: 'var(--muted)', label: () => L('休眠') },
  offline: { icon: '○', color: 'var(--dim)', label: () => L('未出击') },
  boot: { icon: '…', color: 'var(--muted)', label: () => L('启动中') },
  shell: { icon: '›', color: 'var(--green)', label: () => L('终端') },
  exited: { icon: '✕', color: 'var(--muted)', label: () => L('已退出') },
};

/** Waiting on a person: which kind ('permit' / 'question'), or null. */
export function waitingKind(u) {
  if (!u?.permission) return null;
  return u.permission.prompt?.kind === 'question' ? 'question' : 'permit';
}

/**
 * The state key of a unit (a session) and/or one of our agents.
 * @param {object | null} u unit from the state (may be missing while an agent starts)
 * @param {{ agent?: object, standbyMs?: number, now?: number }} [o]
 */
export function stateKey(u, o = {}) {
  const a = o.agent;
  if (a && a.alive === false) return 'exited';
  if (a?.kind === 'shell') return 'shell';
  if (u?.offline) return 'offline';
  if (!u) return a ? 'boot' : 'offline';
  const w = waitingKind(u);
  if (w) return w;
  if (u.status === 'busy') return 'busy';
  const now = o.now || Date.now();
  if (o.standbyMs && now - (u.statusSince || now) > o.standbyMs) return 'standby';
  return 'idle';
}

export const stateOf = (u, o) => {
  const key = stateKey(u, o);
  const s = STATES[key];
  return { key, icon: s.icon, color: s.color, label: s.label() };
};

/** The state as a small chip: shape + word in the state's color. */
export function stateChip(u, o) {
  const s = stateOf(u, o);
  return `<span class="st-chip st-${s.key}" style="--sc:${s.color}"><i aria-hidden="true">${s.icon}</i>${s.label}</span>`;
}
