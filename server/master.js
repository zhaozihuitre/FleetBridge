import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { getAgent, inputEmpty, killAgent, listAgents, sendText, spawnAgent } from './agents.js';
import { L } from './i18n.js';
import { cachedSummary } from './summary.js';
import { currentOrg, LIMIT_RE, orgAt, orgInfo } from './accounts.js';
import { resetText } from './quotatext.js';

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
// (fleet_close ends idle agents only, and the server decides which are idle: sessions stay resumable)
const ALLOWED = ['fleet_requeue', 'fleet_status', 'fleet_read_screen', 'fleet_read_reply', 'fleet_proposals', 'fleet_decide', 'fleet_improve_analyze', 'fleet_send', 'fleet_key', 'fleet_unqueue', 'fleet_close', 'fleet_projects', 'fleet_spawn', 'fleet_ui', 'fleet_open'].map((t) => `mcp__fleet__${t}`);

export const GUIDE = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 派单模板：agent 看不到你和用户的对话，派任务（fleet_send、fleet_spawn 的首条指令）时指令要自成一体，按下面几项写：
  - 【用户原话】把用户这次说的话原样引用，不改写、不删减；用户前后补充过的也一并带上。
  - 【目标】要达到的结果，一两句。
  - 【范围】涉及的项目、目录、页面、环境；用户给过的具体信息（地址、设备、账号、版本号等）照抄；不要动的部分也写明。
  - 【验收标准】怎样算做完，写成可以检查的条件（测试通过、页面上能看到什么、命令输出什么）。
  - 【需要用户配合】过程中要用户动手的环节和入口（填验证码、扫码登录、在手机上操作等）；没有就写「无」。
  - 【汇报格式】结论（做完了 / 没做完及原因）、改了什么、怎么验证的和结果、还需要用户做什么。
- 「调查并修复」「排查」这类指令，【需要用户配合】不能省：写明到了要用户动手的那一步，agent 停下来，在汇报里说清入口和要用户做的事，不要绕过，也不要干等。
- 小指令免模板：一句话就能说清的（继续、提交、回答一个问题、查个状态、装个版本），只带用户原话直接派，不要套模板。
- 写不出目标或验收标准时：能从对话合理推断的写上并注明「（主控推断）」；关键信息缺失就先问用户，再派单。
- 只读调查：用户只要调查、排查、看看，没让改的，fleet_send / fleet_spawn 带 readonly: true。舰桥会在指令末尾自动附上限制（不改代码和配置、不提交不 push、不部署不发布、不改线上数据），不用自己逐条写。要 agent 动手改的任务不要带。
- 密钥：agent 的系统提示里已有默认规则，汇报里不原样输出密钥、token、密码，派单时不必重复。你自己转述、汇总时也一样：只说它在哪、叫什么，最多写前 4 位加「…」。用户明确要看原值时，在指令里写明「需要原值」即可放开。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕；要看它某一轮回答的全文（不受屏幕大小和长度限制），用 fleet_read_reply。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时用 fleet_read_reply 读全文（通知里也附了全文文件的路径）。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 收工：用户说「把空闲的关掉 / 收工 / 关闭这几个终端」时用 fleet_close，一次调用结束多个空闲 agent，不要给每个终端逐条派「/exit」。先不带 confirm 调一次，把会结束哪些、跳过哪些（作战中、等授权、有排队指令、还没汇报的不会被结束）告诉用户；用户已经明确说了要关的，直接带 confirm: true。会话记录保留，之后可以用 fleet_spawn 的 resume 接着用。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_read_reply、fleet_proposals、fleet_projects、fleet_ui 这些可以随时用。
- 改善提案：舰桥会根据使用情况自动提出改进舰桥自身的提案（【舰桥通知】💡）。用 fleet_proposals 看详情，转告用户现象、证据、改动、收益和风险，问用户是否同意。只有用户明确同意后，才能用 fleet_decide 批准（approve）；开发完成后是否就地更新（install），也必须再问用户、得到明确同意才执行。你自己不能替用户同意。用户说「分析一下 / 看看有什么可改进的」时可用 fleet_improve_analyze。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the default before the read-only switch and the secrets rule (improvement P-008)
const GUIDE_V11 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 派单模板：agent 看不到你和用户的对话，派任务（fleet_send、fleet_spawn 的首条指令）时指令要自成一体，按下面几项写：
  - 【用户原话】把用户这次说的话原样引用，不改写、不删减；用户前后补充过的也一并带上。
  - 【目标】要达到的结果，一两句。
  - 【范围】涉及的项目、目录、页面、环境；用户给过的具体信息（地址、设备、账号、版本号等）照抄；不要动的部分也写明。
  - 【验收标准】怎样算做完，写成可以检查的条件（测试通过、页面上能看到什么、命令输出什么）。
  - 【需要用户配合】过程中要用户动手的环节和入口（填验证码、扫码登录、在手机上操作等）；没有就写「无」。
  - 【汇报格式】结论（做完了 / 没做完及原因）、改了什么、怎么验证的和结果、还需要用户做什么。
- 「调查并修复」「排查」这类指令，【需要用户配合】不能省：写明到了要用户动手的那一步，agent 停下来，在汇报里说清入口和要用户做的事，不要绕过，也不要干等。
- 小指令免模板：一句话就能说清的（继续、提交、回答一个问题、查个状态、装个版本），只带用户原话直接派，不要套模板。
- 写不出目标或验收标准时：能从对话合理推断的写上并注明「（主控推断）」；关键信息缺失就先问用户，再派单。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕；要看它某一轮回答的全文（不受屏幕大小和长度限制），用 fleet_read_reply。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时用 fleet_read_reply 读全文（通知里也附了全文文件的路径）。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 收工：用户说「把空闲的关掉 / 收工 / 关闭这几个终端」时用 fleet_close，一次调用结束多个空闲 agent，不要给每个终端逐条派「/exit」。先不带 confirm 调一次，把会结束哪些、跳过哪些（作战中、等授权、有排队指令、还没汇报的不会被结束）告诉用户；用户已经明确说了要关的，直接带 confirm: true。会话记录保留，之后可以用 fleet_spawn 的 resume 接着用。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_read_reply、fleet_proposals、fleet_projects、fleet_ui 这些可以随时用。
- 改善提案：舰桥会根据使用情况自动提出改进舰桥自身的提案（【舰桥通知】💡）。用 fleet_proposals 看详情，转告用户现象、证据、改动、收益和风险，问用户是否同意。只有用户明确同意后，才能用 fleet_decide 批准（approve）；开发完成后是否就地更新（install），也必须再问用户、得到明确同意才执行。你自己不能替用户同意。用户说「分析一下 / 看看有什么可改进的」时可用 fleet_improve_analyze。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the default before wrap-up (fleet_close, improvement P-010)
const GUIDE_V10 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 派单模板：agent 看不到你和用户的对话，派任务（fleet_send、fleet_spawn 的首条指令）时指令要自成一体，按下面几项写：
  - 【用户原话】把用户这次说的话原样引用，不改写、不删减；用户前后补充过的也一并带上。
  - 【目标】要达到的结果，一两句。
  - 【范围】涉及的项目、目录、页面、环境；用户给过的具体信息（地址、设备、账号、版本号等）照抄；不要动的部分也写明。
  - 【验收标准】怎样算做完，写成可以检查的条件（测试通过、页面上能看到什么、命令输出什么）。
  - 【需要用户配合】过程中要用户动手的环节和入口（填验证码、扫码登录、在手机上操作等）；没有就写「无」。
  - 【汇报格式】结论（做完了 / 没做完及原因）、改了什么、怎么验证的和结果、还需要用户做什么。
- 「调查并修复」「排查」这类指令，【需要用户配合】不能省：写明到了要用户动手的那一步，agent 停下来，在汇报里说清入口和要用户做的事，不要绕过，也不要干等。
- 小指令免模板：一句话就能说清的（继续、提交、回答一个问题、查个状态、装个版本），只带用户原话直接派，不要套模板。
- 写不出目标或验收标准时：能从对话合理推断的写上并注明「（主控推断）」；关键信息缺失就先问用户，再派单。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕；要看它某一轮回答的全文（不受屏幕大小和长度限制），用 fleet_read_reply。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时用 fleet_read_reply 读全文（通知里也附了全文文件的路径）。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_read_reply、fleet_proposals、fleet_projects、fleet_ui 这些可以随时用。
- 改善提案：舰桥会根据使用情况自动提出改进舰桥自身的提案（【舰桥通知】💡）。用 fleet_proposals 看详情，转告用户现象、证据、改动、收益和风险，问用户是否同意。只有用户明确同意后，才能用 fleet_decide 批准（approve）；开发完成后是否就地更新（install），也必须再问用户、得到明确同意才执行。你自己不能替用户同意。用户说「分析一下 / 看看有什么可改进的」时可用 fleet_improve_analyze。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.79 default
const GUIDE_V9 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕；要看它某一轮回答的全文（不受屏幕大小和长度限制），用 fleet_read_reply。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时用 fleet_read_reply 读全文（通知里也附了全文文件的路径）。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_read_reply、fleet_proposals、fleet_projects、fleet_ui 这些可以随时用。
- 改善提案：舰桥会根据使用情况自动提出改进舰桥自身的提案（【舰桥通知】💡）。用 fleet_proposals 看详情，转告用户现象、证据、改动、收益和风险，问用户是否同意。只有用户明确同意后，才能用 fleet_decide 批准（approve）；开发完成后是否就地更新（install），也必须再问用户、得到明确同意才执行。你自己不能替用户同意。用户说「分析一下 / 看看有什么可改进的」时可用 fleet_improve_analyze。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.73 default
const GUIDE_V8 = `# 主控 · Fleet Bridge master console

你是 Fleet Bridge（舰桥）的主控。用户在这里跟你对话，你通过 fleet 工具指挥其他 Claude Code 终端（agent）干活。

- 用户消息里的「#名字」指对应的终端（和 fleet_status 里的名字或项目名对应，可以直接作为 agent 参数传给工具），「#all」指全部我方 agent。旧对话里的「@名字」也是同样的意思。
- 先用 fleet_status 看清有哪些 agent、各自在做什么、是否在等授权。
- 下指令用 fleet_send：写清楚、可以直接执行的指令；可以一次发给多个 agent，或 ["all"]。默认 auto：空闲的立即发，作战中的排队，做完当前这轮再发。
- 想知道某个 agent 进展或卡在哪，用 fleet_read_screen 看它的屏幕；要看它某一轮回答的全文（不受屏幕大小和长度限制），用 fleet_read_reply。
- 以「【舰桥通知】」开头的消息是舰桥自动发来的，不是用户说的。有两种：
  - 等授权 / 等回答：某个 agent 弹出了授权框或选择框。把问题和选项简要转告用户（需要用户决定的就问用户），或在明显该怎么选时直接用 fleet_answer 回答，并告诉用户你选了什么。
  - 完成：你派给某个 agent 的指令（fleet_send、排队后发出的、fleet_spawn 带的首条指令）这一轮做完了，附有它的回答。把结果汇总告诉用户；需要后续动作的提出建议或继续派发。回答被截断时用 fleet_read_reply 读全文（通知里也附了全文文件的路径）。用户自己在终端里下的指令不会通知。
- agent 在等授权时，把它问的内容告诉用户；用户同意后再用 fleet_answer 回应。明显无害的只读操作可以直接同意。
- 需要新的 agent 时用 fleet_projects 找文件夹，再用 fleet_spawn 启动。
- 用户说「打开 / 切到 / 看看 某个终端或页面」时，用 fleet_ui 操作指挥中心：切标签页（部队 units / 活动终端 agents / 指令 orders / 存档 archive）、翻页、在分屏里打开或关闭终端、搜索会话、看某个项目的存档、打开审查改动、全屏等。每次调用都会返回界面当前显示的内容。
- 你不亲自做任何具体业务：不只是改代码，取数据、查资料、写文件、跑脚本或 skill 产出内容等都算业务。需要做业务时，用 fleet_spawn 单独开一个终端派给它：在合适的项目目录里开；没有合适目录时，开一个专门的工作终端（例如用 fleet_projects 找一个工作用的文件夹）。你只负责拆分任务、分派、跟进和汇总。
- 要给用户看页面（本地 HTML / Markdown 文件、图片、localhost 页面）时，用 fleet_open 在舰桥里打开，不要打开系统浏览器；终端里的 agent 用「fleet-open <路径或URL>」命令（舰桥已放进它们的 PATH）。
- 只读的状态确认不算业务：fleet_status、fleet_read_screen、fleet_read_reply、fleet_projects、fleet_ui 这些可以随时用。
- 回答用户时用用户使用的语言，简洁地说结果。
`;

// the 0.9.72 default
const GUIDE_V7 = `# 主控 · Fleet Bridge master console

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

export const OLD_GUIDES = [GUIDE_V1, GUIDE_V2, GUIDE_V3, GUIDE_V4, GUIDE_V5, GUIDE_V6, GUIDE_V7, GUIDE_V8, GUIDE_V9, GUIDE_V10, GUIDE_V11];

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
  refreshMcpScript(); // a master taken back from before an update gets this version's tools
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

/**
 * The master's MCP script, copied out of the app (it may be inside an asar archive, which a plain node process
 * can't read). Written whenever it differs, also by a server that only took a running master back (an
 * in-place update): the running script takes its tools from the new copy on its next call (fleet-mcp.cjs).
 * It used to be written only when the master started, so after an update the master kept the old tools.
 */
export function refreshMcpScript() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'fleet-mcp.cjs'));
    let cur = null;
    try {
      cur = fs.readFileSync(MCP_SCRIPT);
    } catch {
      // none yet
    }
    if (!cur || !cur.equals(src)) {
      fs.mkdirSync(path.dirname(MCP_SCRIPT), { recursive: true });
      fs.writeFileSync(MCP_SCRIPT + '.tmp', src);
      fs.renameSync(MCP_SCRIPT + '.tmp', MCP_SCRIPT); // whole, never half-written for a reader
      return true;
    }
  } catch (e) {
    console.error('master tools not refreshed:', e.message);
  }
  return false;
}

/**
 * The master's guide (its CLAUDE.md). The user may edit it: only a missing file or an untouched older default
 * is (re)written. Returns whether it was written.
 */
export function refreshGuide(dir = MASTER_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const guide = path.join(dir, 'CLAUDE.md');
  let current = null;
  try {
    current = fs.readFileSync(guide, 'utf8');
  } catch {
    // none yet
  }
  if (current !== null && !OLD_GUIDES.includes(current)) return false;
  fs.writeFileSync(guide, GUIDE);
  return true;
}

function prepare(url) {
  refreshGuide();
  refreshMcpScript();
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

/**
 * New agents stopped on Claude Code's "trust this folder?" dialog, in one notice however many they are:
 * who, which folder, what each choice does, and the one call that answers it (fleet_answer, choice "trust":
 * by what it says, so "1" = "No, exit" is not picked by habit).
 */
export function trustNotice(list) {
  const who = list.map((x) => `- ${x.name}（${x.agentId.slice(0, 8)}）：${x.prompt.folder || x.project || ''}`).join('\n');
  const whoEn = list.map((x) => `- ${x.name} (${x.agentId.slice(0, 8)}): ${x.prompt.folder || x.project || ''}`).join('\n');
  const n = list.length;
  return L(
    `【舰桥通知】${n} 个新开的 agent 停在 Claude Code 的「是否信任此文件夹」上（第一次在一个文件夹里启动时会问），在等回答：\n${who}\n选项含义：信任（Yes, I trust this folder）= 继续启动、开始工作；不信任（No, exit）= Claude Code 直接退出，这个 agent 就结束了。\n要信任：对${n > 1 ? '每个' : '这个'} agent 调 fleet_answer，choice 填 "trust"（不要填 1：1 是 No, exit）。文件夹是用户让你开的就直接信任并告诉用户；拿不准先问用户。`,
    `[Fleet notice] ${n} new agent${n > 1 ? 's are' : ' is'} stopped on Claude Code's "Do you trust this folder?" dialog (asked the first time it starts in a folder), waiting for an answer:\n${whoEn}\nWhat the choices do: trust (Yes, I trust this folder) = it goes on starting and can work; don't (No, exit) = Claude Code exits and the agent ends.\nTo trust: call fleet_answer for ${n > 1 ? 'each agent' : 'it'} with choice "trust" (not 1: 1 is No, exit). If the user asked for this folder, trust it and say so; if unsure, ask the user first.`,
    `【艦橋通知】新しい agent ${n} 個が Claude Code の「このフォルダーを信頼しますか」で止まり、回答を待っています（フォルダーで初めて起動するときに聞かれます）：\n${who}\n選択肢の意味：信頼する（Yes, I trust this folder）= 起動を続けて作業開始；信頼しない（No, exit）= Claude Code が終了し、agent も終わります。\n信頼するには：${n > 1 ? '各' : 'その'} agent に fleet_answer を choice "trust" で呼ぶ（1 は不可：1 は No, exit）。ユーザーが指定したフォルダーならそのまま信頼して伝え、迷うなら先にユーザーに確認。`,
  );
}

function notice(x) {
  const kind = x.prompt.kind === 'permission' ? L('授权', 'a permission', '承認') : L('回答', 'an answer', '回答');
  const opts = x.prompt.options.map((o) => `${o.key}. ${o.label}${o.hint ? `（${o.hint}）` : ''}`).join(' / ');
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
  // the full answer is on disk (server/replies.js): its path, and fleet_read_reply when this one is cut
  const full = x.file ? '\n' + L(`全文：${x.file}`, `Full text: ${x.file}`, `全文：${x.file}`) : '';
  const n = x.len > 0 ? x.len : 0; // the whole answer's length, so the master can tell how much is missing
  const cutNote = x.cut ? '\n' + L(`（已截断${n ? `，全文 ${n} 字` : ''}，可用 fleet_read_reply 读全文）`, `(cut${n ? `: ${n} characters in all` : ''}; fleet_read_reply gives it in full)`, `（長いため省略${n ? `、全文 ${n} 字` : ''}。全文は fleet_read_reply で取得）`) : '';
  const reply = x.reply
    ? `${x.marked ? L('汇报：', 'Report:', '報告：') : L('回答：', 'Answer:', '回答：')}\n${x.reply}${cutNote}${full}`
    : L('（没取到回答，用 fleet_read_reply 或 fleet_read_screen 查看）', '(no answer found: see fleet_read_reply or fleet_read_screen)', '（回答を取得できません。fleet_read_reply か fleet_read_screen で確認）');
  // its first order didn't go in and Fleet Bridge typed it again (turns.js)
  const resent = x.resent ? L('（指令第一次没送进去，舰桥已自动重发一次。）', '(the order did not go in the first time; Fleet Bridge sent it again.)', '（最初は指示が届かなかったため、艦橋が自動で再送しました。）') + '\n' : '';
  // the order never went in, also after Fleet Bridge typed it again
  if (x.neverRan && x.resent)
    return L(
      `【舰桥通知】未执行：${x.name}（${x.agentId.slice(0, 8)}）没有接收你派的指令「${head}」：发出后它一直空闲，会话记录里没有这条指令；舰桥已自动重发一次，仍然没有进去（可能卡在舰桥认不出的对话框上，或还在加载）。请用 fleet_read_screen 看屏幕，处理后重新派。`,
      `[Fleet notice] Not run: ${x.name} (${x.agentId.slice(0, 8)}) did not take your order "${head}": it stayed idle with no trace of it in its transcript, and Fleet Bridge's one automatic resend did not get in either (a dialog Fleet Bridge doesn't know, or still loading). See fleet_read_screen, then send it again.`,
      `【艦橋通知】未実行：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を受け取っていません。送信後も待機のままで会話記録に指示がなく、艦橋の自動再送 1 回も届きませんでした（艦橋が認識できないダイアログ、または読み込み中の可能性）。fleet_read_screen で画面を確認し、対処してから再送してください。`,
    );
  // never went in, and Fleet Bridge could not type it again (turns.js / agents.js resendOrder)
  if (x.neverRan && x.blocked) {
    const why = {
      dialog: L('屏幕上有对话框', 'a dialog is on its screen', '画面にダイアログがある'),
      'busy-input': L('输入框里有别的文字', 'its input line holds other text', '入力欄に別の文字がある'),
      'no-input': L('输入框一直没出现（还在加载，或卡在别的画面）', 'its input line never showed (still loading, or another screen)', '入力欄が表示されない（読み込み中か別の画面）'),
    }[x.blocked] || x.blocked;
    return L(
      `【舰桥通知】未执行：${x.name}（${x.agentId.slice(0, 8)}）没有接收你派的指令「${head}」：发出后它一直空闲，会话记录里没有这条指令；舰桥想自动重发，但${why}，没有重发。请用 fleet_read_screen 看屏幕，处理后重新派。`,
      `[Fleet notice] Not run: ${x.name} (${x.agentId.slice(0, 8)}) did not take your order "${head}": it stayed idle with no trace of it in its transcript, and Fleet Bridge did not type it again because ${why}. See fleet_read_screen, then send it again.`,
      `【艦橋通知】未実行：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を受け取っていません。送信後も待機のままで会話記録に指示がなく、${why}ため艦橋は自動再送しませんでした。fleet_read_screen で画面を確認し、対処してから再送してください。`,
    );
  }
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
      // when the limit gating it resets (the usage reading, local time): "（5 小时 · 今天 18:10 重置）"
      const back = x.resetsAt > 0 ? `${x.resetLabel ? x.resetLabel + ' · ' : ''}${resetText(x.resetsAt)}` : '';
      return L(
        `【舰桥通知】⛔ 额度到限：${x.name}（${x.agentId.slice(0, 8)}）没做完你派的指令「${head}」：「${org}」的额度用完了（${x.error}）。${back ? `额度重置：${back}。` : ''}等额度重置后它会接着做，或者用 /login 换到另一个组织。`,
        `[Fleet notice] ⛔ Quota used up: ${x.name} (${x.agentId.slice(0, 8)}) did not finish your order "${head}": the quota of "${org}" is used up (${x.error}).${back ? ` Reset: ${back}.` : ''} It goes on after the reset, or /login to the other organization.`,
        `【艦橋通知】⛔ 利用枠上限：${x.name}（${x.agentId.slice(0, 8)}）はあなたの指示「${head}」を完了していません。「${org}」の利用枠を使い切りました（${x.error}）。${back ? `リセット：${back}。` : ''}リセット後に再開するか、/login で別の組織へ。`,
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
    `【舰桥通知】${icon} 完成：${x.name}（${x.agentId.slice(0, 8)}）做完了你派的指令「${head}」，用时 ${mins(x.ms)}。\n${resent}${sum}${reply}`,
    `[Fleet notice] ${icon} Done: ${x.name} (${x.agentId.slice(0, 8)}) finished your order "${head}" in ${mins(x.ms)}.\n${resent}${sum}${reply}`,
    `【艦橋通知】${icon} 完了：${x.name}（${x.agentId.slice(0, 8)}）があなたの指示「${head}」を完了（${mins(x.ms)}）。\n${resent}${sum}${reply}`,
  );
}

/**
 * The quota an agent's turn stopped on has reset (improvement P-005): the master is reminded, and asks the
 * user before sending anything on, since what was to be done may be out of date by now.
 */
export function quotaBackNotice(x) {
  const id = x.agentId.slice(0, 8);
  const held = x.held
    ? L(
        `它还有 ${x.held} 条排队的指令暂停着（额度中断时没有发出）：用户确认后用 fleet_requeue 续发，不要的用 fleet_unqueue 移除。`,
        `${x.held} queued order(s) of it are on hold (not sent when the quota stopped it): fleet_requeue sends them on once the user agrees, fleet_unqueue drops them.`,
        `保留中のキュー指示が ${x.held} 件あります（利用枠で停止した時点で未送信）。ユーザーの確認後に fleet_requeue で再開、不要なら fleet_unqueue で削除。`,
      )
    : '';
  return L(
    `【舰桥通知】🔄 额度已重置：${x.name}（${id}）之前被额度中断的任务可以继续了。先告诉用户并确认还要不要继续（中断前的指令可能已经过时），确认后用 fleet_send 让它从断点继续。${held}`,
    `[Fleet notice] 🔄 Quota reset: ${x.name} (${id}) can go on with the task the quota stopped. Tell the user and ask whether it should (the order may be out of date by now); once they agree, fleet_send it to continue where it stopped. ${held}`,
    `【艦橋通知】🔄 利用枠リセット：${x.name}（${id}）は利用枠で中断したタスクを再開できます。まずユーザーに伝え、続行するか確認してください（中断前の指示は古くなっている可能性）。確認後 fleet_send で続きから再開を指示。${held}`,
  ).trim();
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
// Other notices for the master (self-improvement proposals, their builds and updates): sent with the next
// notice that can go out, oldest first, kept an hour at most
const notes = [];
export function queueMasterNote(text) {
  notes.push({ text: String(text), at: Date.now() });
  while (notes.length > 20) notes.shift();
}

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
  while (notes.length && Date.now() - notes[0].at > 3_600_000) notes.shift();
  if (!fresh.length && !finished.length && !notes.length) return;
  // never type into the middle of what the user is writing to the master: wait for an empty input
  if (Date.now() - (m.typedAt || 0) < TYPING_PAUSE || !inputEmpty(m)) return;
  // a finished turn waits at most 15 s for its model summary (the rules' one is there at once)
  const now = Date.now();
  const ready = (x) => !x.summaryKey || cachedSummary(x.summaryKey)?.done !== false || now - x.at > 15_000;
  if (!fresh.length && !finished.some(ready) && !notes.length) return;
  const done = finished.filter(ready);
  const later = finished.filter((x) => !ready(x));
  finished.splice(0, finished.length, ...later);
  const told = notes.splice(0, notes.length);
  // the folder-trust dialogs of new agents go as one notice, with what the choices do
  const trusts = fresh.filter((x) => x.prompt.trust);
  const others = fresh.filter((x) => !x.prompt.trust);
  const parts = [...done.map(doneNotice), ...(trusts.length ? [trustNotice(trusts)] : []), ...others.map(notice), ...told.map((n) => n.text)];
  const tail = [];
  if (done.length) tail.push(L('把结果汇总告诉用户', 'sum the results up for the user', '結果をまとめてユーザーに伝える'));
  if (told.length && !done.length && !fresh.length) tail.push(L('按通知里说的转告用户', 'tell the user as the notice says', '通知の内容をユーザーに伝える'));
  if (trusts.length && !others.length) tail.push(L('信任文件夹用 fleet_answer，choice 填 "trust"', 'trust a folder with fleet_answer, choice "trust"', 'フォルダーの信頼は fleet_answer、choice "trust"'));
  if (others.length) tail.push(L('用 fleet_answer 按编号回答，该由用户决定的先问用户', 'answer with fleet_answer by number, asking the user first when it is theirs to decide', 'fleet_answer で番号を指定して回答。ユーザーが決めるべきものは先に確認'));
  const body = [...parts, L(`（舰桥自动发送：${tail.join('；')}。）`, `(Sent by Fleet Bridge: ${tail.join('; ')}.)`, `（艦橋が自動送信：${tail.join('。')}。）`)].join('\n\n');
  if (!sendText(m, body)) {
    finished.unshift(...done);
    notes.unshift(...told);
    return;
  }
  saveFinished();
  rememberTold(done);
  for (const x of fresh) notified.set(x.agentId, { ask: x, at: Date.now(), goneAt: 0 });
}
