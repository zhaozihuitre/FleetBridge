# 用 npm 安装舰桥（Windows）

> 适用于 0.9.22 及以后。目前只支持 Windows（x64）；Mac 还没做，见文末。

舰桥的 npm 版和安装包版功能相同：右下角的小窗、指挥中心、托盘、系统通知、防休眠、手机访问都有。区别只是装法和升级方式。
安装包（`FleetBridge-Setup-x.y.z.exe`）在 npm 版稳定之前继续提供。

## 需要

- Windows 10 / 11（x64）
- Node.js 22.12 或更新（Electron 45 的要求）
- Git，并且能访问私有仓库（SSH 密钥，或已登录的 HTTPS 凭据）
- 不发布到任何公共 npm 仓库：`package.json` 是 `"private": true`，只能从仓库安装

## 安装

```bash
# 指定版本（推荐，用 tag）
npm i -g github:zhaozihuitre/FleetBridge#v0.9.22
# 或者用 SSH 地址
npm i -g git+ssh://git@github.com/zhaozihuitre/FleetBridge.git#v0.9.22
```

- 安装时会下载 Electron（约 100 MB，第一次要几分钟）。
- 新版 npm 可能提示 `install-scripts ... not yet covered by allowScripts`。可以加 `--allow-scripts=fleet-bridge` 让它在安装时下载 Electron；不加也行，第一次启动时会自动下载。

## 使用

| 命令 | 作用 |
|---|---|
| `fleet-bridge` | 启动（后台运行，命令行马上返回）。已经在运行时，打开指挥中心 |
| `fleet-bridge --headless` | 只起服务端，在浏览器里用 `http://127.0.0.1:8787`。没有小窗、托盘和系统通知；Ctrl+C 结束 |
| `fleet-bridge status` | 正在运行的是哪个版本、哪些终端 |
| `fleet-bridge stop` | 退出（舰桥里的终端会一起结束，和小窗菜单里的「退出」一样） |
| `fleet-bridge cleanup` | 退出，并删除开始菜单快捷方式和开机启动（卸载前用） |
| `fleet-bridge --version` | 已安装的版本 |

第一次启动后，开始菜单里会有「Fleet Bridge (npm)」（Windows 需要它才会显示舰桥的通知），以后也可以从这里启动。
开机自动启动在小窗菜单里开关，和安装包版一样。

## 和安装包版的关系

- **同一时间只能运行一个。** 两者共用数据目录 `~/.claude-ops`（设置、手机配对、主控、历史）和端口 8787。一个在运行时，另一个会提示「已经在运行」并退出；`fleet-bridge` 命令也会拒绝启动。
- 切换方法：在小窗菜单里退出正在运行的那个，再启动另一个。终端会结束，Claude 会话可以在「存档」里接着用。
- 两者的版本文件夹分开放：安装包版在 `~/.claude-ops/app`，npm 版在 `~/.claude-ops/app-npm`，互不影响。

## 升级

**常规升级（换新版本）：**

```bash
fleet-bridge stop
npm i -g github:zhaozihuitre/FleetBridge#v0.9.23
fleet-bridge
```

必须先 `stop`：Windows 会锁住正在运行的 Electron 和终端组件，运行中 npm 换不掉这些文件。退出时舰桥里的终端会结束，会话可以在「存档」里接着用。
不指定 tag 时（`npm i -g github:zhaozihuitre/FleetBridge`）装的是默认分支的最新提交。`npm update -g` 对从仓库安装的包不可靠，请用上面带 tag 的重新安装。

**就地升级（不中断终端）：** 和安装包版一样，从一份代码目录执行：

```bash
node tools/update.mjs --prod
```

它会自动认出正在运行的是 npm 版，把新的 server/ 和 web/ 装进 `~/.claude-ops/app-npm`，只重启服务端，终端继续运行；新版本起不来会自动回到上一个版本。
只适用于 server/ 和 web/ 的改动。Electron、外壳（desktop/）或依赖变了，要用上面的常规升级。
`--headless` 模式不支持就地升级。

## 卸载

```bash
fleet-bridge cleanup
npm uninstall -g fleet-bridge
```

- `cleanup` 会退出舰桥，删除开始菜单快捷方式和开机启动。npm 卸载时不会自动做这些。
- 数据目录 `~/.claude-ops` 保留（安装包版也用它）。确定都不用了再手动删。
- 小窗位置等界面设置在 `%APPDATA%\fleet-bridge-npm`，可以一起删。

## Mac（还没做）

代码里和平台有关的部分集中在 `desktop/platform.cjs`，标了 `todo(mac)`。在 Mac 上能装、能启动，但下面这些要在真机上补完、测试后才算支持：

- 额度：Claude Code 在 Mac 上把登录令牌存在钥匙串里，不在 `~/.claude/.credentials.json`
- 找 `claude` 用的是 `where.exe`；状态栏启动器是 `.cmd`
- 没有应用菜单，⌘C / ⌘V 不能用；无边框窗口要留红绿灯按钮；托盘图标要做 Template 图
- 开机启动要写 LaunchAgent；跳到外部终端、语音输入只做了 Windows

## 维护者：发版

1. 改 `package.json` 的 version，提交。
2. 打 tag 并推送：`git tag v0.9.23 && git push origin main v0.9.23`。
3. 安装包：`npm run dist`。它会在打包期间把 electron 临时移回 devDependencies，打完还原 `package.json`；electron 不会被打进安装包。
