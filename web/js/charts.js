/**
 * The profile page's line charts, as inline SVG. No charting library, so nothing to fetch
 * and nothing to keep up to date.
 *
 * The rank and pp charts are described below. The Play History is the exception: it is
 * drawn in pixels with real axes, as osu-web's `charts/line-chart.ts` does (see
 * `drawLineChart`).
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
import { t } from './i18n.js';

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
  if (!input || input.length === 0) return EMPTY(t('chart.unranked'));

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
export function ppChart(input, emptyMessage = t('chart.noRankedPlays')) {
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
 * Drawn the way osu-web draws it (`profile-page/chart.tsx` on `charts/line-chart.ts`): a
 * plain line with gridlines, a y axis of whole numbers, month labels on a slant, and a
 * tooltip. The markup here is only an empty box carrying the points; `bindCharts` measures
 * it and draws, because unlike the other charts this one is laid out in pixels.
 */
export function playHistoryChart(input) {
  const points = padMonths(input);
  if (points.length === 0) return '';

  const data = escapeHtml(JSON.stringify(points));
  return `<div class="line-chart line-chart--profile-page" data-line-chart="${data}"></div>`;
}

/**
 * osu-web's `convertUserDataForChart`: sorted, every missing month filled with zero, and a
 * lone month given a zero month before it so there is a line to draw.
 */
function padMonths(input) {
  if (!input || input.length === 0) return [];

  const sorted = [...input].sort((a, b) => a.at - b.at);
  const out = [];
  for (const p of sorted) {
    if (out.length > 0) {
      const d = new Date(out[out.length - 1].x);
      for (;;) {
        d.setUTCMonth(d.getUTCMonth() + 1);
        if (d.getTime() >= p.at) break;
        out.push({ x: d.getTime(), y: 0 });
      }
    }
    out.push({ x: p.at, y: p.count });
  }

  if (out.length === 1) {
    const d = new Date(out[0].x);
    d.setUTCMonth(d.getUTCMonth() - 1);
    out.unshift({ x: d.getTime(), y: 0 });
  }
  return out;
}

/* ------------------------------------------------------- pixel-space line chart */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86_400_000;
// osu-web's defaults, with the profile page's wider right margin for the last label.
const MARGIN = { top: 20, right: 60, bottom: 50, left: 60 };
const DESKTOP = '(min-width: 900px)';

/** d3's `tickStep`: 1, 2 or 5 times a power of ten, whichever is nearest `(stop - start) / count`. */
function tickStep(start, stop, count) {
  const step0 = Math.abs(stop - start) / Math.max(0, count);
  let step1 = 10 ** Math.floor(Math.log10(step0));
  const error = step0 / step1;
  if (error >= Math.sqrt(50)) step1 *= 10;
  else if (error >= Math.sqrt(10)) step1 *= 5;
  else if (error >= Math.sqrt(2)) step1 *= 2;
  return step1;
}

/** d3's linear `ticks(start, stop, count)`, which is what osu-web's y axis asks for. */
function linearTicks(start, stop, count) {
  if (!(count > 0)) return [];
  if (start === stop) return [start];

  const step = (stop - start) / count;
  const power = Math.floor(Math.log10(step));
  const error = step / 10 ** power;
  const factor = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;

  let i1;
  let i2;
  let inc;
  if (power < 0) {
    inc = 10 ** -power / factor;
    i1 = Math.round(start * inc);
    i2 = Math.round(stop * inc);
    if (i1 / inc < start) i1++;
    if (i2 / inc > stop) i2--;
  } else {
    inc = 10 ** power * factor;
    i1 = Math.round(start / inc);
    i2 = Math.round(stop / inc);
    if (i1 * inc < start) i1++;
    if (i2 * inc > stop) i2--;
  }

  const out = [];
  for (let i = i1; i <= i2; i++) out.push(power < 0 ? i / inc : i * inc);
  return out;
}

/**
 * d3's `scaleUtc().ticks(count)`, for the month-sized spans a monthly series has: every
 * month, every third month (Jan, Apr, Jul, Oct), or every so many years, whichever puts the
 * count nearest `count`. It picks the same way d3 does, by the ratio to the neighbouring size.
 */
function utcTicks(min, max, count) {
  const target = (max - min) / count;
  const MONTH = 30 * DAY_MS;
  const QUARTER = 90 * DAY_MS;
  const YEAR = 365 * DAY_MS;

  let months = 1;
  let years = 0;
  if (target >= YEAR) {
    years = Math.max(1, Math.floor(tickStep(min / YEAR, max / YEAR, count)));
  } else if (target >= QUARTER) {
    if (target / QUARTER < YEAR / target) months = 3;
    else years = 1;
  } else if (target >= MONTH) {
    if (target / MONTH >= QUARTER / target) months = 3;
  }

  const out = [];
  const d = new Date(min);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  if (years > 0) d.setUTCMonth(0);
  for (; d.getTime() <= max; d.setUTCMonth(d.getUTCMonth() + (years > 0 ? 12 : 1))) {
    if (d.getTime() < min) continue;
    if (years > 0 ? d.getUTCFullYear() % years === 0 : d.getUTCMonth() % months === 0) out.push(d.getTime());
  }
  return out;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * osu-web's `LineChart`, for the Play History. Reads the points off the element, then builds
 * the svg and the hover layer once and redraws them whenever the box changes size.
 */
function drawLineChart(root) {
  let points;
  try {
    points = JSON.parse(root.dataset.lineChart);
  } catch {
    return; // a malformed chart should not take the page down
  }
  if (!Array.isArray(points) || points.length < 2) return;

  const minX = points[0].x;
  const maxX = points[points.length - 1].x;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const svg = svgEl('svg');
  const wrapper = svgEl('g');
  const axisX = svgEl('g', { class: 'line-chart__axis line-chart__axis--x' });
  const axisY = svgEl('g', { class: 'line-chart__axis line-chart__axis--y' });
  const line = svgEl('path', { class: 'line-chart__line' });
  wrapper.append(axisX, axisY, line);
  svg.append(wrapper);

  const hoverArea = document.createElement('div');
  hoverArea.className = 'line-chart__hover-area';
  hoverArea.innerHTML = `<div class="line-chart__hover" data-visibility="hidden">
    <div class="line-chart__hover-line"></div>
    <div class="line-chart__hover-circle"></div>
    <div class="line-chart__hover-info-box" data-float="left">
      <div class="line-chart__hover-info-box-text line-chart__hover-info-box-text--x"></div>
      <div class="line-chart__hover-info-box-text line-chart__hover-info-box-text--y"></div>
    </div>
  </div>`;
  root.replaceChildren(svg, hoverArea);

  const hover = hoverArea.querySelector('.line-chart__hover');
  const hoverLine = hoverArea.querySelector('.line-chart__hover-line');
  const hoverCircle = hoverArea.querySelector('.line-chart__hover-circle');
  const infoBox = hoverArea.querySelector('.line-chart__hover-info-box');
  const infoX = hoverArea.querySelector('.line-chart__hover-info-box-text--x');
  const infoY = hoverArea.querySelector('.line-chart__hover-info-box-text--y');

  hoverArea.style.top = `${MARGIN.top}px`;
  hoverArea.style.bottom = `${MARGIN.bottom}px`;
  hoverArea.style.left = `${MARGIN.left}px`;
  hoverArea.style.right = `${MARGIN.right}px`;

  let width = 0;
  let height = 0;
  const scaleX = (x) => ((x - minX) / (maxX - minX)) * width;
  // A flat series has no span to divide by; d3 puts it mid-chart.
  const scaleY = (y) => (maxY === minY ? height / 2 : height - ((y - minY) / (maxY - minY)) * height);

  let autoEnd;
  const hoverEnd = () => hover.setAttribute('data-visibility', 'hidden');

  const draw = () => {
    const box = root.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return; // hidden tab; the observer calls again
    width = box.width - (MARGIN.left + MARGIN.right);
    height = box.height - (MARGIN.top + MARGIN.bottom);

    svg.setAttribute('width', String(box.width));
    svg.setAttribute('height', String(box.height));
    wrapper.setAttribute('transform', `translate(${MARGIN.left}, ${MARGIN.top})`);

    // Under ten months every month is labelled; past that d3 picks about fifteen (six on a phone).
    const desktop = window.matchMedia(DESKTOP).matches;
    const ticksX =
      desktop && points.length < 10
        ? points.map((p) => p.x)
        : utcTicks(minX, maxX, desktop ? 15 : Math.min(6, points.length));

    axisX.setAttribute('transform', `translate(0, ${height})`);
    axisX.replaceChildren(
      ...ticksX.map((x) => {
        const g = svgEl('g', { class: 'line-chart__tick', transform: `translate(${scaleX(x)}, 0)` });
        const text = svgEl('text', { class: 'line-chart__tick-text line-chart__tick-text--strong', y: 5, dy: '0.71em' });
        text.setAttribute('transform', 'rotate(45) translate(5, 0)');
        text.style.textAnchor = 'start';
        text.textContent = monthLabel(x);
        g.append(
          svgEl('line', { class: 'line-chart__tick-line line-chart__tick-line--default', y2: -height }),
          text,
        );
        return g;
      }),
    );

    axisY.replaceChildren(
      ...linearTicks(minY, maxY, 4).map((y) => {
        const g = svgEl('g', { class: 'line-chart__tick', transform: `translate(0, ${scaleY(y)})` });
        const text = svgEl('text', { class: 'line-chart__tick-text', x: -3, dy: '0.32em' });
        text.style.textAnchor = 'end';
        // Whole numbers only, as osu-web: a fractional tick has no meaning for a play count.
        text.textContent = Number.isInteger(y) ? fmt(y) : '';
        g.append(svgEl('line', { class: 'line-chart__tick-line line-chart__tick-line--default', x2: width }), text);
        return g;
      }),
    );

    line.setAttribute(
      'd',
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.x).toFixed(2)},${scaleY(p.y).toFixed(2)}`).join(''),
    );

    // Back to hidden and unmoved, since the old coordinates mean nothing at the new size.
    hoverEnd();
    hoverLine.style.transform = '';
    hoverCircle.style.transform = '';
  };

  const onHover = (event) => {
    if (width === 0) return;
    const relativeX = event.clientX - hover.getBoundingClientRect().left;
    const x = minX + (relativeX / width) * (maxX - minX);

    // osu-web's bisect, clamped so both neighbours exist, then whichever is nearer.
    let i = points.findIndex((p) => p.x >= x);
    if (i === -1) i = points.length;
    i = Math.min(Math.max(i, 1), points.length - 1);
    const d = x - points[i - 1].x <= points[i].x - x ? points[i - 1] : points[i];

    hover.setAttribute('data-visibility', 'visible');
    clearTimeout(autoEnd);
    if (!window.matchMedia(DESKTOP).matches) autoEnd = setTimeout(hoverEnd, 3000);

    // Rounded to keep the marker off half pixels.
    const cx = Math.round(scaleX(d.x));
    const cy = Math.round(scaleY(d.y));
    hoverLine.style.transform = `translateX(${cx}px)`;
    hoverCircle.style.transform = `translate(${cx}px,${cy}px)`;

    // Both strings are built here from numbers and the page's own month names.
    infoX.textContent = monthTitle(d.x);
    infoY.innerHTML = `<strong>Plays</strong> ${escapeHtml(fmt(d.y))}`;

    const rect = infoBox.getBoundingClientRect();
    if (infoBox.getAttribute('data-float') === 'right') {
      if (event.clientX > rect.left) infoBox.setAttribute('data-float', 'left');
    } else if (event.clientX < rect.right) {
      infoBox.setAttribute('data-float', 'right');
    }
  };

  hoverArea.addEventListener('mousemove', onHover);
  hoverArea.addEventListener('mouseout', hoverEnd);

  draw();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      if (!root.isConnected) observer.disconnect(); // the page wrote a new chart over this one
      else draw();
    });
    observer.observe(root);
  } else {
    window.addEventListener('resize', draw);
  }
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
  for (const chart of root.querySelectorAll('.line-chart[data-line-chart]')) {
    if (chart.dataset.lineChartReady) continue;
    chart.dataset.lineChartReady = '1';
    drawLineChart(chart);
  }

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
