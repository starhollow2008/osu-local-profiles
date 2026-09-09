/**
 * The two charts on the profile page, as inline SVG. No charting library, so nothing to
 * fetch and nothing to keep up to date.
 *
 * Both stretch with `preserveAspectRatio="none"` and draw in a 0..100 coordinate space,
 * which keeps them responsive without measuring the DOM. The consequence is that anything
 * round would come out elliptical and any text would be sheared -- so there is neither.
 * Axis labels are HTML alongside the SVG, and strokes use `vector-effect` so they keep an
 * even weight however the box is scaled.
 */
import { dayLabel, escapeHtml, fmt, monthLabel } from './format.js';

const EMPTY = (message) => `<div class="profile-detail-stats__empty-chart">${escapeHtml(message)}</div>`;

function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * pp over time. osu-web plots global rank here; a fresh profile has no rank until Phase 3
 * implements estimation, and pp is the honest equivalent it does have.
 */
export function ppChart(input, emptyMessage = 'no ranked plays yet') {
  if (!input || input.length === 0) return EMPTY(emptyMessage);

  // A profile that has only ever been played on one day has a single point, which would
  // draw as an invisible zero-length path. Extend it into a flat line instead.
  const points = input.length === 1 ? [input[0], { ...input[0], at: input[0].at + 1 }] : input;

  const [minX, maxX] = extent(points.map((p) => p.at));
  const [, maxY] = extent(points.map((p) => p.pp));
  // Anchor the baseline at zero: a fresh profile starts there, and letting the floor
  // float would make a 2pp wobble look like a career.
  const spanX = maxX - minX || 1;
  const spanY = maxY || 1;

  const at = (p) => {
    const x = ((p.at - minX) / spanX) * 100;
    const y = 96 - (p.pp / spanY) * 92;
    return [x, y];
  };

  const coords = points.map(at);
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} L${last[0].toFixed(2)} 100 L${first[0].toFixed(2)} 100 Z`;

  const from = dayLabel(minX);
  const to = dayLabel(maxX);
  const range = from === to ? from : `${from} - ${to}`;

  // The fill fades out downwards rather than sitting as a flat slab, which matters most
  // early on: one day's worth of data is a flat line with the whole chart beneath it.
  const grad = `ppfill${Math.random().toString(36).slice(2, 8)}`;

  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
      <!-- style=, not stop-color=: var() is CSS and is not substituted in SVG
           presentation attributes. -->
      <stop offset="0" style="stop-color: hsl(var(--hsl-h1)); stop-opacity: .35"/>
      <stop offset="1" style="stop-color: hsl(var(--hsl-h1)); stop-opacity: 0"/>
    </linearGradient>
  </defs>
  <path d="${area}" fill="url(#${grad})"/>
  <path class="chart__line" d="${line}" vector-effect="non-scaling-stroke"/>
</svg>
<div class="chart__caption">
  <span>${escapeHtml(range)}</span>
</div>`;
}

/**
 * Global rank over time, which is what osu-web actually charts here.
 *
 * Two differences from the pp chart: the axis is inverted, because a *smaller* rank is
 * better and belongs at the top; and it is log-scaled, because rank spans six orders of
 * magnitude and a fresh profile lives in the long tail where a linear axis would flatten
 * every gain to nothing.
 */
export function rankChart(input) {
  if (!input || input.length === 0) return EMPTY('unranked');

  const points = input.length === 1 ? [input[0], { ...input[0], at: input[0].at + 1 }] : input;

  const [minX, maxX] = extent(points.map((p) => p.at));
  const [bestRank, worstRank] = extent(points.map((p) => p.rank));
  const spanX = maxX - minX || 1;
  const lo = Math.log(bestRank);
  const hi = Math.log(worstRank);
  const spanY = hi - lo;

  const coords = points.map((p) => {
    const x = ((p.at - minX) / spanX) * 100;
    // A flat series has no span; park it mid-chart rather than dividing by zero.
    const y = spanY > 0 ? 4 + ((Math.log(p.rank) - lo) / spanY) * 92 : 50;
    return [x, y];
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const from = dayLabel(minX);
  const to = dayLabel(maxX);

  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
  <path class="chart__line" d="${line}" vector-effect="non-scaling-stroke"/>
</svg>
<div class="chart__caption">
  <span>${escapeHtml(from === to ? from : `${from} - ${to}`)}</span>
</div>`;
}

/** Monthly play counts, the bar chart in the Historical section. */
export function playcountChart(points) {
  if (!points || points.length === 0) return '';

  const [, maxY] = extent(points.map((p) => p.count));
  const spanY = maxY || 1;
  const slot = 100 / points.length;
  // Capped, or a profile with one tracked month renders as a single full-width slab.
  const width = Math.min(Math.max(slot * 0.6, slot - 1.5), 8);

  const bars = points
    .map((p, i) => {
      const h = (p.count / spanY) * 96;
      const x = i * slot + (slot - width) / 2;
      return `<rect class="chart__bar" x="${x.toFixed(2)}" y="${(100 - h).toFixed(2)}"
        width="${width.toFixed(2)}" height="${Math.max(h, p.count > 0 ? 0.8 : 0).toFixed(2)}"/>`;
    })
    .join('');

  // Labelling every month gets unreadable fast, so thin them to at most eight.
  const step = Math.ceil(points.length / 8);
  const labels = points
    .map((p, i) =>
      i % step === 0 || i === points.length - 1
        ? `<span style="left:${(i * slot + slot / 2).toFixed(2)}%">${escapeHtml(monthLabel(p.at))}</span>`
        : '',
    )
    .join('');

  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>
<div class="chart__months">${labels}</div>
<div class="chart__peak">peak ${fmt(maxY)} play${maxY === 1 ? '' : 's'}</div>`;
}
