import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A development run (the unpackaged app sets FLEET_DEV, the demo sets MONITOR_DEMO) never touches the
// installed app's world: its own data folder and port unless given explicitly, its agents named
// "dev·…" so the installed app leaves their sessions out, and no toasts or phone pushes of its own.
export const DEV = process.env.FLEET_DEV === '1' || Boolean(process.env.MONITOR_DEMO);
export const DEV_PREFIX = 'dev·';

// Writable state lives outside the app folder (an installed app's files are read-only).
// server/hook.js writes here too (it follows MONITOR_DATA_DIR, which our agents inherit).
const PROD_DIR = path.join(os.homedir(), '.claude-ops');
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// A dev run never uses the installed app's folder, even when told to (an agent of the installed app
// passes its MONITOR_DATA_DIR on to whatever it starts, a dev run included).
export const DATA_DIR = (() => {
  const given = process.env.MONITOR_DATA_DIR;
  if (DEV && given && sameDir(given, PROD_DIR)) {
    console.warn(`dev run: not using the installed app's data folder ${given}; using ~/.claude-ops-dev`);
    return path.join(os.homedir(), '.claude-ops-dev');
  }
  return given || (DEV ? path.join(os.homedir(), '.claude-ops-dev') : PROD_DIR);
})();

const defaults = {
  port: Number(process.env.MONITOR_PORT) || (DEV ? 8790 : 8787),
  claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  // usage is a shared, rate-limited endpoint (the status line may poll it too): keep it slow
  intervals: { usage: 180_000, sessions: 3_000, git: 30_000 },
  // Transcripts don't record the window size, so it is looked up by model id (first match wins).
  contextWindows: [
    { match: 'opus-5', tokens: 1_000_000 },
    { match: '[1m]', tokens: 1_000_000 },
    { match: '', tokens: 200_000 },
  ],
  thresholds: {
    contextWarnPct: 85,
    energyLowPct: 10,
    staleDirtyDays: 3,
    standbyMinutes: 30,
  },
  git: { scanDepth: 2, autoFetch: false },
  operator: { name: 'NOVA' },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function load() {
  const file = [path.join(DATA_DIR, 'config.json'), path.join(ROOT, 'config.json')].find((f) => fs.existsSync(f));
  if (!file) return defaults;
  return merge(defaults, JSON.parse(fs.readFileSync(file, 'utf8')));
}

export const config = load();

export function contextWindowFor(model, tokens) {
  const rule = config.contextWindows.find((r) => (model || '').includes(r.match));
  const size = rule ? rule.tokens : 200_000;
  // A transcript can't exceed its window, so a larger count means the guess was wrong.
  return tokens > size ? 1_000_000 : size;
}
