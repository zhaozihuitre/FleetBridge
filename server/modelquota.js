// Which quota a terminal's model runs on, and when it resets.
// The usage API lists every limit: the 5-hour and weekly ones count every model, and a per-model weekly
// one (key "<kind>:<display name>", e.g. "weekly_scoped:Fable") only that model. A terminal is held by
// whichever of those it is under is the tightest: the one gating requests now (active), else the most used;
// on a tie the model's own. Its terminal's organization decides whose reading (each has its own quota).

// "Fable" -> "fable", "Opus 5.5" -> "opus-5-5": matched against the model id ("claude-fable-5-2[1m]")
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The limits a model counts against: those for every model, and its own. */
export function limitsForModel(limits, model) {
  const id = norm(model);
  return (limits || []).filter((l) => {
    const name = String(l.key || '').split(':')[1];
    return !name || (id && norm(name) && id.includes(norm(name)));
  });
}

const rank = (l) => (l.active ? 1000 : 0) + (Number.isFinite(l.usedPct) ? l.usedPct : 0) + (String(l.key).includes(':') ? 0.5 : 0);

/**
 * A terminal's quota: the limit holding it, and every limit its model is under (for the tooltip).
 * @param {string|null} model the model id the terminal last used
 * @param {Array} limits the reading of the terminal's organization (labels set, rolled-over windows at 0)
 * @param {{ asOf?: number }} [o] asOf: when another organization's reading was made (not read live now)
 */
export function modelQuota(model, limits, o = {}) {
  if (!model || model === '<synthetic>') return null;
  const all = limitsForModel(limits, model);
  if (!all.length) return null;
  const pick = (l) => ({ key: l.key, label: l.label, usedPct: Number.isFinite(l.usedPct) ? l.usedPct : 0, resetsAt: l.resetsAt > 0 ? l.resetsAt : 0, active: Boolean(l.active), own: String(l.key).includes(':') });
  const top = all.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return { ...pick(top), all: all.map(pick), asOf: o.asOf || null };
}
