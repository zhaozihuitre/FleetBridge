// Wrapping up (improvement P-010): which of our terminals may be ended in one go. Ending several idle
// terminals used to be one "/exit" order each. Only a terminal with nothing going on and nothing owed is
// ended; every other one is passed over with the reason, so a slip of the hand cannot end work in progress.
// Decided here, on the server, at the moment of ending: what the page or the master saw a while ago
// (a list in a confirmation dialog) does not count.

export const JUST_ORDERED = 15_000; // an order typed in this recently may not show as "working" yet

/**
 * Why a terminal is passed over, most telling first; null = idle with nothing owed.
 * a: an agent as in the published state ({ alive, kind, queue, masterTurn, waiting, orderedAt });
 * u: its live unit, if its session is known yet.
 */
export function busyReason(a, u, now = Date.now()) {
  if (!u) return a.waiting ? 'needs-answer' : 'starting';
  if (u.permission) return u.permission.prompt?.kind === 'question' ? 'needs-answer' : 'needs-approval';
  if (u.status !== 'idle') return 'working';
  if (a.orderedAt && now - a.orderedAt < JUST_ORDERED) return 'just-ordered';
  if (a.queue?.length) return 'queued'; // orders still to go out, held ones too: ending it would strand them
  if (a.masterTurn) return 'unreported'; // the master's order ended but its report has not gone to the master yet
  return null;
}

/**
 * @param {{ agents: object[], units: object[], only?: string[] | null, now?: number }} o
 *   only: agent ids to consider (a selection); without it, every live Claude terminal of ours
 * @returns {{ close: { id, name, project, unseen }[], skip: { id, name, project, reason }[] }}
 *   unseen: its last turn ended after its terminal was last looked at (said in the confirmation, not a reason to keep it:
 *   the session and its answer stay)
 */
export function wrapupPlan({ agents = [], units = [], only = null, now = Date.now() }) {
  const unitOf = new Map(units.filter((u) => u.agentId).map((u) => [u.agentId, u]));
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const byId = new Map(agents.map((a) => [a.id, a]));
  const picked = only ? [...new Set(only)].map((id) => byId.get(id) || { id, missing: true }) : agents.filter((a) => a.alive && (a.kind || 'claude') === 'claude');
  const close = [];
  const skip = [];
  for (const a of picked) {
    const u = unitOf.get(a.id);
    const who = { id: a.id, name: a.name || u?.name || base(a.cwd) || String(a.id).slice(0, 8), project: base(a.cwd) };
    // a selection may name what is not a live Claude terminal: said, never ended here
    const reason = a.missing || !a.alive ? 'gone' : (a.kind || 'claude') !== 'claude' ? 'not-claude' : busyReason(a, u, now);
    if (reason) skip.push({ ...who, reason });
    else close.push({ ...who, unseen: Boolean(u.seenAt && (u.statusSince || 0) > u.seenAt) });
  }
  return { close, skip };
}
