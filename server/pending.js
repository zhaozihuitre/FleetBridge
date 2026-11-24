// The "待决定" list: what the user still owes an answer to, kept until it is answered (design:
// ~/.claude-ops/designs/pending-decisions-设计.html, phase 1). Notices tell what happened and scroll away;
// this is state: a question stays until it is answered, snoozed or dropped, across restarts and updates.
//   report   a terminal's report: its "需要用户…" section, one item per list entry (else the summary's needs)
//   dialog   a permission or choice dialog nobody answered for DIALOG_AFTER (mirrored: the screen decides)
//   master   a question the master put to the user (fleet_pending_add)
//   system   Fleet Bridge's own (proposals to approve or install, orders on hold, a folder-trust dialog):
//            never stored, made from their own state each time (server/index.js systemItems)
// Kept in <data>/pending.json: open ones forever, closed ones 30 days and at most 500.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DIALOG_AFTER = 2 * 60_000; // a dialog the master usually answers in seconds: listed after this
export const AMBER_AFTER = 2 * 3_600_000; // waiting this long: yellow
export const RED_AFTER = 24 * 3_600_000; // and this long: red, named in the banner
const KEEP_CLOSED_MS = 30 * 86_400_000;
const KEEP_CLOSED_MAX = 500;
const TEXT_MAX = 600;
const OPEN = new Set(['open', 'snoozed']);
// the same turn, seen by two paths (the notices and the master's done notice): its start read a few seconds apart
const sameRef = (a, b) => a.agentId === b.agentId && Math.abs((a.turnAt || 0) - (b.turnAt || 0)) < 30_000;

/** Words only: no whitespace, no punctuation (wrapping and quoting differ between two readings). */
export const squash = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const clip = (s, n) => {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ---- a report's "needs the user" section --------------------------------------------------------------

// its heading: 【需要用户配合】, **还需要用户做的事**：, ### 需要你决定, 还需要用户决定的事：… (the rest of the line is content)
const HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*【?\s*((?:还)?需要(?:用户|你)(?:配合|决定|做|确认|动手)?(?:的事|的点|什么|的事项)?|待(?:你|用户)决定(?:的点|的事)?)\s*】?\s*(?:\*\*)?\s*(?:[（(][^)）]*[)）])?\s*[:：]?\s*(?:\*\*)?\s*(.*)$/;
// any other heading ends the section
const OTHER_HEAD = /^\s*(?:#{1,6}\s+\S|\*\*[^*]{1,40}\*\*\s*[:：]?\s*$|\*\*[^*]{1,40}[:：]\*\*|【[^】]{1,20}】|\[\[\/?FLEET-REPORT\]\])/;
const ITEM = /^(\s*)(?:[-*•·]|\d{1,2}[.、)）])\s+(.*)$/;
const NOTHING = /^(?:无|没有|暂无|none|n\/a|nothing|不需要|—+|-+)\s*[。.，,；;！!]?$/i;

/** The section's text, or null when the reply has none. */
function needsSection(reply) {
  const lines = String(reply || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEAD);
    if (!m) continue;
    const out = [];
    if (m[2]?.trim()) out.push(m[2].replace(/\*\*$/, '').trim());
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (OTHER_HEAD.test(l) && !ITEM.test(l)) break;
      // a blank line then plain text: the section was its list (or its sentence), the rest is something else
      if (!l.trim()) {
        const next = lines.slice(j + 1).find((x) => x.trim());
        if (out.length && next !== undefined && !ITEM.test(next) && !/^\s{2,}/.test(next)) break;
        continue;
      }
      out.push(l);
    }
    return out.join('\n');
  }
  return null;
}

/** One entry per top-level list item (deeper ones and continuation lines belong to the item above). */
function splitItems(section) {
  const lines = section.split('\n');
  const items = [];
  let top = null; // indent of the first list item
  for (const l of lines) {
    const m = l.match(ITEM);
    if (m && (top === null || m[1].length <= top)) {
      top ??= m[1].length;
      items.push(m[2].trim());
    } else if (items.length) items[items.length - 1] += '\n' + l.trim();
    else items.push(l.trim());
  }
  // text before the first list item is an introduction ("需要用户决定的点："), not an item
  if (items.length > 1 && !ITEM.test(lines.find((l) => l.trim()) || '')) items.shift();
  return items.map((s) => s.replace(/\*\*/g, '').trim()).filter((s) => s && !NOTHING.test(s));
}

/** Choices written in the text: "A. … B. …", "（1）…（2）…", "要不要 / 是否" (yes / no). */
export function optionsOf(text) {
  const t = String(text || '');
  // a label ends at the next choice, a full stop, or a bracket ("B. 直接报错（建议 A）": "直接报错")
  const lettered = [...t.matchAll(/(?:^|[\s（(：:，,；;])([A-D])[.、:：)）]\s*([^\n；;。（(]+?)(?=\s*(?:[；;。\n（(]|[A-D][.、:：)）]|$))/g)];
  if (lettered.length >= 2 && lettered.map((m) => m[1]).join('') === 'ABCD'.slice(0, lettered.length)) return lettered.map((m) => ({ key: m[1], label: clip(m[2].replace(/[，,]\s*$/, ''), 40) }));
  const numbered = [...t.matchAll(/[（(]([1-4])[)）]\s*([^\n；;。（(]+)/g)];
  if (numbered.length >= 2) return numbered.map((m) => ({ key: m[1], label: clip(m[2], 40) }));
  if (/要不要|是否|可不可以|能不能|行不行|同不同意|需不需要/.test(t)) return [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }];
  return [];
}

/** "推荐 / 建议 / 我倾向…" in the text: that part; "建议 A" names its option ("A. 回退到密码登录"). */
export function suggestionOf(text, options = optionsOf(text)) {
  const m = String(text || '').match(/[（(]?\s*(?:我的)?(?:推荐|建议|倾向于?|我倾向于?)\s*[：:，,]?\s*([^。；;\n)）]{1,80})/);
  if (!m) return '';
  const s = m[1].trim();
  const o = /^[A-D1-4]$/i.test(s) && options.find((x) => x.key.toUpperCase() === s.toUpperCase());
  return o ? `${o.key}. ${o.label}` : s.length >= 2 ? clip(s, 80) : '';
}

/** Something to do (scan a code, type a code, create…) or a choice to make. */
export const kindOf = (text) => (/扫码|验证码|登录|填写|填到|填入|输入|下载|安装|运行|执行|配置|创建|建一个|新建|打开.*(?:网址|链接|页面)|看一眼/.test(text) && !/是否|要不要|还是|选择|决定|同意|批准/.test(text) ? 'do' : 'decide');

/**
 * What a reply needs of the user, as items: its section, one per list entry; with no section the summary's
 * one sentence (summary.js needs); [] when it needs nothing.
 */
export function parseNeeds(reply, summaryNeeds = '') {
  const section = needsSection(reply);
  const texts = section !== null ? splitItems(section) : summaryNeeds && !NOTHING.test(summaryNeeds.trim()) ? [summaryNeeds.trim()] : [];
  return texts.map((t) => {
    const text = clip(t, TEXT_MAX);
    const options = optionsOf(text);
    return { text, kind: options.length ? 'decide' : kindOf(text), options, suggestion: suggestionOf(text, options) };
  });
}

// ---- the store --------------------------------------------------------------------------------------

/**
 * @param {{ file?: string, now?: () => number }} o file: where it is kept (none: memory only, for tests)
 */
export function createStore({ file = null, now = Date.now } = {}) {
  let data = { seq: 0, items: [] };
  let listeners = [];

  function load() {
    if (!file) return;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && Array.isArray(d.items)) data = { seq: Number(d.seq) || 0, items: d.items };
    } catch (e) {
      // unreadable: kept aside as .bad, and the list starts empty (never overwritten unread)
      if (e.code !== 'ENOENT') {
        try {
          fs.renameSync(file, `${file}.${now()}.bad`);
        } catch {}
        data = { seq: 0, items: [], damaged: true };
      }
    }
  }
  function save() {
    prune();
    for (const f of listeners) f();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify({ seq: data.seq, items: data.items }));
      fs.renameSync(file + '.tmp', file);
    } catch {
      // kept in memory; written with the next change
    }
  }
  function prune() {
    const t = now();
    const closed = data.items.filter((x) => !OPEN.has(x.status));
    const keep = new Set(closed.filter((x) => t - (x.closedAt || x.at) < KEEP_CLOSED_MS).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, KEEP_CLOSED_MAX));
    data.items = data.items.filter((x) => OPEN.has(x.status) || keep.has(x));
  }
  const log = (x, action, by, extra) => (x.history ||= []).push({ at: now(), action, by: by || 'system', ...extra });
  const owner = (x) => x.agentId || x.project || '';
  const same = (a, b) => {
    if (a.source !== b.source || owner(a) !== owner(b)) return false;
    const x = squash(a.text);
    const y = squash(b.text);
    return x === y || (Math.min(x.length, y.length) >= 8 && (x.includes(y) || y.includes(x)));
  };

  /**
   * One item in: a new one, or merged into the same open question (seen once more, the first time kept).
   * A question asked again after it was closed, by a later turn: a new item.
   * @returns {{ id: string, merged: boolean }}
   */
  function add(it, by) {
    const t = now();
    const ref = it.ref || null;
    const prev = data.items.find((x) => same(x, it) && (OPEN.has(x.status) || (ref && (x.refs || []).some((r) => sameRef(r, ref)))));
    if (prev) {
      if (ref && !(prev.refs || []).some((r) => sameRef(r, ref))) {
        (prev.refs ||= []).push(ref);
        prev.seen = (prev.seen || 1) + 1;
        prev.lastAt = t;
        prev.stale = false;
        log(prev, 'merge', by);
        save();
      }
      return { id: prev.id, merged: true };
    }
    const x = {
      id: `Q-${++data.seq}`,
      source: it.source,
      kind: it.kind || kindOf(it.text),
      project: it.project || null,
      cwd: it.cwd || null,
      agentId: it.agentId || null,
      agentName: it.agentName || null,
      sessionId: it.sessionId || null,
      at: it.at || t,
      lastAt: t,
      seen: 1,
      text: clip(it.text, TEXT_MAX),
      options: Array.isArray(it.options) ? it.options.slice(0, 6).map((o) => ({ key: String(o.key), label: clip(o.label, 60) })) : [],
      suggestion: it.suggestion ? clip(it.suggestion, 120) : '',
      refs: ref ? [ref] : [],
      dialogKey: it.dialogKey || null,
      status: 'open',
      stale: false,
      snoozeUntil: null,
      answer: null,
    };
    data.items.push(x);
    log(x, 'add', by);
    save();
    return { id: x.id, merged: false };
  }

  /**
   * A terminal's finished turn: its needs, as items. Its earlier open report items it does not ask again are
   * marked stale ("the later report did not mention it"): never closed by this, the user decides.
   * @returns {string[]} the ids of its items
   */
  function fromReport({ agentId, agentName, sessionId, project, cwd, turnAt, order, reply, needs }) {
    const found = parseNeeds(reply, needs);
    const ref = { agentId, turnAt: turnAt || 0, order: clip(order, 60), report: clip(reply, 8000) };
    const ids = found.map((f) => add({ source: 'report', ...f, agentId, agentName, sessionId, project, cwd, ref }, 'report').id);
    let marked = false;
    // only a report that has the section says what it still needs (a short answer between says nothing of it)
    const said = needsSection(reply) !== null;
    for (const x of data.items)
      if (said && x.source === 'report' && x.agentId === agentId && OPEN.has(x.status) && !ids.includes(x.id) && !x.stale && (x.refs || []).every((r) => (r.turnAt || 0) < (turnAt || 0) - 30_000)) {
        x.stale = true;
        marked = true;
      }
    if (marked) save();
    return ids;
  }

  /**
   * The dialogs on screen now ({ dialogKey, at, agentId, … }): those waiting DIALOG_AFTER are listed; a listed
   * one gone from the screen was answered there (its terminal alive) or went with its terminal (expired).
   */
  function syncDialogs(current, alive = () => true) {
    const t = now();
    const keys = new Set(current.map((d) => d.dialogKey));
    for (const d of current) if (t - (d.at || t) >= DIALOG_AFTER) add({ source: 'dialog', kind: 'decide', ...d, at: d.at }, 'dialog');
    let changed = false;
    for (const x of data.items) {
      if (x.source !== 'dialog' || !OPEN.has(x.status) || keys.has(x.dialogKey)) continue;
      const ok = alive(x.agentId);
      x.status = ok ? 'answered' : 'expired';
      x.closedAt = t;
      if (ok) x.answer = { text: '', option: null, at: t, by: 'terminal', delivered: 'sent' };
      log(x, ok ? 'answer' : 'expire', 'terminal');
      changed = true;
    }
    if (changed) save();
  }

  /**
   * answered / dropped / snoozed / reopened. answer: { text, option, by, delivered, orderAt }; until: when a
   * snoozed one is open again.
   */
  function resolve(id, { action, answer = null, until = null, by = 'ui' } = {}) {
    const x = data.items.find((i) => i.id === String(id).toUpperCase());
    if (!x) throw new Error(`no pending item ${id}`);
    const t = now();
    if (action === 'reopen') {
      x.status = 'open';
      x.snoozeUntil = null;
      x.closedAt = null;
    } else if (action === 'snooze') {
      if (!(until > t)) throw new Error('snooze needs a time to come back (until)');
      x.status = 'snoozed';
      x.snoozeUntil = until;
    } else if (action === 'answered' || action === 'dropped') {
      x.status = action;
      x.closedAt = t;
      x.answer = answer ? { text: clip(answer.text || '', 2000), option: answer.option ?? null, at: t, by, delivered: answer.delivered || 'not-sent', orderAt: answer.orderAt || null } : { text: '', option: null, at: t, by, delivered: 'not-sent' };
    } else throw new Error(`unknown action ${action}`);
    log(x, action, by, until ? { until } : undefined);
    save();
    return x;
  }

  /** Snoozed ones whose time came: open again. */
  function wake() {
    const t = now();
    let changed = false;
    for (const x of data.items)
      if (x.status === 'snoozed' && x.snoozeUntil && x.snoozeUntil <= t) {
        x.status = 'open';
        x.snoozeUntil = null;
        log(x, 'wake', 'system');
        changed = true;
      }
    if (changed) save();
  }

  load();
  return {
    add,
    fromReport,
    syncDialogs,
    resolve,
    wake,
    get: (id) => data.items.find((x) => x.id === String(id).toUpperCase()) || null,
    items: () => data.items,
    damaged: () => Boolean(data.damaged),
    onChange: (f) => listeners.push(f),
    reload: load,
  };
}

/** How long it waited: '' / 'amber' / 'red'. */
export const ageLevel = (at, now = Date.now()) => (now - at >= RED_AFTER ? 'red' : now - at >= AMBER_AFTER ? 'amber' : '');

/**
 * What the pages and the master get: the open items (oldest first), the snoozed, those closed in the last
 * week, Fleet Bridge's own, and the counts (snoozed ones not counted).
 */
export function pendingView(items, system = [], now = Date.now()) {
  // what goes out with every state: no reports, no history (GET /api/pending?id= gives one in full)
  items = items.map(({ history, refs, ...x }) => ({ ...x, refs: (refs || []).map(({ report, ...r }) => ({ ...r, hasReport: Boolean(report) })) }));
  const open = items.filter((x) => x.status === 'open').sort((a, b) => a.at - b.at);
  const snoozed = items.filter((x) => x.status === 'snoozed').sort((a, b) => a.snoozeUntil - b.snoozeUntil);
  const recent = items.filter((x) => !OPEN.has(x.status) && now - (x.closedAt || 0) < 7 * 86_400_000).sort((a, b) => b.closedAt - a.closedAt).slice(0, 30);
  const live = [...open, ...system];
  const byAgent = {};
  for (const x of live) if (x.agentId) byAgent[x.agentId] = (byAgent[x.agentId] || 0) + 1;
  const red = live.filter((x) => ageLevel(x.at, now) === 'red');
  return {
    open,
    snoozed,
    recent,
    system,
    count: live.length,
    red: red.length,
    amber: live.filter((x) => ageLevel(x.at, now) === 'amber').length,
    oldestAt: live.length ? Math.min(...live.map((x) => x.at)) : null,
    redList: red.map((x) => ({ id: x.id, project: x.project, agentName: x.agentName })),
    byAgent,
  };
}

/**
 * Fleet Bridge's own waiting items, from their own state (never stored): proposals to approve or to install,
 * orders on hold (P-005), a folder-trust dialog waiting DIALOG_AFTER.
 */
export function systemItems({ proposals = [], agents = [], now = Date.now() } = {}) {
  const out = [];
  for (const p of proposals) {
    if (p.status === 'new') out.push({ id: p.id, source: 'system', sys: 'approve', project: '舰桥', text: p.title, at: p.createdAt || p.updatedAt || now });
    if (p.status === 'built') out.push({ id: p.id, source: 'system', sys: 'install', project: '舰桥', text: p.title, at: p.updatedAt || now });
  }
  for (const a of agents) {
    if (!a.alive && !(a.queue || []).some((q) => q.held)) continue;
    const held = (a.queue || []).filter((q) => q.held);
    if (held.length) out.push({ id: `held:${a.id}`, source: 'system', sys: 'held', agentId: a.id, agentName: a.name, project: base(a.cwd), text: held.map((q) => clip(q.text, 80)).join(' / '), n: held.length, at: Math.min(...held.map((q) => q.at || now)) });
    if (a.alive && a.waiting?.trust && now - (a.waiting.at || now) >= DIALOG_AFTER) out.push({ id: `trust:${a.id}`, source: 'system', sys: 'trust', agentId: a.id, agentName: a.name, project: base(a.cwd), text: a.cwd || '', at: a.waiting.at || now });
  }
  return out;
}
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

/** The words sent to the terminal that asked: the question with its id, then the answer. */
export function answerText(x, { text = '', option = null, dropped = false } = {}) {
  const label = option != null ? x.options.find((o) => o.key === String(option))?.label || String(option) : '';
  const what = dropped ? `不做了${text ? `：${text}` : ''}` : [label, text].filter(Boolean).join('：');
  return `关于你之前提的问题（${x.id}：${clip(x.text.replace(/\s+/g, ' '), 120)}），用户的答复：${what}`;
}

// the one list of this Fleet Bridge, in its data folder
let main = null;
export function pendingStore() {
  return (main ||= createStore({ file: path.join(DATA_DIR, 'pending.json') }));
}
