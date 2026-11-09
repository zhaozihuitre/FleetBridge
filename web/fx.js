// The flagship themes' background layer (holo, cyber, bridge; theme.js sets <html data-fx>): one fixed layer
// behind every page's content holding the theme's backdrop (fx.css), the holo scan line and the bridge's
// starfield (a canvas, 24 frames a second). Low cost by design: the canvas only runs on the command center and a
// popped-out terminal (the phone gets still stars, the widget no layer at all: it is always on screen), stops
// while the page is hidden or minimized, and under "reduce motion" is drawn once, still.
const page = /\/widget\b/.test(location.pathname) ? 'widget' : /^\/m\b/.test(location.pathname) ? 'phone' : /\/term\b/.test(location.pathname) ? 'term' : 'main';
document.documentElement.classList.add('fx-' + page);

const still = matchMedia('(prefers-reduced-motion: reduce)');
let layer = null;
let canvas = null;

function build() {
  if (layer || page === 'widget' || !document.body) return;
  layer = document.createElement('div');
  layer.className = 'fx-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<i class="fx-sweep"></i><i class="fx-horizon"></i>';
  document.body.prepend(layer);
}

// ---- the starfield (bridge): three layers drifting left at their own pace, twinkling a little ----
let stars = [];
let W = 0;
let H = 0;
let g = null;
function size() {
  if (!canvas) return;
  const r = Math.min(2, devicePixelRatio || 1);
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * r);
  canvas.height = Math.round(H * r);
  g.setTransform(r, 0, 0, r, 0, 0);
  stars = Array.from({ length: Math.round((W * H) / 9000) }, () => {
    const l = Math.random();
    return { x: Math.random() * W, y: Math.random() * H, z: l < 0.6 ? 1 : l < 0.9 ? 2 : 3, t: Math.random() * 6.28 };
  });
  draw(0);
}
function draw(dt) {
  g.clearRect(0, 0, W, H);
  for (const s of stars) {
    s.x -= s.z * 2.2 * dt;
    if (s.x < -2) {
      s.x = W + 2;
      s.y = Math.random() * H;
    }
    s.t += dt * (0.6 + s.z * 0.3);
    const a = (0.35 + s.z * 0.18) * (0.75 + 0.25 * Math.sin(s.t));
    g.fillStyle = s.z === 3 ? `rgba(190,220,255,${a.toFixed(2)})` : `rgba(150,180,235,${a.toFixed(2)})`;
    g.fillRect(s.x, s.y, s.z * 0.7, s.z * 0.7);
  }
}
let timer = 0;
let last = 0;
function tick() {
  timer = 0;
  if (!running()) return;
  const now = performance.now();
  draw(Math.min(0.2, (now - last) / 1000));
  last = now;
  timer = setTimeout(tick, 1000 / 24);
}
const running = () => canvas && document.documentElement.dataset.fx === 'bridge' && !document.hidden && !still.matches;
function sync() {
  const fx = document.documentElement.dataset.fx;
  if (fx) build();
  // the stars: only where they belong, made the first time the bridge theme is on
  if (fx === 'bridge' && layer && !canvas && (page === 'main' || page === 'term')) {
    canvas = document.createElement('canvas');
    canvas.className = 'fx-stars';
    layer.prepend(canvas);
    g = canvas.getContext('2d');
    size();
  }
  // a hidden page: the CSS effects pause too (the browser mostly stops them anyway)
  document.documentElement.classList.toggle('fx-paused', document.hidden);
  if (running() && !timer) {
    last = performance.now();
    timer = setTimeout(tick, 1000 / 24);
  } else if (canvas && still.matches) draw(0);
}

new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fx'] });
document.addEventListener('visibilitychange', sync);
still.addEventListener?.('change', sync);
addEventListener('resize', () => canvas && size());
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
else sync();
