import { createTerminal } from './terminal.js';
import { ask } from './ui.js';

const $ = (id) => document.getElementById(id);
// How many items of each list fit the page area at its current size (the window is not a fixed size).
const ITEM = { unitW: 400, unitGap: 16, questH: 92, questGap: 10, msgH: 46, saveH: 108, saveGap: 8 };
function pageSize(kind) {
  const W = $('page').clientWidth || 900;
  const H = $('page').clientHeight || 600;
  if (kind === 'units') return Math.max(1, Math.floor((W + ITEM.unitGap) / (ITEM.unitW + ITEM.unitGap)));
  if (kind === 'quests') return Math.max(1, Math.floor((H + ITEM.questGap) / (ITEM.questH + ITEM.questGap)));
  if (kind === 'comms') return Math.max(3, Math.floor((H - 40) / ITEM.msgH));
  return Math.max(1, Math.floor((H - 30) / (ITEM.saveH + ITEM.saveGap))); // archive
}
const KIND = {
  PERMIT: { label: 'PERMIT', c: 'var(--red)', mood: '● 请求授权' },
  ALERT: { label: 'ALERT', c: 'var(--red)', mood: '● 紧张' },
  OVERLOAD: { label: 'OVERLOAD', c: 'var(--red)', mood: '● 担心' },
  READY: { label: 'READY', c: 'var(--amber)', mood: '● 招手' },
  GIT: { label: 'GIT', c: 'var(--amber)', mood: '● 皱眉' },
  SYS: { label: 'SYS', c: 'var(--muted)', mood: '● 惊讶' },
  RECHARGED: { label: 'RECHARGED', c: 'var(--green)', mood: '● 开心' },
  ENGAGED: { label: 'ENGAGED', c: 'var(--cyan)', mood: '● 专注' },
  STANDBY: { label: 'STANDBY', c: 'var(--muted)', mood: '● 打盹' },
  DRONE: { label: 'DRONE', c: 'var(--cyan)' },
};
const LV_COLOR = { S: 'var(--red)', A: 'var(--amber)', B: '#C9A24A' };

const TABS = ['units', 'quests', 'comms', 'archive'];
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
  if (d) return short ? `${d}天` : `${d}天 ${pad(h)}:${pad(m)}`;
  return short ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

function ago(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
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
  return n == null ? '--' : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/* ---------- header ---------- */

const ERROR_TEXT = { rate_limited: '接口限流，稍后自动重试', token_expired: '登录过期，打开一次 Claude Code 即可' };

// The API's limit list (5h, weekly, per-model weekly); caches from older versions only had two windows.
function usageLimits(u) {
  if (u?.limits?.length) return u.limits;
  return [
    u?.fiveHour && { key: 'session', label: '5 小时', ...u.fiveHour },
    u?.sevenDay && { key: 'weekly_all', label: '本周 · 所有模型', ...u.sevenDay },
  ].filter(Boolean);
}

function renderEnergy() {
  const u = state?.usage;
  const limits = usageLimits(u);
  const errText = u?.error ? ERROR_TEXT[u.error] || u.error : '';
  if (!limits.length) {
    $('energy').innerHTML = `<div class="energy box cut"><div class="row"><span class="label">ENERGY · 额度</span><span>${errText ? '读取失败：' + esc(errText) : '读取中…'}</span></div>${seg(0, 30, 'var(--cyan)')}</div>`;
  } else {
    $('energy').innerHTML = limits
      .map((l) => {
        // the bar shows what's used, like /usage does
        const used = Math.min(100, Math.max(0, l.usedPct));
        const low = 100 - used <= state.thresholds.energyLowPct;
        const color = low ? 'var(--red)' : l.active ? 'var(--amber)' : 'var(--cyan)';
        const weekly = l.key !== 'session';
        const stale = u.error ? `<span class="stale" title="${esc(errText)}${u.retryAt ? ' · ' + clock(u.retryAt) + ' 重试' : ''}">缓存 ${clock(u.fetchedAt)}</span>` : '';
        return `<div class="energy box cut ${l.active ? 'active' : ''}" title="${l.active ? '当前起作用的限额' : ''}">
          <div class="row"><span class="label">${weekly ? 'RESERVE' : 'ENERGY'} · ${esc(l.label)}</span>${stale}
            <span class="left ${low ? 'low' : ''}">${Math.round(used)}%</span></div>
          ${seg(used, 24, color)}
          <div class="row"><span>已用</span><span>重置 <span class="cd" data-reset="${l.resetsAt}">${dur(l.resetsAt - Date.now())}</span> · ${clock(l.resetsAt, weekly)}</span></div>
        </div>`;
      })
      .join('');
  }
  const a = u?.account;
  $('pilot').textContent = a ? `PILOT · ${(a.tier || a.plan || '').replace('default_claude_', '').toUpperCase()} · ${a.email || ''}` : 'PILOT';
  $('pilot').title = a ? `${a.email || ''} · ${a.org || ''}` : '';
}

function tick() {
  $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
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
  $('dlg-name').textContent = op.name;
  $('op-mood').textContent = KIND[mood]?.mood || '';
  $('op-mood').style.color = KIND[mood]?.c;
  const text = esc(line?.text || '').replace(/(\d+(?:\.\d+)?%)/g, line?.kind === 'OVERLOAD' || line?.kind === 'ALERT' ? '<em>$1</em>' : '$1');
  $('dlg-go').innerHTML = line?.kind === 'PERMIT' ? '▶ 去终端授权<kbd>[ENTER]</kbd>' : '▶ 跳到这个终端<kbd>[ENTER]</kbd>';
  $('dlg-text').innerHTML = `${text}<span class="caret">▌</span>`;
  $('dlg-target').textContent = line?.unit ? `→ 部队 ${line.unit.project.toUpperCase()}` : '';
  $('dlg-count').textContent = op.lines.length > 1 ? `${ui.line + 1} / ${op.lines.length}` : '';
  $('dlg-go').disabled = !line?.unit;
  const ambient = !line?.key || AMBIENT.has(line.key);
  $('dlg-next').innerHTML = !ambient
    ? (op.lines.length > 1 ? '▷ 下一条提醒' : '▷ 30 分钟后再提醒') + `<kbd>[${op.lines.length > 1 ? 'SPACE' : 'S'}]</kbd>`
    : '▷ 没有其他提醒<kbd></kbd>';
  $('dlg-next').disabled = ambient;
}

/* ---------- master console: one input for all of our agents ---------- */

const targets = new Set(); // agent ids the console sends to
const knownAgents = new Set(); // so newly deployed agents start out selected
const sentLog = [];

function liveAgents() {
  return (state?.agents || []).filter((a) => a.alive);
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

function renderConsole() {
  const live = liveAgents();
  for (const a of live) {
    if (knownAgents.has(a.id)) continue;
    knownAgents.add(a.id);
    targets.add(a.id);
  }
  for (const id of [...targets]) if (!live.some((a) => a.id === id)) targets.delete(id);

  const handleOf = new Map(handles().map((h) => [h.id, h.handle]));
  const rows = live.map((a) => {
    const u = state.units.find((x) => x.agentId === a.id);
    const look = !u ? ['var(--muted)', '启动中'] : u.permission ? ['var(--red)', '等你授权'] : u.status === 'busy' ? ['var(--cyan)', '作战中'] : ['var(--amber)', '待命'];
    const ctx = u?.contextPct != null ? Math.round(u.contextPct) + '%' : '';
    return `<label class="cmd-item" style="--c:${look[0]}" title="${esc(a.cwd)}">
      <input type="checkbox" data-target="${esc(a.id)}" ${targets.has(a.id) ? 'checked' : ''}>
      <span class="dot"></span>
      <span class="who"><b>${esc(agentLabel(a.id).name)}</b><small><i>@${esc(handleOf.get(a.id))}</i> · ${esc(a.cwd)}</small></span>
      <span class="st">${look[1]}${ctx ? ' · ' + ctx : ''}</span>
    </label>`;
  });
  const html = rows.join('') || '<div class="cmd-empty">还没有我方 agent。点右上角「＋ 出击」，或在存档里「在此继续」。</div>';
  // only rebuild when something changed, so a click or focus in the list isn't interrupted
  if (renderConsole.last !== html) $('cmd-list').innerHTML = renderConsole.last = html;
  $('cmd-count').textContent = targets.size;
  $('cmd-send').disabled = !targets.size;
  document.querySelectorAll('.cmd-quick button').forEach((b) => (b.disabled = !targets.size));

  $('cmd-log').innerHTML = sentLog
    .slice(0, 5)
    .map((s) => `<div class="log-row"><span class="t">${clock(s.t)}</span><span class="m" title="${esc(s.text)}">${esc(s.text)}</span><span class="n">→ ${s.n}</span></div>`)
    .join('');
}

async function sendToTargets(body, label, ids = [...targets]) {
  if (!ids.length) return;
  const r = await post('/api/agents/action', { ...body, id: ids });
  const ok = (r.results || []).filter(Boolean).length;
  sentLog.unshift({ t: Date.now(), text: label, n: ok });
  toast(ok === ids.length ? `已发给 ${ok} 个 agent` : `发出 ${ok} / ${ids.length}，有的 agent 可能已经退出`);
  renderConsole();
}

$('cmd-list').addEventListener('change', (e) => {
  const id = e.target.dataset.target;
  if (!id) return;
  e.target.checked ? targets.add(id) : targets.delete(id);
  renderConsole();
});
$('cmd-all').addEventListener('click', () => {
  for (const a of liveAgents()) targets.add(a.id);
  renderConsole();
});
$('cmd-none').addEventListener('click', () => {
  targets.clear();
  renderConsole();
});
$('cmd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('cmd-text').value.trim();
  if (!raw) return ($('cmd-err').textContent = '先输入指令');
  // @mentions pick the recipients for this one message; without any, the checked agents get it
  const m = parseMentions(raw);
  if (m.unknown.length) return ($('cmd-err').textContent = `找不到 ${m.unknown.join(' ')}`);
  if (!m.text) return ($('cmd-err').textContent = '@ 后面还要写指令内容');
  $('cmd-err').textContent = '';
  const ids = m.ids.length ? m.ids : [...targets];
  const who = m.ids.length ? raw.match(/@[^\s@]+/g).join(' ') + ' ' : '';
  await sendToTargets({ action: 'text', text: m.text }, who + m.text, ids);
  $('cmd-text').value = '';
  closeSuggest();
});

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
  if (!state?.agentSupport?.ok) return toast(state?.agentSupport?.error || '无法启动 agent');
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
  if (!picks.length) return toast('没有可以出击的项目会话');
  const lines = picks.map((p) => `◆ ${p.project.toUpperCase()}${p.open ? '　已在指挥中心' : '　' + p.title.slice(0, 40)}`);
  const go = await ask({
    tag: 'FULL DEPLOY',
    title: `全军出击：${picks.length} 个项目`,
    message: '打开这些项目最新的会话，分屏排开。',
    detail: external.length ? [...lines, '', `跳过（正在外部终端运行）：${external.join('、')}`] : lines,
    ok: '⚡ 出击',
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
  toast(failed ? `出击 ${picks.length - failed} 个，${failed} 个失败` : `全军出击！${picks.length} 个终端已就位`);
}
$('deploy-all').addEventListener('click', deployAll);
document.querySelector('.cmd-quick').addEventListener('click', (e) => {
  if (e.target.closest('button')?.dataset.q === 'esc') sendToTargets({ action: 'key', key: 'esc' }, 'Esc 中断');
});

/* ---------- pages ---------- */

function unitCard(u) {
  const th = state.thresholds;
  const now = Date.now();
  const standby = u.status === 'idle' && now - u.statusSince > th.standbyMinutes * 60_000;
  const cls = u.permission ? 'permit' : u.status === 'busy' ? 'busy' : standby ? 'idle standby' : 'idle';
  const label = u.permission ? 'PERMIT · 等你授权' : u.status === 'busy' ? 'ENGAGED · 作战中' : standby ? 'STANDBY · 休眠' : 'AWAITING · 待命';
  const hot = u.contextPct != null && u.contextPct >= th.contextWarnPct;
  const loadColor = hot ? 'var(--red)' : 'var(--cyan)';
  const running = u.agents.filter((a) => a.running);
  const drones = !u.agents.length ? '无' : running.length ? `${running.length} 架出击：${running.map((a) => a.description).join('、')}` : `${u.agents.length} 架 · 全部返航`;
  const repos = u.repos.slice(0, 4).map(repoRow).join('');
  const more = u.repos.length > 4 ? `<div class="empty">还有 ${u.repos.length - 4} 个仓库…</div>` : '';
  const oldestFetch = u.repos.reduce((m, r) => (r.fetchedAt && (!m || r.fetchedAt < m) ? r.fetchedAt : m), null);
  const action = u.owned
    ? `<button class="mini" data-term="${esc(u.agentId)}" title="打开它的终端，直接下指令">▶ 终端</button>`
    : `<button class="mini ghost" data-focus="${u.pid}" title="在外部终端里运行，只能切过去">跳过去</button>`;
  return `
  <article class="unit ${cls}">
    <div class="top"><span>◆ ${label}${u.owned ? ' <i class="ours">我方</i>' : ''}</span><span class="top-r"><span class="timer" data-since="${u.statusSince}">T+${dur(now - u.statusSince)}</span>${action}</span></div>
    <div><h3 title="${esc(u.cwd)}">${esc(u.project)}</h3><div class="call">呼号 ${esc(u.name)} · ${esc((u.model || '').replace('claude-', '').toUpperCase())}</div>
      <div class="loc" title="${esc(u.cwd)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${esc(u.cwd)}</div></div>
    <div class="last" title="${esc(u.permission?.message || u.lastText)}">${esc(u.permission ? '请求授权：' + (u.permission.message || '需要你确认') : u.status === 'busy' && u.lastPrompt ? '执行中：' + u.lastPrompt : u.lastText || '（还没有汇报）')}</div>
    <div class="stats">
      <div class="stat" style="--kc:${loadColor}"><div class="k"><span>LOAD 记忆负载</span><span class="mono">${u.contextPct == null ? '--' : Math.round(u.contextPct) + '%'} · ${kTokens(u.contextTokens)}</span></div>${seg(u.contextPct ?? 0, 20, loadColor)}</div>
      <div class="stat"><div class="k"><span>DRONES 僚机</span></div><div class="v" title="${esc(drones)}">${esc(drones)}</div></div>
    </div>
    <div class="repos">
      <div class="k"><span>REPOS 仓库 ×${u.repos.length}</span><span>${oldestFetch ? '最早 fetch 在 ' + ago(now - oldestFetch) : ''}</span></div>
      ${!u.gitScanned ? '<div class="empty">扫描中…</div>' : u.repos.length ? repos + more : '<div class="empty">这个目录下没有 git 仓库</div>'}
    </div>
  </article>`;
}

function repoRow(r) {
  if (r.error) return `<div class="repo" style="--rc:var(--red)"><div class="r1"><span class="name">${esc(r.name)}</span></div><div class="chg">读取失败：${esc(r.error)}</div></div>`;
  const th = state.thresholds;
  const now = Date.now();
  const stale = r.oldestChangeAt && now - r.oldestChangeAt >= th.staleDirtyDays * 86_400_000;
  const rc = r.conflicts || r.operation || stale ? 'var(--red)' : r.changedCount ? 'var(--amber)' : 'var(--line-hi)';
  const sync = !r.upstream ? ['无上游', 'var(--amber)'] : r.ahead || r.behind ? [`↑${r.ahead} ↓${r.behind}`, 'var(--amber)'] : ['↑0 ↓0', 'var(--green)'];
  let chg = '工作区干净';
  if (r.operation) chg = `卡在 ${r.operation} 中途${r.conflicts ? `，${r.conflicts} 个冲突` : ''}`;
  else if (r.changedCount)
    chg = `${r.changedCount} 个文件未提交${r.untracked ? `（${r.untracked} 新）` : ''} · +${r.insertions} −${r.deletions}${r.oldestChangeAt ? ' · 已放 ' + dur(now - r.oldestChangeAt, true).replace(/^(\d\d):(\d\d)$/, '$1h$2m') : ''}`;
  if (r.stash) chg += ` · stash ${r.stash}`;
  const touched = r.claudeTouchedAt ? `<span class="claude" title="Claude 最后一次修改这个仓库的时间">CLAUDE ${clock(r.claudeTouchedAt, now - r.claudeTouchedAt > 86_400_000)}</span>` : '';
  return `<div class="repo" style="--rc:${rc}" title="${esc(r.head ? `${r.head.hash} · ${r.head.subject} · ${r.head.author}` : r.path)}">
    <div class="r1"><span class="name">${esc(r.name)}</span>${touched}<span class="branch">${esc(r.branch || '(detached)')}</span><span class="sync" style="color:${sync[1]}">${sync[0]}</span></div>
    <div class="chg">${esc(chg)}</div></div>`;
}

function questCard(q) {
  const since = q.since ? `T+${dur(Date.now() - q.since, true)}` : '';
  return `<article class="quest" style="--qc:${LV_COLOR[q.lv]}">
    <span class="lv">${q.lv}</span>
    <div class="body"><span class="type">${q.kind}${q.unit ? ' · 部队 ' + esc(q.unit.project.toUpperCase()) : ''}</span>
      <span class="title">${esc(q.title)}</span><span class="goal" title="${esc(q.goal)}">目标：${esc(q.goal)}</span></div>
    <div class="side"><span class="mono">${since}</span><div>
      <button class="btn ghost" data-snooze="${esc(q.key)}">稍后</button>
      ${q.unit ? `<button class="btn" data-focus="${q.unit.pid}">▶ 前往</button>` : ''}</div></div>
  </article>`;
}

function msgRow(e) {
  const k = KIND[e.kind] || KIND.SYS;
  return `<div class="msg"><span class="t">[${clock(e.t, Date.now() - e.t > 86_400_000)}]</span><span class="k" style="--kc:${k.c}">${k.label}</span><span class="m" title="${esc(e.msg)}">${esc(e.msg)}</span></div>`;
}

function archiveRow(h) {
  const now = Date.now();
  const action = h.owned
    ? `<button class="btn" data-term="${esc(h.agentId)}">▶ 终端</button>`
    : h.pid
      ? `<button class="btn" data-focus="${h.pid}" title="正在外部终端里运行">▶ 跳过去</button>`
      : `<div class="save-actions"><button class="btn" data-takeover="${esc(h.sessionId)}" title="在指挥中心里继续，可以直接下指令">▶ 在此继续</button>
         <button class="btn ghost" data-resume="${esc(h.sessionId)}" title="在新的 Windows Terminal 里继续">外部终端</button></div>`;
  return `<article class="save ${h.pid ? 'live' : ''}">
    <div class="when"><span class="mono">${clock(h.updatedAt, true)}</span><small>${ago(now - h.updatedAt)}</small></div>
    <div class="info">
      <div class="r1"><b>${esc(h.project.toUpperCase())}</b>${h.pid ? '<span class="running">运行中</span>' : ''}<span class="title">${esc(h.title || h.lastPrompt)}</span></div>
      <div class="prompt" title="${esc(h.lastPrompt)}">${h.lastPrompt ? '最后指令：' + esc(h.lastPrompt) : ''}</div>
      <div class="path">${esc(h.cwd)}</div>
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
  if (ui.tab === 'archive' || (ui.tab === 'units' && !state.units.length)) return { kind: 'archive', list: currentFolder()?.sessions || [] };
  return { kind: ui.tab, list: { units: state.units, quests: state.quests, comms: state.comms }[ui.tab] };
}

function folderList(list, sel) {
  const now = Date.now();
  return list
    .map((f) => `<button class="folder ${f.key === sel?.key ? 'on' : ''}" data-folder="${esc(f.key)}" title="${esc(f.cwd)}">
      <span class="fname">${esc(f.project)}</span>${f.running ? `<span class="running">${f.running} 运行中</span>` : ''}
      <span class="fmeta">${f.sessions.length} 个会话 · ${ago(now - f.latest)}</span></button>`)
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
      <nav class="folders" aria-label="项目文件夹"><div class="archive-head"><span class="mono">FOLDERS</span><span>${fl.length} 个 · ↑↓ 切换</span></div>${folderList(fl, sel)}</nav>
      <div class="saves"><div class="archive-head"><span class="mono">SAVE DATA</span><span>${ui.tab === 'units' ? '没有活动的会话 · ' : ''}${esc(sel?.cwd || '')} · ${list.length} 个</span></div>
      ${items.map(archiveRow).join('') || '<div class="blank">没有找到会话</div>'}</div></div>`;
    $('page').innerHTML = html;
    document.querySelector('.folders').scrollTop = scroll; // keep the folder list where it was across live refreshes
  }
  else if (ui.tab === 'units') html = `<div class="units" style="grid-template-columns: repeat(${size}, minmax(0, 1fr))">${items.map(unitCard).join('')}</div>`;
  else if (ui.tab === 'quests') html = items.length ? `<div class="quests">${items.map(questCard).join('')}</div>` : '<div class="blank">没有待处理的任务，指挥官可以喝杯咖啡</div>';
  else html = `<div class="comms">${items.map(msgRow).join('') || '<div class="msg"><span class="m">还没有通讯记录。部队状态变化时会出现在这里。</span></div>'}</div>`;
  if (kind !== 'archive') $('page').innerHTML = html;

  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab)));
  $('n-units').textContent = state.units.length;
  $('n-quests').textContent = state.quests.length;
  $('n-comms').textContent = state.comms.length;
  $('n-archive').textContent = (state.history || []).length;
  const busy = state.units.filter((u) => u.status === 'busy').length;
  $('summary').textContent = `◆ 作战 ${busy}　◆ 待命 ${state.units.length - busy}`;
  $('dots').innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i === ui.page ? 'on' : ''}"></i>`).join('') + `<span>${pad(ui.page + 1)} / ${pad(total)}</span>`;
  $('prev').disabled = ui.page === 0;
  $('next').disabled = ui.page >= total - 1;
}

function render() {
  if (!state) return;
  renderEnergy();
  renderOperator();
  renderConsole();
  renderPage();
  renderTermHeads();
  $('deploy-open').disabled = !state.agentSupport?.ok;
  $('deploy-open').title = state.agentSupport?.ok ? '在指挥中心里启动一个新的 Claude Code（N）' : state.agentSupport?.error || '';
  tick();
}

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
  toast(r.ok ? `已切到 ${r.window} 窗口` : '没找到这个会话的终端窗口');
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
  <button data-tkey="esc" title="打断当前操作">Esc</button>
  <button data-tact="pop" title="弹出成独立窗口">⧉</button>
  <button data-tact="kill" class="danger" title="结束这个 Claude 进程">结束</button>
  <button data-tact="remove" class="ghost" hidden>移除</button>
  <button data-tact="close" title="收起这个终端（agent 继续运行）" aria-label="收起这个终端">✕</button>`;

function renderTermHeads() {
  for (const [id, { el }] of panes) {
    const { a, name, cwd } = agentLabel(id);
    const alive = a?.alive;
    el.querySelector('.t-name').textContent = name;
    el.querySelector('.t-cwd').textContent = cwd;
    const st = el.querySelector('.t-state');
    const u = state?.units.find((x) => x.agentId === id);
    const [label, cls] = !alive
      ? [`● 已退出${a?.exitCode != null ? '（' + a.exitCode + '）' : ''}`, 'off']
      : u?.permission ? ['● 等你授权', 'permit'] : u?.status === 'busy' ? ['● 作战中', 'busy'] : ['● 待命', 'on'];
    st.textContent = label;
    st.className = 't-state ' + cls;
    el.querySelector('.t-ctx').innerHTML = ctxBadge(u);
    el.querySelectorAll('[data-tkey], [data-tcmd], [data-tact=kill], [data-tact=pop]').forEach((b) => (b.disabled = !alive));
    el.querySelector('[data-tact=remove]').hidden = alive !== false;
  }
  $('term-count').textContent = `${panes.size} / ${MAX_PANES}`;

  // Our other agents, one click away from joining the split view (the panel hides the unit cards).
  const others = (state?.agents || []).filter((a) => a.alive && !panes.has(a.id));
  const html = others.length
    ? others.map((a) => `<button data-add="${esc(a.id)}" title="${esc(a.cwd)}">＋ ${esc(agentLabel(a.id).name)}</button>`).join('') + '<button data-add-new title="启动新的 Claude（N）">＋ 出击</button>'
    : '<span class="hint">没有其他我方 agent · </span><button data-add-new>＋ 出击</button>';
  if (renderTermHeads.last !== html) $('term-add').innerHTML = renderTermHeads.last = html;
}

// Context load of one agent, for its terminal title bar: mini bar + percent + tokens.
function ctxBadge(u) {
  if (u?.contextPct == null) return '';
  const pct = Math.round(u.contextPct);
  const hot = pct >= state.thresholds.contextWarnPct;
  const color = hot ? 'var(--red)' : 'var(--cyan)';
  return `<span class="ctx-badge" style="--cc:${color}" title="记忆负载 ${pct}%：${(u.contextTokens || 0).toLocaleString()} / ${(u.contextWindow || 0).toLocaleString()} tokens${hot ? '，建议 /compact' : ''}">
    <i style="width:${Math.min(100, pct)}%"></i></span><span class="ctx-num" style="color:${color}">${pct}% · ${kTokens(u.contextTokens)}</span>`;
}

function setActivePane(id) {
  ui.term = id;
  for (const [pid, { el }] of panes) el.classList.toggle('active', pid === id);
}

function layoutPanes() {
  $('term-grid').dataset.n = String(panes.size);
  const font = panes.size > 1 ? 12 : 13; // narrower panes get a smaller font to keep enough columns
  for (const { t } of panes.values()) t.setFontSize(font);
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
  el.innerHTML = `<header class="term-head"><div class="term-who"><b class="t-name"></b><span class="t-state"></span><span class="t-ctx"></span><span class="term-cwd t-cwd"></span></div><div class="term-actions">${PANE_ACTIONS}</div></header><div class="term-host"></div>`;
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
  if (!r.ok) toast('操作没有生效：这个 agent 可能已经退出');
  return r;
}

async function takeover(sessionId) {
  const r = await post('/api/agents', { resume: sessionId });
  if (!r.ok) return toast('接管失败：' + r.error);
  toast('已在指挥中心里继续这个会话');
  openTerm(r.id);
}

function openDeploy() {
  if (state && !state.agentSupport?.ok) return toast(state.agentSupport?.error || '无法启动 agent');
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
  $('dp-note').textContent = s?.pid && !s.owned ? '这个文件夹最新的会话正在外部终端运行，将开新会话。' : '';
  if (s && (resumable || s.owned)) {
    const title = (s.title || s.lastPrompt || s.sessionId.slice(0, 8)).slice(0, 36);
    $('dp-latest').textContent = `${s.owned ? '打开' : '继续'}最新会话：${title} · ${ago(Date.now() - s.updatedAt)}`;
  }
  $('dp-name').disabled = Boolean(s && (resumable || s.owned) && $('deploy-form').elements['dp-mode'].value === 'resume');
}

$('dp-cwd').addEventListener('input', () => {
  $('deploy-form').elements['dp-mode'].value = 'resume'; // a new folder starts back at "continue latest"
  updateDeployMode();
});
$('dp-mode').addEventListener('change', updateDeployMode);
$('deploy-open').addEventListener('click', openDeploy);
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
      $('dp-err').textContent = r.error || '启动失败';
      return;
    }
    $('deploy').close();
    toast(wantResume ? '部队归队，继续最新会话' : '部队出击！');
    openTerm(r.id);
  } finally {
    $('dp-go').disabled = false;
  }
});

$('term-close-all').addEventListener('click', closeAllPanes);
$('term-add').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add) openTerm(b.dataset.add);
  else if ('addNew' in b.dataset) openDeploy();
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
    const yes = await ask({ danger: true, title: `结束「${agentLabel(id).name}」？`, message: '进程会退出，会话记录保留，可以从存档继续。', ok: '结束' });
    if (!yes) return;
    await agentAction({ id, action: 'kill' });
  } else if (b.dataset.tact === 'remove') {
    await agentAction({ id, action: 'remove' });
    return closePane(id);
  } else if (b.dataset.tact === 'pop') return popOut(id);
  else if (b.dataset.tact === 'close') return closePane(id);
  else return;
  panes.get(id)?.t.focus();
});

async function resume(sessionId) {
  const r = await post('/api/resume', { sessionId });
  if (r.focused) toast(r.ok ? `已经在运行，切到 ${r.window} 窗口` : '这个会话在运行，但没找到它的终端窗口');
  else toast(r.ok ? `已在 ${r.terminal} 里打开，部队即将上线` : '打开失败：' + r.error);
}

async function snoozeLine(key, minutes = 30) {
  await post('/api/snooze', { key, minutes });
  toast(`${minutes} 分钟后再提醒`);
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
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('prev').addEventListener('click', () => turn(-1));
$('next').addEventListener('click', () => turn(1));
$('dlg-go').addEventListener('click', () => {
  const l = currentLine();
  if (l?.unit) focus(l.unit.pid);
});
$('dlg-next').addEventListener('click', () => {
  const l = currentLine();
  if (state.operator.lines.length > 1) nextLine();
  else if (l) snoozeLine(l.key);
});
$('refresh').addEventListener('click', async () => {
  toast('正在刷新…');
  await post('/api/refresh');
  toast('已刷新');
});
$('page').addEventListener('click', (e) => {
  const fo = e.target.closest('[data-folder]');
  if (fo) {
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
  else if (k === 'enter') $('dlg-go').click();
  else if (k === ' ') nextLine();
  else if (k === 's') {
    const l = currentLine();
    if (l && !$('dlg-next').disabled) snoozeLine(l.key);
  } else return;
  e.preventDefault();
});

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
    title: '退出 CLAUDE OPS？',
    message: `还有 ${names.length} 支部队在指挥中心里运行，退出会结束它们。会话记录会保留，下次启动时自动恢复阵容。`,
    detail: names.map((n) => '◆ ' + n),
    ok: '退出',
  });
  if (yes) window.opsBridge?.quit();
};

// Frameless desktop window: our own minimize / maximize / close in the HUD.
const winBridge = window.opsBridge;
if (winBridge?.win) {
  document.body.classList.add('frameless');
  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => winBridge.win(b.dataset.win)));
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

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const first = !state;
    state = JSON.parse(e.data);
    // deep link: /#term=<agent id> opens that agent's terminal
    const deep = first && location.hash.match(/^#term=([0-9a-f-]{36})$/);
    if (deep && state.agents?.some((a) => a.id === deep[1])) setTimeout(() => openTerm(deep[1]), 0);
    $('conn').textContent = '● 已连接';
    $('conn').classList.remove('bad');
    render();
  };
  es.onerror = () => {
    $('conn').textContent = '● 连接断开，重连中…';
    $('conn').classList.add('bad');
  };
}
connect();

