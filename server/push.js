import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { L } from './i18n.js';

// Phone push through ntfy (https://ntfy.sh, free iOS / Android app): what needs you arrives as a
// system notification even when nobody watches a screen. Only "which project, what happened" is
// sent: no commands, code or Claude's replies, since the message passes through the ntfy server.
// The topic is a long random name, which is what keeps it private. Off by default.
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const FILE = path.join(DATA_DIR, 'push.json');
const READY_AFTER = 20_000; // a turn is "done" once idle this long (not the pauses between steps)
const OVERLOAD_EVERY = 3_600_000;

let settings = load();
let primed = false;
const told = new Set(); // quest keys already pushed (or already pending when we started)
const overloadAt = new Map(); // sessionId -> last OVERLOAD push

function load() {
  try {
    return { server: 'https://ntfy.sh', ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { enabled: false, server: 'https://ntfy.sh', topic: null };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
}

const newTopic = () => 'fleet-bridge-' + crypto.randomBytes(12).toString('hex');

export async function pushInfo() {
  const host = settings.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
  // the Android app subscribes from an ntfy:// link (https links do not open the app)
  const link = settings.topic ? `ntfy://${host}/${settings.topic}?display=Fleet+Bridge` : null;
  const qr = settings.enabled && link ? await QRCode.toString(link, { type: 'svg', margin: 1, color: { dark: '#04060c', light: '#ddf6ff' } }) : null;
  return { enabled: Boolean(settings.enabled), server: settings.server, topic: settings.topic, link, qr };
}

export async function setPush({ enabled, regenerate }) {
  if (regenerate || !settings.topic) settings.topic = newTopic();
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  save();
  primed = false; // what is pending right now is not news
  return pushInfo();
}

async function send({ title, message, priority = 3, tags = [], click }) {
  if (!settings.topic) return { ok: false, error: 'no topic' };
  try {
    const r = await fetch(settings.server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: settings.topic, title, message, priority, tags, ...(click ? { click } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function testPush(click) {
  return send({ title: L('舰桥 · 测试通知', 'Fleet Bridge · test', '舰橋 · テスト通知'), message: L('收到这条，手机推送就设置好了。', 'If you got this, phone push works.', 'これが届けばスマホ通知の設定は完了です。'), tags: ['white_check_mark'], click });
}

// short, content-free texts: the project and what it needs
function textOf(q) {
  const p = q.unit?.project || '';
  switch (q.kind) {
    case 'PERMIT':
      return { title: L(`${p} 等你授权`, `${p} needs your approval`, `${p} が承認待ち`), message: L('Claude 在等你确认一个操作，打开手机页处理。', 'Claude is waiting for you to confirm an action. Open the phone page.', 'Claude が操作の確認を待っています。スマホページで対応してください。'), priority: 5, tags: ['rotating_light'] };
    case 'READY':
      return { title: L(`${p} 做完了`, `${p} is done`, `${p} 完了`), message: L('等你下一步指令。', 'Waiting for your next order.', '次の指示を待っています。'), priority: 3, tags: ['white_check_mark'] };
    case 'OVERLOAD':
      return { title: L(`${p} 记忆负载过高`, `${p} context is high`, `${p} のコンテキストが逼迫`), message: L('建议 /compact 或开新会话。', 'Consider /compact or a new session.', '/compact か新しいセッションを推奨。'), priority: 3, tags: ['warning'] };
    case 'ALERT':
      return { title: L('额度告急', 'Quota running low', '利用枠が残りわずか'), message: q.title, priority: 4, tags: ['warning'] };
    default:
      return null;
  }
}

/** Called on every publish: push each new reminder once, with the same pacing as the desktop toasts. */
export function pushQuests(quests, click, now = Date.now()) {
  if (!settings.enabled || !settings.topic) return;
  const keys = new Set(quests.map((q) => q.key));
  for (const k of told) if (!keys.has(k)) told.delete(k);
  for (const q of quests) {
    if (told.has(q.key)) continue;
    const t = textOf(q);
    if (!t) continue;
    if (!primed) {
      told.add(q.key);
      continue;
    }
    if (q.kind === 'READY' && now - (q.since || now) < READY_AFTER) continue; // check again next publish
    told.add(q.key);
    if (q.kind === 'OVERLOAD') {
      const id = q.unit?.sessionId;
      if (now - (overloadAt.get(id) || 0) < OVERLOAD_EVERY) continue;
      overloadAt.set(id, now);
    }
    send({ ...t, click });
  }
  primed = true;
}
