import path from 'node:path';
import { config, contextWindowFor } from './config.js';
import { projectKey } from './collectors/sessions.js';
import { readTranscript } from './collectors/transcript.js';

// Projects with nothing running still get a unit card: their latest session, newest first,
// after the live units. Temp folders (scratch / tool runs under AppData) and the home folder
// are not projects.
const NOT_PROJECT = /[\\/]AppData[\\/]|^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i;
const MAX = 16;

/** The latest session of each project folder with no running session (history is newest-first). */
export function offlineSessions(history, runningCwds) {
  const seen = new Set(runningCwds.map((c) => c.toLowerCase()));
  const out = [];
  for (const h of history) {
    const key = h.cwd.toLowerCase();
    if (seen.has(key) || NOT_PROJECT.test(h.cwd)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= MAX) break;
  }
  return out;
}

/** Unit-shaped cards for those sessions; the transcript is read incrementally like a live one. */
export function buildOffline(sessions, gitByCwd) {
  return sessions.map((h) => {
    const t = readTranscript(path.join(config.claudeDir, 'projects', projectKey(h.cwd), `${h.sessionId}.jsonl`)) || {};
    const window = t.contextTokens != null ? contextWindowFor(t.model, t.contextTokens) : null;
    return {
      key: `offline:${h.sessionId}`,
      offline: true,
      pid: null,
      sessionId: h.sessionId,
      project: h.project,
      cwd: h.cwd,
      name: h.title || t.title || h.sessionId.slice(0, 8),
      status: 'offline',
      statusSince: h.updatedAt,
      permission: null,
      model: t.model || null,
      contextTokens: t.contextTokens ?? null,
      contextWindow: window,
      contextPct: window ? Math.round((t.contextTokens / window) * 1000) / 10 : null,
      lastText: t.lastText || null,
      lastPrompt: h.lastPrompt || t.lastPrompt || null,
      agents: [],
      repos: (gitByCwd[h.cwd] || []).map((r) => ({ ...r, claudeTouchedAt: null })),
      gitScanned: h.cwd in gitByCwd,
    };
  });
}
