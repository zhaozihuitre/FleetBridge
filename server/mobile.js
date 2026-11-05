import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, DATA_DIR, ROOT } from './config.js';
import { L } from './i18n.js';
import { createAuth, isPrivateAddress, SESSION_DAYS } from './phoneauth.js';

// The phone page: a second, separate server on the LAN (the main one stays on 127.0.0.1). Off by
// default; when on, a phone signs in with the PIN (or by opening the QR link shown on the computer,
// which carries a random key) and gets a device session cookie good for 30 days from its last use.
// Nothing else is served without it, and only private addresses may connect. Changing the PIN or
// a new key signs every phone out.
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const FILE = path.join(DATA_DIR, 'mobile.json');
const PORT = Number(process.env.MONITOR_MOBILE_PORT) || config.port + 2;
const COOKIE = 'fbm';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const FILES = new Set(['/web/m.html', '/web/m.js', '/web/m.css', '/web/i18n.js', '/web/style.css', '/web/theme.js']);

let settings = load();
const auth = createAuth(settings, save);
let server = null;
const PHONE_KEYS = new Set(['esc', 'enter', 'up', 'down', 'left', 'right', 'tab', 'shift-tab', 'backspace', '1', '2', '3']);
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
let addrCache = { at: 0, list: [] };
function addresses() {
  // asked on every 3 s publish; the interfaces seldom change and reading them costs a few ms
  if (Date.now() - addrCache.at < 30_000) return addrCache.list;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
      out.push({ ip: a.address, name, tailscale });
    }
  }
  addrCache = { at: Date.now(), list: out };
  return out;
}

/** The phone page address for a notification to open, or null when phone access is off. */
export function phoneUrl() {
  if (!settings.enabled || !server?.listening) return null;
  const a = addresses().find((x) => !x.tailscale) || addresses()[0];
  return a ? `http://${a.ip}:${PORT}/m` : null;
}

export async function mobileInfo() {
  const urls = settings.enabled && settings.token ? addresses().map((a) => ({ ...a, url: `http://${a.ip}:${PORT}/m?k=${settings.token}` })) : [];
  // dark on light: some phone cameras cannot read inverted codes
  const qr = urls[0] ? await QRCode.toString(urls.find((u) => !u.tailscale)?.url || urls[0].url, { type: 'svg', margin: 1, color: { dark: '#04060c', light: '#ddf6ff' } }) : null;
  // the computer's name: still right when the DHCP address changes, where the network resolves it
  const host = settings.enabled ? `http://${os.hostname().toLowerCase()}:${PORT}/m` : null;
  return { enabled: Boolean(settings.enabled), running: Boolean(server?.listening), port: PORT, urls, qr, host, pinDefault: auth.isDefault(), devices: auth.devices(), sessionDays: SESSION_DAYS };
}

export async function setMobile({ enabled, regenerate, pin, logoutAll }) {
  if (pin !== undefined) {
    const r = auth.setPin(pin);
    if (!r.ok) return { ...(await mobileInfo()), error: L('PIN 需要是 4 到 12 位数字', 'The PIN must be 4 to 12 digits', 'PIN は 4〜12 桁の数字にしてください') };
  }
  if (logoutAll) auth.logoutAll();
  if (regenerate) auth.logoutAll(); // a new key: the old QR link and every signed-in phone stop working
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

const sessionCookie = (token) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86_400}`;

// PIN sign-in, self-contained (nothing else is served before signing in).
function loginPage(res, note = '') {
  const t = {
    title: L('舰桥 · 登录', 'Fleet Bridge · sign in', '艦橋 · ログイン'),
    head: L('输入 PIN', 'Enter the PIN', 'PIN を入力'),
    sub: L(`登录后这台设备 ${SESSION_DAYS} 天内不用再输。PIN 在电脑的指挥中心「手机访问」里设置。`, `This device stays signed in for ${SESSION_DAYS} days. The PIN is set under Phone access in the command center.`, `ログイン後 ${SESSION_DAYS} 日間は再入力不要です。PIN は指揮センターの「スマホ接続」で設定します。`),
    go: L('登录', 'Sign in', 'ログイン'),
    wrong: L('PIN 不对，还可以试 {0} 次', 'Wrong PIN, {0} tries left', 'PIN が違います。残り {0} 回'),
    locked: L('错误次数太多，请 {0} 后再试', 'Too many wrong PINs. Try again in {0}', '誤りが多すぎます。{0} 後に再試行してください'),
    fail: L('连接失败，请重试', 'Could not connect, try again', '接続できません。再試行してください'),
  };
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#04060c"><title>${t.title}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 20px;background:#04060c;color:#ddf6ff;font-family:system-ui,-apple-system,'Noto Sans SC',sans-serif}
.box{width:100%;max-width:360px;display:flex;flex-direction:column;gap:16px}
.brand{font:900 20px/1 system-ui;letter-spacing:3px;color:#3df5ff}.brand i{color:#ddf6ff;font-style:normal}
h1{margin:0;font-size:22px}p{margin:0;font-size:14px;line-height:1.6;color:#8fb4c4}
input{width:100%;height:60px;padding:0 16px;font-size:30px;letter-spacing:10px;text-align:center;background:#081220;border:1px solid #2a4a5e;color:#fff;border-radius:6px;outline:none}
input:focus{border-color:#3df5ff;box-shadow:0 0 0 2px rgba(61,245,255,.25)}
button{height:54px;font-size:18px;font-weight:700;background:#3df5ff;color:#04060c;border:0;border-radius:6px}button:disabled{opacity:.5}
.msg{min-height:22px;font-size:14px;color:#ff6b85}
</style></head><body><form class="box" id="f" autocomplete="off">
<div class="brand">FLEET<i>//</i>BRIDGE</div><h1>${t.head}</h1><p>${t.sub}</p>
<input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="current-password" aria-label="PIN" autofocus>
<div class="msg" id="msg" role="alert">${note}</div><button id="go">${t.go}</button></form>
<script>
const T=${JSON.stringify(t)};const f=document.getElementById('f'),pin=document.getElementById('pin'),msg=document.getElementById('msg'),go=document.getElementById('go');
const fmt=(s)=>s>=60?Math.ceil(s/60)+' min':s+' s';
f.addEventListener('submit',async(e)=>{e.preventDefault();if(!pin.value)return;go.disabled=true;msg.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin.value})});const j=await r.json();
if(j.ok){location.replace('/m');return}msg.textContent=j.wait?T.locked.replace('{0}',fmt(j.wait)):T.wrong.replace('{0}',j.left);pin.value='';pin.focus()}
catch{msg.textContent=T.fail}go.disabled=false});
</script></body></html>`);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://phone');
  // the LAN only (Tailscale included): never the internet, even if a router forwards the port
  if (!isPrivateAddress(req.socket.remoteAddress)) return page(res, 403, L('只允许局域网内访问。', 'Only reachable from the local network.', 'ローカルネットワークからのみ利用できます。'));
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden' });
  // the QR link on the computer's screen signs this phone in right away, then drops the key from the address bar
  if (url.pathname === '/m' && url.searchParams.has('k')) {
    if (!safeEqual(url.searchParams.get('k'), settings.token)) return loginPage(res, L('二维码已失效，请输入 PIN 登录。', 'The code is no longer valid. Sign in with the PIN.', 'コードが無効です。PIN でログインしてください。'));
    res.writeHead(302, { 'Set-Cookie': sessionCookie(auth.issue(req.headers['user-agent'])), Location: '/m' });
    return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { pin } = await readBody(req);
    const r = auth.login(pin, req.socket.remoteAddress, req.headers['user-agent']);
    if (!r.ok) return send(res, r.wait ? 429 : 401, { ok: false, wait: r.wait || 0, left: r.left ?? null });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(r.token) });
    return res.end(JSON.stringify({ ok: true }));
  }
  const cookie = cookieOf(req);
  // phones paired before PINs keep working until a new key
  const signedIn = auth.valid(cookie) || safeEqual(cookie, settings.token);
  if (!signedIn) {
    if (req.method === 'GET' && (url.pathname === '/m' || url.pathname === '/m/' || url.pathname === '/')) return loginPage(res);
    return send(res, 401, { error: 'sign_in' });
  }
  if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/lang') return send(res, 200, { ok: true }); // the phone follows the computer's language
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    auth.logout(cookie);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
    return res.end('{"ok":true}');
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { Location: '/m' });
    return res.end();
  }

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
    // keys for dialogs and the input line; not Ctrl+C (twice ends the session)
    if (body.action === 'key' && !PHONE_KEYS.has(body.key)) return send(res, 400, { error: 'not_allowed' });
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
