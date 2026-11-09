import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Server-side texts (reminders, comms, operator lines, errors) follow the language picked in the
// command center. Kept in settings.json so the next start speaks the same language.
const FILE = path.join(DATA_DIR, 'settings.json');
export const LANGS = ['zh', 'en', 'ja'];

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

/** Pick the text for the current language: L('中文', 'English', '日本語'). */
export const L = (zh, en, ja) => (lang === 'en' ? en : lang === 'ja' ? ja ?? en : zh);

export const locale = () => ({ en: 'en-US', ja: 'ja-JP' })[lang] || 'zh-CN';

// The color theme (web/theme.js), kept beside the language: every page and the phone follow it.
export const THEMES = ['auto', 'neon', 'deepspace', 'tokyo', 'warm', 'light'];
let theme = (() => {
  try {
    const t = JSON.parse(fs.readFileSync(FILE, 'utf8')).theme;
    return THEMES.includes(t) ? t : 'deepspace';
  } catch {
    return 'deepspace';
  }
})();
export const getTheme = () => theme;
// the paper grain over the light theme's terminals (on unless turned off)
let paper = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).paper !== false;
  } catch {
    return true;
  }
})();
export const getPaper = () => paper;
// the light theme's grain: off unless turned on
let lightGrain = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).lightGrain === true;
  } catch {
    return false;
  }
})();
export const getLightGrain = () => lightGrain;
export function setLightGrain(on) {
  if (typeof on !== 'boolean' || on === lightGrain) return false;
  lightGrain = on;
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // first setting
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...s, lightGrain }, null, 2));
  return true;
}
export function setPaper(on) {
  if (typeof on !== 'boolean' || on === paper) return false;
  paper = on;
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // first setting
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...s, paper }, null, 2));
  return true;
}
export function setTheme(next) {
  if (!THEMES.includes(next) || next === theme) return false;
  theme = next;
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    // first setting
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ...s, theme }, null, 2));
  return true;
}
