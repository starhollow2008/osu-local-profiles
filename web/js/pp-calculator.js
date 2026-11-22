/**
 * Options -> pp calculator: what a play would be worth on any beatmap here.
 *
 * It opens laid out in full, with the beatmap's slot at the top empty until one is picked:
 * searched among every client's, by a link osu! is asked for, or a .osu file. A score, or an
 * unfinished play, opens it from its menu or its card with its beatmap, mods and judgements in.
 * It starts at a perfect play: osu! counts the beatmap's judgements for the ruleset and mods, and
 * the 300s (MAX in mania) are whatever the other judgements leave, so the total always matches the
 * beatmap. A blank combo is a full one. An accuracy typed in becomes judgements (pp-accuracy.js).
 * Accuracy and combo have sliders too, which price the play again as they move.
 *
 * Every number comes from dotnet/App/PpCalculation.cs, which prices the play with the calculator
 * the app prices scores with: osu!'s release, or the player's own source (roadmap 5.70). With
 * Classic, the play is scored as osu!stable scores it; without, in osu! and taiko, as lazer does.
 * Whether a play starts with it is the profile's (`ppCalcClassic`, off by default), and a score
 * brings its own. In osu! with Classic, osu!stable's score can be given, which osu! works out the
 * combo breaks from (a stable score brings it). Nothing is stored.
 */
import { escapeHtml, fmt, MODE_NAMES, pct } from './format.js';
import { coverUrl, gradeBadge, modDefinition, modPill } from './badges.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';
import { original } from './metadata.js';
import { accuracyOf, countsFromStatistics, judgementsForAccuracy, sliderMisses } from './pp-accuracy.js';
import { hint, postJson } from './ui.js';
import { hideTooltip } from './tooltip.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** Not offered: Autoplay and Cinema have no player, and ScoreV2 is a system mod. */
const LEFT_OUT = new Set(['AT', 'CN', 'SV2']);

/** osu!'s mod groups, in lazer's order, as the play tracking filter shows them. */
const MOD_GROUPS = [
  ['DifficultyReduction', () => t('mods.difficultyReduction')],
  ['DifficultyIncrease', () => t('mods.difficultyIncrease')],
  ['Conversion', () => t('mods.conversion')],
  ['Fun', () => t('mods.fun')],
  ['System', () => t('mods.system')],
];

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

/** Difficulty Adjust's settings that move pp, per ruleset. */
const DA_SETTINGS = {
  0: ['circle_size', 'approach_rate', 'overall_difficulty', 'drain_rate'],
  1: ['overall_difficulty', 'drain_rate'],
  2: ['circle_size', 'approach_rate', 'drain_rate'],
  3: ['overall_difficulty', 'drain_rate'],
};

/** Each ruleset's judgements, by the replay counter that holds them, as osu!stable labels them. */
const FIELDS = {
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

/** What lazer judges besides each object in osu!, missed: only without Classic. */
const SLIDER_FIELDS = [
  ['tailMiss', () => t('ppCalc.sliderEndsMissed')],
  ['tickMiss', () => t('ppCalc.sliderTicksMissed')],
];

/** Each ruleset's icon, as osu-web names them (`.mode-icon`). */
const RULESETS = ['osu', 'taiko', 'fruits', 'mania'];

/** The judgement that is whatever the others leave: the best one. */
const REMAINDER = { 0: 'c300', 1: 'c300', 2: 'c300', 3: 'geki' };

/** The clients osu! scores as osu!stable: their scores are priced with Classic. */
const STABLE_CLIENTS = new Set(['stable', 'mcosu', 'neki', 'neomod']);

let beatmap = null;
/** The ruleset chosen. */
let ruleset = 0;
/** The search's results so far, and what is needed to load the next page of them. */
let found = [];
let search = { q: '', more: false, loading: false };
/** Chosen mods: acronym -> its settings. Classic is `classic`, not one of these. */
let mods = new Map();
/** osu! and taiko only: false scores the play as lazer does, without Classic. */
let classic = false;
/** Whether a play starts with Classic: the profile's `ppCalcClassic`, and how a change of it is saved. */
let classicDefault = false;
let saveClassicDefault = null;
/** A perfect play's judgements on this beatmap, ruleset and mods; null when the calculator cannot say. */
let perfect = null;
/** osu! without Classic: the beatmap's slider ends and ticks, which the accuracy counts. */
let ends = null;
/** Which request is the latest: an older answer arriving late is dropped. */
let asked = 0;
let calcTimer = 0;
let searchTimer = 0;
/** The mods that leave pp as it is, by ruleset, from the app's state (PpCalculation.NoPp). */
let noPp = {};
/** Set by a mod change: if the beatmap's judgements change with it, the play starts again. */
let modsChanged = false;
/** The accuracy of the play last priced, as osu! worked it out. */
let lastAccuracy = null;
/** Requests being priced, and whether a slider moved meanwhile: it is priced again once they are back. */
let inFlight = 0;
let again = false;

const say = (message, isError) => hint('ppCalcHint', message, isError);
const mode = () => ruleset;
const withoutClassic = () => !classic && mode() <= 1;

export const ppCalculatorOpen = () => !$('ppCalcModal').hidden;

/** The profile's choice of whether a play starts with Classic, and `save(on)` for when it is changed here. */
export function setClassicDefault(on, save) {
  classicDefault = on === true;
  if (save) saveClassicDefault = save;
  $('ppCalcClassicDefault').checked = classicDefault;
}

/** The app's list of mods that do not change pp, from /api/state. */
export function setNoPpMods(list) {
  noPp = list ?? {};
  if (ppCalculatorOpen()) renderMods();
}

/** Open it empty, laid out for `ruleset` (the profile's), with the beatmap still to pick. */
export function openPpCalculator(ruleset = 0) {
  beatmap = null;
  found = [];
  search = { q: '', more: false, loading: false };
  mods = new Map();
  classic = classicDefault;
  $('ppCalcClassicDefault').checked = classicDefault;
  perfect = null;
  ends = null;
  asked++;
  $('ppCalcQuery').value = '';
  $('ppCalcResults').hidden = true;
  $('ppCalcChosen').hidden = true;
  $('ppCalcFind').hidden = false;
  renderModes([0, 1, 2, 3], ruleset);
  renderMods();
  renderCounts(null);
  $('ppCalcCombo').value = '';
  $('ppCalcCombo').placeholder = '';
  $('ppCalcMaxCombo').textContent = '';
  $('ppCalcAccuracy').value = '';
  $('ppCalcScore').value = '';
  $('ppCalcScoreUnused').hidden = true;
  renderEmpty();
  say(' ');
  $('ppCalcModal').hidden = false;
  $('ppCalcQuery').focus();
}

/**
 * Open it on a beatmap by its MD5, with what is known of a play on it: `{ md5, mode, mods?,
 * classic?, counts?, combo?, score? }`. Without counts it is a perfect play, and without
 * `classic` it is the profile's choice.
 */
export async function openPpCalculatorFor(play) {
  openPpCalculator(play.mode);
  say(t('manual.lookingUp'));
  try {
    await choose(await postJson('/api/beatmaps/find', { md5: play.md5 }, t('ppCalc.failed')), play);
  } catch (err) {
    say(err.message, true);
  }
}

/**
 * A score's play, for the calculator: its ruleset, the mods it can price (its own settings kept),
 * Classic as osu! scored it, and for a finished play its judgements and combo. A failed play's
 * stop short of the beatmap's end, so it is priced as a perfect one.
 */
export function scorePlay(score) {
  const ruleset = Number(score.mode) || 0;
  const all = score.mods ?? [];
  const withClassic = ruleset > 1 || STABLE_CLIENTS.has(score.client) || all.some((m) => m.acronym === 'CL');
  const kept = all
    .filter((m) => offered(ruleset).includes(m.acronym) && m.acronym !== 'CL' && !(noPp[ruleset] ?? []).includes(m.acronym))
    .map((m) => ({ acronym: m.acronym, settings: plainSettings(m.settings) }));
  const play = { md5: score.beatmapMd5, mode: ruleset, mods: kept, classic: withClassic };
  if (score.passed !== false && score.statistics) {
    play.counts = countsFromStatistics(ruleset, score.statistics);
    if (ruleset === 0 && !withClassic) Object.assign(play.counts, sliderMisses(score.statistics, score.maximumStatistics));
    // A mania combo can run past the maximum osu!'s calculator counts, and mania's pp has no use for it.
    play.combo = ruleset === 3 ? null : (score.maxCombo ?? null);
    play.score = score.stableScore ?? null;
  }
  return play;
}

/** A mod's settings as the calculator takes them: numbers and switches only. */
function plainSettings(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

export function closePpCalculator() {
  $('ppCalcModal').hidden = true;
  clearTimeout(calcTimer);
  clearTimeout(searchTimer);
  asked++;
}

/* ---------------------------------------------------------------- beatmap */

/** A beatmap link or bare id, which osu! is asked about, rather than words to search for. */
const looksLikeLink = (q) => /^\d+$/.test(q) || /osu\.ppy\.sh\//i.test(q);

const modeIcon = (m) => `<span class="mode-icon mode-icon--${RULESETS[m]}" aria-hidden="true"></span>`;

/** A beatmap's cover from osu!, as `--bg` and `--bg-2x`: nothing for one never submitted. */
function coverVars(b, size) {
  const set = Number(b.beatmapsetId);
  if (!Number.isInteger(set) || set <= 0) return '';
  return `--bg: url('${coverUrl(set, size)}'); --bg-2x: url('${coverUrl(set, `${size}@2x`)}')`;
}

/**
 * A beatmap as a row shows it, as favourite beatmaps are shown: its cover beside it and faded
 * behind it (the row's own `--bg`), its name, and who mapped it under that.
 */
function beatmapLine(b) {
  const thumb = coverVars(b, 'list');
  return `<span class="beatmapset-cover pp-calc__thumb"${thumb ? ` style="${thumb}"` : ''}></span>
    <span class="pp-calc__name">
      <span class="u-ellipsis">${escapeHtml(original(b.title, b.titleOriginal))}</span>
      ${b.creator ? `<span class="pp-calc__mapper u-ellipsis">${escapeHtml(t('beatmap.mappedBy', { mapper: b.creator }))}</span>` : ''}
    </span>`;
}

function renderFound(message) {
  // A row's ruleset tooltip would outlast the row.
  hideTooltip();
  $('ppCalcResults').innerHTML =
    (message ? `<div class="setting__hint">${escapeHtml(message)}</div>` : '') +
    found
      .map(
        (b, i) => `<button type="button" class="manual-beatmap pp-calc__beatmap" data-found="${i}" style="${coverVars(b, 'card')}">
          ${beatmapLine(b)}
          <span class="pp-calc__beatmap-mode" data-tooltip="${escapeHtml(MODE_NAMES[b.mode])}">${modeIcon(b.mode)}</span>
        </button>`,
      )
      .join('') +
    (search.more ? `<div class="setting__hint pp-calc__more">${escapeHtml(t('ppCalc.loadingMore'))}</div>` : '');
  $('ppCalcResults').hidden = false;
}

/** The next page of the search, once the list is scrolled near its end. */
async function loadMore() {
  if (!search.more || search.loading) return;
  const q = search.q;
  search.loading = true;
  try {
    const d = await (await fetch(`/api/beatmaps/search?q=${encodeURIComponent(q)}&offset=${found.length}`)).json();
    if (search.q !== q) return;
    found = found.concat(d.beatmaps ?? []);
    search.more = d.more === true;
    const top = $('ppCalcResults').scrollTop;
    renderFound(null);
    $('ppCalcResults').scrollTop = top;
  } catch (err) {
    search.more = false;
    renderFound(err.message);
  } finally {
    search.loading = false;
  }
}

$('ppCalcResults').addEventListener('scroll', () => {
  const list = $('ppCalcResults');
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) void loadMore();
}, { passive: true });

/** The rulesets a beatmap can be played in: one made for osu! in any, the others only in their own. */
const modesFor = (b) => (!b || b.mode === 0 ? [0, 1, 2, 3] : [b.mode]);

/** The rulesets the beatmap can be played in, left to right as osu! orders them, the one chosen lit. */
function renderModes(modes, selected) {
  hideTooltip();
  ruleset = modes.includes(selected) ? selected : modes[0];
  $('ppCalcModes').innerHTML = modes
    .map((m) => `<button type="button" class="pp-calc__mode" data-mode="${m}" role="radio"
      aria-label="${escapeHtml(MODE_NAMES[m])}" data-tooltip="${escapeHtml(MODE_NAMES[m])}">${modeIcon(m)}</button>`)
    .join('');
  renderModeState();
}

function renderModeState() {
  for (const button of $('ppCalcModes').querySelectorAll('[data-mode]')) {
    const on = Number(button.dataset.mode) === ruleset;
    button.classList.toggle('pp-calc__mode--active', on);
    button.setAttribute('aria-checked', String(on));
  }
}

// Another ruleset: its own mods, and a perfect play on the beatmap as that ruleset converts it.
$('ppCalcModes').onclick = (e) => {
  const button = e.target.closest('[data-mode]');
  if (!button || Number(button.dataset.mode) === ruleset) return;
  ruleset = Number(button.dataset.mode);
  renderModeState();
  renderMods();
  void startOver();
};

/** Nothing to price until there is a beatmap: the judgements wait, and the result says why. */
function renderEmpty() {
  const empty = !beatmap;
  $('ppCalcModal').querySelector('.pp-calc').classList.toggle('pp-calc--empty', empty);
  for (const input of $('ppCalcForm').querySelectorAll('#ppCalcCounts input, .pp-calc__totals input')) input.disabled = empty;
  if (empty) $('ppCalcResult').innerHTML = `<p class="pp-calc__waiting">${escapeHtml(t('ppCalc.chooseBeatmap'))}</p>`;
}

/**
 * The beatmap to price. The mods chosen so far stay, where the ruleset has them; a play brought
 * along (`play`, as openPpCalculatorFor takes it) sets them, and its judgements and combo.
 */
async function choose(chosen, play = null) {
  beatmap = chosen;
  clearTimeout(searchTimer);
  $('ppCalcResults').hidden = true;
  $('ppCalcFind').hidden = true;
  $('ppCalcChosen').innerHTML = `${beatmapLine(chosen)}
    <button type="button" id="ppCalcChange">${escapeHtml(t('manual.change'))}</button>`;
  $('ppCalcChosen').style.cssText = coverVars(chosen, 'card');
  $('ppCalcChosen').hidden = false;
  renderModes(modesFor(chosen), play?.mode ?? mode());
  if (play) {
    mods = new Map((play.mods ?? []).map((m) => [m.acronym, { ...(m.settings ?? {}) }]));
    classic = play.classic ?? classicDefault;
  }
  renderMods();
  renderEmpty();
  say(' ');
  await startOver();
  if (!play?.counts || beatmap !== chosen) return;
  renderCounts(play.counts);
  $('ppCalcCombo').value = play.combo == null ? '' : String(play.combo);
  $('ppCalcScore').value = play.score == null ? '' : String(play.score);
  if (fillRemainder()) await calculate(false);
}

$('ppCalcQuery').oninput = () => {
  clearTimeout(searchTimer);
  const q = $('ppCalcQuery').value.trim();
  found = [];
  search = { q, more: false, loading: false };
  if (!q) {
    $('ppCalcResults').hidden = true;
    return;
  }
  if (looksLikeLink(q)) {
    renderFound(t('manual.pressEnter'));
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const d = await (await fetch(`/api/beatmaps/search?q=${encodeURIComponent(q)}`)).json();
      if (search.q !== q) return;
      found = d.beatmaps ?? [];
      search.more = d.more === true;
      renderFound(found.length ? null : t('manual.noneFound'));
    } catch (err) {
      renderFound(err.message);
    }
  }, 250);
};

$('ppCalcQuery').onkeydown = async (e) => {
  // Back to the beatmap already chosen, rather than closing the calculator.
  if (e.key === 'Escape' && beatmap) {
    e.stopPropagation();
    showChosen();
    return;
  }
  if (e.key !== 'Enter') return;
  const q = $('ppCalcQuery').value.trim();
  if (!looksLikeLink(q)) {
    if (found.length === 1) void choose(found[0]);
    return;
  }
  renderFound(t('manual.lookingUp'));
  try {
    await choose(await postJson('/api/beatmaps/find', { link: q }));
  } catch (err) {
    renderFound(err.message);
  }
};

function showChosen() {
  $('ppCalcResults').hidden = true;
  $('ppCalcFind').hidden = true;
  $('ppCalcChosen').hidden = false;
}

$('ppCalcResults').onclick = (e) => {
  const button = e.target.closest('[data-found]');
  if (button) void choose(found[Number(button.dataset.found)]);
};

// Another beatmap: the one chosen is priced as it is until the next is picked.
$('ppCalcChosen').onclick = (e) => {
  if (!e.target.closest('#ppCalcChange')) return;
  $('ppCalcChosen').hidden = true;
  $('ppCalcFind').hidden = false;
  if ($('ppCalcQuery').value.trim() && found.length) $('ppCalcResults').hidden = false;
  $('ppCalcQuery').focus();
  $('ppCalcQuery').select();
};

// A .osu file goes up as it is, and is kept with the beatmaps downloaded for score links.
$('ppCalcOpenFile').onclick = () => {
  $('ppCalcFile').value = '';
  $('ppCalcFile').click();
};
$('ppCalcFile').onchange = async () => {
  const file = $('ppCalcFile').files?.[0];
  if (!file) return;
  say(t('ppCalc.opening', { file: file.name }));
  try {
    const r = await fetch('/api/pp-calculator/beatmap', { method: 'POST', body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? t('ppCalc.failed'));
    say(' ');
    await choose(d);
  } catch (err) {
    say(err.message, true);
  }
};

/* ------------------------------------------------------------------- mods */

const offered = (m) =>
  Object.entries(MOD_DEFINITIONS)
    .filter(([acronym, d]) => d.playable && d.modes.includes(m) && !LEFT_OUT.has(acronym))
    .map(([acronym]) => acronym);

/** A mod that leaves this ruleset's pp as it is: shown, dimmed, and not chosen. */
const inert = (acronym) => (noPp[mode()] ?? []).includes(acronym);

function renderMods() {
  const available = offered(mode());
  // A mod the ruleset does not have, or one that changes nothing in it, goes when the ruleset changes.
  for (const acronym of [...mods.keys()]) if (!available.includes(acronym) || inert(acronym)) mods.delete(acronym);
  $('ppCalcMods').innerHTML = MOD_GROUPS.map(([type, label]) => {
    const inGroup = available.filter((a) => modDefinition(a).type === type).sort();
    if (inGroup.length === 0) return '';
    return `<div class="mod-grid__group">
      <div class="mod-grid__label">${escapeHtml(label())}</div>
      <div class="mod-grid__row">${inGroup
        .map((a) => {
          const name = modDefinition(a).name;
          return inert(a)
            ? `<button type="button" class="mod-chip mod-chip--inert" data-mod="${escapeHtml(a)}" data-inert
                aria-disabled="true" title="${escapeHtml(t('ppCalc.noPpChange', { mod: name }))}">${modPill(a)}</button>`
            : `<button type="button" class="mod-chip" data-mod="${escapeHtml(a)}" aria-pressed="false"
                title="${escapeHtml(name)}">${modPill(a)}</button>`;
        })
        .join('')}</div>
    </div>`;
  }).join('');
  renderModState();
}

function renderModState() {
  for (const chip of $('ppCalcMods').querySelectorAll('[data-mod]:not([data-inert])')) {
    const on = chip.dataset.mod === 'CL' ? classic : mods.has(chip.dataset.mod);
    chip.classList.toggle('mod-chip--required', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  // osu!stable's score says where an osu! play broke its combo, and only with Classic.
  $('ppCalcScoreField').hidden = !(mode() === 0 && classic);
  renderModSettings();
}

/** Classic on or off: osu! without it has slider ends and ticks to miss, and the judgements typed stay. */
function setClassic(on) {
  if (classic === on) return;
  classic = on;
  renderModState();
  if (mode() === 0) renderCounts(typedCounts());
  schedule();
}

// The profile's choice, which this play takes too.
$('ppCalcClassicDefault').onchange = () => {
  const on = $('ppCalcClassicDefault').checked;
  classicDefault = on;
  void saveClassicDefault?.(on);
  setClassic(on);
};

/** The speed of a rate mod, and Difficulty Adjust's values: blank is the beatmap's own. */
function renderModSettings() {
  const fields = [];
  for (const [acronym, settings] of mods) {
    if (RATES[acronym]) {
      const r = RATES[acronym];
      fields.push(`<label class="field"><span>${escapeHtml(t('ppCalc.speed', { mod: acronym }))}</span>
        <input type="number" data-mod-setting="${acronym}" data-key="speed_change" min="${r.min}" max="${r.max}" step="0.01"
               value="${settings.speed_change ?? r.value}"></label>`);
    }
    if (acronym === 'DA') {
      for (const key of DA_SETTINGS[mode()]) {
        fields.push(`<label class="field"><span>${escapeHtml(MOD_DEFINITIONS.DA.settings[key])}</span>
          <input type="number" data-mod-setting="DA" data-key="${key}" min="0" max="11" step="0.1"
                 placeholder="${escapeHtml(t('ppCalc.asMapped'))}" value="${settings[key] ?? ''}"></label>`);
      }
    }
  }
  $('ppCalcModSettings').innerHTML = fields.join('');
  $('ppCalcModSettings').hidden = fields.length === 0;
}

$('ppCalcMods').onclick = (e) => {
  const chip = e.target.closest('[data-mod]');
  if (!chip) return;
  const acronym = chip.dataset.mod;
  if (chip.hasAttribute('data-inert')) {
    say(t('ppCalc.noPpChange', { mod: modDefinition(acronym).name }));
    return;
  }
  if (acronym === 'CL') {
    setClassic(!classic);
    return;
  }
  if (mods.has(acronym)) {
    mods.delete(acronym);
  } else {
    for (const set of EXCLUSIVE) if (set.includes(acronym)) for (const other of set) if (other !== acronym) mods.delete(other);
    mods.set(acronym, {});
  }
  renderModState();
  // A mod that changes how many objects there are (a mania key mod, Target Practice) starts the play again.
  modsChanged = true;
  schedule();
};

$('ppCalcModSettings').oninput = (e) => {
  const input = e.target.closest('[data-mod-setting]');
  if (!input) return;
  const settings = mods.get(input.dataset.modSetting);
  if (!settings) return;
  const value = input.value === '' ? null : Number(input.value);
  if (value === null || !Number.isFinite(value)) delete settings[input.dataset.key];
  else settings[input.dataset.key] = value;
  schedule();
};

/** The mods as osu! writes them: settings only when changed, Difficulty Adjust past 10 with its extended limits. */
function requestMods() {
  return [...mods].map(([acronym, settings]) => {
    const changed = { ...settings };
    if (RATES[acronym] && changed.speed_change === RATES[acronym].value) delete changed.speed_change;
    if (acronym === 'DA' && Object.values(changed).some((v) => v > 10)) changed.extended_limits = true;
    return Object.keys(changed).length ? { acronym, settings: changed } : { acronym };
  });
}

/* ------------------------------------------------------------- judgements */

function renderCounts(counts) {
  const remainder = REMAINDER[mode()];
  const fields = [...(FIELDS[mode()] ?? []), ...(mode() === 0 && withoutClassic() ? SLIDER_FIELDS : [])];
  $('ppCalcCounts').innerHTML = fields
    .map(([key, label]) => {
      const auto = perfect && key === remainder;
      return `<label class="field"><span>${escapeHtml(label())}</span>
        <input type="number" data-count="${key}" min="0" step="1" value="${counts?.[key] ?? (key.endsWith('Miss') ? 0 : '')}"${
          auto ? ' readonly class="pp-calc__auto"' : ''}${beatmap ? '' : ' disabled'}></label>`;
    })
    .join('');
}

function typedCounts() {
  const out = {};
  for (const input of $('ppCalcCounts').querySelectorAll('[data-count]')) {
    out[input.dataset.count] = input.value === '' ? 0 : Number(input.value);
  }
  return out;
}

/** The best judgement is whatever the others leave of a perfect play's. Slider ends and ticks are apart from these. */
function fillRemainder() {
  if (!perfect) return true;
  const key = REMAINDER[mode()];
  const total = Object.values(perfect).reduce((a, b) => a + b, 0);
  const counts = typedCounts();
  const others = (FIELDS[mode()] ?? []).reduce((sum, [k]) => (k === key ? sum : sum + (counts[k] ?? 0)), 0);
  const left = total - others;
  $('ppCalcCounts').querySelector(`[data-count="${key}"]`).value = String(Math.max(0, left));
  if (left < 0) {
    say(t('ppCalc.tooMany', { total: fmt(total) }), true);
    return false;
  }
  return true;
}

$('ppCalcCounts').oninput = (e) => {
  if (e.target.closest('[data-count]') && fillRemainder()) schedule();
};
$('ppCalcCombo').oninput = () => {
  const slider = $('ppCalcComboSlider');
  slider.value = $('ppCalcCombo').value === '' ? slider.max : $('ppCalcCombo').value;
  fill(slider);
  schedule();
};
$('ppCalcComboSlider').oninput = () => {
  $('ppCalcCombo').value = $('ppCalcComboSlider').value;
  fill($('ppCalcComboSlider'));
  live();
};
$('ppCalcScore').oninput = () => schedule();

/** The slider ends and ticks the accuracy counts: osu! without Classic only. */
const accuracyEnds = () => (mode() === 0 && withoutClassic() ? ends : null);

/** An accuracy (a percentage) becomes judgements: the misses typed stay, and the rest are spread to reach it. */
function applyAccuracy(value) {
  if (!perfect || !Number.isFinite(value)) return false;
  const { counts, reached } = judgementsForAccuracy(mode(), value / 100, { perfect, counts: typedCounts(), ends: accuracyEnds() });
  renderCounts(counts);
  fillRemainder();
  say(reached ? ' ' : t('ppCalc.accuracyOutOfReach'));
  return true;
}

$('ppCalcAccuracy').oninput = () => {
  if ($('ppCalcAccuracy').value === '' || !applyAccuracy(Number($('ppCalcAccuracy').value))) return;
  $('ppCalcAccuracySlider').value = $('ppCalcAccuracy').value;
  fill($('ppCalcAccuracySlider'));
  schedule();
};
$('ppCalcAccuracySlider').oninput = () => {
  const slider = $('ppCalcAccuracySlider');
  fill(slider);
  $('ppCalcAccuracy').value = Number(slider.value).toFixed(2);
  if (applyAccuracy(Number(slider.value))) live();
};
// Once it is left, it shows the accuracy osu! worked out, which whole judgements can only come near.
$('ppCalcAccuracy').onblur = () => {
  if (lastAccuracy !== null) $('ppCalcAccuracy').value = (lastAccuracy * 100).toFixed(2);
};

/* ------------------------------------------------------------ calculating */

/** A perfect, full-combo play: the judgements osu! counts on the beatmap, and no combo typed. */
async function startOver() {
  perfect = null;
  $('ppCalcCombo').value = '';
  // A score is the play it was set with: another play has none until one is typed.
  $('ppCalcScore').value = '';
  renderCounts(null);
  await calculate(true);
}

function schedule() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(() => void calculate(false), 200);
}

/**
 * A slider moving: priced now, or as soon as the play being priced is back, so the pp keeps up
 * with it as fast as osu!'s calculator answers, and the requests never pile up.
 */
function live() {
  clearTimeout(calcTimer);
  if (inFlight > 0) again = true;
  else void calculate(false);
}

/** A slider's track, filled up to its handle. */
function fill(slider) {
  const min = Number(slider.min);
  const span = Number(slider.max) - min;
  slider.style.setProperty('--fill', `${span > 0 ? ((Number(slider.value) - min) / span) * 100 : 100}%`);
}

/**
 * The sliders, for the play priced: accuracy from the lowest the misses allow (every other hit
 * the worst there is) to 100%, and combo up to the beatmap's maximum. One being moved is left
 * where it is.
 */
function renderSliders(d) {
  const accuracy = $('ppCalcAccuracySlider');
  if (document.activeElement !== accuracy) {
    let lowest = 0;
    if (perfect) {
      const worst = judgementsForAccuracy(mode(), 0, { perfect, counts: typedCounts(), ends: accuracyEnds() }).counts;
      lowest = Math.floor(accuracyOf(mode(), worst, accuracyEnds()) * 10000) / 100;
    }
    accuracy.min = String(Math.min(lowest, d.accuracy * 100));
    accuracy.value = String(d.accuracy * 100);
    fill(accuracy);
  }
  const combo = $('ppCalcComboSlider');
  if (document.activeElement !== combo) {
    combo.max = String(d.maxCombo);
    combo.value = String(d.combo);
    fill(combo);
  }
}

async function calculate(fresh) {
  if (!beatmap) return;
  const mine = ++asked;
  const changed = modsChanged;
  modsChanged = false;
  inFlight++;
  try {
    const d = await postJson('/api/pp-calculator', {
      md5: beatmap.md5,
      mode: mode(),
      mods: requestMods(),
      classic,
      counts: fresh ? null : typedCounts(),
      combo: $('ppCalcCombo').value,
      score: mode() === 0 && classic ? $('ppCalcScore').value : '',
    }, t('ppCalc.failed'));
    if (mine !== asked) return;
    perfect = d.perfect ?? null;
    ends = d.sliderEnds == null ? null : { sliders: d.sliderEnds, ticks: d.sliderTicks ?? 0 };
    if (fresh) renderCounts(d.counts);
    $('ppCalcCombo').placeholder = fmt(d.maxCombo);
    $('ppCalcMaxCombo').textContent = `/ ${fmt(d.maxCombo)}x`;
    lastAccuracy = d.accuracy;
    const typingAccuracy = [$('ppCalcAccuracy'), $('ppCalcAccuracySlider')].includes(document.activeElement);
    if (document.activeElement !== $('ppCalcAccuracy')) $('ppCalcAccuracy').value = (d.accuracy * 100).toFixed(2);
    renderSliders(d);
    $('ppCalcScoreUnused').hidden = d.stableScoreUsed !== false;
    renderResult(d);
    if (!typingAccuracy) say(' ');
  } catch (err) {
    if (mine !== asked) return;
    // The mods changed how many objects there are: a perfect play on the beatmap as it is now.
    if (changed && !fresh && /^the judgements add up to/.test(err.message)) {
      void startOver();
      return;
    }
    // With no count of the beatmap's judgements, they are typed in full.
    if (fresh) renderCounts(null);
    $('ppCalcResult').innerHTML = '';
    say(err.message, true);
  } finally {
    inFlight--;
    if (again && inFlight === 0) {
      again = false;
      void calculate(false);
    }
  }
}

function renderResult(d) {
  const version = d.version?.startsWith('source ')
    ? t('ppCalc.bySource', { version: d.version.slice('source '.length) })
    : t('ppCalc.byRelease', { version: d.version ?? '' });
  // A part worth nothing is one the play has no use for, such as Flashlight's without Flashlight.
  const parts = (d.breakdown ?? [])
    .filter((p) => p.pp > 0)
    .map((p) => `<div class="pp-calc__part"><dt>${escapeHtml(p.name)}</dt><dd>${fmt(p.pp, 2)}</dd></div>`)
    .join('');
  $('ppCalcResult').innerHTML = `
    <div class="pp-calc__pp">${fmt(d.pp, 2)}<span>pp</span></div>
    <div class="pp-calc__facts">
      ${gradeBadge(d.rank)}
      <span>${fmt(d.stars, 2)}★</span>
      <span>${pct(d.accuracy)}</span>
      <span>${fmt(d.combo)}/${fmt(d.maxCombo)}x</span>
    </div>
    ${parts ? `<dl class="pp-calc__parts">${parts}</dl>` : ''}
    ${d.ranked === false ? `<p class="pp-calc__note">${escapeHtml(t('ppCalc.unranked'))}</p>` : ''}
    <p class="pp-calc__version">${escapeHtml(version)}</p>`;
}

$('ppCalcClose').onclick = closePpCalculator;
$('ppCalcModal').onclick = (e) => {
  if (e.target === $('ppCalcModal')) closePpCalculator();
};
