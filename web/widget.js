// Always-on-top status widget: quota, the most urgent thing, and every unit at a glance.
const $ = (id) => document.getElementById(id);
const bridge = window.opsBridge; // present only inside the Electron widget window
const MAX_ROWS = 8;

let state = null;
let muted = false;

// Themed menu (☰ or right-click) instead of the native context menu.
bridge?.onSettings((s) => {
  muted = Boolean(s.muted);
  $('m-mute').setAttribute('aria-checked', String(muted));
  $('m-auto').hidden = !s.packaged; // only the installed app can register itself
  $('m-auto').setAttribute('aria-checked', String(Boolean(s.autostart)));
});

function toggleMenu(open = $('w-menu').hidden) {
  $('w-menu').hidden = !open;
  $('w-menu-btn').setAttribute('aria-expanded', String(open));
  fitHeight();
}

$('w-menu-btn').addEventListener('click', () => toggleMenu());
$('w-menu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  toggleMenu(false);
  if (bridge) bridge.action(act);
  else if (act === 'open-main') window.open('/', 'claude-ops');
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && !$('w-menu').hidden && toggleMenu(false));
window.addEventListener('blur', () => !$('w-menu').hidden && toggleMenu(false));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

function since(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${pad(m % 60)}` : `${Math.floor(h / 24)}天`;
}

function seg(pct, n, color) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n);
  return `<div class="seg" style="--c:${color}">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
}

const SHORT = { session: '5 小时', weekly_all: '本周' };

function renderLimits() {
  const limits = state.usage?.limits || [];
  const th = state.thresholds;
  $('limits').innerHTML = limits.length
    ? limits
        .map((l) => {
          const low = 100 - l.usedPct <= th.energyLowPct;
          const color = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
          const label = SHORT[l.key] || l.label.replace('本周 · ', '周 · ');
          const reset = new Date(l.resetsAt);
          return `<div class="lim ${l.active ? 'active' : ''} ${low ? 'low' : ''}" title="${esc(l.label)} 已用 ${Math.round(l.usedPct)}%，${reset.toLocaleString('zh-CN', { hour12: false })} 重置">
            <span>${esc(label)}</span>${seg(l.usedPct, 16, color)}<span class="pct">${Math.round(l.usedPct)}%</span></div>`;
        })
        .join('')
    : `<div class="lim"><span>额度</span><span>${state.usage?.error ? '读取失败' : '读取中…'}</span><span></span></div>`;
}

function unitLook(u) {
  const th = state.thresholds;
  const now = Date.now();
  const hot = u.contextPct != null && u.contextPct >= th.contextWarnPct;
  if (u.permission) return { c: 'var(--red)', s: '等你授权！', blink: true };
  if (u.status === 'busy') return { c: 'var(--cyan)', s: u.lastPrompt ? '执行：' + u.lastPrompt : '作战中', blink: false, hot };
  const standby = now - u.statusSince > th.standbyMinutes * 60_000;
  return { c: standby ? 'var(--muted)' : 'var(--amber)', s: standby ? '休眠' : '做完了，等你指令', blink: false, hot };
}

function renderUnits() {
  const units = [...state.units].sort((a, b) => Boolean(b.permission) - Boolean(a.permission) || (a.status === 'idle') - (b.status === 'idle'));
  const rows = units.slice(0, MAX_ROWS).map((u) => {
    const look = unitLook(u);
    const ctx = u.contextPct == null ? '--' : Math.round(u.contextPct) + '%';
    return `<button class="row" style="--c:${look.c}" data-agent="${esc(u.agentId || '')}" data-pid="${u.pid}" title="${esc(u.cwd)}\n${u.owned ? '点击打开它的终端' : '点击切到它的终端窗口'}">
      <span class="dot ${look.blink ? 'blink' : ''}"></span>
      <span class="mid"><span class="p">${esc(u.project)}${u.owned ? '<i>我方</i>' : ''}</span><span class="s">${esc(look.s)}</span></span>
      <span class="r"><span class="ctx" style="--kc:${look.hot ? 'var(--red)' : 'var(--text)'}">${ctx}</span><span>${since(Date.now() - u.statusSince)}</span></span>
    </button>`;
  });
  const more = units.length > MAX_ROWS ? `<div class="more">还有 ${units.length - MAX_ROWS} 个，打开指挥中心查看</div>` : '';
  $('units').innerHTML = rows.join('') + more || '<div class="empty-w">没有运行中的会话 · 点 ⤢ 去存档挑一个</div>';

  const busy = units.filter((u) => u.status === 'busy').length;
  const permit = units.filter((u) => u.permission).length;
  $('chips').innerHTML = `<span>作战 <b>${busy}</b></span><span>待命 <b>${units.length - busy}</b></span>${permit ? `<span style="color:var(--red)">授权 <b>${permit}</b></span>` : ''}`;
}

const LV = { S: 'var(--red)', A: 'var(--amber)', B: '#C9A24A' };

function renderAlert() {
  const q = state.quests[0];
  const a = $('alert');
  if (!q) {
    a.innerHTML = '';
    return;
  }
  const u = q.unit && state.units.find((x) => x.sessionId === q.unit.sessionId);
  a.style.setProperty('--qc', LV[q.lv]);
  a.dataset.agent = u?.agentId || '';
  a.dataset.pid = q.unit?.pid ?? '';
  a.innerHTML = `<b>[${q.lv}] ${esc(q.title)}</b><small>${esc(q.goal)}${state.quests.length > 1 ? ` · 另有 ${state.quests.length - 1} 项` : ''}</small>`;
}

function render() {
  renderLimits();
  renderAlert();
  renderUnits();
  fitHeight();
}

function fitHeight() {
  requestAnimationFrame(() => bridge?.setHeight(Math.ceil($('w').getBoundingClientRect().height)));
}

/* ---------- notifications: each new "needs you" quest raises one Windows toast ---------- */

const NOTIFY = {
  PERMIT: (q) => [`${q.unit.project} 等你授权`, q.goal],
  READY: (q) => [`${q.unit.project} 做完了，等你指令`, q.goal],
  OVERLOAD: (q) => [`${q.unit.project} 记忆负载过高`, q.title],
};
let seen = null;

function notifyNew() {
  const keys = new Set(state.quests.map((q) => q.key));
  if (seen && !muted)
    for (const q of state.quests) if (!seen.has(q.key) && NOTIFY[q.kind] && q.unit) bridge?.notify(...NOTIFY[q.kind](q));
  seen = keys; // the first render only records what was already pending
}

/* ---------- actions ---------- */

async function go(el) {
  const agent = el.dataset.agent;
  const pid = Number(el.dataset.pid);
  if (agent) return bridge ? bridge.openMain(agent) : window.open(`/#term=${agent}`, 'claude-ops');
  if (pid) await fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
  else bridge ? bridge.openMain() : window.open('/', 'claude-ops');
}

$('units').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) go(row);
});
$('alert').addEventListener('click', () => go($('alert')));
$('w-main').addEventListener('click', () => (bridge ? bridge.openMain() : window.open('/', 'claude-ops')));

function setFolded(v) {
  $('w').classList.toggle('folded', v);
  $('w-fold').textContent = v ? '▸' : '▾';
  try {
    localStorage.setItem('ops-widget-folded', v ? '1' : '');
  } catch {
    // storage unavailable: folding just won't persist
  }
  fitHeight();
}
$('w-fold').addEventListener('click', () => setFolded(!$('w').classList.contains('folded')));
try {
  setFolded(Boolean(localStorage.getItem('ops-widget-folded')));
} catch {
  setFolded(false);
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  toggleMenu(true);
});

new EventSource('/api/stream').onmessage = (e) => {
  state = JSON.parse(e.data);
  render();
  notifyNew();
};
setInterval(() => state && renderUnits(), 30_000); // keep the "waiting for" times fresh
