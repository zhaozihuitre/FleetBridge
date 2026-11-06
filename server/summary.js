import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { getLang, L } from './i18n.js';
import { historyFiles } from './collectors/history.js';

// What a finished turn did, in a few lines, for the notices (desktop, phone, lists, the master):
//  1. the turn is read from the session's transcript: the last prompt and everything after it
//     (the answer, the tools it used, whether it was interrupted or ended on an API error);
//  2. a summary by rules, at once and free: the answer's first real sentence (its opening "OK, let
//     me look" skipped), its result, and what it asks of you (a question at its end);
//  3. for a longer answer, a summary by Haiku (claude -p, on your plan, no tools, no session kept,
//     your hooks not run), within 15 s; if that fails or is late, the rules' summary stands.

const SETTINGS_FILE = path.join(DATA_DIR, 'notify.json');
let settings = loadSettings();
function loadSettings() {
  try {
    return { model: true, modelExternal: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { model: true, modelExternal: false };
  }
}
export const notifySettings = () => ({ ...settings });
export function setNotifySettings(p) {
  for (const k of ['model', 'modelExternal']) if (typeof p?.[k] === 'boolean') settings[k] = p[k];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {
    // kept for this run
  }
  return notifySettings();
}

/* ---------- the turn, from the transcript ---------- */

const found = new Map();
function transcriptOf(sessionId) {
  if (historyFiles.has(sessionId)) return historyFiles.get(sessionId);
  const hit = found.get(sessionId);
  if (hit && (hit.file || Date.now() - hit.at < 5000)) return hit.file;
  let file = null;
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) {
        file = f;
        break;
      }
    }
  } catch {
    // no projects folder
  }
  found.set(sessionId, { file, at: Date.now() }); // a new session's file may not be there yet: not found is retried after 5 s
  return file;
}

function tail(file, bytes = 1_048_576) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf
      .toString('utf8')
      .split('\n')
      .slice(size > len ? 1 : 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const textsOf = (content) => (typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text || '') : []);
const INTERRUPT = /^\[Request interrupted by user/;
// a prompt someone typed (not a tool result, a command's output, a reminder or an interruption mark)
function isPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return false;
  const t = textsOf(c).join('\n').trim();
  return Boolean(t) && !INTERRUPT.test(t) && !/^<(command-|local-command|system-reminder|bash-)/.test(t);
}

/**
 * The session's last turn: its prompt and what followed.
 * ended: the turn is over by the transcript itself (its last answer says end_turn, it was interrupted,
 * or it stopped on an API error), not just a pause between two steps.
 * @returns {null | { prompt: string, promptAt: number, reply: string, said: string, lastAt: number, lastTool: string, interrupted: boolean, error: string, ended: boolean }}
 */
export function lastTurn(sessionId) {
  const file = sessionId && transcriptOf(sessionId);
  if (!file) return null;
  let entries;
  try {
    entries = tail(file).filter((e) => !e.isSidechain);
  } catch {
    return null;
  }
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (isPrompt(entries[i])) {
    start = i;
    break;
  }
  if (start < 0) return null;
  const p = entries[start];
  const turn = { prompt: textsOf(p.message.content).join('\n').trim(), promptAt: Date.parse(p.timestamp || '') || 0, reply: '', said: '', lastAt: 0, lastTool: '', interrupted: false, error: '', ended: false };
  const all = [];
  for (const e of entries.slice(start + 1)) {
    const at = Date.parse(e.timestamp || '') || 0;
    if (e.type === 'user' && textsOf(e.message?.content).some((t) => INTERRUPT.test(t.trim()))) {
      turn.interrupted = true;
      turn.ended = true;
      if (at) turn.lastAt = at;
      continue;
    }
    // a tool result: the turn goes on (a local command like /login or a reminder afterwards doesn't)
    if (e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((c) => c?.type === 'tool_result')) turn.ended = false;
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    if (at) turn.lastAt = at;
    turn.ended = e.isApiErrorMessage || e.message.stop_reason === 'end_turn' || e.message.stop_reason === 'stop_sequence';
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text?.trim()) {
        if (e.isApiErrorMessage) turn.error = c.text.trim();
        else {
          turn.reply = c.text.trim();
          turn.error = '';
          turn.interrupted = false; // it went on and answered after all
          all.push(c.text.trim());
        }
      }
      if (c.type === 'tool_use') {
        const arg = c.input?.command || c.input?.file_path || c.input?.path || c.input?.pattern || c.input?.description || '';
        turn.lastTool = `${c.name}${arg ? ' · ' + String(arg).replace(/\s+/g, ' ').slice(0, 60) : ''}`;
      }
    }
  }
  turn.said = all.join('\n\n');
  return turn;
}

/* ---------- trimming ---------- */

/** Markdown down to plain sentences: no code blocks, tables, headings marks, emphasis or links. */
export function plain(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** At most max characters, cut at the end of a sentence (or clause) when one is near, else with "…". */
export function clipSentence(text, max) {
  const s = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(...['。', '！', '？', '. ', '! ', '? ', '；', '; '].map((p) => head.lastIndexOf(p)));
  if (cut >= max * 0.5) return head.slice(0, cut + 1).trim();
  const soft = Math.max(head.lastIndexOf('，'), head.lastIndexOf(', '), head.lastIndexOf('、'));
  return (soft >= max * 0.6 ? head.slice(0, soft) : head.slice(0, max - 1)).trim() + '…';
}

// (an ASCII ! or ? ends a sentence only right after a word: "! gh auth login" is a command)
const sentences = (s) => s.split(/(?<=[。！？])\s*|(?<=[^\s][!?])\s+|(?<=\.)\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const noTail = (s) => s.replace(/[。；;，,：:\s]+$/, '');
// openers that say nothing: "好的，我来看一下", "OK, let me check", "了解しました"
const OPENER = /^(好的|好|嗯|OK|Okay|Sure|Alright|了解|わかりました|承知|はい|让我|我来|我先|现在|下面|以下|Let me|I'll|I will|Now)[，,。.！!：:\s]|^.{0,30}[:：]$/i;
// What the answer asks of you, strictly: only a choice, a confirmation or something to do. A word like
// "是否" inside a statement ("实际是否可见") or a test report is not; a "需要你" is only one with a verb.
// a question to you: it ends in a question mark and reads as one (a particle, an ask word, or in
// English an auxiliary first), not a fragment like "「RSDEV 环境？"
const ASK_Q = /(吗|呢|吧|么|要不要|需不需要|有没有|是不是|能不能|可不可以|要我|需要我|你(想|要|觉得|看|希望|选|打算|知道)|哪(个|种|一|些|里|条)|怎么|多少|しますか|ますか|でしょうか|どちら)[?？]?$|要不要|是否(需要|要|继续|推送|提交|发布|合并|改|删)|哪(个|种|一|些|条)|^(Should|Shall|Do|Does|Did|Is|Are|Can|Could|Would|Will|Want|Which|What|How|Where|Who|Any)\b/i;
// a request to act or decide ("需要你处理的…" is a noun phrase, "不需要你…" a no: neither counts)
const ASK_DO = /(请你|请(先)?(确认|决定|选择|回复|运行|执行|登录|提供|告诉我|设置|检查|在|看|输入|打开)|(?<![不无])需要你.{0,12}(决定|确认|选|回复|运行|执行|登录|提供|处理|操作|设置|点|输入|扫码|批准|允许|授权|拍板|建|装|看|说|定)(?!的)|等你.{0,10}(确认|决定|拍板|运行|定|说)(?!的)|你来(定|决定|选)|告诉我(之后|以后|后|一下|怎么|哪|具体|是否|前面)|Please (confirm|choose|decide|run|reply|let me know|approve)|let me know|Tell me which|Decision for you|ご確認ください|選んでください|教えてください)/i;
// a heading over what you have to do ("需要你做的", "还在等你决定的：", "For you:"): the line after it
const ASK_HEAD = /^(.{0,8}(需要你|等你|你需要)(做|处理|决定|确认)的?(事|有.{0,3})?|待你处理|For you|Your turn|Decision for you|あなたの対応)[：:]?$/i;
// a list mark ("1. ", "2、", "- "), not a version's "0."
const readable = (x) => x.replace(/^\s*(\d+[.)]\s+|\d+、\s*|[-*•]\s+)/, '').trim();
// what is quoted (「…」) is not asked; "需要你处理的…" is a noun phrase, not a request
const unquoted = (x) => x.replace(/「[^」]*」|“[^”]*”/g, '「」');
const nounPhrase = (x) => /需要你[^，。,；;]{0,12}的(?!话)/.test(x);

/** What an answer asks of you, as one sentence that reads on its own; '' when nothing. */
export function askOf(s) {
  const end = s.slice(-4);
  const q = end.find((x) => /[?？]$/.test(x) && x.length >= 4 && ASK_Q.test(x.replace(/[?？]$/, '')) && !/^[「『"]/.test(x));
  // a short one ("要开始吗？", "Is that acceptable?") reads only with the sentence before it
  if (q) {
    const i = s.lastIndexOf(q);
    return (q.length < 15 || (!/[^ -~]/.test(q) && q.length < 30)) && i > 0 ? clipSentence(`${readable(s[i - 1])} ${q}`, 100).replace(/^.*?([^。！？.!?]{0,80}[。！？.!?]\s*\S.*)$/, '$1') : readable(q);
  }
  const head = s.findIndex((x, i) => i >= s.length - 8 && ASK_HEAD.test(x.trim()));
  if (head >= 0 && s[head + 1]) return readable(s[head + 1]);
  // "要不要改短。": a question written as a statement, as the answer's last words
  const last = s.slice(-2).find((x) => /要不要|是否要/.test(unquoted(x)) && !/需要(业务|对方|他们)/.test(x));
  if (last) return readable(last);
  const d = end.find((x) => ASK_DO.test(unquoted(x)) && !nounPhrase(x));
  return d ? readable(d) : '';
}

/** The rules' summary of an answer. */
export function ruleSummary(reply) {
  const s = sentences(plain(reply));
  const body = s.filter((x) => !OPENER.test(x));
  const first = body[0] || s[0] || '';
  // what it asks of you: a question to you near its end, or a sentence that says you have to act
  let needs = askOf(s);
  if (needs.length < 4) needs = '';
  const rest = body.slice(1).filter((x) => readable(x) !== needs).join(' ');
  return { title: noTail(clipSentence(first, 40)), result: clipSentence(rest || first, 160), needs: clipSentence(needs, 100), by: 'rules' };
}

/* ---------- Haiku ---------- */

let claudeExe = null;
export function useClaude(exe) {
  claudeExe = exe;
}
const MODEL = 'claude-haiku-5-5';
const MODEL_TIMEOUT = 15_000;
let running = 0;
const waiting = [];

function runModel(prompt) {
  return new Promise((resolve, reject) => {
    if (!claudeExe) return reject(new Error('no claude'));
    const p = spawn(claudeExe, ['-p', '--model', MODEL, '--no-session-persistence', '--setting-sources', '', '--tools', '', '--output-format', 'text'], { windowsHide: true, cwd: os.tmpdir(), env: { ...process.env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' } });
    let out = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('timeout'));
    }, MODEL_TIMEOUT);
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error('exit ' + code));
    });
    p.stdin.end(prompt);
  });
}

async function limited(fn) {
  if (running >= 2) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function modelPrompt(order, said) {
  const lang = { zh: '简体中文', en: 'English', ja: '日本語' }[getLang()] || '简体中文';
  return `你在为一条桌面通知写摘要。下面是用户给 AI 编程助手的指令，以及助手这一轮的回答。
只输出一个 JSON 对象，不要任何别的文字，用${lang}写：
{"title": "一句话结论（不超过 30 字）", "result": "做了什么、结果是什么（不超过 120 字）", "needs": "要用户做的选择、确认或操作，没有就是空字符串（不超过 80 字）"}
不要编造回答里没有的内容。
needs 只在回答明确要用户做选择、确认或操作时才写，写成一句不看原文也能懂的话，例如「要不要推送 0.9.27–0.9.40？」「在 Google Cloud 建一个 OAuth 客户端」。
测试结果、改动说明、注意事项、助手自己会做的后续、可做可不做的建议都不算，这些情况 needs 一律留空。

【指令】
${String(order || '').slice(0, 1500)}

【回答】
${String(said || '').slice(-6000)}`;
}

async function modelSummary(order, said) {
  const out = await limited(() => runModel(modelPrompt(order, said)));
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json');
  const j = JSON.parse(m[0]);
  if (!j.title) throw new Error('no title');
  return { title: clipSentence(j.title, 40), result: clipSentence(j.result || '', 160), needs: clipSentence(j.needs || '', 100), by: 'model' };
}

/* ---------- the summary of one turn, once ---------- */

const cache = new Map(); // key -> { rules, model?, done: boolean, at }
const LONG = 300; // a shorter answer is its own summary

/**
 * The summary of a turn, by key (one per ended turn). Returns at once with what is known: the rules'
 * summary, and the model's once it has arrived; done: no better one is coming.
 * @param {{ useModel?: boolean, quotaLow?: boolean }} [o]
 */
export function summarize(key, turn, o = {}) {
  let c = cache.get(key);
  if (!c) {
    c = { rules: ruleSummary(turn.reply || turn.said), model: null, done: true, at: Date.now() };
    const want = settings.model && o.useModel !== false && !o.quotaLow && (turn.said || '').length > LONG && claudeExe;
    if (want) {
      c.done = false;
      modelSummary(turn.prompt, turn.said)
        .then((s) => (c.model = s))
        .catch(() => {}) // the rules' summary stands
        .finally(() => (c.done = true));
    }
    cache.set(key, c);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return { summary: c.model || c.rules, done: c.done };
}

/** What summarize() has for a key so far (null: never asked). */
export function cachedSummary(key) {
  const c = cache.get(key);
  return c ? { summary: c.model || c.rules, done: c.done } : null;
}

export const kindWord = (kind) =>
  ({
    done: L('完成', 'Done', '完了'),
    ask: L('完成，等你决定', 'Done, your call', '完了・判断待ち'),
    permit: L('等授权', 'Needs approval', '承認待ち'),
    question: L('等回答', 'Needs an answer', '回答待ち'),
    interrupted: L('中断', 'Interrupted', '中断'),
    never_ran: L('未执行', 'Not run', '未実行'),
    error: L('出错', 'Error', 'エラー'),
    overload: L('负载过高', 'Context high', 'コンテキスト逼迫'),
    alert: L('额度告急', 'Quota low', '利用枠わずか'),
  })[kind] || kind;

export const kindIcon = (kind) => ({ done: '✅', ask: '🟡', permit: '🔐', question: '❓', interrupted: '⏸', never_ran: '⛔', error: '❗', overload: '⚠', alert: '⚠' })[kind] || '•';
