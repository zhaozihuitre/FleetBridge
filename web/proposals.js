// The "改善 PROPOSALS" tab: Fleet Bridge's own improvement proposals (server/insights), made from how it is used.
// A list grouped by where each stands, one opened in full (finding, evidence, change, benefit, risk, the
// development agent's report and tests), the decisions its status allows (approve, reject with a reason,
// later, update in place, roll back, discard), and the feature's switches. Approving and updating ask first.
import { L } from './i18n.js';
import { ask } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let deps = { post: null, toast: () => {}, render: () => {} };
let list = [];
let improve = null;
let fetchedFor = -1;
let open = null; // the id shown in full
let detail = null; // its full record
let busy = false;

export const STATUS = () => ({
  new: [L('待决定'), 'var(--amber)'],
  later: [L('稍后'), 'var(--muted)'],
  approved: [L('已同意'), 'var(--cyan)'],
  implementing: [L('开发中'), 'var(--cyan)'],
  built: [L('待更新'), 'var(--green)'],
  'needs-installer': [L('需安装包'), 'var(--amber)'],
  failed: [L('开发失败'), 'var(--red)'],
  installing: [L('更新中'), 'var(--cyan)'],
  'install-failed': [L('更新失败'), 'var(--red)'],
  installed: [L('已更新'), 'var(--green)'],
  'rolling-back': [L('回滚中'), 'var(--cyan)'],
  'rolled-back': [L('已回滚'), 'var(--muted)'],
  rejected: [L('已拒绝'), 'var(--muted)'],
  discarded: [L('已丢弃'), 'var(--muted)'],
});
const GROUPS = () => [
  [L('待决定'), ['new']],
  [L('进行中'), ['approved', 'implementing', 'installing', 'rolling-back']],
  [L('等你确认更新'), ['built', 'install-failed', 'needs-installer', 'failed']],
  [L('已更新'), ['installed']],
  [L('稍后 / 已拒绝 / 已结束'), ['later', 'rejected', 'discarded', 'rolled-back']],
];
const ACTION = () => ({
  approve: [L('同意并开发'), ''],
  reject: [L('拒绝'), 'ghost'],
  later: [L('稍后（7 天）'), 'ghost'],
  new: [L('拉回待决定'), 'ghost'],
  retry: [L('重试开发'), ''],
  install: [L('就地更新'), ''],
  rollback: [L('回滚到更新前'), 'ghost danger'],
  discard: [L('丢弃分支'), 'ghost danger'],
});

/** The tab's count: proposals waiting on the user (new ones, and built ones waiting for the word to update). */
export function proposalCount(state) {
  const s = state?.improve;
  return s ? (s.pending || 0) + (s.waiting || 0) : 0;
}

/** Fetches the list again when the server's proposals changed. */
export async function loadProposals(state, force = false) {
  const stamp = state?.improve?.stamp ?? 0;
  improve = state?.improve || improve;
  if (!force && fetchedFor === stamp) return false;
  fetchedFor = stamp;
  const r = await fetch('/api/proposals', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  if (!r) {
    fetchedFor = -1;
    return false;
  }
  list = r.proposals || [];
  improve = r.improve || improve;
  if (open) await loadDetail(open);
  return true;
}

async function loadDetail(id) {
  const r = await fetch(`/api/proposals?id=${encodeURIComponent(id)}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  detail = r?.proposal ? { ...r.proposal, allowed: r.allowed || [] } : null;
}

const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function settingsBar() {
  const s = improve?.settings;
  if (!s) return '';
  const last = improve.last;
  const lastText = last?.at ? `${L('上次分析')} ${when(last.at)}${last.model === 'failed' ? ` · ${L('模型分析失败，用了规则结果')}` : last.model === 'off' ? ` · ${L('仅规则')}` : ''}${last.error && last.model !== 'failed' ? ` · ${esc(last.error)}` : ''}` : L('还没有分析过');
  return `<div class="pp-bar">
    <label title="${esc(L('关掉后不再记录事件、不再分析；已有提案保留'))}"><input type="checkbox" data-pp-set="enabled" ${s.enabled ? 'checked' : ''}> ${L('自我改善')}</label>
    <label title="${esc(L('脱敏后的统计和片段会经本机 Claude Code 发到 Anthropic API；关掉则只用本机规则'))}"><input type="checkbox" data-pp-set="llm" ${s.llm ? 'checked' : ''} ${s.enabled ? '' : 'disabled'}> ${L('模型分析')}</label>
    <label><input type="checkbox" data-pp-set="push" ${s.push ? 'checked' : ''} ${s.enabled ? '' : 'disabled'}> ${L('推送到手机')}</label>
    <span class="pp-when">${L('每天 {0} 或满 {1} 轮', `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`, s.minTurns)}</span>
    <span class="pp-last">${lastText}</span>
    <button type="button" class="pp-btn" data-pp-analyze ${s.enabled && !improve.analyzing && !busy ? '' : 'disabled'}>${improve.analyzing ? L('分析中…') : L('立即分析')}</button>
    <button type="button" class="pp-btn ghost" data-pp-clear title="${esc(L('删除本机的事件日志（events.jsonl）；提案保留'))}">${L('清空事件日志')}</button>
  </div>`;
}

function row(p) {
  const [word, color] = STATUS()[p.status] || [p.status, 'var(--muted)'];
  const ev = p.evidence?.length || 0;
  const res = p.impl?.result;
  return `<button type="button" class="pp-row${open === p.id ? ' on' : ''}" style="--pc:${color}" data-pp-open="${esc(p.id)}">
    <span class="pp-id">${esc(p.id)}</span>
    <span class="pp-main"><b>${esc(p.title)}</b><span class="pp-sub">${esc(p.finding || '').slice(0, 140)}</span></span>
    <span class="pp-tags"><i class="pp-st">${esc(word)}</i><i>${L('工作量')} ${esc(p.effort)}</i><i>${L('证据')} ${ev}</i>${p.count ? `<i>×${p.count}</i>` : ''}${res?.tests ? `<i>${L('测试')} ${res.tests.pass}/${res.tests.pass + res.tests.fail}</i>` : ''}<i>${when(p.createdAt)}</i></span>
  </button>${open === p.id ? full() : ''}`;
}

function full() {
  const p = detail;
  if (!p) return `<div class="pp-full">${L('读取中…')}</div>`;
  const evidence = (p.evidence || []).map((e) => `<li><code>${esc(e.ref || e.metric)}</code>${e.value ? ` = ${esc(e.value)}` : ''}${e.quote ? `<q>${esc(e.quote)}</q>` : ''}</li>`).join('');
  const res = p.impl?.result;
  const build = p.impl
    ? `<section><h4>${L('开发')}</h4><p>${L('分支')} <code>${esc(p.impl.branch || '')}</code>${p.impl.worktree ? ` · <code>${esc(p.impl.worktree)}</code>` : ''}</p>
      ${res ? `<p>${esc((STATUS()[res.status] || [res.status])[0])}${res.reason ? ' · ' + esc(res.reason) : ''}${res.tests ? ` · ${L('测试')} ${res.tests.pass} ${L('通过')} / ${res.tests.fail} ${L('失败')}` : ''}</p>` : ''}
      ${res?.files?.length ? `<p>${L('改动文件')}：${res.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>` : ''}
      ${res?.stat ? `<pre class="pp-pre">${esc(res.stat)}</pre>` : ''}
      ${res?.tests && !res.tests.ok ? `<pre class="pp-pre">${esc(res.tests.tail || '')}</pre>` : ''}
      ${p.impl.reply ? `<details open><summary>${L('开发 agent 的汇报')}</summary><pre class="pp-pre">${esc(p.impl.reply)}</pre></details>` : ''}
      ${p.impl.installResult ? `<p>${L('更新')}：${p.impl.installResult.ok ? esc(p.impl.installResult.version || 'ok') : L('失败，已回退')}${p.impl.installResult.kept ? ` · ${L('终端保留')} ${esc(p.impl.installResult.kept)}` : ''}</p><pre class="pp-pre">${esc(p.impl.installResult.tail || '')}</pre>` : ''}
    </section>`
    : '';
  const hist = (p.history || []).map((h) => `<li>${when(h.at)} · ${esc(h.by)} · ${esc((STATUS()[h.action] || [h.action])[0])}${h.note ? ` · ${esc(h.note.split('\n')[0].slice(0, 120))}` : ''}</li>`).join('');
  const buttons = (p.allowed || []).map((a) => `<button type="button" class="pp-btn ${ACTION()[a]?.[1] || ''}" data-pp-act="${a}" ${busy ? 'disabled' : ''}>${esc(ACTION()[a]?.[0] || a)}</button>`).join('');
  const needNote = (p.allowed || []).some((a) => a === 'reject' || a === 'later');
  return `<div class="pp-full">
    <section><h4>${L('现象')}</h4><p>${esc(p.finding)}</p></section>
    <section><h4>${L('证据')}</h4><ul class="pp-ev">${evidence || `<li>${L('（无）')}</li>`}</ul></section>
    <section><h4>${L('建议改动')}</h4><p>${esc(p.change)}</p></section>
    <div class="pp-cols"><section><h4>${L('预期收益')}</h4><p>${esc(p.benefit)}</p></section><section><h4>${L('工作量 / 风险')}</h4><p>${esc(p.effort)} · ${esc(p.risk)}</p></section></div>
    ${p.decision?.note ? `<section><h4>${L('你的备注')}</h4><p>${esc(p.decision.note)}</p></section>` : ''}
    ${build}
    ${needNote ? `<input class="pp-note" id="pp-note" maxlength="500" placeholder="${esc(L('理由或备注（拒绝时会记下，以后不再提同类）'))}">` : ''}
    <div class="pp-acts">${buttons || `<span class="pp-sub">${L('当前没有可做的操作')}</span>`}</div>
    ${hist ? `<details><summary>${L('记录')}</summary><ul class="pp-hist">${hist}</ul></details>` : ''}
  </div>`;
}

/** The tab's page. */
export function proposalsPage() {
  const groups = GROUPS()
    .map(([name, sts]) => {
      const items = list.filter((p) => sts.includes(p.status));
      return items.length ? `<div class="o-day">${esc(name)} · ${items.length}</div>${items.map(row).join('')}` : '';
    })
    .join('');
  const empty = `<div class="pp-empty">${improve?.settings?.enabled === false ? L('自我改善已关闭。打开后，舰桥会记录使用情况，每天分析一次并在这里提出改进舰桥自身的建议。') : L('还没有提案。舰桥每天分析一次使用情况（通知、指令、读屏、授权等待、手动纠正、失败的工具调用…），发现可改进的地方会列在这里，你同意后才会开发和更新。')}</div>`;
  return `<div class="proposals"><div class="archive-head"><span class="mono">PROPOSALS</span><span>${L('根据使用情况提出的舰桥改进；同意后在独立分支开发，更新前会再问你')}</span></div>${settingsBar()}${groups || empty}</div>`;
}

async function act(id, action) {
  const p = detail?.id === id ? detail : list.find((x) => x.id === id);
  if (!p) return;
  const note = document.getElementById('pp-note')?.value?.trim() || '';
  const confirmations = {
    approve: { title: L('同意并开发 {0}？', id), message: p.title, detail: [L('舰桥会在 FleetBridge 仓库的一个独立 worktree 分支（improve/{0}）里启动开发 agent：实现、测试、本地提交，然后向你汇报。', id.toLowerCase()), L('不会改动你的主仓库工作区，不会 push、不会发版；更新安装前会再问你。')], ok: L('同意并开发') },
    install: { title: L('就地更新到 {0} 的版本？', id), message: p.title, detail: [L('用 tools/update.mjs 就地更新正在运行的舰桥：窗口会刷新，终端继续运行。'), L('新版本起不来会自动回到当前版本；之后也可以随时回滚。')], ok: L('更新') },
    rollback: { title: L('回滚 {0}？', id), message: L('回到更新前的版本（tools/update.mjs --rollback）。'), ok: L('回滚'), danger: true },
    discard: { title: L('丢弃 {0} 的分支？', id), message: L('删除它的 worktree 和分支 improve/{0}（未合并的改动会丢失）。', id.toLowerCase()), ok: L('丢弃'), danger: true },
    retry: { title: L('重新开发 {0}？', id), message: L('在同一个分支上再派一次开发 agent。'), ok: L('重试') },
  };
  if (confirmations[action] && !(await ask(confirmations[action]))) return;
  busy = true;
  deps.render();
  try {
    const r = await deps.post('/api/proposals/decide', { id, action, note });
    if (r.error) deps.toast(L('没有成功：{0}', r.error));
    else deps.toast(`${id} → ${(STATUS()[r.proposal.status] || [r.proposal.status])[0]}`);
  } finally {
    busy = false;
    fetchedFor = -1;
    await loadProposals({ improve }, true);
    deps.render();
  }
}

export function initProposals(d) {
  deps = { ...deps, ...d };
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const o = t.closest?.('[data-pp-open]');
    if (o) {
      const id = o.dataset.ppOpen;
      open = open === id ? null : id;
      detail = null;
      deps.render();
      if (open) {
        await loadDetail(open);
        deps.render();
      }
      return;
    }
    const a = t.closest?.('[data-pp-act]');
    if (a && open) return act(open, a.dataset.ppAct);
    if (t.closest?.('[data-pp-analyze]')) {
      busy = true;
      deps.render();
      deps.toast(L('开始分析，可能要一两分钟…'));
      try {
        const r = await deps.post('/api/proposals/analyze', {});
        deps.toast(r.error ? L('分析失败：{0}', r.error) : r.added?.length ? L('新提案 {0} 条', r.added.length) : L('没有新的提案'));
      } finally {
        busy = false;
        fetchedFor = -1;
        await loadProposals({ improve }, true);
        deps.render();
      }
      return;
    }
    if (t.closest?.('[data-pp-clear]')) {
      if (!(await ask({ title: L('清空事件日志？'), message: L('删除本机记录的使用事件（events.jsonl）。提案和其他数据不受影响。'), ok: L('清空'), danger: true }))) return;
      await deps.post('/api/improve/clear', {});
      deps.toast(L('已清空'));
    }
  });
  document.addEventListener('change', async (e) => {
    const k = e.target?.dataset?.ppSet;
    if (!k) return;
    const r = await deps.post('/api/improve/settings', { [k]: e.target.checked });
    improve = { ...(improve || {}), settings: r };
    deps.render();
  });
}
