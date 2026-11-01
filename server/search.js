import { Worker } from 'node:worker_threads';

// Full-text search over session transcripts: what you asked and what Claude answered (not tool
// output). Reading ~500 MB takes a couple of seconds, so it runs in a worker thread and the server
// keeps publishing meanwhile.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { files, query, maxSessions, maxSnippets } = workerData;
const q = query.toLowerCase();

function textOf(d) {
  if (d.isSidechain || d.isMeta || !d.message) return null;
  const c = d.message.content;
  if (d.type === 'user') {
    if (typeof c === 'string') return c.startsWith('<') ? null : c;
    if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return null;
    return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\\n') || null;
  }
  if (d.type === 'assistant' && Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\\n') || null;
  return null;
}

function snippet(text, at) {
  const from = Math.max(0, at - 50);
  const to = Math.min(text.length, at + q.length + 70);
  return (from ? '…' : '') + text.slice(from, to).replace(/\\s+/g, ' ') + (to < text.length ? '…' : '');
}

const out = [];
for (const f of files) {
  if (out.length >= maxSessions) break;
  let raw;
  try {
    raw = fs.readFileSync(f.file, 'utf8');
  } catch {
    continue;
  }
  const low = raw.toLowerCase();
  let at = low.indexOf(q);
  if (at < 0) continue;
  const snippets = [];
  let hits = 0;
  const seen = new Set();
  while (at >= 0) {
    const start = raw.lastIndexOf('\\n', at) + 1;
    let end = raw.indexOf('\\n', at);
    if (end < 0) end = raw.length;
    if (!seen.has(start)) {
      seen.add(start);
      try {
        const d = JSON.parse(raw.slice(start, end));
        const text = textOf(d);
        const i = text ? text.toLowerCase().indexOf(q) : -1;
        if (i >= 0) {
          hits++;
          if (snippets.length < maxSnippets) snippets.push({ role: d.type, at: Date.parse(d.timestamp) || null, text: snippet(text, i) });
        }
      } catch {}
    }
    at = low.indexOf(q, end);
  }
  if (hits) out.push({ sessionId: f.sessionId, hits, snippets });
}
parentPort.postMessage(out);
`;

/** files: [{ file, sessionId }] newest first. Resolves to [{ sessionId, hits, snippets }]. */
export function searchSessions(files, query, { maxSessions = 40, maxSnippets = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { files, query, maxSessions, maxSnippets } });
    w.once('message', resolve);
    w.once('error', reject);
  });
}
