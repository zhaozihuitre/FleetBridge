// MONITOR_DEMO=1: fake sessions over real project folders, for working on the UI
// when few Claude Code sessions are open. Git data is still scanned for real.
const MIN = 60_000;
const boot = Date.now();

export function demoSessions() {
  const now = Date.now();
  const t = (ms) => new Date(now - ms).toISOString();
  const cycle = Math.floor((now - boot) / (20 * 1000)) % 2; // flips every 20s so transitions show up
  return [
    {
      pid: process.pid, sessionId: 'demo-shop-app', cwd: 'D:\\projects\\shop-app', project: 'shop-app', name: 'checkout-flow',
      status: 'idle', statusSince: now - 1 * MIN, startedAt: now - 120 * MIN, model: 'claude-opus-5-5',
      contextTokens: 940_838, contextWindow: 1_000_000, contextPct: 94.1,
      lastText: '已完成 Go / Flutter / Python 三端代码审查，汇总了 12 条问题。', lastPrompt: '三端一起 review 一下', lastActivity: now - 1 * MIN,
      agents: [
        { id: 'a1', type: 'Explore', description: 'Review Go backend', running: false },
        { id: 'a2', type: 'Explore', description: 'Review Flutter app', running: false },
        { id: 'a3', type: 'Explore', description: 'Review Python agent', running: false },
      ],
      edits: new Map([
        ['d:/projects/shop-app/shop-mobile/lib/pages/patrol_page.dart', t(140 * MIN)],
        ['d:/projects/shop-app/shop-agent/app/main.py', t(26 * 60 * MIN)],
      ]),
    },
    {
      pid: process.pid, sessionId: 'demo-returns-api', cwd: 'D:\\projects\\returns-api', project: 'returns-api', name: 'close-public-ingress',
      status: cycle ? 'busy' : 'idle', statusSince: cycle ? now - 2 * MIN : now - 113 * MIN, startedAt: now - 200 * MIN, model: 'claude-opus-5-5',
      contextTokens: 85_699, contextWindow: 1_000_000, contextPct: 8.6,
      lastText: '关闭生产前端公网 IP 的方案已列出，等你确认是否执行。', lastPrompt: '把生产前端的公网 IP 关掉', lastActivity: now - 2 * MIN,
      agents: cycle ? [{ id: 'b1', type: 'Explore', description: '检查 Ingress 依赖', running: true }] : [],
      edits: new Map([['d:/projects/returns-api/returns-web/k8s/ingress.yaml', t(25 * 60 * MIN)]]),
    },
    {
      pid: process.pid, sessionId: 'demo-qc', cwd: 'D:\\projects\\image-service', project: 'image-service', name: 'fix-upload-retry',
      status: 'busy', statusSince: now - 6 * MIN, startedAt: now - 30 * MIN, model: 'claude-opus-5-5',
      permission: { at: boot, message: 'Claude needs your permission to use Bash' },
      contextTokens: 312_000, contextWindow: 1_000_000, contextPct: 31.2,
      lastText: null, lastPrompt: '上传失败时加指数退避重试', lastActivity: now - 10_000,
      agents: [], edits: new Map(),
    },
  ];
}
