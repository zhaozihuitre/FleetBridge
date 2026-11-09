// Always-on-top status widget: quota, the most urgent thing, and every unit at a glance.
const $ = (id) => document.getElementById(id);
import { L, locale, translateDom } from './i18n.js';
import { followTheme } from './theme.js';

translateDom();
const bridge = window.opsBridge; // present only inside the Electron widget window
const MAX_ROWS = 8;

let state = null;
let muted = false;
let awakeOn = false;
const AWAKE = { busy: '保持唤醒：有任务时', always: '保持唤醒：始终', off: '保持唤醒：关闭' };

// Themed menu (☰ or right-click) instead of the native context menu.
bridge?.onSettings((s) => {
  muted = Boolean(s.muted);
  if (s.awakeMode) {
    $('m-awake').hidden = $('m-screen').hidden = false;
    $('m-awake').textContent = L(AWAKE[s.awakeMode] || AWAKE.busy);
    $('m-awake').title = L('点击切换：有任务时 → 始终 → 关闭。有任务时 = 有 agent 作战、等授权或排队未发完，结束 3 分钟后恢复正常休眠');
    $('m-screen').setAttribute('aria-checked', String(Boolean(s.awakeScreen)));
    $('m-screen').disabled = s.awakeMode === 'off';
  }
  if (awakeOn !== Boolean(s.awakeOn)) {
    awakeOn = Boolean(s.awakeOn);
    if (state) render();
  }
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
  else if (act === 'open-main') window.open('/', 'fleet-bridge');
});
window.addEventListener('keydown', (e) => e.key === 'Escape' && !$('w-menu').hidden && toggleMenu(false));
window.addEventListener('blur', () => !$('w-menu').hidden && toggleMenu(false));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

function since(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${pad(m % 60)}` : L('{0}天', Math.floor(h / 24));
}

function seg(pct, n, color) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n);
  return `<div class="seg" style="--c:${color}">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
}

const SHORT = { session: L('5 小时'), weekly_all: L('本周') };

function renderLimits() {
  const limits = state.usage?.limits || [];
  const th = state.thresholds;
  $('limits').innerHTML = limits.length
    ? limits
        .map((l) => {
          const low = 100 - l.usedPct <= th.energyLowPct;
          const color = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
          const label = SHORT[l.key] || l.label.replace('本周 · ', '周 · ').replace('Week · ', 'Wk · ').replace('今週 · ', '週 · ');
          const reset = new Date(l.resetsAt);
          return `<div class="lim ${l.active ? 'active' : ''} ${low ? 'low' : ''}" title="${esc(L('{0} 已用 {1}%，{2} 重置', l.label, Math.round(l.usedPct), reset.toLocaleString(locale, { hour12: false })))}">
            <span>${esc(label)}</span>${seg(l.usedPct, 16, color)}<span class="pct">${Math.round(l.usedPct)}%</span></div>`;
        })
        .join('')
    : `<div class="lim"><span>${L('额度')}</span><span>${state.usage?.error ? L('读取失败') : L('读取中…')}</span><span></span></div>`;
  // same as the command center: say when these numbers are an old reading (e.g. rate limited)
  const u = state.usage;
  if (limits.length && u?.error && u.fetchedAt) {
    const d = new Date(u.fetchedAt);
    $('limits').insertAdjacentHTML('beforeend', `<div class="lim-stale">${L('缓存 {0}', `${pad(d.getHours())}:${pad(d.getMinutes())}`)}${u.error === 'rate_limited' ? L(' · 接口限流，稍后自动重试') : ''}</div>`);
  }
}

function unitLook(u) {
  const th = state.thresholds;
  const now = Date.now();
  const hot = u.contextPct != null && u.contextPct >= th.contextWarnPct;
  if (u.permission) return { c: 'var(--red)', s: u.permission.prompt?.kind === 'question' ? L('等你回答！') : L('等你授权！'), blink: true };
  if (u.status === 'busy') return { c: 'var(--cyan)', s: u.lastPrompt ? L('执行：') + u.lastPrompt : L('作战中'), blink: false, hot };
  // stopped on the quota: whose (the same words as the cards)
  if (u.limit) return { c: 'var(--red)', s: L('额度到限（{0}）', u.limit.org || L('组织未知')), blink: false, hot };
  const standby = now - u.statusSince > th.standbyMinutes * 60_000;
  // finished: the conclusion of its answer when there is one (the notice's summary), not just "done"
  return { c: standby ? 'var(--muted)' : 'var(--amber)', s: u.summary || u.lastText || (standby ? L('休眠') : L('做完了，等你指令')), blink: false, hot };
}

function renderUnits() {
  const units = [...state.units].sort((a, b) => Boolean(b.permission) - Boolean(a.permission) || (a.status === 'idle') - (b.status === 'idle'));
  const rows = units.slice(0, MAX_ROWS).map((u) => {
    const look = unitLook(u);
    const ctx = u.contextPct == null ? '--' : Math.round(u.contextPct) + '%';
    return `<button class="row" style="--c:${look.c};${u.permission?.at ? `--ago:${((u.permission.at - Date.now()) / 1000).toFixed(1)}s` : ''}" data-agent="${esc(u.agentId || '')}" data-pid="${u.pid}" title="${esc(u.cwd)}\n${u.owned ? L('点击打开它的终端') : L('点击切到它的终端窗口')}">
      <span class="dot ${look.blink ? 'blink' : ''}"></span>
      <span class="mid"><span class="p">${esc(u.name || u.project)}${u.name && u.project && u.name.toLowerCase() !== u.project.toLowerCase() ? `<small>${esc(u.project)}</small>` : ''}${u.owned ? `<i>${L('我方')}</i>` : ''}</span><span class="s">${esc(look.s)}</span></span>
      <span class="r"><span class="ctx" style="--kc:${look.hot ? 'var(--red)' : 'var(--text)'}">${ctx}</span><span>${since(Date.now() - u.statusSince)}</span></span>
    </button>`;
  });
  const more = units.length > MAX_ROWS ? `<div class="more">${L('还有 {0} 个，打开指挥中心查看', units.length - MAX_ROWS)}</div>` : '';
  $('units').innerHTML = rows.join('') + more || `<div class="empty-w">${L('没有运行中的会话 · 点 ⤢ 去存档挑一个')}</div>`;

  const busy = units.filter((u) => u.status === 'busy').length;
  const permit = units.filter((u) => u.permission).length;
  $('chips').innerHTML = `<span>${L('作战 ')}<b>${busy}</b></span><span>${L('待命 ')}<b>${units.length - busy}</b></span>${permit ? `<span style="color:var(--red)">${L('等你 ')}<b>${permit}</b></span>` : ''}${awakeOn ? `<span class="awake" title="${esc(L('保持唤醒中：电脑不会自动休眠'))}">☀</span>` : ''}`;
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
  a.innerHTML = `<b>${esc(q.title)}</b><small>${esc(q.goal)}${state.quests.length > 1 ? L(' · 另有 {0} 项', state.quests.length - 1) : ''}</small>`;
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

/* ---------- notifications: each new notice raises one Windows toast ---------- */

// The server decides what is worth telling and when (server/notices.js: dialogs at once, a finished
// turn after 20 s idle with the summary of its answer, interrupted / not run / errors, context and
// quota), the same for the phone push; here each new one becomes a toast once.
const told = new Set(); // notice keys already shown (or there when the widget started)
let primed = false;

function notifyNew() {
  for (const n of state.notices || []) {
    if (told.has(n.key)) continue;
    told.add(n.key);
    if (primed && !muted && n.toast) bridge?.notify(n.toast.title, n.toast.body, n.agentId || (n.sessionId ? 's:' + n.sessionId : ''));
  }
  primed = true; // the first state only records what was already there
}

/* ---------- actions ---------- */

async function go(el) {
  const agent = el.dataset.agent;
  const pid = Number(el.dataset.pid);
  if (agent) return bridge ? bridge.openMain(agent) : window.open(`/#term=${agent}`, 'fleet-bridge');
  if (pid) await fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
  else bridge ? bridge.openMain() : window.open('/', 'fleet-bridge');
}

// a toast clicked: the terminal it is about, as a click on its row would (our agent's id, or s:<session>)
bridge?.onNotifyClick?.((tag) => {
  if (!tag.startsWith('s:')) return go({ dataset: { agent: tag } });
  const u = (state?.units || []).find((x) => x.sessionId === tag.slice(2));
  go({ dataset: { agent: u?.agentId || '', pid: u?.agentId ? '' : String(u?.pid || '') } });
});

$('units').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) go(row);
});
$('alert').addEventListener('click', () => go($('alert')));
$('w-main').addEventListener('click', () => (bridge ? bridge.openMain() : window.open('/', 'fleet-bridge')));

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
$('w-tuck').addEventListener('click', () => bridge?.action('tuck-widget'));
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
  followTheme(state.theme, state.paper);
  render();
  notifyNew();
};
setInterval(() => state && renderUnits(), 30_000); // keep the "waiting for" times fresh
