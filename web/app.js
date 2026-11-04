import { createTerminal } from './terminal.js';
import { ask } from './ui.js';
import { L, lang, locale, setLang, translateDom } from './i18n.js';
import { followTheme, THEMES, THEME_KEYS } from './theme.js';

const $ = (id) => document.getElementById(id);
// How many items of each list fit the page area at its current size (the window is not a fixed size).
const ITEM = { unitW: 400, unitGap: 16, questH: 92, questGap: 10, saveH: 108, saveGap: 8 };
function pageSize(kind) {
  const W = $('page').clientWidth || 900;
  const H = $('page').clientHeight || 600;
  if (kind === 'units') return Math.max(1, Math.floor((W + ITEM.unitGap) / (ITEM.unitW + ITEM.unitGap)));
  if (kind === 'agents') return Math.max(1, Math.floor((H - 46 + ITEM.questGap) / (ITEM.questH + ITEM.questGap))); // minus the header row
  return Math.max(1, Math.floor((H - 30) / (ITEM.saveH + ITEM.saveGap))); // archive
}
const KIND = {
  PERMIT: { label: 'PERMIT', c: 'var(--red)', mood: L('● 请求授权') },
  ALERT: { label: 'ALERT', c: 'var(--red)', mood: L('● 紧张') },
  OVERLOAD: { label: 'OVERLOAD', c: 'var(--red)', mood: L('● 担心') },
  READY: { label: 'READY', c: 'var(--amber)', mood: L('● 招手') },
  GIT: { label: 'GIT', c: 'var(--amber)', mood: L('● 皱眉') },
  SYS: { label: 'SYS', c: 'var(--muted)', mood: L('● 惊讶') },
  RECHARGED: { label: 'RECHARGED', c: 'var(--green)', mood: L('● 开心') },
  ENGAGED: { label: 'ENGAGED', c: 'var(--cyan)', mood: L('● 专注') },
  STANDBY: { label: 'STANDBY', c: 'var(--muted)', mood: L('● 打盹') },
  DRONE: { label: 'DRONE', c: 'var(--cyan)' },
};
const LV_COLOR = { S: 'var(--red)', A: 'var(--amber)', B: '#C9A24A' };

const TABS = ['units', 'agents', 'orders', 'archive'];
const ui = { tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'units', page: 0, line: 0, lineKey: null, folder: null };
let state = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

function dur(ms, short = false) {
  if (ms == null || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  // Orbitron draws "D" almost like "0", so days use 天
  if (d) return short ? L('{0}天', d) : `${L('{0}天', d)} ${pad(h)}:${pad(m)}`;
  return short ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function ago(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return L('刚刚');
  if (m < 60) return L('{0} 分钟前', m);
  const h = Math.floor(m / 60);
  return h < 48 ? L('{0} 小时前', h) : L('{0} 天前', Math.floor(h / 24));
}

// Operator lines that are just ambience: nothing to jump to or snooze.
const AMBIENT = new Set(['engaged', 'calm', 'standby', 'empty']);

function clock(ms, withDate) {
  const d = new Date(ms);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

function seg(pct, n, color) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n);
  return `<div class="seg" style="--c:${color}">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
}

function kTokens(n) {
  return n == null ? '--' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/* ---------- header ---------- */

const ERROR_TEXT = { rate_limited: L('接口限流，稍后自动重试'), token_expired: L('登录过期，打开一次 Claude Code 即可') };

// The API's limit list (5h, weekly, per-model weekly); caches from older versions only had two windows.
function usageLimits(u) {
  if (u?.limits?.length) return u.limits;
  return [
    u?.fiveHour && { key: 'session', label: L('5 小时'), ...u.fiveHour },
    u?.sevenDay && { key: 'weekly_all', label: L('本周 · 所有模型'), ...u.sevenDay },
  ].filter(Boolean);
}

function renderEnergy() {
  const u = state?.usage;
  const limits = usageLimits(u);
  const errText = u?.error ? ERROR_TEXT[u.error] || u.error : '';
  if (!limits.length) {
    $('energy').innerHTML = `<div class="energy box cut"><div class="row"><span class="label">ENERGY · ${L('额度')}</span><span>${errText ? L('读取失败：') + esc(errText) : L('读取中…')}</span></div>${seg(0, 30, 'var(--cyan)')}</div>`;
  } else {
    $('energy').innerHTML = limits
      .map((l) => {
        // the bar shows what's used, like /usage does
        const used = Math.min(100, Math.max(0, l.usedPct));
        const low = 100 - used <= state.thresholds.energyLowPct;
        const color = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
        const weekly = l.key !== 'session';
        const stale = u.error ? `<span class="stale" title="${esc(errText)}${u.retryAt ? ' · ' + clock(u.retryAt) + L(' 重试') : ''}">${L('缓存 {0}', clock(u.fetchedAt))}</span>` : '';
        return `<div class="energy box cut ${l.active ? 'active' : ''}" title="${l.active ? L('当前起作用的限额') : ''}">
          <div class="row"><span class="label">${weekly ? 'RESERVE' : 'ENERGY'} · ${esc(l.label)}</span>${stale}
            <span class="left ${low ? 'low' : ''}">${Math.round(used)}%</span></div>
          ${seg(used, 24, color)}
          <div class="row">${burnText(l)}<span>${L('重置 ')}<span class="cd" data-reset="${l.resetsAt}">${dur(l.resetsAt - Date.now())}</span> · ${clock(l.resetsAt, weekly)}</span></div>
        </div>`;
      })
      .join('');
  }
  const a = u?.account;
  $('pilot').textContent = a ? `PILOT · ${(a.tier || a.plan || '').replace('default_claude_', '').toUpperCase()} · ${a.email || ''}` : 'PILOT';
  $('pilot').title = a ? `${a.email || ''} · ${a.org || ''}` : '';
}

// Burn rate under a quota bar: "+12%/h", or in red when it runs out before the reset.
function burnText(l) {
  const f = state.forecast?.[l.key];
  if (!f || f.perHour <= 0) return `<span>${L('已用')}</span>`;
  const tip = esc(L('最近每小时用掉 {0}%', f.perHour));
  return f.runsOutAt
    ? `<span class="burn hot" title="${tip}">${L('约 {0} 用完', clock(f.runsOutAt))}</span>`
    : `<span class="burn" title="${tip}">+${f.perHour}%/h</span>`;
}

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString(locale, { hour12: false });
  document.querySelectorAll('[data-reset]').forEach((el) => (el.textContent = dur(+el.dataset.reset - Date.now())));
  document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = 'T+' + dur(Date.now() - +el.dataset.since)));
}

/* ---------- operator ---------- */

function currentLine() {
  const lines = state?.operator.lines || [];
  if (!lines.length) return null;
  // keep pointing at the same quest when the list reorders
  const keep = lines.findIndex((l) => l.key === ui.lineKey);
  ui.line = keep >= 0 ? keep : Math.min(ui.line, lines.length - 1);
  ui.lineKey = lines[ui.line].key;
  return lines[ui.line];
}

function renderOperator() {
  const op = state.operator;
  const line = currentLine();
  const mood = line && line.kind !== op.mood && op.mood !== 'STANDBY' ? line.kind : op.mood;
  $('operator').dataset.mood = mood;
  $('op-mood').textContent = KIND[mood]?.mood || '';
  $('op-mood').style.color = KIND[mood]?.c;
  renderStats();

  // Message box: every reminder as an incoming message (most urgent first), then the commands we sent.
  const incoming = op.lines.map((l, i) => {
    const k = KIND[l.kind] || {};
    const text = esc(l.text).replace(/(\d+(?:\.\d+)?%)/g, l.kind === 'OVERLOAD' || l.kind === 'ALERT' ? '<em>$1</em>' : '$1');
    // a permission dialog of one of our agents: show what it asks and answer it right here
    const live = l.kind === 'PERMIT' && l.unit ? state.units.find((u) => u.sessionId === l.unit.sessionId) : null;
    const pp = live?.owned ? live.permission?.prompt : null;
    const answer = pp
      ? `${pp.text ? `<pre class="msg-prompt">${esc(pp.text)}</pre>` : ''}<div class="msg-answers">${pp.options
          .map((o) => `<button type="button" class="${o.key === '1' ? 'yes' : ''}" data-answer="${esc(live.agentId)}" data-choice="${esc(o.key)}" title="${esc(o.label)}">${esc(o.key)}. ${esc(o.label)}</button>`)
          .join('')}<button type="button" class="no" data-answer="${esc(live.agentId)}" data-choice="esc">${L('拒绝（Esc）')}</button></div>`
      : '';
    const acts = l.unit && !AMBIENT.has(l.key)
      ? `${answer}<div class="msg-acts"><button type="button" data-msg-go="${i}">${l.kind === 'PERMIT' ? L('▶ 去终端授权') : L('▶ 跳到终端')}</button><button type="button" data-msg-snooze="${esc(l.key)}">${L('稍后')}</button></div>`
      : '';
    return `<div class="msg in ${i === ui.line ? 'on' : ''}" style="--mc:${k.c || 'var(--cyan)'}" data-line="${i}">
      <div class="msg-head"><b>${esc(op.name)}</b>${l.unit ? `<span>→ ${esc(l.unit.project.toUpperCase())}</span>` : ''}<i>${k.label || ''}</i>${l.at ? `<time title="${esc(new Date(l.at).toLocaleString(locale, { hour12: false }))}">${clock(l.at, Date.now() - l.at > 86_400_000)}</time>` : ''}</div>
      <div class="msg-text">${text}</div>${acts}</div>`;
  });
  const outgoing = sentLog
    .slice(0, 8)
    .reverse()
    .map((s) => `<div class="msg out"><div class="msg-text">${esc(s.text)}</div><div class="msg-meta">${clock(s.t)} · ${L('发给 {0} 个', s.n)}</div></div>`);
  const queued = (state.agents || [])
    .filter((a) => a.alive && a.queue?.length)
    .flatMap((a) => a.queue.map((q, i) => `<div class="msg out queued"><div class="msg-text">${esc(q.text)}</div><div class="msg-meta">→ ${esc(agentLabel(a.id).name)} · #${i + 1}<button type="button" data-unqueue="${esc(a.id)}" data-index="${i}" title="${L('从队列移除')}">✕</button></div></div>`));
  const html = incoming.join('') + (outgoing.length ? `<div class="msg-sep">${L('已发送')}</div>` + outgoing.join('') : '') + (queued.length ? `<div class="msg-sep">${L('排队中')}</div>` + queued.join('') : '');
  if (renderOperator.last !== html) {
    const box = $('msg-box');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.innerHTML = renderOperator.last = html;
    if (atBottom && outgoing.length) box.scrollTop = box.scrollHeight;
  }
}

// Today at a glance, above the message box: tokens, cache hit rate, prompts, who is waiting for you.
function renderStats() {
  const t = state.today;
  const th = state.thresholds;
  const now = Date.now();
  const waiting = state.units.filter((u) => u.permission || (u.status === 'idle' && now - u.statusSince <= th.standbyMinutes * 60_000));
  const longest = waiting.reduce((m, u) => Math.max(m, now - u.statusSince), 0);
  const permit = waiting.filter((u) => u.permission).length;
  const hit = t?.cacheHitPct;
  const tiles = [
    { c: 'var(--cyan)', v: t ? kTokens(t.total) : '--', full: t ? t.total.toLocaleString() : null, k: L('今日 token'), s: t ? L('输出 {0} · {1} 个会话', kTokens(t.output), t.sessions) : L('统计中…'), tip: t ? L('输入 {0} · 缓存读 {1} · 缓存写 {2} · 输出 {3}', t.input.toLocaleString(), t.cacheRead.toLocaleString(), t.cacheWrite.toLocaleString(), t.output.toLocaleString()) : '' },
    { c: hit == null ? 'var(--dim)' : hit >= 80 ? 'var(--green)' : hit >= 50 ? 'var(--amber)' : 'var(--red)', v: hit == null ? '--' : `${Math.round(hit)}%`, k: L('缓存命中'), s: L('越高越省额度'), tip: L('缓存读取 ÷ 全部输入 token') },
    { c: 'var(--cyan)', v: t ? String(t.prompts) : '--', k: L('今日指令'), s: L('你发出的指令数'), tip: L('今天所有会话里你输入的指令（不含工具结果和斜杠命令）') },
    { c: permit ? 'var(--red)' : waiting.length ? 'var(--amber)' : 'var(--dim)', v: String(waiting.length), k: permit ? L('等你 · {0} 个授权', permit) : L('等你'), s: waiting.length ? L('最久 {0}', ago(longest).replace(/ ?(前|ago)$/, '')) : L('没有会话在等'), tip: waiting.map((u) => u.project).join('、') },
  ];
  const html = tiles
    // one compact row: the number and its name; the details (and the unabbreviated number) on hover
    .map((x) => `<div class="stat-box ${x.v === '0' || x.v === '--' ? 'zero' : ''}" style="--sc:${x.c}" title="${esc([`${x.k}：${x.full || x.v}`, x.s, x.tip].filter(Boolean).join('\n'))}"><b>${esc(x.v)}</b><span>${esc(x.k)}</span></div>`)
    .join('');
  if (renderStats.last !== html) $('op-stats').innerHTML = renderStats.last = html;
}

function goLine(i) {
  const l = state?.operator.lines[i];
  if (l?.unit && !AMBIENT.has(l.key)) focus(l.unit.pid);
}

/* ---------- master console: one input for all of our agents ---------- */

const sentLog = []; // shown as outgoing messages in the message box

// our live Claude agents; plain shells (kind 'shell') get panes but no orders, no rows, no "end all"
function liveAgents() {
  return (state?.agents || []).filter((a) => a.alive && a.kind !== 'shell');
}

const isShell = (id) => (state?.agents || []).some((a) => a.id === id && a.kind === 'shell');

// A plain PowerShell in the split view, in the folder of the active terminal (else the newest project).
async function openShell() {
  const cwd = agentLabel(ui.term || '').cwd || folders()[0]?.cwd || '';
  const r = await post('/api/agents', { shell: true, cwd });
  if (!r.id) return toast(r.error || L('无法打开终端'));
  openTerm(r.id);
}

// @handles for the command box: the agent's name, lowercased and spaceless; duplicates get an id suffix.
function handles() {
  const list = liveAgents().map((a) => ({ id: a.id, cwd: a.cwd, handle: agentLabel(a.id).name.toLowerCase().replace(/\s+/g, '-') }));
  const seen = new Map();
  for (const h of list) seen.set(h.handle, (seen.get(h.handle) || 0) + 1);
  for (const h of list) if (seen.get(h.handle) > 1) h.handle += '-' + h.id.slice(0, 4);
  return list;
}

// "@ideas-b6 @monitor do X" -> { ids, text: "do X", unknown: [] }. A mention may also be a unique prefix or the folder name.
function parseMentions(raw) {
  const hs = handles();
  const ids = new Set();
  const unknown = [];
  const text = raw
    .replace(/@([^\s@]+)/g, (_, name) => {
      const n = name.toLowerCase();
      const exact = hs.find((h) => h.handle === n);
      const prefix = hs.filter((h) => h.handle.startsWith(n));
      const folder = hs.filter((h) => h.cwd.toLowerCase().split(/[\\/]/).pop() === n);
      const hit = exact ? [exact] : prefix.length === 1 ? prefix : folder.length ? folder : [];
      if (!hit.length) unknown.push('@' + name);
      for (const h of hit) ids.add(h.id);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { ids: [...ids], text, unknown };
}

// Without an @mention a command goes to every live agent of ours.
function renderConsole() {
  const n = liveAgents().length;
  $('cmd-to').textContent = n ? L('发给全部 {0} 个 · @ 指定', n) : L('还没有我方 agent');
  $('cmd-send').disabled = !n;
}

async function sendToTargets(body, label, ids) {
  if (!ids.length) return;
  const r = await post('/api/agents/action', { ...body, id: ids });
  const ok = (r.results || []).filter(Boolean).length;
  spotlight(ids.filter((_, i) => r.results?.[i]));
  sentLog.unshift({ t: Date.now(), text: label, n: ok });
  if (body.action === 'queue') toast(L('已加入 {0} 个 agent 的队列，做完当前的再发', ok));
  else toast(ok === ids.length ? L('已发给 {0} 个 agent', ok) : L('发出 {0} / {1}，有的 agent 可能已经退出', ok, ids.length));
  renderOperator();
  $('msg-box').scrollTop = $('msg-box').scrollHeight;
}

$('msg-box').addEventListener('click', (e) => {
  const go = e.target.closest('[data-msg-go]');
  if (go) return goLine(Number(go.dataset.msgGo));
  const uq = e.target.closest('[data-unqueue]');
  if (uq) return post('/api/agents/action', { id: uq.dataset.unqueue, action: 'unqueue', index: Number(uq.dataset.index) });
  const an = e.target.closest('[data-answer]');
  if (an) {
    an.disabled = true;
    return post('/api/agents/action', { id: an.dataset.answer, action: 'answer', choice: an.dataset.choice }).then((r) =>
      toast(r.results?.[0] ? L('已回应授权') : L('回应失败：agent 可能已经退出')),
    );
  }
  const sn = e.target.closest('[data-msg-snooze]');
  if (sn) return snoozeLine(sn.dataset.msgSnooze);
  const m = e.target.closest('[data-line]');
  if (m) {
    ui.line = Number(m.dataset.line);
    ui.lineKey = state.operator.lines[ui.line]?.key;
    renderOperator();
  }
});
$('cmd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('cmd-text').value.trim();
  if (!raw) return ($('cmd-err').textContent = L('先输入指令'));
  // @mentions pick the recipients for this one message; without any, the checked agents get it
  const m = parseMentions(raw);
  if (m.unknown.length) return ($('cmd-err').textContent = L('找不到 {0}', m.unknown.join(' ')));
  if (!m.text) return ($('cmd-err').textContent = L('@ 后面还要写指令内容'));
  $('cmd-err').textContent = '';
  const ids = m.ids.length ? m.ids : liveAgents().map((a) => a.id);
  const who = m.ids.length ? raw.match(/@[^\s@]+/g).join(' ') + ' ' : '';
  await sendToTargets({ action: queueMode ? 'queue' : 'text', text: m.text }, (queueMode ? '⏱ ' : '') + who + m.text, ids);
  $('cmd-text').value = '';
  closeSuggest();
});

/* queue mode: orders wait in a queue and go out one per finished turn */
let queueMode = false;
try {
  queueMode = localStorage.getItem('fb-queue-mode') === '1';
} catch {
  // default: send right away
}
function setQueueMode(on) {
  queueMode = on;
  $('cmd-queue').setAttribute('aria-pressed', String(on));
  try {
    localStorage.setItem('fb-queue-mode', on ? '1' : '0');
  } catch {
    // not remembered
  }
}
setQueueMode(queueMode);
$('cmd-queue').addEventListener('click', () => setQueueMode(!queueMode));

/* the library of saved prompts */
let library = [];
async function loadLibrary() {
  library = (await fetch('/api/prompts').then((r) => r.json()).catch(() => ({ list: [] }))).list || [];
}
async function saveLibrary(list) {
  library = (await post('/api/prompts', { list })).list || list;
}
function renderLibrary() {
  $('lib-menu').innerHTML =
    (library.length
      ? library.map((p, i) => `<div class="lib-item"><button type="button" data-lib="${i}" title="${esc(p)}">${esc(p.split('\n')[0])}</button><button type="button" class="del" data-lib-del="${i}" title="${L('删除')}">✕</button></div>`).join('')
      : `<div class="lib-empty">${L('还没有常用指令。在输入框写好后点下面保存。')}</div>`) +
    `<button type="button" class="lib-add" data-lib-add>${L('＋ 保存当前输入')}</button>`;
}
async function toggleLibrary(open = $('lib-menu').hidden) {
  if (open) {
    await loadLibrary();
    renderLibrary();
  }
  $('lib-menu').hidden = !open;
  $('cmd-lib').setAttribute('aria-expanded', String(open));
}
$('cmd-lib').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleLibrary();
});
$('lib-menu').addEventListener('click', async (e) => {
  e.stopPropagation();
  const use = e.target.closest('[data-lib]');
  const del = e.target.closest('[data-lib-del]');
  if (use) {
    $('cmd-text').value = library[Number(use.dataset.lib)] || '';
    toggleLibrary(false);
    $('cmd-text').focus();
  } else if (del) {
    await saveLibrary(library.filter((_, i) => i !== Number(del.dataset.libDel)));
    renderLibrary();
  } else if (e.target.closest('[data-lib-add]')) {
    const t = $('cmd-text').value.trim();
    if (!t) return toast(L('输入框是空的'));
    if (!library.includes(t)) await saveLibrary([...library, t]);
    renderLibrary();
    toast(L('已保存到常用'));
  }
});
document.addEventListener('click', () => !$('lib-menu').hidden && toggleLibrary(false));

/* @ autocomplete: suggests our agents while typing a mention */
const suggest = { items: [], index: 0, start: -1 };

function closeSuggest() {
  suggest.items = [];
  suggest.start = -1;
  $('cmd-suggest').hidden = true;
}

function updateSuggest() {
  const ta = $('cmd-text');
  const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) return closeSuggest();
  const q = m[1].toLowerCase();
  suggest.items = handles().filter((h) => h.handle.includes(q) || h.cwd.toLowerCase().includes(q));
  if (!suggest.items.length) return closeSuggest();
  suggest.start = before.length - m[0].length;
  suggest.index = Math.min(suggest.index, suggest.items.length - 1);
  $('cmd-suggest').innerHTML = suggest.items
    .map((h, i) => `<div class="sg ${i === suggest.index ? 'on' : ''}" role="option" data-i="${i}"><b>@${esc(h.handle)}</b><small>${esc(h.cwd)}</small></div>`)
    .join('');
  $('cmd-suggest').hidden = false;
}

function pickSuggest(i) {
  const h = suggest.items[i];
  if (!h) return;
  const ta = $('cmd-text');
  const after = ta.value.slice(ta.selectionStart);
  const head = ta.value.slice(0, suggest.start) + '@' + h.handle + ' ';
  ta.value = head + after.replace(/^[^\s@]*/, '');
  ta.selectionStart = ta.selectionEnd = head.length;
  closeSuggest();
  ta.focus();
}

$('cmd-text').addEventListener('input', () => {
  suggest.index = 0;
  updateSuggest();
});
$('cmd-text').addEventListener('click', updateSuggest);
$('cmd-text').addEventListener('blur', () => setTimeout(closeSuggest, 150));
$('cmd-suggest').addEventListener('mousedown', (e) => {
  const el = e.target.closest('[data-i]');
  if (!el) return;
  e.preventDefault();
  pickSuggest(Number(el.dataset.i));
});
$('cmd-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $('cmd-form').requestSubmit();
    return;
  }
  if ($('cmd-suggest').hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
    updateSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') pickSuggest(suggest.index);
  else if (e.key === 'Escape') closeSuggest();
  else return;
  e.preventDefault();
});

/* ---------- full deploy: the latest session of the 4 most recent projects, split 2x2 ---------- */

// Home and temp folders aren't projects (scratch chats, tool runs).
const NOT_PROJECT = /\\AppData\\|^[A-Za-z]:\\Users\\[^\\]+\\?$/i;

async function deployAll() {
  if (!state?.agentSupport?.ok) return toast(state?.agentSupport?.error || L('无法启动 agent'));
  const picks = [];
  const external = [];
  for (const f of folders()) {
    if (picks.length >= MAX_PANES) break;
    if (NOT_PROJECT.test(f.cwd)) continue;
    const s = f.sessions[0]; // newest session of that folder
    if (s.owned) picks.push({ project: f.project, open: s.agentId });
    else if (s.pid) external.push(f.project); // running in an outside terminal: can't be commanded from here
    else picks.push({ project: f.project, resume: s.sessionId, title: s.title || s.lastPrompt || '' });
  }
  if (!picks.length) return toast(L('没有可以出击的项目会话'));
  const lines = picks.map((p) => `◆ ${p.project.toUpperCase()}${p.open ? L('　已在指挥中心') : '　' + p.title.slice(0, 40)}`);
  const go = await ask({
    tag: 'FULL DEPLOY',
    title: L('全军出击：{0} 个项目', picks.length),
    message: L('打开这些项目最新的会话，分屏排开。'),
    detail: external.length ? [...lines, '', L('跳过（正在外部终端运行）：{0}', external.join(lang === 'en' ? ', ' : '、'))] : lines,
    ok: L('⚡ 出击'),
  });
  if (!go) return;

  closeAllPanes();
  let failed = 0;
  for (const p of picks) {
    if (p.open) {
      openTerm(p.open);
      continue;
    }
    const r = await post('/api/agents', { resume: p.resume });
    if (r.ok) openTerm(r.id);
    else failed++;
  }
  toast(failed ? L('出击 {0} 个，{1} 个失败', picks.length - failed, failed) : L('全军出击！{0} 个终端已就位', picks.length));
}
$('deploy-all').addEventListener('click', deployAll);

/* ---------- pages ---------- */

function unitCard(u) {
  const th = state.thresholds;
  const now = Date.now();
  const standby = u.status === 'idle' && now - u.statusSince > th.standbyMinutes * 60_000;
  const cls = u.offline ? 'offline' : u.permission ? 'permit' : u.status === 'busy' ? 'busy' : standby ? 'idle standby' : 'idle';
  const label = u.offline ? { zh: 'OFFLINE · 未出击', en: 'OFFLINE', ja: 'OFFLINE · 未出撃' }[lang] : lang === 'en' ? (u.permission ? 'PERMIT' : u.status === 'busy' ? 'ENGAGED' : standby ? 'STANDBY' : 'AWAITING') : lang === 'ja' ? (u.permission ? 'PERMIT · 承認待ち' : u.status === 'busy' ? 'ENGAGED · 作業中' : standby ? 'STANDBY · 休止' : 'AWAITING · 待機') : u.permission ? 'PERMIT · 等你授权' : u.status === 'busy' ? 'ENGAGED · 作战中' : standby ? 'STANDBY · 休眠' : 'AWAITING · 待命';
  const hot = u.contextPct != null && u.contextPct >= th.contextWarnPct;
  const loadColor = hot ? 'var(--red)' : 'var(--cyan)';
  const running = u.agents.filter((a) => a.running);
  const drones = !u.agents.length ? L('无') : running.length ? L('{0} 架出击：{1}', running.length, running.map((a) => a.description).join(lang === 'en' ? ', ' : '、')) : L('{0} 架 · 全部返航', u.agents.length);
  const repos = u.repos.map(repoRow).join('');
  const oldestFetch = u.repos.reduce((m, r) => (r.fetchedAt && (!m || r.fetchedAt < m) ? r.fetchedAt : m), null);
  // offline: its latest session, deployed here (or in an outside terminal) on demand
  const action = u.offline
    ? `<button class="mini" data-takeover="${esc(u.sessionId)}" title="${L('在指挥中心里继续，可以直接下指令')}">${L('▶ 出击')}</button><button class="mini ghost" data-resume="${esc(u.sessionId)}" title="${L('在新的 Windows Terminal 里继续')}">${L('外部终端')}</button>`
    : u.owned
    ? `<button class="mini" data-term="${esc(u.agentId)}" title="${L('打开它的终端，直接下指令')}">${L('▶ 终端')}</button>`
    : `<button class="mini ghost" data-focus="${u.pid}" title="${L('在外部终端里运行，只能切过去')}">${L('跳过去')}</button>`;
  return `
  <article class="unit ${cls}" data-unit="${esc(u.key)}">
    <div class="top"><span>◆ ${label}${u.owned ? ` <i class="ours">${L('我方')}</i>` : ''}</span><span class="top-r"><span class="timer" data-since="${u.statusSince}">T+${dur(now - u.statusSince)}</span>${action}</span></div>
    <div><h3 title="${esc(u.cwd)}">${esc(u.project)}</h3><div class="call">${L('呼号')} ${esc(u.name)} · ${esc((u.model || '').replace('claude-', '').toUpperCase())}</div>
      <div class="loc" title="${esc(u.cwd)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${esc(u.cwd)}</div></div>
    <div class="last" title="${esc(u.permission?.message || u.lastText)}">${esc(u.permission ? L('请求授权：') + (u.permission.message || L('需要你确认')) : u.status === 'busy' && u.lastPrompt ? L('执行中：') + u.lastPrompt : u.lastText || (u.lastPrompt ? L('最后指令：') + u.lastPrompt : L('（还没有汇报）')))}</div>
    <div class="stats">
      <div class="stat" style="--kc:${loadColor}"><div class="k"><span>${L('LOAD 记忆负载')}</span><span class="mono">${u.contextPct == null ? '--' : Math.round(u.contextPct) + '%'} · ${kTokens(u.contextTokens)}</span></div>${seg(u.contextPct ?? 0, 20, loadColor)}</div>
      <div class="stat"><div class="k"><span>${L('DRONES 僚机')}</span></div><div class="v" title="${esc(drones)}">${esc(drones)}</div></div>
    </div>
    <div class="repos">
      <div class="k"><span>${L('REPOS 仓库')} ×${u.repos.length}</span><span>${oldestFetch ? L('最早 fetch 在 ') + ago(now - oldestFetch) : ''}</span></div>
      ${!u.gitScanned ? `<div class="empty">${L('扫描中…')}</div>` : u.repos.length ? repos : `<div class="empty">${L('这个目录下没有 git 仓库')}</div>`}
    </div>
  </article>`;
}

function repoRow(r) {
  if (r.error) return `<div class="repo" style="--rc:var(--red)"><div class="r1"><span class="name">${esc(r.name)}</span></div><div class="chg">${L('读取失败：{0}', esc(r.error))}</div></div>`;
  const th = state.thresholds;
  const now = Date.now();
  const stale = r.oldestChangeAt && now - r.oldestChangeAt >= th.staleDirtyDays * 86_400_000;
  const rc = r.conflicts || r.operation || stale ? 'var(--red)' : r.changedCount ? 'var(--amber)' : 'var(--line-hi)';
  const sync = !r.upstream ? [L('无上游'), 'var(--amber)'] : r.ahead || r.behind ? [`↑${r.ahead} ↓${r.behind}`, 'var(--amber)'] : ['↑0 ↓0', 'var(--green)'];
  let chg = L('工作区干净');
  if (r.operation) chg = L('卡在 {0} 中途', r.operation) + (r.conflicts ? L('，{0} 个冲突', r.conflicts) : '');
  else if (r.changedCount)
    chg = `${L('{0} 个文件未提交', r.changedCount)}${r.untracked ? L('（{0} 新）', r.untracked) : ''} · +${r.insertions} −${r.deletions}${r.oldestChangeAt ? L(' · 已放 ') + dur(now - r.oldestChangeAt, true).replace(/^(\d\d):(\d\d)$/, '$1h$2m') : ''}`;
  if (r.stash) chg += ` · stash ${r.stash}`;
  const touched = r.claudeTouchedAt ? `<span class="claude" title="${L('Claude 最后一次修改这个仓库的时间')}">CLAUDE ${clock(r.claudeTouchedAt, now - r.claudeTouchedAt > 86_400_000)}</span>` : '';
  return `<div class="repo" style="--rc:${rc}" title="${esc(r.head ? `${r.head.hash} · ${r.head.subject} · ${r.head.author}` : r.path)}">
    <div class="r1"><span class="name">${esc(r.name)}</span>${touched}<span class="branch">${esc(r.branch || '(detached)')}</span><span class="sync" style="color:${sync[1]}">${sync[0]}</span></div>
    ${remoteLine(r)}
    <div class="chg">${esc(chg)}${r.changedCount || r.ahead ? `<button type="button" class="rv-open" data-review="${esc(r.path)}">${L('审查改动')}</button>` : ''}</div></div>`;
}

// Where this repo pushes to, so commits don't land in the wrong repository.
function remoteLine(r) {
  const icon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v6m0 8v6M5 12h14"/><circle cx="12" cy="12" r="3"/></svg>';
  if (!r.remote) return `<div class="rmt warn">${icon}${r.remotes?.length ? L('有多个远程，没有默认推送目标') : L('没有远程仓库，只在本地')}</div>`;
  const label = `${r.remote.host}/${r.remote.slug}`;
  const others = (r.remotes || []).filter((x) => x.name !== r.remote.name);
  const more = others.length
    ? `<span class="more-rmt" title="${esc(others.map((x) => `${x.name} → ${x.host}/${x.slug}`).join('\n'))}">${L('另有 {0}', others.map((x) => esc(x.name)).join(lang === 'en' ? ', ' : '、'))}</span>`
    : '';
  const link = r.remote.web
    ? `<a href="${esc(r.remote.web)}" target="_blank" rel="noopener" title="${L('推送到 {0}：{1}（点击打开）', esc(r.remote.name), esc(label))}">${esc(label)}</a>`
    : `<span>${esc(label)}</span>`;
  return `<div class="rmt">${icon}<span class="rname">${esc(r.remote.name)}</span>${link}${more}</div>`;
}

// The repo an agent is working in: the one Claude edited last, else the only one under its folder.
function activeRepo(u) {
  const repos = (u?.repos || []).filter((r) => !r.error);
  const touched = repos.filter((r) => r.claudeTouchedAt).sort((a, b) => b.claudeTouchedAt - a.claudeTouchedAt);
  return touched[0] || (repos.length === 1 ? repos[0] : null);
}

function repoBadge(u) {
  const r = activeRepo(u);
  const all = (u?.repos || []).map((x) => `${x.name} → ${x.remote ? x.remote.host + '/' + x.remote.slug : L('无远程')}`).join('\n');
  if (!r) return u?.repos?.length ? `<span class="t-repo" title="${esc(all)}">${L('{0} 个仓库', u.repos.length)}</span>` : '';
  const target = r.remote ? r.remote.slug : L('无远程');
  return `<span class="t-repo ${r.remote ? '' : 'warn'}" title="${esc(all)}">⎇ ${esc(target)} · ${esc(r.branch || '')}</span>`;
}

// One of our live terminals on the Agents page: status, project, load, last report; open it into the split.
/* Orders tab: what is waiting in each agent's queue, then the record of every order given. */
const ORDER_KIND = {
  sent: { label: () => L('已发送'), c: 'var(--cyan)' },
  queued: { label: () => L('已排队'), c: 'var(--amber)' },
  dispatched: { label: () => L('排队→已发出'), c: 'var(--green)' },
  removed: { label: () => L('已移除'), c: 'var(--muted)' },
};

function orderWho(agentId, name, project) {
  const live = (state.agents || []).find((a) => a.id === agentId);
  const n = live ? agentLabel(agentId).name : name || agentId.slice(0, 8);
  return `<b>${esc(n)}</b>${project && project.toLowerCase() !== String(n).toLowerCase() ? `<span class="o-proj">${esc(project)}</span>` : ''}`;
}

function ordersPage() {
  const now = Date.now();
  const waiting = (state.agents || []).filter((a) => a.alive && a.queue?.length);
  const queued = waiting.length
    ? waiting
        .map((a) => {
          const proj = (a.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
          const items = a.queue
            .map((q, i) => `<li><span class="o-n">#${i + 1}</span><span class="o-text" title="${esc(q.text)}">${esc(q.text)}</span><span class="o-time">${L('排队于 {0}', clock(q.at, now - q.at > 86_400_000))} · ${ago(now - q.at)}</span><button type="button" class="o-x" data-unqueue="${esc(a.id)}" data-index="${i}" title="${L('从队列移除')}">✕</button></li>`)
            .join('');
          return `<div class="o-group"><div class="o-head">→ ${orderWho(a.id, a.name, proj)}<span class="o-count">${L('{0} 条待发', a.queue.length)}</span><button type="button" class="o-x" data-unqueue-all="${esc(a.id)}" title="${L('清空这个 agent 的队列')}">${L('清空')}</button></div><ol>${items}</ol></div>`;
        })
        .join('')
    : `<div class="o-empty">${L('没有排队的指令。打开总指挥台的「⏱ 排队」后发出的指令会在这里等，agent 每做完一条自动发下一条。')}</div>`;
  const log = state.orders || [];
  const rows = log.length
    ? log
        .map((o) => {
          const k = ORDER_KIND[o.kind] || ORDER_KIND.sent;
          const waited = o.kind === 'dispatched' && o.queuedAt ? L('（排队 {0}）', waitText(o.at - o.queuedAt)) : '';
          return `<div class="o-row" style="--oc:${k.c}"><span class="o-time">${clock(o.at, now - o.at > 86_400_000)}</span><span class="o-kind">${k.label()}${waited}</span><span class="o-who">→ ${orderWho(o.agentId, o.name, o.project)}${o.via === 'phone' ? `<span class="o-via">${L('手机')}</span>` : o.via === 'master' ? `<span class="o-via">${L('主控')}</span>` : ''}</span><span class="o-text" title="${esc(o.text)}">${esc(o.text)}</span></div>`;
        })
        .join('')
    : `<div class="o-empty">${L('还没有指令记录。')}</div>`;
  return `<div class="orders"><section><div class="archive-head"><span class="mono">QUEUE</span><span>${L('排队中 · {0} 条', waiting.reduce((n, a) => n + a.queue.length, 0))}</span></div>${queued}</section>
    <section><div class="archive-head"><span class="mono">LOG</span><span>${L('指令记录 · 最近 {0} 条', log.length)}</span></div>${rows}</section></div>`;
}

function waitText(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return L('不到 1 分钟');
  if (m < 60) return L('{0} 分钟', m);
  return L('{0} 小时 {1} 分', Math.floor(m / 60), m % 60);
}

function agentRow(a) {
  const u = state.units.find((x) => x.agentId === a.id);
  const [code, c] = u?.permission ? ['PERMIT', 'var(--red)'] : u?.status === 'busy' ? ['ENGAGED', 'var(--cyan)'] : u ? ['AWAITING', 'var(--amber)'] : ['BOOT', 'var(--muted)'];
  const st = u?.permission ? L('等你授权') : u?.status === 'busy' ? L('作战中') : u ? L('待命') : L('启动中');
  const text = u?.permission ? L('请求授权：') + (u.permission.message || '') : u?.status === 'busy' && u.lastPrompt ? L('执行中：') + u.lastPrompt : u?.lastText || L('（还没有汇报）');
  const pct = u?.contextPct == null ? '--' : Math.round(u.contextPct) + '%';
  const open = panes.has(a.id);
  return `<article class="quest agent-row ${open ? 'open' : ''}" style="--qc:${c}">
    <span class="lv">◆</span>
    <div class="body"><span class="type">${code} · ${esc(st)} · ${esc((u?.project || a.cwd.split(/[\\/]/).pop() || '').toUpperCase())}</span>
      <span class="title">${esc(agentLabel(a.id).name)}</span><span class="goal" title="${esc(text)}">${esc(text)}</span></div>
    <div class="side"><span class="mono">LOAD ${pct}</span><div>
      ${open ? `<span class="opened">${L('已在分屏')}</span>` : ''}<button class="btn ${open ? 'ghost' : ''}" data-term="${esc(a.id)}">${open ? L('切过去') : L('▶ 打开')}</button></div></div>
  </article>`;
}


// The search term highlighted in an escaped snippet.
function mark(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

function archiveRow(h) {
  const now = Date.now();
  const action = h.owned
    ? `<button class="btn" data-term="${esc(h.agentId)}">${L('▶ 终端')}</button>`
    : h.pid
      ? `<button class="btn" data-focus="${h.pid}" title="${L('正在外部终端里运行')}">▶ ${L('跳过去')}</button>`
      : `<div class="save-actions"><button class="btn" data-takeover="${esc(h.sessionId)}" title="${L('在指挥中心里继续，可以直接下指令')}">${L('▶ 在此继续')}</button>
         <button class="btn ghost" data-resume="${esc(h.sessionId)}" title="${L('在新的 Windows Terminal 里继续')}">${L('外部终端')}</button></div>`;
  return `<article class="save ${h.pid ? 'live' : ''}">
    <div class="when"><span class="mono">${clock(h.updatedAt, true)}</span><small>${ago(now - h.updatedAt)}</small></div>
    <div class="info">
      <div class="r1"><b>${esc(h.project.toUpperCase())}</b>${h.pid ? `<span class="running">${L('运行中')}</span>` : ''}<span class="title">${esc(h.title || h.lastPrompt)}</span></div>
      ${h.snippets
        ? h.snippets.slice(0, 2).map((s) => `<div class="hit" title="${esc(s.text)}"><i>${s.role === 'user' ? 'YOU' : 'CLAUDE'}</i>${mark(s.text, ui.search.q)}</div>`).join('')
        : `<div class="prompt" title="${esc(h.lastPrompt)}">${h.lastPrompt ? L('最后指令：') + esc(h.lastPrompt) : ''}</div>
      <div class="path">${esc(h.cwd)}</div>`}
    </div>
    ${action}
  </article>`;
}

// Sessions grouped by working folder, most recently active folder first.
function folders() {
  const map = new Map();
  for (const h of state.history || []) {
    const key = h.cwd.toLowerCase();
    if (!map.has(key)) map.set(key, { key, cwd: h.cwd, project: h.project, sessions: [] });
    map.get(key).sessions.push(h); // history is already newest-first
  }
  return [...map.values()].map((f) => ({ ...f, latest: f.sessions[0].updatedAt, running: f.sessions.filter((s) => s.pid).length }));
}

function currentFolder(list = folders()) {
  return list.find((f) => f.key === ui.folder) || list[0] || null;
}

// What the current tab pages through; Units falls back to the archive when nothing is running.
function currentList() {
  // units: live sessions first, then every other project's latest session (newest first)
  const units = [...state.units, ...(state.offline || [])];
  if (ui.tab === 'archive' && ui.search) {
    const byId = new Map((state.history || []).map((h) => [h.sessionId, h]));
    return { kind: 'archive', list: (ui.search.results || []).filter((r) => byId.has(r.sessionId)).map((r) => ({ ...byId.get(r.sessionId), ...r })) };
  }
  if (ui.tab === 'archive' || (ui.tab === 'units' && !units.length)) return { kind: 'archive', list: currentFolder()?.sessions || [] };
  if (ui.tab === 'units') return { kind: 'units', list: units };
  if (ui.tab === 'orders') return { kind: 'orders', list: [] }; // one scrolling page, no paging
  return { kind: ui.tab, list: { units: state.units, agents: liveAgents() }[ui.tab] };
}

function folderList(list, sel) {
  const now = Date.now();
  return list
    .map((f) => `<button class="folder ${f.key === sel?.key ? 'on' : ''}" data-folder="${esc(f.key)}" title="${esc(f.cwd)}">
      <span class="fname">${esc(f.project)}</span>${f.running ? `<span class="running">${L('{0} 运行中', f.running)}</span>` : ''}
      <span class="fmeta">${L('{0} 个会话 · {1}', f.sessions.length, ago(now - f.latest))}</span></button>`)
    .join('');
}

function moveFolder(d) {
  const list = folders();
  const i = Math.max(0, list.findIndex((f) => f.key === currentFolder(list)?.key));
  const next = list[Math.min(list.length - 1, Math.max(0, i + d))];
  if (!next) return;
  ui.folder = next.key;
  ui.page = 0;
  renderPage();
  document.querySelector('.folder.on')?.scrollIntoView({ block: 'nearest' });
}

// A card's repo list that doesn't fit scrolls inside the card; a fade at the bottom says there is more.
function markRepoScroll(r) {
  r.classList.toggle('more-below', r.scrollHeight - r.scrollTop - r.clientHeight > 2);
}
document.addEventListener('scroll', (e) => e.target.classList?.contains('repos') && markRepoScroll(e.target), true);

function renderPage() {
  const { kind, list } = currentList();
  const size = pageSize(kind);
  const total = Math.max(1, Math.ceil(list.length / size));
  ui.page = Math.min(ui.page, total - 1);
  const items = list.slice(ui.page * size, ui.page * size + size);

  let html;
  if (kind === 'archive') {
    const fl = folders();
    const sel = currentFolder(fl);
    const scroll = document.querySelector('.folders')?.scrollTop || 0;
    html = `<div class="archive">
      <nav class="folders" aria-label="${L('项目文件夹')}"><div class="archive-head"><span class="mono">FOLDERS</span><span>${L('{0} 个 · ↑↓ 切换', fl.length)}</span></div>${folderList(fl, sel)}</nav>
      <div class="saves"><div class="archive-head">${
        ui.search && ui.tab === 'archive'
          ? `<span class="mono">SEARCH</span><span>${ui.search.results ? L('「{0}」：{1} 个会话', esc(ui.search.q), list.length) : L('搜索中…')}</span>`
          : `<span class="mono">SAVE DATA</span><span>${ui.tab === 'units' ? L('没有活动的会话 · ') : ''}${esc(sel?.cwd || '')}${L(' · {0} 个', list.length)}</span>`
      }</div>
      ${items.map(archiveRow).join('') || `<div class="blank">${L('没有找到会话')}</div>`}</div></div>`;
    $('page').innerHTML = html;
    document.querySelector('.folders').scrollTop = scroll; // keep the folder list where it was across live refreshes
  }
  else if (ui.tab === 'units') html = `<div class="units" style="grid-template-columns: repeat(${size}, minmax(0, 1fr))">${items.map(unitCard).join('')}</div>`;
  else if (ui.tab === 'agents')
    html = items.length
      ? `<div class="quests"><div class="agents-head"><span>${L('{0} 个活动终端 · {1} 个已在分屏', list.length, list.filter((a) => panes.has(a.id)).length)}</span><span class="agents-acts"><button class="btn danger" data-end-all title="${L('结束所有我方终端（会话记录保留）')}">${L('■ 全部结束')}</button><button class="btn" data-open-all>${L('⧉ 全部打开')}</button></span></div>${items.map(agentRow).join('')}</div>`
      : `<div class="blank">${L('还没有我方终端。点「＋ 出击」，或在部队页的卡片上点「▶ 出击」。')}</div>`;
  else if (ui.tab === 'orders') html = ordersPage();
  if (kind !== 'archive') {
    const keep = kind === 'orders' ? document.querySelector('.orders')?.scrollTop || 0 : 0;
    const repoScroll = new Map([...document.querySelectorAll('.unit[data-unit] .repos')].map((r) => [r.closest('.unit').dataset.unit, r.scrollTop]));
    $('page').innerHTML = html;
    if (keep) document.querySelector('.orders').scrollTop = keep; // live refreshes keep the scroll position
    for (const r of document.querySelectorAll('.unit[data-unit] .repos')) {
      r.scrollTop = repoScroll.get(r.closest('.unit').dataset.unit) || 0;
      markRepoScroll(r);
    }
  }

  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab)));
  $('n-units').textContent = state.units.length;
  $('n-agents').textContent = liveAgents().length;
  $('n-archive').textContent = (state.history || []).length;
  $('n-orders').textContent = (state.agents || []).reduce((n, a) => n + (a.alive ? a.queue?.length || 0 : 0), 0);
  const busy = state.units.filter((u) => u.status === 'busy').length;
  $('summary').textContent = L('◆ 作战 {0}　◆ 待命 {1}', busy, state.units.length - busy);
  $('dots').innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i === ui.page ? 'on' : ''}"></i>`).join('') + `<span>${pad(ui.page + 1)} / ${pad(total)}</span>`;
  $('prev').disabled = ui.page === 0;
  $('next').disabled = ui.page >= total - 1;
}

function render() {
  if (!state) return;
  renderEnergy();
  renderOperator();
  renderMaster();
  renderConsole();
  renderPage();
  renderTermHeads();
  $('deploy-open').disabled = !state.agentSupport?.ok;
  $('deploy-open').title = state.agentSupport?.ok ? L('在指挥中心里启动一个新的 Claude Code（N）') : state.agentSupport?.error || '';
  tick();
}

/* ---------- master console ---------- */

// The left column is either the master (a Claude Code terminal that commands the other agents through
// the fleet tools) or the classic input box. The master's terminal stays connected while hidden.
let opMode = localStorage.getItem('fb-op-mode') === 'input' ? 'input' : 'master';
let masterTerm = null;

function renderMaster() {
  $('operator').classList.toggle('master-mode', opMode === 'master');
  document.querySelectorAll('[data-opmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.opmode === opMode)));
  $('master').hidden = opMode !== 'master';
  const m = state.master || {};
  const alive = Boolean(m.alive && m.id);
  $('master-off').hidden = alive;
  $('master-term').hidden = !alive;
  $('master-st').textContent = alive ? L('● 主控在线') : L('● 主控未启动');
  $('master-st').classList.toggle('on', alive);
  $('master-new').disabled = $('master-stop').disabled = $('master-voice').disabled = !alive;
  $('master-start').disabled = !state.agentSupport?.ok;
  if (alive && masterTerm?.id !== m.id) {
    masterTerm?.dispose();
    masterTerm = createTerminal($('master-term'), m.id, { fontSize: 12, onInput: mentionInput });
  } else if (!alive && masterTerm) {
    masterTerm.dispose();
    masterTerm = null;
  }
}

// # in the master: a picker of the running terminals (type to filter, ↑↓, Enter / Tab to pick).
// (# rather than @: Claude Code's own @ references files, so @ goes straight through to it.)
// The pick goes in as "@name " for the master to read; Esc types a plain @ instead (Claude Code's file mention).
const mention = { open: false, q: '', index: 0, items: [] };

function mentionAll() {
  const units = new Map((state?.units || []).filter((u) => u.agentId).map((u) => [u.agentId, u]));
  const hs = new Map(handles().map((h) => [h.id, h.handle]));
  const live = (state?.agents || []).filter((a) => a.alive);
  const items = live.map((a) => {
    const u = units.get(a.id);
    const shell = a.kind === 'shell';
    const st = shell ? L('终端') : !u ? L('启动中') : u.permission ? L('等你授权') : u.status === 'busy' ? L('作战中') : L('待命');
    const c = shell ? 'var(--soft)' : u?.permission ? 'var(--red)' : u?.status === 'busy' ? 'var(--cyan)' : 'var(--amber)';
    const handle = hs.get(a.id) || agentLabel(a.id).name.toLowerCase().replace(/\s+/g, '-') + (shell ? '-' + a.id.slice(0, 4) : '');
    return { handle, st, c, sub: a.cwd, busy: u?.status === 'busy' || Boolean(u?.permission) };
  });
  items.sort((a, b) => Number(b.busy) - Number(a.busy)); // working ones first
  if (items.length > 1) items.unshift({ handle: 'all', st: L('全部'), c: 'var(--green)', sub: L('所有我方 agent（{0}）', live.filter((a) => a.kind !== 'shell').length) });
  return items;
}

function renderMention() {
  const q = mention.q.toLowerCase();
  mention.items = mentionAll().filter((h) => !q || h.handle.includes(q) || h.sub.toLowerCase().includes(q));
  mention.index = Math.min(mention.index, Math.max(0, mention.items.length - 1));
  $('master-mention').innerHTML =
    `<div class="mn-head">#${esc(mention.q)}<span>${L('↑↓ 选择 · Enter 确定 · Esc 普通 #')}</span></div>` +
    (mention.items.length
      ? mention.items.map((h, i) => `<div class="sg ${i === mention.index ? 'on' : ''}" role="option" data-i="${i}"><b>#${esc(h.handle)}<i style="color:${h.c}">● ${esc(h.st)}</i></b><small>${esc(h.sub)}</small></div>`).join('')
      : `<div class="mn-none">${L('没有匹配的终端')}</div>`);
  $('master-mention').hidden = false;
  $('master-mention').querySelector('.sg.on')?.scrollIntoView({ block: 'nearest' });
}

function closeMention(typed = '') {
  mention.open = false;
  $('master-mention').hidden = true;
  if (typed) masterTerm?.send(typed);
}

function pickMention(i) {
  const h = mention.items[i];
  closeMention();
  if (h) masterTerm?.paste(`#${h.handle} `);
  masterTerm?.focus();
}

/** Keystrokes of the master's terminal; false keeps one from reaching Claude Code. */
function mentionInput(data) {
  if (!mention.open) {
    if (data !== '#' && data !== '＃') return true;
    if (!mentionAll().length) return true; // nothing running: a plain @
    Object.assign(mention, { open: true, q: '', index: 0 });
    renderMention();
    return false;
  }
  const raw = '#' + mention.q;
  if (data === '\x1b[A' || data === '\x1b[B') {
    const n = mention.items.length || 1;
    mention.index = (mention.index + (data === '\x1b[A' ? n - 1 : 1)) % n;
    renderMention();
  } else if (data === '\r' || data === '\t') {
    if (mention.items.length) pickMention(mention.index);
    else closeMention(raw + (data === '\t' ? '' : data));
  } else if (data === '\x1b') closeMention(raw);
  else if (data === '\x7f' || data === '\b') {
    if (!mention.q) closeMention();
    else {
      mention.q = mention.q.slice(0, -1);
      renderMention();
    }
  } else if (/^[^\x00-\x20\x7f]+$/.test(data) && !/[#＃]/.test(data)) {
    mention.q += data;
    mention.index = 0;
    renderMention();
  } else closeMention(raw + data); // space, other keys: it was a plain @
  return false;
}

$('master-mention').addEventListener('mousedown', (e) => {
  const el = e.target.closest('[data-i]');
  if (!el) return;
  e.preventDefault();
  pickMention(Number(el.dataset.i));
});
$('master-term').addEventListener('focusout', () => setTimeout(() => mention.open && !$('master-term').contains(document.activeElement) && closeMention(), 150));

async function masterDo(action) {
  const r = await post('/api/master', { action });
  if (r.error) return toast(r.error);
  if (action !== 'stop') setTimeout(() => masterTerm?.focus(), 400);
}

document.querySelectorAll('[data-opmode]').forEach((b) =>
  b.addEventListener('click', () => {
    opMode = b.dataset.opmode;
    localStorage.setItem('fb-op-mode', opMode);
    if (state) renderMaster();
    if (opMode === 'master') masterTerm?.focus();
    else $('cmd-text').focus();
  }),
);
$('master-start').addEventListener('click', () => masterDo('start'));
$('master-new').addEventListener('click', async () => {
  if (await ask({ title: L('开一个新的主控会话？'), message: L('当前对话会结束，主控从头开始。'), ok: L('新会话') })) masterDo('new');
});
$('master-stop').addEventListener('click', async () => {
  if (await ask({ danger: true, title: L('结束主控？'), message: L('之后点「启动主控」会接着这次的对话。'), ok: L('结束') })) masterDo('stop');
});
$('master-voice').addEventListener('click', () => voiceInto(() => masterTerm?.focus()));

/* ---------- actions ---------- */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

async function focus(pid) {
  // our own agents live in the terminal panel, not in an outside window
  const u = state.units.find((x) => x.pid === Number(pid));
  if (u?.owned) return openTerm(u.agentId);
  const r = await post('/api/focus', { pid: Number(pid) });
  toast(r.ok ? L('已切到 {0} 窗口', r.window) : L('没找到这个会话的终端窗口'));
}

/* ---------- agents launched by the command center ---------- */

function agentLabel(id) {
  const a = (state?.agents || []).find((x) => x.id === id);
  const u = state?.units.find((x) => x.agentId === id);
  const h = (state?.history || []).find((x) => x.sessionId === id);
  return { a, name: a?.name || u?.name || h?.title || id.slice(0, 8), cwd: a?.cwd || u?.cwd || h?.cwd || '' };
}

/* Split view: up to 4 agent terminals side by side; ⧉ pops one out into its own window. */
const MAX_PANES = 4;
const panes = new Map(); // agent id -> { el, t }

const PANE_ACTIONS = `
  <button data-tact="voice" class="voice-btn" title="${L('语音输入：对这个终端说话（Windows 语音输入，Win+H）')}" aria-label="${L('语音输入')}" hidden><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
  <button data-tkey="esc" title="${L('打断当前操作')}">Esc</button>
  <button data-tact="pop" title="${L('弹出成独立窗口')}">⧉</button>
  <button data-tact="kill" class="danger" title="${L('结束这个 Claude 进程')}">${L('结束')}</button>
  <button data-tact="remove" class="ghost" hidden>${L('移除')}</button>
  <button data-tact="close" title="${L('收起这个终端（agent 继续运行）')}" aria-label="${L('收起这个终端')}">✕</button>`;

const SHELL_BTN = `<button data-add-shell class="shell-btn" title="${L('打开一个普通的 PowerShell 终端，目录是当前终端的项目')}">${L('＞_ 终端')}</button>`;

function renderTermHeads() {
  for (const [id, { el }] of panes) {
    const { a, name, cwd } = agentLabel(id);
    const alive = a?.alive;
    // the project folder tells panes apart when callsigns don't (alpha, bravo…);
    // without a callsign (name is just the id) the project is the name
    const proj = cwd.split(/[\\/]/).filter(Boolean).pop() || '';
    const bare = name === id.slice(0, 8);
    el.querySelector('.t-name').textContent = bare && proj ? proj : name;
    el.querySelector('.t-proj').textContent = !bare && proj && proj.toLowerCase() !== name.toLowerCase() ? proj : '';
    el.querySelector('.term-who').title = `${name}${proj ? ' · ' + proj : ''}\n${cwd}`;
    el.querySelector('.t-cwd').textContent = cwd;
    const st = el.querySelector('.t-state');
    const u = state?.units.find((x) => x.agentId === id);
    const [label, cls] = !alive
      ? [a?.exitCode != null ? L('● 已退出（{0}）', a.exitCode) : L('● 已退出'), 'off']
      : a?.kind === 'shell' ? [L('● 终端'), 'on'] : u?.permission ? [L('● 等你授权'), 'permit'] : u?.status === 'busy' ? [L('● 作战中'), 'busy'] : [L('● 待命'), 'on'];
    st.textContent = label;
    st.className = 't-state ' + cls;
    el.querySelector('.t-ctx').innerHTML = ctxBadge(u) + repoBadge(u);
    el.querySelectorAll('[data-tkey], [data-tcmd], [data-tact=kill], [data-tact=pop]').forEach((b) => (b.disabled = !alive));
    el.querySelector('[data-tact=remove]').hidden = alive !== false;
  }
  $('term-count').textContent = `${panes.size} / ${MAX_PANES}`;

  // Our other agents, one click away from joining the split view (the panel hides the unit cards).
  const others = (state?.agents || []).filter((a) => a.alive && !panes.has(a.id));
  const html = others.length
    ? others.map((a) => `<button data-add="${esc(a.id)}" title="${esc(a.cwd)}">＋ ${esc(agentLabel(a.id).name)}</button>`).join('') + `<button data-add-new title="${L('启动新的 Claude（N）')}">${L('＋ 出击')}</button>${SHELL_BTN}`
    : `<span class="hint">${L('没有其他我方 agent · ')}</span><button data-add-new>${L('＋ 出击')}</button>${SHELL_BTN}`;
  if (renderTermHeads.last !== html) $('term-add').innerHTML = renderTermHeads.last = html;
}

// Context load of one agent, for its terminal title bar: mini bar + percent + tokens.
function ctxBadge(u) {
  if (u?.contextPct == null) return '';
  const pct = Math.round(u.contextPct);
  const hot = pct >= state.thresholds.contextWarnPct;
  const color = hot ? 'var(--red)' : 'var(--cyan)';
  return `<span class="ctx-badge" style="--cc:${color}" title="${L('记忆负载 {0}%：{1} / {2} tokens', pct, (u.contextTokens || 0).toLocaleString(), (u.contextWindow || 0).toLocaleString())}${hot ? L('，建议 /compact') : ''}">
    <i style="width:${Math.min(100, pct)}%"></i></span><span class="ctx-num" style="color:${color}">${pct}% · ${kTokens(u.contextTokens)}</span>`;
}

function setActivePane(id) {
  const changed = ui.term !== id;
  ui.term = id;
  for (const [pid, { el }] of panes) el.classList.toggle('active', pid === id);
  if (changed) layoutPanes(); // the dynamic split follows the active pane
}

// Dynamic split: the active pane fills the main area (3/4 wide, full height) and the others
// stack in a narrow column on its right. Off: equal sizes.
let dynamicSplit = true;
try {
  dynamicSplit = localStorage.getItem('fb-dynamic-split') !== '0';
} catch {
  // storage unavailable: default on
}

function layoutPanes() {
  const grid = $('term-grid');
  const ids = [...panes.keys()];
  const n = ids.length;
  grid.dataset.n = String(n);
  grid.classList.toggle('dynamic', dynamicSplit && n > 1);
  const act = dynamicSplit && n > 1 ? ids.indexOf(ui.term) : -1;
  if (act < 0) {
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    for (const { el } of panes.values()) el.style.gridArea = '';
  } else {
    // the active one on the left; the others stack top to bottom in a narrow right column
    grid.style.gridTemplateColumns = 'minmax(0, 3fr) minmax(0, 1fr)';
    grid.style.gridTemplateRows = `repeat(${n - 1}, minmax(0, 1fr))`;
    let row = 1;
    for (const [id, { el }] of panes) el.style.gridArea = id === ui.term ? '1 / 1 / -1 / 2' : `${row++} / 2 / ${row} / 3`;
  }
  // the big pane gets a normal font, small ones a smaller one to keep enough columns
  for (const [id, { t }] of panes) t.setFontSize(n === 1 ? 13 : act >= 0 && id === ui.term ? 13 : act >= 0 ? 11 : 12);
  $('term-dyn').setAttribute('aria-pressed', String(dynamicSplit));
  // the label names the current mode, so an accidental click is easy to spot
  $('term-dyn').textContent = dynamicSplit ? L('⇔ 动态') : L('▦ 等分');
  $('term-dyn').title = dynamicSplit ? L('动态分屏：当前 / 刚收到指令的终端变大，其他变小') : L('等分：所有终端一样大。点击切回动态分屏');
}

function setDynamicSplit(on) {
  dynamicSplit = on;
  try {
    localStorage.setItem('fb-dynamic-split', on ? '1' : '0');
  } catch {
    // not persisted
  }
  layoutPanes();
}

// Flash the panes that just received a command; a single recipient also becomes the active, big one.
function spotlight(ids) {
  const open = ids.filter((id) => panes.has(id));
  if (open.length === 1) setActivePane(open[0]);
  for (const id of open) {
    const el = panes.get(id).el;
    el.classList.remove('hit');
    void el.offsetWidth; // restart the animation
    el.classList.add('hit');
  }
}

function openTerm(id) {
  $('term-panel').hidden = false;
  if (panes.has(id)) {
    setActivePane(id);
    panes.get(id).t.focus();
    return;
  }
  // full: the new one replaces the active pane
  if (panes.size >= MAX_PANES) closePane(panes.has(ui.term) ? ui.term : panes.keys().next().value);
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.pane = id;
  el.innerHTML = `<header class="term-head"><div class="term-who"><b class="t-name"></b><span class="t-proj"></span><span class="t-state"></span><span class="t-ctx"></span><span class="term-cwd t-cwd"></span></div><div class="term-actions">${PANE_ACTIONS}</div></header><div class="term-host"></div>`;
  $('term-grid').appendChild(el);
  const t = createTerminal(el.querySelector('.term-host'), id, { fontSize: panes.size ? 12 : 13, onFocus: () => setActivePane(id) });
  panes.set(id, { el, t });
  layoutPanes();
  setActivePane(id);
  renderTermHeads();
  t.focus();
}

function closePane(id) {
  const p = panes.get(id);
  if (!p) return;
  p.t.dispose();
  p.el.remove();
  panes.delete(id);
  if (ui.term === id) ui.term = panes.keys().next().value ?? null;
  if (!panes.size) $('term-panel').hidden = true;
  layoutPanes();
  setActivePane(ui.term);
  renderTermHeads();
}

function closeAllPanes() {
  for (const id of [...panes.keys()]) closePane(id);
}

function popOut(id) {
  window.open(`/term#${id}`, `claude-ops-term-${id}`, 'width=1100,height=720');
  closePane(id);
}

async function agentAction(body) {
  const r = await post('/api/agents/action', body);
  if (!r.ok) toast(L('操作没有生效：这个 agent 可能已经退出'));
  return r;
}

async function takeover(sessionId) {
  const r = await post('/api/agents', { resume: sessionId });
  if (!r.ok) return toast(L('接管失败：') + r.error);
  toast(L('已在指挥中心里继续这个会话'));
  openTerm(r.id);
}

function openDeploy() {
  if (state && !state.agentSupport?.ok) return toast(state.agentSupport?.error || L('无法启动 agent'));
  const cwds = new Map();
  for (const u of state?.units || []) cwds.set(u.cwd.toLowerCase(), u.cwd);
  for (const h of state?.history || []) cwds.set(h.cwd.toLowerCase(), h.cwd);
  $('dp-folders').innerHTML = [...cwds.values()].map((c) => `<option value="${esc(c)}"></option>`).join('');
  $('dp-err').textContent = '';
  $('deploy-form').reset();
  updateDeployMode();
  $('deploy').showModal();
  $('dp-cwd').focus();
}

// The newest session of the folder typed in the deploy dialog; deploying continues it by default.
function latestSessionIn(cwd) {
  const key = cwd.trim().replace(/[\\/]+$/, '').toLowerCase();
  if (!key) return null;
  return (state?.history || []).find((h) => h.cwd.replace(/[\\/]+$/, '').toLowerCase() === key) || null; // history is newest-first
}

function updateDeployMode() {
  const s = latestSessionIn($('dp-cwd').value);
  const resumable = s && !s.pid; // a session running in an outside terminal can't be taken over
  $('dp-mode').hidden = !s || (Boolean(s.pid) && !s.owned);
  $('dp-note').textContent = s?.pid && !s.owned ? L('这个文件夹最新的会话正在外部终端运行，将开新会话。') : '';
  if (s && (resumable || s.owned)) {
    const title = (s.title || s.lastPrompt || s.sessionId.slice(0, 8)).slice(0, 36);
    $('dp-latest').textContent = L('{0}最新会话：{1} · {2}', s.owned ? L('打开') : L('继续'), title, ago(Date.now() - s.updatedAt));
  }
  $('dp-name').disabled = Boolean(s && (resumable || s.owned) && $('deploy-form').elements['dp-mode'].value === 'resume');
}

$('dp-cwd').addEventListener('input', () => {
  $('deploy-form').elements['dp-mode'].value = 'resume'; // a new folder starts back at "continue latest"
  updateDeployMode();
});
$('dp-mode').addEventListener('change', updateDeployMode);
$('deploy-open').addEventListener('click', openDeploy);
$('shell-open').addEventListener('click', openShell);
$('dp-cancel').addEventListener('click', () => $('deploy').close());
$('deploy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('dp-go').disabled = true;
  try {
    const s = latestSessionIn($('dp-cwd').value);
    const wantResume = s && !$('dp-mode').hidden && $('deploy-form').elements['dp-mode'].value === 'resume';
    const prompt = $('dp-prompt').value.trim();
    if (wantResume && s.owned) {
      // already one of ours: just bring it up (and pass on the first command, if any)
      $('deploy').close();
      openTerm(s.agentId);
      if (prompt) await agentAction({ id: s.agentId, action: 'text', text: prompt });
      return;
    }
    const body = wantResume ? { resume: s.sessionId, prompt } : { cwd: $('dp-cwd').value, name: $('dp-name').value, prompt };
    const r = await post('/api/agents', body);
    if (!r.ok) {
      $('dp-err').textContent = r.error || L('启动失败');
      return;
    }
    $('deploy').close();
    toast(wantResume ? L('部队归队，继续最新会话') : L('部队出击！'));
    openTerm(r.id);
  } finally {
    $('dp-go').disabled = false;
  }
});

$('term-close-all').addEventListener('click', closeAllPanes);
$('term-dyn').addEventListener('click', () => setDynamicSplit(!dynamicSplit));
$('term-add').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add) openTerm(b.dataset.add);
  else if ('addNew' in b.dataset) openDeploy();
  else if ('addShell' in b.dataset) openShell();
});
$('term-grid').addEventListener('click', async (e) => {
  const pane = e.target.closest('.pane');
  if (!pane) return;
  const id = pane.dataset.pane;
  setActivePane(id);
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tkey) await agentAction({ id, action: 'key', key: b.dataset.tkey });
  else if (b.dataset.tcmd) await agentAction({ id, action: 'text', text: b.dataset.tcmd });
  else if (b.dataset.tact === 'kill') {
    const yes = await ask({ danger: true, title: L('结束「{0}」？', agentLabel(id).name), message: isShell(id) ? L('这个终端会关闭。') : L('进程会退出，会话记录保留，可以从存档继续。'), ok: L('结束') });
    if (!yes) return;
    await agentAction({ id, action: 'kill' });
  } else if (b.dataset.tact === 'remove') {
    await agentAction({ id, action: 'remove' });
    return closePane(id);
  } else if (b.dataset.tact === 'pop') return popOut(id);
  else if (b.dataset.tact === 'voice') return voiceInto(() => panes.get(id)?.t.focus());
  else if (b.dataset.tact === 'close') return closePane(id);
  else return;
  panes.get(id)?.t.focus();
});

async function resume(sessionId) {
  const r = await post('/api/resume', { sessionId });
  if (r.focused) toast(r.ok ? L('已经在运行，切到 {0} 窗口', r.window) : L('这个会话在运行，但没找到它的终端窗口'));
  else toast(r.ok ? L('已在 {0} 里打开，部队即将上线', r.terminal) : L('打开失败：') + r.error);
}

async function snoozeLine(key, minutes = 30) {
  await post('/api/snooze', { key, minutes });
  toast(L('{0} 分钟后再提醒', minutes));
}

function setTab(tab) {
  ui.tab = tab;
  ui.page = 0;
  renderPage();
}

function turn(d) {
  const { kind, list } = currentList();
  const size = pageSize(kind);
  const len = list.length;
  const next = ui.page + d;
  if (next < 0 || next * size >= Math.max(len, 1)) return;
  ui.page = next;
  renderPage();
}

function nextLine() {
  const n = state.operator.lines.length;
  if (n < 2) return;
  ui.line = (ui.line + 1) % n;
  ui.lineKey = state.operator.lines[ui.line].key;
  renderOperator();
  document.querySelector('.msg.on')?.scrollIntoView({ block: 'nearest' });
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('prev').addEventListener('click', () => turn(-1));
$('next').addEventListener('click', () => turn(1));
$('refresh').addEventListener('click', async () => {
  toast(L('正在刷新…'));
  await post('/api/refresh');
  toast(L('已刷新'));
});
$('page').addEventListener('click', (e) => {
  // Orders tab: take one order, or a whole queue, off
  const uq = e.target.closest('[data-unqueue]');
  if (uq) return post('/api/agents/action', { id: uq.dataset.unqueue, action: 'unqueue', index: Number(uq.dataset.index) });
  const ua = e.target.closest('[data-unqueue-all]');
  if (ua) {
    const id = ua.dataset.unqueueAll;
    return ask({ danger: true, title: L('清空「{0}」的队列？', agentLabel(id).name), message: L('排队中的指令都不会再发出，记录里会标为已移除。'), ok: L('清空') }).then((yes) => yes && post('/api/agents/action', { id, action: 'unqueue' }));
  }
  // end every terminal of ours, after a confirmation; sessions stay and can be continued later
  if (e.target.closest('[data-end-all]')) {
    const live = liveAgents();
    if (!live.length) return;
    return ask({
      danger: true,
      title: L('结束全部 {0} 个终端？', live.length),
      message: L('这些 agent 的进程会退出。会话记录保留，之后可以在部队页或存档里接着用。'),
      detail: live.map((a) => '◆ ' + agentLabel(a.id).name),
      ok: L('全部结束'),
    }).then(async (yes) => {
      if (!yes) return;
      closeAllPanes();
      const r = await post('/api/agents/action', { id: live.map((a) => a.id), action: 'kill' });
      toast(L('已结束 {0} 个终端', (r.results || []).filter(Boolean).length));
    });
  }
  if (e.target.closest('[data-open-all]')) {
    const ids = liveAgents().map((a) => a.id);
    for (const id of ids.slice(0, MAX_PANES)) openTerm(id);
    if (ids.length > MAX_PANES) toast(L('分屏最多 {0} 个，已打开前 {0} 个', MAX_PANES));
    return renderPage();
  }
  const rv = e.target.closest('[data-review]');
  if (rv) return openReview(rv.dataset.review);
  const fo = e.target.closest('[data-folder]');
  if (fo) {
    if (ui.search) clearSearch(false);
    ui.folder = fo.dataset.folder;
    ui.page = 0;
    renderPage();
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) focus(f.dataset.focus);
  const s = e.target.closest('[data-snooze]');
  if (s) snoozeLine(s.dataset.snooze);
  const r = e.target.closest('[data-resume]');
  if (r) resume(r.dataset.resume);
  const t = e.target.closest('[data-term]');
  if (t) openTerm(t.dataset.term);
  const tk = e.target.closest('[data-takeover]');
  if (tk) takeover(tk.dataset.takeover);
});
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey || !state) return;
  const k = e.key.toLowerCase();
  // typing (incl. inside the xterm, which uses a textarea) or a dialog: not shortcuts
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || document.querySelector('dialog[open]')) return;
  if (k === 'escape' && panes.size) {
    closeAllPanes();
    e.preventDefault();
    return;
  }
  if (k === 'n') {
    openDeploy();
    e.preventDefault();
    return;
  }
  const archive = currentList().kind === 'archive';
  if (archive && (k === 'arrowup' || k === 'arrowdown')) moveFolder(k === 'arrowup' ? -1 : 1);
  else if (k === 'q') setTab(TABS[(TABS.indexOf(ui.tab) + TABS.length - 1) % TABS.length]);
  else if (k === 'e') setTab(TABS[(TABS.indexOf(ui.tab) + 1) % TABS.length]);
  else if (k === 'arrowleft') turn(-1);
  else if (k === 'arrowright') turn(1);
  else if (k === 'enter') currentLine() && goLine(ui.line);
  else if (k === ' ') nextLine();
  else if (k === 's') {
    const l = currentLine();
    if (l && !AMBIENT.has(l.key)) snoozeLine(l.key);
  } else return;
  e.preventDefault();
});

/* ---------- phone access: a QR code to pair a phone with the phone page ---------- */

async function renderPhone(info) {
  $('ph-toggle').textContent = info.enabled ? L('关闭手机访问') : L('开启手机访问');
  $('ph-regen').hidden = !info.enabled;
  $('ph-qr').innerHTML = info.qr || '';
  if (!info.qr) $('ph-qr').textContent = info.enabled ? L('找不到局域网地址') : L('手机访问');
  $('ph-tip').textContent = !info.enabled ? '' : info.running ? L('用手机相机扫码') : L('端口 {0} 没能打开，可能被占用', info.port);
  // the key stays out of the visible list: only the QR code carries it
  $('ph-urls').innerHTML =
    info.urls.map((u) => `<li><b>http://${esc(u.ip)}:${info.port}/m</b> · ${esc(u.name)}${u.tailscale ? ' · Tailscale' : ''}</li>`).join('') +
    (info.host ? `<li><b>${esc(info.host)}</b> · ${L('电脑名（IP 变了也能用，需要网络能解析）')}</li>` : '');
  $('ph-pin-box').hidden = $('ph-logout').hidden = !info.enabled;
  $('ph-pin-warn').hidden = !info.pinDefault;
  $('ph-devices').textContent = info.enabled ? L('已登录的设备：{0} 台（每台 {1} 天内不用再输 PIN）', info.devices ?? 0, info.sessionDays ?? 30) : '';
  if (info.error) toast(info.error);
}

function renderPush(info) {
  $('pu-toggle').textContent = info.enabled ? L('关闭推送') : L('开启推送');
  $('pu-test').hidden = $('pu-regen').hidden = $('pu-steps').hidden = !info.enabled;
  $('pu-qr').innerHTML = info.qr || '';
  if (!info.qr) $('pu-qr').textContent = L('推送通知');
  $('pu-topic').textContent = info.enabled ? info.topic || '' : '';
  $('pu-tip').textContent = info.enabled ? L('用手机扫码订阅') : L('开启后，等你授权、做完了、额度告急时推送到手机。');
}

$('phone-btn').addEventListener('click', async () => {
  $('phone').showModal();
  renderPhone(await fetch('/api/mobile').then((r) => r.json()));
  renderPush(await fetch('/api/push').then((r) => r.json()));
});
$('pu-toggle').addEventListener('click', async () => {
  renderPush(await post('/api/push', { enabled: $('pu-toggle').textContent === L('开启推送') }));
});
$('pu-regen').addEventListener('click', async () => {
  renderPush(await post('/api/push', { regenerate: true }));
  toast(L('已换新频道，手机上需要重新订阅'));
});
$('pu-test').addEventListener('click', async () => {
  const r = await post('/api/push/test', {});
  toast(r.ok ? L('测试通知已发出，看看手机') : L('发送失败：') + (r.error || ''));
});
$('ph-toggle').addEventListener('click', async () => {
  const on = $('ph-toggle').textContent === L('开启手机访问');
  renderPhone(await post('/api/mobile', { enabled: on }));
});
$('ph-pin-save').addEventListener('click', async () => {
  const pin = $('ph-pin').value.trim();
  if (!/^\d{4,12}$/.test(pin)) return toast(L('PIN 需要是 4 到 12 位数字'));
  const info = await post('/api/mobile', { pin });
  renderPhone(info);
  if (!info.error) {
    $('ph-pin').value = '';
    toast(L('PIN 已修改，手机需要用新 PIN 重新登录'));
  }
});
$('ph-logout').addEventListener('click', async () => {
  renderPhone(await post('/api/mobile', { logoutAll: true }));
  toast(L('所有手机都已退出登录'));
});
$('ph-regen').addEventListener('click', async () => {
  renderPhone(await post('/api/mobile', { regenerate: true }));
  toast(L('已生成新密钥'));
});

/* ---------- change review: diff, commit and push without leaving the bridge ---------- */

const review = { repo: null, files: [], file: null };

function repoByPath(p) {
  for (const u of [...state.units, ...(state.offline || [])]) for (const r of u.repos) if (r.path === p) return r;
  return null;
}

function diffHtml(text) {
  return text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('@@') ? 'hunk' : /^(diff |index |--- |\+\+\+ |new file|deleted file)/.test(l) ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return cls ? `<span class="${cls}">${esc(l) || ' '}</span>` : esc(l) + '\n';
    })
    .join('');
}

async function showDiff(f) {
  review.file = f.file;
  for (const li of $('rv-files').children) li.classList.toggle('on', li.dataset.file === f.file);
  $('rv-diff').textContent = L('读取中…');
  const r = await fetch(`/api/git/diff?repo=${encodeURIComponent(review.repo)}&file=${encodeURIComponent(f.file)}&status=${f.status}`).then((x) => x.json());
  if (review.file !== f.file) return;
  $('rv-diff').innerHTML = r.error ? esc(r.error) : diffHtml(r.diff || '') || esc(L('（没有文本差异）'));
}

const ST = { modified: ['M', 'var(--amber)'], added: ['A', 'var(--green)'], untracked: ['U', 'var(--green)'], deleted: ['D', 'var(--red)'], renamed: ['R', 'var(--cyan)'], copied: ['C', 'var(--cyan)'], conflict: ['!', 'var(--red)'] };

async function openReview(path) {
  const r = repoByPath(path);
  review.repo = path;
  $('rv-repo').textContent = r?.name || path;
  $('rv-branch').textContent = r?.branch || '';
  $('rv-remote').className = 'rv-remote' + (r?.remote ? '' : ' warn');
  $('rv-remote').innerHTML = r?.remote ? `${L('推送到')} <b>${esc(r.remote.name)}</b> ${esc(`${r.remote.host}/${r.remote.slug}`)}${r.ahead ? ` · ↑${r.ahead}` : ''}` : esc(L('没有远程仓库，只在本地'));
  $('rv-err').textContent = '';
  $('rv-files').innerHTML = '';
  $('rv-diff').textContent = L('读取中…');
  $('rv-push').hidden = !(r?.ahead > 0 && r?.remote);
  $('review').showModal();
  const res = await fetch(`/api/git/changes?repo=${encodeURIComponent(path)}`).then((x) => x.json());
  if (res.error) return ($('rv-diff').textContent = res.error);
  review.files = res.files;
  $('rv-commit').disabled = $('rv-commit-push').disabled = !res.files.length;
  $('rv-commit-push').disabled ||= !r?.remote;
  $('rv-files').innerHTML = res.files
    .map((f) => {
      const [s, c] = ST[f.status] || ST.modified;
      const n = f.ins == null ? '' : `<span class="a">+${f.ins}</span> <span class="d">−${f.del}</span>`;
      return `<li data-file="${esc(f.file)}" title="${esc(f.file)}"><span class="st" style="--sc:${c}">${s}</span><span class="fn">${esc(f.file)}</span><span class="n">${n}</span></li>`;
    })
    .join('');
  if (res.files.length) showDiff(res.files[0]);
  else $('rv-diff').textContent = L('工作区干净，没有要提交的改动。');
  $('rv-msg').focus();
}

async function doCommit(push) {
  const message = $('rv-msg').value.trim();
  if (!message) return ($('rv-err').textContent = L('先写提交说明'));
  $('rv-err').textContent = '';
  for (const b of ['rv-commit', 'rv-commit-push', 'rv-push']) $(b).disabled = true;
  const r = await post('/api/git/commit', { repo: review.repo, message, push });
  if (!r.ok) {
    $('rv-err').textContent = r.error || L('提交失败');
    for (const b of ['rv-commit', 'rv-commit-push', 'rv-push']) $(b).disabled = false;
    return;
  }
  $('rv-msg').value = '';
  $('review').close();
  toast(push ? L('已提交并推送') : L('已提交'));
}

$('rv-files').addEventListener('click', (e) => {
  const li = e.target.closest('[data-file]');
  const f = li && review.files.find((x) => x.file === li.dataset.file);
  if (f) showDiff(f);
});
$('rv-form').addEventListener('submit', (e) => {
  e.preventDefault();
  doCommit(false);
});
$('rv-commit-push').addEventListener('click', () => doCommit(true));
$('rv-push').addEventListener('click', async () => {
  $('rv-push').disabled = true;
  const r = await post('/api/git/push', { repo: review.repo });
  $('rv-push').disabled = false;
  if (!r.ok) return ($('rv-err').textContent = r.error || L('推送失败'));
  $('review').close();
  toast(L('已推送'));
});
$('rv-close').addEventListener('click', () => $('review').close());
$('rv-msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doCommit(false);
  }
});

/* ---------- full-text search over all sessions ---------- */

async function runSearch(q) {
  ui.search = { q, results: null };
  $('search-clear').hidden = false;
  setTab('archive');
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((x) => x.json());
    if (ui.search?.q !== q) return; // a newer search replaced this one
    if (r.error) throw new Error(r.error);
    ui.search.results = r.results;
  } catch (e) {
    ui.search.results = [];
    toast(L('搜索失败：') + e.message);
  }
  renderPage();
}

function clearSearch(render = true) {
  ui.search = null;
  $('search-q').value = '';
  $('search-clear').hidden = true;
  if (render) renderPage();
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (q.length < 2) return toast(L('至少输入 2 个字'));
  runSearch(q);
});
$('search-q').addEventListener('keydown', (e) => e.key === 'Escape' && clearSearch());
$('search-clear').addEventListener('click', () => clearSearch());

/* ---------- language: the globe in the top bar ---------- */

translateDom();
document.body.appendChild($('lang-menu')); // out of the top bar, whose clip-path would cut it off
function toggleLangMenu(open = $('lang-menu').hidden) {
  const r = $('lang-btn').getBoundingClientRect();
  Object.assign($('lang-menu').style, { top: `${r.bottom + 6}px`, right: `${innerWidth - r.right}px` });
  $('lang-menu').hidden = !open;
  $('lang-btn').setAttribute('aria-expanded', String(open));
}
for (const b of document.querySelectorAll('#lang-menu [data-lang]')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
$('lang-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleLangMenu();
});
$('lang-menu').addEventListener('click', (e) => {
  const next = e.target.closest('[data-lang]')?.dataset.lang;
  toggleLangMenu(false);
  if (next && next !== lang) setLang(next);
});
document.addEventListener('click', () => !$('lang-menu').hidden && toggleLangMenu(false));

/* ---------- themes ---------- */

const THEME_NOTE = { auto: '跟随系统：深色时用深空，浅色时用浅色', neon: '原版：高对比霓虹，带发光', deepspace: '柔和灰蓝，青色柔光（推荐）', tokyo: '蓝紫夜色，柔光', warm: '米白配琥珀，减少蓝光', light: '灰白浅色，白天用' };
function renderThemeMenu() {
  const cur = state?.theme || 'deepspace';
  $('theme-menu').innerHTML = THEME_KEYS.map((k) => {
    const t = THEMES[k] || THEMES.deepspace;
    const sw = k === 'auto' ? [THEMES.deepspace.ui.panel, THEMES.light.ui.panel, THEMES.deepspace.ui.accent] : [t.ui.panel, t.ui.text, t.ui.accent];
    return `<button role="menuitemradio" data-theme="${k}" aria-checked="${k === cur}" title="${esc(L(THEME_NOTE[k]))}"><span class="sw">${sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(k === 'auto' ? L('跟随系统') : L(t.name))}</button>`;
  }).join('');
}
// The header panel's clip-path (its cut corners) clips everything inside it, fixed menus included:
// the menus live on the body instead.
document.body.append($('theme-menu'), $('lang-menu'));
function toggleThemeMenu(open = $('theme-menu').hidden) {
  if (open) renderThemeMenu();
  const r = $('theme-btn').getBoundingClientRect();
  Object.assign($('theme-menu').style, { top: `${r.bottom + 6}px`, right: `${innerWidth - r.right}px` });
  $('theme-menu').hidden = !open;
  $('theme-btn').setAttribute('aria-expanded', String(open));
}
$('theme-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu();
});
$('theme-menu').addEventListener('click', async (e) => {
  const next = e.target.closest('[data-theme]')?.dataset.theme;
  toggleThemeMenu(false);
  if (!next) return;
  followTheme(next); // right away here; the other pages and the phone follow with the next state
  await post('/api/theme', { theme: next });
});
document.addEventListener('click', () => !$('theme-menu').hidden && toggleThemeMenu(false));

/* ---------- boot ---------- */

// Page sizes depend on the window size, so re-paginate when it changes.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state && renderPage(), 120);
});
setInterval(tick, 1000);

// Quitting from the widget menu with agents still running asks here, in the themed dialog.
window.opsConfirmQuit = async (names) => {
  const yes = await ask({
    danger: true,
    tag: 'QUIT',
    title: L('退出舰桥？'),
    message: L('还有 {0} 支部队在指挥中心里运行，退出会结束它们。会话记录会保留，下次启动时自动恢复阵容。', names.length),
    detail: names.map((n) => '◆ ' + n),
    ok: L('退出'),
  });
  if (yes) window.opsBridge?.quit();
};

// Frameless desktop window: our own minimize / maximize / close in the HUD.
const winBridge = window.opsBridge;

// Voice input: Windows' own voice typing (Win+H, pressed for us by the desktop app) writes what you
// say into whatever has focus, so focus the target first. Only in the desktop app.
function voiceInto(focus) {
  if (!winBridge?.action) return;
  focus();
  setTimeout(() => winBridge.action('voice'), 60);
}
if (winBridge?.action) document.body.classList.add('has-voice');
$('cmd-voice').addEventListener('click', () => voiceInto(() => $('cmd-text').focus()));
if (winBridge?.win) {
  document.body.classList.add('frameless');
  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => winBridge.win(b.dataset.win)));
  // F11: fullscreen on / off, from anywhere in the page (also while typing)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F11') return;
    e.preventDefault();
    winBridge.win('fullscreen');
  });
}

// The desktop shell calls this directly when the window is already open.
window.opsOpenTerm = (id) => {
  if (state?.agents?.some((a) => a.id === id)) openTerm(id);
};
// In a plain browser the pet re-targets the window by changing only the hash, which doesn't reload the page.
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#term=([0-9a-f-]{36})$/);
  if (m && state?.agents?.some((a) => a.id === m[1])) openTerm(m[1]);
});

/* ---------- UI commands from the master (fleet_ui) ---------- */

// What the page shows right now, reported back to the master after each command.
function uiView() {
  const { kind, list } = currentList();
  const size = pageSize(kind);
  const pages = kind === 'orders' ? 1 : Math.max(1, Math.ceil((list?.length || 0) / size));
  const shown = kind === 'orders' ? [] : (list || []).slice(ui.page * size, ui.page * size + size);
  const label = (x) => x.name || x.title || x.project || x.cwd || x.id;
  return {
    tab: ui.tab,
    showing: kind,
    page: ui.page + 1,
    pages,
    onPage: shown.map(label).slice(0, 12),
    archiveFolder: kind === 'archive' ? currentFolder()?.cwd || null : null,
    search: ui.search?.q || null,
    terminals: [...panes.keys()].map((id) => ({ id, name: agentLabel(id).name, active: id === ui.term })),
    split: dynamicSplit ? 'dynamic' : 'equal',
    operator: opMode,
    fullscreen: document.body.classList.contains('fullscreen'),
  };
}

async function runUi(c) {
  const ids = (c.ids || []).filter((id) => typeof id === 'string');
  switch (c.action) {
    case 'state':
      return;
    case 'tab':
      if (!TABS.includes(c.tab)) throw new Error(`tab: ${TABS.join(' | ')}`);
      if (c.tab !== 'archive' && ui.search) clearSearch(false);
      return setTab(c.tab);
    case 'page': {
      if (c.to === 'next' || c.to === 'prev') return turn(c.to === 'next' ? 1 : -1);
      const n = Number(c.to) - 1;
      const { kind, list } = currentList();
      if (!Number.isInteger(n) || n < 0 || n * pageSize(kind) >= Math.max(list.length, 1)) throw new Error('no such page');
      ui.page = n;
      return renderPage();
    }
    case 'folder': {
      const want = String(c.cwd || '').toLowerCase().replace(/[\/]+$/, '');
      const f = folders().find((x) => x.key.replace(/[\/]+$/, '') === want) || folders().find((x) => x.project.toLowerCase() === want || x.key.includes(want));
      if (!f) throw new Error('no such folder in the archive');
      if (ui.search) clearSearch(false);
      ui.tab = 'archive';
      ui.folder = f.key;
      ui.page = 0;
      return renderPage();
    }
    case 'open':
      if (!ids.length) throw new Error('no terminals given');
      for (const id of ids.slice(0, MAX_PANES)) openTerm(id);
      return;
    case 'close':
      if (c.all) return closeAllPanes();
      return ids.forEach(closePane);
    case 'split':
      return setDynamicSplit(c.mode !== 'equal');
    case 'search':
      if (String(c.q || '').trim().length < 2) throw new Error('at least 2 characters');
      $('search-q').value = c.q;
      await runSearch(String(c.q).trim());
      return;
    case 'clear_search':
      return clearSearch();
    case 'operator':
      return document.querySelector(`[data-opmode="${c.mode === 'input' ? 'input' : 'master'}"]`)?.click();
    case 'window':
      if (!winBridge?.win || !['fullscreen', 'maximize', 'minimize'].includes(c.op)) throw new Error('window: fullscreen | maximize | minimize (desktop app only)');
      return winBridge.win(c.op);
    case 'shell': {
      const r = await post('/api/agents', { shell: true, cwd: c.cwd || agentLabel(ui.term || '').cwd || folders()[0]?.cwd || '' });
      if (!r.id) throw new Error(r.error || 'could not open a shell');
      // the pane opens once the state lists the new shell
      for (let i = 0; i < 20 && !state.agents?.some((a) => a.id === r.id); i++) await new Promise((ok) => setTimeout(ok, 150));
      return openTerm(r.id);
    }
    case 'review':
      if (!c.path) throw new Error('path (a repo folder) is required');
      return openReview(c.path);
    case 'close_dialog':
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      return;
    default:
      throw new Error(`unknown action ${c.action}`);
  }
}

async function onUiCommand(c) {
  // keep typing in the master: opening a terminal would otherwise take the keyboard
  const typingInMaster = $('master-term').contains(document.activeElement);
  let error = null;
  try {
    await runUi(c);
  } catch (e) {
    error = e.message;
  }
  if (typingInMaster && c.action !== 'operator') setTimeout(() => masterTerm?.focus(), 50);
  await new Promise((ok) => setTimeout(ok, 120)); // let the page settle before reporting it
  post('/api/ui/done', { id: c.id, ok: !error, error, view: uiView() }).catch(() => {});
}

function connect() {
  const es = new EventSource('/api/stream?main=1');
  es.addEventListener('ui', (e) => {
    if (!state) return;
    try {
      onUiCommand(JSON.parse(e.data));
    } catch {
      // malformed: ignore
    }
  });
  es.onmessage = (e) => {
    const first = !state;
    state = JSON.parse(e.data);
    followTheme(state.theme);
    // deep link: /#term=<id>[,<id>...] opens those agents' terminals (split view)
    const deep = first && location.hash.match(/^#term=([0-9a-f-]{36}(?:,[0-9a-f-]{36})*)$/);
    if (deep) {
      const ids = deep[1].split(',').filter((id) => state.agents?.some((a) => a.id === id));
      setTimeout(() => ids.forEach((id) => openTerm(id)), 0);
    }
    $('conn').textContent = L('● 已连接');
    $('conn').classList.remove('bad');
    render();
  };
  es.onerror = () => {
    $('conn').textContent = L('● 连接断开，重连中…');
    $('conn').classList.add('bad');
  };
}
connect();

