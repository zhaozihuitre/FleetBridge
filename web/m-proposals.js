// The phone page's "改善" list: the improvement proposals, one opened in full, and the decisions its status allows
// (approve, reject with a reason, later, update, roll back, discard). The switches stay on the computer.
import { L } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLOR = { new: 'var(--amber)', built: 'var(--green)', installed: 'var(--green)', failed: 'var(--red)', 'install-failed': 'var(--red)', implementing: 'var(--cyan)', installing: 'var(--cyan)', 'rolling-back': 'var(--cyan)', approved: 'var(--cyan)', 'needs-installer': 'var(--amber)' };
const WORD = () => ({ new: L('待决定'), later: L('稍后'), approved: L('已同意'), implementing: L('开发中'), built: L('待更新'), 'needs-installer': L('需安装包'), failed: L('开发失败'), installing: L('更新中'), 'install-failed': L('更新失败'), installed: L('已更新'), 'rolling-back': L('回滚中'), 'rolled-back': L('已回滚'), rejected: L('已拒绝'), discarded: L('已丢弃') });
const ACT = () => ({ approve: L('同意并开发'), reject: L('拒绝'), later: L('稍后'), new: L('拉回'), retry: L('重试'), install: L('就地更新'), rollback: L('回滚'), discard: L('丢弃分支') });
const ORDER = ['new', 'built', 'install-failed', 'failed', 'needs-installer', 'implementing', 'approved', 'installing', 'rolling-back', 'installed', 'later', 'rolled-back', 'rejected', 'discarded'];

let list = [];
let stamp = -1;
let open = null;
let detail = null;
let busy = false;
let deps = { toast: () => {}, render: () => {} };

export const pendingProposals = (state) => (state?.improve ? (state.improve.pending || 0) + (state.improve.waiting || 0) : 0);

export async function loadPhoneProposals(state) {
  const s = state?.improve?.stamp ?? 0;
  if (s === stamp) return false;
  stamp = s;
  const r = await fetch('/api/proposals', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) {
    stamp = -1;
    return false;
  }
  list = (r.proposals || []).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.createdAt - a.createdAt);
  if (open) await loadOne(open);
  return true;
}

async function loadOne(id) {
  const r = await fetch(`/api/proposals?id=${encodeURIComponent(id)}`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  detail = r?.proposal ? { ...r.proposal, allowed: r.allowed || [] } : null;
}

function full() {
  const p = detail;
  if (!p) return `<div class="pp-m-full">${L('读取中…')}</div>`;
  const ev = (p.evidence || []).map((e) => `<li>${esc(e.ref || e.metric)}${e.value ? ' = ' + esc(e.value) : ''}${e.quote ? `<br><span class="sub">${esc(e.quote)}</span>` : ''}</li>`).join('');
  const res = p.impl?.result;
  return `<div class="pp-m-full">
    <h4>${L('现象')}</h4><p>${esc(p.finding)}</p>
    <h4>${L('证据')}</h4><ul>${ev || `<li>${L('（无）')}</li>`}</ul>
    <h4>${L('建议改动')}</h4><p>${esc(p.change)}</p>
    <h4>${L('预期收益')}</h4><p>${esc(p.benefit)}</p>
    <h4>${L('工作量 / 风险')}</h4><p>${esc(p.effort)} · ${esc(p.risk)}</p>
    ${res ? `<h4>${L('开发')}</h4><p>${esc(WORD()[res.status] || res.status)}${res.reason ? ' · ' + esc(res.reason) : ''}${res.tests ? ` · ${L('测试')} ${res.tests.pass}/${res.tests.pass + res.tests.fail}` : ''}${res.files?.length ? ` · ${L('{0} 个文件', res.files.length)}` : ''}</p>` : ''}
    ${p.impl?.reply ? `<details><summary>${L('开发 agent 的汇报')}</summary><pre>${esc(p.impl.reply)}</pre></details>` : ''}
    ${p.impl?.installResult ? `<p>${L('更新')}：${p.impl.installResult.ok ? esc(p.impl.installResult.version || 'ok') : L('失败，已回退')}</p>` : ''}
    <div class="pp-m-acts">${(p.allowed || []).map((a) => `<button type="button" data-ppm-act="${a}" class="${['reject', 'discard', 'rollback'].includes(a) ? 'ghost' : ''}" ${busy ? 'disabled' : ''}>${esc(ACT()[a] || a)}</button>`).join('')}</div>
  </div>`;
}

export function phoneProposalsHtml(state, empty) {
  if (state?.improve?.settings?.enabled === false) return `<div class="empty">${empty}${L('自我改善已在电脑上关闭')}</div>`;
  return (
    list
      .map((p) => {
        const inner = `<div class="head"><span class="nk">${esc(p.id)} · ${esc(WORD()[p.status] || p.status)}</span><span class="nm">${L('工作量')} ${esc(p.effort)}</span></div><div class="nt-title">${esc(p.title)}</div>`;
        return `<button type="button" class="card notice" style="--c:${COLOR[p.status] || 'var(--muted)'}" data-ppm-open="${esc(p.id)}">${inner}<span class="go" aria-hidden="true">${open === p.id ? '⌄' : '›'}</span></button>${open === p.id ? full() : ''}`;
      })
      .join('') || `<div class="empty">${empty}${L('还没有改善提案')}</div>`
  );
}

const CONFIRM = () => ({
  approve: L('同意后，舰桥会在独立分支里派开发 agent 实现并测试，完成后再问你是否更新。确定？'),
  install: L('就地更新正在运行的舰桥（窗口会刷新，终端继续运行；起不来会自动回退）。确定？'),
  rollback: L('回到更新前的版本？'),
  discard: L('删除这个提案的分支和 worktree（未合并的改动会丢失）？'),
  retry: L('再派一次开发 agent？'),
});

export function initPhoneProposals(d) {
  deps = { ...deps, ...d };
  document.addEventListener('click', async (e) => {
    const o = e.target.closest?.('[data-ppm-open]');
    if (o) {
      open = open === o.dataset.ppmOpen ? null : o.dataset.ppmOpen;
      detail = null;
      deps.render();
      if (open) {
        await loadOne(open);
        deps.render();
      }
      return;
    }
    const a = e.target.closest?.('[data-ppm-act]');
    if (!a || !open) return;
    const action = a.dataset.ppmAct;
    let note = '';
    if (action === 'reject' || action === 'later') {
      const r = prompt(action === 'reject' ? L('拒绝的理由（会记下，以后不再提同类）') : L('备注（可空）'), '');
      if (r === null) return;
      note = r;
    } else if (CONFIRM()[action] && !confirm(CONFIRM()[action])) return;
    busy = true;
    deps.render();
    try {
      const res = await fetch('/api/proposals/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: open, action, note }) }).then((x) => x.json());
      deps.toast(res.error ? L('没有成功：{0}', res.error) : `${open} → ${WORD()[res.proposal.status] || res.proposal.status}`);
    } catch {
      deps.toast(L('没有成功'));
    } finally {
      busy = false;
      stamp = -1;
      await loadPhoneProposals({ improve: { stamp: Date.now() } });
      deps.render();
    }
  });
}
