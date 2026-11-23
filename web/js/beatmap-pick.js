/**
 * Choosing a beatmap and describing a play on it, as the pp calculator (pp-calculator.js) and
 * Manually enter a score (manual-entry.js) both do, so the two look and work alike.
 *
 * A beatmap row is drawn as favourite beatmaps are: its cover beside it and faded behind it, its
 * name and mapper, its star rating without mods in osu-web's colours, and its ruleset's icon. The
 * star rating comes from the calculator the app prices with (POST /api/beatmaps/stars), after the
 * rows are drawn: osu! works each one out, so the list never waits for them.
 */
import { escapeHtml, MODE_NAMES } from './format.js';
import { coverUrl, modDefinition, modPill } from './badges.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';
import { difficultyBadge } from './beatmapsets.js';
import { original } from './metadata.js';
import { postJson } from './ui.js';
import { t } from './i18n.js';

/** Each ruleset's icon, as osu-web names them (`.mode-icon`). */
export const RULESETS = ['osu', 'taiko', 'fruits', 'mania'];

export const modeIcon = (m) => `<span class="mode-icon mode-icon--${RULESETS[m]}" aria-hidden="true"></span>`;

/** A beatmap link or bare id, which osu! is asked about, rather than words to search for. */
export const looksLikeLink = (q) => /^\d+$/.test(q) || /osu\.ppy\.sh\//i.test(q);

/** The rulesets a beatmap can be played in: one made for osu! in any, the others only in their own. */
export const modesFor = (b) => (!b || b.mode === 0 ? [0, 1, 2, 3] : [b.mode]);

/** Each ruleset's judgements, by the replay counter that holds them, as osu!stable labels them. */
export const JUDGEMENT_FIELDS = {
  0: [['c300', () => '300'], ['c100', () => '100'], ['c50', () => '50'], ['miss', () => t('manual.miss')]],
  1: [['c300', () => t('manual.great')], ['c100', () => t('manual.good')], ['miss', () => t('manual.miss')]],
  2: [
    ['c300', () => t('manual.fruits')],
    ['c100', () => t('manual.drops')],
    ['c50', () => t('manual.droplets')],
    ['katu', () => t('manual.missedDroplets')],
    ['miss', () => t('manual.miss')],
  ],
  3: [
    ['geki', () => 'MAX'],
    ['c300', () => '300'],
    ['katu', () => '200'],
    ['c100', () => '100'],
    ['c50', () => '50'],
    ['miss', () => t('manual.miss')],
  ],
};

/** The judgement that is whatever the others leave of a perfect play: the best one. */
export const REMAINDER = { 0: 'c300', 1: 'c300', 2: 'c300', 3: 'geki' };

/** How many judgements are left for the best one once the others are counted, from a perfect play's. */
export function remainderOf(mode, perfect, counts) {
  const key = REMAINDER[mode];
  const total = Object.values(perfect).reduce((a, b) => a + b, 0);
  const others = (JUDGEMENT_FIELDS[mode] ?? []).reduce((sum, [k]) => (k === key ? sum : sum + (counts[k] ?? 0)), 0);
  return { key, total, left: total - others };
}

/** osu!'s mod groups, in lazer's order, as the play tracking filter shows them. */
const MOD_GROUPS = [
  ['DifficultyReduction', () => t('mods.difficultyReduction')],
  ['DifficultyIncrease', () => t('mods.difficultyIncrease')],
  ['Conversion', () => t('mods.conversion')],
  // Relax, Autopilot and Spun Out: Autoplay and Cinema are never offered.
  ['Automation', () => t('mods.automation')],
  ['Fun', () => t('mods.fun')],
  ['System', () => t('mods.system')],
];

/**
 * Mods to choose from, grouped as osu!'s mod select groups them, each a chip to press.
 * `inertTitle(acronym)`, when it returns text, shows that mod dimmed and not to be chosen.
 */
export function modGrid(available, inertTitle = () => null) {
  return MOD_GROUPS.map(([type, label]) => {
    const inGroup = available.filter((a) => modDefinition(a)?.type === type).sort();
    if (inGroup.length === 0) return '';
    return `<div class="mod-grid__group">
      <div class="mod-grid__label">${escapeHtml(label())}</div>
      <div class="mod-grid__row">${inGroup
        .map((a) => {
          const inert = inertTitle(a);
          return inert
            ? `<button type="button" class="mod-chip mod-chip--inert" data-mod="${escapeHtml(a)}" data-inert
                aria-disabled="true" title="${escapeHtml(inert)}">${modPill(a)}</button>`
            : `<button type="button" class="mod-chip" data-mod="${escapeHtml(a)}" aria-pressed="false"
                title="${escapeHtml(modDefinition(a)?.name ?? a)}">${modPill(a)}</button>`;
        })
        .join('')}</div>
    </div>`;
  }).join('');
}

/** Light the chips that are on. */
export function markMods(grid, isOn) {
  for (const chip of grid.querySelectorAll('[data-mod]:not([data-inert])')) {
    const on = isOn(chip.dataset.mod);
    chip.classList.toggle('mod-chip--required', on);
    chip.setAttribute('aria-pressed', String(on));
  }
}

/** The rulesets as buttons, left to right as osu! orders them. */
export const modeButtons = (modes) =>
  modes
    .map((m) => `<button type="button" class="pp-calc__mode" data-mode="${m}" role="radio"
      aria-label="${escapeHtml(MODE_NAMES[m])}" data-tooltip="${escapeHtml(MODE_NAMES[m])}">${modeIcon(m)}</button>`)
    .join('');

/** Light the ruleset chosen. */
export function markMode(group, ruleset) {
  for (const button of group.querySelectorAll('[data-mode]')) {
    const on = Number(button.dataset.mode) === ruleset;
    button.classList.toggle('pp-calc__mode--active', on);
    button.setAttribute('aria-checked', String(on));
  }
}

/* ------------------------------------------------------------------ rows */

/** A beatmap's cover from osu!, as `--bg` and `--bg-2x`: nothing for one never submitted. */
export function coverVars(b, size) {
  const set = Number(b.beatmapsetId);
  if (!Number.isInteger(set) || set <= 0) return '';
  return `--bg: url('${coverUrl(set, size)}'); --bg-2x: url('${coverUrl(set, `${size}@2x`)}')`;
}

/** Star ratings without mods already worked out, by MD5: null for one the calculator could not describe. */
const starsKnown = new Map();
const starsAsked = new Set();

const starsSlot = (md5) => {
  const stars = starsKnown.get(md5);
  return `<span class="beatmap-pick__stars" data-stars-for="${escapeHtml(md5)}">${stars == null ? '' : difficultyBadge(stars)}</span>`;
};

/**
 * A beatmap as a row shows it, as favourite beatmaps are shown: its cover beside it and faded
 * behind it (the row's own `--bg`), its name and who mapped it, and its star rating.
 */
export function beatmapLine(b) {
  const thumb = coverVars(b, 'list');
  return `<span class="beatmapset-cover pp-calc__thumb"${thumb ? ` style="${thumb}"` : ''}></span>
    <span class="pp-calc__name">
      <span class="u-ellipsis">${escapeHtml(original(b.title, b.titleOriginal))}</span>
      ${b.creator ? `<span class="pp-calc__mapper u-ellipsis">${escapeHtml(t('beatmap.mappedBy', { mapper: b.creator }))}</span>` : ''}
    </span>
    ${starsSlot(b.md5)}`;
}

/** Beatmaps found, one button each, with its ruleset's icon. */
export function foundRows(found) {
  return found
    .map(
      (b, i) => `<button type="button" class="manual-beatmap pp-calc__beatmap" data-found="${i}" style="${coverVars(b, 'card')}">
        ${beatmapLine(b)}
        <span class="pp-calc__beatmap-mode" data-tooltip="${escapeHtml(MODE_NAMES[b.mode])}">${modeIcon(b.mode)}</span>
      </button>`,
    )
    .join('');
}

/** Show every star rating known in the rows on the page. */
function showStars() {
  for (const slot of document.querySelectorAll('[data-stars-for]')) {
    const stars = starsKnown.get(slot.dataset.starsFor);
    if (stars != null && !slot.firstElementChild) slot.innerHTML = difficultyBadge(stars);
  }
}

/** How many star ratings one request asks for: the first rows fill in quickly, the rest after. */
const STARS_AT_ONCE = 5;

/** Ask for the star ratings of these beatmaps not yet known, a few at a time, and show each as it comes. */
export async function loadStars(beatmaps) {
  const wanted = [...new Set(beatmaps.map((b) => b.md5))].filter((md5) => md5 && !starsKnown.has(md5) && !starsAsked.has(md5));
  for (let i = 0; i < wanted.length; i += STARS_AT_ONCE) {
    const chunk = wanted.slice(i, i + STARS_AT_ONCE);
    for (const md5 of chunk) starsAsked.add(md5);
    try {
      const d = await postJson('/api/beatmaps/stars', { md5s: chunk });
      for (const md5 of chunk) starsKnown.set(md5, d.stars?.[md5] ?? null);
    } catch {
      // Left without: asked again the next time these rows are shown.
    } finally {
      for (const md5 of chunk) starsAsked.delete(md5);
    }
    showStars();
  }
}

/* ------------------------------------------------------------ lazer's mods */

/** Not offered: Autoplay and Cinema have no player, and ScoreV2 is a system mod. */
const LEFT_OUT = new Set(['AT', 'CN', 'SV2']);

/** lazer's mods a ruleset offers: every one a player can play with. */
export const lazerMods = (mode) =>
  Object.entries(MOD_DEFINITIONS)
    .filter(([acronym, d]) => d.playable && d.modes.includes(mode) && !LEFT_OUT.has(acronym))
    .map(([acronym]) => acronym);

/** Mods that cannot be on together, as in osu!'s mod select: choosing one takes off the others in its set. */
const EXCLUSIVE = [
  ['EZ', 'HR'],
  ['HT', 'DC', 'DT', 'NC', 'WU', 'WD', 'AS'],
  ['NF', 'SD', 'PF'],
  ['NF', 'AC'],
  ['RX', 'AP'],
  ['RX', 'NF', 'SD', 'PF', 'AC'],
  ['AP', 'NF', 'SD', 'PF', 'AC'],
  ['HD', 'FI'],
  ['1K', '2K', '3K', '4K', '5K', '6K', '7K', '8K', '9K', '10K'],
];

/** The rate mods' speed: osu!'s default, and the range its slider allows. */
const RATES = {
  DT: { value: 1.5, min: 1.01, max: 2 },
  NC: { value: 1.5, min: 1.01, max: 2 },
  HT: { value: 0.75, min: 0.5, max: 0.99 },
  DC: { value: 0.75, min: 0.5, max: 0.99 },
};

/**
 * Mods osu! gives a seed (Random, Target Practice). Without one, osu! rolls a new one every time it
 * prices, so the pp would change with every request: choosing one picks a seed, as osu! does.
 */
const seeded = (acronym) => Boolean(MOD_DEFINITIONS[acronym]?.settings?.seed);
/** osu!'s seeds are ints, and it picks its own from 0 up to int's largest. */
const MAX_SEED = 2147483647;
const newSeed = () => Math.floor(Math.random() * MAX_SEED);

/** Difficulty Adjust's settings that move pp, per ruleset. */
const DA_SETTINGS = {
  0: ['circle_size', 'approach_rate', 'overall_difficulty', 'drain_rate'],
  1: ['overall_difficulty', 'drain_rate'],
  2: ['circle_size', 'approach_rate', 'drain_rate'],
  3: ['overall_difficulty', 'drain_rate'],
};

/** What lazer judges besides each object in osu!, missed: a play as lazer scores it. */
export const SLIDER_FIELDS = [
  ['tailMiss', () => t('ppCalc.sliderEndsMissed')],
  ['tickMiss', () => t('ppCalc.sliderTicksMissed')],
];

/**
 * Choose a mod, or take it off (`mods`: acronym -> its settings). Choosing one takes off those it
 * cannot be on with, and a mod with a seed comes with one.
 */
export function toggleMod(mods, acronym) {
  if (mods.has(acronym)) {
    mods.delete(acronym);
    return;
  }
  for (const set of EXCLUSIVE) if (set.includes(acronym)) for (const other of set) if (other !== acronym) mods.delete(other);
  mods.set(acronym, seeded(acronym) ? { seed: newSeed() } : {});
}

/** The settings of the mods chosen that move pp, as fields: a rate mod's speed, Difficulty Adjust's values (blank is the beatmap's own), a seed. */
export function modSettingsFields(mods, mode) {
  const fields = [];
  for (const [acronym, settings] of mods) {
    if (RATES[acronym]) {
      const r = RATES[acronym];
      fields.push(`<label class="field"><span>${escapeHtml(t('ppCalc.speed', { mod: acronym }))}</span>
        <input type="number" data-mod-setting="${acronym}" data-key="speed_change" min="${r.min}" max="${r.max}" step="0.01"
               value="${settings.speed_change ?? r.value}"></label>`);
    }
    if (acronym === 'DA') {
      for (const key of DA_SETTINGS[mode]) {
        fields.push(`<label class="field"><span>${escapeHtml(MOD_DEFINITIONS.DA.settings[key])}</span>
          <input type="number" data-mod-setting="DA" data-key="${key}" min="0" max="11" step="0.1"
                 placeholder="${escapeHtml(t('ppCalc.asMapped'))}" value="${settings[key] ?? ''}"></label>`);
      }
    }
    if (seeded(acronym)) {
      fields.push(`<label class="field"><span>${escapeHtml(t('ppCalc.seed', { mod: acronym }))}</span>
        <input type="number" data-mod-setting="${acronym}" data-key="seed" min="0" max="${MAX_SEED}" step="1"
               value="${settings.seed ?? ''}"></label>`);
    }
  }
  return fields.join('');
}

/** A setting typed into one of those fields, kept on its mod. False when the input was not one. */
export function readModSetting(mods, input) {
  const settings = input?.dataset.modSetting ? mods.get(input.dataset.modSetting) : null;
  if (!settings) return false;
  let value = input.value === '' ? null : Number(input.value);
  // A seed is a whole number in osu!'s range; a blank one gets a new seed when it is priced.
  if (value !== null && input.dataset.key === 'seed') value = Math.min(MAX_SEED, Math.max(0, Math.trunc(value)));
  if (value === null || !Number.isFinite(value)) delete settings[input.dataset.key];
  else settings[input.dataset.key] = value;
  return true;
}

/** Once a seed field is left, it shows the seed priced with. `mods()` is the map the fields are for. */
export function showSeedOnLeave(container, mods) {
  container.addEventListener('focusout', (e) => {
    const input = e.target.closest('[data-key="seed"]');
    const seed = input && mods().get(input.dataset.modSetting)?.seed;
    if (seed != null) input.value = String(seed);
  });
}

/** The mods as osu! writes them: settings only when changed, Difficulty Adjust past 10 with its extended limits. */
export function modsForRequest(mods) {
  return [...mods].map(([acronym, settings]) => {
    // Kept on the mod, so the next price has the same one: a score opened without one, or a seed cleared.
    if (seeded(acronym) && settings.seed == null) settings.seed = newSeed();
    const changed = { ...settings };
    if (RATES[acronym] && changed.speed_change === RATES[acronym].value) delete changed.speed_change;
    if (acronym === 'DA' && Object.values(changed).some((v) => v > 10)) changed.extended_limits = true;
    return Object.keys(changed).length ? { acronym, settings: changed } : { acronym };
  });
}
