# 核心流程

## 1. 状态刷新与推送

触发：定时器。会话每 3 秒，额度每 3 分钟，git 与存档每 30 秒。

```mermaid
sequenceDiagram
  participant T as 定时器
  participant I as server/index.js
  participant C as collectors
  participant St as state.js
  participant UI as 页面（SSE）
  T->>I: publish()（3s）
  I->>C: collectSessions()（状态文件 + transcript 增量 + 授权通知）
  I->>I: bindAgents()：按 pid 关联我方 agent，saveRoster()
  I->>St: buildState(sessions, git, usage)
  St->>St: 对比上一次 → 事件写 comms.jsonl
  St-->>I: units / quests / operator / comms
  I->>I: 与上次 JSON 相同则不推
  I-->>UI: data: {...}
```

异常分支：
- 额度接口 401 → 显示「登录过期，打开一次 Claude Code」；429 → 退避并显示缓存（I-001）。
- 会话状态文件存在但进程已不在 → 跳过（不显示）。
- 首次刷新不产生事件（避免启动时刷屏）。

## 2. 授权提醒

```mermaid
sequenceDiagram
  participant CC as Claude Code 会话
  participant H as ~/.claude-ops/hook.js
  participant F as notifications.jsonl
  participant S as 后端
  participant W as 小窗 / 指挥中心
  CC->>H: Notification hook（permission_prompt，stdin JSON）
  H->>F: 追加 {at, sessionId, message}
  S->>F: 每 3s 增量读取
  S->>S: 该会话 transcript 在 at 之后没有新行 且 状态非 idle 且 < 30 分钟 → 等授权
  S-->>W: PERMIT 任务（最高优先级）+ Windows 通知
  CC->>CC: 用户批准 / 拒绝 → 写入工具结果
  S->>S: transcript 有新行 → 提醒自动消失
```

## 3. 出击 / 接管 / 下指令

```mermaid
sequenceDiagram
  participant UI as 指挥中心
  participant S as 后端
  participant P as node-pty
  participant C as claude
  UI->>S: POST /api/agents {cwd} 或 {resume}
  S->>S: resume 已被我方接管？→ 返回已有 agent（不再起第二个进程）
  S->>P: spawn claude --session-id/--resume [--name] --settings agent-settings.json（清掉继承的会话环境变量）
  P->>C: 启动
  S-->>UI: {id}
  UI->>S: WebSocket /ws/agents/{id}
  S-->>UI: 回放屏幕缓冲 + 实时输出
  UI->>S: 键盘输入 / 窗口大小
  Note over UI,S: 总指令台：POST /api/agents/action {id:[...], action:"text"}<br/>后端以 bracketed paste 写入后回车
```

## 4. 恢复阵容

```mermaid
flowchart TD
  A[每次 publish] --> B[saveRoster：我方存活 agent 的当前 sessionId / cwd / name]
  Q[退出程序] --> R[freezeRoster 后 killAll，名单不被清空]
  S[启动 start] --> L[loadRoster]
  L --> X{该会话还有进程在跑?}
  X -- 否 --> Y[resume 接管]
  X -- 是，父进程已不在 --> K[孤儿：结束它] --> Y
  X -- 是，父进程还在 --> Z[正被外部终端使用：跳过]
```

## 5. 全军出击

1. 存档按文件夹分组，按最近活动排序。
2. 跳过主目录和 `AppData` 目录；每个文件夹取最新会话：我方 → 直接打开；外部运行中 → 跳过并顺延；否则 → 接管。
3. 主题确认框列出要打开的 4 个，确认后收起现有分屏并依次打开。
