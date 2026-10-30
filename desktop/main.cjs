// Electron shell: runs the monitor server in-process, shows the always-on-top status widget
// and opens the main screen (command center) on demand.
const { app, BrowserWindow, ipcMain, Notification, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WIDGET_WIDTH = 302; // the page's 300px card plus its border
const prefsFile = () => path.join(app.getPath('userData'), 'widget.json');
const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(require('node:os').homedir(), '.claude-ops');

// The Notification hook in ~/.claude/settings.json runs ~/.claude-ops/hook.js with plain Node,
// so keep a copy there that doesn't depend on where (or whether) this app is installed.
function installHookScript() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'hook.js'));
    const dest = path.join(DATA_DIR, 'hook.js');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(src)) fs.writeFileSync(dest, src);
  } catch (e) {
    console.error('could not install hook script', e);
  }
}

let baseUrl = 'http://127.0.0.1:8787';
let serverModule = null;
let widget = null;
let mainWin = null;
let muted = false;

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), JSON.stringify({ ...loadPrefs(), ...patch }));
}

async function startServer() {
  const server = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href);
  baseUrl = server.url;
  try {
    await server.start();
    serverModule = server;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e; // a standalone `npm start` is already serving: just use it
  }
}

// The widget is anchored by its bottom-right corner: it grows upward as units are added.
function defaultAnchor() {
  const { workArea } = screen.getPrimaryDisplay();
  return { right: workArea.x + workArea.width - 16, bottom: workArea.y + workArea.height - 16 };
}

// Keep the widget reachable if a saved spot is now off-screen (monitor unplugged, resolution change).
function onScreen(a) {
  return screen.getAllDisplays().some(({ workArea: w }) => a.right > w.x + 80 && a.right <= w.x + w.width + 40 && a.bottom > w.y + 60 && a.bottom <= w.y + w.height + 40);
}

function placeWidget(height) {
  if (!widget) return;
  const saved = loadPrefs();
  const a = saved.right != null && onScreen(saved) ? saved : defaultAnchor();
  widget.setBounds({ x: Math.round(a.right - WIDGET_WIDTH), y: Math.round(a.bottom - height), width: WIDGET_WIDTH, height: Math.round(height) });
}

function createWidget() {
  muted = Boolean(loadPrefs().muted);
  widget = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: 120,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  widget.setAlwaysOnTop(true, 'floating');
  placeWidget(120);
  widget.loadURL(`${baseUrl}/widget`);
  widget.webContents.on('did-finish-load', sendSettings);
  widget.once('ready-to-show', () => widget.showInactive());
  widget.on('moved', () => {
    const b = widget.getBounds();
    savePrefs({ right: b.x + b.width, bottom: b.y + b.height });
  });
  widget.on('closed', () => (widget = null));
}

// term: an agent id to open its terminal panel right away
function openMain(term) {
  const target = typeof term === 'string' && /^[0-9a-f-]{36}$/.test(term) ? `${baseUrl}/#term=${term}` : null;
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    // an open page only needs to be told; reloading would drop its open terminals
    if (target) mainWin.webContents.executeJavaScript(`window.opsOpenTerm && window.opsOpenTerm(${JSON.stringify(term)})`).catch(() => {});
    mainWin.show();
    mainWin.focus();
    return;
  }
  // Frameless and maximized to the desktop work area; the page draws its own window controls.
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#04060c',
    title: '舰桥 · Fleet Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  mainWin.maximize();
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.loadURL(target || baseUrl);
  // ⧉ pop-out terminals open as their own windows; web links (repo pages) go to the default browser
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${baseUrl}/term`))
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 720, autoHideMenuBar: true, backgroundColor: '#050a12' } };
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The widget would cover the command center: hide it while the command center is on screen.
  const showWidget = (on) => widget && (on ? widget.showInactive() : widget.hide());
  mainWin.on('show', () => showWidget(false));
  mainWin.on('restore', () => showWidget(false));
  mainWin.on('minimize', () => showWidget(true));
  mainWin.on('hide', () => showWidget(true));
  mainWin.on('closed', () => {
    mainWin = null;
    showWidget(true);
  });
}

// Run code in the command center page, opening it first if needed.
function runInMain(js) {
  openMain();
  const wc = mainWin.webContents;
  const go = () => wc.executeJavaScript(js).catch(() => {});
  wc.isLoading() ? wc.once('did-finish-load', go) : go();
}

// Agents launched from the command center are our child processes and end with the app
// (the roster is kept and restored on the next start). Confirm in the themed dialog of the page.
function confirmQuit() {
  const live = serverModule?.liveAgents() || [];
  if (!live.length) return app.quit();
  runInMain(`window.opsConfirmQuit && window.opsConfirmQuit(${JSON.stringify(live.map((a) => a.name || a.cwd))})`);
}

// What the widget's own (themed) menu shows.
function widgetSettings() {
  return { muted, packaged: app.isPackaged, autostart: app.isPackaged && app.getLoginItemSettings().openAtLogin };
}

function sendSettings() {
  widget?.webContents.send('ops:settings', widgetSettings());
}

const ACTIONS = {
  'open-main': () => openMain(),
  'toggle-mute': () => {
    muted = !muted;
    savePrefs({ muted });
  },
  'reset-pos': () => {
    savePrefs(defaultAnchor());
    placeWidget(widget.getBounds().height);
  },
  // only meaningful for the installed app; a dev run would register the bare electron.exe
  'toggle-autostart': () => app.isPackaged && app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin }),
  quit: () => confirmQuit(),
};

ipcMain.on('ops:height', (_e, h) => {
  const height = Math.max(40, Math.min(900, Number(h) || 0));
  if (widget && Math.abs(widget.getBounds().height - height) > 1) placeWidget(height);
});
ipcMain.on('ops:open-main', (_e, term) => openMain(term));
ipcMain.on('ops:win', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w === widget) return;
  if (action === 'minimize') w.minimize();
  else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === 'close') w.close();
});
ipcMain.on('ops:action', (_e, name) => {
  ACTIONS[name]?.();
  sendSettings();
});
ipcMain.on('ops:quit', () => app.quit()); // already confirmed in the page
ipcMain.on('ops:notify', (_e, title, body) => {
  if (muted || !Notification.isSupported()) return;
  // The command center already shows everything; a toast on top of it is just noise.
  if (mainWin && mainWin.isVisible() && !mainWin.isMinimized()) return;
  const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), silent: false });
  n.on('click', () => openMain());
  n.show();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // required for Windows toast notifications; kept from the pre-rename build (like appId and ~/.claude-ops)
  // so notification settings and upgrades carry over
  app.setAppUserModelId('claude-ops-monitor');
  app.on('second-instance', () => openMain());
  app.whenReady().then(async () => {
    installHookScript();
    await startServer();
    createWidget();
  });
  app.on('window-all-closed', (e) => e.preventDefault?.()); // the widget keeps the app alive; quit from its menu
  app.on('before-quit', () => serverModule?.shutdown()); // agents are our child processes
}
