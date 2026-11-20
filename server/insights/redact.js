import os from 'node:os';

// Everything that goes into the model's input, a proposal or a piece of evidence passes through here first:
// keys, tokens, passwords, cookies, private keys, e-mail addresses, long random strings, this machine's own
// secrets (the push topic, the phone's tokens) and the user's name in paths. What is taken out becomes
// ‹redacted:kind›. The rules err on the side of taking too much.

const R = (kind) => `‹redacted:${kind}›`;

const RULES = [
  // whole private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => R('private-key')],
  // provider keys and tokens by their shape
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, () => R('anthropic-key')],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, () => R('api-key')],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, () => R('github-token')],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => R('github-token')],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, () => R('gitlab-token')],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => R('slack-token')],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => R('aws-key')],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => R('google-key')],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, () => R('google-token')],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, () => R('npm-token')],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => R('jwt')],
  // credentials in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, (_, s) => `${s}${R('credentials')}@`],
  // Authorization / Cookie headers
  [/\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;"']+/gi, (_, k) => `${k}: ${R('auth')}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, () => `Bearer ${R('token')}`],
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\n]+/gi, (_, k) => `${k}: ${R('cookie')}`],
  // name = value for anything secret-looking (password, token, secret, api key, session, cookie …)
  [/\b([A-Za-z0-9_.-]*(?:passw(?:or)?d|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|session(?:[_-]?id)?|cookie|credential)s?)(["']?\s*[:=]\s*)(["']?)([^\s"',;}{)]{3,})\3/gi, (_, k, sep, q) => `${k}${sep}${q}${R('secret')}${q}`],
  // command-line flags: --password x, -p x after login-like commands, --token=x
  [/(--?(?:password|passwd|pwd|token|secret|api-key|apikey)(?:=|\s+))(["']?)[^\s"']+\2/gi, (_, f, q) => `${f}${q}${R('secret')}${q}`],
  // e-mail addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => R('email')],
  // long random-looking strings (hex ≥ 32, or ≥ 24 letters and digits mixed, base64-ish ≥ 40)
  [/\b[a-f0-9]{32,}\b/gi, () => R('hex')],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}\b/g, () => R('random')],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, () => R('base64')],
];

/**
 * @param {string} text
 * @param {{ secrets?: string[], home?: string, user?: string }} [o] secrets: exact values of this machine to take out
 *   (the push topic, tokens); home / user: the user's folder and name (default: this machine's)
 */
export function redact(text, o = {}) {
  let s = String(text ?? '');
  for (const v of o.secrets || []) if (v && String(v).length >= 6) s = s.split(String(v)).join(R('local-secret'));
  for (const [re, fn] of RULES) s = s.replace(re, fn);
  // the user's folder and name: C:\Users\<name> → ~ (either slash), then the bare name
  const home = o.home ?? os.homedir();
  if (home) {
    const parts = home.split(/[\\/]+/).filter(Boolean).map(escRe);
    if (parts.length) s = s.replace(new RegExp((/^[\\/]/.test(home) ? '[\\\\/]+' : '') + parts.join('[\\\\/]+'), 'gi'), '~');
  }
  let user = o.user;
  if (user === undefined) {
    try {
      user = os.userInfo().username;
    } catch {
      user = '';
    }
  }
  if (user && user.length >= 3) s = s.replace(new RegExp(`\\b${escRe(user)}\\b`, 'gi'), R('user'));
  return s;
}

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The same, through every string of a JSON-like value. */
export function redactDeep(v, o) {
  if (typeof v === 'string') return redact(v, o);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, o));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, o)]));
  return v;
}
