// The "待决定 DECIDE" tab: what you still owe an answer to (server/pending.js), kept until you answer it.
// Grouped by project (the group with the oldest first), oldest first inside; how long each has waited, yellow
// after 2 hours, red after 24 (and named in the banner). Each item: its options as buttons, an answer box (the
// answer goes to the terminal that asked: now when it is idle, queued when busy), later, drop, its report.
// Fleet Bridge's own (proposals, orders on hold, a folder-trust dialog) follow their own state and come last.
import { L } from './i18n.js';
import { ask } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const AMBER = 2 * 3_600_000;
const RED = 24 * 3_600_000;
let deps = { post: null, toast: () => {}, render: () => {}, setTab: () => {}, openTerm: () => {}, agentAlive: () => false };
let pv = null; // the list as the server last sent it (state.pending)
const drafts = new Map(); // id -> what is typed in its answer box (kept across redraws)
let showRecent = false;
let report = null; // { id, text } shown under its item
let busy = new Set();

export const level = (at, now = Date.now()) => (now - at >= RED ? 'red' : now - at >= AMBER ? 'amber' : '');

/** "3 分钟" / "2 小时 10 分" / "1 天 3 小时". */
export function waited(at, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 60) return L('{0} 分钟', Math.max(1, m));
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? L('{0} 小时 {1} 分', h, m % 60) : L('{0} 小时', h);
  return h % 24 ? L('{0} 天 {1} 小时', Math.floor(h / 24), h % 24) : L('{0} 天', Math.floor(h / 24));
}

/** Groups by project: the one with the oldest item first; inside, oldest first. Fleet Bridge's own after. */
export function groups(items) {
  const by = new Map();
  for (const x of items) {
    const k = x.project || x.agentName || L('其他');
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(x);
  }
  for (const list of by.values()) list.sort((a, b) => a.at - b.at);
  return [...by.entries()].sort((a, b) => a[1][0].at - b[1][0].at);
}

export function setPending(p) {
  pv = p || null;
}
export const pendingCount = () => pv?.count || 0;
export const pendingRed = () => pv?.red || 0;
export const pendingOf = (agentId) => pv?.byAgent?.[agentId] || 0;

const SRC = () => ({ report: L('汇报'), dialog: L('对话框'), master: L('主控'), auto: L('自动') });
const SYS = () => ({ approve: L('改善提案 · 等你批准'), install: L('改善提案 · 等你决定更新'), held: L('暂停的指令'), trust: L('等你信任文件夹') });

function item(x, now) {
  const lv = level(x.at, now);
  const gone = x.agentId && !deps.agentAlive(x.agentId);
  const tags = [
    `<span class="pd-tag">${esc(SRC()[x.source] || x.source)}</span>`,
    `<span class="pd-tag">${x.kind === 'do' ? L('要你动手') : L('要你决定')}</span>`,
    x.seen > 1 ? `<span class="pd-tag">${L('合并 {0} 次', x.seen)}</span>` : '',
    x.stale ? `<span class="pd-tag dim" title="${esc(L('这个终端后来的汇报里没再提，可能已经解决'))}">${L('后来没再提')}</span>` : '',
  ].join('');
  const who = x.agentName && x.agentName !== x.project ? ` · ${esc(x.agentName)}` : '';
  const off = busy.has(x.id) ? ' disabled' : '';
  const opts = x.options.map((o) => `<button type="button" class="pd-btn p" data-pd-opt="${esc(o.key)}"${off}>${esc(o.label)}</button>`).join('');
  const done = x.kind === 'do' && !x.options.length ? `<button type="button" class="pd-btn p" data-pd-done${off}>${L('做好了')}</button>` : '';
  const sendTo = x.source === 'dialog' ? '' : x.agentId ? (gone ? L('终端已关闭：答复只记下，不转达') : L('答复会转给 {0}', x.agentName || x.project)) : L('答复会转给主控');
  const box =
    x.source === 'dialog'
      ? ''
      : `<div class="pd-ans"><textarea rows="1" data-pd-draft="${esc(x.id)}" placeholder="${esc(sendTo)}">${esc(drafts.get(x.id) || '')}</textarea><button type="button" class="pd-btn p" data-pd-send${off}>${L('答复')}</button></div>`;
  const rep = report?.id === x.id ? `<pre class="pd-report">${esc(report.text)}</pre>` : '';
  return `<div class="pd-item ${lv}${x.stale ? ' stale' : ''}" data-pd-id="${esc(x.id)}">
    <div class="pd-h"><b>${esc(x.id)}</b>${tags}<span class="pd-age">${L('等了 {0}', waited(x.at, now))}</span>${who}${gone ? `<span class="pd-gone">${L('终端已关闭')}</span>` : ''}${x.status === 'snoozed' ? `<span class="pd-tag">${L('稍后 · {0} 回来', new Date(x.snoozeUntil).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</div>
    <div class="pd-q">${esc(x.text)}</div>
    ${x.suggestion ? `<div class="pd-sug">${L('建议：')}${esc(x.suggestion)}</div>` : ''}
    <div class="pd-btns">${opts}${done}
      <span class="pd-later"><button type="button" class="pd-btn" data-pd-later="1h"${off}>${L('稍后 1 小时')}</button><button type="button" class="pd-btn" data-pd-later="evening"${off}>${L('今天傍晚')}</button><button type="button" class="pd-btn" data-pd-later="tomorrow"${off}>${L('明天 9:00')}</button></span>
      <button type="button" class="pd-btn" data-pd-drop${off}>${L('不做了')}</button>
      ${x.refs?.some((r) => r.hasReport) ? `<button type="button" class="pd-btn" data-pd-report>${report?.id === x.id ? L('收起原汇报') : L('看原汇报')}</button>` : ''}
      ${x.agentId && !gone ? `<button type="button" class="pd-btn" data-pd-term="${esc(x.agentId)}">${L('打开终端')}</button>` : ''}
    </div>${box}${rep}</div>`;
}

function sysItem(x, now) {
  const lv = level(x.at, now);
  const btns = {
    approve: `<button type="button" class="pd-btn p" data-pd-sys="proposals">${L('去审批')}</button>`,
    install: `<button type="button" class="pd-btn p" data-pd-sys="proposals">${L('查看并决定')}</button>`,
    held: `<button type="button" class="pd-btn p" data-pd-requeue="${esc(x.agentId)}">${L('续发')}</button><button type="button" class="pd-btn" data-pd-unqueue="${esc(x.agentId)}">${L('移除')}</button>`,
    trust: `<button type="button" class="pd-btn p" data-pd-trust="${esc(x.agentId)}">${L('信任')}</button><button type="button" class="pd-btn" data-pd-term="${esc(x.agentId)}">${L('打开终端')}</button>`,
  }[x.sys];
  const what = x.sys === 'held' ? L('{0} 条：', x.n) + x.text : x.text;
  return `<div class="pd-item sys ${lv}"><div class="pd-h"><b>${esc(x.sys === 'approve' || x.sys === 'install' ? x.id : x.agentName || x.project)}</b><span class="pd-tag">${esc(SYS()[x.sys] || x.sys)}</span><span class="pd-age">${L('等了 {0}', waited(x.at, now))}</span></div>
    <div class="pd-q">${esc(what)}</div><div class="pd-btns">${btns || ''}</div></div>`;
}

function recentRow(x) {
  const how = { sent: L('已转达'), queued: L('已排队转达'), master: L('已告诉主控'), 'not-sent': L('未转达') }[x.answer?.delivered] || '';
  const word = x.status === 'answered' ? L('已答') : x.status === 'dropped' ? L('不做了') : L('已失效');
  const ans = x.answer?.text || (x.answer?.option != null ? x.options.find((o) => o.key === String(x.answer.option))?.label || x.answer.option : '');
  return `<div class="pd-recent"><b>${esc(x.id)}</b><span class="pd-tag">${esc(word)}</span><span class="pd-q1">${esc(x.text)}</span>${ans ? `<span class="pd-a">→ ${esc(ans)}</span>` : ''}<span class="pd-tag dim">${esc(how)}</span>${x.status !== 'expired' ? `<button type="button" class="pd-btn" data-pd-reopen="${esc(x.id)}">${L('撤销')}</button>` : ''}</div>`;
}

export function pendingPage(now = Date.now()) {
  if (!pv) return `<div class="pending"><div class="pd-empty">${L('读取中…')}</div></div>`;
  const banner = pv.red ? `<div class="pd-banner">⚠ ${L('{0} 条等了超过 24 小时：', pv.red)}${esc(pv.redList.map((x) => `${x.id}（${x.project || x.agentName || ''}）`).join('、'))}</div>` : '';
  const damaged = pv.damaged ? `<div class="pd-banner">${L('清单文件读不出来，已另存为 .bad，现在从空清单开始。')}</div>` : '';
  const body = groups(pv.open)
    .map(([name, list]) => `<div class="o-day">${esc(name)} · ${list.length}</div>${list.map((x) => item(x, now)).join('')}`)
    .join('');
  const sys = pv.system.length ? `<div class="o-day">${L('舰桥 · {0}（跟随原状态）', pv.system.length)}</div>${pv.system.map((x) => sysItem(x, now)).join('')}` : '';
  const snoozed = pv.snoozed.length ? `<div class="o-day">${L('稍后 · {0}', pv.snoozed.length)}</div>${pv.snoozed.map((x) => item(x, now)).join('')}` : '';
  const empty = !body && !sys ? `<div class="pd-empty">${L('没有等你决定的事。终端汇报里「需要用户」的事项、2 分钟没人答的授权框和选择框、主控问你的问题，都会留在这里，直到你答复。')}</div>` : '';
  const recent = pv.recent.length
    ? `<div class="o-day pd-toggle" data-pd-recent>${showRecent ? '▾' : '▸'} ${L('最近答复 · {0}', pv.recent.length)}</div>${showRecent ? pv.recent.map(recentRow).join('') : ''}`
    : '';
  return `<div class="pending"><div class="archive-head"><span class="mono">DECIDE</span><span>${L('等你决定 {0} 条 · 答复会转给提问的终端', pv.count)}</span></div>${damaged}${banner}${body}${sys}${empty}${snoozed}${recent}</div>`;
}

/** When a snoozed item comes back. */
export function laterAt(which, now = Date.now()) {
  const d = new Date(now);
  if (which === '1h') return now + 3_600_000;
  if (which === 'evening') {
    d.setHours(18, 0, 0, 0);
    return d.getTime() > now + 10 * 60_000 ? d.getTime() : now + 3_600_000;
  }
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

async function act(body, id) {
  busy.add(id);
  deps.render();
  try {
    const r = await deps.post('/api/pending', body);
    if (!r.ok) deps.toast(L('没有成功：{0}', r.error || '?'));
    else if (body.action === 'answer' || body.action === 'drop') {
      drafts.delete(id);
      const how = { sent: L('已转给终端'), queued: L('终端在忙，已排队'), master: L('已告诉主控'), 'not-sent': L('已记下（没有转达）') }[r.delivered] || '';
      deps.toast(`${id} · ${how}`);
    } else if (body.action === 'snooze') deps.toast(L('{0} 稍后再提醒', id));
    else if (body.action === 'reopen') deps.toast(L('{0} 已重新打开', id));
    return r;
  } finally {
    busy.delete(id);
    deps.render();
  }
}

export function initPending(d) {
  deps = { ...deps, ...d };
  document.addEventListener('input', (e) => {
    const id = e.target?.dataset?.pdDraft;
    if (id) drafts.set(id, e.target.value);
  });
  document.addEventListener('keydown', (e) => {
    const id = e.target?.dataset?.pdDraft;
    if (id && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.target.closest('.pd-item')?.querySelector('[data-pd-send]')?.click();
    }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t.closest?.('.pending')) return;
    if (t.closest('[data-pd-recent]')) {
      showRecent = !showRecent;
      return deps.render();
    }
    const ro = t.closest('[data-pd-reopen]');
    if (ro) return act({ action: 'reopen', id: ro.dataset.pdReopen }, ro.dataset.pdReopen);
    const sy = t.closest('[data-pd-sys]');
    if (sy) return deps.setTab(sy.dataset.pdSys);
    const rq = t.closest('[data-pd-requeue]');
    if (rq) {
      if (!(await ask({ title: L('续发暂停的指令？'), message: L('这些指令是在会话重开或额度中断之前排的，可能已经过时。'), ok: L('续发') }))) return;
      return deps.post('/api/agents/action', { id: rq.dataset.pdRequeue, action: 'requeue' }).then(() => deps.render());
    }
    const uq = t.closest('[data-pd-unqueue]');
    if (uq) {
      if (!(await ask({ title: L('移除暂停的指令？'), message: L('这些指令不会再发出。'), ok: L('移除'), danger: true }))) return;
      return deps.post('/api/agents/action', { id: uq.dataset.pdUnqueue, action: 'unqueue', held: true }).then(() => deps.render());
    }
    const tr = t.closest('[data-pd-trust]');
    if (tr) return deps.post('/api/agents/action', { id: tr.dataset.pdTrust, action: 'trust', choice: 'trust' }).then(() => deps.render());
    const term = t.closest('[data-pd-term]');
    if (term) return deps.openTerm(term.dataset.pdTerm);
    const el = t.closest('[data-pd-id]');
    if (!el) return;
    const id = el.dataset.pdId;
    const x = [...(pv?.open || []), ...(pv?.snoozed || [])].find((i) => i.id === id);
    if (!x) return;
    const opt = t.closest('[data-pd-opt]');
    if (opt) return act({ action: 'answer', id, option: opt.dataset.pdOpt, text: (drafts.get(id) || '').trim() }, id);
    if (t.closest('[data-pd-done]')) return act({ action: 'answer', id, text: (drafts.get(id) || '').trim() || L('已完成') }, id);
    if (t.closest('[data-pd-send]')) {
      const text = (drafts.get(id) || '').trim();
      if (!text) return deps.toast(L('先写答复，或者点上面的选项'));
      return act({ action: 'answer', id, text }, id);
    }
    const later = t.closest('[data-pd-later]');
    if (later) return act({ action: 'snooze', id, until: laterAt(later.dataset.pdLater) }, id);
    if (t.closest('[data-pd-drop]')) {
      const why = (drafts.get(id) || '').trim();
      const ok = await ask({ title: L('{0} 不做了？', id), message: x.text, detail: [why ? L('原因会转给提问的终端：{0}', why) : L('不会通知提问的终端（想告诉它原因，先在答复框里写上再点「不做了」）。')], ok: L('不做了') });
      if (!ok) return;
      return act({ action: 'drop', id, text: why }, id);
    }
    if (t.closest('[data-pd-report]')) {
      if (report?.id === id) report = null;
      else {
        const r = await fetch(`/api/pending?id=${encodeURIComponent(id)}`).then((res) => res.json());
        const refs = r.item?.refs || [];
        report = { id, text: refs.map((f) => `【${f.order || ''}】\n${f.report || ''}`).join('\n\n———\n\n') || L('（没有原汇报）') };
      }
      return deps.render();
    }
  });
}
