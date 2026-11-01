import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Server-side texts (reminders, comms, operator lines, errors) follow the language picked in the
// command center. Kept in settings.json so the next start speaks the same language.
const FILE = path.join(DATA_DIR, 'settings.json');
export const LANGS = ['zh', 'en'];

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return LANGS.includes(s.lang) ? s.lang : 'zh';
  } catch {
    return 'zh';
  }
}

let lang = load();

export const getLang = () => lang;

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return false;
  lang = next;
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // first setting
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...s, lang }, null, 2));
  return true;
}

/** Pick the text for the current language: L('中文', 'English'). */
export const L = (zh, en) => (lang === 'en' ? en : zh);

export const locale = () => (lang === 'en' ? 'en-US' : 'zh-CN');
