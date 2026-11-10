import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { getAgent, inputEmpty, killAgent, listAgents, sendText, spawnAgent } from './agents.js';
import { L } from './i18n.js';
import { cachedSummary } from './summary.js';
import { currentOrg, LIMIT_RE, orgAt, orgInfo } from './accounts.js';

// The master console: a Claude Code session in the command center's left column that commands the
// other agents through the fleet MCP tools (server/fleet-mcp.cjs). It works in its own folder, so its
// session is told apart from the fleet's (no unit card, no reminders, not in the roster), and is
// resumed across restarts so it keeps its memory of what it was doing.
export const MASTER_DIR = path.join(DATA_DIR, 'master');
const STATE_FILE = path.join(DATA_DIR, 'master.json');
const MCP_SCRIPT = path.join(DATA_DIR, 'fleet-mcp.cjs');
const MCP_CONFIG = path.join(DATA_DIR, 'master-mcp.json');

// fleet tools the master may use without asking; answering another agent's permission prompt is
// left out on purpose: that approves something on the user's behalf, so Claude Code asks first
const ALLOWED = ['fleet_status', 'fleet_read_screen', 'fleet_send', 'fleet_key', 'fleet_unqueue', 'fleet_projects', 'fleet_spawn', 'fleet_ui', 'fleet_open'].map((t) => `mcp__fleet__${t}`);

const GUIDE = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时可以用 fleet_read_screen 看全文。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_projects、fleet_ui 这些可以随时用。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.11 default
const GUIDE_V6 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时可以用 fleet_read_screen 看全文。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_projects、fleet_ui 这些可以随时用。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.8 default
const GUIDE_V5 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「@名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「@all」指全部我方 agent。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时可以用 fleet_read_screen 看全文。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你自己不要去改项目代码：具体工作交给对应项目的 agent，你负责拆分任务、分派、跟进和汇总。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.4 default
const GUIDE_V4 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「@名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「@all」指全部我方 agent。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的：某个 agent 弹出了授权框或选择框在等回答。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你自己不要去改项目代码：具体工作交给对应项目的 agent，你负责拆分任务、分派、跟进和汇总。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.2 default
const GUIDE_V3 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「@名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「@all」指全部我方 agent。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你自己不要去改项目代码：具体工作交给对应项目的 agent，你负责拆分任务、分派、跟进和汇总。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.1 default
const GUIDE_V2 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你自己不要去改项目代码：具体工作交给对应项目的 agent，你负责拆分任务、分派、跟进和汇总。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.0 default: replaced by the new one unless the user edited it
const GUIDE_V1 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 你自己不要去改项目代码：具体工作交给对应项目的 agent，你负责拆分任务、分派、跟进和汇总。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

const norm = (p) => path.resolve(p).toLowerCase();
export const isMasterCwd = (cwd) => Boolean(cwd) && norm(cwd) === norm(MASTER_DIR);

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...load(), ...patch }));
  } catch {
    // only resuming is lost
  }
}

let masterId = null;
let savedSession = null;

export function masterAgent() {
  const a = masterId && getAgent(masterId);
  return a || null;
}

/** After a server restart: the master still running in the PTY host is ours again. */
export function adoptMaster() {
  const a = listAgents().find((x) => x.kind === 'master' && x.alive);
  if (a) {
    masterId = a.id;
    savedSession = a.sessionId;
  }
}

export function masterInfo() {
  const a = masterAgent();
  return { id: a?.id || null, alive: Boolean(a?.alive) };
}

// The session's transcript must exist to resume it (a master that never got a message has none).
function transcriptExists(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

function prepare(url) {
  fs.mkdirSync(MASTER_DIR, { recursive: true });
  const guide = path.join(MASTER_DIR, 'CLAUDE.md');
  // the user may edit it: only a missing file or an untouched older default is (re)written
  let current = null;
  try {
    current = fs.readFileSync(guide, 'utf8');
  } catch {
    // none yet
  }
  if (current === null || [GUIDE_V1, GUIDE_V2, GUIDE_V3, GUIDE_V4, GUIDE_V5, GUIDE_V6].includes(current)) fs.writeFileSync(guide, GUIDE);
  // copied out of the app (it may be inside an asar archive, which a plain node process can't read)
  fs.writeFileSync(MCP_SCRIPT, fs.readFileSync(path.join(ROOT, 'server', 'fleet-mcp.cjs')));
  // Electron's own binary runs it as node; under plain node, execPath is node itself
  const config = { mcpServers: { fleet: { type: 'stdio', command: process.execPath, args: [MCP_SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1', FLEET_URL: url } } } };
  fs.writeFileSync(MCP_CONFIG, JSON.stringify(config, null, 2));
}

/** Start the master (resuming its last session when there is one), or return the running one. */
export function startMaster(url, { fresh = false } = {}) {
  const live = masterAgent();
  if (live?.alive) return live;
  prepare(url);
  const last = load().sessionId;
  const resume = !fresh && last && transcriptExists(last) ? last : undefined;
  const agent = spawnAgent({ cwd: MASTER_DIR, name: '主控', resume, kind: 'master', extraArgs: ['--mcp-config', MCP_CONFIG, '--strict-mcp-config', '--allowedTools', ALLOWED.join(',')] });
  masterId = agent.id;
  save({ on: true, sessionId: (savedSession = agent.sessionId) });
  return agent;
}

/** Ended from the command center: not brought back on the next start. */
export function stopMaster() {
  const a = masterAgent();
  if (a?.alive) killAgent(a);
  save({ on: false });
}

/** Called on each publish: follow /clear (new session id) so the next start resumes the right one. */
export function trackMaster() {
  const a = masterAgent();
  if (a?.alive && a.sessionId && a.sessionId !== savedSession) save({ sessionId: (savedSession = a.sessionId) });
}

export const masterWanted = () => Boolean(load().on);

// Questions our agents wait on (permission dialogs, AskUserQuestion, plan approval) are typed into
// the master as a message, so it hears about them without polling. Once per question: what was sent
// is remembered per agent (sameAsk below, not the screen's text as such: a narrower pane wraps it
// differently, a redraw half done reads without its words or its last choice) and forgotten once it is
// answered (keys in that terminal, fleet_answer) or has been gone for a while (not a parse that
// missed it for a moment).
const notified = new Map(); // agentId -> { ask: what was read, at, goneAt }
const firstSeen = new Map(); // agentId -> { at, best }: a question not sent yet, and its fullest reading
const GONE_FORGET = 20_000;
const INCOMPLETE_WAIT = 8_000; // a reading without its words or with one choice waits this long for a full one
const TYPING_PAUSE = 8_000; // after the last real keystroke (inputEmpty() guards text still in the input)

// What makes a question the same question: its words and its fixed choices. Not what changes on the
// screen while it waits: a scroll hint ("Jump to bottom (ctrl+End) ↓"), the key hints, the cursor (❯),
// the ticks on a multi-question's tabs (☐ / ☒ / ✔), nor the free-text choice ("Type something."),
// whose label is what the user is typing into it.
const FREE = /^Type something\.?$/i;
const freeKeys = new Map(); // agentId -> the key of its question's free-text choice
const HINT = /Jump to bottom|ctrl\s*\+\s*End|Esc to (cancel|go back)|Enter to (select|confirm|submit)|Tab\/Arrow keys|↑\/↓|to navigate/i;
export function askKey(x) {
  const p = x.prompt;
  const free = p.options.find((o) => FREE.test(o.label.trim()));
  if (free) freeKeys.set(x.agentId, free.key);
  const text = p.text
    .split('\n')
    .filter((l) => !HINT.test(l))
    .map((l) => l.replace(/[☐☑☒✔✓✗□■●○◉◯❯›▸←→]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  const fixed = p.options.filter((o) => o.key !== freeKeys.get(x.agentId) && !FREE.test(o.label.trim()));
  return `${p.kind}|${text}|${fixed.map((o) => `${o.key}.${o.label.replace(/\s+/g, ' ').trim()}`).join('|')}`;
}

// The same question read twice: the words with no whitespace at all (wrapping only moves line ends and
// spaces), one containing the other (a cut-off reading); with no words read, the choices' labels.
const squash = (s) => String(s || '').replace(/\s+/g, '');
function askParts(x) {
  const p = x.prompt;
  const text = squash(
    p.text
      .split('\n')
      .filter((l) => !HINT.test(l))
      .join('')
      .replace(/[☐☑☒✔✓✗□■●○◉◯❯›▸←→]/g, ''),
  );
  const labels = p.options.filter((o) => o.key !== freeKeys.get(x.agentId) && !FREE.test(o.label.trim())).map((o) => squash(o.label)).filter(Boolean);
  return { kind: p.kind, text, labels };
}
export function sameAsk(a, b) {
  const x = askParts(a);
  const y = askParts(b);
  if (x.kind !== y.kind) return false;
  if (x.text && y.text) return x.text.includes(y.text) || y.text.includes(x.text);
  // no words on one side: the same if their choices overlap (a reading may miss the last one)
  return x.labels.some((l) => y.labels.some((m) => l.includes(m) || m.includes(l)));
}
// a full reading: its words, and more than one choice
const complete = (x) => Boolean(askParts(x).text) && x.prompt.options.length > 1;
// the fuller of two readings of one question
const score = (x) => complete(x) * 1e6 + x.prompt.options.length * 1000 + squash(x.prompt.text).length;
const fuller = (a, b) => (!a || score(b) > score(a) ? b : a);

// The question's words as sentences: the terminal's line breaks joined up again (a word cut at the
// pane's edge back in one piece, a wrapped line joined with a space, CJK with none), a list item, a
// line after a full stop or after a blank line kept on its own (" ⏎ ").
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
const wide = (s) => [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0);
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
export function unwrap(text) {
  const raw = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  const maxW = Math.max(0, ...raw.map(wide));
  const out = [];
  let prev = ''; // the previous line as on the screen (its width tells a wrap from a line end)
  let gap = true;
  for (const r of raw) {
    const l = r.trim();
    if (!l) {
      gap = true;
      continue;
    }
    const last = out[out.length - 1];
    const item = /^(\d+[.)、]|[-•*·▪◦]|[A-Za-z][.)])\s/.test(l);
    const ended = /[。！？!?:：;；.]$/.test(last || '') && wide(prev) < maxW - 2; // a short line ending a sentence: a real line end
    if (gap || item || ended) out.push(l);
    else {
      const a = last.slice(-1);
      // a word cut at the pane's edge: only a word longer than the line is cut (any other wraps whole)
      const word = (last.match(/[\w@.\-/]+$/) || [''])[0] + (l.match(/^[\w@.\-/]+/) || [''])[0];
      const cut = /[\w@.\-/]/.test(a) && /[\w@.\-/]/.test(l[0]) && wide(prev) >= maxW && word.length > maxW / 2;
      out[out.length - 1] = last + (cut || CJK.test(a) || CJK.test(l[0]) ? '' : ' ') + l;
    }
    prev = r;
    gap = false;
  }
  return out.join(' ⏎ ');
}

// Someone is answering in the terminal itself (keys typed into it lately, or text in the free-text
// choice): no "waiting for an answer" notice now; if the question is still there when they stop, it is.
const ANSWERING_PAUSE = 30_000;
export function answering(x) {
  const a = getAgent(x.agentId);
  if (a?.keyAt && Date.now() - a.keyAt < ANSWERING_PAUSE) return true;
  const fk = freeKeys.get(x.agentId);
  const free = fk && x.prompt.options.find((o) => o.key === fk);
  return Boolean(free && free.label.trim() && !FREE.test(free.label.trim()));
}

function notice(x) {
  const kind = x.prompt.kind === 'permission' ? L('授权', 'a permission', '承認') : L('回答', 'an answer', '回答');
  const opts = x.prompt.options.map((o) => `${o.key}. ${o.label}`).join(' / ');
  const text = unwrap(x.prompt.text).slice(0, 1200);
  return L(
    `【舰桥通知】${x.name}（${x.agentId.slice(0, 8)}）在等${kind}：${text || '（见选项）'} ｜ 选项：${opts}`,
    `[Fleet notice] ${x.name} (${x.agentId.slice(0, 8)}) is waiting for ${kind}: ${text || '(see options)'} | Options: ${opts}`,
    `【艦橋通知】${x.name}（${x.agentId.slice(0, 8)}）が${kind}を待っています：${text || '（選択肢を参照）'} ｜ 選択肢：${opts}`,
  );
}

// Turns the master gave out that have ended (server/turns.js): waiting here until they can be typed in
// (kept in <data>/master-finished.json as well, so an update in between doesn't lose them).
const FINISHED_FILE = path.join(DATA_DIR, 'master-finished.json');
const finished = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(FINISHED_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
})(); // { agentId, name, text, ms, reply, cut, at }
let finishedSaved = JSON.stringify(finished);
function saveFinished() {
  const s = JSON.stringify(finished);
  if (s === finishedSaved) return;
  finishedSaved = s;
  try {
    fs.writeFileSync(FINISHED_FILE, s);
  } catch {
    // kept in memory only
  }
}

const mins = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? L(`${s} 秒`, `${s}s`, `${s} 秒`) : s < 3600 ? L(`${Math.round(s / 60)} 分钟`, `${Math.round(s / 60)} min`, `${Math.round(s / 60)} 分`) : L(`${(s / 3600).toFixed(1)} 小时`, `${(s / 3600).toFixed(1)} h`, `${(s / 3600).toFixed(1)} 時間`);
};

export function doneNotice(x) {
  const order = x.text.replace(/\s+/g, ' ').trim();
  const head = order.length > 40 ? order.slice(0, 40) + '…' : order;
  const reply = x.reply
    ? `${L('回答：', 'Answer:', '回答：')}\n${x.reply}${x.cut ? '\n' + L('（太长已截断，完整内容用 fleet_read_screen 查看）', '(cut: fleet_read_screen shows it in full)', '（長いため省略。全文は fleet_read_screen で確認）') : ''}`
    : L('（没取到回答，用 fleet_read_screen 查看）', '(no answer found: see fleet_read_screen)', '（回答を取得できません。fleet_read_screen で確認）');
  // never ran: idle a minute with nothing of the order in its transcript (a dialog before it was cancelled)
  if (x.neverRan)
    return L(
      `【舰桥通知】未执行：${x.name}（${x.agentId.slice(0, 8)}）没有执行你派的指令「${head}」：已经空闲 1 分钟，会话记录里没有这条指令的任何动作（多半是指令前弹出的对话框被取消了，指令没送进去）。请用 fleet_read_screen 看屏幕，需要的话重新派。`,
      `[Fleet notice] Not run: ${x.name} (${x.agentId.slice(0, 8)}) did not run your order "${head}": idle for a minute with nothing of it in its transcript (most likely a dialog shown before it was cancelled and the order dropped). See fleet_read_screen, and send it again if needed.`,
      `【艦橋通知】未実行：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を実行していません。1 分間待機のままで、会話記録にこの指示の動きがありません（直前のダイアログがキャンセルされ、指示が届かなかった可能性）。fleet_read_screen で画面を確認し、必要なら再送してください。`,
    );
  // stopped by the user (Esc, a tool use turned down): not done, and it waits for what to do instead
  if (x.interrupted)
    return L(
      `【舰桥通知】中断：${x.name}（${x.agentId.slice(0, 8)}）没做完你派的指令「${head}」，用时 ${mins(x.ms)}，被中断了（按了 Esc 或拒绝了工具调用），正等着新的指示。\n${x.reply ? reply : '（中断前没有回答，屏幕用 fleet_read_screen 查看）'}`,
      `[Fleet notice] Interrupted: ${x.name} (${x.agentId.slice(0, 8)}) did not finish your order "${head}": stopped after ${mins(x.ms)} (Esc, or a tool use turned down) and waits for what to do instead.\n${x.reply ? reply : '(no answer before it stopped: see fleet_read_screen)'}`,
      `【艦橋通知】中断：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を完了せず、${mins(x.ms)} 後に中断されました（Esc またはツール実行の拒否）。次の指示を待っています。\n${x.reply ? reply : '（中断前の回答なし。画面は fleet_read_screen で確認）'}`,
    );
  // stopped on an API error: not done. The quota used up (or credits needed) says whose quota it was
  if (x.error) {
    if (LIMIT_RE.test(x.error)) {
      const org = orgInfo(orgAt(Date.now()) || currentOrg())?.name || L('组织未知', 'unknown organization', '組織不明');
      return L(
        `【舰桥通知】⛔ 额度到限：${x.name}（${x.agentId.slice(0, 8)}）没做完你派的指令「${head}」：「${org}」的额度用完了（${x.error}）。等额度重置后它会接着做，或者用 /login 换到另一个组织。`,
        `[Fleet notice] ⛔ Quota used up: ${x.name} (${x.agentId.slice(0, 8)}) did not finish your order "${head}": the quota of "${org}" is used up (${x.error}). It goes on after the reset, or /login to the other organization.`,
        `【艦橋通知】⛔ 利用枠上限：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を完了していません。「${org}」の利用枠を使い切りました（${x.error}）。リセット後に再開するか、/login で別の組織へ。`,
      );
    }
    return L(
      `【舰桥通知】❗ 出错：${x.name}（${x.agentId.slice(0, 8)}）没做完你派的指令「${head}」，停在一个 API 错误上：${x.error}\n${x.reply ? reply : ''}`,
      `[Fleet notice] ❗ Error: ${x.name} (${x.agentId.slice(0, 8)}) did not finish your order "${head}": it stopped on an API error: ${x.error}\n${x.reply ? reply : ''}`,
      `【艦橋通知】❗ エラー：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を完了していません。API エラーで停止：${x.error}\n${x.reply ? reply : ''}`,
    ).trim();
  }
  // a summary first (the conclusion, what it did, what it needs of the user), then the answer itself
  const s = (x.summaryKey && cachedSummary(x.summaryKey)?.summary) || null;
  const sum = s
    ? [s.title && L('结论：', 'Conclusion: ', '結論：') + s.title, s.result && s.result !== s.title && L('做了什么：', 'What it did: ', '内容：') + s.result, s.needs && L('需要用户：', 'For the user: ', 'ユーザー対応：') + s.needs].filter(Boolean).join('\n') + '\n'
    : '';
  const icon = s?.needs ? '🟡' : '✅';
  return L(
    `【舰桥通知】${icon} 完成：${x.name}（${x.agentId.slice(0, 8)}）做完了你派的指令「${head}」，用时 ${mins(x.ms)}。\n${sum}${reply}`,
    `[Fleet notice] ${icon} Done: ${x.name} (${x.agentId.slice(0, 8)}) finished your order "${head}" in ${mins(x.ms)}.\n${sum}${reply}`,
    `【艦橋通知】${icon} 完了：${x.name}（${x.agentId.slice(0, 8)}）があなたの指示「${head}」を完了（${mins(x.ms)}）。\n${sum}${reply}`,
  );
}

// Done notices already typed in (the last 50, in <data>/master-told.json): one turn is reported once,
// even when it is seen ending twice (a restart around its end, as during an update).
const TOLD_FILE = path.join(DATA_DIR, 'master-told.json');
let told = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(TOLD_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
})(); // { agentId, text, since, at }
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// the same agent, the same order, a turn that began at (about) the same time
const sameTurn = (a, b) => a.agentId === b.agentId && flat(a.text) === flat(b.text) && Math.abs((a.since || 0) - (b.since || 0)) < 30_000;

function rememberTold(done) {
  told = [...told, ...done.map((x) => ({ agentId: x.agentId, text: x.text, since: x.since || 0, at: Date.now() }))].slice(-50);
  try {
    fs.writeFileSync(TOLD_FILE, JSON.stringify(told));
  } catch {
    // kept in memory only
  }
}

/** A turn the master gave out has ended; told with the next notice that can go out (once). */
export function masterTurnDone(x) {
  if (told.some((y) => sameTurn(y, x)) || finished.some((y) => sameTurn(y, x))) return;
  finished.push({ ...x, at: Date.now() });
  if (finished.length > 20) finished.shift();
  saveFinished();
}

/**
 * Questions our agents wait on, and the master's turns that ended, typed into the master in one message.
 * @param {{agentId: string, name: string, project: string, prompt: {kind: string, text: string, options: {key: string, label: string}[]}}[]} asks
 */
export function notifyMaster(asks) {
  // one question per agent (its session can be found twice: by its process and by its id)
  asks = [...new Map(asks.map((x) => [x.agentId, x])).values()];
  const waiting = new Set(asks.map((x) => x.agentId));
  const now0 = Date.now();
  for (const [id, n] of notified) {
    if (waiting.has(id)) {
      n.goneAt = 0;
      continue;
    }
    n.goneAt ||= now0;
    // answered: a new question is new again; otherwise only after a while (not a redraw that hid it)
    if ((getAgent(id)?.answeredAt || 0) > n.at || now0 - n.goneAt > GONE_FORGET) notified.delete(id);
  }
  for (const id of firstSeen.keys()) if (!waiting.has(id)) firstSeen.delete(id);
  for (const id of freeKeys.keys()) if (!waiting.has(id) && !notified.has(id)) freeKeys.delete(id);
  for (const x of asks) {
    askKey(x); // notes its free-text choice
    // the fullest reading of each question not sent yet
    const f = firstSeen.get(x.agentId);
    if (!f || !sameAsk(f.best, x)) firstSeen.set(x.agentId, { at: now0, best: x });
    else f.best = fuller(f.best, x);
  }
  // ended turns wait for the master at most an hour
  while (finished.length && Date.now() - finished[0].at > 3_600_000) finished.shift();
  saveFinished();
  const m = masterAgent();
  if (!m?.alive) return; // nothing sent: they go out once the master is up
  const fresh = asks
    .filter((x) => {
      const n = notified.get(x.agentId);
      if (n && sameAsk(n.ask, x)) return false; // told already, however it reads now
      if (answering(x)) return false;
      const f = firstSeen.get(x.agentId);
      return complete(f.best) || now0 - f.at > INCOMPLETE_WAIT; // a partial reading waits a little for the full one
    })
    .map((x) => firstSeen.get(x.agentId).best);
  if (!fresh.length && !finished.length) return;
  // never type into the middle of what the user is writing to the master: wait for an empty input
  if (Date.now() - (m.typedAt || 0) < TYPING_PAUSE || !inputEmpty(m)) return;
  // a finished turn waits at most 15 s for its model summary (the rules' one is there at once)
  const now = Date.now();
  const ready = (x) => !x.summaryKey || cachedSummary(x.summaryKey)?.done !== false || now - x.at > 15_000;
  if (!fresh.length && !finished.some(ready)) return;
  const done = finished.filter(ready);
  const later = finished.filter((x) => !ready(x));
  finished.splice(0, finished.length, ...later);
  const parts = [...done.map(doneNotice), ...fresh.map(notice)];
  const tail = [];
  if (done.length) tail.push(L('把结果汇总告诉用户', 'sum the results up for the user', '結果をまとめてユーザーに伝える'));
  if (fresh.length) tail.push(L('用 fleet_answer 按编号回答，该由用户决定的先问用户', 'answer with fleet_answer by number, asking the user first when it is theirs to decide', 'fleet_answer で番号を指定して回答。ユーザーが決めるべきものは先に確認'));
  const body = [...parts, L(`（舰桥自动发送：${tail.join('；')}。）`, `(Sent by Fleet Bridge: ${tail.join('; ')}.)`, `（艦橋が自動送信：${tail.join('。')}。）`)].join('\n\n');
  if (!sendText(m, body)) {
    finished.unshift(...done);
    return;
  }
  saveFinished();
  rememberTold(done);
  for (const x of fresh) notified.set(x.agentId, { ask: x, at: Date.now(), goneAt: 0 });
}
