#!/usr/bin/env node
// The npm install's command (`npm i -g <repository>`, then `fleet-bridge`).
//
//   fleet-bridge              start the app (the widget, the command center, the tray) in the background
//   fleet-bridge --headless   only the server, in this console; use it from a browser (Ctrl+C ends it)
//   fleet-bridge stop         quit the running app (its terminals end, as with Quit in the widget)
//   fleet-bridge status       what runs: install, version, terminals
//   fleet-bridge cleanup      stop, and remove the Start-menu shortcut and autostart (before uninstalling)
//   fleet-bridge --version
//
// One Fleet Bridge runs at a time per data folder (~/.claude-ops): the installer's app and this one
// share it, so each refuses to start while the other is running.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const platform = require('../desktop/platform.cjs');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PORT = Number(process.env.MONITOR_PORT) || 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const NAME = { installer: '安装包版', app: '安装包版', npm: 'npm 版', headless: '无界面版（--headless）', dev: '开发版' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function summary() {
  try {
    const r = await fetch(`${BASE}/api/admin/summary`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// a terminal of the bridge itself, or a dev run, must not pass its own mode on to the app it starts
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'FLEET_SHELL_API', 'FLEET_DEV', 'FLEET_VARIANT', 'FLEET_APPDIR']) delete env[k];
  return { ...env, ...extra };
}

function electronPath() {
  try {
    const p = require('electron'); // the electron package exports its binary's path
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    // not installed (it is an optional dependency: its download may have failed)
  }
  return null;
}

async function start() {
  const s = await summary();
  if (s) {
    if (s.variant === 'npm') {
      // already running: a second start brings up the command center (the single-instance handoff)
      const exe = electronPath();
      if (exe) spawn(exe, [ROOT], { detached: true, stdio: 'ignore', env: cleanEnv({ FLEET_INSTALL: 'npm' }) }).unref();
      console.log(`舰桥已经在运行（${BASE}），已打开指挥中心。`);
      return;
    }
    console.error(`✖ 舰桥（${NAME[s.variant] || NAME.installer}）已经在运行（${BASE}）。同一时间只能运行一个，先退出它再启动 npm 版。`);
    process.exit(1);
  }
  const exe = electronPath();
  if (!exe) {
    console.error('✖ 没有找到 Electron（安装时下载失败？）。重新安装：npm i -g <仓库地址>，或只用服务端：fleet-bridge --headless');
    process.exit(1);
  }
  spawn(exe, [ROOT], { detached: true, stdio: 'ignore', env: cleanEnv({ FLEET_INSTALL: 'npm' }), windowsHide: false }).unref();
  process.stdout.write('启动中');
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const now = await summary();
    if (now?.started) return console.log(`\n✔ 舰桥 ${pkg.version} 已启动：右下角的小窗，或 ${BASE}`);
    if (now && now.variant !== 'npm') return console.log(`\n✖ 另一个舰桥（${NAME[now.variant] || NAME.installer}）在运行，npm 版没有启动`);
    process.stdout.write('.');
  }
  console.log(`\n还没有响应。日志：~/.claude-ops/server.log`);
}

async function headless() {
  const s = await summary();
  if (s) {
    console.error(`✖ 舰桥（${NAME[s.variant] || NAME.installer}）已经在运行（${BASE}），直接用它即可。`);
    process.exit(1);
  }
  Object.assign(process.env, cleanEnv({ FLEET_VARIANT: 'headless' }));
  for (const k of ['ELECTRON_RUN_AS_NODE', 'FLEET_SHELL_API', 'FLEET_DEV', 'FLEET_APPDIR']) delete process.env[k];
  const server = await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
  const { DATA_DIR } = await import(pathToFileURL(path.join(ROOT, 'server', 'config.js')).href);
  // the Notification hook in ~/.claude/settings.json runs <data>/hook.js (as the desktop shell keeps it)
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server', 'hook.js'), path.join(DATA_DIR, 'hook.js'));
  } catch {
    // the hook keeps its old copy
  }
  server.setUiOpener(() => platform.openBrowser(server.url));
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    console.log('\n结束中（终端会一起结束）…');
    await server.shutdown().catch(() => {});
    process.exit(0);
  };
  server.setQuitHandler(end);
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
  await server.start();
  console.log(`✔ 舰桥 ${pkg.version}（无界面）：${server.url}　Ctrl+C 结束`);
  if (!process.argv.includes('--no-open')) platform.openBrowser(server.url);
}

async function stop({ quiet } = {}) {
  const s = await summary();
  if (!s) return quiet || console.log('舰桥没有在运行。');
  // only the npm install and the headless server: the installer's app is quit from its widget
  if (s.variant !== 'npm' && s.variant !== 'headless') {
    console.error(`✖ 正在运行的是${NAME[s.variant] || NAME.installer}（${s.version}），请在它的小窗菜单里退出。`);
    process.exit(1);
  }
  const r = await fetch(`${BASE}/api/admin/quit`, { method: 'POST' }).catch(() => null);
  if (!r?.ok) {
    console.error(`✖ 这个舰桥（${NAME[s.variant] || NAME.installer} ${s.version}）不支持从命令行退出，请在小窗菜单里退出。`);
    process.exit(1);
  }
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (!(await summary())) return console.log(`✔ 已退出（${NAME[s.variant] || NAME.installer}，结束了 ${s.liveIds?.length || 0} 个终端）`);
  }
  console.error('✖ 30 秒内没有退出');
  process.exit(1);
}

async function status() {
  const s = await summary();
  if (!s) return console.log(`舰桥没有在运行（${BASE}）。已安装的 npm 版：${pkg.version}`);
  console.log(`运行中：${NAME[s.variant] || NAME.installer} ${s.version}（${BASE}）\n终端：${s.live.length ? s.live.join('、') : '无'}\n已安装的 npm 版：${pkg.version}`);
}

async function cleanup() {
  const s = await summary();
  if (s?.variant === 'npm' || s?.variant === 'headless') await stop({ quiet: true });
  const a = platform.removeNpmShortcut();
  const b = platform.removeNpmLoginItem();
  console.log(`✔ 已清理：开始菜单快捷方式${a ? '' : '（没有）'}、开机启动${b ? '' : '（没有）'}。现在可以 npm uninstall -g fleet-bridge`);
}

const cmd = process.argv.slice(2).find((a) => !a.startsWith('--no-')) || '';
const run = { '': start, start, '--headless': headless, headless, stop, status, cleanup };
if (cmd === '--version' || cmd === '-v') console.log(pkg.version);
else if (run[cmd]) run[cmd]().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n'));
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1);
}
