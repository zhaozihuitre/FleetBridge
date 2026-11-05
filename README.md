# Fleet Bridge · 舰桥

游戏风格的 Claude Code 多项目指挥舰桥：额度、各会话状态（记忆负载、子 agent、git）、等你授权 / 做完了的提醒，
还能在指挥中心里直接启动 Claude、分屏操作多个终端。只在本机 `127.0.0.1` 上运行。

## 运行

```bash
npm install          # Electron、终端组件（node-pty / xterm.js）、ws
npm run app          # 战况小窗 + 后端（推荐）。⤢ 打开指挥中心，右键菜单
npm start            # 只开后端，浏览器访问 http://127.0.0.1:8787 （/widget 是小窗页）
npm run probe        # 命令行打印一次采集结果
npm run demo         # 假数据演示，端口 8788
npm run dist         # 打包 Windows 安装程序到 dist/
```

## 升级：不用安装程序

安装好的舰桥分成两层：

- **外壳**（安装程序装的）：Electron、窗口代码（`desktop/`）、`node_modules`（含原生终端模块）。
- **应用**（可以就地更新）：`server/` 和 `web/`，从 `<数据目录>\app\<版本>\` 加载，`current.json` 记录当前版本和上一版。

终端由独立的常驻进程（PTY 宿主，`server/ptyhost.cjs`）托管。服务端重启、窗口刷新、甚至外壳崩溃，终端都继续运行，重启后服务端会把它们接回来，屏幕和会话都还在。只有正常退出舰桥时，终端才会跟着结束；下次启动不会自动拉起它们，需要时从存档里接着用。

```bash
npm run update -- --prod        # 把当前代码装进正式版并切换（终端不断，窗口刷新）
npm run update -- --prod --rollback   # 退回上一版
npm run update                  # 同上，但针对开发实例（~/.claude-ops-dev，端口 8790）
```

新版本 20 秒内没有正常启动、或启动后反复崩溃，会自动退回上一版，并记进 `current.json` 的 `failed`。

以下情况仍需用安装程序整包安装：改了 `desktop/`（外壳、预加载脚本、托盘、小窗窗口）、改了依赖（`package.json` 的 dependencies / `node_modules`）、升级 Electron、改了 PTY 宿主的通信协议（`server/ptypipe.cjs` 的 `PROTOCOL`），或者服务端需要更高的外壳接口版本（`package.json` 的 `fleetShellApi`）。整包安装后，如果外壳自带的版本比当前应用目录里的新，会自动改用外壳自带的版本。

## 开发与测试：不要污染正式环境

开发版和安装好的正式版跑在同一台电脑、同一个 Windows 桌面、同一个 `~/.claude` 上，测试时必须隔离：

- 未打包运行（`npm run app` / `npx electron .`）和 `npm run demo` 自动进入开发模式（`FLEET_DEV=1`）：
  - 数据目录默认是 `~/.claude-ops-dev`，端口默认 8790，不碰正式版的 `~/.claude-ops` 和 8787；用 `MONITOR_DATA_DIR` / `MONITOR_PORT` 指定时同样不要指向正式版的目录和端口。
  - 不弹 Windows 系统通知（只写日志），确实要测通知时才设 `MONITOR_DEV_NOTIFY=1`，测完立刻关掉实例。
  - 启动的 agent（包括主控）名字自动加 `dev·` 前缀，正式版在运行中的会话和存档里都会把它们过滤掉。
- 演示数据（`MONITOR_DEMO`）只在开发模式下使用，不发手机推送；正式版不会加载演示数据。
- 测试用的 agent 尽量开在临时文件夹里；测完结束 agent、关掉开发实例，不要让它在后台一直跑。
- 不要把测试指令发给正式版的 agent 或主控，也不要用正式版的手机推送频道测试。

## 功能

- **战况小窗**（置顶）：额度条、最急的一条提醒、所有部队的状态 / 负载 / 等待时间，点一行直接跳过去；
  等你授权、做完了会弹 Windows 通知。
- **指挥中心**：部队（会话卡片 + git）、任务（按 S/A/B 排序）、通讯（事件记录）、存档（按文件夹列出所有会话）。
- **我方 agent**：「＋ 出击」(N) 在指定文件夹启动真实的交互式 `claude`，终端内嵌在指挥中心里；
  最多 4 个分屏，⧉ 弹出成独立窗口；存档里的会话可以「在此继续」。退出程序会结束我方 agent。
- 外部终端里开的会话只能监控和「跳过去」（Claude Code 不支持从外部向运行中的终端输入）。

## 数据从哪来

| 数据 | 来源 |
|---|---|
| 额度 / 重置时间 | `api.anthropic.com/api/oauth/usage`，用 `~/.claude/.credentials.json` 的令牌（只读，从不刷新令牌） |
| 正在运行的会话 | `~/.claude/sessions/<pid>.json` |
| 记忆负载、最后汇报、改过哪些文件 | `~/.claude/projects/<项目>/<会话>.jsonl`（增量读取） |
| 子 agent | `<会话>/subagents/*.meta.json` |
| git | 会话目录下 2 层内的仓库，`GIT_OPTIONAL_LOCKS=0` 只读 |
| 等你授权 | `~/.claude/settings.json` 的 Notification hook → `~/.claude-ops/hook.js` → `~/.claude-ops/notifications.jsonl` |

程序自己的数据（通讯记录、额度缓存、配置）都在 `~/.claude-ops/`。

## 配置

在 `~/.claude-ops/config.json` 覆盖默认值（见 `server/config.js`），例如：

```json
{ "thresholds": { "contextWarnPct": 80, "standbyMinutes": 20 }, "operator": { "name": "NOVA" } }
```
