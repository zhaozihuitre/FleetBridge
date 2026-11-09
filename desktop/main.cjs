// Electron shell: runs the monitor server as a child process from the current app folder (an update
// replaces that folder's version and restarts only the server; the terminals live in the PTY host and
// keep running), shows the always-on-top status widget and opens the command center on demand.
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } = require('electron');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appdir = require('./appdir.cjs');
const platform = require('./platform.cjs');
const { warmVoice, startVoice, stopVoice } = require('./voice.cjs');
const { startAwake, setAwake, nextMode, awakeInfo, stopAwake } = require('./awake.cjs');

// installer / npm (`npm i -g` from the repository) / dev (a checkout): see platform.cjs.
// A development run is kept apart from the installed app: its own data folder and port
// (server/config.js) and agents named dev·…; it shows no toasts unless MONITOR_DEV_NOTIFY=1, so a
// test session or the demo's made-up projects never pop up over the user's work.
const SHELL_DIR = path.join(__dirname, '..');
const VARIANT = platform.variantOf({ packaged: app.isPackaged, shellDir: SHELL_DIR });
const INSTALLED = VARIANT !== 'dev'; // the installer's app or the npm one: the real thing
if (!INSTALLED && !process.env.FLEET_DEV) process.env.FLEET_DEV = '1';
if (INSTALLED) delete process.env.FLEET_DEV; // inherited from a dev run's terminal: not this one

// window / taskbar icon, independent of any shortcut (Windows: the .ico carries a drawing made for 16-32 px)
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const WIDGET_WIDTH = 302; // the page's 300px card plus its border
const prefsFile = () => path.join(app.getPath('userData'), 'widget.json');
// as server/config.js: a dev run has its own data folder
const DEV = process.env.FLEET_DEV === '1' || Boolean(process.env.MONITOR_DEMO);
const PROD_DIR = path.join(os.homedir(), '.claude-ops');
const givenDir = process.env.MONITOR_DATA_DIR;
// (never the installed app's folder for a dev run, even if inherited from one of its agents)
const DATA_DIR = DEV && givenDir && path.resolve(givenDir).toLowerCase() === path.resolve(PROD_DIR).toLowerCase() ? path.join(os.homedir(), '.claude-ops-dev') : givenDir || (DEV ? path.join(os.homedir(), '.claude-ops-dev') : PROD_DIR);
process.env.MONITOR_DATA_DIR = DATA_DIR; // the server child, its PTY host and their agents use the same
// The installed app always runs from an app folder; a dev run from the checkout, unless FLEET_APPDIR=1
// (to try the update mechanism there).
const USE_APPDIR = INSTALLED || process.env.FLEET_APPDIR === '1';

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

let baseUrl = null; // this instance's own server (set below from PORT, then from the server itself)
let serverChild = null;
let summary = { live: [], busy: false }; // the server's last /api/admin/summary (keep-awake, quit)
let quitting = false;
// Windows is shutting down or signing out: it kills the server (and soon us). A server that dies then, or a
// restart that dies before it is ready, says nothing about the version: it used to be set aside as "failed to
// start", and the next start came back on the previous version.
let endingSession = false;
let widget = null;
let mainWin = null;
let muted = false;
let tray = null;
let widgetTucked = false; // minimized to the tray by the user: stays hidden until the tray brings it back

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

const apps = USE_APPDIR ? appdir.create(DATA_DIR, SHELL_DIR, platform.appBase(VARIANT)) : null;
const PORT = Number(process.env.MONITOR_PORT) || (DEV ? 8790 : 8787); // as server/config.js
// never the installed app's server by default: a dev run whose server failed to start used to load
// the installed app's widget (8787) and act on it
baseUrl = `http://127.0.0.1:${PORT}`;
let restarts = []; // times of unexpected server exits (a crash loop falls back to the previous version)

/** Starts the server child from a folder; resolves with its URL once it is ready. */
function spawnServer(dir) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(dir, 'server', 'run.mjs'), [], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FLEET_SHELL_API: String(appdir.SHELL_API), FLEET_VARIANT: VARIANT },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], // the server writes <data>/server.log itself
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the server did not start in 60 s'));
    }, 60_000);
    child.on('message', (m) => {
      if (m?.type === 'ready') {
        clearTimeout(timer);
        resolve({ child, url: m.url, version: m.version });
      } else if (m?.type === 'failed') {
        clearTimeout(timer);
        reject(new Error(m.error));
      } else if (m?.type === 'openMain') openMain();
      else if (m?.type === 'reload') reloadServer('update');
      else if (m?.type === 'rollback') reloadServer('rollback');
      else if (m?.type === 'quit') app.quit(); // `fleet-bridge stop` (the server already asked nobody: it's the user's command)
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (${code})`));
      if (serverChild === child) onServerLost(code);
    });
  });
}

/** The current version's server, falling back to the previous version if it won't start. */
async function startServer() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = apps ? apps.resolve(app.getVersion()) : { version: 'checkout', dir: SHELL_DIR };
    try {
      const s = await spawnServer(cur.dir);
      serverChild = s.child;
      baseUrl = s.url;
      console.log(`server ${s.version || cur.version} from ${cur.dir}`);
      return s;
    } catch (e) {
      console.error(`server ${cur.version} failed: ${e.message}`);
      if (/EADDRINUSE/.test(e.message)) return null; // a standalone `npm start` already serves: use it
      if (quitting || endingSession) throw e; // the system is taking us down: not the version's fault
      // a version is set aside only when it fails twice in a row (one failure can be the moment, not the code)
      if (attempt === 0 && !/did not start in/.test(e.message)) {
        await new Promise((r) => setTimeout(r, 3000));
        if (quitting || endingSession) throw e;
        continue;
      }
      if (!apps?.rollback(e.message)) throw e;
    }
  }
  throw new Error('no version of the server would start');
}

// The running server crashed: start it again (the terminals are still in the PTY host); crashing
// again and again right after an update means that version is bad: back to the previous one.
async function onServerLost(code) {
  serverChild = null;
  if (quitting || endingSession) return;
  const now = Date.now();
  restarts = [...restarts.filter((t) => now - t < 120_000), now];
  if (restarts.length >= 3 && apps?.rollback(`crashed ${restarts.length} times (${code})`)) restarts = [];
  try {
    await startServer();
    reloadWindows();
  } catch (e) {
    // never give up for good (that left a black window): try again in a while
    console.error('server could not be restarted, retrying in 15 s:', e.message);
    setTimeout(() => !serverChild && !quitting && onServerLost('retry'), 15_000);
  }
}

/** Swaps the server for the version current.json now names (an update) or the previous (rollback). */
// Requests arriving while a swap is under way wait for it (one at a time, none dropped).
let swaps = Promise.resolve();
function reloadServer(kind) {
  if (!apps) return;
  swaps = swaps.then(() => swapServer(kind)).catch((e) => console.error('swap failed', e.message));
}
async function swapServer(kind) {
  {
    if (kind === 'rollback') apps.rollback('rolled back by request');
    const old = serverChild;
    serverChild = null; // its exit is expected now
    if (old) {
      await new Promise((resolve) => {
        const t = setTimeout(() => (old.kill(), resolve()), 5000);
        old.once('exit', () => (clearTimeout(t), resolve()));
        old.send({ type: 'detach' });
      });
    }
    await startServer(); // falls back to the previous version by itself if the new one won't start
    reloadWindows();
  }
}

/** The pages come from the server: after a swap they reload (the command center reopens its panes). */
function reloadWindows() {
  for (const w of BrowserWindow.getAllWindows()) {
    const url = w.webContents.getURL();
    if (url.startsWith('http://127.0.0.1')) w.webContents.reloadIgnoringCache();
  }
}

// What the shell asks of the server now and then (keep-awake, quit confirmation).
async function refreshSummary() {
  try {
    summary = await (await fetch(`${baseUrl}/api/admin/summary`)).json();
  } catch {
    // the server is restarting
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
  widget.once('ready-to-show', () => !widgetTucked && widget.showInactive());
  widget.on('moved', () => {
    const b = widget.getBounds();
    savePrefs({ right: b.x + b.width, bottom: b.y + b.height });
  });
  widget.on('closed', () => (widget = null));
}

// term: an agent id to open its terminal panel right away
function openMain(term) {
  warmVoice(); // the voice button's helper, ready before the first click
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
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  mainWin.maximize();
  for (const ev of ['enter-full-screen', 'leave-full-screen'])
    mainWin.on(ev, () => mainWin?.webContents.executeJavaScript(`document.body.classList.toggle('fullscreen', ${ev === 'enter-full-screen'})`).catch(() => {}));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.loadURL(target || baseUrl);
  // ⧉ pop-out terminals open as their own windows; web links (repo pages) go to the default browser
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${baseUrl}/term`))
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 720, icon: ICON, autoHideMenuBar: true, backgroundColor: '#050a12' } };
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The widget would cover the command center: hide it while the command center is on screen.
  const showWidget = (on) => widget && (on && !widgetTucked ? widget.showInactive() : widget.hide());
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
// (they don't come back on the next start; any can be continued from the archive). Confirm in the themed dialog of the page.
async function confirmQuit() {
  await refreshSummary();
  const live = summary.live || [];
  if (!live.length) return app.quit();
  runInMain(`window.opsConfirmQuit && window.opsConfirmQuit(${JSON.stringify(live)})`);
}

// What the widget's own (themed) menu shows.
function widgetSettings() {
  return { muted, packaged: INSTALLED, autostart: INSTALLED && app.getLoginItemSettings(platform.loginItem(VARIANT, SHELL_DIR)).openAtLogin, ...awakeInfo() };
}

function sendSettings() {
  widget?.webContents.send('ops:settings', widgetSettings());
}

// The tray icon: brings a minimized widget back (click), or opens the command center / quits.
function setWidgetTucked(on) {
  widgetTucked = on;
  savePrefs({ tucked: on });
  if (!widget) return;
  const mainOnScreen = mainWin && mainWin.isVisible() && !mainWin.isMinimized();
  if (on || mainOnScreen) widget.hide();
  else widget.showInactive();
}

// The tray icon follows the fleet (the widget tells it): still when idle, the two escorts lighting in turn while
// any terminal works, the main ship blinking amber while one waits on you; under "reduce motion" one still frame
// per state. Frames in desktop/tray (16 px, @2x 32 px).
const TRAY_FRAMES = { idle: ['idle'], busy: ['busy-0', 'busy-1', 'busy-2', 'busy-3'], wait: ['wait-0', 'wait-1'] };
const TRAY_STEP = { busy: 350, wait: 600 };
const trayImages = {};
const trayImage = (name) => (trayImages[name] ||= nativeImage.createFromPath(path.join(__dirname, 'tray', name + '.png')));
let trayAnim = null;
let trayKey = 'idle';
function setTrayState(state, still) {
  const frames = TRAY_FRAMES[state] || TRAY_FRAMES.idle;
  const key = state + (still ? ':still' : '');
  if (!tray || key === trayKey) return;
  trayKey = key;
  clearInterval(trayAnim);
  trayAnim = null;
  const imgs = frames.map(trayImage);
  if (imgs.some((i) => i.isEmpty())) return tray.setImage(ICON);
  tray.setImage(imgs[0]);
  if (still || imgs.length < 2) return;
  let i = 0;
  trayAnim = setInterval(() => tray?.setImage(imgs[(i = (i + 1) % imgs.length)]), TRAY_STEP[state] || 500);
}

function createTray() {
  const idle = trayImage('idle');
  tray = new Tray(idle.isEmpty() ? ICON : idle);
  tray.setToolTip('舰桥 · Fleet Bridge');
  tray.on('click', () => setWidgetTucked(!widgetTucked));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏小窗', click: () => setWidgetTucked(!widgetTucked) },
      { label: '打开指挥中心', click: () => openMain() },
      { type: 'separator' },
      { label: '退出', click: () => confirmQuit() },
    ]),
  );
}

const ACTIONS = {
  'open-main': () => openMain(),
  'tuck-widget': () => setWidgetTucked(true),
  voice: () => startVoice(),
  'cycle-awake': () => {
    const mode = nextMode();
    setAwake({ mode });
    savePrefs({ awakeMode: mode });
  },
  'toggle-awake-screen': () => {
    const screen = !awakeInfo().awakeScreen;
    setAwake({ screen });
    savePrefs({ awakeScreen: screen });
  },
  'toggle-mute': () => {
    muted = !muted;
    savePrefs({ muted });
  },
  'reset-pos': () => {
    savePrefs(defaultAnchor());
    placeWidget(widget.getBounds().height);
  },
  // only meaningful for the installed app; a dev run would register the bare electron.exe
  'toggle-autostart': () => {
    if (!INSTALLED) return;
    const item = platform.loginItem(VARIANT, SHELL_DIR); // the npm shell is electron.exe: it needs the folder to run
    app.setLoginItemSettings({ ...item, openAtLogin: !app.getLoginItemSettings(item).openAtLogin });
  },
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
  // true fullscreen (over the taskbar); the page is told so it can swap the button icon
  else if (action === 'fullscreen') w.setFullScreen(!w.isFullScreen());
});
ipcMain.on('ops:action', (_e, name) => {
  ACTIONS[name]?.();
  sendSettings();
});
ipcMain.on('ops:quit', () => app.quit()); // already confirmed in the page
ipcMain.on('ops:tray', (_e, state, still) => setTrayState(String(state), Boolean(still)));
ipcMain.on('ops:notify', (_e, title, body, tag) => {
  if (muted || !Notification.isSupported()) return;
  if (!INSTALLED && process.env.MONITOR_DEV_NOTIFY !== '1') {
    console.log(`notify (dev, not shown): ${String(title).slice(0, 40)}`);
    return;
  }
  // Someone is looking at the bridge (one of our windows has the focus): its own marks are enough,
  // a toast and its sound would only interrupt. In the background, minimized or unfocused: notify.
  // (the command center or a popped-out terminal; the small widget having focus doesn't count)
  const focused = BrowserWindow.getFocusedWindow();
  const looking = Boolean(focused && focused !== widget && focused.isVisible() && !focused.isMinimized());
  if (!INSTALLED) console.log(`notify ${looking ? 'suppressed' : 'shown'} (focused: ${focused === mainWin ? 'command center' : focused === widget ? 'widget' : focused ? 'other' : 'none'}${focused?.isMinimized() ? ', minimized' : ''}): ${String(title).slice(0, 40)}`);
  if (looking) return;
  const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), silent: false });
  // clicked: the widget goes to that terminal (opens ours in the command center, brings an outside one forward)
  n.on('click', () => {
    if (tag && widget && !widget.isDestroyed()) widget.webContents.send('ops:notify-click', tag);
    else openMain();
  });
  n.show();
});

// The dev build gets its own profile, so it can run beside the installed app (the single-instance
// lock is per profile) instead of quitting and raising the installed one. The npm install has its own
// too; it must not run beside the installer's app (one data folder, one port): see otherRunning().
if (VARIANT === 'dev') app.setPath('userData', path.join(app.getPath('appData'), 'fleet-bridge-dev'));
else if (VARIANT === 'npm') app.setPath('userData', path.join(app.getPath('appData'), 'fleet-bridge-npm'));

const VARIANT_NAME = { installer: '安装包版', npm: 'npm 版', headless: '无界面（--headless）', dev: '开发版', app: '安装包版' };

/** Another Fleet Bridge (the other install, or a headless one) already serves this data folder's port. */
async function otherRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/summary`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows takes the taskbar icon and toast sender from the Start-menu shortcut with this same id.
  // It must equal the build appId, which the installer writes onto its shortcut: the old
  // 'claude-ops-monitor' matched only a stale CLAUDE OPS shortcut whose exe is gone (blank icon).
  app.setAppUserModelId(VARIANT === 'installer' ? 'local.claude-ops.monitor' : VARIANT === 'npm' ? platform.NPM_APP_ID : 'local.claude-ops.monitor.dev');
  app.on('second-instance', () => openMain());
  app.whenReady().then(async () => {
    // one Fleet Bridge per data folder: the other install (or a headless one) is running already
    const other = INSTALLED && (await otherRunning());
    if (other) {
      const who = VARIANT_NAME[other.variant] || VARIANT_NAME.installer;
      dialog.showMessageBoxSync({ type: 'warning', title: 'Fleet Bridge', message: `舰桥（${who}）已经在运行`, detail: `同一时间只能运行一个舰桥（它们共用 ${DATA_DIR} 和端口 ${PORT}）。先退出正在运行的那个，再启动这个。` });
      app.exit(0);
      return;
    }
    if (VARIANT === 'npm') platform.ensureNpmShortcut(shell, SHELL_DIR); // Windows shows our toasts only with it
    installHookScript();
    try {
      await startServer();
    } catch (e) {
      console.error('server did not start, retrying in 15 s:', e.message);
      setTimeout(() => !serverChild && !quitting && onServerLost('retry'), 15_000);
    }
    refreshSummary();
    setInterval(refreshSummary, 10_000);
    widgetTucked = Boolean(loadPrefs().tucked);
    createWidget();
    createTray();
    const p = loadPrefs();
    startAwake({ mode: p.awakeMode, screen: p.awakeScreen, busy: () => summary.busy, changed: sendSettings });
  });
  app.on('window-all-closed', (e) => e.preventDefault?.()); // the widget keeps the app alive; quit from its menu
  // the system going down (shutdown, restart, sign-out): don't restart the server, don't judge its version
  const sessionEnds = () => (endingSession = true);
  app.on('session-end', sessionEnds);
  powerMonitor.on('shutdown', sessionEnds);
  // Quitting ends the terminals too (the server tells the PTY host); they are not brought
  // back next start. Waits for that (a few seconds at most) before the app goes.
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    stopVoice();
    stopAwake();
    const child = serverChild;
    if (!child) return;
    e.preventDefault();
    const done = () => app.quit();
    const t = setTimeout(done, 5000);
    child.once('exit', () => (clearTimeout(t), done()));
    child.send({ type: 'shutdown' });
  });
}
