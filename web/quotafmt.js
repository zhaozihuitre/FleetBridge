// How a quota's reset is told, the same everywhere (the top bar, the terminal cards, the master's panel, the
// phone): what is used and when it resets in local time, "今天 18:10 重置", "明天 09:00 重置", "11/23 13:00 重置";
// in its last hour a countdown first: "还有 25 分钟 · 13:10 重置". No DOM here (tested under node): L comes in.

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param {(zh: string, ...args: any[]) => string} L the page's translator (web/i18n.js)
 */
export function quotaText(L) {
  const hm = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  /** A time with its day, local: "今天 16:20", "明天 09:00", "11/9 14:00". */
  const when = (ms, now = Date.now()) => {
    const d = new Date(ms);
    const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
    const t = hm(ms);
    return days === 0 ? L('今天 {0}', t) : days === 1 ? L('明天 {0}', t) : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
  };
  /** When a window resets; its last hour counts down. */
  const resetText = (at, now = Date.now()) => {
    if (!(at > 0)) return L('未开始');
    const left = at - now;
    if (left <= 0) return L('即将重置');
    if (left < 3_600_000) return L('还有 {0} 分钟 · {1} 重置', Math.max(1, Math.ceil(left / 60_000)), hm(at));
    return L('{0} 重置', when(at, now));
  };
  /** One limit in a line: "5 小时 69% · 13:10 重置" (a label as the server gives it). */
  const limitLine = (l, now = Date.now()) => `${l.label} ${Math.round(Math.min(100, Math.max(0, Number(l.usedPct) || 0)))}% · ${resetText(l.resetsAt, now)}`;
  /** A model without a limit of its own (server/modelquota.js ownNote): it has none, or the usage API, the only
   * source of per-model limits, could not be read ("本周 · Fable 5.2：读不到（额度接口 http_403）"). */
  const ownText = (n) => (!n ? '' : n.reason === 'unread' ? L('本周 · {0}：读不到（额度接口 {1}）', n.name, n.error || L('未连上')) : L('本周 · {0}：无单独额度', n.name));
  return { when, resetText, limitLine, ownText };
}

/** The limit holding things back now: the one gating requests (active), else the most used. */
export function tightest(limits) {
  const list = (limits || []).filter((l) => l && Number.isFinite(Number(l.usedPct)));
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.active ? 1000 : 0) + Number(b.usedPct) > (a.active ? 1000 : 0) + Number(a.usedPct) ? b : a));
}
