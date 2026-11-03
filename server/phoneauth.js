import crypto from 'node:crypto';

// Phone sign-in: a fixed PIN (default 123456, changeable in the command center), then a device
// session that lasts 30 days from its last use, so the PIN is typed once per phone, not per visit.
// Sessions are stored hashed. Wrong PINs lock the sign-in for a while (per address, and for
// everyone after many failures), so a 6-digit PIN can't be tried out. Only private addresses
// (LAN, link-local, Tailscale) may connect at all.
export const DEFAULT_PIN = '123456';
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const MAX_SESSIONS = 30;
const PER_IP_TRIES = 5; // then locked, 5 min doubling up to an hour
const GLOBAL_TRIES = 30; // wrong PINs from anywhere within 10 min: everyone locked for 10 min

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** settings: the persisted phone settings object ({ pin, sessions, ... }); save(): persist it. */
export function createAuth(settings, save) {
  settings.sessions ||= [];
  const fails = new Map(); // ip -> { n, lockedUntil, locks }
  let recent = []; // times of wrong PINs from anywhere
  let globalUntil = 0;

  const isDefault = () => !settings.pin;

  function checkPin(pin) {
    if (!settings.pin) return same(String(pin), DEFAULT_PIN);
    return same(hashPin(pin, settings.pin.salt).hash, settings.pin.hash);
  }

  /** Seconds until this address may try again (0: may try now). */
  function lockedFor(ip, now = Date.now()) {
    const f = fails.get(ip);
    const until = Math.max(f?.lockedUntil || 0, globalUntil);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /** @returns {{ ok: true, token: string } | { ok: false, wait?: number, left?: number }} */
  function login(pin, ip, ua, now = Date.now()) {
    const wait = lockedFor(ip, now);
    if (wait) return { ok: false, wait };
    if (!/^\d{4,12}$/.test(String(pin || '')) || !checkPin(pin)) {
      const f = fails.get(ip) || { n: 0, lockedUntil: 0, locks: 0 };
      f.n++;
      if (f.n >= PER_IP_TRIES) {
        f.locks++;
        f.n = 0;
        f.lockedUntil = now + Math.min(60, 5 * 2 ** (f.locks - 1)) * 60_000;
      }
      fails.set(ip, f);
      recent = recent.filter((t) => now - t < 600_000).concat(now);
      if (recent.length >= GLOBAL_TRIES) {
        globalUntil = now + 600_000;
        recent = [];
      }
      const w = lockedFor(ip, now);
      return w ? { ok: false, wait: w } : { ok: false, left: PER_IP_TRIES - f.n };
    }
    fails.delete(ip);
    return { ok: true, token: issue(ua, now) };
  }

  /** A new device session (after the PIN, or from the QR link shown on the computer's screen). */
  function issue(ua, now = Date.now()) {
    const token = crypto.randomBytes(32).toString('base64url');
    settings.sessions = [{ h: sha(token), at: now, seen: now, ua: String(ua || '').slice(0, 120) }, ...prune(now)].slice(0, MAX_SESSIONS);
    save();
    return token;
  }

  function prune(now = Date.now()) {
    return settings.sessions.filter((s) => now - s.seen < SESSION_MS);
  }

  /** Whether a session cookie is valid; slides its 30 days forward (written at most hourly). */
  function valid(token, now = Date.now()) {
    if (!token) return false;
    const h = sha(token);
    const s = settings.sessions.find((x) => same(x.h, h));
    if (!s || now - s.seen >= SESSION_MS) return false;
    if (now - s.seen > 3_600_000) {
      s.seen = now;
      save();
    }
    return true;
  }

  function logout(token) {
    const h = sha(token || '');
    settings.sessions = settings.sessions.filter((x) => x.h !== h);
    save();
  }

  /** New PIN: 4 to 12 digits. Every signed-in phone has to enter the new one. */
  function setPin(pin) {
    if (!/^\d{4,12}$/.test(String(pin || ''))) return { ok: false, error: 'pin_format' };
    settings.pin = String(pin) === DEFAULT_PIN ? null : hashPin(pin);
    settings.sessions = [];
    save();
    return { ok: true };
  }

  function logoutAll() {
    settings.sessions = [];
    save();
  }

  const devices = () => prune().length;

  return { login, issue, valid, logout, logoutAll, setPin, isDefault, devices, lockedFor };
}

/** LAN, link-local, Tailscale (100.64/10), loopback; IPv4-mapped IPv6 included. */
export function isPrivateAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  if (a === '::1' || /^fe[89ab]/i.test(a) || /^f[cd]/i.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}
