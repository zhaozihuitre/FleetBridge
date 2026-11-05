// Previews: local HTML / Markdown files and localhost pages opened in the command center (a pane in
// the split view, or its own window) instead of the system browser. Agents ask with `fleet-open`
// (a small command put on their PATH, also their BROWSER) or the master with fleet_open.
//
// Files are served by a separate little server on its own port: a previewed page is another origin
// than the command center, so it can neither reach into the page around it nor call our API (which
// only answers its own origin). Markdown is rendered to HTML; a file page reloads itself when
// anything in its folder changes. External (non-local) http(s) links go to the system browser.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';

export const PREVIEW_PORT = config.port + 10;
const TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/html; charset=utf-8', '.markdown': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm' };
const PAGE_EXT = new Set(['.html', '.htm', '.md', '.markdown', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt']);
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

const previews = new Map(); // id -> { id, kind: 'file' | 'url', target, dir, file, title, at, version }

/** What a target is: a local page file, a localhost URL, or an outside URL (system browser). */
export function classify(target, cwd) {
  const t = String(target || '').trim();
  if (!t) throw new Error('nothing to open');
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    return LOCAL_HOSTS.test(u.hostname) ? { kind: 'url', url: u.href } : { kind: 'external', url: u.href };
  }
  if (/^file:\/\//i.test(t)) return classify(decodeURIComponent(new URL(t).pathname).replace(/^\/([a-z]:)/i, '$1'), cwd);
  const file = path.resolve(cwd || process.cwd(), t);
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const st = fs.statSync(file);
  if (st.isDirectory()) {
    const index = ['index.html', 'index.htm', 'README.md', 'readme.md'].map((n) => path.join(file, n)).find((f) => fs.existsSync(f));
    if (!index) throw new Error(`a folder without index.html or README.md: ${file}`);
    return { kind: 'file', file: index };
  }
  const ext = path.extname(file).toLowerCase();
  if (!PAGE_EXT.has(ext)) throw new Error(`not a page to preview (${ext || 'no extension'}): ${file}`);
  return { kind: 'file', file };
}

/** Registers a preview; returns it (with the URL its pane shows) or { external } for the system browser. */
export function openPreview(target, cwd) {
  const c = classify(target, cwd);
  if (c.kind === 'external') {
    openExternal(c.url);
    return { external: true, url: c.url };
  }
  // the same file or URL again: the same preview (its pane comes forward)
  const key = c.kind === 'file' ? path.resolve(c.file).toLowerCase() : c.url;
  let p = [...previews.values()].find((x) => x.key === key);
  if (!p) {
    const id = 'pv:' + crypto.randomBytes(5).toString('hex');
    p = c.kind === 'file' ? { id, key, kind: 'file', target: c.file, dir: path.dirname(c.file), file: path.basename(c.file), title: path.basename(c.file), version: 0 } : { id, key, kind: 'url', target: c.url, title: urlTitle(c.url) };
    previews.set(id, p);
    if (p.kind === 'file') watch(p);
  }
  p.at = Date.now();
  return { ...publicView(p) };
}

// host and path, so two pages of one dev server can be told apart
const urlTitle = (href) => {
  const u = new URL(href);
  return u.host + (u.pathname !== '/' ? u.pathname : '') + u.search;
};

export const getPreview = (id) => (previews.get(id) ? publicView(previews.get(id)) : null);

function publicView(p) {
  const url = p.kind === 'url' ? p.target : `http://127.0.0.1:${PREVIEW_PORT}/p/${p.id.slice(3)}/${encodeURI(p.file)}`;
  return { id: p.id, kind: p.kind, target: p.target, title: p.title, url };
}

// a change anywhere in the file's folder bumps its version; the page polls it and reloads
function watch(p) {
  try {
    p.watcher = fs.watch(p.dir, { recursive: true }, () => p.version++);
  } catch {
    // no watching: the ⟳ button still works
  }
}

/** Opens an outside URL in the system browser. */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', url.replace(/[&^|<>]/g, '^$&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/* ---------- the preview server ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Reloads the page when its folder changes; external links go to the system browser (a popup the
// desktop app hands to it). Nothing of the command center is given to the page.
const RELOAD = (id, version) => `<script>(()=>{let v=${version};setInterval(async()=>{try{const r=await fetch('/p/${id}/__v',{cache:'no-store'});const n=Number(await r.text());if(n!==v)location.reload()}catch{}},800);document.addEventListener('click',(e)=>{const a=e.target.closest&&e.target.closest('a[href]');if(!a)return;const u=new URL(a.href,location.href);if(/^https?:$/.test(u.protocol)&&!/^(localhost|127\\.0\\.0\\.1)$/.test(u.hostname)){e.preventDefault();window.open(u.href,'_blank','noopener')}},true)})();</script>`;

function serve(req, res) {
  const url = new URL(req.url, 'http://preview');
  const m = url.pathname.match(/^\/p\/([0-9a-f]{10})\/(.*)$/);
  const p = m && previews.get('pv:' + m[1]);
  if (!p || p.kind !== 'file') return end(res, 404, 'not found');
  if (m[2] === '__v') return end(res, 200, String(p.version), 'text/plain', { 'Access-Control-Allow-Origin': '*' });
  // only files inside the previewed file's folder
  const file = path.resolve(p.dir, decodeURIComponent(m[2]) || p.file);
  if (!file.toLowerCase().startsWith(path.resolve(p.dir).toLowerCase() + path.sep) && file.toLowerCase() !== path.resolve(p.dir).toLowerCase()) return end(res, 403, 'outside the previewed folder');
  fs.readFile(file, (err, data) => {
    if (err) return end(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    let body = data;
    if (ext === '.md' || ext === '.markdown') body = Buffer.from(markdownPage(path.basename(file), data.toString('utf8')) + RELOAD(m[1], p.version));
    else if (ext === '.html' || ext === '.htm') {
      const html = data.toString('utf8');
      const at = html.search(/<\/body>/i);
      body = Buffer.from(at >= 0 ? html.slice(0, at) + RELOAD(m[1], p.version) + html.slice(at) : html + RELOAD(m[1], p.version));
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

function end(res, code, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

let server = null;
export function startPreview() {
  if (server) return;
  server = http.createServer(serve);
  server.on('error', (e) => console.error('preview server:', e.message));
  server.listen(PREVIEW_PORT, '127.0.0.1');
}
export function stopPreview() {
  server?.close();
  server = null;
  for (const p of previews.values()) p.watcher?.close();
}

/* ---------- Markdown ---------- */

function inline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/** Markdown to HTML: headings, paragraphs, lists (nested by indent), quotes, code, tables, rules, links, images. */
export function markdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTable = (l, next) => /\|/.test(l) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(next || '');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = l.match(/^\s*(```|~~~)\s*([\w-]*)/))) {
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[2] ? ` class="lang-${esc(m[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push('<hr>');
      i++;
    } else if (isTable(l, lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(q.join('\n'))}</blockquote>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const block = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && block.length))) block.push(lines[i++]);
      out.push(list(block));
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !isTable(lines[i], lines[i + 1])) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

function list(block) {
  const indent = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const base = indent(block[0]);
  const ordered = /^\s*\d+[.)]/.test(block[0]);
  const items = [];
  for (const l of block) {
    if (indent(l) <= base && /^\s*([-*+]|\d+[.)])\s+/.test(l)) items.push([l.replace(/^\s*([-*+]|\d+[.)])\s+/, '')]);
    else items[items.length - 1]?.push(l);
  }
  const li = items.map(([first, ...rest]) => {
    const task = first.match(/^\[( |x)\]\s+(.*)$/i);
    const head = task ? `<input type="checkbox" disabled${task[1].trim() ? ' checked' : ''}> ${inline(task[2])}` : inline(first);
    const sub = rest.filter((r) => /^\s*([-*+]|\d+[.)])\s+/.test(r));
    const more = rest.filter((r) => !/^\s*([-*+]|\d+[.)])\s+/.test(r)).map((r) => inline(r.trim()));
    return `<li>${head}${more.length ? ' ' + more.join(' ') : ''}${sub.length ? list(rest) : ''}</li>`;
  });
  return ordered ? `<ol>${li.join('')}</ol>` : `<ul>${li.join('')}</ul>`;
}

function markdownPage(title, src) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f3;--fg:#2b3138;--mut:#5f6873;--line:#d3d7dd;--code:#eceef1;--a:#2a6f96}
@media (prefers-color-scheme:dark){:root{--bg:#1e2228;--fg:#c9ced6;--mut:#949daa;--line:#343b46;--code:#262b33;--a:#7cb3d1}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.75 system-ui,-apple-system,'Segoe UI','Noto Sans SC','Yu Gothic UI',sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 32px 60px}h1,h2,h3{line-height:1.3;margin:1.6em 0 .6em}h1{font-size:1.9em;border-bottom:1px solid var(--line);padding-bottom:.3em}h2{font-size:1.45em;border-bottom:1px solid var(--line);padding-bottom:.25em}
a{color:var(--a)}code{background:var(--code);padding:.1em .35em;border-radius:4px;font:13px/1.5 'Cascadia Mono',Consolas,monospace}pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--line);color:var(--mut)}table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 12px}th{background:var(--code)}img{max-width:100%}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
</style></head><body><main>${markdown(src)}</main>`;
}

/* ---------- fleet-open: the command our terminals use ---------- */

export const BIN_DIR = path.join(DATA_DIR, 'bin');

/**
 * Puts `fleet-open` in <data>/bin (on our terminals' PATH, and their BROWSER): a .cmd for cmd and
 * PowerShell, a shell script for bash, both running the app's own executable as node (no node needed).
 */
export function installBin(port = config.port) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const script = path.join(BIN_DIR, 'fleet-open.cjs');
  fs.writeFileSync(script, FLEET_OPEN_SRC.replace('__PORT__', String(port)));
  const exe = process.execPath;
  fs.writeFileSync(path.join(BIN_DIR, 'fleet-open.cmd'), `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" %*\r\n`);
  const unix = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
  fs.writeFileSync(path.join(BIN_DIR, 'fleet-open'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${unix(exe)}" "${unix(script)}" "$@"\n`);
  try {
    fs.chmodSync(path.join(BIN_DIR, 'fleet-open'), 0o755);
  } catch {
    // Windows
  }
}

const FLEET_OPEN_SRC = `// fleet-open <file|folder|URL>: shows a page in Fleet Bridge (a pane of the command center)
// instead of the system browser. Local HTML / Markdown / images and localhost URLs open there; other
// http(s) URLs go to the system browser. Written by Fleet Bridge.
const args = process.argv.slice(2).filter((a) => a !== '--');
if (!args.length || args[0] === '-h' || args[0] === '--help') {
  console.log('usage: fleet-open <file | folder | http://localhost:PORT/...>');
  process.exit(args.length ? 0 : 1);
}
(async () => {
  let failed = false;
  for (const target of args) {
    try {
      const r = await fetch('http://127.0.0.1:__PORT__/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, cwd: process.cwd() }) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error((j.shown === false ? 'not shown: ' : '') + (j.error || 'HTTP ' + r.status));
      console.log(j.external ? 'opened in the system browser: ' + j.url : 'opened in Fleet Bridge: ' + j.title + (j.previews > 1 ? ' (' + j.previews + ' previews open, as tabs)' : ''));
    } catch (e) {
      failed = true;
      console.error('fleet-open: ' + (e.cause?.code === 'ECONNREFUSED' ? 'Fleet Bridge is not running' : e.message));
    }
  }
  process.exit(failed ? 1 : 0);
})();
`;

