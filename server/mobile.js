import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, DATA_DIR, ROOT } from './config.js';
import { L } from './i18n.js';

// The phone page: a second, separate server on the LAN (the main one stays on 127.0.0.1). Off by
// default; when on, a phone pairs once by opening the QR link (it carries a random key), gets a
// long-lived HttpOnly cookie, and from then on may see the state and send orders. Nothing else
// is served without that cookie. A new key unpairs every phone.
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const FILE = path.join(DATA_DIR, 'mobile.json');
const PORT = Number(process.env.MONITOR_MOBILE_PORT) || config.port + 2;
const COOKIE = 'fbm';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const FILES = new Set(['/web/m.html', '/web/m.js', '/web/m.css', '/web/i18n.js', '/web/style.css']);

let settings = load();
let server = null;
let hooks = null; // { clients, getState, publish, action, screen }

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { enabled: false, token: null };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

/** LAN addresses a phone could reach, Tailscale's 100.64/10 included (labelled). */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
      out.push({ ip: a.address, name, tailscale });
    }
  }
  return out;
}

export async function mobileInfo() {
  const urls = settings.enabled && settings.token ? addresses().map((a) => ({ ...a, url: `http://${a.ip}:${PORT}/m?k=${settings.token}` })) : [];
  // dark on light: some phone cameras cannot read inverted codes
  const qr = urls[0] ? await QRCode.toString(urls.find((u) => !u.tailscale)?.url || urls[0].url, { type: 'svg', margin: 1, color: { dark: '#04060c', light: '#ddf6ff' } }) : null;
  return { enabled: Boolean(settings.enabled), running: Boolean(server?.listening), port: PORT, urls, qr };
}

export async function setMobile({ enabled, regenerate }) {
  if (regenerate || !settings.token) settings.token = newToken();
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  save();
  if (settings.enabled) await listen();
  else stop();
  return mobileInfo();
}

function cookieOf(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c).length > 64_000 && req.destroy());
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function page(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#04060c;color:#ddf6ff;font-family:system-ui;padding:24px;line-height:1.7">${text}</body>`);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://phone');
  // pairing: the QR link sets the cookie, then drops the key from the address bar
  if (url.pathname === '/m' && url.searchParams.has('k')) {
    if (!safeEqual(url.searchParams.get('k'), settings.token)) return page(res, 403, L('配对链接已失效。请在电脑的指挥中心重新扫码。', 'This pairing link is no longer valid. Scan the code in the command center again.', 'このペアリングリンクは無効です。指揮センターでもう一度スキャンしてください。'));
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(settings.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/m' });
    return res.end();
  }
  if (!safeEqual(cookieOf(req), settings.token)) return page(res, 401, L('这台手机还没有配对。请在电脑的指挥中心打开「手机访问」，用手机扫码。', 'This phone is not paired. Turn on phone access in the command center and scan the code.', 'このスマホはペアリングされていません。指揮センターで「スマホ接続」をオンにしてコードをスキャンしてください。'));
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden' });

  if (req.method === 'GET' && (url.pathname === '/m' || url.pathname === '/m/')) return serveFile(res, '/web/m.html');
  if (req.method === 'GET' && FILES.has(url.pathname)) return serveFile(res, url.pathname);
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(hooks.getState())}\n\n`);
    hooks.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      hooks.clients.delete(res);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/screen') return send(res, 200, hooks.screen(url.searchParams.get('id')));
  if (req.method === 'POST' && url.pathname === '/api/action') {
    const body = await readBody(req);
    // the phone may talk to agents, nothing more: no spawning, killing, git, or settings
    if (!['text', 'queue', 'unqueue', 'answer', 'key'].includes(body.action)) return send(res, 400, { error: 'not_allowed' });
    if (body.action === 'key' && body.key !== 'esc') return send(res, 400, { error: 'not_allowed' });
    return send(res, 200, hooks.action(body));
  }
  return send(res, 404, { error: 'not_found' });
}

function serveFile(res, p) {
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function listen() {
  if (server?.listening) return;
  server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })));
  await new Promise((resolve) => {
    server.once('error', (e) => {
      console.error('phone server:', e.message);
      server = null;
      resolve();
    });
    server.listen(PORT, '0.0.0.0', resolve);
  });
}

function stop() {
  server?.close();
  server = null;
}

/** Called once by the main server with what the phone page may use. */
export async function startMobile(h) {
  hooks = h;
  if (settings.enabled && settings.token) await listen();
}

export function stopMobile() {
  stop();
}
