// The fleet radar (deep-space bridge theme): a sweep with a fading trail over rings, ticks and bearings, every
// terminal a blip in its status light's color. A blip flares and shows its name as the sweep passes; one that
// waits on you (approval, an answer) or has an error pulses and keeps its name up. onHit(blip) fires as the sweep
// crosses a blip (the page lights the terminal's card; an optional ping). Canvas, 30 fps at most, nothing drawn
// while the page is hidden; under "reduce motion" a still picture (no sweep motion, every blip lit).
const TAU = Math.PI * 2;
const URGENT = new Set(['permit', 'question', 'error']);

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

// a CSS color (var(), color-mix()) as rgb numbers, through a probe element
const probe = typeof document !== 'undefined' ? document.createElement('i') : null;
const cache = new Map();
function rgbOf(css) {
  if (cache.has(css)) return cache.get(css);
  probe.style.color = css;
  probe.style.display = 'none';
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  let v = [120, 200, 255];
  const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  const s = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) v = [+m[1], +m[2], +m[3]];
  else if (s) v = [s[1] * 255, s[2] * 255, s[3] * 255].map(Math.round);
  cache.set(css, v);
  return v;
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ accent?: string, period?: number, onHit?: (b: object) => void, label?: (b: object) => string, still?: () => boolean }} o
 *   accent: CSS color of the rings and sweep; period: seconds per turn
 */
export function createRadar(canvas, o = {}) {
  const g = canvas.getContext('2d');
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  // o.still: an override (a page's own switch), else the system's reduce-motion setting
  const still = { get matches() { return o.still ? o.still() || mq.matches : mq.matches; } };
  const period = (o.period || 4) * 1000;
  let blips = [];
  let W = 0;
  let H = 0;
  let raf = 0;
  let lastDraw = 0;
  let prevAngle = 0;
  const t0 = performance.now();

  function size() {
    const r = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * r);
    canvas.height = Math.round(H * r);
    g.setTransform(r, 0, 0, r, 0, 0);
  }

  /** blips: [{ id, name, state, color }] (state: a status.js key; color: its light's CSS color) */
  function setBlips(list) {
    const old = new Map(blips.map((b) => [b.id, b]));
    // bearings spread evenly round the scope in a stable order (by id), a little jitter so it doesn't look ruled
    const order = [...list].map((b) => b.id).sort();
    const n = Math.max(1, list.length);
    blips = list.map((b) => {
      const h = hash(b.id);
      const i = order.indexOf(b.id);
      const prev = old.get(b.id);
      const urgent = URGENT.has(b.state);
      return {
        ...b,
        urgent,
        // a stable bearing per terminal; the urgent ones closer in
        angle: (((i + 0.15 + h * 0.5) / n) % 1) * TAU,
        dist: urgent ? 0.48 + hash(b.id + 'r') * 0.14 : 0.66 + hash(b.id + 'r') * 0.24,
        rgb: rgbOf(b.color),
        hitAt: prev?.hitAt || 0,
      };
    });
    if (still.matches || !raf) draw(performance.now());
  }

  function draw(now) {
    const accent = rgbOf(o.accent || 'var(--cyan)');
    const R = Math.min(W, H) / 2 - 18; // room for the bearings outside the ring
    const cx = W / 2;
    const cy = H / 2;
    const moving = !still.matches;
    const a = moving ? (((now - t0) % period) / period) * TAU : TAU * 0.12; // 0 = north, clockwise
    g.clearRect(0, 0, W, H);
    g.save();
    g.translate(cx, cy);
    // the scope's glass
    const glass = g.createRadialGradient(0, 0, 0, 0, 0, R);
    glass.addColorStop(0, rgba(accent, 0.1));
    glass.addColorStop(1, rgba(accent, 0.02));
    g.fillStyle = glass;
    g.beginPath();
    g.arc(0, 0, R, 0, TAU);
    g.fill();
    // rings and the cross
    g.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      g.strokeStyle = rgba(accent, i === 4 ? 0.55 : 0.2);
      g.lineWidth = i === 4 ? 1.5 : 1;
      g.beginPath();
      g.arc(0, 0, (R * i) / 4, 0, TAU);
      g.stroke();
    }
    g.strokeStyle = rgba(accent, 0.14);
    g.beginPath();
    g.moveTo(-R, 0);
    g.lineTo(R, 0);
    g.moveTo(0, -R);
    g.lineTo(0, R);
    g.stroke();
    // ticks every 5°, longer every 30° with the bearing
    g.font = '600 9px Orbitron, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const t = (d / 360) * TAU;
      const sx = Math.sin(t);
      const sy = -Math.cos(t);
      const long = d % 30 === 0;
      g.strokeStyle = rgba(accent, long ? 0.6 : 0.3);
      g.beginPath();
      g.moveTo(sx * R, sy * R);
      g.lineTo(sx * (R - (long ? 8 : 4)), sy * (R - (long ? 8 : 4)));
      g.stroke();
      if (long) {
        g.fillStyle = rgba(accent, 0.65);
        g.fillText(String(d).padStart(3, '0'), sx * (R + 9), sy * (R + 9));
      }
    }
    // the sweep: a fading trail behind the line (a conic gradient over 70°)
    const trail = (70 / 360) * TAU;
    const cg = g.createConicGradient(a - trail - Math.PI / 2, 0, 0);
    cg.addColorStop(0, rgba(accent, 0));
    cg.addColorStop(trail / TAU, rgba(accent, 0.38));
    cg.addColorStop(trail / TAU + 0.0001, rgba(accent, 0));
    g.fillStyle = cg;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R, a - trail - Math.PI / 2, a - Math.PI / 2);
    g.closePath();
    g.fill();
    g.strokeStyle = rgba(accent, 0.95);
    g.lineWidth = 1.5;
    g.shadowColor = rgba(accent, 0.9);
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.sin(a) * R, -Math.cos(a) * R);
    g.stroke();
    g.shadowBlur = 0;
    // the blips
    const labels = [];
    for (const b of blips) {
      // crossed since the last frame: a hit
      if (moving) {
        const crossed = prevAngle <= a ? b.angle > prevAngle && b.angle <= a : b.angle > prevAngle || b.angle <= a;
        if (crossed && now - b.hitAt > 500) {
          b.hitAt = now;
          o.onHit?.(b);
        }
      }
      const since = moving ? (now - b.hitAt) / period : 0; // turns since the sweep passed
      const glow = moving ? Math.max(0, 1 - since * 1.3) : 1; // afterglow: fades over most of a turn
      const x = Math.sin(b.angle) * b.dist * R;
      const y = -Math.cos(b.angle) * b.dist * R;
      const base = b.urgent ? 0.75 : 0.35;
      const alpha = Math.max(base, glow);
      // urgent: a ring pulsing out from it
      if (b.urgent) {
        const p = moving ? ((now - t0) % 1200) / 1200 : 0.5;
        g.strokeStyle = rgba(b.rgb, (1 - p) * 0.8);
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, 4 + p * 12, 0, TAU);
        g.stroke();
      }
      g.fillStyle = rgba(b.rgb, alpha);
      g.shadowColor = rgba(b.rgb, alpha);
      g.shadowBlur = 6 + glow * 10;
      g.beginPath();
      g.arc(x, y, b.urgent ? 4 : 3 + glow * 1.5, 0, TAU);
      g.fill();
      g.shadowBlur = 0;
      // its name: while the sweep has just passed, always for an urgent one (drawn after every blip)
      const show = b.urgent ? 1 : moving ? Math.max(0, 1 - since * 2.2) : 0;
      if (show > 0.02) labels.push({ b, x, y, show });
    }
    // the names: the urgent ones placed first; one that would overlap another moves up or down (away from the
    // middle) with a thin line back to its blip
    g.font = '600 11px "Segoe UI", "Microsoft YaHei", sans-serif';
    g.textBaseline = 'middle';
    const placed = [];
    labels.sort((p, q) => Number(q.b.urgent) - Number(p.b.urgent));
    for (const { b, x, y, show } of labels) {
      const text = (o.label ? o.label(b) : b.name) || '';
      const w = g.measureText(text).width + 8;
      const left = x > 0 ? x - 9 - w + 4 : x + 9 - 4;
      let top = y - 8;
      const hits = () => placed.some((r) => left < r.l + r.w && left + w > r.l && top < r.t + 16 && top + 16 > r.t);
      for (let i = 0; i < 5 && hits(); i++) top += y < 0 ? -15 : 15;
      placed.push({ l: left, t: top, w });
      if (Math.abs(top - (y - 8)) > 1) {
        g.strokeStyle = rgba(b.rgb, 0.5 * show);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x > 0 ? left + w : left, top + 8);
        g.stroke();
      }
      g.fillStyle = `rgba(0,0,0,${(0.6 * show).toFixed(2)})`;
      g.fillRect(left, top, w, 16);
      g.fillStyle = rgba(b.rgb, show);
      g.textAlign = 'left';
      g.fillText(text, left + 4, top + 8);
    }
    g.restore();
    prevAngle = a;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden || still.matches) return;
    if (now - lastDraw < 1000 / 30) return;
    lastDraw = now;
    draw(now);
  }

  function start() {
    size();
    if (!raf) raf = requestAnimationFrame(loop);
    draw(performance.now());
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  const onResize = () => (size(), draw(performance.now()));
  addEventListener('resize', onResize);
  mq.addEventListener?.('change', () => draw(performance.now()));
  return {
    start,
    stop,
    setBlips,
    resize: onResize,
    destroy() {
      stop();
      removeEventListener('resize', onResize);
    },
  };
}

/** A short ping (Web Audio), quiet; urgent: two notes. */
let ac = null;
export function ping(urgent = false, volume = 0.08) {
  try {
    ac ||= new AudioContext();
    const t = ac.currentTime;
    const notes = urgent ? [1320, 990] : [1180];
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      const v = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + i * 0.09);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, t + i * 0.09 + 0.12);
      v.gain.setValueAtTime(0.0001, t + i * 0.09);
      v.gain.exponentialRampToValueAtTime(volume, t + i * 0.09 + 0.01);
      v.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
      o.connect(v).connect(ac.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.18);
    });
  } catch {
    // no audio
  }
}
