import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Claude Code's "do you trust this folder" dialog (server/agents.js trustPrompt), answered without a person:
// only when you turned it on, and only for an agent Fleet Bridge started in one of the folders you listed
// (or below one). Off, with no folders, until you say otherwise: trusting a folder lets Claude Code run what
// that folder's own settings tell it to (hooks, MCP servers), so it is yours to decide, folder by folder.
// Kept in <data>/trust.json: { auto, dirs }.

const SETTINGS_FILE = path.join(DATA_DIR, 'trust.json');
const MAX_DIRS = 50;
const WIN = process.platform === 'win32';

/** A folder as it is compared: absolute, no trailing separator, lower case on Windows. */
function norm(p) {
  const r = path.resolve(String(p)).replace(/[\\/]+$/, '');
  return WIN ? r.toLowerCase() : r;
}
/** A drive or filesystem root ("C:\", "/"): never listed, it would cover everything. */
const isRoot = (p) => {
  const r = path.resolve(p);
  return path.parse(r).root === r;
};

/**
 * The folders worth keeping from what was typed: one per line (or an array), absolute paths only, no drive
 * roots, no duplicates.
 * @param {string | string[]} input
 */
export function cleanDirs(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const p = String(l ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
    if (!p || !path.isAbsolute(p) || isRoot(p)) continue;
    const r = path.resolve(p);
    if (!out.some((x) => norm(x) === norm(r))) out.push(r);
    if (out.length >= MAX_DIRS) break;
  }
  return out;
}

/** Whether a folder is one of these, or below one (whole path segments: E:\work does not cover E:\work2). */
export function underDirs(cwd, dirs) {
  if (!cwd || !path.isAbsolute(String(cwd))) return false;
  const c = norm(cwd);
  return (dirs || []).some((d) => {
    if (!d || !path.isAbsolute(String(d)) || isRoot(d)) return false;
    const n = norm(d);
    return c === n || c.startsWith(n + path.sep);
  });
}

// where a folder really is: a link inside a listed folder that points outside it is not covered
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/** Whether the trust dialog of an agent started in this folder is answered "yes" without asking. */
export function autoTrusts(cwd, s = settings) {
  if (!s?.auto || !s.dirs?.length || !cwd) return false;
  return underDirs(real(cwd), s.dirs.map(real));
}

let settings = load();
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { auto: j.auto === true, dirs: cleanDirs(j.dirs || []) };
  } catch {
    return { auto: false, dirs: [] };
  }
}

export const trustSettings = () => ({ auto: settings.auto, dirs: [...settings.dirs] });

/**
 * @param {{ auto?: boolean, dirs?: string | string[], add?: string, remove?: string }} p
 *   dirs replaces the list; add puts one folder on it; remove takes one off
 */
export function setTrustSettings(p) {
  if (typeof p?.auto === 'boolean') settings.auto = p.auto;
  if (typeof p?.dirs === 'string' || Array.isArray(p?.dirs)) settings.dirs = cleanDirs(p.dirs);
  if (typeof p?.add === 'string') settings.dirs = cleanDirs([...settings.dirs, p.add]);
  if (typeof p?.remove === 'string' && path.isAbsolute(p.remove.trim())) settings.dirs = settings.dirs.filter((d) => norm(d) !== norm(p.remove.trim()));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {
    // kept for this run
  }
  return trustSettings();
}
