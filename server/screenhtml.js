// An agent's screen as colored HTML for the phone page, read from its headless terminal copy.
// The 16 colors mirror the xterm theme in web/terminal.js (dark-ansi Claude draws with these).
const PALETTE = [
  '#0a1120', '#ff4d6d', '#4dffa6', '#ffb020', '#4d9fff', '#c77dff', '#3df5ff', '#86b89c',
  '#24384a', '#3df5ff', '#8affc4', '#ffd166', '#82bcff', '#dcaaff', '#b8fcff', '#dcf8e8',
];
const FG = '#a6e8c0';
const BG = '#050a12';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// xterm's 256-color table beyond the first 16: a 6x6x6 cube, then a gray ramp
function color256(i) {
  if (i < 16) return PALETTE[i];
  if (i < 232) {
    const c = i - 16;
    const v = (x) => (x ? 55 + x * 40 : 0);
    return hex((v(Math.floor(c / 36)) << 16) | (v(Math.floor(c / 6) % 6) << 8) | v(c % 6));
  }
  const g = 8 + (i - 232) * 10;
  return hex((g << 16) | (g << 8) | g);
}

function colorOf(cell, fg) {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const v = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return hex(v);
  return color256(v);
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** The visible screen as HTML lines: runs of cells with the same look become one <span>. */
export function screenHtml(screen) {
  const b = screen?.buffer.active;
  if (!b) return [];
  const cell = b.getNullCell();
  const lines = [];
  for (let y = b.viewportY; y < b.viewportY + screen.rows; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    let html = '';
    let run = '';
    let style = '';
    const flush = () => {
      if (run) html += style ? `<span style="${style}">${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (let x = 0; x < screen.cols; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // second half of a wide (CJK) character
      let fg = colorOf(cell, true);
      let bg = colorOf(cell, false);
      if (cell.isInverse()) [fg, bg] = [bg || BG, fg || FG];
      const parts = [];
      if (fg) parts.push(`color:${fg}`);
      if (bg) parts.push(`background:${bg}`);
      if (cell.isBold()) parts.push('font-weight:700');
      if (cell.isDim()) parts.push('opacity:.6');
      if (cell.isItalic()) parts.push('font-style:italic');
      if (cell.isUnderline()) parts.push('text-decoration:underline');
      const s = parts.join(';');
      if (s !== style) {
        flush();
        style = s;
      }
      run += cell.getChars() || ' ';
    }
    flush();
    lines.push(html.replace(/(\s|&nbsp;)+$/, ''));
  }
  while (lines.length && !lines[lines.length - 1].replace(/<[^>]+>/g, '').trim()) lines.pop();
  return lines;
}
