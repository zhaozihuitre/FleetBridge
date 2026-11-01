import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Quota burn rate: every usage reading is kept (per limit, within its reset window), and the slope
// over the recent past says how fast the quota goes and whether it runs out before it resets.
const FILE = path.join(DATA_DIR, process.env.MONITOR_DEMO ? 'usage-history.demo.json' : 'usage-history.json');
const KEEP_MS = 8 * 86_400_000;
const MIN_SPAN = 10 * 60_000; // need at least 10 minutes of readings for a rate
const WINDOW = { session: 60 * 60_000 }; // the 5-hour limit: last hour; weekly ones: last 6 hours
const DEFAULT_WINDOW = 6 * 60 * 60_000;

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

/** key -> { perHour, runsOutAt } for every limit with enough recent readings in its current window. */
export function forecast(limits, now = Date.now()) {
  const out = {};
  for (const l of limits || []) {
    const span = WINDOW[l.key] || DEFAULT_WINDOW;
    // same reset window (the reset time can wobble by a few seconds between readings)
    const pts = points.filter((p) => p.key === l.key && Math.abs(p.resetsAt - l.resetsAt) < 120_000 && now - p.t <= span).sort((a, b) => a.t - b.t);
    if (pts.length < 2) continue;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (last.t - first.t < MIN_SPAN) continue;
    const perHour = ((last.used - first.used) / (last.t - first.t)) * 3_600_000;
    const left = 100 - l.usedPct;
    const runsOutAt = perHour > 0.05 ? now + (left / perHour) * 3_600_000 : null;
    out[l.key] = { perHour: Math.round(perHour * 10) / 10, runsOutAt: runsOutAt && runsOutAt < l.resetsAt ? Math.round(runsOutAt) : null };
  }
  return out;
}
