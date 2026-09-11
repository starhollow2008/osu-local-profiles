/**
 * The bits of osu!'s visual language that are images on osu.ppy.sh: grade badges, mod
 * pills, the level hexagon, the avatar.
 *
 * They are generated as inline SVG rather than fetched, so the page is complete with no
 * network. The palettes come from docs/osu-web-reference.md; the shapes are drawn here
 * rather than copied from osu-web's assets.
 */
import { escapeHtml } from './format.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';

/* Unique ids per generated SVG, since several appear on the page at once. */
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;

/*
 * Grade badge palettes, read from GradeSmall-*.svg.
 *
 * `letter` is the flat letterform colour used by A..F. SS and S do not use it: their
 * letterform carries a *gradient*, and which gradient is the entire gold/silver cue --
 * gold #FFE7A8 -> #FFB800 on SS/S, white -> #AADFF0 on the silver SSH/SH. Both run
 * vertically from y=2.08 to y=16 in the same 32x16 box, so the two variants differ by
 * nothing but their two stops.
 */
const GRADE_GRADIENT = {
  gold: ['#FFE7A8', '#FFB800'],
  silver: ['#FFFFFF', '#AADFF0'],
};
/*
 * `letter` is osu!'s letterform colour taken about a fifth darker. osu! draws the letter in
 * Venera, a wide heavy display face this project cannot ship; in the fallback face the same
 * colour reads lighter and thinner against the pill, so the extra depth restores roughly
 * the contrast osu!'s own badge has.
 */
const GRADE_PALETTE = {
  X: { pill: '#CE1C9D', light: '#DE31AE', darkA: '#C30B90', darkB: '#BE0089', letter: '#4B1D3E' },
  S: { pill: '#00A8B5', light: '#02B5C3', darkA: '#009DAA', darkB: '#0096A2', letter: '#074045' },
  A: { pill: '#7CCE14', light: '#88DA20', darkA: '#72C904', darkB: '#69BB00', letter: '#1F421F' },
  B: { pill: '#E3B130', light: '#EBBD48', darkA: '#DCA519', darkB: '#D99D03', letter: '#442E22' },
  C: { pill: '#F18252', light: '#FF8E5D', darkA: '#EA7948', darkB: '#E67342', letter: '#392B1E' },
  D: { pill: '#E95353', light: '#FF5A5A', darkA: '#DE4949', darkB: '#D63D3D', letter: '#411E1E' },
  F: { pill: '#373737', light: '#3F3F3F', darkA: '#2E2E2E', darkB: '#2E2E2E', letter: '#1F1F1F' },
};

/** XH/SH are the silver variants of X/S; everything else maps to itself. */
const GRADE_BASE = { XH: 'X', X: 'X', SH: 'S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };
const GRADE_TEXT = { XH: 'SS', X: 'SS', SH: 'S', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F' };

/**
 * A 32x16 pill, faceted with flat triangles and stamped with the grade. Returns markup,
 * not an element, so it can be dropped into a template string.
 */
export function gradeBadge(grade, { title } = {}) {
  const key = GRADE_BASE[grade] ?? 'F';
  const p = GRADE_PALETTE[key];
  const text = GRADE_TEXT[grade] ?? 'F';
  const silver = grade === 'XH' || grade === 'SH';

  const clip = nextId('gclip');
  const grad = nextId('ggrad');
  // Only SS and S are gradient-filled; A..F take the flat dark letterform.
  const stops = key === 'X' || key === 'S' ? GRADE_GRADIENT[silver ? 'silver' : 'gold'] : null;
  const fill = stops === null ? p.letter : `url(#${grad})`;

  return `<svg viewBox="0 0 32 16" role="img" aria-label="${escapeHtml(title ?? `${text} rank`)}">
  <defs>
    <clipPath id="${clip}"><rect width="32" height="16" rx="8"/></clipPath>
    ${stops === null ? '' : `<linearGradient id="${grad}" x1="16" y1="2.08" x2="16" y2="16" gradientUnits="userSpaceOnUse">
      <stop stop-color="${stops[0]}"/><stop offset="1" stop-color="${stops[1]}"/>
    </linearGradient>`}
  </defs>
  <g clip-path="url(#${clip})">
    <rect width="32" height="16" fill="${p.pill}"/>
    <path d="M16 -8 L34 22 L-2 22 Z" fill="${p.light}"/>
    <path d="M26 2 L33 14 L19 14 Z" fill="${p.darkA}"/>
    <path d="M7 -3 L12 5 L2 5 Z" fill="${p.darkB}"/>
    <path d="M9 12 L14 20 L4 20 Z" fill="${p.darkB}"/>
  </g>
  <!-- Sized for the fallback face, which is narrower than osu!'s Venera: at osu!'s own size
       the letter sat small in the pill. The gold and silver letters get a faint dark edge,
       because a light gradient on a saturated pill otherwise loses its outline. -->
  <text x="16" y="12.6" text-anchor="middle" fill="${fill}"
        font-size="${text.length > 1 ? 12 : 12.5}" font-weight="900"
        letter-spacing="${text.length > 1 ? -0.5 : 0}"
        ${stops === null ? '' : 'stroke="rgba(0,0,0,0.28)" stroke-width="0.7" paint-order="stroke"'}
        style="font-family: var(--font-grade)">${text}</text>
</svg>`;
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
 * The accent colour of each mod type, from ppy/osu's `OsuColour.ForModType`, keyed by
 * osu!'s own type names so this table lines up with `mod-definitions.js` entry for entry.
 *
 * A mod no build of this app has heard of is drawn in a neutral grey. It is not guessed
 * into a category: a wrong colour states a fact about the mod that is not true.
 */
const MOD_TYPE_COLOUR = {
  DifficultyReduction: '#b2ff66',
  DifficultyIncrease: '#ff6666',
  Automation: '#66ccff',
  Conversion: '#8c66ff',
  Fun: '#ff66ab',
  System: '#ffcc22',
};

/* hsl(var(--hsl-b1)) resolved, because the badge does its colour arithmetic in JS. */
const MOD_UNKNOWN_COLOUR = '#705c65';

const round2 = (n) => Math.round(n * 100) / 100;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

function toHex(rgb) {
  const byte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${rgb.map(byte).join('')}`;
}

/**
 * Darken an accent colour towards black, the two ways osu! does it.
 *
 * The two are not the same operation. The glyph colour is `Colour4` interpolation, which
 * osu!framework does in *linear* sRGB; the extender is a plain sRGB multiply. osu-web's
 * `mod.less` reproduces both with `color-mix` and spells out where each comes from --
 * `.Darken(2.8f)` divides every component by 3.8, which is a mix at 1/3.8 = 26.3%.
 *
 * Doing the arithmetic here rather than leaving it to `color-mix` keeps the result the
 * same on any browser, and keeps both constants visible next to their reason.
 */
function darken(hex, amount, { linear }) {
  const rgb = channels(hex);
  return toHex(linear ? rgb.map((c) => linearToSrgb(srgbToLinear(c) * amount)) : rgb.map((c) => c * amount));
}

/*
 * The badge a mod is stamped on: flat top and bottom, a point at each end, rounded
 * corners. osu-web masks with `blanks/mod-icon.svg` at 100x70 and `mod-icon-extender.svg`
 * at 155x70, which is where these numbers come from -- 70 units to 1em, so the icon is
 * 1.42em wide, the extender 2.2em, and they overlap by 0.5em.
 *
 * The shape is constructed here rather than copied: a hexagon inset by half the stroke
 * width and stroked with a round join comes back out to the full size with rounded
 * corners, at the same edge slope as osu!'s.
 */
const MOD_UNIT = 70;
const MOD_ICON_W = 100;
const MOD_EXTENDER_W = 155;
const MOD_OVERLAP = 35;
const MOD_ROUND = 12;

function hexagonPoints(x, width) {
  const inset = MOD_ROUND / 2;
  const middle = MOD_UNIT / 2;
  const top = inset;
  const bottom = MOD_UNIT - inset;
  const left = x + inset;
  const right = x + width - inset;
  // osu!'s end slope: 25.5 across for 35 up.
  const run = (middle - inset) * (25.5 / 35);

  return [
    [left, middle],
    [left + run, top],
    [right - run, top],
    [right, middle],
    [right - run, bottom],
    [left + run, bottom],
  ]
    .map(([px, py]) => `${round2(px)},${round2(py)}`)
    .join(' ');
}

function hexagon(x, width, colour) {
  return `<polygon points="${hexagonPoints(x, width)}" stroke-width="${MOD_ROUND}"
      stroke-linejoin="round" style="fill: ${colour}; stroke: ${colour}"/>`;
}

/** A gear, generated from its tooth count rather than drawn. */
function cogPoints(cx, cy, outer, inner, teeth) {
  const points = [];
  const steps = teeth * 2;
  for (let i = 0; i < steps; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
    points.push(`${round2(cx + Math.cos(angle) * r)},${round2(cy + Math.sin(angle) * r)}`);
  }
  return points.join(' ');
}

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
 * One mod, as osu! draws it: the type's colour in the badge, the acronym darkened into it,
 * a tab on the right carrying the rate when the mod was sped up or slowed down, and a cog
 * when anything at all about it was customised.
 *
 * The acronym is the label rather than a glyph. osu!'s own glyphs are artwork this project
 * cannot redistribute (see docs/osu-web-fidelity.md), and an acronym on the badge is what
 * osu! itself falls back to for any mod it has no glyph for.
 */
export function modPill(mod) {
  const m = typeof mod === 'string' ? { acronym: mod } : mod;
  const definition = MOD_DEFINITIONS[m.acronym] ?? null;
  const colour = definition === null
    ? MOD_UNKNOWN_COLOUR
    : MOD_TYPE_COLOUR[definition.type] ?? MOD_UNKNOWN_COLOUR;

  // osu!'s 10% (linear), taken a little further: the fallback face is lighter than Venera,
  // so the same colour reads weaker on the badge than it does on osu!.
  const glyphColour = darken(colour, 0.075, { linear: true });
  const extenderColour = darken(colour, 0.263, { linear: false });

  const extended = extendedContent(m);
  const customised = Object.keys(m.settings ?? {}).length > 0;
  const width = extended === '' ? MOD_ICON_W : MOD_ICON_W + MOD_EXTENDER_W - MOD_OVERLAP;
  const title = modTitle(m, definition);

  const parts = [];

  // Drawn first so the icon overlaps it, which is what hides the tab's left-hand notch.
  if (extended !== '') {
    parts.push(hexagon(MOD_ICON_W - MOD_OVERLAP, MOD_EXTENDER_W, extenderColour));
    parts.push(`<text x="${round2((MOD_ICON_W + width) / 2)}" y="${MOD_UNIT / 2}"
      text-anchor="middle" dominant-baseline="central" font-size="35" font-weight="700"
      style="fill: ${colour}">${escapeHtml(extended)}</text>`);
  }

  parts.push(hexagon(0, MOD_ICON_W, colour));
  // `mod.less` sets 0.4em (28 of 70) in Venera. The fallback face is narrower and lighter,
  // so it is drawn at ~0.49em to fill the badge the way osu!'s acronym does.
  parts.push(`<text x="${MOD_ICON_W / 2}" y="${MOD_UNIT / 2 + 1}" text-anchor="middle"
    dominant-baseline="central" font-size="${m.acronym.length > 2 ? 28 : 34}" font-weight="900" letter-spacing="-0.5"
    style="fill: ${glyphColour}; font-family: var(--font-grade)">${escapeHtml(m.acronym)}</text>`);

  /*
   * osu! marks a customised mod with a cog over the badge's top-right corner, half of it
   * hanging outside. Here it is tucked inside instead: the badge's box is its own SVG, and
   * growing that box to let the cog overhang would make a customised mod a different size
   * from every other mod in the row.
   */
  if (customised) {
    parts.push(`<g class="mod__customised-indicator">
      <polygon points="${cogPoints(72, 16, 10, 7, 7)}" style="fill: ${glyphColour}"/>
      <circle cx="72" cy="16" r="3.5" style="fill: ${colour}"/>
    </g>`);
  }

  return `<svg class="mod" viewBox="0 0 ${width} ${MOD_UNIT}" role="img"
    aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>${parts.join('')}</svg>`;
}

export function modList(mods) {
  if (!mods || mods.length === 0) return '';
  return mods.map(modPill).join('');
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

function hashHue(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

/** A drawn stand-in for a profile picture, since a local profile has no account. */
export function generatedAvatar(name) {
  const hue = hashHue(name || 'local');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const grad = nextId('agrad');
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${escapeHtml(name)}">
  <defs>
    <linearGradient id="${grad}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 45%, 42%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360}, 45%, 22%)"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#${grad})"/>
  <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
        font-size="46" font-weight="700" fill="rgba(255,255,255,.85)"
        font-family="var(--font-default)">${escapeHtml(initial)}</text>
</svg>`;
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
