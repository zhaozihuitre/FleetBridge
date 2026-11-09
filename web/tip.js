// The status lights' tooltip: what a light is about (the permission asked, the question, the error, the last
// report) and how long it has been so, in the theme's colors (a native title tooltip is the OS's own white).
// Shown on hover and keyboard focus; a tap on a phone. Elements carry data-lamp / data-lamp-text /
// data-lamp-since (status.js lampAttrs).
import { L } from './i18n.js';
import { STATES, lamp, lampRate } from './status.js';

let el = null;
let anchor = null;
let shownAt = 0;

function since(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return L('{0} 秒', s);
  const m = Math.floor(s / 60);
  if (m < 60) return L('{0} 分 {1} 秒', m, s % 60);
  const h = Math.floor(m / 60);
  if (h < 24) return L('{0} 小时 {1} 分', h, m % 60);
  return L('{0} 天 {1} 小时', Math.floor(h / 24), h % 24);
}

function render() {
  const key = anchor.dataset.lamp;
  const s = STATES[key];
  if (!s) return;
  const at = Number(anchor.dataset.lampSince) || 0;
  const span = at ? L('已持续 {0}', since(Date.now() - at)) : '';
  el.style.setProperty('--lc', s.color);
  const div = (cls, t) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = t;
    return d;
  };
  el.innerHTML = `<b>${lamp(key, at)}</b>`;
  el.firstChild.append(s.label());
  el.append(div('q', anchor.dataset.lampText || s.what()), div('m', [span, lampRate(key)].filter(Boolean).join(' · ')));
}

function place() {
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function show(target) {
  if (target !== anchor) shownAt = Date.now();
  anchor = target;
  if (!el) {
    el = document.createElement('div');
    el.className = 'lamp-tip';
    el.setAttribute('role', 'tooltip');
    el.id = 'lamp-tip';
    document.body.append(el);
  }
  render();
  el.hidden = false;
  place();
  anchor.setAttribute('aria-describedby', 'lamp-tip');
}

function hide() {
  if (!el || el.hidden) return;
  el.hidden = true;
  anchor?.removeAttribute('aria-describedby');
  anchor = null;
}

const target = (e) => e.target.closest?.('[data-lamp]');
document.addEventListener('mouseover', (e) => {
  const t = target(e);
  if (t) t !== anchor && show(t);
  // (on a touch screen it closes on a tap elsewhere, not on the mouse events a tap emulates)
  else if (anchor && !anchor.contains(e.target) && !matchMedia('(hover: none)').matches) hide();
});
document.addEventListener('focusin', (e) => {
  const t = target(e);
  t ? show(t) : hide();
});
document.addEventListener('focusout', (e) => target(e) === anchor && hide());
document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
// scrolling (or a re-render shifting the page): it follows its light, gone with it when that leaves the screen
document.addEventListener('scroll', () => anchor && (anchor.isConnected ? place() : hide()), true);
// touch: a tap on a light shows its tooltip instead of opening the card under it; a tap elsewhere hides it
document.addEventListener(
  'click',
  (e) => {
    const t = target(e);
    if (t && matchMedia('(hover: none)').matches) {
      e.preventDefault();
      e.stopPropagation();
      // (a tap fires mouseover first, which already showed it: only a second tap closes it)
      t === anchor && Date.now() - shownAt > 600 ? hide() : show(t);
    } else if (!t) hide();
  },
  true,
);
// the content may change under it (a re-render replaced the element): follow the new one under the pointer
let px = -1;
let py = -1;
document.addEventListener('mousemove', (e) => ((px = e.clientX), (py = e.clientY)), { passive: true });
setInterval(() => {
  if (!anchor) return;
  if (!anchor.isConnected) {
    // the same light re-rendered (same state, same words), else whatever light is under the pointer
    const same = [...document.querySelectorAll(`[data-lamp="${anchor.dataset.lamp}"]`)].find((e) => e.dataset.lampText === anchor.dataset.lampText);
    const again = same || (px >= 0 && document.elementFromPoint(px, py)?.closest('[data-lamp]'));
    if (!again) return hide();
    anchor = again;
  }
  render();
  place();
}, 1000);
