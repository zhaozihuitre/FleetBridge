# API 说明

后端只监听 `127.0.0.1:8787`（`MONITOR_PORT` 可改）。带 `Origin` 头的请求必须来自同源页面，否则 403。

## 接口总览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/state` | 当前完整状态 | 同源 |
| GET | `/api/stream` | SSE，状态变化时推送完整状态 | 同源 |
| POST | `/api/refresh` | 立即刷新额度（忽略退避）与 git | 同源 |
| POST | `/api/focus` | 把外部会话的终端窗口切到前台 | 同源 |
| POST | `/api/resume` | 在 Windows Terminal 里 `claude --resume` | 同源 |
| POST | `/api/snooze` | 某任务稍后提醒 | 同源 |
| POST | `/api/agents` | 出击 / 接管我方 agent | 同源 |
| POST | `/api/agents/action` | 给一个或多个我方 agent 发指令、按键、结束、移除 | 同源 |
| GET/POST | `/api/trust` | 自动信任的目录：`{ auto, dirs }`。POST 可带 `auto`（布尔）、`dirs`（数组或每行一个路径的文本，替换整个列表）、`add` / `remove`（一个路径）；返回清理后的设置（只留绝对路径，去掉盘符根目录和重复项）。其他设备 POST 返回 403 `computer_only` | 同源 |
| GET | `/api/agents/screen?id=` | 我方 agent 当前屏幕的文字（主控 `fleet_read_screen`） | 同源 |
| GET | `/api/agents/reply?id=&turn=` | 我方 agent 某一轮的完整回答（主控 `fleet_read_reply`）。返回 `{ source: 'file', file, text, turn, count }`；没有保存过时返回 `{ source: 'transcript', text, ended }`。错误：`unknown_agent`、`no_such_turn`、`no_reply`（均 404） | 同源 |
| GET | `/api/proposals[?id=]` | 改善提案列表（`{ proposals, improve }`），或一条的全部内容（`{ proposal, allowed, improve }`，`allowed` 是当前状态可做的决定） | 同源 / 手机 |
| POST | `/api/proposals/decide` | `{ id, action, note?, by? }`，`action` 取 `approve / reject / later / new / retry / install / rollback / discard`，按状态检查是否允许（不允许返回 400 `not_allowed:<状态>:<动作>`）。手机来的记为 `by: phone` | 同源 / 手机 |
| POST | `/api/proposals/analyze` | 立即分析一次，返回 `{ findings, model: used/off/failed, added, updated }`；自我改善关闭时 400 `self_improve_off` | 同源 / 手机 |
| GET/POST | `/api/improve/settings` | 自我改善的开关（见数据章节 `self-improve.json`）；只能在电脑上改 | 同源 |
| POST | `/api/improve/clear` | 清空事件日志 `events.jsonl`；只能在电脑上 | 同源 |
| WS | `/ws/agents/{id}` | 我方 agent 的终端通道 | 同源 |
| GET | `/`、`/widget`、`/term` | 指挥中心、战况小窗、弹出终端页面 | — |

## POST /api/agents

| 参数 | 类型 | 说明 |
|---|---|---|
| `cwd` | string | 新会话的文件夹（必须存在） |
| `name` | string? | 呼号（会话名，`--name`） |
| `prompt` | string? | 启动后自动发送的首个指令 |
| `readonly` | boolean? | `true` = 在首个指令末尾附上只读调查的限制（`server/constraints.js` 的 `readOnlyOrder`，主控 `fleet_spawn` 的 `readonly`）；没有 `prompt` 时不起作用 |
| `resume` | string? | 接管的会话 ID，必须来自后端自己扫描的存档；给了 `resume` 就忽略 `cwd` |

返回 `{ ok: true, id }`。错误：`400 {error}`（文件夹不存在、未知会话、终端组件不可用），`409`（该会话正在外部终端运行）。

## POST /api/agents/action

```json
{ "id": ["<agentId>", "..."], "action": "text", "text": "跑一下测试" }
```

| action | 额外参数 | 作用 |
|---|---|---|
| `text` | `text`；`readonly`?: `true` | 以 bracketed paste 输入后回车。`readonly: true`（主控 `fleet_send` 的 `readonly`）在指令末尾附上只读调查的限制，`queue` 同样支持 |
| `key` | `key`: `esc` / `ctrl-c` / `enter` | 发送按键 |
| `answer` | `choice`: 选项编号或 `esc` | 回答屏幕上的授权框、选择框。信任对话框的 1 / 2 按选项本身回答（1 = No, exit，2 = Yes, I trust this folder），不看它们在屏幕上的上下顺序 |
| `trust` | `yes`?: 默认 `true`；`remember`?: `true` | 回答「是否信任此文件夹」：`yes: false` 选 No, exit。屏幕上没有信任对话框时返回 `false`；3 秒内重复调用不再按键。`remember: true`（只对本机指挥中心发来的生效）把这个 agent 的文件夹加入自动信任的目录并打开开关 |
| `queue` | `text` | 排进这个 agent 的队列，做完一轮发一条 |
| `unqueue` | `index`?: 第几条（从 0 起），不填 = 全部；`held`?: `true` = 只移除暂停待确认的 | 从队列移除。`id` 是一个终端已经不在的队列（`orphanQueues` 里的）时也可以 |
| `requeue` | — | 续发暂停待确认的指令（会话重开前排队的、额度中断时没发出的）：恢复成普通排队，做完一轮发一条。agent 已退出或没有暂停的指令时返回 `false` |
| `quota-dismiss` | — | 不再提示这个 agent「额度已重置，可以继续」 |
| `kill` | — | 结束进程 |
| `remove` | — | 从列表移除已退出的 agent |

返回 `{ ok, results: [bool...] }`（与 `id` 顺序对应）。

## WS /ws/agents/{id}

- 服务端 → 客户端：原始终端输出（字符串）；连接时先回放最多 512KB 屏幕缓冲。
- 客户端 → 服务端：`{"type":"input","data":"..."}`、`{"type":"resize","cols":120,"rows":32}`。

## GET /api/state 主要字段

| 字段 | 说明 |
|---|---|
| `usage` | `{ ok, error, fetchedAt, retryAt, limits:[{key,label,usedPct,resetsAt,active}], account }` |
| `units[]` | 运行中的会话：`pid, sessionId, project, cwd, status, permission, contextPct, contextTokens, agents[], repos[], owned, agentId` |
| `units[].quota` | 该终端模型受限的额度中最紧的一项：`{ key, label, usedPct, resetsAt, active, own, asOf, all:[{key,label,usedPct,resetsAt,active,own}] }`；`own` = 模型自己的周额度，`asOf` = 另一个组织的读数时间（本组织为 null）；没有模型或额度时为 null |
| `units[].repos[]` | `name, path, branch, upstream, ahead, behind, changedCount, …, remote: {name, host, slug, web}, remotes[]`（不含原始 URL） |
| `quests[]` | 任务：`key, kind, lv, title, goal, since, unit` |
| `comms[]` | 最近 60 条事件 |
| `operator` | 领航员 `mood` 与 `lines[]` |
| `history[]` | 存档会话：`sessionId, cwd, project, title, lastPrompt, updatedAt, pid, owned, agentId` |
| `agents[]` | 我方 agent：`id, sessionId, pid, name, cwd, alive, exitCode, startedAt` |
| `agentSupport` | `{ ok, error }`：node-pty 与 `claude` 是否可用 |
| `thresholds` | 阈值配置 |
