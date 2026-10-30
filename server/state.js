import fs from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';

const DAY = 86_400_000;
const LOG_FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'comms.demo.jsonl' : 'comms.jsonl');
const LOG_KEEP = 200;

// Event kinds double as operator moods; lower number = higher priority (P0..P8).
// PERMIT outranks everything: a session is blocked until you answer it.
export const PRIORITY = { PERMIT: 0, ALERT: 1, OVERLOAD: 2, READY: 3, GIT: 4, SYS: 5, RECHARGED: 6, ENGAGED: 7, STANDBY: 8 };

const snoozed = new Map(); // quest key -> until (ms)
let prev = null;
let log = loadLog();

function loadLog() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-LOG_KEEP);
  } catch {
    return [];
  }
}

function emit(kind, msg, unit = null) {
  const e = { t: Date.now(), kind, msg, unit };
  log.push(e);
  if (log.length > LOG_KEEP) log = log.slice(-LOG_KEEP);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
}

export function snooze(key, minutes) {
  snoozed.set(key, Date.now() + minutes * 60_000);
}

const pct = (n) => `${Math.round(n)}%`;
const remaining = (w) => (w ? Math.max(0, 100 - w.usedPct) : null);

// Every usage limit the API reports (5h, weekly, per-model weekly); older caches only had the two windows.
function limitsOf(usage) {
  if (usage?.limits?.length) return usage.limits;
  return [
    usage?.fiveHour && { key: 'session', label: '5 小时', ...usage.fiveHour },
    usage?.sevenDay && { key: 'weekly_all', label: '本周 · 所有模型', ...usage.sevenDay },
  ].filter(Boolean);
}

function ago(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

// Map Claude's edited file paths onto the repos under a session's cwd.
function touchedRepos(session, repos) {
  const out = {};
  for (const r of repos) {
    const root = r.path.replace(/\\/g, '/').toLowerCase() + '/';
    let lastAt = null;
    for (const [p, at] of session.edits) if (p.startsWith(root) && (!lastAt || at > lastAt)) lastAt = at;
    if (lastAt) out[r.path] = Date.parse(lastAt);
  }
  return out;
}

function buildUnits(sessions, gitByCwd) {
  return sessions.map((s) => {
    const repos = gitByCwd[s.cwd] || [];
    const touched = touchedRepos(s, repos);
    return {
      key: `session:${s.sessionId}`,
      pid: s.pid,
      sessionId: s.sessionId,
      project: s.project,
      cwd: s.cwd,
      name: s.name,
      status: s.status,
      statusSince: s.statusSince,
      permission: s.permission || null,
      model: s.model,
      contextTokens: s.contextTokens,
      contextWindow: s.contextWindow,
      contextPct: s.contextPct,
      lastText: s.lastText,
      lastPrompt: s.lastPrompt,
      lastActivity: s.lastActivity,
      agents: s.agents.map(({ id, type, description, running }) => ({ id, type, description, running })),
      repos: repos.map((r) => ({ ...r, claudeTouchedAt: touched[r.path] || null })),
      gitScanned: s.cwd in gitByCwd,
    };
  });
}

function buildQuests(units, usage, now) {
  const th = config.thresholds;
  const q = [];
  for (const l of limitsOf(usage)) {
    const left = remaining(l);
    if (left !== null && left <= th.energyLowPct)
      q.push({ key: `energy:${l.key}`, kind: 'ALERT', lv: 'S', title: `额度（${l.label}）只剩 ${pct(left)}`, goal: `放慢节奏，或等 ${new Date(l.resetsAt).toLocaleString('zh-CN', { hour12: false })} 回充`, since: usage.fetchedAt });
  }
  for (const u of units) {
    if (u.permission)
      q.push({ key: `permit:${u.sessionId}:${u.permission.at}`, kind: 'PERMIT', lv: 'S', unit: u, title: `${u.project} 等你授权`, goal: u.permission.message || '回到终端确认权限请求', since: u.permission.at });
    if (u.contextPct !== null && u.contextPct >= th.contextWarnPct)
      q.push({ key: `ctx:${u.sessionId}`, kind: 'OVERLOAD', lv: 'S', unit: u, title: `${u.name} 记忆负载 ${pct(u.contextPct)}`, goal: '执行 /compact，或开新会话', since: u.lastActivity });
    if (u.status === 'idle')
      q.push({ key: `ready:${u.sessionId}:${u.statusSince}`, kind: 'READY', lv: 'A', unit: u, title: `${u.project} 待命，等你下一步指令`, goal: u.lastText ? `最后汇报：${u.lastText}` : '回到终端查看结果', since: u.statusSince });
    for (const r of u.repos) {
      if (r.error) continue;
      if (r.conflicts || r.operation)
        q.push({ key: `op:${r.path}`, kind: 'GIT', lv: 'A', unit: u, title: `${r.name} 卡在 ${r.operation || 'merge'} 中途`, goal: '解决冲突后继续或中止', since: now });
      if (r.oldestChangeAt && now - r.oldestChangeAt >= th.staleDirtyDays * DAY)
        q.push({ key: `stale:${r.path}`, kind: 'GIT', lv: 'B', unit: u, title: `${r.name} 有 ${r.changedCount} 个改动 ${ago(now - r.oldestChangeAt)}未提交`, goal: r.upstream ? '提交并推送' : `提交，并为 ${r.branch} 设置上游`, since: r.oldestChangeAt });
      if (r.ahead > 0)
        q.push({ key: `ahead:${r.path}:${r.head?.hash}`, kind: 'GIT', lv: 'B', unit: u, title: `${r.name} 有 ${r.ahead} 个提交没推送`, goal: `git push（${r.branch}）`, since: r.head?.at || now });
    }
  }
  return q
    .filter((x) => !(snoozed.get(x.key) > now))
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || (b.since || 0) - (a.since || 0))
    .map((x) => ({ ...x, unit: x.unit ? { pid: x.unit.pid, project: x.unit.project, name: x.unit.name, sessionId: x.unit.sessionId } : null }));
}

// Compare with the previous tick and write comms entries for transitions only.
function detectEvents(units, usage) {
  const th = config.thresholds;
  if (!prev) return; // first tick: nothing "happened", we just started watching
  const before = new Map(prev.units.map((u) => [u.sessionId, u]));
  const now = new Map(units.map((u) => [u.sessionId, u]));

  const pa = prev.usage?.account?.fingerprint;
  const na = usage?.account?.fingerprint;
  if (pa && na && pa !== na) emit('SYS', `检测到账号切换：${usage.account.email || '新账号'}，档位 ${usage.account.tier || '?'}。`);
  if (usage?.error && !prev.usage?.error)
    emit('SYS', usage.error === 'token_expired' ? '能量数据读取失败：登录令牌过期，打开一次 Claude Code 即可刷新。' : `能量数据读取失败（${usage.error}）。`);

  const prevLimits = new Map(limitsOf(prev.usage).map((l) => [l.key, l]));
  for (const b of limitsOf(usage)) {
    const a = prevLimits.get(b.key);
    if (!a) continue;
    if (b.resetsAt > a.resetsAt + 60_000 && b.usedPct < a.usedPct) emit('RECHARGED', `额度（${b.label}）回充完毕，剩余 ${pct(100 - b.usedPct)}。`);
    const la = 100 - a.usedPct;
    const lb = 100 - b.usedPct;
    if (la > th.energyLowPct && lb <= th.energyLowPct) emit('ALERT', `额度（${b.label}）只剩 ${pct(lb)}，${new Date(b.resetsAt).toLocaleString('zh-CN', { hour12: false })} 回充。`);
  }

  for (const u of units) {
    const p = before.get(u.sessionId);
    if (!p) {
      emit('ENGAGED', `新部队上线：${u.project}（${u.name}）。`, u.project);
      continue;
    }
    if (u.permission && u.permission.at !== p.permission?.at)
      emit('PERMIT', `${u.project} 请求授权：${u.permission.message || '需要你确认'}`, u.project);
    if (p.status === 'busy' && u.status === 'idle') emit('READY', `${u.project} 任务完成，等你下一步指令。${u.lastText ? '「' + u.lastText + '」' : ''}`, u.project);
    if (p.status === 'idle' && u.status === 'busy') emit('ENGAGED', `${u.project} 出击。${u.lastPrompt ? '指令：「' + u.lastPrompt + '」' : ''}`, u.project);
    if ((p.contextPct ?? 0) < th.contextWarnPct && (u.contextPct ?? 0) >= th.contextWarnPct)
      emit('OVERLOAD', `${u.name} 记忆负载 ${pct(u.contextPct)}，建议 /compact。`, u.project);
    if (p.contextPct !== null && u.contextPct !== null && p.contextPct - u.contextPct > 20)
      emit('SYS', `${u.name} 记忆已压缩：${pct(p.contextPct)} → ${pct(u.contextPct)}。`, u.project);
    const pr = p.agents.filter((a) => a.running).length;
    const nr = u.agents.filter((a) => a.running).length;
    if (nr > pr) emit('DRONE', `${u.project} 派出 ${nr - pr} 架僚机：${u.agents.filter((a) => a.running).map((a) => a.description).join('、')}。`, u.project);
    if (pr > 0 && nr === 0) emit('DRONE', `${u.project} 的 ${pr} 架僚机全部返航。`, u.project);

    const prevRepos = new Map(p.repos.map((r) => [r.path, r]));
    for (const r of u.repos) {
      const o = prevRepos.get(r.path);
      if (!o || !r.head || !o.head) continue;
      if (r.head.hash !== o.head.hash) emit('GIT', `${r.name} 新提交 ${r.head.hash}「${r.head.subject}」${r.ahead ? '，还没推送' : ''}。`, u.project);
      else if (o.ahead > 0 && r.ahead === 0) emit('GIT', `${r.name} 已推送到 ${r.upstream}。`, u.project);
    }
  }
  for (const [id, p] of before) if (!now.has(id)) emit('SYS', `部队撤离：${p.project}（${p.name}）的会话已结束。`, p.project);
}

function operatorLine(q) {
  switch (q.kind) {
    case 'PERMIT': return `指挥官！${q.unit.project} 卡在授权确认上，等你批准才能继续。「${q.goal}」`;
    case 'ALERT': return `指挥官，${q.title}。${q.goal}。`;
    case 'OVERLOAD': return `指挥官，${q.title}，再打几轮就会自动压缩。要不要先下令 /compact？`;
    case 'READY': return `${q.unit.project} 做完了，等你下一步指令。${q.goal.startsWith('最后汇报') ? q.goal + '。' : ''}`;
    case 'GIT': return `${q.title}。建议：${q.goal}。`;
    default: return q.title;
  }
}

function operatorState(units, quests, now) {
  const standbyMs = config.thresholds.standbyMinutes * 60_000;
  if (quests.length) {
    // Only long-waiting READY quests left means the commander walked away: doze, but keep the list.
    const dozing = quests.every((q) => q.kind === 'READY' && now - (q.since || 0) > standbyMs);
    return {
      mood: dozing ? 'STANDBY' : quests[0].kind,
      lines: quests.map((q) => ({ key: q.key, kind: q.kind, text: operatorLine(q), unit: q.unit })),
    };
  }
  if (!units.length)
    return { mood: 'STANDBY', lines: [{ key: 'empty', kind: 'STANDBY', text: '现在没有活动的部队。要从最近的存档里挑一个继续吗？' }] };
  const busy = units.filter((u) => u.status === 'busy');
  if (busy.length) return { mood: 'ENGAGED', lines: [{ key: 'engaged', kind: 'ENGAGED', text: `${busy.length} 支部队在推进，我帮你盯着。` }] };
  const quiet = units.every((u) => now - (u.statusSince || 0) > standbyMs);
  return quiet
    ? { mood: 'STANDBY', lines: [{ key: 'standby', kind: 'STANDBY', text: '没人找我……我先进休眠模式。' }] }
    : { mood: 'ENGAGED', lines: [{ key: 'calm', kind: 'ENGAGED', text: '一切正常，随时待命。' }] };
}

export function buildState({ sessions, gitByCwd, usage }) {
  const now = Date.now();
  const units = buildUnits(sessions, gitByCwd);
  detectEvents(units, usage);
  const quests = buildQuests(units, usage, now);
  const state = {
    now,
    usage,
    units,
    quests,
    operator: { ...operatorState(units, quests, now), name: config.operator.name },
    comms: log.slice(-60).reverse(),
    thresholds: config.thresholds,
  };
  prev = { units, usage };
  return state;
}
