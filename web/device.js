// Which page a device gets over web access: one address (and one QR code) for all, then
//   phone            -> /m, the phone page
//   tablet, computer -> /, the command center (the same page as on the computer itself)
// Judged by the screen first (its short side, a touch screen), the User-Agent only helps: an iPad asks
// as a Mac ("Macintosh" in its UA) but has a multi-touch screen, and is a tablet. A choice made with
// "full version / phone version" on either page is kept on this device and wins.
export const VIEW_KEY = 'fb-view'; // 'full' | 'phone'

/** 'phone' | 'tablet' | 'desktop' */
export function deviceKind() {
  const ua = navigator.userAgent || '';
  const touches = navigator.maxTouchPoints || 0;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touch = touches > 0 || coarse;
  const short = Math.min(screen.width || innerWidth, screen.height || innerHeight);
  const iPadAsMac = /Macintosh/.test(ua) && touches > 1; // iPadOS 13+ in its default "desktop" mode
  if (iPadAsMac || /iPad/.test(ua)) return 'tablet';
  // a small touch screen is a phone, whatever it calls itself; a phone's UA backs up a borderline size
  if (touch && short < 600) return 'phone';
  if (/iPhone|iPod|Windows Phone|Android.+Mobile|Mobile.+Firefox/.test(ua) && short < 760) return 'phone';
  if (touch && /Android/.test(ua)) return 'tablet';
  return 'desktop';
}

export function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

/** Remembers the choice on this device and goes to that page. */
export function switchView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // not kept: still go there now
  }
  location.replace(view === 'phone' ? '/m' : '/');
}

/** The view this device should have: its saved choice, else by the device. */
export const wantedView = () => savedView() || (deviceKind() === 'phone' ? 'phone' : 'full');
