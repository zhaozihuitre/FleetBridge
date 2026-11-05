// What differs between the ways Fleet Bridge is installed, and between operating systems. Used by the
// shell (desktop/main.cjs) and by the npm command (bin/fleet-bridge.cjs), which runs without Electron:
// nothing here requires it (Electron's shell module is passed in where needed).
//
// Variants:
//   installer  the packaged app (Windows NSIS installer)
//   npm        `npm i -g` from the repository; the shell is the electron package's binary
//   dev        a run from a checkout (its own data folder and port, see server/config.js)
//   headless   `fleet-bridge --headless`: the server alone under Node, used from a browser
//
// Only Windows is done and tested. A Mac (or Linux) npm install starts, but the parts marked "todo"
// below do nothing there yet.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIN = process.platform === 'win32';
const NPM_APP_ID = 'local.claude-ops.monitor.npm';
const NPM_LOGIN_NAME = 'FleetBridgeNpm';

/** A shell folder inside node_modules/fleet-bridge (a global npm install) is the npm variant. */
function isNpmDir(shellDir) {
  return /[\\/]node_modules[\\/]fleet-bridge[\\/]?$/i.test(path.resolve(shellDir));
}

function variantOf({ packaged, shellDir, env = process.env }) {
  if (packaged) return 'installer';
  if (env.FLEET_INSTALL === 'npm' || isNpmDir(shellDir)) return 'npm';
  return 'dev';
}

/** The folder under the data folder that holds this variant's version folders. */
const appBase = (variant) => (variant === 'npm' ? 'app-npm' : 'app');

/** Start-menu shortcut of the npm install (Windows takes a toast's sender from a shortcut with the app's id). */
function npmShortcutPath() {
  if (!WIN) return null; // todo(mac): notifications come from the app bundle; nothing to write
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Fleet Bridge (npm).lnk');
}

/** Writes (or refreshes) that shortcut: electron.exe "<shell folder>", with the app id. */
function ensureNpmShortcut(electronShell, shellDir) {
  const file = npmShortcutPath();
  if (!file) return false;
  const want = { target: process.execPath, args: `"${shellDir}"`, appUserModelId: NPM_APP_ID, description: 'Fleet Bridge', cwd: shellDir };
  try {
    const have = fs.existsSync(file) ? electronShell.readShortcutLink(file) : null;
    if (have && have.target === want.target && have.args === want.args && have.appUserModelId === want.appUserModelId) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return electronShell.writeShortcutLink(file, have ? 'replace' : 'create', want);
  } catch {
    return false;
  }
}

function removeNpmShortcut() {
  const file = npmShortcutPath();
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Start with the system: the npm shell is electron.exe, so it has to be told which folder to run. */
function loginItem(variant, shellDir) {
  if (variant !== 'npm') return {};
  // todo(mac): openAtLogin with these args registers the bare Electron.app; a LaunchAgent would be needed
  return { path: process.execPath, args: [shellDir], name: NPM_LOGIN_NAME };
}

/** Removes the npm install's autostart entry without Electron (before `npm uninstall -g`). */
function removeNpmLoginItem() {
  if (!WIN) return false;
  try {
    require('node:child_process').execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', NPM_LOGIN_NAME, '/f'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false; // there was none
  }
}

/** Opens a URL in the default browser (the headless server's "open the command center"). */
function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const [cmd, args] = WIN ? ['cmd.exe', ['/c', 'start', '""', url.replace(/[&^|<>]/g, '^$&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // no browser to open: the URL is printed anyway
  }
}

module.exports = { WIN, NPM_APP_ID, variantOf, appBase, ensureNpmShortcut, removeNpmShortcut, npmShortcutPath, loginItem, removeNpmLoginItem, openBrowser };
