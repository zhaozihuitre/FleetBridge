// The phone page: the units at a glance, and any of our terminals on the whole screen to read, type
// into and answer (keys for dialogs: Esc, arrows, 1–3, Tab, Enter). No message list: what needs you
// shows up as a unit waiting for approval. Talks only to the phone server.
import { L, translateDom } from './i18n.js';
import { followTheme } from './theme.js';
import { switchView, wantedView } from './device.js';

// one address for every device: a tablet or computer that lands here goes on to the full page
// (unless it chose this one); the switch stays at hand either way
// a notification links every device to /#term=<id>: here that terminal is #t=<id> (and back again)
// the sign-in page's way back in (?in=…): not kept in the address
if (/[?&]in=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
if (/^#term=[0-9a-f-]{36}$/.test(location.hash)) history.replaceState(null, '', location.pathname + '#t=' + location.hash.slice(6));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && wantedView() === 'full') location.replace('/' + location.hash.replace(/^#t=([0-9a-f-]{36}).*$/, '#term=$1'));

translateDom();
document.getElementById('view-full').addEventListener('click', () => switchView('full'));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// "today 16:20", "tomorrow 09:00", or "11/9 14:00"
const when = (ms) => {
  const d = new Date(ms);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? L('今天 {0}', hhmm(ms)) : days === 1 ? L('明天 {0}', hhmm(ms)) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`;
};
const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
    if (r.status === 401) location.reload(); // signed out (PIN changed, session expired): to the PIN page
    return r.json();
  });

let state = null;
let screenId = null;
let screenTimer = 0;

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('on'), 2200);
}

// a short name for a limit on a narrow screen: "5 小时", "本周", "Fable · 周"
const shortLabel = (l) => {
  const [kind, model] = String(l.key || '').split(':');
  return kind === 'session' ? L('5 小时') : model ? `${model} · ${L('周')}` : kind === 'weekly_all' ? L('本周') : l.label;
};

function renderQuota() {
  const u = state.usage;
  const rows = (u?.limits || [])
    .map((l) => {
      const used = Math.max(0, Math.min(100, l.usedPct));
      const low = 100 - used <= state.thresholds.energyLowPct;
      const c = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
      const on = Math.round(used / 5);
      const seg = `<span class="seg">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
      // what's used and when it resets (with the day); a window not started yet has no reset time
      const started = l.resetsAt > 0;
      const v = `<span class="v">${Math.round(used)}%<small>${started ? esc(L('{0} 重置', when(l.resetsAt))) : L('未开始')}</small></span>`;
      return `<div class="q" style="--c:${c}" title="${esc(l.label)}"><span class="k">${esc(shortLabel(l))}</span>${seg}${v}</div>`;
    })
    .join('');
  // whose quota (the organization), and the other organization's last reading in one line
  const org = u?.org ? `<div class="q-org"><b>${esc(u.org.name)}</b>${u.signedIn ? ` · <i>${esc(L('已切换到 {0}', u.signedIn.name))}</i>` : ''}</div>` : '';
  const others = (u?.others || [])
    .map((x) => {
      const pick = (k) => x.limits.find((l) => l.key === k);
      const part = (l, name) => (l ? `${name} ${Math.round(l.usedPct)}%` : '');
      const text = [part(pick('session'), L('5 小时')), part(pick('weekly_all'), L('本周'))].filter(Boolean).join(' · ') || '--';
      return `<div class="q-other"><b>${esc(x.org.name)}</b><span>${esc(text)}</span><small>${esc(x.live ? L('读取于 {0}', hhmm(x.fetchedAt)) : L('截至 {0}', when(x.fetchedAt)))}</small></div>`;
    })
    .join('');
  $('quota').innerHTML = org + rows + others;
}

/* ---------- units: every terminal of ours (agents and plain shells) and the sessions outside ---------- */

const ST = {
  permit: () => [L('⚠ 等授权'), 'var(--red)', 0],
  question: () => [L('? 等回答'), 'var(--red)', 0],
  busy: () => [L('▶ 作战中'), 'var(--cyan)', 1],
  starting: () => [L('启动中'), 'var(--cyan)', 2],
  idle: () => [L('◆ 待命'), 'var(--amber)', 3],
  shell: () => [L('终端'), 'var(--green)', 4],
};

function rows() {
  const out = [];
  const seen = new Set();
  for (const u of state.units) {
    const kind = u.permission ? (u.permission.prompt?.kind === 'question' ? 'question' : 'permit') : u.status === 'busy' ? 'busy' : 'idle';
    const a = u.owned ? (state.agents || []).find((x) => x.id === u.agentId) : null;
    if (a) seen.add(a.id);
    // stopped on the quota, as on the command center's cards (whose: the quota at the top)
    const limit = u.limit && u.status !== 'busy' ? L('额度到限：') + u.limit.text : '';
    const text = u.permission ? u.permission.message || '' : u.status === 'busy' && u.lastPrompt ? L('执行中：') + u.lastPrompt : limit || u.summary || u.lastText || '';
    out.push({ id: a?.id || null, name: a?.name || u.name || u.project, project: u.project, kind, since: u.statusSince, text, ours: Boolean(a), waitAt: u.permission?.at || null });
  }
  for (const a of state.agents || []) {
    if (!a.alive || seen.has(a.id)) continue;
    const project = String(a.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    out.push({ id: a.id, name: a.name || project, project, kind: a.kind === 'shell' ? 'shell' : 'starting', since: a.startedAt, text: '', ours: true });
  }
  // ours first; within that, what needs you first
  return out.sort((x, y) => Number(y.ours) - Number(x.ours) || ST[x.kind]()[2] - ST[y.kind]()[2] || String(x.name).localeCompare(String(y.name)));
}

const EMPTY = '<svg width="40" height="40" viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M17 2l13 7.5v15L17 32 4 24.5v-15z" stroke="#4f7a90" stroke-width="1.4"/><path d="M11 17l4 4 8-8" stroke="#4dffa6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// how long a dialog has waited, as a negative animation delay: its few blinks run once from when it came up
const ago = (at) => (at ? `--ago:${((at - Date.now()) / 1000).toFixed(1)}s` : '');

function renderChips() {
  const all = rows();
  const n = (k) => all.filter((r) => r.kind === k).length;
  const chip = (c, label, color, alarm, at) => `<span class="chip ${c ? '' : 'zero'} ${alarm && c ? 'alarm' : ''}" style="--c:${color};${ago(at)}"><b>${c}</b>${esc(label)}</span>`;
  $('chips').innerHTML = chip(n('busy'), L('作战中'), 'var(--cyan)') + chip(n('idle'), L('待命'), 'var(--amber)') + chip(n('permit') + n('question'), L('等你处理'), 'var(--red)', true, Math.max(0, ...all.map((r) => r.waitAt || 0)));
}

function renderUnits() {
  const now = Date.now();
  const html =
    rows()
      .map((r) => {
        const [label, color] = ST[r.kind]();
        const mins = r.since ? Math.max(0, Math.round((now - r.since) / 60_000)) : null;
        const age = mins == null ? '' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${pad(mins % 60)}`;
        const inner = `<div class="head"><span class="dot ${r.kind === 'permit' || r.kind === 'question' ? 'blink' : ''}"></span><b class="nm">${esc(r.name)}</b><span class="st">${esc(label)}</span></div>
          <div class="meta"><span class="pj">${esc(r.project)}</span>${r.ours ? '' : `<span class="ext">${L('外部会话')}</span>`}${age ? `<time>${age}</time>` : ''}</div>
          ${r.text ? `<div class="sub">${esc(r.text)}</div>` : ''}`;
        return r.ours
          ? `<button type="button" class="card ${r.kind === 'permit' || r.kind === 'question' ? 'permit' : ''}" style="--c:${color};${ago(r.waitAt)}" data-open="${esc(r.id)}">${inner}<span class="go" aria-hidden="true">›</span></button>`
          : `<div class="card ext" style="--c:${color};${ago(r.waitAt)}" title="${esc(L('不是舰桥启动的会话，只能查看状态'))}">${inner}</div>`;
      })
      .join('') || `<div class="empty">${EMPTY}${L('没有运行中的会话')}</div>`;
  if (view !== 'units') return;
  if (renderUnits.last !== html) $('list').innerHTML = renderUnits.last = html;
}

/* ---------- recent notices: what was told, to read again; a tap opens its terminal ---------- */

let view = 'units'; // the list shows the units or the recent notices
let notices = [];
let noticesFor = -1;
let noticeSeen = 0;
try {
  noticeSeen = Number(localStorage.getItem('fb-notices-seen')) || 0;
} catch {
  // storage unavailable
}
const NOTICE_COLOR = { permit: 'var(--red)', question: 'var(--red)', ask: 'var(--amber)', done: 'var(--green)', limit: 'var(--red)', error: 'var(--red)', never_ran: 'var(--red)', interrupted: 'var(--amber)', overload: 'var(--amber)', alert: 'var(--amber)' };
async function loadNotices() {
  if (noticesFor === state.noticeAt) return;
  noticesFor = state.noticeAt;
  const r = await fetch('/api/notices?limit=50', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return void (noticesFor = -1);
  notices = r.notices || [];
  renderNotices();
}
// which of our terminals a notice opens (outside sessions only on the computer)
const noticeAgent = (n) => {
  const a = n.agentId && (state.agents || []).find((x) => x.id === n.agentId && x.alive);
  return a?.id || state.units.find((u) => u.sessionId === n.sessionId && u.owned)?.agentId || null;
};
function renderNotices() {
  if (view === 'notices' && notices[0] && notices[0].at > noticeSeen) {
    noticeSeen = notices[0].at;
    try {
      localStorage.setItem('fb-notices-seen', String(noticeSeen));
    } catch {
      // only this page remembers
    }
  }
  const unseen = notices.filter((n) => n.at > noticeSeen).length;
  $('nt-new').hidden = !unseen;
  $('nt-new').textContent = unseen || '';
  if (view !== 'notices') return;
  const html =
    notices
      .map((n) => {
        const id = noticeAgent(n);
        const who = [n.name, n.project && n.project !== n.name ? n.project : ''].filter(Boolean).join(' · ');
        const inner = `<div class="head"><span class="nk">${esc(`${n.icon || ''} ${n.word || ''}`.trim())}</span><b class="nm">${esc(who)}</b><time>${esc(when(n.at))}</time></div>
          <div class="nt-title">${esc(n.title || '')}</div>
          ${n.needs ? `<div class="nt-needs">${esc(L('需要你：') + n.needs)}</div>` : ''}${n.result && n.result !== n.title ? `<div class="sub">${esc(n.result)}</div>` : ''}`;
        return id
          ? `<button type="button" class="card notice" style="--c:${NOTICE_COLOR[n.kind] || 'var(--cyan)'}" data-open="${esc(id)}">${inner}<span class="go" aria-hidden="true">›</span></button>`
          : `<div class="card notice gone" style="--c:${NOTICE_COLOR[n.kind] || 'var(--cyan)'}">${inner}</div>`;
      })
      .join('') || `<div class="empty">${EMPTY}${L('还没有通知')}</div>`;
  if (renderNotices.last !== html) $('list').innerHTML = renderNotices.last = html;
}
function setView(v) {
  view = v;
  renderUnits.last = renderNotices.last = null;
  for (const b of document.querySelectorAll('.list-tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  if (v === 'units') renderUnits();
  else renderNotices();
}
document.querySelector('.list-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

function renderSheet() {
  // (a link straight to a terminal opens it before the first state is here: its name and state come with it)
  if (!screenId || !state) return;
  const r = rows().find((x) => x.id === screenId);
  if (!r) {
    $('sheet-st').textContent = L('已结束');
    $('sheet-st').style.color = 'var(--muted)';
    return;
  }
  const [label, color] = ST[r.kind]();
  $('sheet-name').textContent = r.name;
  $('sheet-st').textContent = `${label} · ${r.project}`;
  $('sheet-st').style.color = color;
}

function render() {
  if (!state) return;
  renderQuota();
  renderChips();
  renderUnits();
  loadNotices();
  renderNotices();
  renderSheet();
  renderPending();
}

// New devices waiting to be allowed: a device trusted when it was allowed may allow them here, so you
// don't have to go back to the computer (only the computer can make one trusted).
let meTrusted = false;
fetch('/api/me', { cache: 'no-store' })
  .then((r) => r.json())
  .then((j) => {
    meTrusted = Boolean(j.trusted);
    render();
  })
  .catch(() => {});
function renderPending() {
  const list = meTrusted ? state.webPending || [] : [];
  $('pend').hidden = !list.length;
  const html = list.map((p) => `<div class="pd"><b>${esc(L('新设备请求访问'))}</b> · ${esc(p.device)}（${esc(p.ip)}）<br>${esc(L('输入了正确的访问密码。不认识的设备请拒绝。'))}<div class="pd-acts"><button type="button" data-allow="${esc(p.id)}">${esc(L('允许'))}</button><button type="button" class="no" data-deny="${esc(p.id)}">${esc(L('拒绝'))}</button></div></div>`).join('');
  if ($('pend').innerHTML !== html) $('pend').innerHTML = html;
}
$('pend').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-allow], [data-deny]');
  if (!b) return;
  b.disabled = true;
  const r = await post('/api/devices/approve', { id: b.dataset.allow || b.dataset.deny, allow: Boolean(b.dataset.allow) }).catch(() => null);
  toast(r?.ok ? (b.dataset.allow ? L('已允许') : L('已拒绝')) : L('操作失败'));
});

/* ---------- one terminal on the whole screen ---------- */

async function refreshScreen() {
  if (!screenId) return;
  const id = screenId;
  const r = await fetch(`/api/screen?id=${encodeURIComponent(id)}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  if (!r || id !== screenId) return;
  const el = $('screen');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  // colored by the server (text already escaped there)
  // a full-width rule (120 columns of ─) would wrap into several lines on a phone: one thin line instead
  // (a rule with a short label in it, like Claude Code's "──── name ─", keeps the label)
  const rule = (l) => {
    const text = l.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
    if ((text.match(/[─━═╌┄]/g) || []).length < 20) return null;
    const label = text.replace(/[─━═╌┄]+/g, ' ').replace(/\s+/g, ' ').trim();
    return label.length <= 40 ? `<span class="rule" data-label="${esc(label)}"></span>` : null;
  };
  const html = r.html?.length ? r.html.map((l) => rule(l) ?? l).join('\n') : esc(L('（没有内容）'));
  if (el.dataset.last !== html) {
    el.innerHTML = el.dataset.last = html;
    if (atBottom || el.dataset.fresh) el.scrollTop = el.scrollHeight;
    delete el.dataset.fresh;
  }
  // a dialog's choices as big buttons (permission prompts, questions, menus)
  const menu = r.menu || [];
  const mh = menu.map((o) => `<button type="button" class="${o.current ? 'cur' : ''}" data-choice="${esc(o.key)}"><span class="n">${esc(o.key)}</span>${esc(o.label)}</button>`).join('');
  if ($('sheet-menu').dataset.last !== mh) $('sheet-menu').innerHTML = $('sheet-menu').dataset.last = mh;
}

function openScreen(id, push = true) {
  screenId = id;
  $('screen').dataset.last = '';
  $('screen').dataset.fresh = '1';
  $('screen').textContent = '';
  $('sheet-menu').innerHTML = $('sheet-menu').dataset.last = '';
  $('sheet').hidden = false;
  document.body.classList.add('in-term');
  if (push) history.pushState({ term: id }, '', `#t=${encodeURIComponent(id)}`);
  renderSheet();
  refreshScreen();
  clearInterval(screenTimer);
  screenTimer = setInterval(refreshScreen, 1500);
}

function closeScreen() {
  screenId = null;
  clearInterval(screenTimer);
  $('sheet').hidden = true;
  document.body.classList.remove('in-term');
  $('text').blur();
}

// the phone's back button and the ‹ button both go back to the units
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.hash.slice(1)).get('t');
  if (id) openScreen(id, false);
  else closeScreen();
});
$('sheet-close').addEventListener('click', () => (history.state?.term ? history.back() : (history.replaceState(null, '', location.pathname), closeScreen())));

$('list').addEventListener('click', (e) => {
  const c = e.target.closest('[data-open]');
  if (c) openScreen(c.dataset.open);
});

// keys and menu choices go straight to the agent shown, then the screen refreshes soon after
async function press(body) {
  if (!screenId) return;
  const r = await post('/api/action', { id: screenId, ...body }).catch(() => null);
  if (!r?.results?.[0]) toast(L('发送失败：终端可能已经结束'));
  setTimeout(refreshScreen, 250);
  setTimeout(refreshScreen, 900);
}
$('keys').addEventListener('click', (e) => {
  const b = e.target.closest('[data-key]');
  if (b) press({ action: 'key', key: b.dataset.key });
});
// keep the soft keyboard up when a key button is tapped while typing
$('keys').addEventListener('pointerdown', (e) => {
  if (document.activeElement === $('text')) e.preventDefault();
});
$('sheet-menu').addEventListener('click', (e) => {
  const c = e.target.closest('[data-choice]');
  if (c) press({ action: 'answer', choice: c.dataset.choice });
});

// typing: the text goes in with Enter; an empty send is a bare Enter
$('input').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value;
  if (!screenId) return;
  if (!text.trim()) return press({ action: 'key', key: 'enter' });
  $('send').disabled = true;
  const r = await post('/api/action', { id: screenId, action: 'text', text: text.trim() }).catch(() => null);
  $('send').disabled = false;
  if (!r?.results?.[0]) return toast(L('发送失败：终端可能已经结束'));
  $('text').value = '';
  fit();
  setTimeout(refreshScreen, 400);
  setTimeout(refreshScreen, 1500);
});
const fit = () => {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
};
$('text').addEventListener('input', fit);
$('text').addEventListener('keydown', (e) => {
  // Enter sends (Shift+Enter: a new line); not while an input method is composing
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $('input').requestSubmit();
  }
});

// long lines wrap on a phone by default; off: the terminal as it is, scrolled sideways
function setWrap(on) {
  $('screen').classList.toggle('wrap', on);
  $('wrap').setAttribute('aria-pressed', String(on));
  try {
    localStorage.setItem('fbm-wrap', on ? '1' : '0');
  } catch {
    // not kept
  }
}
let wrapOn = true;
try {
  wrapOn = localStorage.getItem('fbm-wrap') !== '0';
} catch {
  // default on
}
setWrap(wrapOn);
$('wrap').addEventListener('click', () => setWrap($('wrap').getAttribute('aria-pressed') !== 'true'));

/* ---------- the on-screen keyboard must not cover the input ---------- */

// Android Chrome resizes the page for the keyboard (interactive-widget in the viewport meta);
// iOS Safari and others only shrink the visual viewport: the terminal sheet takes that height.
const vv = window.visualViewport;
if (vv) {
  const kb = () => {
    const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${h}px`);
    if (screenId) {
      const el = $('screen');
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
    }
  };
  vv.addEventListener('resize', kb);
  vv.addEventListener('scroll', kb);
  kb();
}

/* ---------- live state ---------- */

// EventSource gives up for good after an error response, and phones kill it in the background:
// reconnect ourselves, and go back to the PIN page once the session is gone.
let es = null;
let retry = null;
async function signedOut() {
  try {
    return (await fetch('/api/me', { cache: 'no-store' })).status === 401;
  } catch {
    return false; // unreachable (computer asleep, other network): keep retrying
  }
}
function connect() {
  clearTimeout(retry);
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => {
    $('conn').classList.remove('bad');
    $('conn-text').textContent = L('在线');
  };
  es.onmessage = (e) => {
    state = JSON.parse(e.data);
    followTheme(state.theme, state.paper, state.lightGrain);
    render();
  };
  es.onerror = async () => {
    $('conn').classList.add('bad');
    $('conn-text').textContent = L('离线');
    if (es.readyState !== EventSource.CLOSED) return; // still retrying by itself
    if (await signedOut()) return location.reload();
    retry = setTimeout(connect, 3000);
  };
}
connect();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!es || es.readyState === EventSource.CLOSED) connect();
  if (screenId) refreshScreen();
});

// a reload inside a terminal stays in it
{
  const id = new URLSearchParams(location.hash.slice(1)).get('t');
  if (id) {
    history.replaceState(null, '', location.pathname);
    history.pushState({ term: id }, '', `#t=${encodeURIComponent(id)}`);
    openScreen(id, false);
  }
}
