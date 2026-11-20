import { L } from './i18n.js';

// When a quota resets, in the words the notices use (the page has the same in web/quotafmt.js): local time,
// "今天 18:10 重置", "明天 09:00 重置", "11/23 13:00 重置", its last hour "还有 25 分钟 · 13:10 重置".

const pad = (n) => String(n).padStart(2, '0');
const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function whenText(ms, now = Date.now()) {
  const d = new Date(ms);
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const t = hm(ms);
  return days === 0 ? L(`今天 ${t}`, `today ${t}`, `今日 ${t}`) : days === 1 ? L(`明天 ${t}`, `tomorrow ${t}`, `明日 ${t}`) : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

export function resetText(at, now = Date.now()) {
  if (!(at > 0)) return L('未开始', 'not started', '未開始');
  const left = at - now;
  if (left <= 0) return L('即将重置', 'resetting now', 'まもなくリセット');
  if (left < 3_600_000) {
    const m = Math.max(1, Math.ceil(left / 60_000));
    return L(`还有 ${m} 分钟 · ${hm(at)} 重置`, `${m} min left · resets ${hm(at)}`, `あと ${m} 分 · ${hm(at)} にリセット`);
  }
  const w = whenText(at, now);
  return L(`${w} 重置`, `resets ${w}`, `${w} にリセット`);
}

/** The limit stopping requests now: the one gating (active), else the most used; started ones only. */
export function gatingLimit(limits, now = Date.now()) {
  const list = (limits || []).filter((l) => l && l.resetsAt > now && Number.isFinite(Number(l.usedPct)));
  if (!list.length) return null;
  return list.reduce((a, b) => ((b.active ? 1000 : 0) + Number(b.usedPct) > (a.active ? 1000 : 0) + Number(a.usedPct) ? b : a));
}
