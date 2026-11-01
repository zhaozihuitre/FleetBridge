// The phone page: what needs you (answerable right here), every unit, a read-only view of an
// agent's screen, and one input to send or queue orders. Talks only to the phone server.
import { L, translateDom } from './i18n.js';

translateDom();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const KIND = { PERMIT: 'var(--red)', ALERT: 'var(--red)', OVERLOAD: 'var(--red)', READY: 'var(--amber)', GIT: 'var(--amber)', ENGAGED: 'var(--cyan)', STANDBY: 'var(--muted)' };
const AMBIENT = new Set(['engaged', 'calm', 'standby', 'empty']);

let state = null;
let view = 'msgs';
let queueMode = false;
let screenId = null;
let screenTimer = 0;

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('on'), 2200);
}

const ours = () => (state?.agents || []).filter((a) => a.alive);
const nameOf = (id) => {
  const a = (state?.agents || []).find((x) => x.id === id);
  const u = state?.units.find((x) => x.agentId === id);
  return a?.name || u?.project || id.slice(0, 8);
};

function renderQuota() {
  const f = state.forecast || {};
  $('quota').innerHTML = (state.usage?.limits || [])
    .map((l) => {
      const used = Math.max(0, Math.min(100, l.usedPct));
      const low = 100 - used <= state.thresholds.energyLowPct;
      const fc = f[l.key];
      const c = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
      const on = Math.round(used / 5);
      const seg = `<span class="seg">${Array.from({ length: 20 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
      const v = fc?.runsOutAt
        ? `<span class="v hot">${esc(L('约 {0} 用完', hhmm(fc.runsOutAt)))}</span>`
        : `<span class="v">${Math.round(used)}%${fc?.perHour > 0 ? `<small>+${fc.perHour}/h</small>` : ''}</span>`;
      return `<div class="q" style="--c:${c}"><span class="k">${esc(l.label)}</span>${seg}${v}</div>`;
    })
    .join('');
}

function renderChips() {
  const busy = state.units.filter((u) => u.status === 'busy').length;
  const permit = state.units.filter((u) => u.permission).length;
  const chip = (n, label, c, alarm) => `<span class="chip ${n ? '' : 'zero'} ${alarm && n ? 'alarm' : ''}" style="--c:${c}"><b>${n}</b>${esc(label)}</span>`;
  $('chips').innerHTML = chip(busy, L('作战中'), 'var(--cyan)') + chip(state.units.length - busy, L('待命'), 'var(--amber)') + chip(permit, L('等你授权'), 'var(--red)', true);
}

const EMPTY = '<svg width="40" height="40" viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M17 2l13 7.5v15L17 32 4 24.5v-15z" stroke="#4f7a90" stroke-width="1.4"/><path d="M11 17l4 4 8-8" stroke="#4dffa6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderMsgs() {
  const lines = state.operator?.lines || [];
  $('n-msgs').textContent = lines.filter((l) => !AMBIENT.has(l.key)).length || '';
  if (view !== 'msgs') return;
  $('list').innerHTML =
    lines
      .map((l) => {
        const live = l.unit ? state.units.find((u) => u.sessionId === l.unit.sessionId) : null;
        const pp = l.kind === 'PERMIT' && live?.owned ? live.permission?.prompt : null;
        const answer = pp
          ? `${pp.text ? `<pre>${esc(pp.text)}</pre>` : ''}<div class="acts">${pp.options
              .map((o) => `<button type="button" class="${o.key === '1' ? 'yes' : ''}" data-answer="${esc(live.agentId)}" data-choice="${esc(o.key)}"><span class="n">${esc(o.key)}</span>${esc(o.label)}</button>`)
              .join('')}<button type="button" class="no" data-answer="${esc(live.agentId)}" data-choice="esc"><span class="n">✕</span>${L('拒绝（Esc）')}</button></div>`
          : '';
        const look = live?.owned && !pp ? `<div class="acts row"><button type="button" class="go" data-screen="${esc(live.agentId)}">▣ ${L('看屏幕')}</button><button type="button" data-to="${esc(live.agentId)}">✎ ${L('发指令')}</button></div>` : '';
        return `<article class="card ${l.kind === 'PERMIT' ? 'permit' : ''}" style="--c:${KIND[l.kind] || 'var(--cyan)'}">
          <div class="head"><span class="tag">${esc(l.kind)}</span>${l.unit ? `<span class="p">${esc(l.unit.project.toUpperCase())}</span>` : ''}${l.at ? `<time>${hhmm(l.at)}</time>` : ''}</div>
          <div class="text">${esc(l.text)}</div>${answer}${look}</article>`;
      })
      .join('') || `<div class="empty">${EMPTY}${L('一切正常，没有需要你处理的事')}</div>`;
}

function renderUnits() {
  $('n-units').textContent = state.units.length || '';
  if (view !== 'units') return;
  const now = Date.now();
  $('list').innerHTML =
    state.units
      .map((u) => {
        const st = u.permission ? [L('等你授权'), 'var(--red)'] : u.status === 'busy' ? [L('作战中'), 'var(--cyan)'] : [L('待命'), 'var(--amber)'];
        const mins = Math.max(0, Math.round((now - u.statusSince) / 60_000));
        const text = u.status === 'busy' && u.lastPrompt ? L('执行中：') + u.lastPrompt : u.lastText || '';
        const acts = u.owned ? `<div class="acts row"><button type="button" class="go" data-screen="${esc(u.agentId)}">▣ ${L('看屏幕')}</button><button type="button" data-to="${esc(u.agentId)}">✎ ${L('发指令')}</button></div>` : '';
        const pct = u.contextPct == null ? null : Math.round(u.contextPct);
        const kc = pct != null && pct >= state.thresholds.contextWarnPct ? 'var(--red)' : 'var(--cyan)';
        const ctx = `<div class="ctxbar" style="--kc:${kc}"><span>LOAD</span><span class="bar"><i style="width:${Math.min(100, pct ?? 0)}%"></i></span><b>${pct == null ? '--' : pct + '%'}</b></div>`;
        return `<article class="card ${u.permission ? 'permit' : ''}" style="--c:${st[1]}">
          <div class="head"><span class="dot ${u.permission ? 'blink' : ''}"></span><span class="p">${esc(u.project.toUpperCase())}</span>${u.owned ? `<span class="ours">${L('我方')}</span>` : ''}<span class="st">${esc(st[0])}</span><time>${mins}m</time></div>
          ${text ? `<div class="sub">${esc(text)}</div>` : ''}${ctx}${acts}</article>`;
      })
      .join('') || `<div class="empty">${EMPTY}${L('没有运行中的会话')}</div>`;
}

function renderTargets() {
  const sel = $('target');
  const keep = sel.value;
  const opts = [`<option value="all">${L('全部我方 agent（{0}）', ours().length)}</option>`, ...ours().map((a) => `<option value="${esc(a.id)}">${esc(nameOf(a.id))}</option>`)];
  const html = opts.join('');
  if (renderTargets.last !== html) {
    sel.innerHTML = renderTargets.last = html;
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all';
  }
  $('send').disabled = !ours().length;
}

function render() {
  if (!state) return;
  renderQuota();
  renderChips();
  renderMsgs();
  renderUnits();
  renderTargets();
}

function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('.tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}

async function refreshScreen() {
  if (!screenId) return;
  const r = await fetch(`/api/screen?id=${encodeURIComponent(screenId)}`).then((x) => x.json()).catch(() => ({ lines: [] }));
  const el = $('screen');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  // colored by the server (text already escaped there)
  if (r.html?.length) el.innerHTML = r.html.join('\n');
  else el.textContent = L('（没有内容）');
  if (atBottom) el.scrollTop = el.scrollHeight;
  const menu = r.menu || [];
  const html = menu.map((o) => `<button type="button" class="${o.current ? 'cur' : ''}" data-choice="${esc(o.key)}">${esc(o.key)}. ${esc(o.label)}</button>`).join('');
  if ($('sheet-menu').dataset.last !== html) $('sheet-menu').innerHTML = $('sheet-menu').dataset.last = html;
}

function openScreen(id) {
  screenId = id;
  $('sheet-name').textContent = nameOf(id);
  $('sheet').hidden = false;
  $('target').value = id;
  refreshScreen();
  clearInterval(screenTimer);
  screenTimer = setInterval(refreshScreen, 2000);
}

function closeScreen() {
  screenId = null;
  clearInterval(screenTimer);
  $('sheet').hidden = true;
}

/* ---------- events ---------- */

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

$('list').addEventListener('click', async (e) => {
  const an = e.target.closest('[data-answer]');
  if (an) {
    an.disabled = true;
    const r = await post('/api/action', { id: an.dataset.answer, action: 'answer', choice: an.dataset.choice });
    return toast(r.results?.[0] ? L('已回应授权') : L('回应失败：agent 可能已经退出'));
  }
  const sc = e.target.closest('[data-screen]');
  if (sc) return openScreen(sc.dataset.screen);
  const to = e.target.closest('[data-to]');
  if (to) {
    $('target').value = to.dataset.to;
    $('text').focus();
  }
});

$('queue').addEventListener('click', () => {
  queueMode = !queueMode;
  $('queue').setAttribute('aria-pressed', String(queueMode));
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  const ids = $('target').value === 'all' ? ours().map((a) => a.id) : [$('target').value];
  if (!ids.length) return toast(L('还没有我方 agent'));
  $('send').disabled = true;
  const r = await post('/api/action', { id: ids, action: queueMode ? 'queue' : 'text', text });
  $('send').disabled = false;
  const ok = (r.results || []).filter(Boolean).length;
  if (!ok) return toast(L('发送失败'));
  $('text').value = '';
  toast(queueMode ? L('已加入 {0} 个 agent 的队列，做完当前的再发', ok) : L('已发给 {0} 个 agent', ok));
  if (screenId) setTimeout(refreshScreen, 1200);
});

$('sheet-close').addEventListener('click', closeScreen);
// keys and menu choices go straight to the agent shown, then the screen refreshes soon after
async function press(body) {
  if (!screenId) return;
  await post('/api/action', { id: screenId, ...body });
  setTimeout(refreshScreen, 400);
}
document.querySelector('.sheet-head .esc').addEventListener('click', () => press({ action: 'key', key: 'esc' }));
$('sheet-menu').addEventListener('click', (e) => {
  const c = e.target.closest('[data-choice]');
  if (c) press({ action: 'answer', choice: c.dataset.choice });
});

/* ---------- the on-screen keyboard must not cover the composer ---------- */

// Android Chrome resizes the page for the keyboard (interactive-widget in the viewport meta);
// iOS Safari and others only shrink the visual viewport, so lift the composer by what it hides.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
$('text').addEventListener('focus', () => setTimeout(() => $('text').scrollIntoView({ block: 'nearest' }), 300));

/* ---------- live state ---------- */

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    $('conn').classList.remove('bad');
    $('conn-text').textContent = L('在线');
  };
  es.onmessage = (e) => {
    state = JSON.parse(e.data);
    render();
  };
  es.onerror = () => {
    $('conn').classList.add('bad'); // EventSource reconnects by itself
    $('conn-text').textContent = L('离线');
  };
}
connect();
