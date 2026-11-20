import { detect } from './detectors.js';
import { redact, redactDeep } from './redact.js';

// One self-improvement analysis: the collected data (collect.js) → the rules' findings (detectors.js) →
// (optional) the model writes the proposals from a redacted digest → the proposal store (proposals.js).
// Nothing reaches the model unredacted. A proposal of the model's must cite evidence that was in its
// input (a ref or a metric given to it): what it can't back up is dropped, so nothing is made up.

const SAMPLE_MASTER = 30; // the user's latest messages to the master given as samples
const SAMPLE_ORDERS = 30;
const MAX_INPUT = 30_000; // characters of the model's input

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (flat(s).length > n ? flat(s).slice(0, n) + '…' : flat(s));
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** What the model gets, redacted, and the refs and metric names it may cite. */
export function digest(data, findings, o = {}) {
  const r = (v) => redactDeep(v, o.redact);
  const samples = [
    ...data.masterSays.slice(-SAMPLE_MASTER).map((m) => ({ ref: `master:${iso(m.at)}`, text: cut(m.text, 300) })),
    ...data.orders
      .filter((x) => ['sent', 'queued'].includes(x.kind))
      .slice(-SAMPLE_ORDERS)
      .map((x) => ({ ref: `order:${iso(x.at)} ${x.name || ''}`.trim(), via: x.via, text: cut(x.text, 300) })),
  ];
  const counts = {};
  for (const e of data.events) counts[e.type] = (counts[e.type] || 0) + 1;
  const sessions = data.sessions.map((s) => ({ name: s.name, toolCalls: s.toolCalls, toolErrors: s.toolErrors.length, stopHooks: s.stopHooks, interrupts: s.interrupts }));
  const input = r({
    period: { days: data.days, from: iso(data.since), to: iso(data.now) },
    eventCounts: counts,
    sessions,
    findings: findings.map((f) => ({ fingerprint: f.fingerprint, title: f.title, finding: f.finding, metric: f.metric, evidence: f.evidence, change: f.change })),
    samples,
  });
  const refs = new Set();
  const metrics = new Set();
  for (const f of input.findings) {
    if (f.metric?.name) metrics.add(f.metric.name);
    for (const e of f.evidence || []) {
      if (e.ref) refs.add(e.ref);
      if (e.metric) metrics.add(e.metric);
    }
  }
  for (const s of input.samples) refs.add(s.ref);
  for (const k of Object.keys(counts)) metrics.add(`count:${k}`);
  return { input, refs, metrics };
}

export function buildPrompt(input, o = {}) {
  const lang = { zh: '简体中文', en: 'English', ja: '日本語' }[o.lang] || '简体中文';
  let json = JSON.stringify(input);
  if (json.length > MAX_INPUT) {
    // the samples go first, then the findings' evidence, until it fits
    const x = structuredClone(input);
    while (JSON.stringify(x).length > MAX_INPUT && x.samples.length) x.samples.shift();
    for (const f of x.findings) if (JSON.stringify(x).length > MAX_INPUT) f.evidence = f.evidence.slice(0, 1);
    json = JSON.stringify(x).slice(0, MAX_INPUT);
  }
  const existing = (o.existing || []).map((p) => `- [${p.status}] ${p.title}${p.why ? `（理由：${cut(p.why, 80)}）` : ''}`).join('\n') || '（无）';
  return `你是「舰桥 Fleet Bridge」的产品改进分析员。舰桥是一个在 Windows 上同时指挥多个 Claude Code 终端（agent）的桌面程序：有一个「主控」会话替用户给各 agent 派指令、收完成通知、转告授权请求。
下面是本机最近一段时间的使用统计、规则检测出的问题和用户原话样本（都已脱敏）。请找出最值得改进的痛点和使用习惯，写成改善提案。

要求：
- 只输出一个 JSON 数组，不要任何别的文字。用${lang}写。最多 6 条，按价值排序。
- 每条：{"title": "一句话（≤30 字）", "basis": "所依据的规则发现的 fingerprint；不是基于规则发现的写 model:英文短语义键（如 model:quick-orders）", "finding": "现象（引用数字）", "evidence": [{"ref": "输入里出现过的 ref"} 或 {"metric": "输入里出现过的 metric 名", "value": "数值"}，可带 "quote"], "change": "建议改动：具体到舰桥的哪部分", "benefit": "预期收益", "effort": "S|M|L", "risk": "风险"}
- evidence 只能引用输入里真实出现过的 ref（如 "master:2026-11-18 14:02"、"order:…"、"event:…"、"session:…"）或 metric 名（findings 里的 metric.name，或 "count:<事件类型>"），不能编造；没有证据支撑的提案不要写。
- 改进只针对舰桥自身（它的通知、主控说明、指挥中心界面、agent 的系统提示与设置），不要建议改用户的其他项目。
- 不要重复下面已有的提案，也不要换个说法重提被拒绝（rejected）的：
${existing}

【数据】
${json}`;
}

/** The model's answer → proposals, keeping only evidence that was in its input (and only proposals with some). */
export function parseModel(out, allowed) {
  const m = String(out || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no json array');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error('not an array');
  const ok = [];
  for (const x of arr.slice(0, 8)) {
    if (!x || typeof x.title !== 'string' || !x.title.trim()) continue;
    const evidence = (Array.isArray(x.evidence) ? x.evidence : []).filter((e) => e && ((e.ref && allowed.refs.has(String(e.ref))) || (e.metric && allowed.metrics.has(String(e.metric))))).map((e) => ({ ...(e.ref ? { ref: String(e.ref) } : { metric: String(e.metric), value: String(e.value ?? '') }), ...(e.quote ? { quote: cut(e.quote, 200) } : {}) }));
    if (!evidence.length) continue; // nothing to back it up
    const basis = String(x.basis || '').trim();
    const fingerprint = /^model:[a-z0-9-]{2,40}$/.test(basis) || allowed.fingerprints?.has(basis) ? basis : `model:${x.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x' + Math.abs(hash(x.title))}`;
    ok.push({ title: cut(x.title, 120), fingerprint, finding: String(x.finding || ''), evidence, change: String(x.change || ''), benefit: String(x.benefit || ''), effort: ['S', 'M', 'L'].includes(x.effort) ? x.effort : 'M', risk: String(x.risk || ''), source: 'model' });
  }
  return ok;
}
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/**
 * @param {{ data: object, store: object, settings: object, runModel?: (prompt: string, o: object) => Promise<string>,
 *   redact?: object, lang?: string, now?: number }} o
 * @returns {Promise<{ findings: number, model: 'used'|'off'|'failed', error?: string, added: object[], updated: object[], skipped: object[] }>}
 */
export async function analyze(o) {
  const now = o.now || Date.now();
  const findings = detect(o.data).map((f) => ({ ...redactDeep(f, o.redact), source: 'rules' }));
  let cands = findings;
  let model = 'off';
  let error;
  if (o.settings.llm && o.runModel) {
    try {
      const d = digest(o.data, findings, o);
      const prompt = buildPrompt(d.input, { lang: o.lang, existing: o.store.titles() });
      if (o.onPrompt) o.onPrompt(prompt); // tests: what would leave this machine
      const out = await o.runModel(prompt, { model: o.settings.model, timeout: 180_000 });
      const fromModel = parseModel(out, { ...d, fingerprints: new Set(findings.map((f) => f.fingerprint)) }).map((p) => redactDeep(p, o.redact));
      // the rules' findings the model didn't write up stay as they are
      const covered = new Set(fromModel.map((p) => p.fingerprint));
      cands = [...fromModel, ...findings.filter((f) => !covered.has(f.fingerprint))].map((c) => ({ ...c, count: c.count || findings.find((f) => f.fingerprint === c.fingerprint)?.count || 0 }));
      model = 'used';
    } catch (e) {
      model = 'failed';
      error = String(e.message || e).slice(0, 200);
    }
  }
  const r = o.store.merge(cands, now);
  o.store.setLastAnalysis({ at: now, findings: findings.length, model, error: error || null, added: r.added.map((p) => p.id), updated: r.updated.length, events: o.data.events.length });
  return { findings: findings.length, model, error, ...r };
}

export { redact };
