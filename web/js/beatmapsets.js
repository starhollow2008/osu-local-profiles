/**
 * Favorite Beatmaps: osu-web's beatmapset card, and the difficulty popup under it.
 *
 * Built from osu-web's `beatmapset-panel` and `beatmaps-popup` -- the layout, sizes, colours
 * and wording are theirs (see docs/roadmap.md 5.20); the markup and the icons are drawn here.
 * osu! draws its icons from Font Awesome and its own ruleset font, neither of which this page
 * ships, so each icon is a small SVG made for this page.
 */
import { escapeHtml, fmt, shortDate } from './format.js';
import { coverUrl } from './badges.js';

/* ------------------------------------------------------------------------ */
/* Difficulty colour                                                         */
/* ------------------------------------------------------------------------ */

/*
 * osu-web's `getDiffColour`: eleven stops from 0.1 to 9 stars, interpolated in RGB with a
 * gamma of 2.2 (d3's `interpolateRgb.gamma(2.2)`), grey below 0.1 and black from 9 up.
 */
const DIFF_DOMAIN = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
const DIFF_RANGE = [
  '#4290FB', '#4FC0FF', '#4FFFD5', '#7CFF4F', '#F6F05C', '#FF8068',
  '#FF4E6F', '#C645B8', '#6563DE', '#18158E', '#000000',
];
const GAMMA = 2.2;

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

function mixGamma(a, b, t) {
  // d3's gamma interpolation: each channel raised to the gamma, mixed, and brought back.
  return a.map((ca, i) => {
    const pa = ca ** GAMMA;
    const pb = b[i] ** GAMMA;
    return (pa + (pb - pa) * t) ** (1 / GAMMA);
  });
}

export function getDiffColour(rating) {
  if (rating == null) return null;
  if (rating < 0.1) return '#AAAAAA';
  if (rating >= 9) return '#000000';
  let i = 0;
  while (i < DIFF_DOMAIN.length - 2 && rating > DIFF_DOMAIN[i + 1]) i++;
  const t = (rating - DIFF_DOMAIN[i]) / (DIFF_DOMAIN[i + 1] - DIFF_DOMAIN[i]);
  return toHex(mixGamma(channels(DIFF_RANGE[i]), channels(DIFF_RANGE[i + 1]), Math.min(1, Math.max(0, t))));
}

/** osu-web's `getDiffTextColour`, for the range this page can reach: black, then yellow. */
export function getDiffTextColour(rating) {
  return rating == null || rating < 6.5 ? '#000000' : '#F6F05C';
}

/* ------------------------------------------------------------------------ */
/* Icons                                                                     */
/* ------------------------------------------------------------------------ */

const svg = (body, viewBox = '0 0 16 16') =>
  `<svg class="icon" viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;

/*
 * The four rulesets, drawn plainly: a hit circle, a drum face, falling fruit, and columns.
 * Not osu!'s own ruleset glyphs, which are its artwork.
 */
const MODE_ICON = {
  osu: svg('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/>'),
  taiko: svg('<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 2.5v11" stroke="currentColor" stroke-width="2"/>'),
  fruits: svg('<circle cx="5" cy="5.5" r="2.4" fill="currentColor"/><circle cx="11" cy="5.5" r="2.4" fill="currentColor"/><circle cx="8" cy="11" r="2.4" fill="currentColor"/>'),
  mania: svg('<rect x="2" y="2" width="3" height="12" rx="1" fill="currentColor"/><rect x="6.5" y="5" width="3" height="9" rx="1" fill="currentColor"/><rect x="11" y="2" width="3" height="12" rx="1" fill="currentColor"/>'),
};

const MODE_NAME = { osu: 'osu!', taiko: 'osu!taiko', fruits: 'osu!catch', mania: 'osu!mania' };

const ICON = {
  heart: svg('<path d="M8 14.2 2.3 8.6A3.6 3.6 0 0 1 8 4.1a3.6 3.6 0 0 1 5.7 4.5z" fill="currentColor"/>'),
  download: svg('<path d="M4 1.5h5l3.5 3.5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.25 6.5v5m-2.25-2 2.25 2.25L10.5 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  star: svg('<path d="m8 1.2 2 4.4 4.8.5-3.6 3.2 1 4.7L8 11.6 3.8 14l1-4.7L1.2 6.1 6 5.6z" fill="currentColor"/>'),
  play: svg('<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M6.5 5v6l4.5-3z" fill="hsl(var(--hsl-b2))"/>'),
  check: svg('<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4" fill="none" stroke="hsl(var(--hsl-b2))" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
};

/* ------------------------------------------------------------------------ */
/* The card                                                                  */
/* ------------------------------------------------------------------------ */

const MODE_ORDER = ['osu', 'taiko', 'fruits', 'mania'];

/** osu-web's `group` + `sort`: by ruleset, easiest first within each. */
export function groupDifficulties(difficulties) {
  const groups = new Map();
  for (const mode of MODE_ORDER) {
    const list = difficulties
      .filter((d) => d.mode === mode)
      .sort((a, b) => (a.stars ?? Infinity) - (b.stars ?? Infinity));
    if (list.length > 0) groups.set(mode, list);
  }
  return groups;
}

const setUrl = (id) => `https://osu.ppy.sh/beatmapsets/${id}`;
const external = (href, cls, inner, title = '') =>
  `<a class="${cls}" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${
    title ? ` title="${escapeHtml(title)}"` : ''
  }>${inner}</a>`;

function badge(type, label, href) {
  const cls = `beatmapset-badge beatmapset-badge--panel beatmapset-badge--${type}`;
  return href ? external(href, cls, escapeHtml(label)) : `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function dot(d) {
  const colour = getDiffColour(d.stars);
  return colour
    ? `<div class="beatmapset-panel__beatmap-dot" style="--bg: ${colour}"></div>`
    : '<div class="beatmapset-panel__beatmap-dot beatmapset-panel__beatmap-dot--unknown"></div>';
}

/** One card. `card` is a FavoriteCard from src/favorites.ts. */
export function beatmapsetCard(card) {
  const url = setUrl(card.id);
  const cover = (size) =>
    `--bg: url('${coverUrl(card.id, size)}'); --bg-2x: url('${coverUrl(card.id, `${size}@2x`)}')`;

  const groups = groupDifficulties(card.difficulties);
  // osu-web switches to a count once a set has more than twelve difficulties.
  const compact = card.difficulties.length > 12;
  const dots = [...groups]
    .map(
      ([mode, list]) => `<div class="beatmapset-panel__extra-item beatmapset-panel__extra-item--dots">
        <div class="beatmapset-panel__beatmap-icon" title="${escapeHtml(MODE_NAME[mode])}">${MODE_ICON[mode]}</div>
        ${compact ? `<div class="beatmapset-panel__beatmap-count">${list.length}</div>` : list.map(dot).join('')}
      </div>`,
    )
    .join('');

  const status = card.status
    ? `<div class="beatmapset-panel__extra-item">
        <div class="beatmapset-status beatmapset-status--panel beatmapset-status--${escapeHtml(card.status)}">${
          escapeHtml(STATUS_LABEL[card.status] ?? card.status)
        }</div>
      </div>`
    : '';

  const stats = [
    card.playCount != null
      ? `<div class="beatmapset-panel__stats-item" title="Playcount: ${fmt(card.playCount)}">
          <span class="beatmapset-panel__stats-item-icon">${ICON.play}</span><span>${suffixed(card.playCount)}</span></div>`
      : '',
    card.favouriteCount != null
      ? `<div class="beatmapset-panel__stats-item" title="Favourites: ${fmt(card.favouriteCount)}">
          <span class="beatmapset-panel__stats-item-icon">${ICON.heart}</span><span>${suffixed(card.favouriteCount)}</span></div>`
      : '',
    card.date
      ? `<div class="beatmapset-panel__stats-item" title="${escapeHtml(new Date(card.date).toLocaleString())}">
          <span class="beatmapset-panel__stats-item-icon">${ICON.check}</span><span>${escapeHtml(shortDate(Date.parse(card.date)))}</span></div>`
      : '',
  ].join('');

  const mapper = card.creator
    ? card.userId
      ? external(`https://osu.ppy.sh/users/${card.userId}`, 'beatmapset-panel__mapper-link', escapeHtml(card.creator))
      : `<span class="beatmapset-panel__mapper-link">${escapeHtml(card.creator)}</span>`
    : null;

  const local =
    card.source === 'local'
      ? ' title="Shown from what is on this machine: osu.ppy.sh could not be reached when this was favourited, so star ratings and badges may be missing. They fill in the next time a beatmap is favourited with a connection."'
      : '';

  return `<div class="beatmapset-panel${card.source === 'local' ? ' beatmapset-panel--local' : ''}" data-set-id="${card.id}"${local}>
  <a class="beatmapset-panel__cover-container" href="${url}" target="_blank" rel="noreferrer noopener" tabindex="-1" aria-hidden="true">
    <div class="beatmapset-panel__cover-col beatmapset-panel__cover-col--play">
      <div class="beatmapset-cover beatmapset-cover--full" style="${cover('list')}"></div>
    </div>
    <div class="beatmapset-panel__cover-col beatmapset-panel__cover-col--info">
      <div class="beatmapset-cover beatmapset-cover--full" style="${cover('card')}"></div>
    </div>
  </a>
  <div class="beatmapset-panel__content">
    <div class="beatmapset-panel__play-container"></div>
    <div class="beatmapset-panel__info">
      <div class="beatmapset-panel__info-row beatmapset-panel__info-row--title">
        ${external(url, 'beatmapset-panel__main-link u-ellipsis', escapeHtml(card.title))}
        <div class="beatmapset-panel__badge-container">
          ${card.nsfw ? badge('nsfw', 'Explicit') : ''}
          ${card.spotlight ? badge('spotlight', 'Spotlight', 'https://osu.ppy.sh/wiki/Beatmap_Spotlights') : ''}
        </div>
      </div>
      <div class="beatmapset-panel__info-row beatmapset-panel__info-row--artist">
        ${external(url, 'beatmapset-panel__main-link u-ellipsis', `by ${escapeHtml(card.artist)}`)}
        <div class="beatmapset-panel__badge-container">
          ${card.featuredArtist ? badge('featured_artist', 'Featured Artist') : ''}
        </div>
      </div>
      <div class="beatmapset-panel__info-row beatmapset-panel__info-row--mapper">
        <div class="u-ellipsis">${mapper ? `mapped by ${mapper}` : '&nbsp;'}</div>
      </div>
      <div class="beatmapset-panel__info-row beatmapset-panel__info-row--stats">${stats}</div>
      <a class="beatmapset-panel__info-row beatmapset-panel__info-row--extra" href="${url}"
         target="_blank" rel="noreferrer noopener" data-beatmaps-popup="${card.id}">
        ${status}${dots}
      </a>
    </div>
    <div class="beatmapset-panel__menu-container">
      <div class="beatmapset-panel__menu">
        <button type="button" class="beatmapset-panel__menu-item beatmapset-panel__menu-item--favourite"
                data-unfavorite="${card.id}" title="Unfavorite this beatmap" aria-label="Unfavorite this beatmap">${ICON.heart}</button>
        ${external(`${url}/download`, 'beatmapset-panel__menu-item', ICON.download, 'download')}
      </div>
    </div>
  </div>
</div>`;
}

/** osu-web's `formatNumberSuffixed`: 22,968 -> 23K. */
function suffixed(n) {
  return Number(n).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

/** osu-web's `beatmapsets.show.status.*`; drawn uppercase by the pill. */
const STATUS_LABEL = {
  ranked: 'Ranked',
  approved: 'Approved',
  qualified: 'Qualified',
  loved: 'Loved',
  pending: 'Pending',
  wip: 'WIP',
  graveyard: 'Graveyard',
};

/* ------------------------------------------------------------------------ */
/* The difficulty popup                                                      */
/* ------------------------------------------------------------------------ */

/** osu-web's `formatStarRating`: two decimals. */
const stars = (n) => (n == null ? '?' : n.toFixed(2));

/**
 * osu-web's `beatmaps-popup`: every difficulty, grouped by ruleset, each with its mode, a
 * star-rating pill in its own colour, and its name.
 */
export function beatmapsPopupContent(card) {
  return `<div class="beatmaps-popup__content">${[...groupDifficulties(card.difficulties)]
    .map(
      ([mode, list]) => `<div class="beatmaps-popup__group">${list
        .map((d) => {
          const href = d.id ? `https://osu.ppy.sh/beatmaps/${d.id}` : `https://osu.ppy.sh/beatmapsets/${card.id}`;
          const bg = getDiffColour(d.stars) ?? 'hsl(var(--hsl-b5))';
          return `<a class="beatmaps-popup-item" href="${href}" target="_blank" rel="noreferrer noopener">
            <span class="beatmaps-popup-item__icon" title="${escapeHtml(MODE_NAME[mode])}">${MODE_ICON[mode]}</span>
            <span class="difficulty-badge" style="--bg: ${bg}; color: ${getDiffTextColour(d.stars)}">
              <span class="difficulty-badge__icon">${ICON.star}</span>
              <span class="difficulty-badge__rating">${stars(d.stars)}</span>
            </span>
            <span class="beatmaps-popup-item__version u-ellipsis">${escapeHtml(d.version)}</span>
          </a>`;
        })
        .join('')}</div>`,
    )
    .join('')}</div>`;
}

export function favoriteList(cards) {
  if (!cards || cards.length === 0) return '';
  return `<div class="page-extra__beatmapsets">${cards.map(beatmapsetCard).join('')}</div>`;
}
