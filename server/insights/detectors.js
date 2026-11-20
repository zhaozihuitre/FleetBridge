import crypto from 'node:crypto';
import { L } from '../i18n.js';

// The rules' layer of the self-improvement analysis: plain counts over the collected data (collect.js), no
// model. Each detector that finds its signal over its threshold gives a finding that is already a complete
// proposal (template text); the model's layer (analyze.js) can then write it better or add what rules can't
// see. fingerprint: what makes two findings "the same problem" (dedup, never proposing a rejected one again).

const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cut = (s, n = 200) => (flat(s).length > n ? flat(s).slice(0, n) + '…' : flat(s));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fp = (...parts) => parts.join(':') + (parts.length > 1 ? '' : '');
const keyHash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const byType = (d, ...types) => d.events.filter((e) => types.includes(e.type));
const masterTurns = (d) => byType(d, 'notice.done', 'notice.interrupted', 'notice.error', 'notice.never_ran').length;

/* ---------- the detectors ---------- */

// 1. a cut answer, then the master reads the whole of it (or the screen) within 10 minutes
function cutThenRead(d) {
  const cuts = byType(d, 'notice.done').filter((e) => e.cut);
  if (cuts.length < 5) return null;
  const reads = byType(d, 'tool.read_reply', 'tool.read_screen');
  const followed = cuts.filter((c) => reads.some((r) => r.agentId === c.agentId && r.at >= c.at && r.at - c.at < 600_000));
  const rate = pct(followed.length, cuts.length);
  if (rate < 40) return null;
  return {
    fingerprint: fp('cut-then-read'),
    detector: 'cut-then-read',
    count: followed.length,
    metric: { name: 'cut_then_read_rate', value: `${rate}% (${followed.length}/${cuts.length})` },
    evidence: followed.slice(-3).map((c) => ({ ref: `event:${iso(c.at)} ${c.agent || ''}`.trim(), quote: L(`完成通知被截断（回答 ${c.len || '?'} 字），之后读了全文`, `done notice cut (answer ${c.len || '?'} chars), then read in full`, `完了通知が省略（回答 ${c.len || '?'} 字）、その後全文を取得`) })),
    title: L('完成通知截断后主控总要再读全文', 'The master reads the whole answer after most cut notices', '完了通知の省略後、主控がほぼ毎回全文を読み直す'),
    finding: L(`近 ${d.days} 天被截断的完成通知中，${rate}% 在 10 分钟内又用 fleet_read_reply / fleet_read_screen 读了全文。`, `In the last ${d.days} days, ${rate}% of the cut done notices were followed by fleet_read_reply / fleet_read_screen within 10 minutes.`, `直近 ${d.days} 日、省略された完了通知の ${rate}% で 10 分以内に全文を読み直している。`),
    change: L('提高通知里回答的长度上限（turns.js REPLY_MAX），或截断时把汇报标记块完整保留、只截其余部分。', 'Raise the answer length in notices (turns.js REPLY_MAX), or keep the marked report whole when cutting and cut only the rest.', '通知内の回答の上限（turns.js REPLY_MAX）を上げる、または省略時に報告ブロックは全文残す。'),
    benefit: L('主控每轮少一次读全文的工具调用，汇总更快。', 'One tool call less per turn for the master, faster summaries.', '主控のツール呼び出しが毎回 1 回減り、まとめが速くなる。'),
    effort: 'S',
    risk: L('低：通知变长，主控上下文多占一些。', 'Low: longer notices take more of the master\'s context.', '低：通知が長くなり主控のコンテキストを少し多く使う。'),
  };
}

// 2. the user asking the master again ("结果呢", "汇总一下", "继续")
const FOLLOWUP = /^(结果呢|然后呢|怎么样了?|好了吗|做完了吗|进展(如何|呢)?|汇总一下|总结一下|再说一遍|继续|status\??|progress\??|what happened|any update|summari[sz]e|結果は|どうなった|まとめて|続けて)/i;
function masterFollowups(d) {
  const hits = d.masterSays.filter((m) => flat(m.text).length <= 30 && FOLLOWUP.test(flat(m.text)));
  if (hits.length < 5) return null;
  return {
    fingerprint: fp('master-followups'),
    detector: 'master-followups',
    count: hits.length,
    metric: { name: 'master_followups', value: `${hits.length}` },
    evidence: hits.slice(-3).map((m) => ({ ref: `master:${iso(m.at)}`, quote: cut(m.text, 80) })),
    title: L('经常要追问主控「结果呢 / 汇总一下」', 'You often have to ask the master again for results', '主控に「結果は？」と聞き直すことが多い'),
    finding: L(`近 ${d.days} 天对主控说了 ${hits.length} 次这类追问。`, `${hits.length} such follow-ups to the master in the last ${d.days} days.`, `直近 ${d.days} 日でこの種の聞き直しが ${hits.length} 回。`),
    change: L('完成通知后让主控主动给出结论与下一步（改主控说明 GUIDE），并在多个 agent 都完成时合并成一段汇总。', 'Have the master give the conclusion and the next step on its own after a done notice (its GUIDE), and one summary when several agents finish.', '完了通知の後に主控が自ら結論と次の手を伝えるよう GUIDE を変更し、複数完了時はまとめて報告。'),
    benefit: L('少打追问，结论直接出现在主控对话里。', 'Fewer follow-ups: the conclusion comes by itself.', '聞き直しが減り、結論が自動で届く。'),
    effort: 'S',
    risk: L('低：只改主控的说明文字。', 'Low: only the master\'s guide text.', '低：主控の説明文のみ。'),
  };
}

// 3. many screen reads per turn
function readScreenHeavy(d) {
  const reads = byType(d, 'tool.read_screen');
  const turns = masterTurns(d);
  if (reads.length < 10 || reads.length < turns * 1.5) return null;
  const per = turns ? (reads.length / turns).toFixed(1) : String(reads.length);
  const agents = Object.entries(reads.reduce((m, r) => ((m[r.agent || '?'] = (m[r.agent || '?'] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  return {
    fingerprint: fp('read-screen-heavy'),
    detector: 'read-screen-heavy',
    count: reads.length,
    metric: { name: 'read_screen_per_turn', value: `${per} (${reads.length}/${turns})` },
    evidence: [{ metric: 'read_screen_by_agent', value: agents.slice(0, 5).map(([n, c]) => `${n} ${c}`).join(', ') }],
    title: L('主控频繁读屏才能知道 agent 在干什么', 'The master reads screens often to see what agents do', '主控が画面を頻繁に読んで状況を確認している'),
    finding: L(`近 ${d.days} 天读屏 ${reads.length} 次，平均每个回合 ${per} 次。`, `${reads.length} screen reads in ${d.days} days, ${per} per turn.`, `直近 ${d.days} 日で画面読み取り ${reads.length} 回、1 ターン平均 ${per} 回。`),
    change: L('在 fleet_status 里补上每个 agent 当前在做的步骤（最近一次工具调用、已用时、是否卡在对话框），减少读屏需要。', 'Add each agent\'s current step to fleet_status (last tool call, time spent, stuck on a dialog) so screens are needed less.', 'fleet_status に各 agent の現在のステップ（直近のツール、経過時間、ダイアログ待ち）を追加。'),
    benefit: L('主控少花工具调用和上下文在读屏上。', 'Fewer tool calls and less context spent on screens.', '画面読み取りのツール呼び出しとコンテキストを節約。'),
    effort: 'M',
    risk: L('低。', 'Low.', '低。'),
  };
}

// 4. orders that didn't go in
function orderNotTaken(d) {
  const ev = byType(d, 'order.resent', 'order.blocked', 'notice.never_ran');
  if (ev.length < 3) return null;
  const why = Object.entries(ev.reduce((m, e) => ((m[e.reason || e.type] = (m[e.reason || e.type] || 0) + 1), m), {}));
  return {
    fingerprint: fp('order-not-taken'),
    detector: 'order-not-taken',
    count: ev.length,
    metric: { name: 'orders_not_taken', value: why.map(([k, v]) => `${k} ${v}`).join(', ') },
    evidence: ev.slice(-3).map((e) => ({ ref: `event:${iso(e.at)} ${e.agent || ''}`.trim(), quote: `${e.type}${e.reason ? ' · ' + e.reason : ''}${e.text ? ' · ' + cut(e.text, 60) : ''}` })),
    title: L('指令没送进 agent 的情况反复出现', 'Orders keep not getting into agents', '指示が agent に届かないことが繰り返し起きている'),
    finding: L(`近 ${d.days} 天有 ${ev.length} 次指令没送进去或需要重发。`, `${ev.length} orders in ${d.days} days did not go in or had to be sent again.`, `直近 ${d.days} 日で ${ev.length} 回、指示が届かないか再送が必要だった。`),
    change: L('按原因分布排查：对话框识别（agents.js dialogShowing / pickerPrompt）、whenQuiet 的就绪判断、resume 加载时间。', 'Look into the causes by kind: dialog recognition (agents.js dialogShowing / pickerPrompt), whenQuiet\'s readiness check, resume loading time.', '原因別に調査：ダイアログ認識、whenQuiet の準備判定、resume の読み込み時間。'),
    benefit: L('派出的指令一次就送达，不必等重发或手动处理。', 'Orders get in the first time.', '指示が一度で届く。'),
    effort: 'M',
    risk: L('中：涉及给终端打字的时机。', 'Medium: the timing of typing into terminals.', '中：端末への入力タイミングに関わる。'),
  };
}

// 5. permission dialogs that keep coming back and wait long (by what they ask)
function permitWaits(d) {
  const waits = byType(d, 'permit.wait').filter((e) => e.waitMs > 0);
  const groups = new Map();
  for (const w of waits) {
    const k = flat(w.text).split(/[\s(:：]/).slice(0, 2).join(' ').slice(0, 40) || '?';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 5) continue;
    const avg = Math.round(list.reduce((s, w) => s + w.waitMs, 0) / list.length / 1000);
    if (avg < 60) continue;
    out.push({
      fingerprint: fp('permit-wait', keyHash(k)),
      detector: 'permit-wait',
      count: list.length,
      metric: { name: 'permit_wait', value: L(`「${k}」${list.length} 次，平均等 ${avg} 秒`, `"${k}" ${list.length} times, ${avg} s on average`, `「${k}」${list.length} 回、平均 ${avg} 秒`) },
      evidence: list.slice(-3).map((w) => ({ ref: `event:${iso(w.at)} ${w.agent || ''}`.trim(), quote: cut(w.text, 120) })),
      title: L(`同一类授权反复等待：${k}`, `The same permission keeps waiting: ${k}`, `同じ種類の許可待ちが繰り返し発生：${k}`),
      finding: L(`近 ${d.days} 天「${k}」类授权弹出 ${list.length} 次，平均等了 ${avg} 秒才被回答。`, `"${k}" was asked ${list.length} times in ${d.days} days and waited ${avg} s on average.`, `直近 ${d.days} 日で「${k}」の許可が ${list.length} 回、平均 ${avg} 秒待ち。`),
      change: L('在指挥中心提示用户把这一类加入允许列表（只给出建议的规则和放在哪个 settings，不自动修改），或让主控对这类明显无害的请求直接同意。', 'Suggest an allow rule for this kind in the command center (the rule and which settings file, never changed by itself), or let the master approve such plainly harmless requests.', 'この種類を許可リストに入れる提案を表示（ルールと設定ファイルを示すだけで自動変更しない）、または主控が明らかに無害な要求を承認。'),
      benefit: L(`每次少等约 ${avg} 秒，agent 不再停着。`, `About ${avg} s less waiting each time.`, `毎回約 ${avg} 秒の待ちが減る。`),
      effort: 'S',
      risk: L('中：放宽授权要用户自己确认范围。', 'Medium: loosening permissions is the user\'s call.', '中：許可の緩和範囲はユーザーが判断。'),
    });
  }
  return out;
}

// 6. the user stepping in right after (or during) a turn of the master's
function corrections(d) {
  const ev = byType(d, 'order.correction');
  if (ev.length < 4) return null;
  const typed = new Map(d.sessions.map((s) => [s.sessionId, s.typed]));
  const evidence = ev.slice(-3).map((e) => {
    const said = (typed.get(e.agentId) || []).find((m) => m.at >= e.at - 2000 && m.at - e.at < 60_000);
    return { ref: `event:${iso(e.at)} ${e.agent || ''}`.trim(), quote: L(`主控回合${e.during ? '进行中' : `结束 ${Math.round((e.afterMs || 0) / 1000)} 秒后`}，用户经${e.by}补了：${cut(said?.text || e.text || '（终端输入）', 100)}`, `${e.during ? 'during' : `${Math.round((e.afterMs || 0) / 1000)} s after`} the master's turn, the user added via ${e.by}: ${cut(said?.text || e.text || '(typed in the terminal)', 100)}`, `主控ターン${e.during ? '中' : `終了 ${Math.round((e.afterMs || 0) / 1000)} 秒後`}、ユーザーが ${e.by} で追加：${cut(said?.text || e.text || '（端末入力）', 100)}`) };
  });
  return {
    fingerprint: fp('manual-corrections'),
    detector: 'manual-corrections',
    count: ev.length,
    metric: { name: 'manual_corrections', value: `${ev.length}` },
    evidence,
    title: L('主控派完指令后常要手动补充或纠正', 'You often correct or add to the master\'s orders by hand', '主控の指示の後、手で補足・修正することが多い'),
    finding: L(`近 ${d.days} 天有 ${ev.length} 次在主控派的回合中或刚结束时，又在终端 / 输入框 / 手机里给同一个 agent 下了指令。`, `${ev.length} times in ${d.days} days the same agent got another order by hand during or right after the master's turn.`, `直近 ${d.days} 日で ${ev.length} 回、主控のターン中または直後に同じ agent へ手動で指示した。`),
    change: L('给主控的派单加模板（目标、范围、验收标准、汇报格式），并在派单前把用户原话完整带上。', 'Give the master an order template (goal, scope, acceptance, report format) and have it pass the user\'s own words along.', '主控の指示にテンプレート（目的・範囲・受け入れ基準・報告形式）を導入し、ユーザーの原文を添える。'),
    benefit: L('少手动介入，agent 一次做对。', 'Less stepping in, agents get it right the first time.', '手動介入が減る。'),
    effort: 'S',
    risk: L('低。', 'Low.', '低。'),
  };
}

// 7. the same order given again and again
function repeatedOrders(d) {
  const groups = new Map();
  for (const o of d.orders) {
    if (!['sent', 'queued'].includes(o.kind)) continue;
    const k = flat(o.text).slice(0, 40);
    if (k.length < 6) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 3) continue;
    out.push({
      fingerprint: fp('repeated-order', keyHash(k)),
      detector: 'repeated-order',
      count: list.length,
      metric: { name: 'repeated_order', value: `${list.length}` },
      evidence: list.slice(-3).map((o) => ({ ref: `order:${iso(o.at)} ${o.name || ''}`.trim(), quote: cut(o.text, 120) })),
      title: L(`同一条指令反复下：${cut(k, 20)}`, `The same order again and again: ${cut(k, 20)}`, `同じ指示を繰り返し：${cut(k, 20)}`),
      finding: L(`近 ${d.days} 天这条指令下了 ${list.length} 次。`, `Given ${list.length} times in ${d.days} days.`, `直近 ${d.days} 日で ${list.length} 回。`),
      change: L('做成总指令台的快捷指令（一键发送到选中的终端），或写成一个 skill。', 'Make it a quick order on the command desk (one click to the chosen terminals), or a skill.', '総指令台のクイック指示（ワンクリック送信）または skill にする。'),
      benefit: L('少打字，指令内容固定不走样。', 'Less typing, the order stays the same.', '入力が減り内容が安定。'),
      effort: 'S',
      risk: L('低。', 'Low.', '低。'),
    });
  }
  return out;
}

// 8. tool calls failing the same way in several sessions
function toolErrors(d) {
  const groups = new Map();
  for (const s of d.sessions)
    for (const e of s.toolErrors) {
      const k = `${e.tool}: ${e.error.replace(/\d+/g, 'N').slice(0, 60)}`;
      if (!groups.has(k)) groups.set(k, { list: [], sessions: new Set() });
      const g = groups.get(k);
      g.list.push({ ...e, name: s.name });
      g.sessions.add(s.sessionId);
    }
  const out = [];
  for (const [k, g] of [...groups].sort((a, b) => b[1].list.length - a[1].list.length).slice(0, 3)) {
    if (g.list.length < 5 || g.sessions.size < 2) continue;
    out.push({
      fingerprint: fp('tool-error', keyHash(k)),
      detector: 'tool-error',
      count: g.list.length,
      metric: { name: 'tool_error', value: L(`${g.list.length} 次，${g.sessions.size} 个会话`, `${g.list.length} times, ${g.sessions.size} sessions`, `${g.list.length} 回、${g.sessions.size} セッション`) },
      evidence: g.list.slice(-3).map((e) => ({ ref: `session:${e.name} ${iso(e.at)}`, quote: cut(`${e.tool} ${e.arg} → ${e.error}`, 200) })),
      title: L(`工具反复以同样方式失败：${cut(k, 40)}`, `A tool keeps failing the same way: ${cut(k, 40)}`, `ツールが同じ形で繰り返し失敗：${cut(k, 40)}`),
      finding: L(`近 ${d.days} 天在 ${g.sessions.size} 个会话里出现 ${g.list.length} 次。`, `${g.list.length} times in ${g.sessions.size} sessions over ${d.days} days.`, `直近 ${d.days} 日、${g.sessions.size} セッションで ${g.list.length} 回。`),
      change: L('在舰桥给 agent 的系统提示里加一句针对这台机器的提示（例如 Windows 路径、编码、命令差异），避免同样的错误。', 'Add a hint for this machine to the agents\' system prompt (Windows paths, encodings, command differences) so the same error is avoided.', 'agent のシステムプロンプトにこのマシン向けのヒント（Windows のパス、文字コード、コマンド差）を追加。'),
      benefit: L('agent 少走弯路，节省时间和额度。', 'Less trial and error, time and quota saved.', '試行錯誤が減り時間と利用枠を節約。'),
      effort: 'S',
      risk: L('低。', 'Low.', '低。'),
    });
  }
  return out;
}

// 9. turns stopped by the user
function interrupts(d) {
  const n = byType(d, 'notice.interrupted').length + d.sessions.reduce((s, x) => s + x.interrupts, 0);
  if (n < 8) return null;
  const top = d.sessions.filter((s) => s.interrupts).sort((a, b) => b.interrupts - a.interrupts).slice(0, 3);
  return {
    fingerprint: fp('interrupts'),
    detector: 'interrupts',
    count: n,
    metric: { name: 'interrupts', value: `${n}` },
    evidence: top.map((s) => ({ ref: `session:${s.name}`, quote: L(`中断 ${s.interrupts} 次`, `${s.interrupts} interruptions`, `中断 ${s.interrupts} 回`) })),
    title: L('经常中途打断 agent', 'Agents are often stopped midway', 'agent を途中で止めることが多い'),
    finding: L(`近 ${d.days} 天中断了 ${n} 次。`, `${n} interruptions in ${d.days} days.`, `直近 ${d.days} 日で中断 ${n} 回。`),
    change: L('让 agent 在动手前先给出计划（大改动先确认），或在指挥中心加「暂停并提问」按钮代替直接中断。', 'Have agents state a plan before big changes, or add a "pause and ask" button instead of stopping them.', '大きな変更の前に計画を示させる、または「一時停止して質問」ボタンを追加。'),
    benefit: L('少返工。', 'Less rework.', '手戻りが減る。'),
    effort: 'M',
    risk: L('低。', 'Low.', '低。'),
  };
}

// 10. stop hooks sending agents back to work after they ended their turn
function stopHooks(d) {
  const n = d.sessions.reduce((s, x) => s + x.stopHooks, 0);
  const turns = masterTurns(d) || 1;
  if (n < 10) return null;
  return {
    fingerprint: fp('stop-hooks'),
    detector: 'stop-hooks',
    count: n,
    metric: { name: 'stop_hooks', value: `${n} (${(n / turns).toFixed(1)} / turn)` },
    evidence: d.sessions.filter((s) => s.stopHooks).sort((a, b) => b.stopHooks - a.stopHooks).slice(0, 3).map((s) => ({ ref: `session:${s.name}`, quote: L(`stop hook ${s.stopHooks} 次`, `${s.stopHooks} stop hooks`, `stop hook ${s.stopHooks} 回`) })),
    title: L('stop hook 经常把做完的 agent 拦回去', 'Stop hooks often send finished agents back', 'stop hook が完了した agent をよく引き戻す'),
    finding: L(`近 ${d.days} 天 stop hook 触发 ${n} 次。`, `${n} stop hooks in ${d.days} days.`, `直近 ${d.days} 日で stop hook ${n} 回。`),
    change: L('在 agent 的系统提示里提前说明这个 hook 的要求（例如改完代码顺手更新 project-docs），让它在第一次结束前就做完。', 'Tell agents the hook\'s requirement up front in their system prompt (e.g. update project-docs with the code) so it is done before the first end.', 'hook の要件を事前にシステムプロンプトで伝え、最初の終了前に済ませる。'),
    benefit: L('每轮少一次被拦回去的往返。', 'One round trip less per turn.', '毎ターン往復が 1 回減る。'),
    effort: 'S',
    risk: L('低。', 'Low.', '低。'),
  };
}

export const DETECTORS = { cutThenRead, masterFollowups, readScreenHeavy, orderNotTaken, permitWaits, corrections, repeatedOrders, toolErrors, interrupts, stopHooks };

/** Every finding over its threshold. */
export function detect(data) {
  const out = [];
  for (const f of Object.values(DETECTORS)) {
    try {
      const r = f(data);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    } catch {
      // one broken detector doesn't stop the others
    }
  }
  return out;
}
