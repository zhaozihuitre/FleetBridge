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
| WS | `/ws/agents/{id}` | 我方 agent 的终端通道 | 同源 |
| GET | `/`、`/widget`、`/term` | 指挥中心、战况小窗、弹出终端页面 | — |

## POST /api/agents

| 参数 | 类型 | 说明 |
|---|---|---|
| `cwd` | string | 新会话的文件夹（必须存在） |
| `name` | string? | 呼号（会话名，`--name`） |
| `prompt` | string? | 启动后自动发送的首个指令 |
| `resume` | string? | 接管的会话 ID，必须来自后端自己扫描的存档；给了 `resume` 就忽略 `cwd` |

返回 `{ ok: true, id }`。错误：`400 {error}`（文件夹不存在、未知会话、终端组件不可用），`409`（该会话正在外部终端运行）。

## POST /api/agents/action

```json
{ "id": ["<agentId>", "..."], "action": "text", "text": "跑一下测试" }
```

| action | 额外参数 | 作用 |
|---|---|---|
| `text` | `text` | 以 bracketed paste 输入后回车 |
| `key` | `key`: `esc` / `ctrl-c` / `enter` | 发送按键 |
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
| `units[].repos[]` | `name, path, branch, upstream, ahead, behind, changedCount, …, remote: {name, host, slug, web}, remotes[]`（不含原始 URL） |
| `quests[]` | 任务：`key, kind, lv, title, goal, since, unit` |
| `comms[]` | 最近 60 条事件 |
| `operator` | 领航员 `mood` 与 `lines[]` |
| `history[]` | 存档会话：`sessionId, cwd, project, title, lastPrompt, updatedAt, pid, owned, agentId` |
| `agents[]` | 我方 agent：`id, sessionId, pid, name, cwd, alive, exitCode, startedAt` |
| `agentSupport` | `{ ok, error }`：node-pty 与 `claude` 是否可用 |
| `thresholds` | 阈值配置 |
