import crypto from 'node:crypto';

// Sign-in for other devices (the web command center, the phone page): a password, then a device
// session that lasts 30 days from its last use, so the password is typed once per device.
//   - there is no default password: until one is set (or generated, see mobile.js) nobody gets in;
//   - a right password is not enough: the device waits until it is allowed on the computer
//     (mobile.js keeps those requests), so a password seen over a shoulder or on the network alone
//     doesn't open the fleet;
//   - wrong passwords lock the sign-in for a while (per address, and for everyone after many);
//   - sessions and the password are stored hashed; each device can be signed out on its own.
export const SESSION_DAYS = 30;
// a device trusted when it was allowed ("信任此设备"): 90 days, and it may allow new devices itself
export const TRUST_DAYS = 90;
const ttl = (s) => (s.trusted ? TRUST_DAYS : SESSION_DAYS) * 86_400_000;
const MAX_SESSIONS = 30;
const PER_IP_TRIES = 5; // then locked, 5 min doubling up to an hour
const GLOBAL_TRIES = 30; // wrong passwords from anywhere within 10 min: everyone locked for 10 min
export const PASSWORD_MIN = 8;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Spaces don't count (a generated password is shown as "1234 5678"). */
export const normPassword = (p) => String(p ?? '').replace(/\s+/g, '');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(normPassword(pw), salt, 32).toString('hex') };
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** settings: the persisted settings object ({ password, sessions, ... }); save(): persist it. */
export function createAuth(settings, save) {
  settings.sessions ||= [];
  const fails = new Map(); // ip -> { n, lockedUntil, locks }
  let recent = []; // times of wrong passwords from anywhere
  let globalUntil = 0;

  const hasPassword = () => Boolean(settings.password?.hash);

  /** Seconds until this address may try again (0: may try now). */
  function lockedFor(ip, now = Date.now()) {
    const f = fails.get(ip);
    const until = Math.max(f?.lockedUntil || 0, globalUntil);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /**
   * Checks a password (with the lockouts). A right one still needs the computer's OK before a
   * session is issued.
   * @returns {{ ok: true } | { ok: false, wait?: number, left?: number }}
   */
  function check(pw, ip, now = Date.now()) {
    const wait = lockedFor(ip, now);
    if (wait) return { ok: false, wait };
    const good = hasPassword() && normPassword(pw).length >= PASSWORD_MIN && same(hashPassword(pw, settings.password.salt).hash, settings.password.hash);
    if (!good) {
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
    return { ok: true };
  }

  /** A new device session, after the computer (or a trusted device) allowed it. */
  function issue(ua, ip, { trusted = false } = {}, now = Date.now()) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomBytes(4).toString('hex');
    settings.sessions = [{ id, h: sha(token), at: now, seen: now, ua: String(ua || '').slice(0, 160), ip: String(ip || '').replace(/^::ffff:/, ''), ...(trusted ? { trusted: true } : {}) }, ...prune(now)].slice(0, MAX_SESSIONS);
    save();
    return token;
  }

  function prune(now = Date.now()) {
    return settings.sessions.filter((s) => now - s.seen < ttl(s));
  }

  /** The session of a cookie, if valid; slides its 30 (trusted: 90) days forward (written at most hourly). */
  function session(token, now = Date.now()) {
    if (!token) return null;
    const h = sha(token);
    const s = settings.sessions.find((x) => same(x.h, h));
    if (!s || now - s.seen >= ttl(s)) return null;
    if (now - s.seen > 3_600_000) {
      s.seen = now;
      save();
    }
    return s;
  }
  const valid = (token, now) => Boolean(session(token, now));

  function logout(token) {
    const h = sha(token || '');
    settings.sessions = settings.sessions.filter((x) => x.h !== h);
    save();
  }

  function revoke(id) {
    settings.sessions = settings.sessions.filter((x) => x.id !== id);
    save();
  }

  /** A new password (at least 8 characters, spaces ignored): every signed-in device has to sign in again. */
  function setPassword(pw) {
    if (normPassword(pw).length < PASSWORD_MIN) return { ok: false, error: 'password_short' };
    settings.password = hashPassword(pw);
    settings.sessions = [];
    save();
    return { ok: true };
  }

  function logoutAll() {
    settings.sessions = [];
    save();
  }

  const devices = () => prune().map(({ id, ua, ip, at, seen, trusted }) => ({ id, ua, ip, at, seen, trusted: Boolean(trusted) }));

  return { check, issue, valid, session, logout, logoutAll, revoke, setPassword, hasPassword, devices, lockedFor };
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
