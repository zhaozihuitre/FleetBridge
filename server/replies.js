import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// The full answers of the turns the master gave out: one Markdown file per turn, in
// <data>/replies/<agent id>/<yyyymmdd-hhmmss>.md. The master's notice carries the start and end of a long
// answer and this file's path; fleet_read_reply returns it whole (the screen only shows its last rows).

export const REPLIES_DIR = path.join(DATA_DIR, 'replies');
const KEEP = 50; // per agent

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);

/**
 * Writes one turn's full answer; returns the file, or null when there is nothing to write or it failed.
 * @param {{ agentId: string, name?: string, order?: string, reply: string, at?: number, ms?: number, status?: string }} x
 */
export function saveReply(x, dir = REPLIES_DIR) {
  const id = safeId(x.agentId);
  if (!id || !String(x.reply || '').trim()) return null;
  const at = x.at || Date.now();
  try {
    const d = path.join(dir, id);
    fs.mkdirSync(d, { recursive: true });
    let file = path.join(d, `${stamp(at)}.md`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(d, `${stamp(at)}-${i}.md`);
    const head = [`# ${x.name || id}`, '', `- agent: ${x.agentId}`, `- time: ${new Date(at).toISOString()}`, x.status ? `- status: ${x.status}` : '', x.ms ? `- took: ${Math.round(x.ms / 1000)} s` : '', '', '## Order', '', String(x.order || '').trim(), '', '## Reply', '', ''].filter((l, i, a) => l !== '' || a[i - 1] !== '');
    fs.writeFileSync(file, head.join('\n') + '\n' + String(x.reply).trim() + '\n');
    prune(d);
    return file;
  } catch {
    return null;
  }
}

function prune(d) {
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(d, f), { force: true });
}

/** An agent's saved answers, newest first (file names only). */
export function listReplies(agentId, dir = REPLIES_DIR) {
  try {
    return fs.readdirSync(path.join(dir, safeId(agentId))).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * One saved answer: turn 0 is the latest, 1 the one before, … (or a file name from listReplies).
 * @returns {{ file: string, text: string, turn: number, count: number } | null}
 */
export function readReply(agentId, turn = 0, dir = REPLIES_DIR) {
  const files = listReplies(agentId, dir);
  const i = typeof turn === 'string' && !/^\d+$/.test(turn) ? files.indexOf(path.basename(turn)) : Number(turn) || 0;
  if (i < 0 || i >= files.length) return null;
  const file = path.join(dir, safeId(agentId), files[i]);
  try {
    return { file, text: fs.readFileSync(file, 'utf8'), turn: i, count: files.length };
  } catch {
    return null;
  }
}
