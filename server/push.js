import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { L } from './i18n.js';
import { pushText } from './notices.js';

// Phone push through ntfy (https://ntfy.sh, free iOS / Android app): what needs you arrives as a
// system notification even when nobody watches a screen. By default "which terminal, what
// happened" plus the conclusion and what it needs of you (from the summary; never the answer itself,
// commands or code) is sent. It passes through the ntfy server: with "content" off, only which
// terminal and what kind of thing happened go. The topic is a long random name,
// which is what keeps it private. Off by default.
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const FILE = path.join(DATA_DIR, 'push.json');

let settings = load();
let primed = false;

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
  return { enabled: Boolean(settings.enabled), content: settings.content !== false, server: settings.server, topic: settings.topic, link, qr };
}

export async function setPush({ enabled, regenerate, content }) {
  if (regenerate || !settings.topic) settings.topic = newTopic();
  if (typeof enabled === 'boolean') settings.enabled = enabled;
  // the conclusion and what it needs of you in the push: on by default (it is what makes a push useful);
  // off sends only the kind and the project, for when nothing may pass through the ntfy server
  if (typeof content === 'boolean') settings.content = content;
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

// what each kind of notice is worth on a phone: things that need you ring loudest
const PRIORITY = { permit: 5, question: 5, error: 4, interrupted: 4, never_ran: 4, alert: 4, ask: 4, done: 3, overload: 3 };
const TAGS = { permit: 'rotating_light', question: 'question', error: 'x', interrupted: 'pause_button', never_ran: 'no_entry', alert: 'warning', ask: 'yellow_circle', done: 'white_check_mark', overload: 'warning' };
const sent = new Set();

/** Called on every publish: push each new notice once (with its summary only if you chose so). */
export function pushNotices(notices, click) {
  if (!settings.enabled || !settings.topic) return;
  for (const n of notices) {
    if (sent.has(n.key)) continue;
    sent.add(n.key);
    if (sent.size > 1000) sent.delete(sent.values().next().value);
    if (!primed) continue; // what was there when push was turned on (or the server started) is not news
    const t = pushText(n, settings.content !== false);
    send({ title: t.title, message: t.body, priority: PRIORITY[n.kind] || 3, tags: [TAGS[n.kind] || 'bell'], click });
  }
  primed = true;
}
