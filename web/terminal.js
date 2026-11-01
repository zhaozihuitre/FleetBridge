// Live terminal of an agent launched by the command center: xterm.js on a WebSocket to its PTY.
// Several can be open at once (split view, pop-out windows); each call makes an independent one.
import { Terminal } from '/lib/xterm/lib/xterm.mjs';
import { FitAddon } from '/lib/xterm-fit/lib/addon-fit.mjs';
import { L } from './i18n.js';
import { WebglAddon } from '/lib/xterm-webgl/lib/addon-webgl.mjs';

// The command center palette for all 16 colors: our agents run Claude Code with the dark-ansi
// theme, so its whole UI (accents, diffs, prompts, spinners) is drawn from these.
export const THEME = {
  background: '#050a12',
  foreground: '#9fd4ff', // body text: a soft sky blue, easier on the eyes than white for long reads
  cursor: '#3df5ff',
  cursorAccent: '#050a12',
  selectionBackground: 'rgba(61,245,255,.3)',
  black: '#0a1120',
  red: '#ff4d6d',
  green: '#4dffa6',
  yellow: '#ffb020',
  blue: '#4d9fff',
  magenta: '#c77dff',
  cyan: '#3df5ff',
  white: '#7fb2d0',
  // dark-ansi paints panels (diff review, the highlighted prompt) with this as background, and dim
  // text with it as foreground: a dark slate, with minimumContrastRatio lifting the dim text
  brightBlack: '#24384a',
  brightRed: '#3df5ff', // Claude's brand accent (logo, highlights) in dark-ansi: our cyan; errors use plain red
  brightGreen: '#8affc4',
  brightYellow: '#ffd166',
  brightBlue: '#82bcff',
  brightMagenta: '#dcaaff',
  brightCyan: '#b8fcff',
  brightWhite: '#d6f0ff',
};

/**
 * @param {HTMLElement} host
 * @param {string} id agent id
 * @param {{fontSize?: number, onFocus?: () => void}} [opts]
 */
export function createTerminal(host, id, opts = {}) {
  host.innerHTML = '';
  const term = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, 'Noto Sans SC', monospace", fontSize: opts.fontSize || 13, cursorBlink: true, scrollback: 5000, theme: THEME, minimumContrastRatio: 3 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // GPU rendering: the default DOM renderer lags with several panes redrawing at once.
  // Falls back to DOM if WebGL is unavailable or its context gets lost.
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    // no WebGL: keep the DOM renderer
  }
  if (opts.onFocus) term.textarea?.addEventListener('focus', opts.onFocus);

  const ws = new WebSocket(`ws://${location.host}/ws/agents/${id}`);
  const sendResize = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  const refit = () => {
    try {
      fit.fit();
    } catch {
      // host hidden mid-resize
    }
  };
  ws.onopen = () => {
    refit();
    sendResize();
  };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => term.write(`\r\n\x1b[90m${L('[与终端的连接已断开]')}\x1b[0m\r\n`);
  term.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data })));
  term.onResize(sendResize);

  // Panes animate when the split view resizes them: refit once they settle, not on every frame,
  // or claude would redraw its whole screen dozens of times per transition.
  let settle = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(refit, 120);
  });
  ro.observe(host);
  requestAnimationFrame(refit);

  return {
    id,
    focus: () => term.focus(),
    setFontSize(px) {
      term.options.fontSize = px;
      refit();
    },
    dispose() {
      ro.disconnect();
      ws.close();
      term.dispose();
    },
  };
}
