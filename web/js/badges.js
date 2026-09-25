/**
 * The bits of osu!'s visual language that are images on osu.ppy.sh: grade badges, mod
 * badges, the level hexagon, the avatar.
 *
 * Grade badges, mod glyphs and the guest avatar are osu-web's own artwork, vendored into
 * web/osu-web/ by scripts/build-osu-web-art.mjs and pointed at by web/css/osu-web-art.css.
 * What is built here is osu-web's markup for them, so the class names are osu-web's too;
 * everything is local, so the page is complete with no network.
 */
import { escapeHtml } from './format.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';
import { MCOSU_DEFINITIONS, mcosuModNames } from './mcosu-mods.js';

/** A mod's name, type and settings: osu-web's, or McOsu's MC beside them. */
export function modDefinition(acronym) {
  return MOD_DEFINITIONS[acronym] ?? MCOSU_DEFINITIONS[acronym] ?? null;
}

/* Unique ids per generated SVG, since several appear on the page at once. */
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;

/** What each grade says, for its label. The picture is osu-web's GradeSmall-*.svg. */
const GRADE_TEXT = { XH: 'SS', X: 'SS', SH: 'S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };

/**
 * osu-web's `score-rank`: a 2em x 1em badge, sized by the font-size of wherever it sits.
 * Returns markup, not an element, so it can be dropped into a template string.
 */
export function gradeBadge(grade, { title } = {}) {
  const key = grade in GRADE_TEXT ? grade : 'F';
  const label = title ?? `${GRADE_TEXT[key]} rank`;
  return `<div class="score-rank score-rank--${key}" role="img" aria-label="${escapeHtml(label)}"></div>`;
}

/**
 * The badge for a play that has no grade, because it was never finished.
 *
 * Deliberately not the `F` badge. `F` is a real osu! grade, awarded to a score that exists
 * and failed; these plays have no score at all, and dressing them up as one would be a
 * quiet lie about what is known. An outline and a dash say "nothing here" instead, at the
 * same 32x16 as every grade so the rows still line up.
 */
export function incompleteBadge() {
  return `<svg viewBox="0 0 32 16" role="img" aria-label="Play not finished">
  <rect x="0.75" y="0.75" width="30.5" height="14.5" rx="7.25"
        fill="none" stroke-width="1.5" stroke-dasharray="3 2.5"
        style="stroke: hsl(var(--hsl-f1))"/>
  <rect x="12" y="7.25" width="8" height="1.5" rx="0.75" style="fill: hsl(var(--hsl-f1))"/>
</svg>`;
}

/* ------------------------------------------------------------------------ */
/* Mods                                                                     */
/* ------------------------------------------------------------------------ */

/*
 * osu!'s six mod types, which colour a badge (`.mod--type-*` in profile.css). A mod no build
 * of this app has heard of gets no type class and is drawn in a neutral grey: a guessed
 * colour would state a fact about the mod that is not true.
 */
const MOD_TYPES = new Set(['DifficultyReduction', 'DifficultyIncrease', 'Automation', 'Conversion', 'Fun', 'System']);

/*
 * The customised-mod cog, osu-web's `blanks/mod-cog-badge.svg` (c) ppy Pty Ltd, AGPL-3.0.
 * Inline rather than `<use href>`d from the file as mod.tsx does, so a saved copy of the page
 * carries it; the fills are the badge's own CSS variables either way.
 */
const COG = `<div class="mod__customised-indicator"><svg viewBox="0 0 32 16" width="100%" height="100%" aria-hidden="true">
  <circle cx="25.5996" cy="5.59961" r="4" style="fill: var(--type-fg-colour)"/>
  <path d="M27.7676 6.15915L27.3683 5.92852C27.4086 5.71102 27.4086 5.4879 27.3683 5.2704L27.7676 5.03977C27.8136 5.01352 27.8342 4.95915 27.8192 4.90852C27.7151 4.57477 27.5379 4.2729 27.3064 4.02165C27.2708 3.98321 27.2126 3.97384 27.1676 4.00009L26.7683 4.23071C26.6004 4.08634 26.4073 3.97477 26.1983 3.90165V3.44134C26.1983 3.38884 26.1617 3.3429 26.1101 3.33165C25.7661 3.25477 25.4136 3.25852 25.0864 3.33165C25.0348 3.3429 24.9983 3.38884 24.9983 3.44134V3.90259C24.7901 3.97665 24.597 4.08821 24.4283 4.23165L24.0298 4.00102C23.9839 3.97477 23.9267 3.98321 23.8911 4.02259C23.6595 4.2729 23.4823 4.57477 23.3783 4.90946C23.3623 4.96009 23.3839 5.01446 23.4298 5.04071L23.8292 5.27134C23.7889 5.48884 23.7889 5.71196 23.8292 5.92946L23.4298 6.16009C23.3839 6.18634 23.3633 6.24071 23.3783 6.29134C23.4823 6.62509 23.6595 6.92696 23.8911 7.17821C23.9267 7.21665 23.9848 7.22603 24.0298 7.19978L24.4292 6.96915C24.597 7.11353 24.7901 7.22509 24.9992 7.29821V7.75946C24.9992 7.81196 25.0358 7.8579 25.0873 7.86915C25.4314 7.94603 25.7839 7.94228 26.1111 7.86915C26.1626 7.8579 26.1992 7.81196 26.1992 7.75946V7.29821C26.4073 7.22415 26.6004 7.11259 26.7692 6.96915L27.1686 7.19978C27.2145 7.22603 27.2717 7.21759 27.3073 7.17821C27.5389 6.9279 27.7161 6.62602 27.8201 6.29134C27.8342 6.23977 27.8136 6.1854 27.7676 6.15915ZM25.5983 6.34946C25.1848 6.34946 24.8483 6.0129 24.8483 5.59946C24.8483 5.18602 25.1848 4.84946 25.5983 4.84946C26.0117 4.84946 26.3483 5.18602 26.3483 5.59946C26.3483 6.0129 26.0117 6.34946 25.5983 6.34946Z" style="fill: var(--type-bg-colour)"/>
</svg></div>`;

/* Mods whose extender shows a rate, and the adjustments Difficulty Adjust can show. */
const RATE_MODS = new Set(['HT', 'DC', 'DT', 'NC']);
const DA_DISPLAY = {
  approach_rate: ['AR', 1],
  circle_size: ['CS', 1],
  drain_rate: ['HP', 1],
  overall_difficulty: ['OD', 1],
  scroll_speed: ['SS', 2],
};

/**
 * What the extender tab says, following osu-web's `getExtendedContent`.
 *
 * Only a rate change and Difficulty Adjust get one, and Difficulty Adjust only when
 * *one* value was changed -- two would not fit, so osu! shows neither and leaves the
 * tooltip to say what happened. Everything else has an empty extender and no tab.
 */
function extendedContent(mod) {
  const settings = mod.settings ?? {};

  if (RATE_MODS.has(mod.acronym)) {
    const rate = settings.speed_change;
    return typeof rate === 'number' ? `${rate.toFixed(2)}×` : '';
  }

  if (mod.acronym === 'DA') {
    let shown = '';
    for (const [key, [acronym, digits]] of Object.entries(DA_DISPLAY)) {
      if (typeof settings[key] !== 'number') continue;
      if (shown !== '') return '';
      shown = `${acronym}${settings[key].toFixed(digits)}`;
    }
    return shown;
  }

  return '';
}

function settingValue(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * `Double Time (1.5×)` -- the mod's name first, then whatever was customised, which is
 * how osu! writes it. A setting osu! gives no label to is left out of the tooltip rather
 * than shown under its raw key.
 */
function modTitle(mod, definition) {
  // MC stands for McOsu's own mods, and its settings are which of them were on.
  if (mod.acronym === 'MC') {
    const names = mcosuModNames(mod.settings);
    return names.length === 0 ? 'McOsu' : `McOsu (${names.join(', ')})`;
  }

  const settings = [];
  for (const [key, value] of Object.entries(mod.settings ?? {})) {
    if (key === 'speed_change') {
      settings.push(`${value}×`);
      continue;
    }
    const label = definition?.settings?.[key];
    if (label != null) settings.push(`${label}: ${settingValue(value)}`);
  }

  const name = definition?.name ?? mod.acronym;
  return settings.length === 0 ? name : `${name} (${settings.join(', ')})`;
}

/**
 * One mod, as osu-web's `components/mod.tsx` draws it: the type's colour in the badge,
 * osu!'s glyph darkened into it, a tab on the right carrying the rate when the mod was sped
 * up or slowed down, and a cog when anything at all about it was customised.
 *
 * The glyph comes from `.mod__icon--<acronym>` in osu-web-art.css. A mod osu-web has no glyph
 * for shows its acronym instead (`data-acronym`), which is what osu! itself does.
 *
 * `title` replaces the tooltip, for a badge that stands for something other than a mod:
 * the play tracking filter's "no mods at all".
 */
export function modPill(mod, { title: named } = {}) {
  const m = typeof mod === 'string' ? { acronym: mod } : mod;
  const definition = modDefinition(m.acronym);
  const type = MOD_TYPES.has(definition?.type) ? ` mod--type-${definition.type}` : '';
  const extended = extendedContent(m);
  // MC's settings say which McOsu mods it stands for, not that anything was customised.
  const customised = m.acronym !== 'MC' && Object.keys(m.settings ?? {}).length > 0;
  const title = escapeHtml(named ?? modTitle(m, definition));
  const acronym = escapeHtml(m.acronym);

  return `<div class="mod${type}" role="img" aria-label="${title}" title="${title}">` +
    `<div class="mod__icon mod__icon--${acronym}" data-acronym="${acronym}"></div>` +
    (extended === '' ? '' : `<div class="mod__extender"><span>${escapeHtml(extended)}</span></div>`) +
    (customised ? COG : '') +
    '</div>';
}

export function modList(mods) {
  if (!mods || mods.length === 0) return '';
  return mods.map((mod) => modPill(mod)).join('');
}

/* ------------------------------------------------------------------------ */
/* Level hexagon                                                            */
/* ------------------------------------------------------------------------ */

/** The rounded hexagon osu! frames the level number in. */
export function levelBadge(level) {
  return `<div class="user-level">
  <svg viewBox="0 0 50 50" aria-hidden="true">
    <path style="fill: hsl(var(--hsl-c1))"
          d="M25 1.5 L43.6 12.25 A6 6 0 0 1 46.6 17.45 V32.55 A6 6 0 0 1 43.6 37.75
             L25 48.5 A6 6 0 0 1 19 48.5 L6.4 37.75 A6 6 0 0 1 3.4 32.55 V17.45
             A6 6 0 0 1 6.4 12.25 L25 1.5 Z"/>
  </svg>
  <span class="user-level__level">${escapeHtml(String(level))}</span>
</div>`;
}

/* ------------------------------------------------------------------------ */
/* Avatar and cover art                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Beatmap covers live on a plain image CDN keyed by beatmapset id, which online.db gives
 * us offline. They are progressive enhancement only: every caller must cope with the
 * request failing, because the app is expected to work with no network at all.
 */
export function coverUrl(beatmapsetId, size = 'list@2x') {
  if (beatmapsetId == null) return null;
  return `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/${size}.jpg`;
}

/**
 * The picture of a profile that has none: osu!'s own guest avatar, as osu-web shows for any
 * user without one. Filled by `.avatar-guest` in osu-web-art.css.
 */
export function guestAvatar(name) {
  return `<span class="avatar-guest" role="img" aria-label="${escapeHtml(name)}"></span>`;
}

/*
 * Medal colours by family, loosely following osu!'s own: combo and hits are the warm
 * "dedication" side, the skill families are cooler as they get harder.
 */
const MEDAL_HUE = { combo: 42, plays: 28, hits: 28, rank: 275, pass: 200, fc: 330, intro: 150 };

/**
 * A drawn stand-in for a medal image.
 *
 * osu!'s own icons are loaded over the top of this, the same arrangement beatmap covers
 * use: the placeholder sits underneath, so a request that fails -- or a page opened with no
 * network at all -- still shows a complete medal rather than a broken image.
 */
export function medalPlaceholder(medal) {
  const hue = MEDAL_HUE[medal.family] ?? 210;
  // Drawn in colour even when locked: `.badge-achievement--locked` greys the whole badge the
  // way osu! greys its own icon, so the placeholder and the real icon fade identically.
  const grad = nextId('mgrad');

  // A star level is worth showing on the face; a five-digit combo is not.
  const stamp = medal.family === 'pass' || medal.family === 'fc' ? String(medal.threshold) : '';

  return `<svg class="badge-achievement__placeholder" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="${grad}" cx="0.4" cy="0.32" r="0.85">
      <stop offset="0" stop-color="hsl(${hue}, 62%, 62%)"/>
      <stop offset="1" stop-color="hsl(${hue}, 55%, 28%)"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="44" fill="url(#${grad})"/>
  <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="3"/>
  <circle cx="50" cy="50" r="31" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="2"/>
  ${
    stamp
      ? `<text x="50" y="52" text-anchor="middle" dominant-baseline="central"
              font-size="34" font-weight="700" fill="rgba(255,255,255,.85)"
              font-family="var(--font-default)">${escapeHtml(stamp)}</text>`
      : ''
  }
</svg>`;
}

/**
 * One medal icon, osu-web's `badge-achievement`, with no text beside it -- the name,
 * description and date live in the hover card (see `medalCard` in main.js).
 *
 * `size` picks the modifier: `listing` in the Medals section, `recent-activity` in the
 * Recent feed, `tooltip` inside the card itself. The first two carry `data-medal` so the
 * card can find what to show, and are focusable so it opens from the keyboard or a tap.
 */
export function medalBadge(medal, size = 'listing') {
  const locked = medal.achievedAt === null;
  const interactive = size !== 'tooltip';
  return `<div class="badge-achievement badge-achievement--${size}${locked ? ' badge-achievement--locked' : ''}"
    ${interactive ? `tabindex="0" data-medal="${escapeHtml(medal.slug)}"` : ''}
    role="img" aria-label="${escapeHtml(medal.name)}">
  ${medalPlaceholder(medal)}
  <!-- Not lazy: a full-page screenshot renders below the fold without ever scrolling there,
       and lazy icons never loaded. -->
  <img class="badge-achievement__image" src="${escapeHtml(medal.icon)}" alt="">
</div>`;
}
