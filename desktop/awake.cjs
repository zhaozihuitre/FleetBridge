// Keep the computer awake while the fleet has work: a sleeping PC stops every agent, and the phone
// page and push notifications go quiet with it. Electron's powerSaveBlocker asks Windows not to sleep
// (and, optionally, not to turn the screen off); it is released as soon as the work is done.
// It can't stop a manual sleep, a closed lid, or a group policy that forces sleep.
const { powerSaveBlocker } = require('electron');

const MODES = ['busy', 'always', 'off']; // the menu item cycles through these
const GRACE = 3 * 60_000; // stay awake a little after the last turn ends, for the next order

let mode = 'busy';
let screen = false; // also keep the display on
let lastWork = 0;
let blocker = null; // { id, type }
let onChange = () => {};

function apply(now = Date.now()) {
  const want = mode === 'always' || (mode === 'busy' && now - lastWork < GRACE);
  const type = screen ? 'prevent-display-sleep' : 'prevent-app-suspension';
  if (blocker && (!want || blocker.type !== type)) {
    powerSaveBlocker.stop(blocker.id);
    blocker = null;
  }
  if (want && !blocker) blocker = { id: powerSaveBlocker.start(type), type };
  return Boolean(blocker);
}

/** busy(): whether any agent is working, waiting on a permission prompt, or has queued orders. */
function startAwake({ mode: m, screen: s, busy, changed }) {
  mode = MODES.includes(m) ? m : 'busy';
  screen = Boolean(s);
  onChange = changed || onChange;
  let was = null;
  const tick = () => {
    try {
      if (busy()) lastWork = Date.now();
    } catch {
      // server not up yet
    }
    const on = apply();
    if (on !== was) {
      was = on;
      onChange();
    }
  };
  tick();
  setInterval(tick, 10_000).unref?.();
  return tick;
}

function setAwake(patch) {
  if (patch.mode && MODES.includes(patch.mode)) mode = patch.mode;
  if (patch.screen != null) screen = Boolean(patch.screen);
  apply();
}

const nextMode = () => MODES[(MODES.indexOf(mode) + 1) % MODES.length];
const awakeInfo = () => ({ awakeMode: mode, awakeScreen: screen, awakeOn: Boolean(blocker) });

function stopAwake() {
  if (blocker) powerSaveBlocker.stop(blocker.id);
  blocker = null;
}

module.exports = { startAwake, setAwake, nextMode, awakeInfo, stopAwake };
