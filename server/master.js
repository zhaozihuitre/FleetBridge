import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { getAgent, inputEmpty, killAgent, listAgents, sendText, spawnAgent } from './agents.js';
import { L } from './i18n.js';

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
// the master as a message, so it hears about them without polling. Once per question: what was
// sent is remembered per agent and forgotten when the question goes away (answered).
const notified = new Map(); // agentId -> key of the question last sent
const TYPING_PAUSE = 20_000;

const askKey = (p) => `${p.kind}|${p.text}|${p.options.map((o) => o.label).join('|')}`;

function notice(x) {
  const kind = x.prompt.kind === 'permission' ? L('授权', 'a permission', '承認') : L('回答', 'an answer', '回答');
  const opts = x.prompt.options.map((o) => `${o.key}. ${o.label}`).join(' / ');
  const text = x.prompt.text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ⏎ ').slice(0, 1200);
  return L(
    `【舰桥通知】${x.name}（${x.agentId.slice(0, 8)}）在等${kind}：${text || '（见选项）'} ｜ 选项：${opts}`,
    `[Fleet notice] ${x.name} (${x.agentId.slice(0, 8)}) is waiting for ${kind}: ${text || '(see options)'} | Options: ${opts}`,
    `【艦橋通知】${x.name}（${x.agentId.slice(0, 8)}）が${kind}を待っています：${text || '（選択肢を参照）'} ｜ 選択肢：${opts}`,
  );
}

// Turns the master gave out that have ended (server/turns.js): waiting here until they can be typed in.
const finished = []; // { agentId, name, text, ms, reply, cut, at }

const mins = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? L(`${s} 秒`, `${s}s`, `${s} 秒`) : s < 3600 ? L(`${Math.round(s / 60)} 分钟`, `${Math.round(s / 60)} min`, `${Math.round(s / 60)} 分`) : L(`${(s / 3600).toFixed(1)} 小时`, `${(s / 3600).toFixed(1)} h`, `${(s / 3600).toFixed(1)} 時間`);
};

function doneNotice(x) {
  const order = x.text.replace(/\s+/g, ' ').trim();
  const head = order.length > 40 ? order.slice(0, 40) + '…' : order;
  const reply = x.reply
    ? `${L('回答：', 'Answer:', '回答：')}\n${x.reply}${x.cut ? '\n' + L('（太长已截断，完整内容用 fleet_read_screen 查看）', '(cut: fleet_read_screen shows it in full)', '（長いため省略。全文は fleet_read_screen で確認）') : ''}`
    : L('（没取到回答，用 fleet_read_screen 查看）', '(no answer found: see fleet_read_screen)', '（回答を取得できません。fleet_read_screen で確認）');
  return L(
    `【舰桥通知】完成：${x.name}（${x.agentId.slice(0, 8)}）做完了你派的指令「${head}」，用时 ${mins(x.ms)}。\n${reply}`,
    `[Fleet notice] Done: ${x.name} (${x.agentId.slice(0, 8)}) finished your order "${head}" in ${mins(x.ms)}.\n${reply}`,
    `【艦橋通知】完了：${x.name}（${x.agentId.slice(0, 8)}）があなたの指示「${head}」を完了（${mins(x.ms)}）。\n${reply}`,
  );
}

/** A turn the master gave out has ended; told with the next notice that can go out. */
export function masterTurnDone(x) {
  finished.push({ ...x, at: Date.now() });
  if (finished.length > 20) finished.shift();
}

/**
 * Questions our agents wait on, and the master's turns that ended, typed into the master in one message.
 * @param {{agentId: string, name: string, project: string, prompt: {kind: string, text: string, options: {key: string, label: string}[]}}[]} asks
 */
export function notifyMaster(asks) {
  const waiting = new Set(asks.map((x) => x.agentId));
  for (const id of notified.keys()) if (!waiting.has(id)) notified.delete(id); // answered: a new question is new again
  // ended turns wait for the master at most an hour
  while (finished.length && Date.now() - finished[0].at > 3_600_000) finished.shift();
  const m = masterAgent();
  if (!m?.alive) return; // nothing sent: they go out once the master is up
  const fresh = asks.filter((x) => notified.get(x.agentId) !== askKey(x.prompt));
  if (!fresh.length && !finished.length) return;
  // never type into the middle of what the user is writing to the master: wait for an empty input
  if (Date.now() - (m.typedAt || 0) < TYPING_PAUSE || !inputEmpty(m)) return;
  const done = finished.splice(0);
  const parts = [...done.map(doneNotice), ...fresh.map(notice)];
  const tail = [];
  if (done.length) tail.push(L('把结果汇总告诉用户', 'sum the results up for the user', '結果をまとめてユーザーに伝える'));
  if (fresh.length) tail.push(L('用 fleet_answer 按编号回答，该由用户决定的先问用户', 'answer with fleet_answer by number, asking the user first when it is theirs to decide', 'fleet_answer で番号を指定して回答。ユーザーが決めるべきものは先に確認'));
  const body = [...parts, L(`（舰桥自动发送：${tail.join('；')}。）`, `(Sent by Fleet Bridge: ${tail.join('; ')}.)`, `（艦橋が自動送信：${tail.join('。')}。）`)].join('\n\n');
  if (!sendText(m, body)) {
    finished.unshift(...done);
    return;
  }
  for (const x of fresh) notified.set(x.agentId, askKey(x.prompt));
}
