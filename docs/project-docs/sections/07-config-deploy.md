# 配置与部署

## 配置项

`~/.claude-ops/config.json`（或项目根目录 `config.json`）覆盖 `server/config.js` 里的默认值：

| 名称 | 默认值 | 说明 |
|---|---|---|
| `port` | `8787` | 也可用环境变量 `MONITOR_PORT` |
| `intervals.usage` | `180000` | 额度刷新间隔（ms）。接口与状态栏共享限流，不要调太低 |
| `intervals.sessions` | `3000` | 会话刷新与推送 |
| `intervals.git` | `30000` | git 与存档扫描 |
| `contextWindows` | opus-5 → 1M，其余 200K | 按模型 id 推断窗口大小 |
| `thresholds.contextWarnPct` | `85` | 负载告警 |
| `thresholds.energyLowPct` | `10` | 额度剩余告警 |
| `thresholds.staleDirtyDays` | `3` | 未提交改动搁置天数 |
| `thresholds.standbyMinutes` | `30` | 待命多久算休眠 |
| `git.scanDepth` | `2` | 会话目录下找仓库的深度 |
| `git.autoFetch` | `false` | 是否自动 fetch（默认不联网，见 T-002） |
| `operator.name` | `NOVA` | 领航员名字 |

环境变量：

| 变量 | 作用 |
|---|---|
| `MONITOR_PORT` | 端口 |
| `MONITOR_DATA_DIR` | 数据目录（默认 `~/.claude-ops`），测试版隔离时用 |
| `MONITOR_DEMO` | `1` 假会话；`empty` 无会话（预览存档） |
| `CLAUDE_CONFIG_DIR` | Claude 配置目录（默认 `~/.claude`） |

## 授权提醒 hook

`~/.claude/settings.json` 中：

```json
"hooks": { "Notification": [ { "matcher": "permission_prompt", "hooks": [ {
  "type": "command",
  "command": "C:/path/to/node.exe",
  "args": ["C:/Users/<你>/.claude-ops/hook.js"],
  "async": true, "timeout": 10 } ] } ] }
```

已打开的会话要执行一次 `/hooks` 或重启才会加载。hook 依赖本机 Node 路径（T-004）。

## 部署（打包安装程序）

```bash
npm run dist     # 输出到 dist/ClaudeOps-Setup-<version>.exe
```

- electron-builder NSIS，按用户安装（无需管理员），可选安装目录，建桌面 / 开始菜单快捷方式。
- `node_modules/@lydell/**`（node-pty 原生模块与 ConPTY）通过 `asarUnpack` 放在 asar 外。
- 没有代码签名，首次运行会有 SmartScreen 提示（T-005）。
- **D 盘只有 15GB**，一次打包临时占约 500MB；出新版后删掉旧安装包（I-004）。

升级时安装程序会关闭正在运行的版本：我方 agent 被结束，新版本启动后按 `roster.json` 自动恢复。

## 测试版与安装版同时运行

开发版要和安装版隔离，避免抢端口与单实例锁：

```bash
MONITOR_PORT=8790 MONITOR_DATA_DIR=<临时目录> npx electron . --user-data-dir=<临时目录>
```
