// The taskbar icon goes blank when an old shortcut answers for the app. Windows gives a running window
// the icon (and name) of the Start-menu shortcut that carries the window's AppUserModelID. Earlier builds
// left a per-user "Fleet Bridge.lnk" with the same id (local.claude-ops.monitor) and no icon of its own.
// The installer removes it only from the Start menu it installs into: installed for all users
// (C:\Program Files, the shortcut in ProgramData), the per-user one stays. After the installer replaced
// the exe, the taskbar took that leftover (its button reads "Fleet Bridge", not "Fleet Bridge 舰桥") and
// showed a blank page for its icon.
//
// The installed server removes such leftovers, only while the installer's own shortcut is there, and
// asks Windows to refresh its icons. The window takes the right icon the next time it opens.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const CURRENT = 'Fleet Bridge 舰桥.lnk';
// names earlier builds used; never the current one
export const STALE = ['Fleet Bridge.lnk', 'CLAUDE OPS.lnk'];

const startMenu = (base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

/**
 * The leftover shortcuts to remove, from the user's and the all-users Start menu (where Windows looks
 * for the window's id; a desktop shortcut may be the user's own), only while the installer's current
 * shortcut is in one of them.
 */
export function staleShortcuts({ appData, programData, exists = fs.existsSync }) {
  const menus = [appData, programData].filter(Boolean).map(startMenu);
  if (!menus.some((m) => exists(path.join(m, CURRENT)))) return [];
  const out = [];
  for (const dir of menus) for (const name of STALE) if (exists(path.join(dir, name))) out.push(path.join(dir, name));
  return out;
}

/** Removes the leftovers (Windows, installed app only). Returns the removed paths. */
export function cleanShortcuts({ env = process.env, platform = process.platform, refresh = refreshIcons, log = console.log } = {}) {
  if (platform !== 'win32' || env.FLEET_VARIANT !== 'installer') return [];
  const found = staleShortcuts({ appData: env.APPDATA, programData: env.ProgramData || env.PROGRAMDATA });
  const removed = [];
  for (const f of found) {
    try {
      fs.unlinkSync(f);
      removed.push(f);
    } catch (e) {
      log(`old shortcut ${f} not removed: ${e.code || e.message}`); // all-users ones need admin rights
    }
  }
  if (removed.length) {
    log(`removed old shortcuts that took the taskbar icon: ${removed.join(', ')}`);
    refresh();
  }
  return removed;
}

// Windows' own "refresh the icons" (what a reinstall of the shell does)
export function refreshIcons() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe');
  execFile(exe, ['-show'], { windowsHide: true }, () => {});
}
