/**
 * The Play tracking filter dialog: which plays this profile records at all.
 *
 * Every other dialog on this page changes how stored plays are *read*. This one decides
 * whether a play is written down, and a play it turns away is gone -- so the whole design is
 * about making the current rule impossible to misread. Three things follow from that:
 *
 * - It opens switched off, and switching it on narrows nothing. Every criterion starts at its
 *   widest, so the dialog can only ever be made stricter on purpose.
 * - Every section says what it means in a sentence underneath it, recomputed as the controls
 *   move. A grid of sixty-nine mod icons cannot be read as a rule; "tracks DT and DTHD" can.
 * - Anything the filter cannot know is said out loud rather than left to be discovered: the
 *   two criteria that cannot judge an unfinished play, and the three that need osu!lazer's
 *   `online.db` and so cannot work on an osu!stable-only machine.
 *
 * `src/tracking-filter.ts` is the authority on the shape and on what matches; this file only
 * edits the object and posts it back. Nothing here re-implements the matching rule.
 */
import { escapeHtml, MODE_NAMES } from './format.js';
import { modPill } from './badges.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';
import { hint, postJson, toast } from './ui.js';

const $ = (id) => document.getElementById(id);

/** Matches `OSU_EPOCH` in src/tracking-filter.ts: the day osu!'s beatmap listing begins. */
const OSU_EPOCH = Date.UTC(2007, 9, 6);
const DAY = 86_400_000;

const MAX_STARS = 15;
const MAX_LENGTH_SECONDS = 3600;

/**
 * Autoplay and Cinema are left out of the grid on purpose: no setting in this app can make
 * either count (`NEVER_COUNTABLE` in src/calc/pp.ts), so offering them as a choice would be
 * a control that cannot do anything. ScoreV2 is not a mod a player picks at all.
 */
const HIDDEN_MODS = new Set(['AT', 'CN', 'SV2']);

/** osu!'s own mod groups, in lazer's own order, with the wording lazer uses for each. */
const MOD_GROUPS = [
  ['DifficultyReduction', 'Difficulty reduction'],
  ['DifficultyIncrease', 'Difficulty increase'],
  ['Conversion', 'Conversion'],
  ['Automation', 'Automation'],
  ['Fun', 'Fun'],
  ['System', 'System'],
];

const CATEGORY_LABELS = [
  ['ranked', 'Ranked'],
  ['qualified', 'Qualified'],
  ['loved', 'Loved'],
  ['pending', 'Pending'],
  ['wip', 'Work in progress'],
  ['graveyard', 'Graveyarded'],
  ['unsubmitted', 'Never submitted'],
];

/** The states a mod chip cycles through, in the order a click moves through them. */
const MOD_CYCLE = ['allowed', 'required', 'excluded'];

const MOD_STATE_WORDS = {
  allowed: 'may be used',
  required: 'must be used',
  excluded: 'must not be used',
};

/* The filter being edited, and the machine facts that decide what the dialog can offer. */
let draft = null;
let context = { profileName: 'this profile', statusKnown: true, hasLazer: true, onSaved: null };

const filterHint = (message, isError) => hint('filterHint', message, isError);

/* ------------------------------------------------------------------- helpers */

/** A deep-enough copy: the filter is plain data, and every nested value is a scalar or array. */
function copyFilter(filter) {
  return {
    enabled: Boolean(filter?.enabled),
    keywords: typeof filter?.keywords === 'string' ? filter.keywords : '',
    modes: Array.isArray(filter?.modes) ? [...filter.modes] : [0, 1, 2, 3],
    stars: { min: filter?.stars?.min ?? 0, max: filter?.stars?.max ?? null },
    length: { min: filter?.length?.min ?? 0, max: filter?.length?.max ?? null },
    mods: { ...(filter?.mods ?? {}) },
    noMod: filter?.noMod ?? 'allowed',
    categories: Array.isArray(filter?.categories)
      ? [...filter.categories]
      : CATEGORY_LABELS.map(([name]) => name),
    added: { from: filter?.added?.from ?? null, to: filter?.added?.to ?? null },
    submitted: {
      from: filter?.submitted?.from ?? null,
      to: filter?.submitted?.to ?? null,
      includeUnknown: filter?.submitted?.includeUnknown !== false,
    },
    ranked: {
      from: filter?.ranked?.from ?? null,
      to: filter?.ranked?.to ?? null,
      includeUnknown: filter?.ranked?.includeUnknown !== false,
    },
  };
}

/** `215` -> `3:35`, which is how osu! writes a beatmap's length everywhere else. */
function clock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Seconds from `3:35` or from `215`, so either can be typed. NaN for anything else, which the
 * caller reads as "leave this bound alone".
 */
function parseClock(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return NaN;
    return minutes * 60 + seconds;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

/** An epoch time as `<input type="date">` wants it, in the viewer's own timezone. */
function dateInputValue(at) {
  if (at === null || at === undefined) return '';
  const date = new Date(at);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** Whole days since osu!'s first beatmap, which is the unit both date sliders move in. */
const dayIndex = (at) => Math.max(0, Math.round((at - OSU_EPOCH) / DAY));
const dayTime = (index) => OSU_EPOCH + index * DAY;
const today = () => dayIndex(Date.now());

/* -------------------------------------------------------------- range control */

/**
 * A two-handled range, built from two native sliders stacked on one track.
 *
 * Native `<input type="range">` has one handle, and the alternative -- drawing the whole thing
 * -- would mean reimplementing keyboard support, touch and focus. So both handles are real
 * inputs: the track is drawn underneath, the inputs are transparent, and only their thumbs
 * take pointer events. That is the standard arrangement, and it keeps Tab and the arrow keys
 * working for nothing.
 *
 * The far-right position is one step *past* the maximum and means "no upper bound", which is
 * where both sliders start. That is why 15.00 stars and 60:00 are reachable rather than being
 * swallowed by the open end.
 */
function rangeControl(id, steps, fields) {
  return `<div class="range" id="${id}">
    <div class="range__track"><div class="range__fill" data-fill></div></div>
    <input type="range" class="range__input" data-bound="min" min="0" max="${steps}" step="1"
           value="0" aria-label="minimum">
    <input type="range" class="range__input" data-bound="max" min="0" max="${steps}" step="1"
           value="${steps}" aria-label="maximum">
  </div>
  <div class="range__fields">
    <input type="${fields.type}" class="range__value" data-field="min"
           ${fields.attrs ?? ''} placeholder="${escapeHtml(fields.minPlaceholder ?? '')}"
           aria-label="${escapeHtml(fields.minLabel)}">
    <span class="range__dash" aria-hidden="true">&ndash;</span>
    <input type="${fields.type}" class="range__value" data-field="max"
           ${fields.attrs ?? ''} placeholder="${escapeHtml(fields.maxPlaceholder ?? '')}"
           aria-label="${escapeHtml(fields.maxLabel)}">
    ${fields.unit ? `<span class="range__unit">${escapeHtml(fields.unit)}</span>` : ''}
  </div>`;
}

/** Paint the filled span between the handles, and keep the two from crossing over. */
function paintRange(id) {
  const root = $(id);
  const min = root.querySelector('[data-bound="min"]');
  const max = root.querySelector('[data-bound="max"]');
  const steps = Number(max.max);
  const low = Math.min(Number(min.value), Number(max.value));
  const high = Math.max(Number(min.value), Number(max.value));
  const fill = root.querySelector('[data-fill]');
  fill.style.left = `${(low / steps) * 100}%`;
  fill.style.right = `${100 - (high / steps) * 100}%`;
}

/* ------------------------------------------------------------------- sections */

function keywordsSection() {
  return section(
    'Keywords',
    `<input type="text" id="tf-keywords" class="tfilter__text"
            placeholder="e.g. Sotarks, Blue Zenith, Insane">`,
    'Matched against the song title, the artist, the difficulty name and the mapper. Separate ' +
      'several with commas -- a play counts if any one of them appears anywhere in those four. ' +
      'Leave it empty to accept every beatmap.',
  );
}

function modesSection() {
  const boxes = MODE_NAMES.map(
    (name, index) =>
      `<label class="checkgroup__item"><input type="checkbox" data-mode="${index}"> ${escapeHtml(
        name,
      )}</label>`,
  ).join('');
  return section(
    'Mode',
    `<div class="checkgroup">${boxes}</div>`,
    'The mode the play was set in. A play on a converted beatmap counts as the mode it was ' +
      'played in -- except an unfinished one, which osu! only records the beatmap for, so it ' +
      "counts as the beatmap's own mode.",
  );
}

function starsSection() {
  return section(
    'Difficulty',
    rangeControl('tf-stars', MAX_STARS * 10 + 1, {
      type: 'text',
      attrs: 'inputmode="decimal" maxlength="5"',
      minLabel: 'minimum star rating',
      maxLabel: 'maximum star rating',
      minPlaceholder: '0.00',
      maxPlaceholder: 'no limit',
      unit: 'stars',
    }),
    'The star rating of the play as it happened, mods included -- so a 5.50★ beatmap ' +
      'played with Double Time is judged at its Double Time rating. osu!’s own calculator ' +
      'produces it. Drag the right handle in from the end to set a ceiling; the far end is no ' +
      'ceiling at all.',
  );
}

function lengthSection() {
  return section(
    'Length',
    rangeControl('tf-length', MAX_LENGTH_SECONDS + 1, {
      type: 'text',
      attrs: 'inputmode="numeric" maxlength="7"',
      minLabel: 'minimum length',
      maxLabel: 'maximum length',
      minPlaceholder: '0:00',
      maxPlaceholder: 'no limit',
      unit: 'm:ss',
    }),
    'How long the beatmap runs at the speed it was played, so Double Time shortens it. Type ' +
      'either <code>3:30</code> or a number of seconds.',
    { html: true },
  );
}

function categoriesSection(suffix) {
  const boxes = CATEGORY_LABELS.map(
    ([name, label]) =>
      `<label class="checkgroup__item"><input type="checkbox" data-category="${name}"> ${escapeHtml(
        label,
      )}</label>`,
  ).join('');
  return section(
    'Categories',
    `<div class="checkgroup">${boxes}</div>`,
    'The beatmap’s state on osu!. <b>Ranked</b> covers both ranked and approved, as osu! ' +
      'does. <b>Never submitted</b> is a beatmap that exists only on this machine.' + suffix,
    { html: true, id: 'tf-categories' },
  );
}

function datesSection(key, title, help, { unknown } = {}) {
  const steps = today();
  return section(
    title,
    rangeControl(`tf-${key}`, steps, {
      type: 'date',
      minLabel: `earliest ${title.toLowerCase()}`,
      maxLabel: `latest ${title.toLowerCase()}`,
    }) +
      (unknown
        ? `<label class="checkgroup__item tfilter__unknown">
             <input type="checkbox" data-unknown="${key}">
             ${escapeHtml(unknown)}
           </label>`
        : ''),
    help,
    { html: true, id: `tf-${key}-section` },
  );
}

/**
 * The mod grid.
 *
 * Every mod in all four rulesets, grouped and coloured by osu!'s own mod type, drawn with the
 * same `modPill` the score rows use so a chip here is the badge seen everywhere else. A mod
 * that exists in only some modes says which in its tooltip; the grid is not split by mode
 * because the mode criterion is its own section and splitting would draw Hidden four times.
 */
function modsSection() {
  const acronyms = Object.keys(MOD_DEFINITIONS).filter((a) => !HIDDEN_MODS.has(a));
  const groups = MOD_GROUPS.map(([type, label]) => {
    const inGroup = acronyms.filter((a) => MOD_DEFINITIONS[a].type === type).sort();
    if (inGroup.length === 0) return '';
    return `<div class="mod-grid__group">
      <div class="mod-grid__label">${escapeHtml(label)}</div>
      <div class="mod-grid__row">${inGroup.map(modChip).join('')}</div>
    </div>`;
  }).join('');

  return section(
    'Mods',
    `<div class="mod-grid__legend">
       <span class="mod-grid__key mod-grid__key--allowed">may be used</span>
       <span class="mod-grid__key mod-grid__key--required">must be used</span>
       <span class="mod-grid__key mod-grid__key--excluded">must not be used</span>
       <span class="mod-grid__actions">
         <button type="button" id="tf-mods-all">Allow every mod</button>
         <button type="button" id="tf-mods-none">Allow none</button>
       </span>
     </div>
     <div class="mod-grid" id="tf-mods">
       <div class="mod-grid__group">
         <div class="mod-grid__label">No mods</div>
         <div class="mod-grid__row">${modChip('NM')}</div>
       </div>
       ${groups}
     </div>
     <div class="tfilter__readout" id="tf-mods-readout"></div>`,
    'Click a mod to cycle it: <b>may be used</b>, then <b>must be used</b>, then <b>must not ' +
      'be used</b>. Everything starts at "may be used", so no mod combination is excluded ' +
      'until you say so. Only which mods were on is compared, never how they were configured, ' +
      'and osu!stable plays are matched on what the player actually chose -- osu! adds Classic ' +
      'to them afterwards, which is not a choice anyone made. Autoplay and Cinema are not ' +
      'listed: nothing in this app can ever count them.',
    { html: true },
  );
}

/** One chip. `NM` is this app's own, not a mod: it stands for a play with no mods at all. */
function modChip(acronym) {
  const definition = MOD_DEFINITIONS[acronym];
  const modes =
    definition && definition.modes.length < 4
      ? ` (${definition.modes.map((m) => MODE_NAMES[m]).join(', ')} only)`
      : '';
  const name = acronym === 'NM' ? 'No mods at all' : `${definition?.name ?? acronym}${modes}`;
  return `<button type="button" class="mod-chip" data-mod="${escapeHtml(acronym)}"
    data-name="${escapeHtml(name)}" aria-pressed="false">${
      acronym === 'NM' ? noModIcon() : modPill(acronym)
    }</button>`;
}

/**
 * A stand-in badge for "no mods", drawn in the same hexagon as a real mod so the chip lines up
 * with the rest of the grid. Grey, because it is the absence of a mod rather than one of
 * osu!'s types -- and osu! has no icon for it to copy.
 */
function noModIcon() {
  return `<svg class="mod" viewBox="0 0 100 70" role="img" aria-label="No mods at all">
    <title>No mods at all</title>
    <polygon points="6,35 27.13,6 72.87,6 94,35 72.87,64 27.13,64" stroke-width="12"
             stroke-linejoin="round" style="fill: #4b4046; stroke: #4b4046"/>
    <text x="50" y="36" text-anchor="middle" dominant-baseline="central" font-size="34"
          font-weight="900" letter-spacing="-0.5"
          style="fill: #1d1a1c; font-family: var(--font-grade)">NM</text>
  </svg>`;
}

function section(title, control, help, { html = false, id = null } = {}) {
  return `<section class="tfilter-section"${id ? ` id="${id}"` : ''}>
    <h4>${escapeHtml(title)}</h4>
    ${control}
    <div class="setting__hint">${html ? help : escapeHtml(help)}</div>
  </section>`;
}

/* --------------------------------------------------------------------- render */

function renderBody() {
  const stable = !context.hasLazer;
  const needsLazer = stable
    ? ' <b>Not available here:</b> this needs osu!lazer’s beatmap database, and only ' +
      'osu!stable was found, so this criterion is left wide open.'
    : '';

  $('filterBody').innerHTML =
    keywordsSection() +
    modesSection() +
    starsSection() +
    modsSection() +
    categoriesSection(needsLazer) +
    lengthSection() +
    datesSection(
      'added',
      'Date added',
      'When the beatmap arrived on this machine, taken from when osu! created the file. A ' +
        'beatmap imported from osu!stable is dated when it was imported, not when it was made.',
    ) +
    datesSection(
      'submitted',
      'Date submitted',
      'When the beatmap was first uploaded to osu!. osu! only records this for beatmaps it has ' +
        'ranked, approved or loved; the box above covers every other beatmap.' + needsLazer,
      { unknown: 'Include beatmaps with no submission date on record' },
    ) +
    datesSection(
      'ranked',
      'Date ranked',
      'When the beatmap was ranked, approved or loved. Only those three ever have a date; ' +
        'everything else is covered by the box above.' + needsLazer,
      { unknown: 'Include beatmaps that were never ranked, qualified or loved' },
    );

  bindBody();
  fillFromDraft();
}

/** Put the draft into the controls. Called on open and after "Clear every criterion". */
function fillFromDraft() {
  $('filterEnabled').checked = draft.enabled;
  $('tf-keywords').value = draft.keywords;

  for (const box of $('filterBody').querySelectorAll('[data-mode]')) {
    box.checked = draft.modes.includes(Number(box.dataset.mode));
  }
  for (const box of $('filterBody').querySelectorAll('[data-category]')) {
    box.checked = draft.categories.includes(box.dataset.category);
  }
  $('filterBody').querySelector('[data-unknown="submitted"]').checked =
    draft.submitted.includeUnknown;
  $('filterBody').querySelector('[data-unknown="ranked"]').checked = draft.ranked.includeUnknown;

  setNumberRange('tf-stars', draft.stars, starsCodec);
  setNumberRange('tf-length', draft.length, lengthCodec);
  for (const key of ['added', 'submitted', 'ranked']) setDateRange(key);

  for (const chip of $('tf-mods').querySelectorAll('.mod-chip')) paintChip(chip);

  renderReadouts();
  applyEnabled();
}

/* Each range converts between a slider index and the value the filter stores. */
const starsCodec = {
  steps: MAX_STARS * 10 + 1,
  toIndex: (value) => Math.round(Math.min(MAX_STARS, Math.max(0, value)) * 10),
  toValue: (index) => Math.round(index) / 10,
  format: (value) => value.toFixed(2),
  parse: (text) => {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? Math.min(MAX_STARS, Math.max(0, value)) : NaN;
  },
};

const lengthCodec = {
  steps: MAX_LENGTH_SECONDS + 1,
  toIndex: (value) => Math.round(Math.min(MAX_LENGTH_SECONDS, Math.max(0, value))),
  toValue: (index) => Math.round(index),
  format: clock,
  parse: (text) => {
    const seconds = parseClock(text);
    if (seconds === null || Number.isNaN(seconds)) return seconds;
    return Math.min(MAX_LENGTH_SECONDS, Math.max(0, seconds));
  },
};

function setNumberRange(id, range, codec) {
  const root = $(id);
  const minInput = root.querySelector('[data-bound="min"]');
  const maxInput = root.querySelector('[data-bound="max"]');
  minInput.value = String(codec.toIndex(range.min));
  maxInput.value = String(range.max === null ? codec.steps : codec.toIndex(range.max));
  const fields = root.nextElementSibling;
  fields.querySelector('[data-field="min"]').value = range.min > 0 ? codec.format(range.min) : '';
  fields.querySelector('[data-field="max"]').value =
    range.max === null ? '' : codec.format(range.max);
  paintRange(id);
}

function setDateRange(key) {
  const range = draft[key];
  const root = $(`tf-${key}`);
  const steps = Number(root.querySelector('[data-bound="max"]').max);
  root.querySelector('[data-bound="min"]').value = String(
    range.from === null ? 0 : Math.min(steps, dayIndex(range.from)),
  );
  root.querySelector('[data-bound="max"]').value = String(
    range.to === null ? steps : Math.min(steps, dayIndex(range.to)),
  );
  const fields = root.nextElementSibling;
  fields.querySelector('[data-field="min"]').value = dateInputValue(range.from);
  fields.querySelector('[data-field="max"]').value = dateInputValue(range.to);
  paintRange(`tf-${key}`);
}

function paintChip(chip) {
  const acronym = chip.dataset.mod;
  const state = acronym === 'NM' ? draft.noMod : draft.mods[acronym] ?? 'allowed';
  chip.classList.toggle('mod-chip--required', state === 'required');
  chip.classList.toggle('mod-chip--excluded', state === 'excluded');
  chip.setAttribute('aria-pressed', state === 'required' ? 'true' : 'false');
  chip.title = `${chip.dataset.name} — ${MOD_STATE_WORDS[state]}`;
}

/* ------------------------------------------------------------------- readouts */

/**
 * What the mod selection means, in a sentence.
 *
 * The reason this exists: three states across sixty-nine chips is a rule nobody can read off
 * the grid, and the rule is the whole point of the section.
 */
function modsReadout() {
  const required = Object.keys(draft.mods).filter((a) => draft.mods[a] === 'required').sort();
  const excluded = Object.keys(draft.mods).filter((a) => draft.mods[a] === 'excluded').sort();

  if (draft.noMod === 'required') {
    return required.length > 0
      ? `<b>Nothing can match.</b> "No mods at all" and ${list(required)} cannot both be true.`
      : 'Tracks plays with <b>no mods at all</b>.';
  }

  const parts = [];
  if (required.length > 0) parts.push(`use ${list(required)}`);
  // Only worth saying while nothing is required: a required mod already rules out a nomod play,
  // and a sentence that says the same thing twice reads as two separate rules.
  if (draft.noMod === 'excluded' && required.length === 0) parts.push('use at least one mod');
  if (excluded.length > 0) {
    // Named while the list is short enough to read, counted once it is not.
    parts.push(
      excluded.length <= 3
        ? `never use ${list(excluded)}`
        : `use none of the ${excluded.length} mods marked out`,
    );
  }
  if (parts.length === 0) return 'Every mod combination counts.';
  return `Tracks plays that ${joinWords(parts)}.`;
}

const joinWords = (items) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

const list = (items) => joinWords(items.map((item) => `<b>${escapeHtml(item)}</b>`));

/**
 * The one line that says whether this filter can track anything at all.
 *
 * A criterion narrowed to nothing -- no mode ticked, no category ticked, a required mod
 * alongside "no mods at all" -- is a filter that silently records nothing, which is the worst
 * thing this dialog could let someone save without noticing.
 */
function impossibleReason() {
  if (!draft.enabled) return null;
  if (draft.modes.length === 0) return 'No mode is ticked, so no play can be tracked.';
  if (draft.categories.length === 0) {
    return 'No category is ticked, so no play can be tracked.';
  }
  if (draft.noMod === 'required' && Object.values(draft.mods).includes('required')) {
    return 'A mod is required alongside "no mods at all", so no play can be tracked.';
  }
  return null;
}

function renderReadouts() {
  $('tf-mods-readout').innerHTML = modsReadout();
  const impossible = impossibleReason();
  const warning = $('filterImpossible');
  warning.hidden = impossible === null;
  warning.textContent = impossible ?? '';
}

/**
 * The filter switched off leaves every control visible but inert, the same treatment a
 * dependent setting gets in the Settings dialog: what the controls say is most of why someone
 * opened this, and hiding them would make the dialog look empty.
 */
function applyEnabled() {
  const on = $('filterEnabled').checked;
  $('filterBody').classList.toggle('tfilter--inactive', !on);
  for (const control of $('filterBody').querySelectorAll('input, button')) control.disabled = !on;

  // With osu!stable alone there is no source for a beatmap's status or either submission date,
  // so those three stay inert even when the filter is on -- there is nothing to compare.
  if (!context.hasLazer) {
    for (const id of ['tf-categories', 'tf-submitted-section', 'tf-ranked-section']) {
      const node = $(id);
      if (!node) continue;
      node.classList.add('tfilter-section--unavailable');
      for (const control of node.querySelectorAll('input, button')) control.disabled = true;
    }
  }
}

/* -------------------------------------------------------------------- binding */

function bindBody() {
  const body = $('filterBody');

  body.oninput = (e) => {
    const target = e.target;

    if (target.id === 'tf-keywords') {
      draft.keywords = target.value;
      return;
    }
    if (target.dataset.bound) {
      readSlider(target);
      return;
    }
    if (target.dataset.field) readField(target);
  };

  body.onchange = (e) => {
    const target = e.target;
    if (target.dataset.mode !== undefined) {
      const mode = Number(target.dataset.mode);
      draft.modes = [0, 1, 2, 3].filter((m) =>
        m === mode ? target.checked : draft.modes.includes(m),
      );
      renderReadouts();
      return;
    }
    if (target.dataset.category !== undefined) {
      const names = CATEGORY_LABELS.map(([name]) => name);
      draft.categories = names.filter((name) =>
        name === target.dataset.category ? target.checked : draft.categories.includes(name),
      );
      renderReadouts();
      return;
    }
    if (target.dataset.unknown !== undefined) {
      draft[target.dataset.unknown].includeUnknown = target.checked;
    }
  };

  /*
   * Two stacked sliders mean the one later in the document catches a click where they overlap,
   * and a range dragged to either end would bury the other handle for good. So the handle
   * nearer the pointer is raised before the press reaches either of them. Delegated, because
   * the ranges are regenerated whenever the dialog is rebuilt.
   */
  body.addEventListener('pointerdown', (e) => {
    const root = e.target.closest('.range');
    if (!root) return;
    const minInput = root.querySelector('[data-bound="min"]');
    const maxInput = root.querySelector('[data-bound="max"]');
    const box = root.getBoundingClientRect();
    const steps = Number(maxInput.max);
    const at = ((e.clientX - box.left) / Math.max(1, box.width)) * steps;
    const nearer =
      Math.abs(at - Number(minInput.value)) <= Math.abs(at - Number(maxInput.value))
        ? minInput
        : maxInput;
    minInput.classList.toggle('range__input--front', nearer === minInput);
    maxInput.classList.toggle('range__input--front', nearer === maxInput);
  }, true);

  body.onclick = (e) => {
    if (e.target.closest('#tf-mods-all')) {
      draft.mods = {};
      draft.noMod = 'allowed';
      for (const chip of $('tf-mods').querySelectorAll('.mod-chip')) paintChip(chip);
      renderReadouts();
      return;
    }
    if (e.target.closest('#tf-mods-none')) {
      // Every mod out of play, which is the same rule as "no mods at all" and is written that
      // way rather than as sixty-nine exclusions -- one fact instead of a list that would go
      // stale the next time osu! adds a mod.
      draft.mods = {};
      draft.noMod = 'required';
      for (const chip of $('tf-mods').querySelectorAll('.mod-chip')) paintChip(chip);
      renderReadouts();
      return;
    }
    const chip = e.target.closest('.mod-chip');
    if (!chip) return;
    cycleChip(chip);
  };
}

function cycleChip(chip) {
  const acronym = chip.dataset.mod;
  const current = acronym === 'NM' ? draft.noMod : draft.mods[acronym] ?? 'allowed';
  const next = MOD_CYCLE[(MOD_CYCLE.indexOf(current) + 1) % MOD_CYCLE.length];

  if (acronym === 'NM') {
    draft.noMod = next;
    // Requiring "no mods" and requiring a mod cannot both hold, so asking for one drops the
    // other instead of saving a filter that matches nothing.
    if (next === 'required') {
      for (const [mod, state] of Object.entries(draft.mods)) {
        if (state === 'required') delete draft.mods[mod];
      }
      for (const other of $('tf-mods').querySelectorAll('.mod-chip')) paintChip(other);
    }
  } else {
    if (next === 'allowed') delete draft.mods[acronym];
    else draft.mods[acronym] = next;
    if (next === 'required' && draft.noMod === 'required') {
      draft.noMod = 'allowed';
      paintChip($('tf-mods').querySelector('[data-mod="NM"]'));
    }
  }

  paintChip(chip);
  renderReadouts();
}

/**
 * A handle moved.
 *
 * The handles push rather than cross: dragging one past the other pins it at the other's
 * position, which is what keeps the thumb under the pointer the one that is moving. Swapping
 * their roles mid-drag was the alternative, and it makes the control feel broken.
 */
function readSlider(input) {
  const root = input.closest('.range');
  const id = root.id;
  const key = id.slice('tf-'.length);
  const minInput = root.querySelector('[data-bound="min"]');
  const maxInput = root.querySelector('[data-bound="max"]');
  const steps = Number(maxInput.max);
  if (Number(minInput.value) > Number(maxInput.value)) {
    const other = input === minInput ? maxInput : minInput;
    input.value = other.value;
  }
  const low = Number(minInput.value);
  const high = Number(maxInput.value);

  if (key === 'stars' || key === 'length') {
    const codec = key === 'stars' ? starsCodec : lengthCodec;
    draft[key] = {
      min: codec.toValue(low),
      max: high >= codec.steps ? null : codec.toValue(high),
    };
    setNumberRange(id, draft[key], codec);
  } else {
    draft[key] = {
      ...draft[key],
      from: low === 0 ? null : dayTime(low),
      to: high >= steps ? null : dayTime(high),
    };
    setDateRange(key);
  }
  renderReadouts();
}

/** A text field was typed in. An unreadable value leaves the bound as it was. */
function readField(input) {
  const fields = input.closest('.range__fields');
  const root = fields.previousElementSibling;
  const key = root.id.slice('tf-'.length);
  const which = input.dataset.field;

  if (key === 'stars' || key === 'length') {
    const codec = key === 'stars' ? starsCodec : lengthCodec;
    const value = codec.parse(input.value);
    if (Number.isNaN(value)) return;
    if (which === 'min') draft[key] = { ...draft[key], min: value ?? 0 };
    else draft[key] = { ...draft[key], max: value };
    // Only the slider is repainted: rewriting the field under the cursor would fight the typing.
    const minInput = root.querySelector('[data-bound="min"]');
    const maxInput = root.querySelector('[data-bound="max"]');
    minInput.value = String(codec.toIndex(draft[key].min));
    maxInput.value = String(draft[key].max === null ? codec.steps : codec.toIndex(draft[key].max));
    paintRange(root.id);
  } else {
    const at = input.value === '' ? null : Date.parse(`${input.value}T00:00:00`);
    if (at !== null && !Number.isFinite(at)) return;
    if (which === 'min') draft[key] = { ...draft[key], from: at };
    else {
      // An upper bound means "up to the end of that day", or a beatmap ranked that morning
      // would fall outside a range that names its own date.
      draft[key] = { ...draft[key], to: at === null ? null : at + DAY - 1 };
    }
    const steps = Number(root.querySelector('[data-bound="max"]').max);
    root.querySelector('[data-bound="min"]').value = String(
      draft[key].from === null ? 0 : Math.min(steps, dayIndex(draft[key].from)),
    );
    root.querySelector('[data-bound="max"]').value = String(
      draft[key].to === null ? steps : Math.min(steps, dayIndex(draft[key].to)),
    );
    paintRange(root.id);
  }
  renderReadouts();
}

/* ---------------------------------------------------------------------- dialog */

/**
 * Open the dialog on a copy of the profile's saved filter.
 *
 * A copy, so Cancel really cancels: the live `settings` object is only replaced by what the
 * server hands back from the save.
 */
export function openTrackingFilter(options) {
  context = { ...context, ...options };
  draft = copyFilter(options.filter);

  $('filterProfileName').textContent = context.profileName;
  $('filterSessionCount').textContent =
    context.playsFiltered > 0
      ? `${context.playsFiltered} play${context.playsFiltered === 1 ? '' : 's'} ` +
        'have not been recorded since the app started because of this filter.'
      : '';
  filterHint(' ');
  renderBody();

  $('filterEnabled').onchange = () => {
    draft.enabled = $('filterEnabled').checked;
    applyEnabled();
    renderReadouts();
  };

  $('filterModal').hidden = false;
  $('filterCancel').focus();
}

export function closeTrackingFilter() {
  $('filterModal').hidden = true;
}

export function trackingFilterOpen() {
  return !$('filterModal').hidden;
}

/** Every criterion back to its widest, leaving the switch itself alone. */
export function resetTrackingFilter() {
  const enabled = draft.enabled;
  draft = copyFilter(null);
  draft.enabled = enabled;
  fillFromDraft();
  filterHint('Every criterion is wide open again. Save to keep it that way.');
}

export async function saveTrackingFilter() {
  $('filterSave').disabled = true;
  try {
    const data = await postJson('/api/settings', { trackingFilter: draft }, 'saving failed');
    draft = copyFilter(data.settings.trackingFilter);
    closeTrackingFilter();
    toast(
      draft.enabled
        ? 'Play tracking filter saved - it applies to plays from now on'
        : 'Play tracking filter off - every play is tracked',
    );
    context.onSaved?.(data.settings);
  } catch (err) {
    filterHint(err.message, true);
  } finally {
    $('filterSave').disabled = false;
  }
}
