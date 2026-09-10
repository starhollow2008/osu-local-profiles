/** Number, percentage and time formatting, matching how osu! presents each value. */

export function fmt(n, digits = 0) {
  return Number(n ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** osu! shows accuracy to two decimals, from a 0..1 fraction. */
export function pct(fraction, digits = 2) {
  return `${fmt((fraction ?? 0) * 100, digits)}%`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

const UNITS = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** "3 hours ago", the way the profile page timestamps every score. */
export function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return '';
  if (Math.abs(diff) < 45_000) return 'just now';

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return rtf.format(-Math.round(diff / size), unit);
  }
  return 'just now';
}

export function fullDate(ms) {
  return new Date(ms).toLocaleString();
}

/** "9 Sep 2026" -- a date with no time, for somewhere too narrow to carry one. */
export function shortDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "Sep 2026" -- the x-axis label on the monthly playcount chart. */
export function monthLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function dayLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const MODE_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];
