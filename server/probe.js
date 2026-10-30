// One-shot snapshot of everything the monitor collects, for checking data without the UI.
import { collectGit } from './collectors/git.js';
import { collectSessions } from './collectors/sessions.js';
import { collectUsage } from './collectors/usage.js';
import { buildState } from './state.js';

const sessions = collectSessions();
const [usage, gitByCwd] = await Promise.all([collectUsage(), collectGit(sessions.map((s) => s.cwd))]);
const state = buildState({ sessions, gitByCwd, usage });
const t = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');

console.log('USAGE', usage.ok ? '' : `ERROR ${usage.error}`);
for (const [k, w] of [['5h', usage.fiveHour], ['7d', usage.sevenDay]]) if (w) console.log(`  ${k}: used ${w.usedPct}%  resets ${t(w.resetsAt)}`);
console.log('  account', usage.account?.email, usage.account?.org, usage.account?.tier);
for (const u of state.units) {
  console.log(`\nUNIT ${u.project} [${u.status}] pid=${u.pid} name=${u.name}`);
  console.log(`  ctx ${u.contextTokens} / ${u.contextWindow} = ${u.contextPct}%  model=${u.model}  last=${t(u.lastActivity)}`);
  console.log(`  text: ${u.lastText}`);
  console.log(`  agents: ${u.agents.map((a) => `${a.type}:${a.running ? 'RUN' : 'done'}`).join(' ') || '-'}`);
  for (const r of u.repos)
    console.log(`  repo ${r.name} ${r.branch} up=${r.upstream || '-'} +${r.ahead}/-${r.behind} changed=${r.changedCount} (+${r.insertions} -${r.deletions}) oldest=${t(r.oldestChangeAt)} head=${r.head?.hash} claude=${t(r.claudeTouchedAt)}${r.error ? ' ERR ' + r.error : ''}`);
}
console.log('\nQUESTS');
for (const q of state.quests) console.log(`  [${q.lv}] ${q.kind} ${q.title} → ${q.goal}`);
console.log('\nOPERATOR', state.operator.mood, '|', state.operator.lines[0]?.text);
