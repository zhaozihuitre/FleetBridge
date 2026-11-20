import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// The improvement proposals and what became of them, in <data>/proposals.json. Each one:
//   { id: 'P-007', fingerprint, title, finding, evidence[], change, benefit, effort, risk, source: 'rules'|'model',
//     status, count, createdAt, updatedAt, history: [{ at, by, action, note }], decision?, impl? }
// status:  new → (later) later → new after 7 days
//              → (reject) rejected                     never proposed again (unless it got 3× worse)
//              → (approve) approved → implementing → built | needs-installer | failed (→ retry: implementing)
//          built → (install) installing → installed | install-failed      (→ rollback: rolled-back)
//          installed → (rollback) rolling-back → rolled-back
//          implementing / built / failed / needs-installer / install-failed / rolled-back → (discard) discarded
// Dedup: the same fingerprint, or a title much like another's, is the same proposal (its count and evidence
// are updated, not a new one). Installed: nothing of its kind again for 30 days.

export const PROPOSALS_FILE = path.join(DATA_DIR, 'proposals.json');
const DAY = 86_400_000;
const LATER_DAYS = 7;
const INSTALLED_QUIET_DAYS = 30;
const WORSE = 3;
const KEEP_CLOSED = 200;

const OPEN = ['new', 'later', 'approved', 'implementing', 'built', 'needs-installer', 'failed', 'installing', 'install-failed', 'rolling-back'];
export const STATUSES = [...OPEN, 'installed', 'rolled-back', 'rejected', 'discarded'];

export function createStore(file = PROPOSALS_FILE) {
  let db = { seq: 0, items: [], lastAnalysis: null };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.items)) db = { seq: j.seq || 0, items: j.items, lastAnalysis: j.lastAnalysis || null };
  } catch {
    // none yet
  }
  const save = () => {
    // closed ones are kept (the rejected ones matter for dedup) up to a limit
    const closed = db.items.filter((p) => !OPEN.includes(p.status));
    if (closed.length > KEEP_CLOSED) {
      const drop = new Set(closed.filter((p) => p.status !== 'rejected').slice(0, closed.length - KEEP_CLOSED).map((p) => p.id));
      db.items = db.items.filter((p) => !drop.has(p.id));
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
    } catch {
      // kept for this run
    }
  };
  const get = (id) => db.items.find((p) => p.id === id) || null;
  const note = (p, by, action, extra = '', now = Date.now()) => {
    p.history = [...(p.history || []), { at: now, by, action, note: String(extra || '').slice(0, 500) }].slice(-50);
    p.updatedAt = now;
  };

  /** "Later" ones whose week is over come back as new. */
  function wake(now = Date.now()) {
    let n = 0;
    for (const p of db.items)
      if (p.status === 'later' && now - (p.laterAt || p.updatedAt) >= LATER_DAYS * DAY) {
        p.status = 'new';
        note(p, 'system', 'woke', '', now);
        n++;
      }
    if (n) save();
    return n;
  }

  /**
   * Takes the candidates of an analysis: new proposals, or more evidence for ones already there.
   * @returns {{ added: object[], updated: object[], skipped: { title: string, why: string }[] }}
   */
  function merge(cands, now = Date.now()) {
    const added = [];
    const updated = [];
    const skipped = [];
    for (const c of cands) {
      if (!c?.title || !c.fingerprint) continue;
      const same = db.items.filter((p) => p.fingerprint === c.fingerprint || similar(p.title, c.title) >= 0.6);
      const rejected = same.find((p) => p.status === 'rejected');
      const open = same.find((p) => OPEN.includes(p.status));
      const installed = same.find((p) => p.status === 'installed' && now - (p.installedAt || p.updatedAt) < INSTALLED_QUIET_DAYS * DAY);
      if (open) {
        open.count = Math.max(open.count || 0, c.count || 0);
        open.evidence = c.evidence?.length ? c.evidence : open.evidence;
        open.metric = c.metric || open.metric;
        open.seenAt = now;
        if (open.status === 'new' && c.source === 'model' && open.source === 'rules') Object.assign(open, pick(c), { source: 'model' }); // the model's wording is better
        updated.push(open);
        continue;
      }
      if (installed) {
        skipped.push({ title: c.title, why: 'installed-recently' });
        continue;
      }
      if (rejected) {
        // only when it got much worse than when it was turned down, and then once
        const was = rejected.countAtReject || rejected.count || 0;
        if (!(was > 0 && (c.count || 0) >= was * WORSE) || same.some((p) => p.reopenOf === rejected.id)) {
          skipped.push({ title: c.title, why: 'rejected' });
          continue;
        }
      }
      const p = { id: `P-${String(++db.seq).padStart(3, '0')}`, ...pick(c), fingerprint: c.fingerprint, source: c.source || 'rules', metric: c.metric || null, count: c.count || 0, status: 'new', createdAt: now, updatedAt: now, seenAt: now, history: [] };
      if (rejected) {
        p.reopenOf = rejected.id;
        p.finding = `${p.finding}\n（${rejected.id} 曾被拒绝${rejected.decision?.note ? '：' + rejected.decision.note : ''}；之后明显恶化，再提一次）`;
      }
      note(p, 'system', 'proposed', c.source || 'rules', now);
      db.items.push(p);
      added.push(p);
    }
    if (added.length || updated.length) save();
    return { added, updated, skipped };
  }

  /** A decision of the user's (or a step of the implementation): returns the proposal, or throws. */
  function setStatus(id, status, by, extra = {}, now = Date.now()) {
    const p = get(id);
    if (!p) throw new Error('unknown_proposal');
    p.status = status;
    if (status === 'later') p.laterAt = now;
    if (status === 'rejected') p.countAtReject = p.count || 0;
    if (status === 'installed') p.installedAt = now;
    if (extra.decision) p.decision = { at: now, by, ...extra.decision };
    if (extra.impl) p.impl = { ...(p.impl || {}), ...extra.impl };
    note(p, by, status, extra.note || '', now);
    save();
    return p;
  }

  const list = () => [...db.items].sort((a, b) => b.createdAt - a.createdAt);
  const titles = () => db.items.map((p) => ({ id: p.id, title: p.title, status: p.status, fingerprint: p.fingerprint, why: p.decision?.note || '' }));
  const setLastAnalysis = (x) => {
    db.lastAnalysis = x;
    save();
  };
  return { get, list, merge, setStatus, wake, titles, save, lastAnalysis: () => db.lastAnalysis, setLastAnalysis };
}

const pick = (c) => ({
  title: String(c.title).slice(0, 120),
  finding: String(c.finding || '').slice(0, 2000),
  evidence: (c.evidence || []).slice(0, 8),
  change: String(c.change || '').slice(0, 2000),
  benefit: String(c.benefit || '').slice(0, 600),
  effort: ['S', 'M', 'L'].includes(c.effort) ? c.effort : 'M',
  risk: String(c.risk || '').slice(0, 600),
});

/** How alike two titles are: the Jaccard index of their character pairs (0…1). */
export function similar(a, b) {
  const grams = (s) => {
    const t = String(s || '').toLowerCase().replace(/[\s\p{P}]+/gu, '');
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** Which decisions a proposal in this status takes (the buttons). */
export function allowed(status) {
  return (
    {
      new: ['approve', 'reject', 'later'],
      later: ['approve', 'reject', 'new'],
      implementing: ['discard'],
      failed: ['retry', 'discard', 'reject'],
      built: ['install', 'discard'],
      'needs-installer': ['discard'],
      'install-failed': ['install', 'discard'],
      installed: ['rollback'],
      'rolled-back': ['install', 'discard'],
    }[status] || []
  );
}
