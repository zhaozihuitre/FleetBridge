// UI language: Chinese is written in the code; English comes from the dictionary below, keyed by the
// Chinese text. L('还有 {0} 个仓库…', n) fills {0}, {1}… in either language. Static HTML is
// translated once at load by translateDom(). The choice is shared by every window (same origin)
// and sent to the server, which writes reminders and comms in the same language.
const KEY = 'fb-lang';

function read() {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export const lang = read();
document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
export const locale = lang === 'en' ? 'en-US' : 'zh-CN';

const EN = {
  // moods / states
  '● 请求授权': '● Approval', '● 紧张': '● Tense', '● 担心': '● Worried', '● 招手': '● Waving', '● 皱眉': '● Frowning',
  '● 惊讶': '● Surprised', '● 开心': '● Happy', '● 专注': '● Focused', '● 打盹': '● Dozing', '● 待命': '● Standby',
  '● 已退出': '● Exited', '● 已退出（{0}）': '● Exited ({0})', '● 等你授权': '● Needs approval', '● 作战中': '● Working',
  '● 已连接': '● Connected', '● 连接断开，重连中…': '● Disconnected, reconnecting…', '● 连接中': '● Connecting',
  // time
  '{0}天': '{0}d', '刚刚': 'just now', '{0} 分钟前': '{0} min ago', '{0} 小时前': '{0} h ago', '{0} 天前': '{0} days ago',
  // quota
  '接口限流，稍后自动重试': 'Rate limited, retrying later', '登录过期，打开一次 Claude Code 即可': 'Login expired, open Claude Code once',
  '5 小时': '5 hours', '本周 · 所有模型': 'Week · all models', '额度': 'Quota', '读取失败：': 'Read failed: ', '读取中…': 'Loading…',
  ' 重试': ' retry', '缓存 {0}': 'cached {0}', '当前起作用的限额': 'The limit currently in effect', '已用': 'used', '重置 ': 'resets ',
  // message box / console
  '▶ 去终端授权': '▶ Approve in terminal', '▶ 跳到终端': '▶ Go to terminal', '稍后': 'Later', '发给 {0} 个': 'sent to {0}',
  '已发送': 'Sent', '发给全部 {0} 个 · @ 指定': 'To all {0} · @ to pick', '还没有我方 agent': 'No agents of ours yet',
  '已发给 {0} 个 agent': 'Sent to {0} agent(s)', '发出 {0} / {1}，有的 agent 可能已经退出': 'Sent {0} / {1}; some agents may have exited',
  '先输入指令': 'Type an order first', '找不到 {0}': 'Not found: {0}', '@ 后面还要写指令内容': 'Write the order after the @name',
  // stats tiles
  '今日 token': 'Tokens today', '输出 {0} · {1} 个会话': 'output {0} · {1} sessions', '统计中…': 'Counting…',
  '输入 {0} · 缓存读 {1} · 缓存写 {2} · 输出 {3}': 'input {0} · cache read {1} · cache write {2} · output {3}',
  '缓存命中': 'Cache hits', '越高越省额度': 'higher saves quota', '缓存读取 ÷ 全部输入 token': 'cache reads ÷ all input tokens',
  '今日指令': 'Orders today', '你发出的指令数': 'prompts you sent', '今天所有会话里你输入的指令（不含工具结果和斜杠命令）': 'Prompts you typed today in all sessions (no tool results or slash commands)',
  '等你 · {0} 个授权': 'Waiting · {0} approval', '等你': 'Waiting', '最久 {0}': 'longest {0}', '没有会话在等': 'nobody waiting',
  // deploy
  '无法启动 agent': 'Cannot start agents', '没有可以出击的项目会话': 'No project sessions to deploy', '　已在指挥中心': '　already here',
  '全军出击：{0} 个项目': 'Full deploy: {0} projects', '打开这些项目最新的会话，分屏排开。': 'Open the latest session of each project, side by side.',
  '跳过（正在外部终端运行）：{0}': 'Skipped (running in an outside terminal): {0}', '⚡ 出击': '⚡ Deploy',
  '出击 {0} 个，{1} 个失败': '{0} deployed, {1} failed', '全军出击！{0} 个终端已就位': 'Full deploy! {0} terminals ready',
  // unit cards
  '等你授权': 'Needs approval', '作战中': 'Working', '休眠': 'Dormant', '待命': 'Standby', '无': 'none',
  '{0} 架出击：{1}': '{0} out: {1}', '{0} 架 · 全部返航': '{0} · all back', '还有 {0} 个仓库…': '{0} more repos…',
  '打开它的终端，直接下指令': 'Open its terminal and give orders', '▶ 终端': '▶ Terminal', '在外部终端里运行，只能切过去': 'Runs in an outside terminal; can only switch to it',
  '跳过去': 'Switch', '我方': 'ours', '呼号': 'Callsign', '请求授权：': 'Approval needed: ', '需要你确认': 'needs your confirmation',
  '执行中：': 'Working on: ', '（还没有汇报）': '(no report yet)', 'LOAD 记忆负载': 'LOAD · context', 'DRONES 僚机': 'DRONES · subagents',
  'REPOS 仓库': 'REPOS', '最早 fetch 在 ': 'oldest fetch ', '扫描中…': 'Scanning…', '这个目录下没有 git 仓库': 'No git repos in this folder',
  // repos
  '无上游': 'no upstream', '工作区干净': 'clean', '卡在 {0} 中途': 'stuck mid-{0}', '，{0} 个冲突': ', {0} conflicts',
  '{0} 个文件未提交': '{0} files uncommitted', '（{0} 新）': ' ({0} new)', ' · 已放 ': ' · idle ',
  'Claude 最后一次修改这个仓库的时间': 'When Claude last changed this repo', '有多个远程，没有默认推送目标': 'Several remotes, no default push target',
  '没有远程仓库，只在本地': 'No remote, local only', '另有 {0}': 'also {0}', '推送到 {0}：{1}（点击打开）': 'Pushes to {0}: {1} (click to open)',
  '无远程': 'no remote', '{0} 个仓库': '{0} repos', '读取失败：{0}': 'Read failed: {0}',
  // quests / archive / comms
  ' · 部队 ': ' · unit ', '目标：': 'Goal: ', '▶ 前往': '▶ Go', '正在外部终端里运行': 'Running in an outside terminal',
  '在指挥中心里继续，可以直接下指令': 'Continue here, with orders from the console', '▶ 在此继续': '▶ Continue here',
  '在新的 Windows Terminal 里继续': 'Continue in a new Windows Terminal', '外部终端': 'Outside terminal', '运行中': 'running',
  '{0} 运行中': '{0} running', '最后指令：': 'Last order: ', '{0} 个会话 · {1}': '{0} sessions · {1}', '项目文件夹': 'Project folders',
  '{0} 个 · ↑↓ 切换': '{0} · ↑↓ to switch', '没有活动的会话 · ': 'No active sessions · ', ' · {0} 个': ' · {0}',
  '没有找到会话': 'No sessions found', '没有待处理的任务，指挥官可以喝杯咖啡': 'Nothing to do. Time for a coffee, commander.',
  '还没有通讯记录。部队状态变化时会出现在这里。': 'No comms yet. Unit status changes show up here.',
  '◆ 作战 {0}　◆ 待命 {1}': '◆ Working {0}　◆ Standby {1}', '在指挥中心里启动一个新的 Claude Code（N）': 'Start a new Claude Code here (N)',
  '已切到 {0} 窗口': 'Switched to the {0} window', '没找到这个会话的终端窗口': 'Could not find this session’s terminal window',
  // terminals
  '打断当前操作': 'Interrupt the current action', '弹出成独立窗口': 'Pop out into its own window', '结束这个 Claude 进程': 'End this Claude process',
  '结束': 'End', '移除': 'Remove', '收起这个终端（agent 继续运行）': 'Hide this terminal (the agent keeps running)', '收起这个终端': 'Hide this terminal',
  '启动新的 Claude（N）': 'Start a new Claude (N)', '＋ 出击': '＋ Deploy', '没有其他我方 agent · ': 'No other agents · ',
  '记忆负载 {0}%：{1} / {2} tokens': 'Context {0}%: {1} / {2} tokens', '，建议 /compact': ', consider /compact',
  '操作没有生效：这个 agent 可能已经退出': 'Nothing happened: this agent may have exited', '接管失败：': 'Takeover failed: ',
  '已在指挥中心里继续这个会话': 'Continuing this session here',
  '这个文件夹最新的会话正在外部终端运行，将开新会话。': 'The latest session here runs in an outside terminal; a new session will start.',
  '打开': 'Open', '继续': 'Continue', '{0}最新会话：{1} · {2}': '{0} the latest session: {1} · {2}', '启动失败': 'Failed to start',
  '部队归队，继续最新会话': 'Back in formation, continuing the latest session', '部队出击！': 'Unit deployed!',
  '结束「{0}」？': 'End “{0}”?', '进程会退出，会话记录保留，可以从存档继续。': 'The process exits; the session is kept and can be continued from the archive.',
  '已经在运行，切到 {0} 窗口': 'Already running, switched to the {0} window', '这个会话在运行，但没找到它的终端窗口': 'This session is running, but its terminal window was not found',
  '已在 {0} 里打开，部队即将上线': 'Opened in {0}, the unit comes online shortly', '打开失败：': 'Failed to open: ', '{0} 分钟后再提醒': 'Reminding again in {0} min',
  '正在刷新…': 'Refreshing…', '已刷新': 'Refreshed', '退出舰桥？': 'Quit Fleet Bridge?',
  '还有 {0} 支部队在指挥中心里运行，退出会结束它们。会话记录会保留，下次启动时自动恢复阵容。': '{0} unit(s) are running here and will end on quit. Sessions are kept and the roster is restored on the next start.',
  '退出': 'Quit', '结束这个 Claude？': 'End this Claude?', '确定': 'OK', '取消': 'Cancel', '[与终端的连接已断开]': '[Disconnected from the terminal]',
  // static HTML (index / widget / term)
  '舰桥 · 多项目指挥中心': 'Multi-project command center', '立即刷新': 'Refresh now', '最小化': 'Minimize', '最大化或还原': 'Maximize or restore',
  '最大化 / 还原（双击顶栏也可以）': 'Maximize / restore (or double-click the top bar)', '关闭指挥中心': 'Close the command center',
  '关闭指挥中心（agent 和小窗继续运行）': 'Close the command center (agents and the widget keep running)', '总指令台': 'Master console',
  'COMMAND · 总指令台': 'COMMAND', '今日概况': 'Today', '消息': 'Messages', '正在连接指挥网络…': 'Connecting…', '指令': 'Order',
  '输入指令，Ctrl+Enter 发送。\n@名字 只发给指定的终端，不写 @ 就发给全部我方 agent。作战中的会排队执行。': 'Type an order, Ctrl+Enter to send.\n@name sends to that terminal only; without @ it goes to all our agents. Busy ones queue it.',
  '▶ 发送': '▶ Send', '指挥面板': 'Command panel', '部队': 'Units', '任务': 'Quests', '通讯': 'Comms', '存档': 'Archive',
  '打开最近 4 个项目各自最新的会话，分屏排开': 'Open the latest session of the 4 most recent projects, side by side', '⚡ 全军出击': '⚡ Full deploy',
  '◀ 上一页': '◀ Prev', '下一页 ▶': 'Next ▶', '部队终端': 'Unit terminals', '动态分屏：当前 / 刚收到指令的终端变大，其他变小': 'Dynamic split: the current / just-ordered terminal grows, the others shrink',
  '⇔ 动态': '⇔ Dynamic', '收起所有终端（agent 继续运行）': 'Hide all terminals (agents keep running)', '✕ 全部收起': '✕ Hide all',
  '出击 · 启动新的 Claude Code': 'Deploy · start a new Claude Code', '作战地点（文件夹）': 'Location (folder)', '开新会话': 'New session',
  '继续最新会话': 'Continue the latest session', '呼号（可选，会话名称）': 'Callsign (optional, session name)', '例如 fix-login': 'e.g. fix-login',
  '首个指令（可选，启动后自动发送）': 'First order (optional, sent after start)', '例如：看一下 README，告诉我这个项目怎么跑起来': 'e.g. Read the README and tell me how to run this project',
  '▶ 出击': '▶ Deploy', '语言 / Language': 'Language / 语言',
  '舰桥 · 战况': 'Fleet Bridge · status', '拖动移动 · 右键菜单': 'Drag to move · right-click for menu', '打开指挥中心': 'Open the command center',
  '折叠 / 展开': 'Fold / unfold', '折叠或展开': 'Fold or unfold', '菜单（也可以右键）': 'Menu (or right-click)', '菜单': 'Menu',
  '静音提醒': 'Mute notifications', '回到右下角': 'Back to the corner', '开机自动启动': 'Start with Windows', '舰桥 · 终端': 'Fleet Bridge · terminal',
  // widget
  '周 · ': 'Wk · ', '本周': 'Week', '{0} 已用 {1}%，{2} 重置': '{0} {1}% used, resets {2}', '读取失败': 'Read failed', '等你授权！': 'Needs approval!',
  '执行：': 'Doing: ', '做完了，等你指令': 'Done, awaiting orders', '点击打开它的终端': 'Click to open its terminal', '点击切到它的终端窗口': 'Click to switch to its terminal window',
  '还有 {0} 个，打开指挥中心查看': '{0} more, open the command center', '没有运行中的会话 · 点 ⤢ 去存档挑一个': 'No running sessions · ⤢ to pick a save',
  '作战 ': 'Busy ', '待命 ': 'Idle ', '授权 ': 'Approve ', ' · 另有 {0} 项': ' · {0} more',
  '{0} 等你授权': '{0} needs your approval', '{0} 做完了，等你指令': '{0} is done, awaiting orders', '{0} 记忆负载过高': '{0} context is too high',
};

/** Translate the Chinese source text, filling {0}, {1}… with the arguments. */
export function L(zh, ...args) {
  const s = lang === 'en' && EN[zh] != null ? EN[zh] : zh;
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => String(args[i] ?? '')) : s;
}

const ATTRS = ['title', 'aria-label', 'placeholder'];

/** Translate the static text of a page (text nodes and title / aria-label / placeholder). */
export function translateDom(root = document.body) {
  document.title = L(document.title);
  if (lang !== 'en') return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const raw = n.nodeValue;
    const key = raw.trim();
    if (key && EN[key] != null) n.nodeValue = raw.replace(key, EN[key]);
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && EN[v] != null) el.setAttribute(a, EN[v]);
    }
  }
}

/** Switch language everywhere: remember it, tell the server, reload this page (others follow via storage). */
export async function setLang(next) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not persisted: still switch this page
  }
  await fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: next }) }).catch(() => {});
  location.reload();
}

// Another window switched the language: follow it.
window.addEventListener('storage', (e) => e.key === KEY && location.reload());

// The server keeps its own copy (for reminders); make sure it matches this window's choice.
fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang }) }).catch(() => {});
