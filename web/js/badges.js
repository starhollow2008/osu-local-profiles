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

export function modPill(acronym) {
  const colour = MOD_COLOUR.get(acronym) ?? 'var(--mod-unknown)';
  return `<span class="mod" style="--mod-colour: ${colour}">${escapeHtml(acronym)}</span>`;
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
