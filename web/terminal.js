// Live terminal of an agent launched by the command center: xterm.js on a WebSocket to its PTY.
// Several can be open at once (split view, pop-out windows); each call makes an independent one.
import { Terminal } from '/lib/xterm/lib/xterm.mjs';
import { FitAddon } from '/lib/xterm-fit/lib/addon-fit.mjs';

const THEME = {
  background: '#050a12',
  foreground: '#ddf6ff',
  cursor: '#3df5ff',
  selectionBackground: 'rgba(61,245,255,.3)',
  black: '#0a1120',
  brightBlack: '#4f7a90',
  cyan: '#3df5ff',
  brightCyan: '#b8fcff',
  yellow: '#ffb020',
  red: '#ff4d6d',
  green: '#4dffa6',
};

/**
 * @param {HTMLElement} host
 * @param {string} id agent id
 * @param {{fontSize?: number, onFocus?: () => void}} [opts]
 */
export function createTerminal(host, id, opts = {}) {
  host.innerHTML = '';
  const term = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, 'Noto Sans SC', monospace", fontSize: opts.fontSize || 13, cursorBlink: true, scrollback: 5000, theme: THEME });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
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
  ws.onclose = () => term.write('\r\n\x1b[90m[与终端的连接已断开]\x1b[0m\r\n');
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
