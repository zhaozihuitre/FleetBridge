import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Quota burn rate: every usage reading is kept (per limit, within its reset window), and the rise
// over a stretch of the past says how fast each quota goes and whether it runs out before it resets.
// Each limit is forecast on its own, over a stretch that fits it:
// - the 5-hour limit: the last hour (it is spent in bursts, and only the next few hours matter);
// - weekly limits: the average since the week began (nights, breaks and weekends included), once
//   half a day of it has gone by. The last few busy hours stretched over days used to say "runs out
//   at 23:37" (tomorrow, shown without the date) with a third of the week used and four days to go.
const FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'usage-history.demo.json' : 'usage-history.json');
const KEEP_MS = 8 * 86_400_000;
const HOUR = 3_600_000;
const SESSION = { span: HOUR, min: 10 * 60_000, length: 5 * HOUR, basis: '1h' };
const WEEKLY = { span: 7 * 24 * HOUR, min: 12 * HOUR, length: 7 * 24 * HOUR, basis: 'week' };
const kind = (key) => (key === 'session' ? SESSION : WEEKLY);

let points = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).filter((p) => p && p.key && Number.isFinite(p.t));
  } catch {
    return [];
  }
}

/** Remember one usage reading (cached / rate-limited readings repeat their fetchedAt and are skipped). */
export function recordUsage(usage) {
  if (!usage?.limits?.length || !usage.fetchedAt || usage.error) return;
  const t = usage.fetchedAt;
  if (points.some((p) => p.t === t)) return;
  for (const l of usage.limits) points.push({ t, key: l.key, used: l.usedPct, resetsAt: l.resetsAt });
  points = points.filter((p) => t - p.t <= KEEP_MS);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(points));
  } catch {
    // history is a convenience: keep going without it
  }
}

/**
 * key -> { perHour, basis, runsOutAt, lasts } for every limit with enough readings in its current window.
 * runsOutAt: only when it runs out before the reset; lasts: in use, but it holds until the reset.
 * basis: the stretch the rate is over: '1h' (the last hour) or 'week' (since the week began).
 */
export function forecast(limits, now = Date.now(), history = points) {
  const out = {};
  for (const l of limits || []) {
    const k = kind(l.key);
    // same reset window (the reset time can wobble by a few seconds between readings)
    const pts = history.filter((p) => p.key === l.key && Math.abs(p.resetsAt - l.resetsAt) < 120_000 && p.t <= now).sort((a, b) => a.t - b.t);
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    const from = now - k.span;
    // the rise since `from`: from the last reading at or before it; with none, from the window's
    // start (nothing used at the reset) when that is within the stretch, else from the first reading
    const before = pts.filter((p) => p.t <= from).pop();
    const start = l.resetsAt - k.length;
    const anchor = before || (start >= from ? { t: start, used: 0 } : pts[0]);
    const basis = k.basis;
    if (last.t - anchor.t < k.min) continue;
    const perHour = Math.max(0, ((last.used - anchor.used) / (last.t - anchor.t)) * HOUR);
    const left = 100 - l.usedPct;
    const at = perHour > 0.05 ? now + (left / perHour) * HOUR : null;
    const runsOut = at !== null && at < l.resetsAt;
    out[l.key] = { perHour: Math.round(perHour * 10) / 10, basis, runsOutAt: runsOut ? Math.round(at) : null, lasts: at !== null && !runsOut };
  }
  return out;
}
