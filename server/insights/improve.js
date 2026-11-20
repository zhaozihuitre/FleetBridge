import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { L } from '../i18n.js';
import { analyze } from './analyze.js';
import { collect } from './collect.js';
import { logEvent } from './events.js';
import { discardImpl, findRepo, finishImpl, followImpl, startImpl, startUpdate, updateResult } from './implement.js';
import { allowed, createStore } from './proposals.js';
import { improveSettings } from './settings.js';

// Self-improvement, put together (docs/self-improve-design.md): when to analyze, what a decision does, following
// a development agent and an update, and telling the user (the master's notices, the phone, the page's state).
// server/index.js hands in what it needs (spawning agents, the transcripts, the master, push…).

const MIN_GAP = 6 * 3_600_000; // between two analyses that weren't asked for
let store = null;
let d = null; // the dependencies
let analyzing = null; // the promise of the analysis running
let lastDueCheck = 0;

const NOTICE_TYPES = ['notice.done', 'notice.interrupted', 'notice.error', 'notice.never_ran'];

export function initImprove(deps) {
  d = deps;
  store = deps.store || createStore(deps.file);
  // a check cut off by a restart is done again
  for (const p of store.list()) if (p.impl?.finishing) p.impl.finishing = false;
  return store;
}

export const proposalStore = () => store;

/** Whether the scheduled analysis is due now. */
export function due(now, last, s, turnsSince) {
  if (!s.enabled) return false;
  if (last && now - last.at < MIN_GAP) return false;
  const slot = new Date(now);
  slot.setHours(s.hour, s.minute, 0, 0);
  if (now >= slot.getTime() && (!last || last.at < slot.getTime())) return true;
  return turnsSince >= s.minTurns;
}

function tell(text, push) {
  try {
    d.masterNote?.(text);
  } catch {
    // the master isn't there: the page shows it anyway
  }
  if (push && improveSettings().push) d.push?.({ title: push.title, message: push.message, tags: ['bulb'], priority: push.priority || 3 });
  d.changed?.();
}

/** One analysis (scheduled, or asked for by the user / the master). */
export function analyzeNow(by = 'user') {
  if (analyzing) return analyzing;
  const s = improveSettings();
  analyzing = (async () => {
    try {
      const data = collect({ days: s.days, masterSession: d.masterSession?.(), transcriptOf: d.transcriptOf, dataDir: d.dataDir || DATA_DIR });
      const r = await analyze({ data, store, settings: s, runModel: s.llm ? d.runModel : null, redact: d.redactOptions?.(), lang: d.lang?.() });
      logEvent('improve.analysis', { by, findings: r.findings, model: r.model, added: r.added.length });
      if (r.added.length) {
        const list = r.added.map((p, i) => `${'①②③④⑤⑥⑦⑧'[i] || i + 1 + '.'} ${p.id} ${p.title}（${p.effort}）`).join('\n');
        tell(
          L(
            `【舰桥通知】💡 改善提案 ${r.added.length} 条：\n${list}\n用 fleet_proposals 看详情（现象、证据、改动、收益、风险），转告用户并问是否同意；只有用户明确同意后才能用 fleet_decide 批准。`,
            `[Fleet notice] 💡 ${r.added.length} improvement proposal(s):\n${list}\nSee fleet_proposals for the details (finding, evidence, change, benefit, risk), tell the user and ask; approve with fleet_decide only after the user clearly agreed.`,
            `【艦橋通知】💡 改善提案 ${r.added.length} 件：\n${list}\nfleet_proposals で詳細を確認し、ユーザーに伝えて同意を確認してください。承認（fleet_decide）はユーザーの明確な同意の後のみ。`,
          ),
          { title: L(`💡 新的改善提案 ${r.added.length} 条`, `💡 ${r.added.length} new improvement proposal(s)`, `💡 新しい改善提案 ${r.added.length} 件`), message: r.added.map((p) => p.title).join('\n') },
        );
      }
      d.changed?.();
      return r;
    } catch (e) {
      store.setLastAnalysis({ at: Date.now(), error: String(e.message || e).slice(0, 200), findings: 0, model: 'failed', added: [] });
      d.changed?.();
      throw e;
    } finally {
      analyzing = null;
    }
  })();
  return analyzing;
}

/**
 * A decision on a proposal: by the user (the page, the phone) or the master on the user's word.
 * approve / retry → its development starts; install → in-place update; rollback; discard; reject; later; new.
 */
export async function decide(id, action, note = '', by = 'user') {
  const p = store.get(id);
  if (!p) throw new Error('unknown_proposal');
  if (!allowed(p.status).includes(action)) throw new Error(`not_allowed:${p.status}:${action}`);
  if (action === 'reject') return store.setStatus(id, 'rejected', by, { decision: { action, note }, note });
  if (action === 'later') return store.setStatus(id, 'later', by, { decision: { action, note }, note });
  if (action === 'new') return store.setStatus(id, 'new', by, { note });
  if (action === 'approve' || action === 'retry') {
    if (store.list().some((x) => x.status === 'implementing')) throw new Error('busy_implementing'); // one at a time
    const repo = findRepo(improveSettings().repo, d.repoCandidates?.() || []);
    if (!repo) throw new Error('no_fleet_repo');
    store.setStatus(id, 'approved', by, { decision: { action, note }, note });
    let impl;
    try {
      impl = startImpl(store.get(id), { repo, dataDir: d.dataDir || DATA_DIR, baseSettings: d.baseSettings?.(), spawnAgent: d.spawnAgent });
    } catch (e) {
      store.setStatus(id, 'failed', 'system', { impl: { reason: 'start-failed', error: String(e.message || e).slice(0, 300) }, note: String(e.message || e) });
      throw e;
    }
    logEvent('improve.start', { id, branch: impl.branch });
    return store.setStatus(id, 'implementing', 'system', { impl: { ...impl, result: null }, note: impl.branch });
  }
  if (action === 'install') {
    if (!p.impl?.worktree) throw new Error('nothing_built');
    const log = startUpdate(p.impl, { dataDir: d.dataDir || DATA_DIR, port: d.port, id, spawn: d.spawnProcess });
    logEvent('improve.install', { id });
    return store.setStatus(id, 'installing', by, { impl: { installLog: log, installAt: Date.now(), prevVersion: d.appVersion?.() || null }, note: log });
  }
  if (action === 'rollback') {
    const log = startUpdate(p.impl, { dataDir: d.dataDir || DATA_DIR, port: d.port, id, spawn: d.spawnProcess }, { rollback: true });
    logEvent('improve.rollback', { id });
    return store.setStatus(id, 'rolling-back', by, { impl: { rollbackLog: log, rollbackAt: Date.now() }, note: log });
  }
  if (action === 'discard') {
    if (p.impl?.agentId) d.endAgent?.(p.impl.agentId);
    const out = p.impl?.worktree ? discardImpl(p.impl) : '';
    return store.setStatus(id, 'discarded', by, { decision: { action, note }, note: out });
  }
  throw new Error('unknown_action');
}

/** On every publish: "later" ones waking, the schedule, development agents, updates under way. */
export function improveTick(units = [], waiting = new Set(), now = Date.now()) {
  if (!store) return;
  store.wake(now);
  const s = improveSettings();
  // the scheduled analysis: looked at once a minute; never with the quota low, in a demo, or with next to
  // nothing to look at (under 20 events in the period)
  if (s.enabled && !analyzing && !d.demo && now - lastDueCheck >= 60_000 && !d.quotaLow?.()) {
    lastDueCheck = now;
    const last = store.lastAnalysis();
    const evs = d.events ? d.events(Math.min(last?.at || now, now - s.days * 86_400_000)) : [];
    const turnsSince = evs.filter((e) => e.at >= (last?.at || 0) && NOTICE_TYPES.includes(e.type)).length;
    if (evs.length >= 20 && due(now, last, s, turnsSince)) analyzeNow('schedule').catch(() => {});
  }
  for (const p of store.list()) {
    if (p.status === 'implementing') followOne(p, units, waiting, now);
    else if (p.status === 'installing' || p.status === 'rolling-back') updateOne(p, now);
  }
}

function followOne(p, units, waiting, now) {
  const impl = p.impl;
  if (impl.finishing) return;
  // the folder-trust dialog of its new folder: ours, so answered yes
  d.trustIfAsked?.(impl.agentId);
  const unit = units.find((u) => u.agentId === impl.agentId);
  const was = impl.seenBusy;
  const st = followImpl(impl, unit, { now, alive: (id) => d.alive(id), waiting: waiting.has(impl.agentId), turnOver: d.turnOver });
  if (st === 'running') {
    if (!was && impl.seenBusy) store.save();
    return;
  }
  if (st === 'gone' || st === 'timeout') {
    if (st === 'timeout') d.endAgent?.(impl.agentId);
    const reason = st === 'gone' ? 'agent-gone' : 'timeout';
    store.setStatus(p.id, 'failed', 'system', { impl: { result: { status: 'failed', reason } }, note: reason });
    report(store.get(p.id));
    return;
  }
  impl.finishing = true;
  const reply = d.turnReply?.(impl.sessionId, impl.startedAt)?.reply || '';
  finishImpl(impl, { reply })
    .then((r) => {
      store.setStatus(p.id, r.status, 'system', { impl: { finishing: false, result: { ...r, reply: undefined }, reply: r.reply.slice(0, 20_000) }, note: r.reason || r.stat.split('\n').pop() || '' });
      logEvent('improve.built', { id: p.id, status: r.status, reason: r.reason, files: r.files.length, tests: r.tests ? `${r.tests.pass}/${r.tests.fail}` : '' });
      report(store.get(p.id));
    })
    .catch((e) => {
      store.setStatus(p.id, 'failed', 'system', { impl: { finishing: false, result: { status: 'failed', reason: 'check-failed', error: String(e.message || e).slice(0, 300) } }, note: String(e.message || e) });
      report(store.get(p.id));
    });
}

function updateOne(p, now) {
  const rollback = p.status === 'rolling-back';
  const r = updateResult(rollback ? p.impl.rollbackLog : p.impl.installLog, rollback ? p.impl.rollbackAt : p.impl.installAt, now);
  if (!r.done) return;
  const status = rollback ? (r.ok ? 'rolled-back' : 'installed') : r.ok ? 'installed' : 'install-failed';
  store.setStatus(p.id, status, 'system', { impl: { [rollback ? 'rollbackResult' : 'installResult']: r }, note: r.tail.split('\n').pop() || '' });
  logEvent(rollback ? 'improve.rolled_back' : 'improve.installed', { id: p.id, ok: r.ok });
  report(store.get(p.id));
}

/** Tells the user (the master, the phone) where a proposal's development or update stands. */
function report(p) {
  const r = p.impl?.result || {};
  const tests = r.tests ? L(`测试 ${r.tests.pass} 通过 / ${r.tests.fail} 失败`, `tests ${r.tests.pass} passed / ${r.tests.fail} failed`, `テスト ${r.tests.pass} 成功 / ${r.tests.fail} 失敗`) : '';
  const files = r.files?.length ? L(`改了 ${r.files.length} 个文件`, `${r.files.length} files changed`, `${r.files.length} ファイル変更`) : '';
  const why = { 'main-repo-changed': L('主仓库工作区在开发期间被改动了（越界或你自己改了），为安全不允许更新', 'the checkout\'s own working tree changed meanwhile (out of bounds, or your own edits): not installable for safety', '開発中にメインの作業ツリーが変更された（範囲外、またはご自身の変更）。安全のため更新不可'), 'no-changes': L('没有任何改动', 'nothing changed', '変更なし'), 'tests-failed': L('测试没通过', 'tests failed', 'テスト失敗'), 'agent-gone': L('开发 agent 退出了', 'the development agent exited', '開発 agent が終了'), timeout: L('超过 4 小时没做完，已停止', 'not done in 4 hours, stopped', '4 時間以内に終わらず停止'), 'check-failed': L('校验出错', 'the check failed', '検証エラー'), 'start-failed': L('启动失败', 'could not start', '起動失敗') }[r.reason] || r.reason || '';
  const msgs = {
    built: [L(`【舰桥通知】🛠 改善提案 ${p.id}「${p.title}」开发完成：${files}，${tests}。分支 ${p.impl.branch}。要就地更新吗？（只有用户同意后才能 fleet_decide install；可先看 diff）`, `[Fleet notice] 🛠 Proposal ${p.id} "${p.title}" built: ${files}, ${tests}. Branch ${p.impl.branch}. Update in place? (fleet_decide install only after the user agreed)`, `【艦橋通知】🛠 改善提案 ${p.id}「${p.title}」の開発完了：${files}、${tests}。ブランチ ${p.impl.branch}。その場で更新しますか？（ユーザーの同意後のみ fleet_decide install）`), L(`🛠 ${p.id} 开发完成，等你决定是否更新`, `🛠 ${p.id} built: update?`, `🛠 ${p.id} 完了：更新しますか`)],
    'needs-installer': [L(`【舰桥通知】🛠 改善提案 ${p.id}「${p.title}」开发完成（${files}，${tests}），但改动涉及外壳或依赖，不能就地更新，需要安装包；分支 ${p.impl.branch} 已保留，请转告用户另行决定。`, `[Fleet notice] 🛠 Proposal ${p.id} "${p.title}" built (${files}, ${tests}) but it changes the shell or dependencies: it needs the installer, not an in-place update. Branch ${p.impl.branch} kept; tell the user.`, `【艦橋通知】🛠 改善提案 ${p.id}「${p.title}」完了（${files}、${tests}）。シェルか依存関係の変更のためインストーラーが必要。ブランチ ${p.impl.branch} を保持。`), L(`🛠 ${p.id} 完成，需要安装包`, `🛠 ${p.id} built, needs the installer`, `🛠 ${p.id} 完了、インストーラーが必要`)],
    failed: [L(`【舰桥通知】❗ 改善提案 ${p.id}「${p.title}」开发未完成：${why}${tests ? '（' + tests + '）' : ''}。可在改善提案里重试或丢弃。`, `[Fleet notice] ❗ Proposal ${p.id} "${p.title}" not built: ${why}${tests ? ' (' + tests + ')' : ''}. Retry or discard it in the proposals.`, `【艦橋通知】❗ 改善提案 ${p.id}「${p.title}」未完了：${why}${tests ? '（' + tests + '）' : ''}。再試行か破棄を。`), L(`❗ ${p.id} 开发未完成`, `❗ ${p.id} not built`, `❗ ${p.id} 未完了`)],
    installed: [L(`【舰桥通知】✅ 改善提案 ${p.id} 已就地更新到 ${p.impl.installResult?.version || ''}${p.impl.installResult?.kept ? '，终端保留 ' + p.impl.installResult.kept : ''}。分支 ${p.impl.branch} 保留，合并与否由用户决定；有问题可回滚。`, `[Fleet notice] ✅ Proposal ${p.id} installed: now ${p.impl.installResult?.version || ''}${p.impl.installResult?.kept ? ', terminals kept ' + p.impl.installResult.kept : ''}. Branch ${p.impl.branch} kept (merging is the user's call); it can be rolled back.`, `【艦橋通知】✅ 改善提案 ${p.id} を更新：${p.impl.installResult?.version || ''}。ブランチ ${p.impl.branch} は保持。問題があればロールバック可。`), L(`✅ ${p.id} 已更新`, `✅ ${p.id} installed`, `✅ ${p.id} 更新済み`)],
    'install-failed': [L(`【舰桥通知】❗ 改善提案 ${p.id} 更新失败，已回到原来的版本：${p.impl.installResult?.tail?.split('\n').pop() || ''}`, `[Fleet notice] ❗ Proposal ${p.id}: the update failed and the app is back on its previous version: ${p.impl.installResult?.tail?.split('\n').pop() || ''}`, `【艦橋通知】❗ 改善提案 ${p.id} の更新失敗、元のバージョンに戻りました：${p.impl.installResult?.tail?.split('\n').pop() || ''}`), L(`❗ ${p.id} 更新失败，已回退`, `❗ ${p.id} update failed, rolled back`, `❗ ${p.id} 更新失敗、ロールバック済み`)],
    'rolled-back': [L(`【舰桥通知】↩ 改善提案 ${p.id} 已回滚到 ${p.impl.rollbackResult?.version || '之前的版本'}。`, `[Fleet notice] ↩ Proposal ${p.id} rolled back to ${p.impl.rollbackResult?.version || 'the previous version'}.`, `【艦橋通知】↩ 改善提案 ${p.id} を ${p.impl.rollbackResult?.version || '以前のバージョン'} にロールバック。`), L(`↩ ${p.id} 已回滚`, `↩ ${p.id} rolled back`, `↩ ${p.id} ロールバック済み`)],
  };
  const m = msgs[p.status];
  if (m) tell(m[0], { title: m[1], message: p.title, priority: p.status === 'built' ? 4 : 3 });
}

/** For the page's state: the counts and switches (the list itself is fetched from /api/proposals). */
export function improveState() {
  if (!store) return null;
  const items = store.list();
  const count = (st) => items.filter((p) => st.includes(p.status)).length;
  return {
    settings: improveSettings(),
    pending: count(['new']),
    waiting: count(['built', 'install-failed']), // waiting on the user's word to update
    running: count(['implementing', 'installing', 'rolling-back']),
    analyzing: Boolean(analyzing),
    last: store.lastAnalysis(),
    stamp: items.reduce((m, p) => Math.max(m, p.updatedAt || 0), 0),
  };
}

export const improveDir = () => path.join(d?.dataDir || DATA_DIR, 'improve');
