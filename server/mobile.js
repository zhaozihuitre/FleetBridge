import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, DATA_DIR, ROOT } from './config.js';
import { L } from './i18n.js';
import { createAuth, isPrivateAddress, normPassword, PASSWORD_MIN, SESSION_DAYS, TRUST_DAYS } from './phoneauth.js';

// Web access: the command center (the same page as on the computer) and the phone page, for other
// devices on the local network (a tablet, a phone, another computer), on a second server; the main one
// stays on 127.0.0.1 for this computer only. On by default, never open:
//   - signing in takes the password (set on the computer first: nothing listens before) and then the
//     computer's OK for each new device (a dialog in the command center). The QR code on the computer
//     is only the address: one for every device (phones then go on to /m, tablets and computers to /),
//     and it leads to the same sign-in, it never lets anyone in by itself;
//   - a device stays signed in 30 days from its last use; each can be signed out on its own;
//   - only private addresses (LAN, Tailscale) may connect, even if a router forwards the port;
//   - what only this computer may do is never reachable from here: the settings of this access itself
//     (password, devices, push), quitting / updating the app, opening local files as previews, the
//     master's own channel (fleet_ui), focusing windows or opening terminals on this desktop.
// Everything else goes to the main server's handlers, as the local page would call them.
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const FILE = path.join(DATA_DIR, 'mobile.json');
const PORT = Number(process.env.MONITOR_MOBILE_PORT) || config.port + 2;
const COOKIE = 'fbm';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
// this computer's business only (see above)
const LOCAL_ONLY = /^\/api\/(admin\/|mobile\b|push\b|notify\b|web\/|ui\b|focus\b|resume\b|preview(\/restore|\/external)?$)/;
const PENDING_MS = 5 * 60_000;

let settings = load();
const auth = createAuth(settings, save);
let server = null;
// listening on the network: on, and a password set
const shouldListen = () => Boolean(settings.enabled) && auth.hasPassword();
/** The command center should ask for a password (first start, or not set yet and not put off). */
export const webSetupNeeded = () => Boolean(settings.enabled) && !auth.hasPassword() && !settings.setupSeen;
const PHONE_KEYS = new Set(['esc', 'enter', 'up', 'down', 'left', 'right', 'tab', 'shift-tab', 'backspace', '1', '2', '3']);
let hooks = null; // { action, screen, web(req, res), socket(req, socket, head), changed() }
const pending = new Map(); // request id -> { id, ua, ip, at, state: 'pending' | 'allowed' | 'denied', token }

function load() {
  try {
    return { enabled: true, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { enabled: true, token: null };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
}

// eight digits, shown as "1234 5678": easy to type on a tablet's number row
const newPassword = () => String(crypto.randomInt(0, 1e8)).padStart(8, '0').replace(/^(\d{4})(\d{4})$/, '$1 $2');

// From the phone page's PIN (default 123456) to the web access's password: the old PIN and every
// device signed in with it are dropped (anyone on the network knew the default). Web access is on by
// default, but listens on the network only once you have set a password: the command center asks for
// one on first start (or later from its Web access button). A password 0.9.35 made by itself, which
// nobody chose, is dropped the same way.
function migrate() {
  let changed = false;
  if ((settings.v || 0) < 2) {
    delete settings.pin;
    settings.sessions = [];
    settings.enabled = true;
    changed = true;
  }
  if ((settings.v || 0) < 3) {
    if (settings.generated && !settings.chosen) {
      delete settings.password;
      delete settings.generated;
      settings.sessions = [];
    }
    settings.v = 3;
    changed = true;
  }
  // the QR code's sign-in key (up to 0.9.37) is gone: the code is the address only now
  if (settings.token) {
    delete settings.token;
    changed = true;
  }
  if (changed) save();
}

migrate();

/** Addresses another device could reach, Tailscale's 100.64/10 included (labelled). */
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

/**
 * The web page a notification opens on a phone or tablet (it goes on to the phone page or the command
 * center by the device itself): the Tailscale address first, which also works away from the local
 * network, else the local one; null when web access is off. No credential in it: a device that is not
 * signed in gets the sign-in (password, then this computer's OK) and goes on to the target after.
 */
export function webUrl() {
  if (!settings.enabled || !server?.listening) return null;
  const list = addresses();
  const a = list.find((x) => x.tailscale) || list[0];
  return a ? `http://${a.ip}:${PORT}/` : null;
}

/** Devices waiting for the computer's OK (shown as a dialog in the command center). */
export function pendingDevices() {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > PENDING_MS) pending.delete(id);
  return [...pending.values()].filter((p) => p.state === 'pending').map(({ id, ua, ip, at }) => ({ id, ua, ip, at, device: deviceName(ua) }));
}

/** "iPad · Safari", "Android · Chrome", "Windows · Edge": enough to recognize one's own device. */
export function deviceName(ua = '') {
  const os_ = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android' : L('Android 平板', 'Android tablet', 'Android タブレット')) : /Macintosh/.test(ua) ? 'Mac / iPad' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os_, br].filter(Boolean).join(' · ') || L('未知设备', 'Unknown device', '不明なデバイス');
}

export async function mobileInfo() {
  const list = shouldListen() ? addresses() : [];
  const urls = list.map((a) => ({ ...a, web: `http://${a.ip}:${PORT}/`, phone: `http://${a.ip}:${PORT}/m` }));
  const best = list.find((u) => !u.tailscale) || list[0];
  // the QR code is the address only (the same for phones, tablets and computers): it opens the sign-in,
  // it does not sign anyone in. Dark on light, which every camera reads.
  const qr = best ? await QRCode.toString(`http://${best.ip}:${PORT}/`, { type: 'svg', margin: 1, color: { dark: '#04060c', light: '#ddf6ff' } }) : null;
  const host = shouldListen() ? `http://${os.hostname().toLowerCase()}:${PORT}/` : null;
  return {
    enabled: Boolean(settings.enabled),
    running: Boolean(server?.listening),
    port: PORT,
    urls,
    qr,
    host,
    hasPassword: auth.hasPassword(),
    setup: webSetupNeeded(),
    generated: settings.generated || null, // a password you had made ("随机生成"), shown here until you set your own
    devices: auth.devices().map((d) => ({ ...d, device: deviceName(d.ua) })),
    pending: pendingDevices(),
    sessionDays: SESSION_DAYS,
    trustDays: TRUST_DAYS,
    passwordMin: PASSWORD_MIN,
  };
}

export async function setMobile({ enabled, password, logoutAll, revoke, approve, newGenerated, setupSeen }) {
  if (setupSeen) settings.setupSeen = true; // "later": not asked again at start
  if (password !== undefined) {
    const r = auth.setPassword(password);
    if (!r.ok) return { ...(await mobileInfo()), error: L('密码至少 {0} 个字符', 'The password needs at least {0} characters', 'パスワードは {0} 文字以上にしてください').replace('{0}', PASSWORD_MIN) };
    delete settings.generated;
    settings.chosen = true;
    settings.setupSeen = true;
    save();
  }
  if (newGenerated) {
    // made at your request: it is your choice, shown on this computer until you set your own
    settings.generated = newPassword();
    settings.chosen = true;
    settings.setupSeen = true;
    auth.setPassword(settings.generated);
    save();
  }
  if (logoutAll) auth.logoutAll();
  if (revoke) auth.revoke(String(revoke));
  if (approve?.id) decide(approve.id, Boolean(approve.allow), { trust: Boolean(approve.trust), by: 'pc' });
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  save();
  if (shouldListen()) await listen();
  else stop();
  hooks?.changed?.(); // the pages see the new state (the first-start question) right away
  return mobileInfo();
}

function cookieOf(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
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

// Lax, not Strict: a link opened from another app (a phone push, a chat) is a cross-site navigation,
// and Strict kept the cookie off it: a signed-in phone got the sign-in page (and the computer's OK)
// on every tap. Lax sends it on such a top-level GET only; no other site's page can make a browser
// send it with a POST, a fetch or a WebSocket, and those also have to come from this server's own page
// (Origin, checked in handle), as do cross-site GETs of the API.
const sessionCookie = (token, trusted) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${(trusted ? TRUST_DAYS : SESSION_DAYS) * 86_400}`;

// Sign-in records (<data>/web-auth.jsonl, the last 500): who got the sign-in page and why (no cookie,
// a cookie we don't know, an expired one; and whether the browser said it came from another site),
// who was allowed or turned down and by whom. Never a password or a token.
const AUTH_LOG = path.join(DATA_DIR, 'web-auth.jsonl');
function authLog(ev, req, extra = {}) {
  try {
    const line = JSON.stringify({ at: Date.now(), ev, ip: String(req?.socket?.remoteAddress || extra.ip || '').replace(/^::ffff:/, ''), device: deviceName(req?.headers?.['user-agent'] || extra.ua || ''), site: req?.headers?.['sec-fetch-site'] || undefined, ...extra, ua: undefined });
    fs.appendFileSync(AUTH_LOG, line + '\n');
    if (fs.statSync(AUTH_LOG).size > 200_000) fs.writeFileSync(AUTH_LOG, fs.readFileSync(AUTH_LOG, 'utf8').split('\n').slice(-500).join('\n'));
  } catch {
    // no record
  }
}

/** Allows or turns down a waiting device (by this computer, or by a trusted device). */
function decide(id, allow, { trust = false, by = 'pc' } = {}) {
  const p = pending.get(id);
  if (!p || p.state !== 'pending') return false;
  p.state = allow ? 'allowed' : 'denied';
  if (allow) {
    p.trusted = Boolean(trust);
    p.token = auth.issue(p.ua, p.ip, { trusted: p.trusted });
  }
  authLog(allow ? 'allowed' : 'denied', null, { ip: p.ip, ua: p.ua, by, trusted: allow ? p.trusted : undefined });
  hooks?.changed?.();
  return true;
}

// Sign-in, self-contained (nothing else is served before it): the password, then waiting for the
// computer's OK. `next` is where to go after (the command center, or the phone page).
function loginPage(res, next = '/', note = '') {
  const t = {
    title: L('舰桥 · 登录', 'Fleet Bridge · sign in', '艦橋 · ログイン'),
    head: L('输入访问密码', 'Enter the access password', 'アクセスパスワードを入力'),
    sub: L(`密码在电脑上的指挥中心「Web 访问」里。登录后这台设备 ${SESSION_DAYS} 天内不用再输。`, `The password is under Web access in the command center on the computer. This device then stays signed in for ${SESSION_DAYS} days.`, `パスワードはパソコンの指揮センター「Web アクセス」にあります。ログイン後 ${SESSION_DAYS} 日間は再入力不要です。`),
    go: L('登录', 'Sign in', 'ログイン'),
    wait: L('密码正确。请在电脑上的指挥中心点「允许」…', 'Right password. Now allow this device in the command center on the computer…', 'パスワードは正しいです。パソコンの指揮センターで「許可」してください…'),
    denied: L('电脑上拒绝了这台设备。', 'The computer turned this device down.', 'パソコンでこのデバイスが拒否されました。'),
    expired: L('等待超时，请重新登录。', 'Timed out. Sign in again.', 'タイムアウトしました。再度ログインしてください。'),
    wrong: L('密码不对，还可以试 {0} 次', 'Wrong password, {0} tries left', 'パスワードが違います。残り {0} 回'),
    locked: L('错误次数太多，请 {0} 后再试', 'Too many wrong passwords. Try again in {0}', '誤りが多すぎます。{0} 後に再試行してください'),
    fail: L('连接失败，请重试', 'Could not connect, try again', '接続できません。再試行してください'),
  };
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#04060c"><title>${t.title}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 20px;background:#04060c;color:#ddf6ff;font-family:system-ui,-apple-system,'Microsoft YaHei UI','PingFang SC',sans-serif}
.box{width:100%;max-width:380px;display:flex;flex-direction:column;gap:16px}
.brand{font:900 20px/1 system-ui;letter-spacing:3px;color:#3df5ff}.brand i{color:#ddf6ff;font-style:normal}
h1{margin:0;font-size:22px}p{margin:0;font-size:14px;line-height:1.6;color:#8fb4c4}
input{width:100%;height:56px;padding:0 16px;font-size:24px;letter-spacing:4px;text-align:center;background:#081220;border:1px solid #2a4a5e;color:#fff;border-radius:6px;outline:none}
input:focus{border-color:#3df5ff;box-shadow:0 0 0 2px rgba(61,245,255,.25)}
button{height:54px;font-size:18px;font-weight:700;background:#3df5ff;color:#04060c;border:0;border-radius:6px}button:disabled{opacity:.5}
.msg{min-height:22px;font-size:14px;color:#ff6b85}.msg.ok{color:#4dffa6}
</style></head><body><form class="box" id="f" autocomplete="off">
<div class="brand">FLEET<i>//</i>BRIDGE</div><h1>${t.head}</h1><p>${t.sub}</p>
<input id="pw" type="password" autocomplete="current-password" aria-label="password" autofocus>
<div class="msg" id="msg" role="alert">${note}</div><button id="go">${t.go}</button></form>
<script>
const T=${JSON.stringify(t)},NEXT=${JSON.stringify(next)};const f=document.getElementById('f'),pw=document.getElementById('pw'),msg=document.getElementById('msg'),go=document.getElementById('go');
// signed in: on to the page with the link's target (#term=…), at a new address each time: the same
// address would only change the hash, and a reload of a page another app opened still counts as coming
// from elsewhere (an old Strict cookie stays off it); a navigation from this page does not
const go2=()=>location.replace(NEXT+'?in='+Date.now()+location.hash);
// signed in already (the cookie only stayed off the link that opened this): straight on, no password
// (not when this page is that way back in already, ?in=…: never a loop)
if(!/[?&]in=/.test(location.search))fetch('/api/me',{cache:'no-store'}).then(r=>{if(r.ok)go2()}).catch(()=>{});
const fmt=(s)=>s>=60?Math.ceil(s/60)+' min':s+' s';
const wait=async(id)=>{msg.className='msg ok';msg.textContent=T.wait;go.disabled=true;pw.disabled=true;
for(;;){await new Promise(r=>setTimeout(r,1500));let j;try{j=await (await fetch('/api/login/wait?id='+encodeURIComponent(id))).json()}catch{continue}
if(j.state==='allowed'){go2();return}if(j.state!=='pending'){msg.className='msg';msg.textContent=j.state==='denied'?T.denied:T.expired;go.disabled=false;pw.disabled=false;pw.value='';return}}};
f.addEventListener('submit',async(e)=>{e.preventDefault();if(!pw.value)return;go.disabled=true;msg.className='msg';msg.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});const j=await r.json();
if(j.ok){if(j.pending)return wait(j.pending);go2();return}msg.textContent=j.wait?T.locked.replace('{0}',fmt(j.wait)):T.wrong.replace('{0}',j.left);pw.value='';pw.focus()}
catch{msg.textContent=T.fail}go.disabled=false});
</script></body></html>`);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://web');
  // the local network only (Tailscale included): never the internet, even if a router forwards the port
  if (!isPrivateAddress(req.socket.remoteAddress)) return page(res, 403, L('只允许局域网内访问。', 'Only reachable from the local network.', 'ローカルネットワークからのみ利用できます。'));
  // only this server's own pages may call it (no other site's page, with the cookie or without)
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden' });
  // a write (POST…) only from this server's own page: the browser always names its Origin there
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden' });
  // The cookie now goes along when another site links here (Lax). Every GET of the API only reads
  // (state, screens, diffs, search), and what a top-level visit shows is shown to the user, not to the
  // other site; still, a browser that says it came from another site gets the pages only (browsers
  // send Sec-Fetch-Site over HTTPS or to localhost only, so on the LAN it rests on the reads alone)
  if (req.headers['sec-fetch-site'] === 'cross-site' && url.pathname.startsWith('/api/')) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { password, pin } = await readBody(req);
    const r = auth.check(password ?? pin, req.socket.remoteAddress);
    if (!r.ok) return send(res, r.wait ? 429 : 401, { ok: false, wait: r.wait || 0, left: r.left ?? null });
    // a right password: this device now waits for the computer's OK
    const id = crypto.randomBytes(12).toString('base64url');
    pending.set(id, { id, ua: String(req.headers['user-agent'] || '').slice(0, 160), ip: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''), at: Date.now(), state: 'pending', token: null });
    authLog('password', req);
    hooks?.changed?.();
    return send(res, 200, { ok: true, pending: id });
  }
  if (req.method === 'GET' && url.pathname === '/api/login/wait') {
    const p = pending.get(url.searchParams.get('id') || '');
    if (!p || Date.now() - p.at > PENDING_MS) return send(res, 200, { state: 'expired' });
    if (p.state === 'allowed' && p.token) {
      pending.delete(p.id);
      return send(res, 200, { state: 'allowed' }, { 'Set-Cookie': sessionCookie(p.token, p.trusted) });
    }
    if (p.state === 'denied') pending.delete(p.id);
    return send(res, 200, { state: p.state });
  }
  const cookie = cookieOf(req);
  const me = auth.session(cookie);
  if (!me) {
    const pageNext = req.method === 'GET' && (url.pathname === '/m' || url.pathname === '/m/') ? '/m' : req.method === 'GET' && url.pathname === '/' ? '/' : null;
    if (pageNext) {
      authLog('sign-in-page', req, { cookie: cookie ? 'unknown-or-expired' : 'none', path: url.pathname });
      return loginPage(res, pageNext);
    }
    return send(res, 401, { error: 'sign_in' });
  }
  if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { ok: true, trusted: Boolean(me.trusted) });
  // a page visit renews the cookie (Lax, its full time again): cookies set Strict before 0.9.44 change over
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/m' || url.pathname === '/m/')) res.setHeader('Set-Cookie', sessionCookie(cookie, me.trusted));
  // a trusted device (allowed with "trust this device") may allow new devices itself, without the computer
  if (url.pathname === '/api/devices/pending' || url.pathname === '/api/devices/approve') {
    if (!me.trusted) return send(res, 403, { error: 'not_trusted' });
    if (req.method === 'GET') return send(res, 200, { pending: pendingDevices() });
    const { id, allow } = await readBody(req);
    return send(res, 200, { ok: decide(String(id || ''), Boolean(allow), { by: 'device ' + me.id }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    auth.logout(cookie);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  }

  // the phone page, with its own small API
  if (req.method === 'GET' && (url.pathname === '/m' || url.pathname === '/m/')) return serveFile(res, '/web/m.html');
  if (req.method === 'GET' && url.pathname === '/api/screen') return send(res, 200, hooks.screen(url.searchParams.get('id')));
  if (req.method === 'POST' && url.pathname === '/api/action') {
    const body = await readBody(req);
    // the phone page talks to agents, nothing more: no spawning, killing, git, or settings
    if (!['text', 'queue', 'unqueue', 'answer', 'key'].includes(body.action)) return send(res, 400, { error: 'not_allowed' });
    // keys for dialogs and the input line; not Ctrl+C (twice ends the session)
    if (body.action === 'key' && !PHONE_KEYS.has(body.key)) return send(res, 400, { error: 'not_allowed' });
    return send(res, 200, hooks.action({ ...body, via: 'phone' }));
  }
  if (req.method === 'POST' && url.pathname === '/api/lang') return send(res, 200, { ok: true }); // follows the computer's language

  // the command center, as on the computer, minus what is this computer's business only
  if (LOCAL_ONLY.test(url.pathname)) return send(res, 403, { error: 'local_only', message: L('这个操作只能在电脑上做。', 'Only on the computer itself.', 'この操作はパソコン本体でのみ可能です。') });
  return hooks.web(req, res);
}

function serveFile(res, p) {
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// the terminals' WebSockets: the same checks as a page (private address, this server's own page, signed in)
function upgrade(req, socket, head) {
  if (!isPrivateAddress(req.socket.remoteAddress) || req.headers.origin !== `http://${req.headers.host}` || !auth.valid(cookieOf(req))) return socket.destroy();
  hooks.socket(req, socket, head);
}

async function listen() {
  if (server?.listening) return;
  server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })));
  server.on('upgrade', upgrade);
  await new Promise((resolve) => {
    server.once('error', (e) => {
      console.error('web access server:', e.message);
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

/** Called once by the main server with what the other devices may use. */
export async function startMobile(h) {
  hooks = h;
  if (shouldListen()) await listen();
}

export function stopMobile() {
  stop();
}

export { normPassword };
