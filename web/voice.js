// Spoken notices: what the server decided to tell (server/notices.js: a dialog waiting, a finished turn with its
// one-line conclusion, an error, the quota) read out by the system's own voices (Web Speech: Windows' SAPI
// voices in the app, the phone's own; never an online voice). One sentence or two: "monitor 等你授权：Bash npm
// install", "mobileapp 完成了：<its conclusion>". Notices arriving together are merged ("3 个终端完成了：a、b、c"),
// the same terminal is not told twice within a minute and a half, the one you are looking at is not told at all,
// and nothing is said in the quiet hours. A short tone first, if wanted. Settings: server/voice.js.
import { L, lang } from './i18n.js';

// the notice kinds by the switch that covers them
const KIND = { permit: 'permit', question: 'question', done: 'done', ask: 'done', error: 'error', limit: 'error', never_ran: 'error', interrupted: 'error', overload: 'warn', alert: 'warn', sysload: 'sys' };
export const VOICE_KINDS = ['permit', 'question', 'done', 'error', 'warn', 'sys'];
export const kindName = (k) => ({ permit: L('等授权'), question: L('等回答'), done: L('完成'), error: L('出错 / 额度到限'), warn: L('警告（额度、上下文快满）'), sys: L('系统负荷（内存吃紧、CPU 满载）') })[k];

const LANG = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' }[lang] || 'zh-CN';
const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
export const voiceSupported = () => Boolean(synth);

/** The local voices (no online ones: what is said stays on this machine). */
export function localVoices() {
  return synth ? synth.getVoices().filter((v) => v.localService) : [];
}
function pickVoice(name) {
  const vs = localVoices();
  return vs.find((v) => v.name === name) || vs.find((v) => v.lang === LANG) || vs.find((v) => v.lang.startsWith(LANG.slice(0, 2))) || null;
}

// short, speakable: no emoji, markdown marks, paths cut to their last part, at most about 40 characters
function plain(s, max = 40) {
  let t = String(s || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[`*_#>|]/g, '')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])+([^\\/\s]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max).replace(/[，,、;；\s]+[^，,、;；\s]*$/, '') + '…';
  return t;
}

/** One notice as a sentence. */
export function sentenceOf(n) {
  const who = plain(n.name || n.project || L('一个终端'), 24);
  const what = plain(n.title || '');
  switch (n.kind) {
    case 'permit':
      return what ? L('{0} 等你授权：{1}', who, what) : L('{0} 等你授权', who);
    case 'question':
      return what ? L('{0} 在问你：{1}', who, what) : L('{0} 在等你回答', who);
    case 'done':
    case 'ask':
      return what ? L('{0} 完成了：{1}', who, what) : L('{0} 完成了', who);
    case 'limit':
      return L('{0} 额度到限', who);
    case 'interrupted':
      return L('{0} 被打断了', who);
    case 'never_ran':
      return L('{0} 的指令没有执行', who);
    case 'error':
      return what ? L('{0} 出错：{1}', who, what) : L('{0} 出错了', who);
    default:
      return what ? L('{0}：{1}', who, what) : who;
  }
}

// several of one kind at once: one sentence
function mergedOf(kind, list) {
  const names = [...new Set(list.map((n) => plain(n.name || n.project, 16)))];
  const shown = names.slice(0, 3).join(L('、')) + (names.length > 3 ? L(' 等') : '');
  const n = names.length;
  return {
    permit: L('{0} 个终端在等你授权：{1}', n, shown),
    question: L('{0} 个终端在等你回答：{1}', n, shown),
    done: L('{0} 个终端完成了：{1}', n, shown),
    error: L('{0} 个终端出错：{1}', n, shown),
    warn: L('{0} 条警告：{1}', n, shown),
  }[kind];
}

function inQuiet(q, now = new Date()) {
  if (!q?.on) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const at = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const a = at(q.from);
  const b = at(q.to);
  return a <= b ? m >= a && m < b : m >= a || m < b; // across midnight
}

// a short two-note tone (Web Audio), at the speech's volume
let ac = null;
function chime(volume) {
  return new Promise((done) => {
    try {
      ac ||= new AudioContext();
      const t = ac.currentTime;
      [880, 1320].forEach((f, i) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.12 * volume), t + i * 0.12 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.22);
        o.connect(g).connect(ac.destination);
        o.start(t + i * 0.12);
        o.stop(t + i * 0.12 + 0.25);
      });
      setTimeout(done, 420);
    } catch {
      done();
    }
  });
}

function say(text, s) {
  return new Promise((done) => {
    if (!synth) return done();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(s.voice);
    if (v) u.voice = v;
    u.lang = v?.lang || LANG;
    u.volume = s.volume;
    u.rate = s.rate;
    u.onend = u.onerror = () => done();
    synth.speak(u);
    setTimeout(done, 20_000); // never stuck on a lost end event
  });
}

/** Speaks now with these settings (the settings page's "listen" button). */
export async function speakNow(text, s) {
  synth?.cancel();
  if (s.chime) await chime(s.volume);
  await say(text, s);
}

/**
 * The announcer of one page. settings(): the current voice settings (state.voice); viewing(n): whether you are
 * looking at that notice's terminal right now.
 */
export function createAnnouncer({ settings, viewing }) {
  const toldAt = new Map(); // `${who}:${kind}` -> when it was last told
  let pending = [];
  let timer = 0;
  let busy = Promise.resolve();
  function add(n) {
    const s = settings();
    const kind = KIND[n.kind];
    if (!s?.on || !kind || !s.kinds?.[kind] || inQuiet(s.quiet) || viewing(n)) return;
    const who = n.agentId || n.sessionId || n.name;
    const key = `${who}:${kind}`;
    if (Date.now() - (toldAt.get(key) || 0) < 90_000) return;
    toldAt.set(key, Date.now());
    pending.push({ ...n, vk: kind });
    // gather what arrives together, then speak it as one
    clearTimeout(timer);
    timer = setTimeout(flush, 1500);
  }
  function flush() {
    const list = pending;
    pending = [];
    if (!list.length) return;
    const groups = new Map();
    for (const n of list) groups.set(n.vk, [...(groups.get(n.vk) || []), n]);
    // the most urgent first
    const lines = VOICE_KINDS.filter((k) => groups.has(k)).map((k) => (groups.get(k).length > 1 ? mergedOf(k, groups.get(k)) : sentenceOf(groups.get(k)[0])));
    busy = busy.then(async () => {
      const s = settings();
      if (!s?.on || inQuiet(s.quiet)) return;
      if (s.chime) await chime(s.volume);
      for (const line of lines) await say(line, s);
    });
  }
  return { add };
}
