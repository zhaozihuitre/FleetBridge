import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;
const LIMIT = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cache = new Map(); // file -> { mtimeMs, entry }

function readSlice(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, n);
}

function jsonLines(text) {
  return text.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return []; // the slice edges cut lines in half
    }
  });
}

// cwd sits near the top of a transcript; the latest title and prompt are re-written near the end.
function summarize(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = jsonLines(readSlice(fd, 0, Math.min(HEAD, size)));
    const tail = size > HEAD ? jsonLines(readSlice(fd, Math.max(0, size - TAIL), Math.min(TAIL, size))) : head;
    const all = [...head, ...tail];
    const last = (type, key) => [...tail].reverse().find((d) => d.type === type && d[key])?.[key] ?? [...head].reverse().find((d) => d.type === type && d[key])?.[key] ?? null;
    return {
      cwd: all.find((d) => d.cwd)?.cwd || null,
      title: last('custom-title', 'customTitle') || last('ai-title', 'aiTitle'),
      lastPrompt: last('last-prompt', 'lastPrompt'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Recent sessions across all projects (running ones included), newest first.
/** sessionId -> transcript path of the sessions in the last history, for the full-text search */
export const historyFiles = new Map();

export function collectHistory() {
  const root = path.join(config.claudeDir, 'projects');
  const files = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = path.join(root, dir.name);
    for (const f of fs.readdirSync(p)) {
      const id = f.replace(/\.jsonl$/, '');
      if (!f.endsWith('.jsonl') || !UUID.test(id)) continue;
      const file = path.join(p, f);
      const st = fs.statSync(file);
      files.push({ file, id, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out = [];
  for (const f of files) {
    if (out.length >= LIMIT) break;
    let c = cache.get(f.file);
    if (!c || c.mtimeMs !== f.mtimeMs) {
      try {
        c = { mtimeMs: f.mtimeMs, entry: summarize(f.file, f.size) };
      } catch {
        continue;
      }
      cache.set(f.file, c);
    }
    const { cwd, title, lastPrompt } = c.entry;
    // scratch/temp sessions whose folder is gone can't be resumed
    if (!cwd || !fs.existsSync(cwd) || !(title || lastPrompt)) continue;
    out.push({ sessionId: f.id, cwd, project: path.basename(cwd) || cwd, title, lastPrompt, updatedAt: f.mtimeMs, size: f.size });
    historyFiles.set(f.id, f.file);
  }
  return out;
}
