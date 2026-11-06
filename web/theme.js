// Color themes for every page (command center, widget, popped-out terminals, phone) and their terminals.
// The stylesheets are written in the original neon palette; a theme recolors them by role: each color
// in a rule is matched to the nearest color of the neon palette (background, panel, body text, accent,
// a state...) and replaced by the theme's color for that role, alpha kept. So one stylesheet serves
// every theme, and a rule added later in neon colors follows the themes by itself.
// Body text sits around 7:1 on the panels in the new themes (between WCAG AA and AAA): readable
// without the glare of the neon one's 17:1; glowing text (blurred edges) is off in all of them.

export const THEMES = {
  neon: {
    name: '霓虹（原版）',
    glow: 'full',
    ui: { bg: '#04060c', panel: '#0a1120', panelDeep: '#071019', line: '#12304a', lineHi: '#1b6f80', text: '#ddf6ff', soft: '#a9c4d3', muted: '#7fa3b8', dim: '#4f7a90', accent: '#3df5ff', amber: '#ffb020', red: '#ff4d6d', green: '#4dffa6', termBg: '#050a12' },
    term: { background: '#050a12', foreground: '#a6e8c0', cursor: '#3df5ff', cursorAccent: '#050a12', selectionBackground: 'rgba(61,245,255,.3)', black: '#0a1120', red: '#ff4d6d', green: '#4dffa6', yellow: '#ffb020', blue: '#4d9fff', magenta: '#c77dff', cyan: '#3df5ff', white: '#86b89c', brightBlack: '#24384a', brightRed: '#3df5ff', brightGreen: '#8affc4', brightYellow: '#ffd166', brightBlue: '#82bcff', brightMagenta: '#dcaaff', brightCyan: '#b8fcff', brightWhite: '#dcf8e8' },
  },
  deepspace: {
    name: '深空',
    glow: 'soft',
    ui: { bg: '#1e2228', panel: '#262b33', panelDeep: '#22262d', line: '#343b46', lineHi: '#4a5463', text: '#b2bac7', soft: '#9aa3b1', muted: '#8a94a2', dim: '#6c7785', accent: '#5ea1c6', amber: '#c88f36', red: '#d77c84', green: '#68a868', termBg: '#1b1f25' },
    term: { background: '#1b1f25', foreground: '#a8b0bd', cursor: '#7cb3d1', cursorAccent: '#1b1f25', selectionBackground: 'rgba(124,179,209,.28)', black: '#2a303a', red: '#d26b74', green: '#5d9b57', yellow: '#b18631', blue: '#598dca', magenta: '#a47aba', cyan: '#4996bf', white: '#929dac', brightBlack: '#3a4250', brightRed: '#59a1c8', brightGreen: '#64a85f', brightYellow: '#c29130', brightBlue: '#6a9ad1', brightMagenta: '#af87c3', brightCyan: '#59a1c8', brightWhite: '#b7c0cc' },
  },
  tokyo: {
    name: 'Tokyo Night',
    glow: 'soft',
    ui: { bg: '#222537', panel: '#292e42', panelDeep: '#252839', line: '#3b4261', lineHi: '#545c7e', text: '#b5c1f3', soft: '#a0a8d2', muted: '#8b98c7', dim: '#7077a0', accent: '#50bfff', amber: '#dfab61', red: '#f7738c', green: '#97cb5f', termBg: '#1f2335' },
    term: { background: '#1f2335', foreground: '#b1bef3', cursor: '#7dcfff', cursorAccent: '#1f2335', selectionBackground: 'rgba(122,162,247,.28)', black: '#1d202f', red: '#f6637f', green: '#81bf3f', yellow: '#dca452', blue: '#6e99f6', magenta: '#b38ef6', cyan: '#3db8ff', white: '#9ca6d0', brightBlack: '#414868', brightRed: '#3db8ff', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c4cdf6' },
  },
  warm: {
    name: '暖色',
    glow: 'soft',
    ui: { bg: '#24211d', panel: '#2d2924', panelDeep: '#29251f', line: '#3d372f', lineHi: '#5a5145', text: '#c5b79e', soft: '#af9f85', muted: '#9d8f79', dim: '#7b7467', accent: '#cd8a2f', amber: '#cd8a2f', red: '#da7a64', green: '#88a153', termBg: '#211e1a' },
    term: { background: '#211e1a', foreground: '#bdad92', cursor: '#d9a45b', cursorAccent: '#211e1a', selectionBackground: 'rgba(217,164,91,.25)', black: '#352f28', red: '#d56c52', green: '#7e954c', yellow: '#b2852d', blue: '#6e9099', magenta: '#b07b8e', cyan: '#589b7b', white: '#a8997f', brightBlack: '#4a4238', brightRed: '#d9a45b', brightGreen: '#88a24d', brightYellow: '#c29029', brightBlue: '#7b9ba4', brightMagenta: '#bb889b', brightCyan: '#5da783', brightWhite: '#cfbd9c' },
  },
  light: {
    name: '浅色',
    glow: 'none',
    ui: { bg: '#e7e9ec', panel: '#f3f4f6', panelDeep: '#eceef1', line: '#d3d7dd', lineHi: '#aeb6c1', text: '#48515e', soft: '#58626f', muted: '#66707b', dim: '#838c96', accent: '#2a6f96', amber: '#905e10', red: '#b9434d', green: '#3a744a', termBg: '#f8f9fb' },
    // brightBlack is the panel color Claude Code (dark-ansi) puts behind highlighted text: a light gray here
    term: { background: '#f8f9fb', foreground: '#474f5b', cursor: '#2a6f97', cursorAccent: '#f8f9fb', selectionBackground: 'rgba(42,111,151,.18)', black: '#3a414a', red: '#bb434e', green: '#3b764c', yellow: '#8b6314', blue: '#336db6', magenta: '#8f56a6', cyan: '#287380', white: '#585e66', brightBlack: '#d9dde3', brightRed: '#2a6f96', brightGreen: '#3b6a48', brightYellow: '#7c5a1a', brightBlue: '#38649a', brightMagenta: '#7f5092', brightCyan: '#2c6872', brightWhite: '#363e47' },
  },
};
export const THEME_KEYS = ['auto', ...Object.keys(THEMES)];
export const DEFAULT_THEME = 'deepspace';

/** 'auto' follows the system: dark -> deep space, light -> light. */
export function resolveTheme(key) {
  if (key === 'auto') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'deepspace';
  return THEMES[key] ? key : DEFAULT_THEME;
}

const NEON = THEMES.neon.ui;
// literal colors in the stylesheets besides the palette itself, by the role they play
const EXTRA = [
  ['#000000', 'bg'], ['#0c1628', 'panel'], ['#0a1424', 'panel'], ['#081220', 'panelDeep'], ['#050a12', 'termBg'],
  ['#ff8fa3', 'red'], ['#c42b3c', 'red'], ['#ffd6dd', 'text'], ['#c9dce6', 'soft'], ['#a6e8c0', 'text'], ['#dcf8e8', 'text'], ['#86b89c', 'soft'],
  ['#5c1f2c', 'redDeep'], ['#4a3812', 'amberDeep'], ['#24384a', 'line'], ['#2a4a5e', 'lineHi'], ['#ffd166', 'amber'], ['#c9a24a', 'amber'],
  ['#4d9fff', 'accent'], ['#c77dff', 'accent'], ['#ffffff', 'text'], ['#ddf6ff', 'text'],
];
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + rgbOf(a).map((x, i) => Math.round(x + (rgbOf(b)[i] - x) * t).toString(16).padStart(2, '0')).join('');
const TABLE = [...Object.entries(NEON).map(([k, v]) => [rgbOf(v), k]), ...EXTRA.map(([v, k]) => [rgbOf(v), k])];
const roleOf = (rgb) => {
  let best = 'text';
  let d = Infinity;
  for (const [c, k] of TABLE) {
    const e = (c[0] - rgb[0]) ** 2 * 0.3 + (c[1] - rgb[1]) ** 2 * 0.59 + (c[2] - rgb[2]) ** 2 * 0.11;
    if (e < d) {
      d = e;
      best = k;
    }
  }
  return best;
};

// the stylesheet values as written (neon), kept so a theme can always be computed from them
const originals = new Map(); // CSSStyleRule -> [[prop, value, priority]]
function record(rules) {
  for (const rule of rules) {
    if (rule.cssRules) record(rule.cssRules);
    if (!rule.style || originals.has(rule)) continue;
    const props = [];
    for (const prop of rule.style) {
      const v = rule.style.getPropertyValue(prop);
      if (/rgb|#[0-9a-f]{3}|shadow/i.test(v) || /shadow/.test(prop)) props.push([prop, v, rule.style.getPropertyPriority(prop)]);
    }
    if (props.length) originals.set(rule, props);
  }
}

let applied = null;
const listeners = new Set();
/** Called with the xterm theme whenever the theme changes (the terminals follow). */
export function onTermTheme(fn) {
  listeners.add(fn);
}
export const termTheme = () => THEMES[applied || 'neon'].term;

/** Recolors the page (and its terminals) to a theme; key may be 'auto'. */
export function applyTheme(key) {
  const name = resolveTheme(key);
  const T = THEMES[name];
  for (const sheet of document.styleSheets) {
    try {
      record(sheet.cssRules);
    } catch {
      // cross-origin (web fonts)
    }
  }
  if (name !== applied) {
    const roles = { ...T.ui, redDeep: mix(T.ui.panel, T.ui.red, 0.35), amberDeep: mix(T.ui.panel, T.ui.amber, 0.35) };
    // rgb() in ordinary properties (the browser normalizes them), hex in custom properties (kept as written)
    const swap = (v) =>
      v
        .replace(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g, (_, r, g, b, a) => {
          const n = rgbOf(roles[roleOf([+r, +g, +b])]);
          return a === undefined ? `rgb(${n.join(', ')})` : `rgba(${n.join(', ')}, ${a})`;
        })
        .replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, (_, h) => roles[roleOf(rgbOf('#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h).toLowerCase()))]);
    for (const [rule, props] of originals) {
      for (const [prop, v, prio] of props) {
        // glowing text blurs its edges: only the neon theme keeps it; 'none' drops the panel glow too
        if (prop === 'text-shadow' && T.glow !== 'full') rule.style.setProperty(prop, 'none', prio);
        else if (prop === 'box-shadow' && T.glow === 'none' && !/inset/.test(v)) rule.style.setProperty(prop, 'none', prio);
        else rule.style.setProperty(prop, name === 'neon' ? v : swap(v), prio);
      }
    }
    // inline SVG artwork (the logo) drawn in the neon accent
    for (const el of document.querySelectorAll('svg [stroke], svg [fill]')) {
      for (const attr of ['stroke', 'fill']) {
        const v = el.getAttribute(attr);
        if (!v || v === 'none' || v === 'currentColor') continue;
        el.dataset['neon' + attr] ??= v;
        const orig = el.dataset['neon' + attr];
        if (/^#[0-9a-f]{6}$/i.test(orig)) el.setAttribute(attr, name === 'neon' ? orig : roles[roleOf(rgbOf(orig.toLowerCase()))]);
      }
    }
    applied = name;
    for (const fn of listeners) fn(T.term);
  }
  const root = document.documentElement;
  root.dataset.theme = name;
  root.style.colorScheme = name === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', T.ui.bg);
  return name;
}

// 'auto' follows the system while the page is open
let chosen = null;
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => chosen === 'auto' && applyTheme('auto'));
/** The theme from the server state: applied when it changed (cheap to call on every state). */
export function followTheme(key) {
  const k = THEME_KEYS.includes(key) ? key : DEFAULT_THEME;
  if (k === chosen && applied) return;
  chosen = k;
  applyTheme(k);
  try {
    localStorage.setItem('fb-theme', k);
  } catch {
    // only the first paint of the next visit is affected
  }
}

// the last theme right away, before the first state arrives: no flash of the neon colors
let last = null;
try {
  last = localStorage.getItem('fb-theme');
} catch {
  // storage unavailable
}
followTheme(last || DEFAULT_THEME);
