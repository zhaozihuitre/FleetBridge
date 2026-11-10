import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Spoken notices (web/voice.js speaks them: the widget on the computer, the phone page when that phone turned it
// on): the settings, kept in <data>/voice.json, and which terminal you are looking at right now (a page in front
// with that terminal focused says so), which is not read out.
const FILE = path.join(DATA_DIR, 'voice.json');
const KINDS = ['permit', 'question', 'done', 'error', 'warn', 'sys'];
const DEFAULTS = {
  on: true,
  kinds: { permit: true, question: true, done: true, error: true, warn: false, sys: false }, // sys: memory short / CPU busy
  volume: 0.8, // 0..1
  rate: 1, // 0.6..1.6
  voice: '', // a voice's name ('' = the system's voice for the language)
  chime: true, // a short tone first
  quiet: { on: false, from: '22:00', to: '08:00' }, // no speech in these hours
};
let settings = load();

function load() {
  try {
    return clean({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) });
  } catch {
    return structuredClone(DEFAULTS);
  }
}

const hhmm = (v, d) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
function clean(s) {
  const kinds = {};
  for (const k of KINDS) kinds[k] = typeof s.kinds?.[k] === 'boolean' ? s.kinds[k] : DEFAULTS.kinds[k];
  return {
    on: typeof s.on === 'boolean' ? s.on : DEFAULTS.on,
    kinds,
    volume: num(s.volume, 0, 1, DEFAULTS.volume),
    rate: num(s.rate, 0.6, 1.6, DEFAULTS.rate),
    voice: typeof s.voice === 'string' ? s.voice.slice(0, 120) : '',
    chime: typeof s.chime === 'boolean' ? s.chime : DEFAULTS.chime,
    quiet: { on: typeof s.quiet?.on === 'boolean' ? s.quiet.on : false, from: hhmm(s.quiet?.from, DEFAULTS.quiet.from), to: hhmm(s.quiet?.to, DEFAULTS.quiet.to) },
  };
}

export const voiceSettings = () => structuredClone(settings);

/** A partial change (any of the fields; kinds / quiet merge). */
export function setVoiceSettings(p = {}) {
  settings = clean({ ...settings, ...p, kinds: { ...settings.kinds, ...(p.kinds || {}) }, quiet: { ...settings.quiet, ...(p.quiet || {}) } });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  } catch {
    // kept for this run
  }
  return voiceSettings();
}

// the terminal in front of you: { agentId, at } from the page that last said so (null: none)
let viewing = null;
export function setViewing(agentId) {
  viewing = typeof agentId === 'string' && agentId ? { agentId, at: Date.now() } : null;
}
export const viewingNow = () => viewing;
