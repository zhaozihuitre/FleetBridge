import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { improveSettings } from './settings.js';

// Fleet Bridge's own events, for the self-improvement analysis: one JSON line each in <data>/events.jsonl
// ({ at, type, ...fields }). Only what happened (kinds, counts, durations, an agent's name, an order's first
// words), never a whole answer. Nothing is written while the feature is off. Kept under ~4 MB: past that, the
// older half goes.

export const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_BYTES = 4 * 1024 * 1024;
const head = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function logEvent(type, fields = {}, { file = EVENTS_FILE, force = false, now = Date.now() } = {}) {
  if (!force && !improveSettings().enabled) return;
  const e = { at: now, type };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    e[k] = typeof v === 'string' ? head(v, k === 'text' ? 160 : 240) : v;
  }
  try {
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
    if (fs.statSync(file).size > MAX_BYTES) trim(file);
  } catch {
    // a lost event only makes the statistics a little thinner
  }
}

function trim(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
}

/** The events since `since` (ms), oldest first. */
export function readEvents(since = 0, file = EVENTS_FILE) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (e.at >= since) out.push(e);
    } catch {
      // a cut line
    }
  }
  return out;
}

export function clearEvents(file = EVENTS_FILE) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing to clear
  }
}
