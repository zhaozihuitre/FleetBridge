# 开发约定

## 代码风格

- 后端 ESM，无框架；前端原生模块，无构建步骤。改完前端刷新页面（`Ctrl+R`）即可生效，改 `server/` 或 `desktop/` 要重启程序。
- 注释写「为什么」，不写「做了什么」；用户可见文字在代码里写中文，前端用 `L()` 包起来并在 `web/i18n.js` 词典里补英文，后端用 `L(中文, English)`。
- 页面样式统一用 `web/style.css` 里的 CSS 变量；**不要用浏览器默认控件外观**：确认框用 `web/ui.js` 的 `ask()`，不用 `confirm()`；滚动条、菜单都已主题化。
- 状态推送是完整 JSON，前端每次重绘；会打断交互的部分（总指令台消息框、分屏顶栏）只在内容变化时重建。

## 调试

| 命令 | 用途 |
|---|---|
| `npm run probe` | 命令行打印一次采集结果（额度、会话、git、任务） |
| `npm run demo` | 假会话 + 真实 git，端口 8788 |
| `MONITOR_DEMO=empty` | 无会话，预览存档 / 空状态 |
| `http://127.0.0.1:8787/#quests` | 直接打开某个标签；`#term=<agentId>` 打开某个终端 |

桌面版本地验证：开发版用独立的配置目录（`%APPDATA%/fleet-bridge-dev`），可以和安装版同时运行，配合 `MONITOR_PORT=8790 MONITOR_DATA_DIR=<测试目录> npx electron . --remote-debugging-port=9333`，再用 DevTools 协议对窗口截图（`Page.captureScreenshot`）。不要动安装版进程。

截图检查界面：`chrome --headless=new --screenshot ... --timeout=8000`（页面有 SSE 长连接，用 `--timeout` 而不是 `--virtual-time-budget`）。

## 容易踩的坑

- **重启开发版会结束我方 agent**：先确认阵容已保存（`~/.claude-ops/roster.json`），或用隔离端口跑测试版。正在用的安装版里可能跑着当前对话本身，**不要结束安装版进程**。
- **在 Claude 会话里启动的程序会继承 `CLAUDE_CODE_*` 环境变量**，子 `claude` 会当自己是嵌套会话（I-002）。`agents.js` 已清理。
- **强制结束 Electron 会留下孤儿 claude 进程**：正常退出走 `before-quit → shutdown()`；崩溃靠下次启动清理（I-003）。
- **额度接口限流**：频繁重启会触发 429，退避状态已持久化（I-001）。
- Windows 上 bash heredoc 会吞掉 `\\`，测试 JSON 里的路径用正斜杠。
- `git status` 必须带 `GIT_OPTIONAL_LOCKS=0`，否则可能和用户的 git 操作抢 index 锁。

## 打包体积

- `electronLanguages` 只保留 zh-CN / en-US 两个 Chromium 语言包（原来 55 个，约 47 MB）。
- `files` 里排除依赖的 `*.map`、`*.d.ts`、`src/` 等运行用不到的文件（app.asar 8.2 MB → 1.5 MB）。
- Electron 本体（exe 238 MB、显卡相关 dll）无法再减。
