// Images pasted into Fleet Bridge (a screenshot from Win+Shift+S, an image copied from a page) have no file:
// the page sends the image here, it is kept as a PNG under <data>/pastes and its full path goes where it was
// pasted, for Claude Code to read like any dropped file. Pastes older than a week go, and never more than
// the 200 newest are kept, each time one is saved.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

export const PASTE_DIR = path.join(DATA_DIR, 'pastes');
export const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_DAYS = 7;
const KEEP_FILES = 200;

// what the clipboard gives as an image: Chromium hands it over as PNG; the others for an image file's bytes
const KINDS = [
  ['png', (b) => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG'],
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['gif', (b) => b.toString('latin1', 0, 4) === 'GIF8'],
  ['webp', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['bmp', (b) => b.toString('latin1', 0, 2) === 'BM'],
];

/** The image's file extension from its first bytes, or null for something that isn't one. */
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  return KINDS.find(([, is]) => is(buf))?.[0] || null;
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261123-131500

/** Keeps a pasted image; returns its full path. Throws for an empty, oversized or non-image body. */
export function savePastedImage(buf, { dir = PASTE_DIR, now = new Date() } = {}) {
  if (!buf?.length) throw new Error('empty');
  if (buf.length > MAX_BYTES) throw new Error('too large');
  const ext = imageKind(buf);
  if (!ext) throw new Error('not an image');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paste-${stamp(now)}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  prunePastes({ dir, now: now.getTime(), keep: file });
  return file;
}

/** Removes pastes older than a week, then the oldest beyond the 200 newest. Returns how many went. */
export function prunePastes({ dir = PASTE_DIR, now = Date.now(), days = KEEP_DAYS, max = KEEP_FILES, keep = '' } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^paste-.*\.(png|jpg|gif|webp|bmp)$/i.test(n));
  } catch {
    return 0;
  }
  const files = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      files.push({ f, t: fs.statSync(f).mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  files.sort((a, b) => b.t - a.t);
  let gone = 0;
  files.forEach(({ f, t }, i) => {
    if (f === keep) return;
    if (now - t > days * 86400000 || i >= max) {
      try {
        fs.unlinkSync(f);
        gone++;
      } catch {
        // in use: next time
      }
    }
  });
  return gone;
}

/** The request's raw body, up to max bytes (null past that). */
export function readRaw(req, max = MAX_BYTES) {
  return new Promise((resolve) => {
    const parts = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) over = true;
      else parts.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts)));
    req.on('error', () => resolve(null));
  });
}
