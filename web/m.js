// The phone page: the units at a glance, and any of our terminals on the whole screen to read, type
// into and answer (keys for dialogs: Esc, arrows, 1–3, Tab, Enter). No message list: what needs you
// shows up as a unit waiting for approval. Talks only to the phone server.
import { L, translateDom } from './i18n.js';
import { followTheme } from './theme.js';

translateDom();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
// time left until a reset, short: "02:50" or "3天"
const left = (ms) => {
  if (!(ms > 0)) return '--';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  return d ? L('{0}天', d) : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
setInterval(() => document.querySelectorAll('[data-reset]').forEach((el) => (el.textContent = left(+el.dataset.reset - Date.now()))), 30_000);
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

function renderQuota() {
  $('quota').innerHTML = (state.usage?.limits || [])
    .map((l) => {
      const used = Math.max(0, Math.min(100, l.usedPct));
      const low = 100 - used <= state.thresholds.energyLowPct;
      const c = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
      const on = Math.round(used / 5);
      const seg = `<span class="seg">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
      // what's used and when it resets (with the date)
      const v = `<span class="v">${Math.round(used)}%<small><span class="cd" data-reset="${l.resetsAt}">${left(l.resetsAt - Date.now())}</span> · ${esc(L('{0} 重置', when(l.resetsAt)))}</small></span>`;
      return `<div class="q" style="--c:${c}"><span class="k">${esc(l.label)}</span>${seg}${v}</div>`;
    })
    .join('');
}

/* ---------- units: every terminal of ours (agents and plain shells) and the sessions outside ---------- */

const ST = {
  permit: () => [L('等授权'), 'var(--red)', 0],
  busy: () => [L('作战中'), 'var(--cyan)', 1],
  starting: () => [L('启动中'), 'var(--cyan)', 2],
  idle: () => [L('待命'), 'var(--amber)', 3],
  shell: () => [L('终端'), 'var(--green)', 4],
};

function rows() {
  const out = [];
  const seen = new Set();
  for (const u of state.units) {
    const kind = u.permission ? 'permit' : u.status === 'busy' ? 'busy' : 'idle';
    const a = u.owned ? (state.agents || []).find((x) => x.id === u.agentId) : null;
    if (a) seen.add(a.id);
    const text = u.permission ? u.permission.message || '' : u.status === 'busy' && u.lastPrompt ? L('执行中：') + u.lastPrompt : u.lastText || '';
    out.push({ id: a?.id || null, name: a?.name || u.name || u.project, project: u.project, kind, since: u.statusSince, text, ours: Boolean(a) });
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

function renderChips() {
  const all = rows();
  const n = (k) => all.filter((r) => r.kind === k).length;
  const chip = (c, label, color, alarm) => `<span class="chip ${c ? '' : 'zero'} ${alarm && c ? 'alarm' : ''}" style="--c:${color}"><b>${c}</b>${esc(label)}</span>`;
  $('chips').innerHTML = chip(n('busy'), L('作战中'), 'var(--cyan)') + chip(n('idle'), L('待命'), 'var(--amber)') + chip(n('permit'), L('等授权'), 'var(--red)', true);
}

function renderUnits() {
  const now = Date.now();
  const html =
    rows()
      .map((r) => {
        const [label, color] = ST[r.kind]();
        const mins = r.since ? Math.max(0, Math.round((now - r.since) / 60_000)) : null;
        const age = mins == null ? '' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${pad(mins % 60)}`;
        const inner = `<div class="head"><span class="dot ${r.kind === 'permit' ? 'blink' : ''}"></span><b class="nm">${esc(r.name)}</b><span class="st">${esc(label)}</span></div>
          <div class="meta"><span class="pj">${esc(r.project)}</span>${r.ours ? '' : `<span class="ext">${L('外部会话')}</span>`}${age ? `<time>${age}</time>` : ''}</div>
          ${r.text ? `<div class="sub">${esc(r.text)}</div>` : ''}`;
        return r.ours
          ? `<button type="button" class="card ${r.kind === 'permit' ? 'permit' : ''}" style="--c:${color}" data-open="${esc(r.id)}">${inner}<span class="go" aria-hidden="true">›</span></button>`
          : `<div class="card ext" style="--c:${color}" title="${esc(L('不是舰桥启动的会话，只能查看状态'))}">${inner}</div>`;
      })
      .join('') || `<div class="empty">${EMPTY}${L('没有运行中的会话')}</div>`;
  if (renderUnits.last !== html) $('list').innerHTML = renderUnits.last = html;
}

function renderSheet() {
  if (!screenId) return;
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
  renderSheet();
}

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
    followTheme(state.theme);
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
