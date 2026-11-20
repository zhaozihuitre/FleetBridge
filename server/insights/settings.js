import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// Self-improvement (docs/self-improve-design.md): its switches, in <data>/self-improve.json.
//   enabled  the whole feature: the event log, the analyses, the proposals (off: nothing logged or analyzed;
//            the proposals already made stay)
//   llm      the model's step (claude -p on the user's plan): the redacted digest goes to the Anthropic API.
//            Off: only the rules' proposals, made here
//   model    the model of that step; hour/minute: the daily analysis; minTurns: or after this many of the
//            master's turns; days: how far back the data goes; push: new proposals to the phone (ntfy)
//   repo     the FleetBridge checkout the proposals are built in ('' = found by itself)

const FILE = path.join(DATA_DIR, 'self-improve.json');
export const DEFAULTS = Object.freeze({ enabled: true, llm: true, model: 'claude-sonnet-5-5', hour: 12, minute: 30, minTurns: 30, days: 14, push: false, repo: '' });
let settings = load();

function load() {
  try {
    return clean({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) });
  } catch {
    return { ...DEFAULTS };
  }
}

function clean(s) {
  const out = { ...DEFAULTS };
  for (const k of ['enabled', 'llm', 'push']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (typeof s.model === 'string' && /^claude-[a-z0-9.-]+$/.test(s.model)) out.model = s.model;
  const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  out.hour = int(s.hour, 0, 23, DEFAULTS.hour);
  out.minute = int(s.minute, 0, 59, DEFAULTS.minute);
  out.minTurns = int(s.minTurns, 5, 1000, DEFAULTS.minTurns);
  out.days = int(s.days, 1, 90, DEFAULTS.days);
  if (typeof s.repo === 'string') out.repo = s.repo.trim();
  return out;
}

export const improveSettings = () => ({ ...settings });

export function setImproveSettings(patch) {
  settings = clean({ ...settings, ...(patch || {}) });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  } catch {
    // kept for this run
  }
  return improveSettings();
}
