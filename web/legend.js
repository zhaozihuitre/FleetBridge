// The status lights' legend: a small panel next to the button that opened it (the ? by the command desk's light,
// the phone's ?, or the theme menu's "Status lights…", which anchors it to the ?). It floats over the page
// without pushing anything aside, opens only when asked, and closes on the button again, a click outside or
// Esc; nothing remembers it open.
import { L } from './i18n.js';
import { legendHtml } from './status.js';

let pop = null;
let owner = null;

const isOpen = () => Boolean(pop && !pop.hidden);

function place() {
  if (!isOpen() || !owner) return;
  const r = owner.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  // under the button, its right edge on the button's (inside the window)
  const left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}

export function openLegend(btn) {
  if (!btn) return;
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'lamp-legend';
    pop.className = 'lamp-legend-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', L('状态灯图例'));
    pop.hidden = true;
    document.body.append(pop);
  }
  if (owner && owner !== btn) owner.setAttribute('aria-expanded', 'false');
  owner = btn;
  pop.innerHTML = `<h4>${L('状态灯图例')}</h4>${legendHtml()}`;
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  place();
}

export function closeLegend(refocus = false) {
  if (!isOpen()) return;
  pop.hidden = true;
  owner?.setAttribute('aria-expanded', 'false');
  if (refocus) owner?.focus();
  owner = null;
}

/** The ? button: open, or close if this button opened it. */
export function toggleLegend(btn) {
  if (isOpen() && owner === btn) closeLegend();
  else openLegend(btn);
}

// a press outside it (or its button: that one toggles on its own click) closes it
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!isOpen()) return;
    if (pop.contains(e.target) || owner?.contains(e.target)) return;
    closeLegend();
  },
  true,
);
// (first, so the same Esc doesn't also close what is under it)
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      closeLegend(true);
    }
  },
  true,
);
addEventListener('resize', place);
document.addEventListener('scroll', (e) => !pop?.contains(e.target) && place(), true);
