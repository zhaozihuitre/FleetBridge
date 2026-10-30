// Popped-out terminal window: one agent, full window.
import { createTerminal } from './terminal.js';
import { ask } from './ui.js';

const id = location.hash.slice(1);
const pane = document.getElementById('pane');
const q = (s) => pane.querySelector(s);
const t = createTerminal(document.getElementById('host'), id, { fontSize: 14 });

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

function render(state) {
  const a = state.agents?.find((x) => x.id === id);
  const u = state.units?.find((x) => x.agentId === id);
  const name = a?.name || u?.name || id.slice(0, 8);
  q('.t-name').textContent = name;
  q('.t-cwd').textContent = a?.cwd || u?.cwd || '';
  const [label, cls] = !a?.alive ? ['● 已退出', 'off'] : u?.permission ? ['● 等你授权', 'permit'] : u?.status === 'busy' ? ['● 作战中', 'busy'] : ['● 待命', 'on'];
  q('.t-state').textContent = label;
  q('.t-state').className = 't-state ' + cls;
  q('.t-ctx').innerHTML = ''; // rebuilt every update: load badge, then the repo tag
  if (u?.contextPct != null) {
    const pct = Math.round(u.contextPct);
    const color = pct >= state.thresholds.contextWarnPct ? 'var(--red)' : 'var(--cyan)';
    const k = u.contextTokens >= 1000 ? Math.round(u.contextTokens / 1000) + 'K' : String(u.contextTokens);
    q('.t-ctx').innerHTML = `<span class="ctx-badge" style="--cc:${color}"><i style="width:${Math.min(100, pct)}%"></i></span><span class="ctx-num" style="color:${color}">${pct}% · ${k}</span>`;
  }
  // which repo this agent pushes to: the one Claude edited last, else the only one in its folder
  const repos = (u?.repos || []).filter((r) => !r.error);
  const active = repos.filter((r) => r.claudeTouchedAt).sort((x, y) => y.claudeTouchedAt - x.claudeTouchedAt)[0] || (repos.length === 1 ? repos[0] : null);
  if (active) {
    const tag = document.createElement('span');
    tag.className = 't-repo' + (active.remote ? '' : ' warn');
    tag.textContent = `⎇ ${active.remote ? active.remote.slug : '无远程'} · ${active.branch || ''}`;
    tag.title = repos.map((r) => `${r.name} → ${r.remote ? r.remote.host + '/' + r.remote.slug : '无远程'}`).join('\n');
    q('.t-ctx').appendChild(tag);
  }
  pane.querySelectorAll('button').forEach((b) => (b.disabled = !a?.alive));
  document.title = `${name} · 舰桥`;
}

new EventSource('/api/stream').onmessage = (e) => render(JSON.parse(e.data));

pane.querySelector('.term-actions').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tkey) await post('/api/agents/action', { id, action: 'key', key: b.dataset.tkey });
  else if (b.dataset.tcmd) await post('/api/agents/action', { id, action: 'text', text: b.dataset.tcmd });
  else if (b.dataset.tact === 'kill' && (await ask({ danger: true, title: '结束这个 Claude？', message: '进程会退出，会话记录保留，可以从存档继续。', ok: '结束' })))
    await post('/api/agents/action', { id, action: 'kill' });
  t.focus();
});
