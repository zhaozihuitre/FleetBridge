// Files dragged in (documents, pictures, folders) give their full local paths where they are dropped: a
// terminal pane (the master's too) gets them on its input line as a paste, never with Enter; an order box
// gets them at its cursor. Nothing is uploaded or copied: Claude Code in the terminal reads the files itself.
//
// The path comes from the desktop shell's preload (webUtils.getPathForFile: Electron took File.path away).
// A browser has no such thing, and a shell from before 0.9.79 doesn't give it: then a hint says so, the drop
// is never silently lost. Only drags carrying files are taken: selecting, pasting, scrolling and dragging
// panes around go on as before.
//
// No imports: the pure parts are tested under node (test/filedrop.test.mjs).

/** A path as typed: in double quotes when it has a space (Windows paths can't hold a quote). */
export function quotePath(p) {
  const s = String(p || '');
  return /\s/.test(s) ? `"${s}"` : s;
}

/** Several paths: quoted as needed, separated by spaces. */
export function joinPaths(paths) {
  return paths.filter(Boolean).map(quotePath).join(' ');
}

/** The dropped files' paths, by the shell's getPath; those it can't give (not a local file) counted. */
export function collectPaths(files, getPath) {
  const paths = [];
  let missing = 0;
  for (const f of Array.from(files || [])) {
    let p = '';
    try {
      p = getPath ? String(getPath(f) || '') : '';
    } catch {
      p = '';
    }
    if (p) paths.push(p);
    else missing++;
  }
  return { paths, missing };
}

/** Inserts text into a value at a selection, a space on either side where it would touch other text. */
export function insertText(value, start, end, text) {
  const v = String(value ?? '');
  const a = Math.max(0, Math.min(start ?? v.length, v.length));
  const b = Math.max(a, Math.min(end ?? a, v.length));
  const before = v.slice(0, a);
  const after = v.slice(b);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = !after || !/^\s/.test(after) ? ' ' : '';
  const ins = lead + text + trail;
  return { value: before + ins + after, caret: a + ins.length };
}

/** Whether a drag carries files (not text, not one of our own pane drags). */
export function hasFiles(dt) {
  return Boolean(dt && Array.from(dt.types || []).includes('Files'));
}

/**
 * What this page can do with a drop: 'ok' (the shell gives paths), 'old-shell' (the desktop app, but a
 * shell without it: the installer brings it), 'browser' (no local paths at all).
 */
export function dropSupport(bridge) {
  if (bridge && typeof bridge.pathForFile === 'function') return 'ok';
  return bridge ? 'old-shell' : 'browser';
}

// ---- the page side ----

const T = { L: (s, ...a) => (a.length ? s.replace(/\{(\d+)\}/g, (_, i) => String(a[i] ?? '')) : s) };
const HOT = 'fd-hot';

function style() {
  if (document.getElementById('fd-style')) return;
  const s = document.createElement('style');
  s.id = 'fd-style';
  s.textContent = `.${HOT}{outline:2px dashed var(--accent, #39d0ff) !important;outline-offset:-3px;box-shadow:inset 0 0 0 9999px rgba(57,208,255,.08) !important}
.fd-hint{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:min(640px,calc(100vw - 32px));padding:9px 14px;border-radius:8px;background:rgba(8,14,24,.94);color:#e6f2ff;border:1px solid rgba(57,208,255,.45);font:13px/1.5 system-ui,'Microsoft YaHei UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;opacity:0;transition:opacity .18s}
.fd-hint.show{opacity:1}`;
  document.head.appendChild(s);
}

/** A short hint at the bottom of the page (each page with drops has it, pop-out windows too). */
export function dropHint(text) {
  style();
  let h = document.querySelector('.fd-hint');
  if (!h) {
    h = document.createElement('div');
    h.className = 'fd-hint';
    h.setAttribute('role', 'status');
    document.body.appendChild(h);
  }
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(dropHint.timer);
  dropHint.timer = setTimeout(() => h.classList.remove('show'), 4200);
}

/** Sets the translator (i18n's L) the hints are written with. */
export function setDropText(L) {
  if (typeof L === 'function') T.L = L;
}

/** The dropped files' text, or null after telling why there is none. */
function pathsOf(dt) {
  const bridge = window.opsBridge;
  const kind = dropSupport(bridge);
  if (kind === 'browser') {
    dropHint(T.L('浏览器里拿不到文件的本地路径：请在舰桥桌面窗口里拖入，或手动输入路径'));
    return null;
  }
  if (kind === 'old-shell') {
    dropHint(T.L('这个舰桥外壳还不能取拖入文件的路径，装上 0.9.79 或更新的安装包后可用'));
    return null;
  }
  const { paths, missing } = collectPaths(dt.files, (f) => bridge.pathForFile(f));
  if (!paths.length) {
    dropHint(T.L('拖入的不是本地文件，取不到路径'));
    return null;
  }
  if (missing) dropHint(T.L('{0} 个不是本地文件，已跳过', missing));
  return joinPaths(paths);
}

/**
 * Makes an element take file drops. insert(text) puts the paths in. Highlighted while files are over it.
 * @returns {() => void} undo
 */
export function dropTarget(el, insert) {
  if (!el) return () => {};
  style();
  let depth = 0;
  const off = () => {
    depth = 0;
    el.classList.remove(HOT);
  };
  const enter = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depth++;
    el.classList.add(HOT);
  };
  const over = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add(HOT);
  };
  const leave = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    if (--depth <= 0) off();
  };
  const drop = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    off();
    const text = pathsOf(e.dataTransfer);
    if (text) insert(text);
  };
  el.addEventListener('dragenter', enter, true);
  el.addEventListener('dragover', over, true);
  el.addEventListener('dragleave', leave, true);
  el.addEventListener('drop', drop, true);
  return () => {
    for (const [n, f] of [['dragenter', enter], ['dragover', over], ['dragleave', leave], ['drop', drop]]) el.removeEventListener(n, f, true);
    off();
  };
}

/** An order box (textarea / input) taking drops: the paths at its cursor, focused after. */
export function dropIntoField(field) {
  return dropTarget(field, (text) => {
    const r = insertText(field.value, field.selectionStart, field.selectionEnd, text);
    field.value = r.value;
    field.focus();
    try {
      field.setSelectionRange(r.caret, r.caret);
    } catch {
      // some inputs have no selection
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * The page's guard: a file dropped anywhere else would make the window open it in place of the page
 * (Electron navigates to it). Taken here, with a hint where to drop instead.
 */
export function guardPage() {
  if (guardPage.done) return;
  guardPage.done = true;
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dropHint(T.L('把文件拖到终端或指令输入框里，会插入它的完整路径'));
  });
}
