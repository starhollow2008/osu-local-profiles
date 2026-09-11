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

/** "Sep 2026" -- the x-axis label on the play history chart. osu-web's `MMM YYYY`. */
export function monthLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "September 2026" -- the month in a chart tooltip. osu-web's `MMMM YYYY`. */
export function monthTitle(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Total Play Time as osu-web's `playTimeStrings` writes it: `2d 5h 13m` on the page, with
 * `53 hours` -- or `97 minutes`, below two hours -- as the hover title. Days only appear
 * once there is at least one.
 */
export function playTimeStrings(seconds) {
  const totalMinutes = Math.floor((seconds ?? 0) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const roundedHours = Math.round((seconds ?? 0) / 3600);
  const title =
    roundedHours < 2
      ? `${fmt(totalMinutes)} minute${totalMinutes === 1 ? '' : 's'}`
      : `${fmt(roundedHours)} hours`;

  return { title, value: `${days > 0 ? `${fmt(days)}d ` : ''}${hours}h ${minutes}m` };
}

const DAY_MS = 86_400_000;

/**
 * "40 days ago", or "now" for today.
 *
 * The rank chart's x axis on osu! is days-ago rather than a date, and its tooltip says so
 * in those words (`common.time.days_ago`, with `now` at zero). Counted in whole UTC days,
 * because that is the granularity the chart itself has -- one point per day.
 */
export function daysAgoLabel(ms) {
  const days = Math.round((Date.now() - ms) / DAY_MS);
  if (days <= 0) return 'now';
  return `${fmt(days)} day${days === 1 ? '' : 's'} ago`;
}

export function dayLabel(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const MODE_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];
