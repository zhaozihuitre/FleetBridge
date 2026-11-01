import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { L } from '../i18n.js';
import { config, DATA_DIR } from '../config.js';

const API = 'https://api.anthropic.com/api/oauth';
const PROFILE_TTL = 10 * 60_000;
// Last good reading survives restarts so the HUD isn't blank while we wait on the API.
const CACHE = path.join(DATA_DIR, 'usage-cache.json');

const MIN_GAP = 60_000; // never hit the API more than once a minute, restarts included

let profileCache = { fingerprint: null, at: 0, data: null };
let last = loadCache();
let backoffUntil = last?.retryAt || 0;
let backoffMs = last?.backoffMs || 0;

function loadCache() {
  try {
    return { ...JSON.parse(fs.readFileSync(CACHE, 'utf8')), stale: true };
  } catch {
    return null;
  }
}

function readCredentials() {
  const file = path.join(config.claudeDir, '.credentials.json');
  const oauth = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('no_oauth_token');
  return {
    token: oauth.accessToken,
    expiresAt: oauth.expiresAt,
    tier: oauth.rateLimitTier,
    plan: oauth.subscriptionType,
    // Identifies the account without ever exposing the token itself.
    fingerprint: crypto.createHash('sha256').update(oauth.refreshToken || oauth.accessToken).digest('hex').slice(0, 12),
  };
}

async function get(endpoint, token) {
  const res = await fetch(`${API}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error('token_expired');
  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

function window(w) {
  return w ? { usedPct: w.utilization, resetsAt: Date.parse(w.resets_at) } : null;
}

const LIMIT_LABEL = { session: ['5 小时', '5 hours'], weekly_all: ['本周 · 所有模型', 'Week · all models'] };

// Labels are made when publishing (not cached) so they follow a language switch.
export function limitLabel(key) {
  const [kind, model] = key.split(':');
  return LIMIT_LABEL[kind] ? L(...LIMIT_LABEL[kind]) : model ? L(`本周 · ${model}`, `Week · ${model}`) : kind;
}

// The API's own list of limits, so per-model weekly caps (e.g. Fable) show up without code changes.
function limitsOf(u) {
  return (u.limits || []).map((l) => {
    const model = l.scope?.model?.display_name;
    return {
      key: l.kind + (model ? ':' + model : ''),
      group: l.group,
      label: limitLabel(l.kind + (model ? ':' + model : '')),
      usedPct: l.percent,
      resetsAt: Date.parse(l.resets_at),
      severity: l.severity,
      active: l.is_active, // the limit currently gating requests
    };
  });
}

function saveCache() {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ ...last, retryAt: backoffUntil || null, backoffMs }));
}

async function profile(cred) {
  const fresh = profileCache.fingerprint === cred.fingerprint && Date.now() - profileCache.at < PROFILE_TTL;
  if (!fresh) {
    const p = await get('profile', cred.token);
    profileCache = {
      fingerprint: cred.fingerprint,
      at: Date.now(),
      data: { email: p.account?.email_address || p.account?.email || null, org: p.organization?.name || null },
    };
  }
  return profileCache.data;
}

// Claude Code owns the token and refreshes it; we only read, so an expired token
// means "open Claude Code once", never a refresh from here (that would rotate it under CC).
export async function collectUsage(force = false) {
  if (!force && Date.now() < backoffUntil) return last;
  if (Date.now() - (last?.fetchedAt || 0) < MIN_GAP && last?.ok !== false && !force) return { ...last, stale: false };
  try {
    const cred = readCredentials();
    const [u, p] = await Promise.all([get('usage', cred.token), profile(cred).catch(() => null)]);
    last = {
      ok: true,
      fetchedAt: Date.now(),
      fiveHour: window(u.five_hour),
      sevenDay: window(u.seven_day),
      limits: limitsOf(u),
      account: { ...p, tier: cred.tier, plan: cred.plan, fingerprint: cred.fingerprint },
      error: null,
    };
    backoffMs = 0;
    backoffUntil = 0;
    saveCache();
  } catch (e) {
    if (e.message === 'rate_limited') {
      // 2, 4, 8 … up to 30 minutes between attempts until the API lets us back in
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2 * 60_000, 30 * 60_000);
      backoffUntil = Date.now() + backoffMs;
    }
    last = { ...(last || {}), ok: false, stale: Boolean(last?.fetchedAt), error: e.message, errorAt: Date.now(), retryAt: backoffUntil || null };
    saveCache(); // the backoff must survive a restart, or every restart hits the limit again
  }
  return last;
}
