import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { LIMIT_RE } from '../accounts.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CHUNK = 1 << 20;

// Per-file parse state, so each poll only reads the bytes appended since the last one.
const cache = new Map();

function blank() {
  return {
    offset: 0,
    rest: '',
    decoder: new StringDecoder('utf8'), // keeps multi-byte chars split across chunks intact
    model: null,
    contextTokens: null,
    lastActivity: null,
    limit: null, // { text, at }: the last turn stopped on the quota
    lastEntryAt: null, // any main-thread line, including tool results
    lastText: null,
    lastPrompt: null,
    title: null,
    edits: new Map(), // normalized absolute path -> ISO timestamp of the last edit
  };
}

function firstLine(s, max = 140) {
  const line = s.trim().split('\n').find((l) => l.trim()) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function apply(st, d) {
  if (d.type === 'ai-title' && d.aiTitle) st.title = d.aiTitle;
  if (d.timestamp && !d.isSidechain) st.lastEntryAt = Date.parse(d.timestamp);
  if (d.isSidechain) return;
  const msg = d.message;
  if (d.type === 'assistant' && msg) {
    // Synthetic messages (interrupts, errors) carry all-zero usage and must not reset the context reading.
    if (msg.model === '<synthetic>') {
      // the quota ran out ("You've hit your 5-hour limit"…): kept until it works again
      const text = (msg.content || []).find((b) => b?.type === 'text')?.text?.trim() || '';
      if (d.isApiErrorMessage && (d.error === 'rate_limit' || LIMIT_RE.test(text))) st.limit = { text: firstLine(text), at: Date.parse(d.timestamp) || 0 };
      return;
    }
    st.limit = null;
    const u = msg.usage;
    if (u) {
      st.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      st.model = msg.model;
    }
    st.lastActivity = d.timestamp;
    for (const b of msg.content || []) {
      if (b?.type === 'text' && b.text?.trim()) st.lastText = firstLine(b.text);
      if (b?.type === 'tool_use' && EDIT_TOOLS.has(b.name)) {
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p) st.edits.set(p.replace(/\\/g, '/').toLowerCase(), d.timestamp);
      }
    }
  } else if (d.type === 'user' && msg && typeof msg.content === 'string' && !d.isMeta) {
    if (!msg.content.startsWith('<')) st.lastPrompt = firstLine(msg.content);
    st.limit = null;
    st.lastActivity = d.timestamp;
  }
}

export function readTranscript(file) {
  let st = cache.get(file);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (!st || size < st.offset) {
    st = blank();
    cache.set(file, st);
  }
  if (size > st.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      while (st.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
        if (n <= 0) break;
        st.offset += n;
        const lines = (st.rest + st.decoder.write(buf.subarray(0, n))).split('\n');
        st.rest = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try {
            apply(st, JSON.parse(line));
          } catch {
            // malformed line: skip it rather than stall the whole transcript
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return st;
}
