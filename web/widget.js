// Always-on-top status widget: NOVA with the quota as HP bars on the left, notifications on the right.
const $ = (id) => document.getElementById(id);
const bridge = window.opsBridge; // present only inside the Electron widget window

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
  return h < 48 ? `${h}h${pad(m % 60)}` : `${Math.floor(h / 24)}天`;
}

const SHORT = { session: '5 小时', weekly_all: '本周' };

// Quota as HP bars under NOVA: the bar shows what's left, the number what's used (like /usage).
function renderLimits() {
  const limits = state.usage?.limits || [];
  const th = state.thresholds;
  $('limits').innerHTML = limits.length
    ? limits
        .map((l) => {
          const used = Math.max(0, Math.min(100, l.usedPct));
          const low = 100 - used <= th.energyLowPct;
          const color = low ? 'var(--red)' : 100 - used <= 35 ? 'var(--amber)' : 'var(--green)';
          const label = SHORT[l.key] || l.label.replace('本周 · ', '周 · ');
          const reset = new Date(l.resetsAt);
          return `<div class="hp ${l.active ? 'active' : ''} ${low ? 'low' : ''}" title="${esc(l.label)} 已用 ${Math.round(used)}%，${reset.toLocaleString('zh-CN', { hour12: false })} 重置">
            <div class="top"><span>${esc(label)}</span><b>${Math.round(used)}%</b></div>
            <div class="bar" style="--hc:${color}"><i style="width:${100 - used}%"></i></div></div>`;
        })
        .join('')
    : `<div class="hp"><div class="top"><span>额度</span><b>${state.usage?.error ? '读取失败' : '读取中…'}</b></div></div>`;
}

const LV = { S: 'var(--red)', A: 'var(--amber)', B: '#C9A24A' };
const TAG = { PERMIT: '授权', ALERT: '警报', OVERLOAD: '负载', READY: '待命', GIT: 'GIT' };
const MAX_NOTES = 6;

// Right side: everything that needs you (most urgent first), then the units still at work.
function renderNotes() {
  const now = Date.now();
  const notes = state.quests.map((q) => {
    const u = q.unit && state.units.find((x) => x.sessionId === q.unit.sessionId);
    return { c: LV[q.lv], blink: q.kind === 'PERMIT', agent: u?.agentId || '', pid: q.unit?.pid ?? '', p: q.unit?.project || q.title, tag: TAG[q.kind] || q.kind, s: q.unit ? q.goal : '', title: q.title };
  });
  const asked = new Set(state.quests.map((q) => q.unit?.sessionId));
  for (const u of state.units)
    if (u.status === 'busy' && !asked.has(u.sessionId))
      notes.push({ c: 'var(--cyan)', agent: u.agentId || '', pid: u.pid, p: u.project, tag: since(now - u.statusSince), s: u.lastPrompt ? '执行：' + u.lastPrompt : '作战中', title: u.cwd });
  const rows = notes.slice(0, MAX_NOTES).map(
    (n) => `<button class="nt" style="--c:${n.c}" data-agent="${esc(n.agent)}" data-pid="${n.pid}" title="${esc(n.title)}">
      <span class="dot ${n.blink ? 'blink' : ''}"></span>
      <span class="mid"><span class="p"><span>${esc(n.p)}</span><em>${esc(n.tag)}</em></span><span class="s">${esc(n.s)}</span></span>
    </button>`,
  );
  const more = notes.length > MAX_NOTES ? `<div class="more">还有 ${notes.length - MAX_NOTES} 条，打开指挥中心查看</div>` : '';
  $('notes').innerHTML =
    `<div class="cap"><span>NOTICE · 通知</span><span>${state.quests.length}</span></div>` +
    (rows.join('') + more || '<div class="empty-w">一切正常，没有需要你处理的事</div>');

  const busy = state.units.filter((u) => u.status === 'busy').length;
  const permit = state.units.filter((u) => u.permission).length;
  $('chips').innerHTML = `<span>作战 <b>${busy}</b></span><span>待命 <b>${state.units.length - busy}</b></span>${permit ? `<span style="color:var(--red)">授权 <b>${permit}</b></span>` : ''}`;
}

// NOVA's face follows the operator mood; she "says" the top line when it changes.
const nova = window.Nova?.create($('w-av'), { bubble: false });
const MOOD = { PERMIT: ['请求授权', 'var(--red)'], ALERT: ['紧张', 'var(--red)'], OVERLOAD: ['担心', 'var(--red)'], READY: ['招手', 'var(--amber)'], GIT: ['皱眉', 'var(--amber)'], SYS: ['惊讶', 'var(--muted)'], RECHARGED: ['开心', 'var(--green)'], ENGAGED: ['专注', 'var(--cyan)'], STANDBY: ['打盹', 'var(--muted)'] };
let novaSaid = '';

function renderNova() {
  const mood = state.operator?.mood || 'ENGAGED';
  const [zh, c] = MOOD[mood] || MOOD.ENGAGED;
  $('w').style.setProperty('--nc', c);
  $('w-mood').textContent = `NOVA · ${zh}`;
  if (!nova) return;
  nova.setMood(mood);
  const line = state.operator?.lines?.[0]?.text || '';
  if (line && line !== novaSaid) nova.say(line);
  novaSaid = line;
}

function render() {
  renderNova();
  renderLimits();
  renderNotes();
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
// PERMIT blocks work and is told at once. READY waits until the session has stayed idle a while
// (the short pauses between turns are not "done"); OVERLOAD is told once an hour per session.
const READY_AFTER = 20_000;
const OVERLOAD_EVERY = 3600_000;
const told = new Set(); // quest keys already notified (or pending when the widget started)
const overloadAt = new Map(); // sessionId -> last OVERLOAD toast
let primed = false;

function notifyNew() {
  const now = Date.now();
  const keys = new Set(state.quests.map((q) => q.key));
  for (const k of told) if (!keys.has(k)) told.delete(k);
  for (const q of state.quests) {
    if (told.has(q.key) || !NOTIFY[q.kind] || !q.unit) continue;
    if (!primed) { told.add(q.key); continue; } // the first render only records what was already pending
    if (q.kind === 'READY' && now - (q.since || now) < READY_AFTER) continue; // check again on a later render
    told.add(q.key);
    if (q.kind === 'OVERLOAD') {
      const id = q.unit.sessionId;
      if (now - (overloadAt.get(id) || 0) < OVERLOAD_EVERY) continue;
      overloadAt.set(id, now);
    }
    if (!muted) bridge?.notify(...NOTIFY[q.kind](q));
  }
  primed = true;
}

/* ---------- actions ---------- */

async function go(el) {
  const agent = el.dataset.agent;
  const pid = Number(el.dataset.pid);
  if (agent) return bridge ? bridge.openMain(agent) : window.open(`/#term=${agent}`, 'fleet-bridge');
  if (pid) await fetch('/api/focus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid }) });
  else bridge ? bridge.openMain() : window.open('/', 'fleet-bridge');
}

$('notes').addEventListener('click', (e) => {
  const row = e.target.closest('.nt');
  if (row) go(row);
});
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
setInterval(() => state && renderNotes(), 30_000); // keep the "at work for" times fresh
setInterval(() => state && notifyNew(), 5_000); // READY toasts come due without a new state push
