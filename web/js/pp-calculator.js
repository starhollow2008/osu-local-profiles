/**
 * Options -> pp calculator: what a play would be worth on any beatmap here.
 *
 * It opens laid out in full, with the beatmap's slot at the top empty until one is picked:
 * searched among every client's, by a link osu! is asked for, or a .osu file. A score, or an
 * unfinished play, opens it from its menu or its card with its beatmap, mods and judgements in.
 * It starts at a perfect play: osu! counts the beatmap's judgements for the ruleset and mods, and
 * the 300s (MAX in mania) are whatever the other judgements leave, so the total always matches the
 * beatmap. A blank combo is a full one. An accuracy typed in becomes judgements (pp-accuracy.js).
 * Accuracy and combo have sliders too, which price the play again as they move. Combo is asked
 * for only in osu! and catch, since taiko's and mania's pp never read it.
 *
 * Every number comes from dotnet/App/PpCalculation.cs, which prices the play with the calculator
 * the app prices scores with: osu!'s release, or the player's own source (roadmap 5.70). With
 * Classic, the play is scored as osu!stable scores it; without, in osu! and taiko, as lazer does.
 * Whether a play starts with it is the profile's (`ppCalcClassic`, off by default), and a score
 * brings its own. In osu! with Classic, osu!stable's score can be given, which osu! works out the
 * combo breaks from (a stable score brings it). Nothing is stored.
 */
import { escapeHtml, fmt, pct } from './format.js';
import { gradeBadge, modDefinition } from './badges.js';
import { difficultyBadge } from './beatmapsets.js';
import {
  beatmapLine,
  coverVars,
  foundRows,
  JUDGEMENT_FIELDS as FIELDS,
  lazerMods,
  loadStars,
  looksLikeLink,
  markMode,
  markMods,
  modeButtons,
  modesFor,
  modGrid,
  modSettingsFields,
  modsForRequest,
  readModSetting,
  remainderOf,
  REMAINDER,
  showSeedOnLeave,
  SLIDER_FIELDS,
  toggleMod,
} from './beatmap-pick.js';
import { accuracyOf, countsFromStatistics, judgementsForAccuracy, sliderMisses } from './pp-accuracy.js';
import { closeOnBackdrop, hint, postJson } from './ui.js';
import { hideTooltip } from './tooltip.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** The clients osu! scores as osu!stable: their scores are priced with Classic. */
const STABLE_CLIENTS = new Set(['stable', 'mcosu', 'neki', 'neomod']);

let beatmap = null;
/** The ruleset chosen. */
let ruleset = 0;
/**
 * The search's results so far, and what is needed to load the next page of them. With nothing
 * typed, `recent`: the beatmaps played most recently, suggested until something is.
 */
let found = [];
let search = { q: '', recent: false, more: false, loading: false };
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
/** What the beatmap's stats and FC table were last asked for, and which request for them is the latest. */
let infoKey = null;
let infoAsked = 0;

const say = (message, isError) => hint('ppCalcHint', message, isError);
const mode = () => ruleset;
/** osu! and catch: taiko's and mania's pp never read the combo, so it is not asked for there. */
const comboCounts = (m) => m === 0 || m === 2;
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

/**
 * Open it laid out for `ruleset` (the profile's). The beatmap chosen last is still there, with the
 * play as it was left, and priced again; with none yet, or `fresh`, it opens with the beatmap to pick.
 */
export function openPpCalculator(ruleset = 0, { fresh = false } = {}) {
  if (beatmap && !fresh) {
    $('ppCalcModal').hidden = false;
    showChosen();
    say(' ');
    // The calculator in use may have changed since.
    infoKey = null;
    void calculate(false);
    return;
  }
  beatmap = null;
  found = [];
  search = { q: '', recent: false, more: false, loading: false };
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
  clearInfo();
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
  openPpCalculator(play.mode, { fresh: true });
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
    .filter((m) => lazerMods(ruleset).includes(m.acronym) && m.acronym !== 'CL' && !(noPp[ruleset] ?? []).includes(m.acronym))
    .map((m) => ({ acronym: m.acronym, settings: plainSettings(m.settings) }));
  const play = { md5: score.beatmapMd5, mode: ruleset, mods: kept, classic: withClassic };
  if (score.passed !== false && score.statistics) {
    play.counts = countsFromStatistics(ruleset, score.statistics);
    if (ruleset === 0 && !withClassic) Object.assign(play.counts, sliderMisses(score.statistics, score.maximumStatistics));
    // Taiko's and mania's pp have no use for it, and a mania combo can run past the maximum osu! counts.
    play.combo = comboCounts(ruleset) ? (score.maxCombo ?? null) : null;
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

function renderFound(message) {
  // A row's ruleset tooltip would outlast the row.
  hideTooltip();
  const heading = message ?? (search.recent ? t('ppCalc.recentlyPlayed') : null);
  $('ppCalcResults').innerHTML =
    (heading ? `<div class="setting__hint">${escapeHtml(heading)}</div>` : '') +
    foundRows(found) +
    (search.more ? `<div class="setting__hint pp-calc__more">${escapeHtml(t('ppCalc.loadingMore'))}</div>` : '');
  $('ppCalcResults').hidden = false;
  void loadStars(found);
}

/** The next page of the search, once the list is scrolled near its end. */
async function loadMore() {
  if (!search.more || search.loading) return;
  const asking = search;
  search.loading = true;
  try {
    const url = asking.recent
      ? `/api/beatmaps/recent?offset=${found.length}`
      : `/api/beatmaps/search?q=${encodeURIComponent(asking.q)}&offset=${found.length}`;
    const d = await (await fetch(url)).json();
    if (search !== asking) return;
    found = found.concat(d.beatmaps ?? []);
    search.more = d.more === true;
    const top = $('ppCalcResults').scrollTop;
    renderFound(null);
    $('ppCalcResults').scrollTop = top;
  } catch (err) {
    search.more = false;
    renderFound(err.message);
  } finally {
    asking.loading = false;
  }
}

/**
 * With nothing typed, the beatmaps this profile played most recently, latest first: what a player
 * pricing a play most often wants. None played yet suggests nothing.
 */
async function showRecent() {
  // Asked for afresh each time: what was played changes while the app runs. Not twice at once.
  if ($('ppCalcQuery').value.trim() || (search.recent && search.loading)) return;
  clearTimeout(searchTimer);
  const asking = (search = { q: '', recent: true, more: false, loading: true });
  found = [];
  try {
    const d = await (await fetch('/api/beatmaps/recent')).json();
    if (search !== asking) return;
    found = d.beatmaps ?? [];
    asking.more = d.more === true;
    if (found.length) renderFound(null);
    else $('ppCalcResults').hidden = true;
  } catch {
    // Only a suggestion: the search is there all the same.
    if (search === asking) $('ppCalcResults').hidden = true;
  } finally {
    asking.loading = false;
  }
}

$('ppCalcQuery').addEventListener('focus', () => void showRecent());

$('ppCalcResults').addEventListener('scroll', () => {
  const list = $('ppCalcResults');
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) void loadMore();
}, { passive: true });

/** The rulesets the beatmap can be played in, left to right as osu! orders them, the one chosen lit. */
function renderModes(modes, selected) {
  hideTooltip();
  ruleset = modes.includes(selected) ? selected : modes[0];
  $('ppCalcModes').innerHTML = modeButtons(modes);
  renderModeState();
}

const renderModeState = () => markMode($('ppCalcModes'), ruleset);

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
  void loadStars([chosen]);
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
  search = { q, recent: false, more: false, loading: false };
  if (!q) {
    $('ppCalcResults').hidden = true;
    void showRecent();
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

/** A mod that leaves this ruleset's pp as it is: shown, dimmed, and not chosen. */
const inert = (acronym) => (noPp[mode()] ?? []).includes(acronym);

function renderMods() {
  const available = lazerMods(mode());
  // A mod the ruleset does not have, or one that changes nothing in it, goes when the ruleset changes.
  for (const acronym of [...mods.keys()]) if (!available.includes(acronym) || inert(acronym)) mods.delete(acronym);
  $('ppCalcMods').innerHTML = modGrid(available, (a) => (inert(a) ? t('ppCalc.noPpChange', { mod: modDefinition(a).name }) : null));
  renderModState();
}

function renderModState() {
  markMods($('ppCalcMods'), (a) => (a === 'CL' ? classic : mods.has(a)));
  // osu!stable's score says where an osu! play broke its combo, and only with Classic.
  $('ppCalcScoreField').hidden = !(mode() === 0 && classic);
  $('ppCalcComboField').hidden = !comboCounts(mode());
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

/** The speed of a rate mod, Difficulty Adjust's values, and a seed. */
function renderModSettings() {
  const fields = modSettingsFields(mods, mode());
  $('ppCalcModSettings').innerHTML = fields;
  $('ppCalcModSettings').hidden = fields === '';
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
  toggleMod(mods, acronym);
  renderModState();
  // A mod that changes how many objects there are (a mania key mod, Target Practice) starts the play again.
  modsChanged = true;
  schedule();
};

$('ppCalcModSettings').oninput = (e) => {
  if (readModSetting(mods, e.target.closest('[data-mod-setting]'))) schedule();
};
showSeedOnLeave($('ppCalcModSettings'), () => mods);

const requestMods = () => modsForRequest(mods);

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
  const { key, total, left } = remainderOf(mode(), perfect, typedCounts());
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
      combo: comboCounts(mode()) ? $('ppCalcCombo').value : '',
      score: mode() === 0 && classic ? $('ppCalcScore').value : '',
    }, t('ppCalc.failed'));
    if (mine !== asked) return;
    perfect = d.perfect ?? null;
    // The best judgement is worked out, and an accuracy becomes judgements, only from a perfect play's.
    // A calculator that can't count one is a build from source by an earlier version of the app
    // (SourceHelper.ProgramStamp), and a rebuild fixes it.
    const counting = perfect !== null;
    $('ppCalcAccuracy').disabled = $('ppCalcAccuracySlider').disabled = !counting;
    $('ppCalcRebuild').hidden = counting || !d.version?.startsWith('source ');
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
    void refreshInfo(d);
    if (!typingAccuracy) say(' ');
  } catch (err) {
    if (mine !== asked) return;
    // The mods changed how many objects there are: a perfect play on the beatmap as it is now.
    if (changed && !fresh && /^the judgements add up to/.test(err.message)) {
      void startOver();
      return;
    }
    // With no count of the beatmap's judgements, they are typed in full.
    if (fresh) {
      renderCounts(null);
      clearInfo();
    }
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
      ${comboCounts(mode()) ? `<span>${fmt(d.combo)}/${fmt(d.maxCombo)}x</span>` : ''}
    </div>
    ${parts ? `<dl class="pp-calc__parts">${parts}</dl>` : ''}
    ${d.ranked === false ? `<p class="pp-calc__note">${escapeHtml(t('ppCalc.unranked'))}</p>` : ''}
    <p class="pp-calc__version">${escapeHtml(version)}</p>`;
}

/* ------------------------------------------------- the beatmap, and an FC */

/** The accuracies a full combo is priced at, as the osu! pp extension's table has them. */
const FC_ACCURACIES = [100, 99, 98, 95];

/** The settings song select shows, in the order osu-web's beatmapset page lists them (stats.tsx). */
const STATS = [
  ['CS', () => t('ppCalc.statCircleSize')],
  ['KC', () => t('ppCalc.statKeyCount')],
  ['HP', () => t('ppCalc.statDrain')],
  ['OD', () => t('ppCalc.statAccuracy')],
  ['AR', () => t('ppCalc.statApproachRate')],
];

function clearInfo() {
  infoKey = null;
  infoAsked++;
  $('ppCalcFc').hidden = true;
  $('ppCalcStats').hidden = true;
}

/** What the stats and the FC table depend on: the beatmap, ruleset, mods and Classic, never the judgements typed. */
const infoKeyOf = () => JSON.stringify([beatmap?.md5, mode(), requestMods(), classic]);

/** How long the beatmap, ruleset and mods stay as they are before the stats and FC table are asked for. */
const INFO_SETTLE_MS = 400;

/**
 * The beatmap as osu!'s song select describes it with these mods, and what a full combo is worth
 * at each of `FC_ACCURACIES`. Asked for again only when what they depend on changes, once it has
 * stopped changing, and one at a time: every request waits its turn on the app's one queue, so a
 * pile of them would hold up the play being priced. A change stops the rest.
 */
async function refreshInfo(d) {
  const key = infoKeyOf();
  if (key === infoKey || !beatmap) return;
  infoKey = key;
  const mine = ++infoAsked;
  const target = { md5: beatmap.md5, mode: mode(), mods: requestMods() };
  const full = perfect;
  const fcEnds = accuracyEnds();
  const withClassic = classic;
  // A full combo at each accuracy needs the beatmap's perfect play, which an old source build can't count.
  if (full) renderFc(d.stars, []);
  else $('ppCalcFc').hidden = true;

  await new Promise((r) => setTimeout(r, INFO_SETTLE_MS));
  if (mine !== infoAsked) return;
  try {
    const r = await postJson('/api/pp-calculator/describe', target, t('ppCalc.failed'));
    if (mine !== infoAsked) return;
    renderStats(r.beatmap);
  } catch {
    if (mine === infoAsked) renderStats(null);
  }

  if (!full) return;
  const pp = [];
  for (const acc of FC_ACCURACIES) {
    if (mine !== infoAsked) return;
    const { counts } = judgementsForAccuracy(mode(), acc / 100, { perfect: full, counts: { miss: 0, tailMiss: 0, tickMiss: 0 }, ends: fcEnds });
    try {
      pp.push((await postJson('/api/pp-calculator', { ...target, classic: withClassic, counts, combo: '', score: '' }, t('ppCalc.failed'))).pp);
    } catch {
      pp.push(null);
    }
    if (mine === infoAsked) renderFc(d.stars, pp);
  }
}

/** The pp of a full combo at each accuracy, or a dash for each while they are worked out. */
function renderFc(stars, pp) {
  const head = FC_ACCURACIES.map((acc) => `<th scope="col">${escapeHtml(pct(acc / 100, 0))}</th>`).join('');
  const cells = FC_ACCURACIES.map((_, i) => {
    const value = pp?.[i];
    return value == null
      ? `<td${i < (pp?.length ?? 0) ? '' : ' class="pp-calc__fc-waiting"'}>–</td>`
      : `<td title="${escapeHtml(`${fmt(value, 2)}pp`)}">${escapeHtml(fmt(value, 0))}</td>`;
  }).join('');
  $('ppCalcFc').innerHTML = `<table aria-label="${escapeHtml(t('ppCalc.fcTable'))}">
    <thead><tr><th scope="col">FC</th>${head}</tr></thead>
    <tbody><tr><td>${difficultyBadge(stars)}</td>${cells}</tr></tbody>
  </table>`;
  $('ppCalcFc').hidden = false;
}

/** A setting's value as osu-web writes one: up to two decimals, none when it is whole. */
function statValue(n) {
  const r = Math.round(n * 100) / 100;
  return fmt(r, Number.isInteger(r) ? 0 : Number.isInteger(r * 10) ? 1 : 2);
}

/** A length as osu-web writes one: m:ss, or h:mm:ss. */
function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** One row of osu-web's stats table: the setting, its bar out of 10, and its value. */
function statRow(label, value, original, stars = false) {
  const changed = original != null && Math.abs(original - value) > 0.005;
  const title = changed ? ` title="${escapeHtml(`${statValue(original)} → ${statValue(value)}`)}"` : '';
  const fill = Math.min(100, Math.max(0, value * 10));
  return `<tr>
    <th class="beatmap-stats-table__label" scope="row">${escapeHtml(label)}</th>
    <td class="beatmap-stats-table__bar">
      <div class="bar bar--beatmap-stats${stars ? ' bar--beatmap-stats-stars' : ''}" style="--fill: ${fill}%"><div class="bar__fill"></div></div>
    </td>
    <td class="beatmap-stats-table__value${changed ? ' beatmap-stats-table__value--changed' : ''}"${title}>${stars ? escapeHtml(fmt(value, 2)) : escapeHtml(statValue(value))}</td>
  </tr>`;
}

/** The beatmap with these mods, as osu-web's beatmapset page shows one: its basic stats, then each setting. */
function renderStats(info) {
  const box = $('ppCalcStats');
  if (!info) {
    box.hidden = true;
    return;
  }
  const byAcronym = new Map(info.settings.map((x) => [x.acronym, x]));
  const rows = STATS.filter(([acronym]) => byAcronym.has(acronym))
    .map(([acronym, label]) => statRow(label(), byAcronym.get(acronym).adjusted, byAcronym.get(acronym).original))
    .join('');
  // osu-web's beatmap-basic-stats.tsx, in its order: length, BPM, circles and sliders.
  const basic = [
    ['total_length', t('ppCalc.statLength'), duration(info.lengthMs)],
    ['bpm', 'BPM', info.bpm > 1000 ? '∞' : statValue(info.bpm)],
    ['count_circles', t('ppCalc.statCircles'), fmt(info.circles)],
    ['count_sliders', t('ppCalc.statSliders'), fmt(info.sliders)],
  ]
    .map(([key, title, value]) => `<div class="beatmap-basic-stats__entry" title="${escapeHtml(title)}">
          <div class="beatmap-basic-stats__entry-icon beatmap-basic-stats__entry-icon--${key}"></div>
          <span>${escapeHtml(value)}</span>
        </div>`)
    .join('');
  box.innerHTML = `<div class="pp-calc__stats-row">
      <div class="beatmap-basic-stats">${basic}</div>
    </div>
    <div class="pp-calc__stats-row">
      <table class="beatmap-stats-table">
        <tbody>${rows}${statRow(t('ppCalc.statStars'), info.stars, null, true)}</tbody>
      </table>
    </div>`;
  box.hidden = false;
}

$('ppCalcClose').onclick = closePpCalculator;
closeOnBackdrop($('ppCalcModal'), closePpCalculator);
