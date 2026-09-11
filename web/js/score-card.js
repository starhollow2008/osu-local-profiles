/**
 * View Details: osu!'s score page (`osu.ppy.sh/scores/<id>`), drawn as a card over the
 * profile.
 *
 * Built from osu-web's `scores-show/` components and their `score-*.less` -- the order, the
 * sizes, the cutoffs, the colours and the wording are theirs (see docs/roadmap.md 5.21);
 * the markup and every drawing are made here. Global Rank and the replay watch count are
 * left out: both are facts about osu!'s leaderboards, which a local profile does not have.
 */
import { escapeHtml, fmt } from './format.js';
import { coverUrl, gradeBadge, modList } from './badges.js';
import { MODE_ICON, MODE_NAME, difficultyBadge } from './beatmapsets.js';
import { ppNotes } from './sections.js';

const RULESET = ['osu', 'taiko', 'fruits', 'mania'];

/* ------------------------------------------------------------------------ */
/* Statistics                                                                */
/* ------------------------------------------------------------------------ */

/*
 * osu-web's `scoreStatisticsMapping`, the entries it shows on a single score's page. `basic`
 * rows are the judgements; the rest are shown as `value/maximum`, and only when the beatmap
 * could have produced any (`maximumValue > 0`, which is ppy/osu's own rule).
 */
const STATISTICS = {
  osu: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['meh'], basic: true, label: 'meh' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_tick_hit'], basic: false, label: 'slider tick' },
    { attributes: ['small_tick_hit', 'slider_tail_hit'], basic: false, label: 'slider end' },
    { attributes: ['large_bonus'], basic: false, label: 'spinner bonus' },
    { attributes: ['small_bonus'], basic: false, label: 'spinner spin' },
  ],
  taiko: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_bonus'], basic: false, label: 'bonus' },
    { attributes: ['small_bonus'], basic: false, label: 'drum tick' },
  ],
  fruits: [
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
    { attributes: ['large_tick_hit'], basic: false, label: 'large droplet' },
    { attributes: ['small_tick_hit'], basic: false, label: 'small droplet' },
    { attributes: ['large_bonus'], basic: false, label: 'banana' },
  ],
  mania: [
    { attributes: ['perfect'], basic: true, label: 'perfect' },
    { attributes: ['great'], basic: true, label: 'great' },
    { attributes: ['good'], basic: true, label: 'good' },
    { attributes: ['ok'], basic: true, label: 'ok' },
    { attributes: ['meh'], basic: true, label: 'meh' },
    { attributes: ['miss'], basic: true, label: 'Miss' },
  ],
};

/** osu-web's `calculateStatisticsFor(score, 'single')`, split into its two rows. */
export function statisticsFor(score) {
  const sum = (from, attributes) => attributes.reduce((n, a) => n + (from?.[a] ?? 0), 0);
  const all = (STATISTICS[RULESET[score.mode]] ?? STATISTICS.osu).map((m) => ({
    attribute: m.attributes[0],
    label: m.label,
    basic: m.basic,
    value: sum(score.statistics, m.attributes),
    maximumValue: m.basic ? null : sum(score.maximumStatistics, m.attributes),
  }));
  return {
    basic: all.filter((s) => s.basic),
    extra: all.filter((s) => !s.basic && s.maximumValue > 0),
  };
}

/* ------------------------------------------------------------------------ */
/* The dial                                                                  */
/* ------------------------------------------------------------------------ */

/*
 * Where each grade begins, D to SS, from osu-web's `rankAbsoluteCutoffs` -- which cites the
 * ppy/osu score processors they come from. A stable score is graded by stable's rules, whose
 * thresholds are a ratio of judgements rather than an accuracy, expressed here as the
 * accuracy each one works out to.
 */
const CUTOFFS = {
  current: [
    [0, 0.7, 0.8, 0.9, 0.95, 0.99, 1],
    [0, 0.7, 0.8, 0.9, 0.95, 0.99, 1],
    [0, 0.85, 0.9, 0.94, 0.98, 0.99, 1],
    [0, 0.7, 0.8, 0.9, 0.95, 0.99, 1],
  ],
  legacy: [
    [0, 0.6, 0.8, 0.867, 0.933, 0.99, 1],
    [0, 0.6, 0.75, 0.833, 0.917, 0.99, 1],
    [0, 0.8501, 0.9001, 0.9401, 0.9801, 0.99, 1],
    [0, 0.7, 0.8, 0.9, 0.95, 0.99, 1],
  ],
};

/** osu-web's `rankCutoffIndex`: which cutoff a grade's band ends at. */
const CUTOFF_INDEX = { F: 0, D: 1, C: 2, B: 3, A: 4, S: 5, SH: 5, X: 6, XH: 6 };

export function rankCutoffs(mode, legacy) {
  return CUTOFFS[legacy ? 'legacy' : 'current'][mode] ?? CUTOFFS.current[0];
}

/** osu! floors accuracy to two decimals of a percent rather than rounding it. */
export const flooredAccuracy = (accuracy) => Math.floor(accuracy * 10000) / 10000;

/**
 * How much of the outer ring to fill. Never past the top of the grade the score was given:
 * an A with 97% accuracy (it missed, so it cannot be an S) fills only to the A's end, which
 * is how the dial shows that the misses, not the accuracy, decided the grade.
 */
export function dialFill(accuracy, grade, cutoffs) {
  return Math.min(flooredAccuracy(accuracy), cutoffs[CUTOFF_INDEX[grade] ?? 0] ?? 1);
}

const TAU = Math.PI * 2;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * One ring segment, from `a0` to `a1` radians clockwise from twelve o'clock -- what d3's
 * `arc()` draws for osu-web, written out so the page needs no d3.
 */
function sector(inner, outer, a0, a1) {
  const span = a1 - a0;
  if (span <= 1e-6) return '';
  if (span >= TAU - 1e-6) {
    // A whole ring: two half circles each way, the inner one wound backwards to cut the hole.
    return `M0 ${-outer}A${outer} ${outer} 0 1 1 0 ${outer}A${outer} ${outer} 0 1 1 0 ${-outer}Z` +
      `M0 ${-inner}A${inner} ${inner} 0 1 0 0 ${inner}A${inner} ${inner} 0 1 0 0 ${-inner}Z`;
  }
  const at = (r, a) => `${r2(r * Math.sin(a))} ${r2(-r * Math.cos(a))}`;
  const large = span > Math.PI ? 1 : 0;
  return `M${at(outer, a0)}A${outer} ${outer} 0 ${large} 1 ${at(outer, a1)}` +
    `L${at(inner, a1)}A${inner} ${inner} 0 ${large} 0 ${at(inner, a0)}Z`;
}

const RANK_FILL = ['--rank-d', '--rank-c', '--rank-b', '--rank-a', '--rank-s', '--rank-x'];
const DISPLAY_RANK = { XH: 'SS', X: 'SS', SH: 'S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };

let dialId = 0;

/**
 * osu-web's `score-dial`: an inner ring split at each grade's cutoff in that grade's colour,
 * an outer ring filled with the accuracy in a blue-to-lime gradient, and the grade in the
 * middle.
 */
export function scoreDial(score) {
  const cutoffs = rankCutoffs(score.mode, score.client === 'stable');
  const fill = dialFill(score.accuracy, score.grade, cutoffs);
  const gradient = `dial-outer-${++dialId}`;

  const inner = [];
  for (let i = 1; i < cutoffs.length; i++) {
    const path = sector(68, 73, cutoffs[i - 1] * TAU, cutoffs[i] * TAU);
    if (path) inner.push(`<path d="${path}" style="fill: var(${RANK_FILL[i - 1]})"/>`);
  }
  const filled = sector(75, 100, 0, fill * TAU);
  const rest = sector(75, 100, fill * TAU, TAU);

  // Colours go in `style`, not in presentation attributes, which do not take var().
  return `<div class="score-dial">
  <div class="score-dial__layer">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id="${gradient}" gradientTransform="rotate(90)">
          <stop offset="0%" style="stop-color: hsl(var(--hsl-blue-1))"/>
          <stop offset="100%" style="stop-color: hsl(var(--hsl-lime-1))"/>
        </linearGradient>
      </defs>
      <g transform="translate(100, 100)">
        ${inner.join('')}
        ${filled ? `<path d="${filled}" fill="url(#${gradient})"/>` : ''}
        ${rest ? `<path d="${rest}" style="fill: hsl(var(--hsl-b6))"/>` : ''}
      </g>
    </svg>
  </div>
  <div class="score-dial__layer score-dial__layer--grade"><span>${DISPLAY_RANK[score.grade] ?? 'F'}</span></div>
</div>`;
}

/*
 * A stable score gets its grade as a big letter instead of the dial, as on osu! (osu-web's
 * `legacy-rank`, shown whenever a score came from stable). osu!'s letter is an image of
 * stable's default ranking letter, which is its artwork; this is drawn to the same idea --
 * the grade's colour top to bottom, a white outline -- at the same 200x160.
 */
const LEGACY_LETTER = {
  X: ['#fff4b8', '#f0a800'],
  S: ['#fff4b8', '#f0a800'],
  XH: ['#ffffff', '#9ab8c8'],
  SH: ['#ffffff', '#9ab8c8'],
  A: ['#c4f76a', '#2f9406'],
  B: ['#97dcff', '#1f66cf'],
  C: ['#eaa6ff', '#9031c2'],
  D: ['#ffa3a3', '#c81818'],
};

export function legacyRank(grade) {
  const stops = LEGACY_LETTER[grade];
  const text = DISPLAY_RANK[grade];
  const id = `legacy-rank-${++dialId}`;
  // Two letters have to fit the same box one does, so they are set tighter rather than small.
  const two = text.length > 1;
  return `<div class="legacy-rank" role="img" aria-label="${text} rank">
  <svg viewBox="0 0 200 160" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" style="stop-color: ${stops[0]}"/>
        <stop offset="1" style="stop-color: ${stops[1]}"/>
      </linearGradient>
    </defs>
    <text x="100" y="${two ? 136 : 146}" text-anchor="middle" font-size="${two ? 150 : 176}" font-weight="900"
          letter-spacing="${two ? -18 : 0}" fill="url(#${id})" stroke="#fff" stroke-width="6"
          stroke-linejoin="round" paint-order="stroke" style="font-family: var(--font-grade)">${text}</text>
  </svg>
</div>`;
}

/* ------------------------------------------------------------------------ */
/* The card                                                                  */
/* ------------------------------------------------------------------------ */

/** osu-web's `score-tower`: SS to D, the grade reached bright, those below it dimmed. */
const TOWER_VALUE = { F: -1, D: 0, C: 1, B: 2, A: 3, S: 4, SH: 4, X: 5, XH: 5 };

function tower(grade) {
  const ranks = ['X', 'S', 'A', 'B', 'C', 'D'];
  if (grade === 'XH') ranks[0] = 'XH';
  if (grade === 'SH') ranks[1] = 'SH';
  const current = TOWER_VALUE[grade] ?? -1;
  return `<div class="score-tower">${ranks
    .map((rank) => {
      const cls = current < TOWER_VALUE[rank] ? ' score-tower__item--missed' : current > TOWER_VALUE[rank] ? ' score-tower__item--passed' : '';
      return `<div class="score-tower__item${cls}"><div class="score-rank">${gradeBadge(rank)}</div></div>`;
    })
    .join('')}</div>`;
}

function beatmapInfo(score) {
  const ruleset = RULESET[score.mode] ?? 'osu';
  const href = score.beatmapId ? `https://osu.ppy.sh/beatmaps/${score.beatmapId}?mode=${ruleset}` : null;
  const link = (inner, cls) =>
    href ? `<a class="${cls}" href="${href}" target="_blank" rel="noreferrer noopener">${inner}</a>` : `<span class="${cls}">${inner}</span>`;

  const title = escapeHtml(score.title ?? `unknown beatmap (${(score.beatmapMd5 ?? '').slice(0, 12)})`);
  const artist = score.artist ? ` <span class="score-beatmap__artist">by ${escapeHtml(score.artist)}</span>` : '';

  const mapper = score.creator
    ? score.creatorId
      ? `<a class="beatmap-list-item__mapper-link" href="https://osu.ppy.sh/users/${score.creatorId}" target="_blank" rel="noreferrer noopener">${escapeHtml(score.creator)}</a>`
      : escapeHtml(score.creator)
    : '';

  return `<div class="score-beatmap">
  <h1 class="score-beatmap__title">${link(`${title}${artist}`, 'score-beatmap__link-plain')}</h1>
  <div class="score-beatmap__detail">
    <div class="beatmap-list-item beatmap-list-item--inline">
      <div class="beatmap-list-item__col beatmap-list-item__col--icon" title="${escapeHtml(MODE_NAME[ruleset])}">${MODE_ICON[ruleset]}</div>
      ${score.difficultyStars == null ? '' : `<div class="beatmap-list-item__col">${difficultyBadge(score.difficultyStars)}</div>`}
      <div class="beatmap-list-item__col beatmap-list-item__col--main">
        <div class="beatmap-list-item__version u-ellipsis">${link(escapeHtml(score.version ?? ''), 'beatmap-list-item__version-link')}${
          mapper ? ` <span class="beatmap-list-item__mapper">mapped by ${mapper}</span>` : ''
        }</div>
      </div>
    </div>
  </div>
</div>`;
}

/** osu-web's `LLL`: the date and time in the reader's own format. */
const submitted = (ms) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

function player(score, who) {
  return `<div class="score-player">
  <div class="score-player__row score-player__row--score">
    <div class="score-player__mods">${modList(score.mods)}</div>
    <div class="score-player__score">${fmt(score.totalScore)}</div>
  </div>
  <div class="score-player__row score-player__row--player">
    <span>Played by</span><strong>${escapeHtml(who.name)}</strong>
    <span>Submitted on</span><strong>${escapeHtml(submitted(score.playedAt))}</strong>
    <span>Played on</span><strong>${score.client === 'stable' ? 'Stable' : 'Lazer'}</strong>
  </div>
</div>`;
}

function buttons(score) {
  const download = score.replayAvailable
    ? `<a class="btn-osu-big btn-osu-big--rounded" href="/api/scores/${score.id}/replay"
         data-replay-download="${score.id}">Download Replay</a>`
    : '';
  // The same menu as the row's, so pinning and the rest behave identically in both places.
  const menu = `<div class="score-buttons__menu">
    <button class="score-buttons__menu-button" type="button" data-play-menu data-kind="score" data-context="card"
            data-id="${score.id}" data-pinned="${score.pinned ? 1 : 0}" data-set="${score.beatmapsetId ?? ''}"
            data-replay="${score.hasReplay ? 1 : 0}" aria-haspopup="true" aria-label="Options for this score"
            title="Options">&#8943;</button>
  </div>`;
  return `<div class="score-buttons">${download}${menu}</div>`;
}

/**
 * osu-web's `user-card`, for the profile. Its status line is osu!'s online dot; a local
 * profile has no presence, so the dot says whether the profile is tracking plays right now.
 */
function userCard(who) {
  const flag = who.country
    ? `<div class="user-card__icon user-card__icon--flag"><span class="flag-country" role="img"
         title="${escapeHtml(who.countryName)}" aria-label="${escapeHtml(who.countryName)}"
         style="background-image: url('/flags/${escapeHtml(who.country.toLowerCase())}.svg')"></span></div>`
    : '';
  const background = who.cover
    ? `<div class="user-card__background" style="background-image: url('${escapeHtml(who.cover)}')"></div>`
    : '';
  return `<div class="user-card">
  <div class="user-card__background-container">${background}<div class="user-card__background-overlay"></div></div>
  <div class="user-card__card">
    <div class="user-card__content user-card__content--details">
      <div class="user-card__avatar-space"><div class="user-card__avatar">${who.avatar}</div></div>
      <div class="user-card__details">
        <div class="user-card__icons">${flag}</div>
        <div class="user-card__username-row"><div class="user-card__username u-ellipsis">${escapeHtml(who.name)}</div></div>
      </div>
    </div>
    <div class="user-card__content user-card__content--status">
      <div class="user-card__status">
        <div class="user-card__status-icon-container">
          <div class="user-card__status-icon${who.tracking ? ' user-card__status-icon--online' : ''}"></div>
        </div>
        <div class="user-card__status-messages">
          <span class="user-card__status-message u-ellipsis">${who.tracking ? 'Tracking' : 'Not tracking'}</span>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

function stat(label, value, modifier = '') {
  return `<div class="score-stats__stat">
    <div class="score-stats__stat-row score-stats__stat-row--label${modifier}">${escapeHtml(label)}</div>
    <div class="score-stats__stat-row">${value}</div>
  </div>`;
}

function ppValue(score) {
  const why = ppNotes(score);
  if (why.none !== null) return `<span title="${escapeHtml(why.none)}">-</span>`;
  const title = [`${fmt(score.pp, 2)}pp`, ...why.notes].join(' ');
  const cls = ['score-stats__pp'];
  if (why.uncounted) cls.push('score-stats__pp--uncounted');
  if (why.unofficial) cls.push('score-stats__pp--unofficial');
  return `<span class="${cls.join(' ')}" title="${escapeHtml(title)}">${fmt(Math.round(score.pp))}${
    why.unofficial ? '<span class="score-stats__pp-mark" aria-hidden="true">*</span>' : ''
  }</span>`;
}

function stats(score, calculator) {
  const accuracy = flooredAccuracy(score.accuracy);
  const perfect = (on) => (on ? ' score-stats__stat-row--perfect' : '');
  const { basic, extra } = statisticsFor(score);

  const top = `<div class="score-stats__group-row">
    ${stat('Accuracy', `<span class="${perfect(accuracy === 1).trim()}">${fmt(accuracy * 100, 2)}%</span>`)}
    ${stat('Max Combo', `<span class="${perfect(score.perfectCombo === true).trim()}">${fmt(score.maxCombo)}x</span>`)}
    ${stat('pp', ppValue(score))}
  </div>`;
  const judgements = `<div class="score-stats__group-row">${basic
    .map((s) => stat(s.label, fmt(s.value), ` score-stats__stat-row--hit-${s.attribute}`))
    .join('')}</div>`;
  const more = extra.length
    ? `<div class="score-stats__group-row">${extra
        .map((s) =>
          stat(
            s.label,
            `${fmt(s.value)}<span class="score-stats__stat-row--maximum">/${fmt(s.maximumValue)}</span>`,
            ` score-stats__stat-row--hit-${s.attribute}`,
          ),
        )
        .join('')}</div>`
    : '';
  return `${top}${judgements}${more}${breakdown(score, calculator)}`;
}

/**
 * osu!'s own parts of the pp shown -- Aim, Speed, Accuracy, Flashlight Bonus and Reading in
 * osu!standard, Difficulty and Accuracy in taiko, Difficulty in mania; catch has none -- under
 * the names osu! gives them, with the osu! release whose calculator produced them. osu!'s
 * website does not show this; lazer's results screen does, which is where the names are from.
 */
function breakdown(score, calculator) {
  const parts = score.ppBreakdown;
  if (!parts || parts.length === 0 || score.pp == null) return '';
  const value = (pp) => (pp < 0.05 ? '0' : fmt(pp, pp < 10 ? 1 : 0));
  const older = calculator && score.ppVersion && score.ppVersion !== calculator
    ? ` title="The calculator running now is osu! ${escapeHtml(calculator)}. Recalculate from Settings to update this score."`
    : '';
  return `<div class="score-stats__caption">
    <span>pp breakdown</span>
    ${score.ppVersion ? `<span class="score-stats__caption-version"${older}>osu! ${escapeHtml(score.ppVersion)}${older ? ' (older)' : ''}</span>` : ''}
  </div>
  <div class="score-stats__group-row score-stats__group-row--breakdown"
       title="The parts osu! calculates this score's pp from. The total is not a plain sum: osu! combines them its own way.">
    ${parts.map((p) => stat(p.name, `${value(p.pp)}<span class="score-stats__stat-row--maximum">pp</span>`)).join('')}
  </div>`;
}

/**
 * The whole card. `score` is a ScoreDetail from src/scores.ts; `who` is the profile as the
 * header shows it: { name, avatar (markup), country, countryName, cover, tracking }; and
 * `calculator` is the osu! release pricing scores now, to mark a breakdown from another.
 */
export function scoreCard(score, who, calculator = null) {
  const cover = coverUrl(score.beatmapsetId, 'cover@2x');
  // osu-web shows stable's letter for a stable score; it has no letter for F, so a failed
  // stable score keeps the dial.
  const grade = score.client === 'stable' && LEGACY_LETTER[score.grade] ? legacyRank(score.grade) : scoreDial(score);

  return `<div class="score-page">
  ${beatmapInfo(score)}
  <div class="score-info">
    <div class="score-info__cover"${cover ? ` style="background-image: url('${cover}')"` : ''}></div>
    <div class="score-info__item">${tower(score.grade)}</div>
    <div class="score-info__item score-info__item--dial">${grade}</div>
    <div class="score-info__item score-info__item--player">${player(score, who)}</div>
    <div class="score-info__item score-info__item--buttons">${buttons(score)}</div>
  </div>
  <div class="score-stats">
    <div class="score-stats__group score-stats__group--user-card">${userCard(who)}</div>
    <div class="score-stats__group score-stats__group--stats">${stats(score, calculator)}</div>
  </div>
</div>`;
}
