// Files dragged into Fleet Bridge (web/filedrop.js): their full paths quoted and joined, put where they are
// dropped, a hint instead of nothing in a browser or under a shell that can't give paths, and drags that
// carry no files (text, our pane drags) left alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { quotePath, joinPaths, collectPaths, insertText, hasFiles, dropSupport, dropTarget, dropIntoField, guardPage } = await import('../web/filedrop.js');

test('paths: quoted only with a space, several joined by spaces, folders too', () => {
  assert.equal(quotePath('C:\\work\\a.png'), 'C:\\work\\a.png');
  assert.equal(quotePath('C:\\My Docs\\report v2.docx'), '"C:\\My Docs\\report v2.docx"');
  assert.equal(joinPaths(['C:\\a.txt', 'D:\\New folder', 'E:\\src']), 'C:\\a.txt "D:\\New folder" E:\\src');
  assert.equal(joinPaths(['', 'C:\\a']), 'C:\\a');
});

test('collectPaths: what the shell gives, the rest counted (a getter that throws too)', () => {
  const files = [{ n: 'a' }, { n: 'web' }, { n: 'b' }, { n: 'bad' }];
  const get = (f) => {
    if (f.n === 'bad') throw new Error('x');
    return f.n === 'web' ? '' : `C:\\x\\${f.n}`;
  };
  assert.deepEqual(collectPaths(files, get), { paths: ['C:\\x\\a', 'C:\\x\\b'], missing: 2 });
  assert.deepEqual(collectPaths(files, null), { paths: [], missing: 4 });
});

test('insertText: at the cursor, spaced from the text around it', () => {
  assert.deepEqual(insertText('', 0, 0, 'C:\\a'), { value: 'C:\\a ', caret: 5 });
  assert.deepEqual(insertText('看一下', 3, 3, 'C:\\a'), { value: '看一下 C:\\a ', caret: 9 });
  assert.deepEqual(insertText('看 和', 2, 2, 'X'), { value: '看 X 和', caret: 4 });
  assert.deepEqual(insertText('ab', 1, 2, 'X'), { value: 'a X ', caret: 4 }, 'replaces the selection');
});

test('support: paths with the new preload, a hint for the old shell and for a browser', () => {
  assert.equal(dropSupport({ pathForFile: () => '' }), 'ok');
  assert.equal(dropSupport({ win() {} }), 'old-shell');
  assert.equal(dropSupport(undefined), 'browser');
  assert.equal(hasFiles({ types: ['Files'] }), true);
  assert.equal(hasFiles({ types: ['text/plain'] }), false);
  assert.equal(hasFiles(null), false);
});

// ---- the page side, on a few stand-ins for the DOM ----
function el(extra = {}) {
  const on = {};
  const cls = new Set();
  return {
    on,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    addEventListener: (n, f) => ((on[n] ||= []).push(f)),
    removeEventListener: (n, f) => (on[n] = (on[n] || []).filter((x) => x !== f)),
    fire(n, ev) {
      for (const f of on[n] || []) f(ev);
    },
    setAttribute() {},
    ...extra,
  };
}
function page(bridge) {
  const body = el({ appendChild: (c) => (hint = c) });
  let hint = null;
  const head = el({ appendChild() {} });
  globalThis.document = {
    head,
    body,
    getElementById: () => null,
    querySelector: () => hint,
    createElement: () => el({ textContent: '', className: '' }),
  };
  globalThis.window = el({ opsBridge: bridge });
  return { hint: () => hint?.textContent || '' };
}
const ev = (types, files = []) => {
  const e = { dataTransfer: { types, files, dropEffect: '' }, prevented: false, stopped: false };
  e.preventDefault = () => (e.prevented = true);
  e.stopPropagation = () => (e.stopped = true);
  return e;
};

test('a terminal: highlighted while files are over it, the paths handed over, text drags untouched', () => {
  page({ pathForFile: (f) => f.path });
  const box = el();
  const got = [];
  const undo = dropTarget(box, (t) => got.push(t));
  const text = ev(['text/plain']);
  box.fire('dragover', text);
  box.fire('drop', text);
  assert.equal(text.prevented, false, 'a text drag (selection, our pane drags) goes on as before');
  assert.deepEqual(got, []);
  box.fire('dragenter', ev(['Files']));
  assert.equal(box.classList.contains('fd-hot'), true);
  const d = ev(['Files'], [{ path: 'C:\\a b\\c.png' }, { path: 'D:\\dir' }]);
  box.fire('drop', d);
  assert.equal(d.prevented, true);
  assert.equal(box.classList.contains('fd-hot'), false);
  assert.deepEqual(got, ['"C:\\a b\\c.png" D:\\dir']);
  undo();
  box.fire('drop', ev(['Files'], [{ path: 'C:\\x' }]));
  assert.equal(got.length, 1, 'undone');
});

test('a browser or an old shell: nothing inserted, a hint says why', () => {
  let p = page(undefined);
  const got = [];
  const box = el();
  dropTarget(box, (t) => got.push(t));
  box.fire('drop', ev(['Files'], [{ path: 'C:\\a' }]));
  assert.deepEqual(got, []);
  assert.match(p.hint(), /浏览器/);
  p = page({ win() {} });
  const box2 = el();
  dropTarget(box2, (t) => got.push(t));
  box2.fire('drop', ev(['Files'], [{ path: 'C:\\a' }]));
  assert.deepEqual(got, []);
  assert.match(p.hint(), /0\.9\.79/);
});

test('an order box: paths at its cursor, an input event for the page; the page guard takes stray drops', () => {
  const p = page({ pathForFile: (f) => f.path });
  const events = [];
  const field = el({ value: '看一下', selectionStart: 3, selectionEnd: 3, focus() {}, setSelectionRange(a) { this.caret = a; }, dispatchEvent: (e) => events.push(e.type) });
  dropIntoField(field);
  field.fire('drop', ev(['Files'], [{ path: 'C:\\r.pdf' }]));
  assert.equal(field.value, '看一下 C:\\r.pdf ');
  assert.equal(field.caret, field.value.length);
  assert.deepEqual(events, ['input']);
  guardPage();
  const stray = ev(['Files'], [{ path: 'C:\\r.pdf' }]);
  window.fire('drop', stray);
  assert.equal(stray.prevented, true, 'the window does not open the file in place of the page');
  assert.match(p.hint(), /拖到终端/);
});

// ---- pasting (Ctrl+V): files copied in Explorer, a screenshot, text ----
const { pasteKind, isCtrlV, pasteTarget } = await import('../web/filedrop.js');
const clip = ({ text = '', files = [] } = {}) => ({ files, getData: (t) => (t === 'text/plain' ? text : '') });
const pev = (cd) => {
  const e = { clipboardData: cd, prevented: false, stopped: false };
  e.preventDefault = () => (e.prevented = true);
  e.stopPropagation = () => (e.stopped = true);
  return e;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

test('pasteKind: files give their paths, text stays text (even beside an image), a screenshot is an image', () => {
  const get = (f) => f.path || '';
  assert.deepEqual(pasteKind(clip({ files: [{ path: 'C:\\a b\\c.txt' }, { path: 'D:\\dir' }] }), get), { kind: 'paths', text: '"C:\\a b\\c.txt" D:\\dir', missing: 0 });
  assert.deepEqual(pasteKind(clip({ text: 'hello' }), get), { kind: 'text' });
  assert.deepEqual(pasteKind(clip({ text: 'A1\tB1', files: [{ type: 'image/png' }] }), get), { kind: 'text' }, 'a spreadsheet copy: its text');
  const shot = { type: 'image/png', name: 'image.png' };
  assert.deepEqual(pasteKind(clip({ files: [shot] }), get), { kind: 'image', file: shot });
  assert.deepEqual(pasteKind(clip({ files: [{ type: 'text/plain' }] }), null), { kind: 'nopath', count: 1 }, 'a browser: no paths');
  assert.deepEqual(pasteKind(clip(), get), { kind: 'none' });
  assert.deepEqual(pasteKind(null, get), { kind: 'none' });
});

test("isCtrlV: Ctrl+V alone; not Ctrl+Shift+V, Alt+V (Claude Code's image paste), AltGr or Ctrl+C", () => {
  assert.equal(isCtrlV({ ctrlKey: true, code: 'KeyV', key: 'v' }), true);
  assert.equal(isCtrlV({ ctrlKey: true, code: 'KeyV', key: 'Process' }), true, 'with the IME on');
  assert.equal(isCtrlV({ ctrlKey: true, shiftKey: true, code: 'KeyV', key: 'V' }), false);
  assert.equal(isCtrlV({ altKey: true, code: 'KeyV', key: 'v' }), false);
  assert.equal(isCtrlV({ ctrlKey: true, altKey: true, code: 'KeyV', key: 'v' }), false);
  assert.equal(isCtrlV({ ctrlKey: true, code: 'KeyC', key: 'c' }), false);
});

test('pasteTarget: paths put in, text and empty pastes left alone, a screenshot saved and its path put in', async () => {
  const p = page({ pathForFile: (f) => f.path || '' });
  const box = el();
  const got = [];
  const plain = [];
  let starts = 0;
  const undo = pasteTarget(box, { insert: (t) => got.push(t), plain: (e, k) => plain.push(k), start: () => starts++ });
  const t = pev(clip({ text: 'hello' }));
  box.fire('paste', t);
  assert.equal(t.prevented, false, 'text pastes as before');
  const f = pev(clip({ files: [{ path: 'C:\\My Docs\\a.pdf' }] }));
  box.fire('paste', f);
  assert.equal(f.prevented, true);
  assert.deepEqual(got, ['"C:\\My Docs\\a.pdf"']);
  box.fire('paste', pev(clip()));
  assert.deepEqual(plain, ['text', 'none']);
  const sent = [];
  globalThis.fetch = async (url, o) => (sent.push([url, o.method, o.body.name]), { ok: true, json: async () => ({ ok: true, path: 'C:\\Users\\me\\.claude-ops\\pastes\\paste-1.png' }) });
  const s = pev(clip({ files: [{ type: 'image/png', name: 'image.png' }] }));
  box.fire('paste', s);
  assert.equal(s.prevented, true);
  await tick();
  assert.deepEqual(sent, [['/api/paste-image', 'POST', 'image.png']]);
  assert.equal(got[1], 'C:\\Users\\me\\.claude-ops\\pastes\\paste-1.png');
  globalThis.fetch = async () => ({ ok: false, status: 413, json: async () => ({ error: 'too large' }) });
  box.fire('paste', pev(clip({ files: [{ type: 'image/png' }] })));
  await tick();
  assert.match(p.hint(), /too large/);
  assert.equal(starts, 5);
  undo();
  box.fire('paste', pev(clip({ files: [{ path: 'C:\\x' }] })));
  assert.equal(got.length, 2, 'undone');
});

test('pasted files in a browser or under an old shell: nothing put in, a hint says why', () => {
  let p = page(undefined);
  const got = [];
  const box = el();
  pasteTarget(box, { insert: (t) => got.push(t) });
  box.fire('paste', pev(clip({ files: [{ type: 'application/pdf' }] })));
  assert.match(p.hint(), /浏览器.*粘贴/);
  p = page({ win() {} });
  const box2 = el();
  pasteTarget(box2, { insert: (t) => got.push(t) });
  box2.fire('paste', pev(clip({ files: [{ type: 'application/pdf' }] })));
  assert.match(p.hint(), /粘贴文件的路径.*0\.9\.79/);
  assert.deepEqual(got, []);
});

test("an order box: a pasted file's path at its cursor, text pasted as before", () => {
  page({ pathForFile: (f) => f.path });
  const field = el({ value: '看一下', selectionStart: 3, selectionEnd: 3, focus() {}, setSelectionRange() {}, dispatchEvent() {} });
  dropIntoField(field);
  field.fire('paste', pev(clip({ files: [{ path: 'C:\\r.pdf' }] })));
  assert.equal(field.value, '看一下 C:\\r.pdf ');
  const t = pev(clip({ text: 'x' }));
  field.fire('paste', t);
  assert.equal(t.prevented, false);
});
