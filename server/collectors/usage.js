import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { L } from '../i18n.js';
import { config, DATA_DIR } from '../config.js';
import { currentOrg, noteOrg, orgAt, orgInfo } from '../accounts.js';

const API = 'https://api.anthropic.com/api/oauth';
const PROFILE_TTL = 10 * 60_000;
// Last good reading survives restarts so the HUD isn't blank while we wait on the API.
const CACHE = path.join(DATA_DIR, 'usage-cache.json');

const MIN_GAP = 60_000; // never hit the API more than once a minute, restarts included
// The last reading of every organization this account used (each has its own quota): the one signed
// in now is read live; one signed in before keeps its last reading, and is read on with the token it
// had while that token is still valid (in memory only: never saved, never refreshed from here).
const ORGS = path.join(DATA_DIR, 'usage-orgs.json');
const OTHER_GAP = 5 * 60_000;
let byOrg = loadJson(ORGS) || {}; // org uuid -> { fetchedAt, limits, error? }
const oldTokens = new Map(); // org uuid -> { token, expiresAt, fingerprint, nextAt }

let profileCache = { fingerprint: null, at: 0, data: null };
let last = loadCache();
let backoffUntil = last?.retryAt || 0;
let backoffMs = last?.backoffMs || 0;

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveOrgs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ORGS, JSON.stringify(byOrg));
  } catch {
    // memory only
  }
}

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

const LIMIT_LABEL = { session: ['5 小时', '5 hours', '5 時間'], weekly_all: ['本周 · 所有模型', 'Week · all models', '今週 · 全モデル'] };

/**
 * The quota as our agents' status line last saw it (see agents.js), merged over the API reading
 * when it is newer: it is current whenever one of our agents works, and is never rate limited.
 * It carries the 5-hour and weekly limits only; per-model ones keep the API's last value.
 */
export function withStatusline(usage, file) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return usage;
  }
  if (!s?.at || s.at <= (usage?.fetchedAt || 0)) return usage;
  // read under another organization than the API's reading (just switched): not this one's quota
  const org = orgAt(s.at);
  if (org && usage?.account?.orgId && org !== usage.account.orgId) return usage;
  const win = (w) => (w && Number.isFinite(w.used_percentage) ? { usedPct: w.used_percentage, resetsAt: (w.resets_at || 0) * 1000 } : null);
  const fresh = { session: win(s.five_hour), weekly_all: win(s.seven_day) };
  const limits = (usage?.limits?.length ? usage.limits : [{ key: 'session', active: false }, { key: 'weekly_all', active: false }]).map((l) => (fresh[l.key] ? { ...l, ...fresh[l.key] } : l));
  return { ...usage, ok: true, error: null, retryAt: null, fetchedAt: s.at, source: 'statusline', limits };
}

// Labels are made when publishing (not cached) so they follow a language switch.
export function limitLabel(key) {
  const [kind, model] = key.split(':');
  return LIMIT_LABEL[kind] ? L(...LIMIT_LABEL[kind]) : model ? L(`本周 · ${model}`, `Week · ${model}`, `今週 · ${model}`) : kind;
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
      data: { email: p.account?.email_address || p.account?.email || null, org: p.organization?.name || null, orgId: p.organization?.uuid || null, seat: p.organization?.seat_tier || null },
    };
  }
  return profileCache.data;
}

// The profile call failed (it is rate limited too, and a /login always needs a fresh one: the cache goes by
// the credentials): the reading still says whose quota it is. The same credentials' last profile while it is
// there, else the organization signed in now (~/.claude.json: a /login writes it with the new token).
// Without this the reading carried no organization: the quota boxes lost their name and the current
// organization showed as "another" one.
function profileFallback(cred) {
  if (profileCache.fingerprint === cred.fingerprint && profileCache.data?.orgId) return profileCache.data;
  const id = currentOrg();
  const o = id && orgInfo(id);
  return o ? { email: o.email || null, org: o.name || null, orgId: id, seat: o.seat || null, fromConfig: true } : null;
}

// Claude Code owns the token and refreshes it; we only read, so an expired token
// means "open Claude Code once", never a refresh from here (that would rotate it under CC).
export async function collectUsage(force = false) {
  // MONITOR_USAGE=off (test instances): never call the endpoint. It is rate limited per account,
  // so extra instances polling it starve the real app (it then shows a stale cache).
  if (process.env.MONITOR_USAGE === 'off') return last;
  if (!force && Date.now() < backoffUntil) return last;
  if (Date.now() - (last?.fetchedAt || 0) < MIN_GAP && last?.ok !== false && !force) return { ...last, stale: false };
  try {
    const cred = readCredentials();
    const [u, p] = await Promise.all([get('usage', cred.token), profile(cred).catch(() => profileFallback(cred))]);
    if (p?.orgId) {
      noteOrg(p.orgId, { name: p.org, email: p.email, seat: p.seat, tier: cred.tier });
      // a token of an organization signed in before: keep reading that one with it while it lasts
      for (const [id, t] of oldTokens) if (t.fingerprint === cred.fingerprint && id !== p.orgId) oldTokens.delete(id);
      oldTokens.set(p.orgId, { token: cred.token, expiresAt: cred.expiresAt, fingerprint: cred.fingerprint, nextAt: 0, current: true });
      for (const [id, t] of oldTokens) if (id !== p.orgId) t.current = false;
      byOrg[p.orgId] = { fetchedAt: Date.now(), limits: limitsOf(u), fiveHour: window(u.five_hour), sevenDay: window(u.seven_day) };
      saveOrgs();
    }
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
    await readOthers(p?.orgId);
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

// Organizations signed in before, read with the token they had (until it expires or is refused).
async function readOthers(currentId) {
  for (const [id, t] of oldTokens) {
    if (id === currentId || t.current) continue;
    if (Date.now() < t.nextAt) continue;
    if (t.expiresAt && Date.now() > t.expiresAt) {
      oldTokens.delete(id);
      continue;
    }
    t.nextAt = Date.now() + OTHER_GAP;
    try {
      const u = await get('usage', t.token);
      byOrg[id] = { fetchedAt: Date.now(), limits: limitsOf(u), fiveHour: window(u.five_hour), sevenDay: window(u.seven_day) };
    } catch (e) {
      if (e.message === 'token_expired') oldTokens.delete(id);
      if (byOrg[id]) byOrg[id].error = e.message;
    }
    saveOrgs();
  }
}

/** Every other organization's last reading: { org, fetchedAt, limits, live } (live: still read now). */
export function otherOrgs(currentId) {
  return Object.entries(byOrg)
    .filter(([id]) => id !== currentId && orgInfo(id))
    .map(([id, r]) => ({ org: orgInfo(id), fetchedAt: r.fetchedAt, limits: (r.limits?.length ? r.limits : [r.fiveHour && { key: 'session', ...r.fiveHour }, r.sevenDay && { key: 'weekly_all', ...r.sevenDay }].filter(Boolean)).map((l) => ({ ...l, label: limitLabel(l.key) })), live: oldTokens.has(id) }))
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
}
