// System load on the command desk (server/sysload.js samples it): under the radar on the deep-space bridge, under the
// four numbers in the other themes. CPU and memory with ten minutes of trend (the dashed line: where the warning
// starts), the terminals taking the most memory; folded to one line on demand (and when the window is short), a
// chip in the tab row while the desk is collapsed. The drawer has everything: each terminal's processes (one under
// a terminal we started can be ended, after a confirmation naming it), Fleet Bridge itself, the other programs.
// The page tells the server what it shows, so the sampling slows down or stops when nobody looks.
import { L } from './i18n.js';
import { lamp, stateKey } from './status.js';
import { ask } from './ui.js';

const GB = 1024 ** 3;
const WARN_BYTES = 1.5 * GB;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (b) => (b >= GB ? (b / GB).toFixed(1) + 'G' : Math.round(b / 1024 ** 2) + 'M');
const long = (b) => (b >= GB ? (b / GB).toFixed(1) + ' GB' : Math.round(b / 1024 ** 2) + ' MB');
const PAGE = Math.random().toString(36).slice(2, 10);

let S = null; // state.sys
let units = []; // state.units (for the lights)
let thresholds = {};
let deps = {};
let drawerOpen = false;
let sentLevel = '';
let sentAt = 0;

const folded = () => {
  try {
    const v = localStorage.getItem('fb-sys-fold');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // no storage: the default
  }
  return innerHeight < 760; // a short window: one line unless you opened it
};
const setFolded = (on) => {
  try {
    localStorage.setItem('fb-sys-fold', on ? '1' : '0');
  } catch {
    // this page only
  }
};
const collapsed = () => Boolean(document.querySelector('.main.op-collapsed'));

// a trend: the values over the box, the warning line dashed
function spark(vals, max, cls, thr) {
  const n = vals.length;
  if (n < 2) return `<svg class="sys-spark ${cls}" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  const y = (v) => (26 - (Math.min(v, max) / max) * 25).toFixed(1);
  const pts = vals.map((v, i) => `${((i / (n - 1)) * 200).toFixed(1)},${y(v)}`).join(' ');
  const t = thr != null ? `<line x1="0" x2="200" y1="${y(thr)}" y2="${y(thr)}" class="sys-thr"/>` : '';
  return `<svg class="sys-spark ${cls}" viewBox="0 0 200 26" preserveAspectRatio="none" aria-hidden="true">${t}<polygon points="0,26 ${pts} 200,26"/><polyline points="${pts}"/></svg>`;
}
const usedHist = () => S.hist.used.map((v) => v / 100); // GB
const avail = () => S.avail;
const warnOn = () => Boolean(S?.warn?.mem || S?.warn?.cpu);

/** The warning in one line ("内存只剩 1.3 GB：galaxy 的 python -m http.server 占 820 MB"), or ''. */
export function sysWarnText() {
  if (!warnOn()) return '';
  const head = S.warn.mem ? L('内存只剩 {0}', long(S.avail)) : L('CPU 满载 1 分钟（{0}%）', S.cpu);
  const top = S.warn.top;
  return top ? head + L('：{0} 的 {1} 占 {2}', top.unit, top.label, long(top.mem)) : head;
}
export const sysWarnSince = () => S?.warn?.since || null;

function unitLamp(key) {
  const u = units.find((x) => x.key === key);
  return u ? lamp(stateKey(u, { standbyMs: (thresholds.standbyMinutes || 10) * 60_000 }), 0) : lamp('standby', 0);
}

function block() {
  const el = $('sys-block');
  if (!el || !S) return;
  el.hidden = false;
  const w = el.clientWidth || 396;
  const memLow = S.warn?.mem;
  const usedNow = (S.total - S.avail) / GB;
  const totalGb = (S.total / GB).toFixed(1);
  el.classList.toggle('warn', warnOn());
  if (folded()) {
    el.classList.add('folded');
    const top = S.warn?.top || S.tree?.units?.[0];
    const topText = top ? (S.warn?.top ? `${top.unit} ${top.label.split(' ')[0]} ${short(top.mem)}` : `${top.name} ${short(top.mem)}`) : '';
    el.innerHTML = `<span class="tag">SYS</span>${warnOn() ? lamp('warn', 0) : ''}<span>CPU <b>${S.cpu}%</b></span>${spark(S.hist.cpu.slice(-40), 100, 'cpu mini')}<span>${esc(L('可用'))} <b class="${memLow ? 'w' : ''}">${short(S.avail)}</b></span>${spark(usedHist().slice(-40), S.total / GB, 'mem mini')}<span class="top" title="${esc(sysWarnText())}">${esc(topText)}</span><button class="sys-fold" aria-expanded="false" title="${esc(L('展开系统负荷'))}">▸</button>`;
    return;
  }
  el.classList.remove('folded');
  const rows = w < 380 ? 2 : w >= 580 ? 5 : 3;
  const wide = w >= 580;
  const alert = warnOn() ? `<div class="sys-alert">${lamp('warn', 0)}<span title="${esc(sysWarnText())}">${esc(sysWarnText())}</span><button class="sys-open">${esc(L('处理…'))}</button></div>` : '';
  const g = (k, label, val, sub, sp) => `<div class="sys-g ${k}"><div class="gh"><span class="k">${label}</span><b>${val}</b><span class="sub">${sub}</span></div>${sp}</div>`;
  const gauges = `<div class="sys-gs${w < 380 ? ' stack' : ''}">${g('cpu', 'CPU', S.cpu + '%', wide ? esc(L('10 分钟')) : '', spark(S.hist.cpu, 100, 'cpu'))}${g('mem' + (memLow ? ' w' : ''), esc(L('内存')), esc(L('可用 {0}', short(S.avail))), `${usedNow.toFixed(1)} / ${totalGb}`, spark(usedHist(), S.total / GB, 'mem', (S.total - WARN_BYTES) / GB))}</div>`;
  const list = S.tree?.units?.length
    ? `<ul class="sys-rank">${S.tree.units
        .slice(0, rows)
        .map((u) => {
          const top = u.procs[0];
          return `<li class="${u.mem >= GB ? 'heavy' : ''}">${unitLamp(u.key)}<span class="n" title="${esc(u.name)}">${esc(u.name)}</span><span class="bar"><i style="width:${Math.min(100, (u.mem / (2.5 * GB)) * 100).toFixed(0)}%"></i></span><b>${short(u.mem)}</b>${wide ? `<span class="cp">${Math.round(u.cpu)}%</span><span class="tp" title="${esc(top?.label || '')}">${top ? esc(top.label.split(' ').slice(0, 2).join(' ')) + ' ' + short(top.mem) : ''}</span>` : ''}</li>`;
        })
        .join('')}</ul><button class="sys-more sys-open">${esc(L('全部 {0} 个终端 + 其他程序 ›', S.tree.units.length))}</button>`
    : `<div class="sys-wait">${esc(L('正在统计各终端的占用…'))}</div>`;
  el.innerHTML = `<div class="sh"><span class="tag">SYSTEM · ${esc(L('系统负荷'))}</span><span class="sh-r">${warnOn() ? lamp('warn', 0) : ''}<button class="sys-fold" aria-expanded="true" title="${esc(L('折叠成一行'))}">▾</button></span></div>${alert}${gauges}${list}`;
}

function chip() {
  const c = $('sys-chip');
  if (!c || !S) return;
  c.hidden = !collapsed();
  if (c.hidden) return;
  c.classList.toggle('warn', warnOn());
  c.innerHTML = `${warnOn() ? lamp('warn', 0) : ''}CPU <b>${S.cpu}%</b>${spark(S.hist.cpu.slice(-40), 100, 'cpu mini')}${esc(L('可用'))} <b class="${S.warn?.mem ? 'w' : ''}">${short(S.avail)}</b>`;
  c.title = sysWarnText() || L('系统负荷：点开看各终端的占用');
}

// ---- the drawer ----
function drawer() {
  const d = $('sys-drawer');
  if (!d || !drawerOpen || !S) return;
  const keep = d.querySelector('.sd-body')?.scrollTop || 0;
  const t = S.tree;
  const procRow = (u, p) =>
    `<tr class="kid"><td title="${esc(p.label)} · PID ${p.pid}">└ ${esc(p.label)}</td><td class="r">${long(p.mem)}</td><td class="r">${p.cpu}%</td><td class="r">${p.killable ? `<button class="sd-kill" data-pid="${p.pid}" data-agent="${esc(u.agentId)}" title="${esc(L('结束这个进程（和它的子进程）'))}">${esc(L('结束'))}</button>` : ''}</td></tr>`;
  const unitRows = (t?.units || [])
    .map((u) => `<tr class="u${u.mem >= GB ? ' heavy' : ''}"><td>${unitLamp(u.key)}<b>${esc(u.name)}</b>${u.owned ? '' : `<small>${esc(L('外部会话'))}</small>`}</td><td class="r">${long(u.mem)}</td><td class="r">${Math.round(u.cpu)}%</td><td class="r"><span class="bar"><i style="width:${Math.min(100, (u.mem / (2.5 * GB)) * 100).toFixed(0)}%"></i></span></td></tr>${u.procs.map((p) => procRow(u, p)).join('')}`)
    .join('');
  const self = t ? `<tr class="u"><td>${lamp('sys', 0)}<b>${esc(L('舰桥自身'))}</b><small>${esc(L('{0} 个进程', t.self.count))}</small></td><td class="r">${long(t.self.mem)}</td><td class="r">${Math.round(t.self.cpu)}%</td><td></td></tr>` : '';
  const others = t ? t.others.map((o) => `<tr class="o"><td>${esc(o.name)}${o.count > 1 ? `<small>×${o.count}</small>` : ''}</td><td class="r">${long(o.mem)}</td><td></td><td class="r"><span class="bar"><i style="width:${Math.min(100, (o.mem / (4 * GB)) * 100).toFixed(0)}%"></i></span></td></tr>`).join('') + `<tr class="o"><td>${esc(L('其他'))}</td><td class="r">${long(t.otherMem)}</td><td></td><td></td></tr>` : '';
  d.innerHTML = `<div class="sd-head"><b>${esc(L('系统负荷'))}</b><span class="m">${esc(L('近 10 分钟 · 进程每 5 秒更新'))}</span><button class="sd-x" aria-label="${esc(L('关闭'))}">×</button></div>
  <div class="sd-body">
  ${warnOn() ? `<div class="sys-alert big">${lamp('warn', 0)}<span>${esc(sysWarnText())}</span></div>` : ''}
  <div class="sd-ch"><div class="chh"><span>CPU</span><b>${S.cpu}%</b></div>${spark(S.hist.cpu, 100, 'cpu big')}</div>
  <div class="sd-ch"><div class="chh"><span>${esc(L('内存已用'))}</span><b>${((S.total - S.avail) / GB).toFixed(1)} / ${(S.total / GB).toFixed(1)} GB · ${esc(L('可用 {0}', long(S.avail)))}</b></div>${spark(usedHist(), S.total / GB, 'mem big' + (S.warn?.mem ? ' w' : ''), (S.total - WARN_BYTES) / GB)}</div>
  <h4>${esc(L('按终端（Claude Code 和它下面的所有进程）'))}</h4>
  ${t ? `<table class="sd-rank">${unitRows}${self}</table>` : `<div class="sys-wait">${esc(L('正在统计各终端的占用…'))}</div>`}
  <h4>${esc(L('舰桥以外的程序'))}</h4>
  ${t ? `<table class="sd-rank">${others}</table>` : ''}
  <p class="sd-foot">${esc(L('预警：可用内存低于 1.5 GB（或 10%），或 CPU 满载 1 分钟。只有舰桥启动的终端下的进程能在这里结束；Claude Code 本身和舰桥自己的进程不能。'))}</p>
  </div>`;
  d.querySelector('.sd-body').scrollTop = keep;
}
function openDrawer() {
  drawerOpen = true;
  $('sys-drawer').hidden = false;
  drawer();
  want(true);
}
function closeDrawer() {
  drawerOpen = false;
  $('sys-drawer').hidden = true;
  want(true);
}

async function kill(pid, agentId) {
  const u = S.tree?.units.find((x) => x.agentId === agentId);
  const p = u?.procs.find((x) => x.pid === pid);
  if (!u || !p) return;
  const go = await ask({
    danger: true,
    title: L('结束这个进程？'),
    message: L('它下面的子进程会一起结束。Claude Code 本身和舰桥不受影响，但这个终端里正在用它的命令会失败。'),
    detail: [L('进程：{0}', p.label), L('名称：{0} · PID {1}', p.name, p.pid), L('占用：{0} · CPU {1}%', long(p.mem), p.cpu), L('所属终端：{0}', u.name)],
    ok: L('结束进程'),
  });
  if (!go) return;
  const r = await deps.post('/api/sys/kill', { pid, agentId });
  deps.toast(r.ok ? L('已结束 {0}（PID {1}）', p.label, pid) : L('没能结束：{0}', r.error || ''));
}

// what this page shows, so the server samples as much as that needs (and nothing when nobody looks)
function want(force) {
  const level = document.hidden ? 'none' : drawerOpen ? 'drawer' : collapsed() || folded() ? 'folded' : 'open';
  if (!force && level === sentLevel && Date.now() - sentAt < 15_000) return;
  sentLevel = level;
  sentAt = Date.now();
  deps.post?.('/api/sys/want', { page: PAGE, level }).catch?.(() => {});
}

/** Each state: the block, the chip, the drawer. */
export function renderSys(state) {
  S = state.sys || null;
  units = state.units || [];
  thresholds = state.thresholds || {};
  if (!S) return;
  block();
  chip();
  drawer();
  want(false);
}

/** Once: the page's helpers and the clicks. */
export function initSys(d) {
  deps = d;
  document.addEventListener('click', (e) => {
    if (e.target.closest('#sys-block .sys-fold')) {
      setFolded(!folded());
      block();
      want(true);
      return;
    }
    if (e.target.closest('#sys-block .sys-open, #sys-chip') || (e.target.closest('#sys-block.folded') && !e.target.closest('button'))) return openDrawer();
    if (e.target.closest('#sys-drawer .sd-x')) return closeDrawer();
    const k = e.target.closest('#sys-drawer .sd-kill');
    if (k) return kill(Number(k.dataset.pid), k.dataset.agent);
    if (drawerOpen && !e.target.closest('#sys-drawer, .ask-dialog, dialog')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen && !document.querySelector('dialog[open]')) closeDrawer();
  });
  document.addEventListener('visibilitychange', () => want(true));
  addEventListener('resize', () => S && block());
  setInterval(() => want(false), 15_000);
}
