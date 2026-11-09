import fs from 'node:fs';
import path from 'node:path';
import { config, contextWindowFor } from '../config.js';
import { readNotifications } from './notifications.js';
import { readTranscript } from './transcript.js';

const PERMIT_TIMEOUT = 30 * 60_000;

// A permission prompt is still open until the transcript moves on (approve or deny both
// append a tool result), the session goes idle, or it is too old to trust.
function pendingPermission(n, t, status) {
  if (!n) return null;
  if (status === 'idle' || Date.now() - n.at > PERMIT_TIMEOUT) return null;
  if (t.lastEntryAt && t.lastEntryAt > n.at) return null;
  return { at: n.at, message: n.message };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Claude Code stores a project's transcripts under its cwd with every non-alphanumeric char turned into '-'.
export function projectKey(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Subagent meta files, by path. A finished subagent's meta no longer changes, so it is read once;
// re-reading every meta file of a long session on each 3 s tick held up the server's thread.
const metaCache = new Map();

function agentsOf(projectDir, sessionId) {
  const dir = path.join(projectDir, sessionId, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const file = path.join(dir, f);
      const hit = metaCache.get(file);
      if (hit && !hit.running) return hit;
      const m = readJson(file);
      if (!m) return null;
      let updatedAt = 0;
      try {
        updatedAt = fs.statSync(file).mtimeMs;
      } catch {
        // removed meanwhile
      }
      const a = { id: f.replace('.meta.json', ''), type: m.agentType || 'agent', description: m.description || '', running: !m.finished, updatedAt };
      metaCache.set(file, a);
      return a;
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function collectSessions() {
  const dir = path.join(config.claudeDir, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const notes = readNotifications();
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(dir, f));
    if (!s?.sessionId || !s.cwd || !isAlive(s.pid)) continue;
    const projectDir = path.join(config.claudeDir, 'projects', projectKey(s.cwd));
    const t = readTranscript(path.join(projectDir, `${s.sessionId}.jsonl`)) || {};
    const window = t.contextTokens != null ? contextWindowFor(t.model, t.contextTokens) : null;
    const status = s.status === 'busy' ? 'busy' : 'idle';
    out.push({
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      project: path.basename(s.cwd),
      name: s.name || t.title || s.sessionId.slice(0, 8),
      status,
      statusSince: s.statusUpdatedAt || s.updatedAt || s.startedAt,
      permission: pendingPermission(notes.get(s.sessionId), t, status),
      startedAt: s.startedAt,
      version: s.version,
      model: t.model || null,
      contextTokens: t.contextTokens ?? null,
      contextWindow: window,
      contextPct: window ? Math.round((t.contextTokens / window) * 1000) / 10 : null,
      lastText: t.lastText || null,
      lastPrompt: t.lastPrompt || null,
      lastActivity: t.lastActivity ? Date.parse(t.lastActivity) : null,
      limit: t.limit || null,
      apiError: t.apiError || null,
      agents: agentsOf(projectDir, s.sessionId),
      edits: t.edits || new Map(),
    });
  }
  return out.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt);
}
