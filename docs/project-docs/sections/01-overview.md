# 项目概述

## 定位与背景

同时开好几个 Claude Code 会话做不同项目时，很难知道：额度还剩多少、哪个会话做完了在等我、哪个卡在授权确认上、哪个上下文快满了、各项目 git 有没有忘提交。

**Fleet Bridge（舰桥）** 是一个只在本机运行的游戏风格「指挥中心」，把这些信息集中显示，并且可以在指挥中心里直接启动、分屏操作多个 Claude Code（称为「我方 agent」），用一个输入框统一下达指令。

- 用户：本机同时使用多个 Claude Code 会话的开发者（Windows）
- 只监听 `127.0.0.1`，数据里有账号邮箱和项目路径，不对外暴露

## 核心能力

- **额度监控**：5 小时 / 本周 / 按模型（如 Fable）的已用百分比与重置倒计时
- **会话监控**：每个会话的状态（作战中 / 待命 / 等授权）、记忆负载（context）、子 agent、各仓库 git 状态
- **提醒**：等你授权、做完了、负载过高、能量告急、git 改动搁置 → 指挥中心任务列表 + 战况小窗 + Windows 通知
- **我方 agent**：在指挥中心内嵌终端里启动真实的交互式 `claude`；最多 4 分屏、可弹出独立窗口；总指令台广播 / `@` 指定发送；全军出击；重启后自动恢复阵容
- **存档**：按项目文件夹列出所有历史会话，可「在此继续」或在外部终端继续

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面壳 | Electron 45 | 战况小窗（置顶）、指挥中心（无边框）、弹出终端窗口 |
| 后端 | Node.js（ESM，无框架） | `http` + SSE 推送状态，`ws` 做终端通道 |
| 终端 | `@lydell/node-pty`（ConPTY）+ `@xterm/xterm` | 伪终端里跑真实 `claude`，网页里显示 |
| 前端 | 原生 HTML / CSS / JS 模块 | 无构建步骤 |
| 打包 | electron-builder（NSIS） | Windows 安装程序，按用户安装 |

## 目录结构

```
FleetBridge/
├── server/              后端：采集、状态计算、API、agent 管理
│   ├── index.js         HTTP / SSE / WebSocket 入口、定时刷新
│   ├── state.js         组装状态、任务（quest）、事件（comms）、领航员台词
│   ├── agents.js        我方 agent：node-pty 启动 claude、输入输出
│   ├── roster.js        阵容保存 / 重启恢复 / 孤儿进程清理
│   ├── collectors/      usage / sessions / transcript / git / history / notifications
│   ├── hook.js          Claude Code Notification hook 脚本（授权提醒）
│   ├── focus.js         把外部会话的终端窗口切到前台
│   ├── launch.js        在 Windows Terminal 里 claude --resume
│   └── config.js demo.js probe.js
├── web/                 前端页面
│   ├── index.html app.js style.css   指挥中心
│   ├── widget.html widget.js         战况小窗
│   ├── term.html term.js terminal.js 终端（分屏 / 弹出窗口）
│   └── ui.js                         主题确认框
├── desktop/             Electron 主进程与 preload
├── build/icon.png       程序图标
└── docs/project-docs/   本文档
```

## 快速开始

```bash
npm install
npm run app        # 开发版：战况小窗 + 后端（端口 8787）
npm start          # 只开后端，浏览器访问 http://127.0.0.1:8787
npm run dist       # 打包 Windows 安装程序到 dist/
```
