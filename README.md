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
