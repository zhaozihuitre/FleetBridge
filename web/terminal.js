// Live terminal of an agent launched by the command center: xterm.js on a WebSocket to its PTY.
// Several can be open at once (split view, pop-out windows); each call makes an independent one.
import { Terminal } from '/lib/xterm/lib/xterm.mjs';
import { FitAddon } from '/lib/xterm-fit/lib/addon-fit.mjs';
import { L } from './i18n.js';
import { WebglAddon } from '/lib/xterm-webgl/lib/addon-webgl.mjs';
import { onTermTheme, termTheme } from './theme.js';

// The 16 colors come from the theme (web/theme.js): our agents run Claude Code with the dark-ansi
// theme, so its whole UI (accents, diffs, prompts, spinners) is drawn from them. Open terminals
// follow a theme change right away.
const live = new Set();
onTermTheme((theme) => {
  for (const term of live) term.options.theme = { ...theme };
});

/**
 * @param {HTMLElement} host
 * @param {string} id agent id
 * @param {{fontSize?: number, onFocus?: () => void, onInput?: (data: string) => boolean | void}} [opts]
 */
export function createTerminal(host, id, opts = {}) {
  // xterm goes into a box with no padding of its own: the fit addon sizes the terminal from its
  // parent's CSS width and height, which under border-box include the host's padding, so on the
  // padded host it came out a row taller and a few columns wider than the space (the last row
  // and the right edge were cut off, under the scrollbar)
  host.innerHTML = '<div class="term-fit" style="width:100%;height:100%;overflow:hidden"></div>';
  const box = host.firstElementChild;
  const term = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, 'Noto Sans SC', monospace", fontSize: opts.fontSize || 13, cursorBlink: true, scrollback: 5000, theme: { ...termTheme() }, minimumContrastRatio: 3 });
  live.add(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  // GPU rendering: the default DOM renderer lags with several panes redrawing at once.
  // Falls back to DOM if WebGL is unavailable or its context gets lost.
  let gl = null;
  const useWebgl = () => {
    try {
      gl = new WebglAddon();
      gl.onContextLoss(() => {
        gl?.dispose();
        gl = null;
      });
      term.loadAddon(gl);
    } catch {
      gl = null; // no WebGL: keep the DOM renderer
    }
  };
  useWebgl();
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
  const send = (data) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'input', data }));
  // onInput may take a keystroke for itself (the master's @ picker) by returning false
  term.onData((data) => opts.onInput?.(data) !== false && send(data));
  term.onResize(sendResize);

  // Panes animate when the split view resizes them: refit once they settle, not on every frame,
  // or claude would redraw its whole screen dozens of times per transition.
  let settle = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(refit, 120);
  });
  ro.observe(box);
  requestAnimationFrame(refit);
  // the cell size changes without the box changing: once the fonts are in, and when the window
  // moves to a screen with another scaling (the WebGL renderer kept its old cells: started afresh)
  document.fonts?.ready.then(refit).catch(() => {});
  let dpr = null;
  const watchDpr = () => {
    dpr = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dpr.addEventListener('change', onDpr, { once: true });
  };
  const onDpr = () => {
    if (gl) {
      gl.dispose();
      useWebgl();
    }
    requestAnimationFrame(refit);
    watchDpr();
  };
  watchDpr();

  return {
    id,
    focus: () => term.focus(),
    send,
    /** text as a paste: typed in as-is, without triggering the program's key handling */
    paste: (text) => send(`\x1b[200~${text}\x1b[201~`),
    setFontSize(px) {
      term.options.fontSize = px;
      refit();
    },
    dispose() {
      ro.disconnect();
      dpr?.removeEventListener('change', onDpr);
      ws.close();
      live.delete(term);
      term.dispose();
    },
  };
}
