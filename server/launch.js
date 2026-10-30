import { spawn } from 'node:child_process';

// Opens `claude --resume <id>` in a new terminal at the session's folder.
// Windows Terminal when present, otherwise a plain console window.
export function resumeSession(cwd, sessionId) {
  return new Promise((resolve) => {
    const opts = { detached: true, stdio: 'ignore', windowsHide: false };
    const fallback = () => {
      const p = spawn('cmd.exe', ['/c', 'start', '""', '/D', cwd, 'cmd', '/k', 'claude', '--resume', sessionId], opts);
      p.on('error', () => resolve({ ok: false, error: 'spawn_failed' }));
      p.on('spawn', () => {
        p.unref();
        resolve({ ok: true, terminal: 'cmd' });
      });
    };
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'unsupported_platform' });
    const wt = spawn('wt.exe', ['-d', cwd, 'claude', '--resume', sessionId], opts);
    wt.on('error', fallback);
    wt.on('spawn', () => {
      wt.unref();
      resolve({ ok: true, terminal: 'Windows Terminal' });
    });
  });
}
