import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Which claude.ai organization is signed in, and since when. One account can belong to several
// organizations (each with its own quota); Claude Code keeps one sign-in per config folder, in
// ~/.claude.json (oauthAccount: organization and email) and ~/.claude/.credentials.json (the token).
// After a /login to another organization every running Claude Code picks the new token up before
// its next request (it watches the credentials file), so at any moment all terminals of this folder
// use the organization signed in then. A terminal's organization is therefore the one signed in when
// it last worked: kept here as a timeline of sign-ins, from when Fleet Bridge first saw each one.
// (Before this timeline started, which organization a turn used is not recorded anywhere.)

const CONFIG = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
const CREDENTIALS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
const FILE = path.join(DATA_DIR, 'accounts.json');
const KEEP = 200; // sign-ins kept

let data = load(); // { orgs: { uuid: { name, email, seat, tier } }, since: [{ at, org }] }
let seen = { mtime: 0, size: 0, org: null };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { orgs: d.orgs || {}, since: Array.isArray(d.since) ? d.since : [] };
  } catch {
    return { orgs: {}, since: [] };
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {
    // kept in memory only
  }
}

/** Notes an organization (from the usage API's profile, or the config): its name and the account's email. */
export function noteOrg(uuid, info) {
  if (!uuid) return;
  const o = data.orgs[uuid] || {};
  const next = { ...o, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v != null && v !== '')) };
  if (JSON.stringify(next) !== JSON.stringify(o)) {
    data.orgs[uuid] = next;
    save();
  }
}

/** The organization signed in now (re-read when the config file changes), with its sign-in noted. */
export function currentOrg(now = Date.now()) {
  let st;
  try {
    st = fs.statSync(CONFIG);
  } catch {
    return seen.org;
  }
  if (st.mtimeMs !== seen.mtime || st.size !== seen.size) {
    seen = { mtime: st.mtimeMs, size: st.size, org: seen.org };
    try {
      const a = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).oauthAccount;
      if (a?.organizationUuid) {
        noteOrg(a.organizationUuid, { name: a.organizationName, email: a.emailAddress, seat: a.seatTier, tier: a.organizationRateLimitTier });
        seen.org = a.organizationUuid;
      }
    } catch {
      // being written by Claude Code: next time
    }
  }
  const last = data.since[data.since.length - 1];
  if (seen.org && last?.org !== seen.org) {
    // A switch is seen within seconds (this runs on every publish): from now. The first sign-in seen
    // goes back to the credentials file's last write: a sign-in writes it and every Claude Code
    // reloads it, so whatever ran after that ran under this organization (a token refresh writes it
    // too, every few hours: then it starts later than it could, never wrong).
    let at = now;
    if (!last)
      try {
        at = Math.min(now, fs.statSync(CREDENTIALS).mtimeMs);
      } catch {
        // no file (another credential store): from now
      }
    data.since.push({ at, org: seen.org });
    data.since = data.since.slice(-KEEP);
    save();
  }
  return seen.org;
}

/** The organization signed in at a time; null before the timeline starts. */
export function orgAt(ms) {
  if (!ms) return null;
  let org = null;
  for (const s of data.since) {
    if (s.at > ms) break;
    org = s.org;
  }
  return org;
}

export const orgInfo = (uuid) => (uuid && data.orgs[uuid] ? { id: uuid, ...data.orgs[uuid] } : null);
export const knownOrgs = () => Object.keys(data.orgs);

/** A terminal's organization: the one signed in now while it works, else when it last worked. */
export function orgOfUnit(u, now = Date.now()) {
  const cur = currentOrg(now);
  if (u.status === 'busy' || u.permission) return cur;
  return orgAt(u.lastActivity || u.statusSince) || null;
}

/** Usage text that means a quota ran out ("You've hit your 5-hour limit", "uses usage credits"…). */
export const LIMIT_RE = /hit your .*limit|usage limit|limit reached|rate_limit|out of (usage|credits|extra usage)|usage credits|spend limit|额度|利用枠|上限/i;
