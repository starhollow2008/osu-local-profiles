/**
 * The bits of osu!'s visual language that are images on osu.ppy.sh: grade badges, mod
 * pills, the level hexagon, the avatar.
 *
 * They are generated as inline SVG rather than fetched, so the page is complete with no
 * network. The palettes come from docs/osu-web-reference.md; the shapes are drawn here
 * rather than copied from osu-web's assets.
 */
import { escapeHtml } from './format.js';

/* Unique ids per generated SVG, since several appear on the page at once. */
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;

/*
 * Grade badge palettes, read from GradeSmall-*.svg. `letter` is the flat letterform
 * colour; the silver grades (XH, SH) are the *same* palette but with the letterform
 * filled by a white -> #AADFF0 gradient instead, which is the entire "silver" cue.
 */
const GRADE_PALETTE = {
  X: { pill: '#CE1C9D', light: '#DE31AE', darkA: '#C30B90', darkB: '#BE0089', letter: '#5E244E' },
  S: { pill: '#00A8B5', light: '#02B5C3', darkA: '#009DAA', darkB: '#0096A2', letter: '#095056' },
  A: { pill: '#7CCE14', light: '#88DA20', darkA: '#72C904', darkB: '#69BB00', letter: '#275227' },
  B: { pill: '#E3B130', light: '#EBBD48', darkA: '#DCA519', darkB: '#D99D03', letter: '#553A2B' },
  C: { pill: '#F18252', light: '#FF8E5D', darkA: '#EA7948', darkB: '#E67342', letter: '#473625' },
  D: { pill: '#E95353', light: '#FF5A5A', darkA: '#DE4949', darkB: '#D63D3D', letter: '#512525' },
  F: { pill: '#373737', light: '#3F3F3F', darkA: '#2E2E2E', darkB: '#2E2E2E', letter: '#2B2B2B' },
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
  const fill = silver ? `url(#${grad})` : p.letter;

  return `<svg viewBox="0 0 32 16" role="img" aria-label="${escapeHtml(title ?? `${text} rank`)}">
  <defs>
    <clipPath id="${clip}"><rect width="32" height="16" rx="8"/></clipPath>
    ${silver ? `<linearGradient id="${grad}" x1="0" y1="2" x2="0" y2="16" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff"/><stop offset="1" stop-color="#AADFF0"/>
    </linearGradient>` : ''}
  </defs>
  <g clip-path="url(#${clip})">
    <rect width="32" height="16" fill="${p.pill}"/>
    <path d="M16 -8 L34 22 L-2 22 Z" fill="${p.light}"/>
    <path d="M26 2 L33 14 L19 14 Z" fill="${p.darkA}"/>
    <path d="M7 -3 L12 5 L2 5 Z" fill="${p.darkB}"/>
    <path d="M9 12 L14 20 L4 20 Z" fill="${p.darkB}"/>
  </g>
  <text x="16" y="12.2" text-anchor="middle" fill="${fill}"
        font-size="${text.length > 1 ? 10.5 : 11}" font-weight="800"
        letter-spacing="${text.length > 1 ? -0.6 : 0}"
        font-family="var(--font-default)">${text}</text>
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
 * Acronym -> ModType, so each pill gets the accent colour osu! gives that category
 * (OsuColour.ForModType). An acronym missing here is drawn in a neutral grey rather than
 * being guessed into the wrong category.
 */
const MOD_TYPES = {
  reduction: ['EZ', 'NF', 'HT', 'DC'],
  increase: ['HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'AC', 'BL', 'ST'],
  automation: ['AT', 'CN', 'RX', 'AP', 'SO'],
  conversion: ['CL', 'DA', 'RD', 'MR', 'TP', 'AL', 'SG', 'DS', 'CS', 'FR', 'SW', 'HO',
    '1K', '2K', '3K', '4K', '5K', '6K', '7K', '8K', '9K', '10K'],
  fun: ['TR', 'WG', 'SI', 'MG', 'RP', 'AS', 'MU', 'NS', 'BR', 'BU', 'SY', 'DP', 'BM', 'WU', 'WD'],
  system: ['SV2', 'TD'],
};

const MOD_COLOUR = (() => {
  const map = new Map();
  for (const [type, acronyms] of Object.entries(MOD_TYPES)) {
    for (const a of acronyms) map.set(a, `var(--mod-${type})`);
  }
  return map;
})();

/*
 * Setting keys lazer writes, in the names osu! itself uses. Anything not listed is still
 * shown, just with its raw key humanised -- a new mod setting should be visible rather
 * than silently dropped.
 */
const SETTING_LABELS = {
  speed_change: 'Rate',
  circle_size: 'CS',
  approach_rate: 'AR',
  drain_rate: 'HP',
  overall_difficulty: 'OD',
  initial_rate: 'From',
  final_rate: 'To',
  extended_limits: 'Extended limits',
  adjust_pitch: 'Pitch',
  only_fade_approach_circles: 'Fade approach circles only',
  restart: 'Restart on fail',
  retries: 'Retries',
};

const humanise = (key) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function settingValue(key, value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  // Rates read as "1.3x" everywhere in osu!, so keep that form.
  if (key === 'speed_change' || key === 'initial_rate' || key === 'final_rate') return `${value}x`;
  return String(value);
}

function settingEntries(mod) {
  return Object.entries(mod.settings ?? {}).map(
    ([k, v]) => `${SETTING_LABELS[k] ?? humanise(k)} ${settingValue(k, v)}`,
  );
}

/**
 * One mod. A customised mod is marked so it cannot be mistaken for the default: the rate
 * is shown inline because it changes the difficulty outright, and every setting is listed
 * in the tooltip.
 */
export function modPill(mod) {
  const m = typeof mod === 'string' ? { acronym: mod } : mod;
  const colour = MOD_COLOUR.get(m.acronym) ?? 'var(--mod-unknown)';
  const entries = settingEntries(m);
  const rate = m.settings?.speed_change;
  const label = rate == null ? m.acronym : `${m.acronym} ${rate}x`;
  const title = entries.length > 0 ? ` title="${escapeHtml(entries.join(' · '))}"` : '';
  const customised = entries.length > 0 ? ' mod--customised' : '';

  return `<span class="mod${customised}" style="--mod-colour: ${colour}"${title}>${escapeHtml(label)}</span>`;
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

/** A drawn stand-in for a profile picture, since a fresh profile has no account. */
export function generatedAvatar(name) {
  const hue = hashHue(name || 'fresh');
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
const MEDAL_HUE = { combo: 42, plays: 28, hits: 28, rank: 275, pass: 200, fc: 330 };

/**
 * A drawn stand-in for a medal image.
 *
 * osu!'s own icons are loaded over the top of this, the same arrangement beatmap covers
 * use: the placeholder sits underneath, so a request that fails -- or a page opened with no
 * network at all -- still shows a complete medal rather than a broken image.
 */
export function medalPlaceholder(medal) {
  const hue = MEDAL_HUE[medal.family] ?? 210;
  const locked = medal.achievedAt === null;
  const grad = nextId('mgrad');

  // A star level is worth showing on the face; a five-digit combo is not.
  const stamp = medal.family === 'pass' || medal.family === 'fc' ? String(medal.threshold) : '';

  return `<svg class="medal__placeholder" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <radialGradient id="${grad}" cx="0.4" cy="0.32" r="0.85">
      <stop offset="0" stop-color="hsl(${hue}, ${locked ? 8 : 62}%, ${locked ? 34 : 62}%)"/>
      <stop offset="1" stop-color="hsl(${hue}, ${locked ? 6 : 55}%, ${locked ? 18 : 28}%)"/>
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
