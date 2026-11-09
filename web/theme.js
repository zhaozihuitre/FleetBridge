// Color themes for every page (command center, widget, popped-out terminals, phone) and their terminals.
// The stylesheets use CSS variables for every color: the palette (--bg, --panel, --text, --cyan, ...)
// and --x-<hex> for the other colors of the neon original, all defined in :root with their neon values
// (translucent ones are color-mix(in srgb, var(--...) a%, transparent)). A theme sets those variables:
// each takes the theme's color for its role (the nearest neon palette color: background, panel, body
// text, accent, a state...), unless the theme sets that variable itself (vars: per-theme tuning).
// A rule written later with a plain color still follows the themes: it is recolored by role as before.
// Body text sits around 7:1 on the panels in the new themes (between WCAG AA and AAA): readable
// without the glare of the neon one's 17:1; glowing text (blurred edges) is off in all of them.

export const THEMES = {
  neon: {
    name: '霓虹（原版）',
    glow: 'full',
    // the original HUD look, kept as it was; faint CRT scanlines over the terminals (can be turned off)
    grain: 'scan',
    ui: { bg: '#04060c', panel: '#0a1120', panelDeep: '#071019', line: '#12304a', lineHi: '#1b6f80', text: '#ddf6ff', soft: '#a9c4d3', muted: '#7fa3b8', dim: '#5b8aa1', accent: '#3df5ff', amber: '#ffb020', red: '#ff4d6d', green: '#4dffa6', termBg: '#050a12' },
    term: { background: '#050a12', foreground: '#a6e8c0', cursor: '#3df5ff', cursorAccent: '#050a12', selectionBackground: 'rgba(61,245,255,.3)', black: '#0a1120', red: '#ff4d6d', green: '#4dffa6', yellow: '#ffb020', blue: '#4d9fff', magenta: '#c77dff', cyan: '#3df5ff', white: '#86b89c', brightBlack: '#24384a', brightRed: '#3df5ff', brightGreen: '#8affc4', brightYellow: '#ffd166', brightBlue: '#82bcff', brightMagenta: '#dcaaff', brightCyan: '#b8fcff', brightWhite: '#dcf8e8' },
  },
  deepspace: {
    name: '深空',
    glow: 'soft',
    // an observatory at night: slate blue-gray in one hue (about 215°), ice-blue accent; every neutral (panels,
    // lines, the terminal's black / white / highlight panel) tinted the same blue. No texture: clean glass.
    ui: { bg: '#1a1e25', panel: '#222831', panelDeep: '#1e232b', line: '#313946', lineHi: '#4a5568', text: '#c5cdd9', soft: '#aab4c2', muted: '#97a2b2', dim: '#8792a3', accent: '#6db3df', amber: '#d6a855', red: '#e3838c', green: '#7cbb84', termBg: '#181c22' },
    term: { background: '#181c22', foreground: '#bac3d0', cursor: '#8fd0f5', cursorAccent: '#181c22', selectionBackground: 'rgba(109,179,223,.26)', black: '#29303b', red: '#e37f88', green: '#80bd83', yellow: '#d7ad58', blue: '#73aaea', magenta: '#b996da', cyan: '#62bfcb', white: '#a6b0be', brightBlack: '#323a47', brightRed: '#6db3df', brightGreen: '#93cc94', brightYellow: '#e5bf6b', brightBlue: '#8abaf1', brightMagenta: '#c9a8e5', brightCyan: '#7dd0da', brightWhite: '#d8dfe8' },
  },
  tokyo: {
    name: 'Tokyo Night',
    glow: 'soft',
    // a city at night: deep indigo, periwinkle text, violet-blue accent with sky-blue highlights; the neutrals
    // lean indigo, the inks are the familiar Tokyo Night ones. No texture.
    ui: { bg: '#1c1f2e', panel: '#24283b', panelDeep: '#202434', line: '#343a55', lineHi: '#4d567c', text: '#c4cdf5', soft: '#a9b2db', muted: '#959fcc', dim: '#868fbd', accent: '#7aa2f7', amber: '#e0af68', red: '#f7768e', green: '#9ece6a', termBg: '#1a1c2b' },
    term: { background: '#1a1c2b', foreground: '#c0caf5', cursor: '#7dcfff', cursorAccent: '#1a1c2b', selectionBackground: 'rgba(122,162,247,.28)', black: '#262a3f', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#343a55', brightRed: '#7dcfff', brightGreen: '#b4e083', brightYellow: '#ff9e64', brightBlue: '#94b4fa', brightMagenta: '#cdb2fa', brightCyan: '#a4ddff', brightWhite: '#d5dbf7' },
  },
  warm: {
    name: '暖色',
    glow: 'soft',
    // reading by lamplight: dark walnut, parchment text, the lamp's amber for what waits on you and a teal ink
    // for what is working (amber for both made busy and idle look the same); little blue light (the blues are
    // grayed teal); a faint grain on the dark like old paper (can be turned off)
    grain: 'dark',
    ui: { bg: '#201c17', panel: '#29241e', panelDeep: '#241f1a', line: '#3b342b', lineHi: '#5c5143', text: '#dccbae', soft: '#c4b295', muted: '#ae9d82', dim: '#9d8d74', accent: '#78b8ae', amber: '#e2a453', red: '#e48a70', green: '#a9b86e', termBg: '#1d1915' },
    term: { background: '#1d1915', foreground: '#d6c5a8', cursor: '#ebb66b', cursorAccent: '#1d1915', selectionBackground: 'rgba(226,164,83,.26)', black: '#322b23', red: '#e3846b', green: '#a8b76d', yellow: '#ddb05c', blue: '#91b2ba', magenta: '#d09aa8', cyan: '#90c0a0', white: '#bcad92', brightBlack: '#3b342b', brightRed: '#ebb66b', brightGreen: '#bac87e', brightYellow: '#edc274', brightBlue: '#a5c2c9', brightMagenta: '#ddacb8', brightCyan: '#a4cfb2', brightWhite: '#eadcc1' },
  },
  light: {
    name: '浅色',
    glow: 'none',
    grain: 'paper',
    // the phone page's screen, where a color is text or background (server/screenhtml.js): brightBlack as
    // text is a gray ink, white / brightWhite behind text a darker paper
    paperVars: { '--tf8': '#706860', '--tb7': '#e4e0d6', '--tb15': '#ebe8e0' },
    // paper: the terminals are near-white paper with only a trace of warmth (not cream), ink colors on it, the
    // panels, page and lines around them in the same tone. Every ink is at least 4.5:1 on the paper (WCAG AA).
    ui: { bg: '#ecebe6', panel: '#f8f7f3', panelDeep: '#f2f0eb', line: '#dcd9d1', lineHi: '#b8b3a8', text: '#47413a', soft: '#57514a', muted: '#655e56', dim: '#726b62', accent: '#2a6286', amber: '#82570b', red: '#a43d37', green: '#3b6833', termBg: '#faf9f5' },
    // brightBlack is the panel color Claude Code (dark-ansi) puts behind highlighted text: a slightly darker
    // paper here; the selection is a pale wash of the blue ink (no yellow on the white)
    term: { background: '#faf9f5', foreground: '#38332d', cursor: '#2a5f86', cursorAccent: '#faf9f5', selectionBackground: 'rgba(42,98,134,.18)', black: '#2f2a25', red: '#a8322d', green: '#3d6b2f', yellow: '#7a5306', blue: '#2b5a8f', magenta: '#84407a', cyan: '#22696f', white: '#58514a', brightBlack: '#ebe8e0', brightRed: '#2a5f86', brightGreen: '#356029', brightYellow: '#74500e', brightBlue: '#2d5285', brightMagenta: '#763a6e', brightCyan: '#1f5f64', brightWhite: '#2e2924' },
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

// the xterm theme's 16 colors in ANSI order
const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ANSI = [...BASE, ...BASE.map((k) => 'bright' + k[0].toUpperCase() + k.slice(1))];

/** The terminal texture of the themes that have one (web/texture.css): on unless turned off (kept with the theme
    on the server as "paper", its first name). */
export function followTexture(on) {
  const v = on === false ? 'off' : 'on';
  if (document.documentElement.dataset.texture === v) return false;
  document.documentElement.dataset.texture = v;
  return true;
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
        else if (name !== 'neon' && prop.startsWith('--') && T.vars?.[prop]) rule.style.setProperty(prop, T.vars[prop], prio); // tuned for this theme
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
  // the phone page's terminal (colored by the server with --t0..--t15) in the theme's terminal colors, the
  // same as the command center's xterm; the paper theme adds its text/background variants
  ANSI.forEach((k, i) => root.style.setProperty(`--t${i}`, T.term[k]));
  // on a dark theme, black and brightBlack as text sit on a near-black screen (xterm lifts them with its
  // minimum contrast, the phone page cannot): they read as the theme's dim gray there
  const dark = !T.paperVars ? { '--tf0': T.ui.dim, '--tf8': T.ui.dim } : {};
  const vars = { '--tfg': T.term.foreground, '--tbg': T.term.background, ...dark, ...T.paperVars };
  for (const v of ['--tfg', '--tbg', '--tf0', '--tf8', '--tb7', '--tb15']) vars[v] ? root.style.setProperty(v, vars[v]) : root.style.removeProperty(v);
  root.style.colorScheme = name === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', T.ui.bg);
  return name;
}

// 'auto' follows the system while the page is open
let chosen = null;
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => chosen === 'auto' && applyTheme('auto'));
/** The theme (and the texture switch, when given) from the server state: applied when it changed (cheap to call on every state). */
export function followTheme(key, paper) {
  if (paper !== undefined && followTexture(paper)) {
    try {
      localStorage.setItem('fb-texture', paper === false ? 'off' : 'on');
    } catch {
      // only the first paint of the next visit is affected
    }
  }
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
let lastPaper = null;
try {
  last = localStorage.getItem('fb-theme');
  lastPaper = localStorage.getItem('fb-texture');
} catch {
  // storage unavailable
}
followTexture(lastPaper !== 'off');
followTheme(last || DEFAULT_THEME);
