# 评估：舰桥做成 npm 通用安装（Windows + Mac）

> 2026-11-05 · 基于 0.9.19 · 结论先行，细节在后

## 结论

**推荐方案 B：npm 包里带 Electron**，`npm i -g` 之后运行 `fleet-bridge` 拉起和现在一样的外壳（战况小窗、托盘、通知、防休眠都保留），同时提供 `fleet-bridge --headless`，只起服务端，在浏览器里用（也就是方案 A，几乎不需要额外工作）。现有的 Windows 安装包（方案 C 的 Windows 部分）继续保留，给不用 npm 的人。

- **为什么不是 A**：放弃 Electron 等于放弃战况小窗、托盘、系统通知、防休眠、弹出窗口，这些都是现在的核心体验；而服务端本来就能独立运行（`npm start`），A 可以作为 B 的一个开关免费得到。
- **为什么不是 C（Mac dmg）**：Mac 上分发 dmg 必须做 Apple 签名和公证（每年 99 美元的开发者账号、证书、CI 上的公证流程），否则 Gatekeeper 直接拦。通过 npm 下载的 Electron 不带「隔离」标记，不需要签名就能运行，这是 B 在 Mac 上的最大优势。
- **公开范围**：默认**不发布到公共 npm**。推荐用 `npm pack` 打出的 tgz 或从私有 GitHub 仓库安装（`npm i -g github:<owner>/<repo>`），见第 4 节。
- **工作量**：Windows 上的 npm 版约 1–2 天；Mac 适配约 3–5 天，**而且必须有一台 Mac 实测**（本机无法验证 Mac 行为，这是最大风险）。

## 1. 现状：哪些地方依赖 Windows

| 位置 | 依赖 | Mac 上现状 | 需要做的 |
|---|---|---|---|
| `@lydell/node-pty` | 原生模块 | 官方提供 darwin-arm64 / darwin-x64 / linux 预编译包（N-API，Node 和 Electron 通用，不用本地编译） | 无，npm 会按平台装对应的包 |
| `server/ptypipe.cjs` 终端宿主通道 | Windows 命名管道 | 已写好：非 Windows 用 Unix domain socket（临时目录下的 .sock） | Mac 上实测宿主常驻、重连、残留 sock 文件清理 |
| `server/agents.js` 找 `claude` | `where.exe`、`claude.exe` 兜底路径 | 不可用 | 改成 `which claude`，兜底 `~/.local/bin/claude` |
| `server/agents.js` 状态栏命令 | `.cmd` 启动器 | 不可用 | 非 Windows 写 sh 脚本（`fleet-open` 已经这样做了，照搬） |
| `server/agents.js` Shell 终端 | PowerShell / pwsh | 已写好：非 Windows 用 `$SHELL` | 无 |
| `server/collectors/usage.js` 额度 | 读 `~/.claude/.credentials.json` | **Mac 上 Claude Code 把令牌存在钥匙串**，文件不存在 | 用 `security find-generic-password` 读钥匙串（首次会弹系统授权框）；另一个来源（状态栏上报）本来就跨平台 |
| `server/focus.js` 跳到外部终端窗口 | PowerShell + Win32 API | 已返回 unsupported | 可选：用 osascript 激活 Terminal/iTerm，或先不支持 |
| `server/launch.js` 在外部终端继续会话 | `cmd /c start` | 已返回 unsupported | 可选：`osascript` 打开 Terminal 执行 `claude --resume` |
| `server/preview.js` 外部链接 | `cmd /c start` | 需要分支 | 改用 Electron `shell.openExternal` / Mac 的 `open` |
| `desktop/voice.cjs` 语音 | PowerShell + SAPI | 已返回 false | 可选：Mac 用 `say` |
| `desktop/main.cjs` 外壳 | 托盘、无边框窗口、`setAppUserModelId`、开机自启 | 托盘和通知 Electron 跨平台；但 Mac 有几处必须改 | 见下 |
| `desktop/awake.cjs` 防休眠 | Electron `powerSaveBlocker` | 跨平台 | 无 |
| 安装包 / 开始菜单 / 快捷方式 | NSIS | 无 | npm 版不需要；Mac 用 `fleet-bridge` 命令或可选的 LaunchAgent |
| `ELECTRON_RUN_AS_NODE` 技巧 | 用 Electron 的二进制当 node 跑服务端、宿主、hook、MCP | 跨平台 | 无（纯 node 下 `process.execPath` 就是 node，也成立） |
| 终端环境 `TERM` / `BROWSER` | 已按平台写好 | 可用 | 实测 |

**Mac 外壳必须改的几处（容易漏）：**
- **没有菜单就没有 ⌘C / ⌘V / ⌘A**：Mac 上 Electron 的复制粘贴快捷键靠应用菜单的 Edit 角色，现在去掉了菜单，终端和输入框会无法复制粘贴。
- 无边框窗口要用 `titleBarStyle: 'hiddenInset'` 留出红绿灯按钮，关闭窗口不退出（Mac 习惯），Dock 图标处理。
- 托盘图标要做 Template 图（单色 16/32px），否则在深色/浅色菜单栏上显示不对。
- 开机自启：`setLoginItemSettings` 只对打包好的 .app 有效，npm 版要写 `~/Library/LaunchAgents` 的 plist（Windows 上 npm 版同理，要写启动文件夹快捷方式或注册表 Run 项）。
- 通知在 npm 版里显示为「Electron」而不是「Fleet Bridge」（没有 .app 包装就改不了名字和图标），可以接受。

## 2. 方案比较

| | A. npm：只装服务端 + 网页 | **B. npm：带 Electron 外壳（推荐）** | C. 安装包 + Mac dmg |
|---|---|---|---|
| 安装体验 | `npm i -g`，约 10 MB，秒装；运行后自己开浏览器 | `npm i -g`，安装时下载 Electron（约 100 MB）；`fleet-bridge` 打开和现在一样的界面 | 下载安装包双击；Mac 拖进应用程序 |
| 用户得到的功能 | 指挥中心、终端、手机端；**没有**战况小窗、托盘、系统通知（只有浏览器通知）、防休眠、弹出窗口 | 全部功能 | 全部功能 |
| 原生模块 | `@lydell/node-pty` 预编译包，Node 20+ 直接用 | 同左（N-API，Electron 也能直接加载，不用 rebuild） | 同左，打包时带进去 |
| 常驻终端宿主 | 可用：Windows 命名管道 / Mac Unix socket（代码已有） | 同左 | 同左 |
| 升级 | `npm update -g`。现有的就地升级（复制到数据目录的版本文件夹 + 热重载服务端）可以直接复用：npm 换掉的是安装目录，宿主跑在数据目录里的副本上，不受影响 | 同左；外壳本身（Electron 主进程）更新需要重启应用，和现在装新安装包一样 | Windows 照旧；Mac 需要另做更新（electron-updater 也要求签名） |
| 签名 / 公证 | 不需要 | **不需要**：npm 下载的文件没有隔离标记，Gatekeeper 不拦 | Windows 不签名会有 SmartScreen 提示（现状）；**Mac 必须签名 + 公证**，否则无法打开 |
| 工作量 | 小（0.5–1 天，加 bin 入口和浏览器打开） | 中（Windows 1–2 天；Mac 适配 3–5 天） | 大（Mac 适配同 B，再加证书、公证、CI 打包、更新通道） |
| 风险 | 体验降级明显 | 需要 Mac 实机测试；Electron 版本由 npm 安装决定，要锁定版本 | 开发者账号费用和证书管理；公证流程失败难排查 |

**B 的具体做法：**
1. `package.json` 去掉 `private`，加 `bin: { "fleet-bridge": "bin/fleet-bridge.cjs" }`，把 `electron` 从 devDependencies 移到 dependencies 并锁定版本。
2. `bin/fleet-bridge.cjs`：默认用 `require('electron')` 得到二进制路径并拉起 `desktop/main.cjs`（后台运行，命令行立即返回）；`--headless` 时直接跑服务端并打开浏览器；`--stop`、`--version`。
3. 外壳的「安装目录」从 `resources/app` 换成全局 npm 目录，就地升级的版本文件夹机制照用（node_modules 联接指向全局包的 node_modules）。
4. 上面第 1 节的平台分支逐个补上，先 Windows npm 版跑通，再上 Mac。
5. `npx fleet-bridge` 也能用，但每次都可能重新下载 Electron，只适合试用，常用的还是 `npm i -g`。

## 3. 公开范围

- 当前 `package.json` 是 `"private": true`，npm 会拒绝发布，不会误发。
- 对已提交代码做了敏感词检查（内部项目名、公司域名、本机用户名、邮箱）：**0 处命中**。
- 仍然**建议不发布到公共 npm**，原因：
  - 额度读取用的是 Claude 账号的 OAuth 令牌去调非公开的用量接口，公开发布这类工具需要更谨慎。
  - 包名 `fleet-bridge` 在公共 npm 上是否被占用、以后要不要维护公共用户的问题，都需要先定。
- 推荐的分发方式（任选其一，都不需要公共 npm）：
  1. **tgz 文件**：`npm pack` 生成 `fleet-bridge-0.9.x.tgz`，对方 `npm i -g ./fleet-bridge-0.9.x.tgz`。最简单，适合给少数人。
  2. **私有 GitHub 仓库直接装**：`npm i -g github:<owner>/<repo>#v0.9.x`，对方需要仓库读权限；不需要 registry。
  3. **GitHub Packages**：作用域包 `@<owner>/fleet-bridge`，需要对方配置 `.npmrc` 和令牌，适合人多、要版本管理的时候。

## 4. 需要你决定

1. 是否按 B 做（附带 `--headless` 也就是 A）？
2. Mac 是否现在就做？做的话需要一台 Mac 测试（钥匙串、Unix socket 宿主、菜单快捷键、托盘），否则先只出 Windows 的 npm 版。
3. 分发方式：tgz / 私有 GitHub 仓库 / GitHub Packages？
4. Windows 安装包是否继续维护（建议继续，给不装 Node 的人）？
