import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { getAgent, killAgent, spawnAgent } from './agents.js';

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
const ALLOWED = ['fleet_status', 'fleet_read_screen', 'fleet_send', 'fleet_key', 'fleet_unqueue', 'fleet_projects', 'fleet_spawn', 'fleet_ui'].map((t) => `mcp__fleet__${t}`);

const GUIDE = `# 主控 · Fleet Bridge master console

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
  if (current === null || current === GUIDE_V1 || current === GUIDE_V2) fs.writeFileSync(guide, GUIDE);
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
