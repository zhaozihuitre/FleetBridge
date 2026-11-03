import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { config } from '../config.js';

// Today's totals over every transcript written today (ended sessions and subagents included):
// tokens by kind, cache hit rate and the number of prompts the commander sent.
// Files are read incrementally like transcript.js; everything resets at local midnight.

const CHUNK = 1 << 20;
let day = '';
const files = new Map(); // path -> { offset, rest, decoder, usage: Map(message id -> usage), prompts }

function midnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// A prompt is a main-thread user line with text, not a tool result, a command wrapper (<…>) or meta.
function isPrompt(d) {
  if (d.type !== 'user' || d.isSidechain || d.isMeta || !d.message) return false;
  const c = d.message.content;
  if (typeof c === 'string') return c.trim() !== '' && !c.startsWith('<');
  return Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') && c.some((b) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<'));
}

function apply(st, d, since) {
  if (!d.timestamp || Date.parse(d.timestamp) < since) return;
  const msg = d.message;
  // One reply is written as several lines (one per content block) repeating the same usage,
  // with the final output count on the last: keep the last line per message id.
  if (d.type === 'assistant' && msg?.usage && msg.model !== '<synthetic>') st.usage.set(msg.id || d.uuid, msg.usage);
  else if (isPrompt(d)) st.prompts++;
}

const tick = () => new Promise((r) => setImmediate(r));

// Async and one chunk per turn of the event loop: the first read of the day goes through every
// transcript written today (can be 100+ MB) and must not hold up terminal input meanwhile.
async function read(file, since) {
  let st = files.get(file);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (!st || size < st.offset) {
    st = { offset: 0, rest: '', decoder: new StringDecoder('utf8'), usage: new Map(), prompts: 0 };
    files.set(file, st);
  }
  if (size <= st.offset) return st;
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    while (st.offset < size) {
      const { bytesRead: n } = await fd.read(buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
      if (n <= 0) break;
      st.offset += n;
      const lines = (st.rest + st.decoder.write(buf.subarray(0, n))).split('\n');
      st.rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          apply(st, JSON.parse(line), since);
        } catch {
          // malformed line: skip it
        }
      }
      await tick();
    }
  } finally {
    await fd.close();
  }
  return st;
}

// <projects>/<dir>/<session>.jsonl and <projects>/<dir>/<session>/subagents/*.jsonl, modified today.
// Stats are async: there is one per transcript and session folder, and sync they stalled the server.
async function todaysFiles(root, since) {
  const fresh = (p) => fs.promises.stat(p).then((s) => s.mtimeMs >= since, () => false);
  let dirs = [];
  try {
    dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const found = await Promise.all(
    dirs.map(async (d) => {
      const dir = path.join(root, d.name);
      let entries = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const lists = await Promise.all(
        entries.map(async (e) => {
          const p = path.join(dir, e.name);
          if (e.isFile() && e.name.endsWith('.jsonl')) return (await fresh(p)) ? [p] : [];
          if (!e.isDirectory() || !(await fresh(p))) return [];
          const sub = path.join(p, 'subagents');
          try {
            const names = (await fs.promises.readdir(sub)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sub, f));
            const ok = await Promise.all(names.map(fresh));
            return names.filter((_, i) => ok[i]);
          } catch {
            return []; // no subagents
          }
        }),
      );
      return lists.flat();
    }),
  );
  return found.flat();
}

export async function collectToday() {
  const start = midnight();
  const key = start.toDateString();
  if (key !== day) {
    day = key;
    files.clear();
  }
  const since = start.getTime();
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 0, sessions: 0 };
  for (const f of await todaysFiles(path.join(config.claudeDir, 'projects'), since)) {
    const st = await read(f, since);
    if (!st) continue;
    if (st.usage.size || st.prompts) t.sessions++;
    t.prompts += st.prompts;
    for (const u of st.usage.values()) {
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
    }
  }
  const inTotal = t.input + t.cacheRead + t.cacheWrite;
  return { ...t, total: inTotal + t.output, cacheHitPct: inTotal ? (t.cacheRead / inTotal) * 100 : null };
}
