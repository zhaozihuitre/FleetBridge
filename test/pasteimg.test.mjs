// Pasted images (server/pasteimg.js): kept as files in a folder of their own, only images, the old ones
// cleared as new ones come.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MONITOR_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'fb-paste-data-'));
const { imageKind, savePastedImage, prunePastes, MAX_BYTES } = await import('../server/pasteimg.js');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('imageKind: by the first bytes', () => {
  assert.equal(imageKind(PNG), 'png');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(imageKind(Buffer.from('GIF89a')), 'gif');
  assert.equal(imageKind(Buffer.from('hello world')), null);
  assert.equal(imageKind(null), null);
});

test('savePastedImage: a file with a dated name; not an image, empty or too large refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-paste-'));
  const f = savePastedImage(PNG, { dir, now: new Date('2026-11-23T04:15:00Z') });
  assert.equal(path.dirname(f), dir);
  assert.match(path.basename(f), /^paste-20261123-041500-[0-9a-f]{6}\.png$/);
  assert.deepEqual(fs.readFileSync(f), PNG);
  assert.throws(() => savePastedImage(Buffer.from('not an image'), { dir }), /not an image/);
  assert.throws(() => savePastedImage(Buffer.alloc(0), { dir }), /empty/);
  assert.throws(() => savePastedImage(Buffer.alloc(MAX_BYTES + 1), { dir }), /too large/);
});

test('prunePastes: older than a week or beyond the newest kept go; other files stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-paste-'));
  const now = Date.now();
  const mk = (name, ageDays) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, PNG);
    const t = new Date(now - ageDays * 86400000);
    fs.utimesSync(f, t, t);
    return f;
  };
  const old = mk('paste-old.png', 8);
  const fresh = mk('paste-new.png', 1);
  const other = mk('notes.txt', 30);
  assert.equal(prunePastes({ dir, now }), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true, 'only our pastes');
  for (let i = 0; i < 5; i++) mk(`paste-${i}.png`, i * 0.01);
  assert.equal(prunePastes({ dir, now, max: 3 }), 3, 'the oldest beyond the newest 3');
  assert.equal(prunePastes({ dir: path.join(dir, 'missing') }), 0);
});
