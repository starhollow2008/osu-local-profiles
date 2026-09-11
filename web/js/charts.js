/**
 * The profile page's line charts, as inline SVG. No charting library, so nothing to fetch
 * and nothing to keep up to date.
 *
 * The line stretches with `preserveAspectRatio="none"` in a 0..100 coordinate space, which
 * keeps it responsive without measuring the DOM. The consequence is that anything drawn
 * inside it would be sheared -- so the axis labels, the hover marker and the tooltip are all
 * HTML positioned over the plot in percentages, exactly as osu-web does it (its hover circle
 * is a `div`, not an SVG element, for the same reason). Strokes use `vector-effect` so they
 * keep an even weight however the box is scaled.
 *
 * Colours and behaviour follow osu-web's `.line-chart--profile-page`: a #ffcc22 line at 2px,
 * a hover circle filled `--hsl-b5` with a 4px yellow border, a full-height yellow hover
 * line, and a tooltip pinned to a top corner that flips away from the cursor rather than
 * following it.
 */
import { daysAgoLabel, escapeHtml, fmt, monthLabel, monthTitle } from './format.js';

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
 * Build the shared markup: the line, an optional area fill, and the hover layer.
 *
 * `plotted` is `[{ x, y, title, sub }]` where x and y are percentages within the plot and
 * the two strings are the tooltip's lines, already formatted. Formatting at render time
 * rather than on hover is what keeps the hover handler a pure lookup -- it never has to know
 * what kind of chart it is attached to.
 */
function render(plotted, { area = false, labels = '', caption = '' } = {}) {
  const line = plotted
    .map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

  let fill = '';
  if (area) {
    const first = plotted[0];
    const last = plotted[plotted.length - 1];
    // A unique gradient id per chart: several of these can be on the page at once.
    const grad = `fill${Math.random().toString(36).slice(2, 8)}`;
    const path = `${line} L${last.x.toFixed(2)} 100 L${first.x.toFixed(2)} 100 Z`;
    fill = `<defs>
      <linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1">
        <!-- style=, not stop-color=: var() is CSS and is not substituted into SVG
             presentation attributes. -->
        <stop offset="0" style="stop-color: var(--chart-line); stop-opacity: .3"/>
        <stop offset="1" style="stop-color: var(--chart-line); stop-opacity: 0"/>
      </linearGradient>
    </defs>
    <path d="${path}" fill="url(#${grad})"/>`;
  }

  /*
   * The points ride along on the element as JSON. The markup is replaced wholesale on every
   * re-render, so anything held in a variable would be pointing at a detached node; reading
   * it back off the element is what makes `bindCharts` able to run over whatever is on the
   * page without being told what changed.
   */
  const data = escapeHtml(JSON.stringify(plotted));

  return `<div class="chart" data-chart-points="${data}">
  <div class="chart__plot">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      ${fill}
      <path class="chart__line" d="${line}" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="chart__hover" hidden>
      <div class="chart__hover-line"></div>
      <div class="chart__hover-circle"></div>
      <div class="chart__hover-box">
        <div class="chart__hover-y"></div>
        <div class="chart__hover-x"></div>
      </div>
    </div>
  </div>
  ${labels}
  ${caption}
</div>`;
}

/** One point draws as an invisible zero-length path; extend it into a flat line. */
function widen(input) {
  return input.length === 1 ? [input[0], { ...input[0], at: input[0].at + 1 }] : input;
}

function dateCaption(from, to) {
  const a = monthLabel(from);
  const b = monthLabel(to);
  return `<div class="chart__caption"><span>${escapeHtml(a === b ? a : `${a} - ${b}`)}</span></div>`;
}

/**
 * Global rank over time, which is what osu-web charts in this slot.
 *
 * Two things differ from an ordinary series: the axis is inverted, because a *smaller* rank
 * is better and belongs at the top; and it is log-scaled, because rank spans six orders of
 * magnitude and a new profile lives in the long tail where a linear axis would flatten
 * every gain to nothing.
 */
export function rankChart(input) {
  if (!input || input.length === 0) return EMPTY('unranked');

  const points = widen(input);
  const [minX, maxX] = extent(points.map((p) => p.at));
  const [bestRank, worstRank] = extent(points.map((p) => p.rank));
  const spanX = maxX - minX || 1;
  const lo = Math.log(bestRank);
  const spanY = Math.log(worstRank) - lo;

  const plotted = points.map((p) => ({
    x: ((p.at - minX) / spanX) * 100,
    // A flat series has no span; park it mid-chart rather than dividing by zero.
    y: spanY > 0 ? 6 + ((Math.log(p.rank) - lo) / spanY) * 88 : 50,
    // Matches osu-web's `<strong>Global Ranking</strong> #123`. Built only from numbers
    // this app computed, so there is nothing here that needs escaping.
    title: `<strong>Global Ranking</strong> #${fmt(p.rank)}`,
    sub: daysAgoLabel(p.at),
  }));

  return render(plotted, { caption: dateCaption(minX, maxX) });
}

/**
 * pp over time, shown in the same slot when no rank curve exists for the mode.
 *
 * The baseline is anchored at zero rather than at the lowest value: a new profile starts
 * there, and letting the floor float would make a 2pp wobble look like a career.
 */
export function ppChart(input, emptyMessage = 'no ranked plays yet') {
  if (!input || input.length === 0) return EMPTY(emptyMessage);

  const points = widen(input);
  const [minX, maxX] = extent(points.map((p) => p.at));
  const [, maxY] = extent(points.map((p) => p.pp));
  const spanX = maxX - minX || 1;
  const spanY = maxY || 1;

  const plotted = points.map((p) => ({
    x: ((p.at - minX) / spanX) * 100,
    y: 96 - (p.pp / spanY) * 92,
    title: `<strong>Performance</strong> ${fmt(p.pp, 0)}pp`,
    sub: daysAgoLabel(p.at),
  }));

  return render(plotted, { area: true, caption: dateCaption(minX, maxX) });
}

/**
 * Play History: how much was played each month.
 *
 * A line rather than the bars this used to draw, which is what osu! shows and what makes a
 * long history readable -- twenty bars in the width of a section become twenty slivers.
 */
export function playHistoryChart(input) {
  if (!input || input.length === 0) return '';

  const points = widen(input.map((p) => ({ at: p.at, count: p.count })));
  const [minX, maxX] = extent(points.map((p) => p.at));
  const [, maxY] = extent(points.map((p) => p.count));
  const spanX = maxX - minX || 1;
  const spanY = maxY || 1;

  const plotted = points.map((p) => ({
    x: ((p.at - minX) / spanX) * 100,
    y: 94 - (p.count / spanY) * 88,
    // osu-web's `<strong>Plays</strong> 430` over `March 2020`.
    title: `<strong>Plays</strong> ${fmt(p.count)}`,
    sub: monthTitle(p.at),
  }));

  // Labelling every month gets unreadable fast, so thin them to at most eight.
  const step = Math.ceil(points.length / 8);
  const labels = points
    .map((p, i) =>
      i % step === 0 || i === points.length - 1
        ? `<span style="left:${plotted[i].x.toFixed(2)}%">${escapeHtml(monthLabel(p.at))}</span>`
        : '',
    )
    .join('');

  return render(plotted, { area: true, labels: `<div class="chart__months">${labels}</div>` });
}

/* ------------------------------------------------------------------- hover */

/**
 * Make every chart under `root` respond to the mouse.
 *
 * Called after the page writes new markup, since that replaces the nodes any previous
 * listener was attached to. Listeners go on the plot element itself, so they are discarded
 * with it and there is nothing to clean up.
 *
 * The cursor snaps to the *nearest* point rather than interpolating, which is what gives the
 * rank chart its daily granularity and the play history its monthly one: you are always
 * reading a real value that was really recorded, never a number between two of them.
 */
export function bindCharts(root) {
  for (const chart of root.querySelectorAll('.chart[data-chart-points]')) {
    let points;
    try {
      points = JSON.parse(chart.dataset.chartPoints);
    } catch {
      continue; // a malformed chart should not take the page down
    }
    if (!Array.isArray(points) || points.length === 0) continue;

    const plot = chart.querySelector('.chart__plot');
    const hover = chart.querySelector('.chart__hover');
    const line = chart.querySelector('.chart__hover-line');
    const circle = chart.querySelector('.chart__hover-circle');
    const box = chart.querySelector('.chart__hover-box');
    const yText = chart.querySelector('.chart__hover-y');
    const xText = chart.querySelector('.chart__hover-x');
    if (!plot || !hover) continue;

    const move = (event) => {
      const rect = plot.getBoundingClientRect();
      if (rect.width === 0) return;
      const fraction = ((event.clientX - rect.left) / rect.width) * 100;

      let nearest = points[0];
      let best = Infinity;
      for (const point of points) {
        const distance = Math.abs(point.x - fraction);
        if (distance < best) {
          best = distance;
          nearest = point;
        }
      }

      hover.hidden = false;
      line.style.left = `${nearest.x}%`;
      circle.style.left = `${nearest.x}%`;
      circle.style.top = `${nearest.y}%`;
      // Trusted: both strings are built in this module from numbers, never from user text.
      yText.innerHTML = nearest.title;
      xText.textContent = nearest.sub;

      // Pinned to a top corner and flipped away from the cursor, as osu-web does it, rather
      // than following the point -- which would put the tooltip under the pointer.
      box.dataset.float = fraction < 50 ? 'right' : 'left';
    };

    plot.addEventListener('mousemove', move);
    plot.addEventListener('mouseleave', () => {
      hover.hidden = true;
    });
  }
}
