/**
 * Import past plays -> Manually enter a score: the last resort, for a play with no replay and no
 * score link. Laid out as the pp calculator is (pp-calculator.js), from the same parts
 * (beatmap-pick.js).
 *
 * Pick a beatmap -- searched among the installed ones, or a link osu! is asked for -- then the
 * ruleset, osu!stable's mods, and the judgements, which start at a perfect play: osu! counts the
 * beatmap's judgements for the ruleset and mods, and the best one is whatever the others leave, so
 * the total always matches. The combo starts full. What the play is worth is priced as it is
 * typed, by the calculator the app prices with, as the pp calculator prices a play with Classic.
 * Everything is checked again by the server (POST /api/manual-score), and the pp stored comes from
 * osu!'s calculator, never from this form.
 */
import { escapeHtml, fmt, pct } from './format.js';
import { modDefinition } from './badges.js';
import {
  beatmapLine,
  coverVars,
  foundRows,
  JUDGEMENT_FIELDS,
  loadStars,
  looksLikeLink,
  markMode,
  markMods,
  modeButtons,
  modesFor,
  modGrid,
  remainderOf,
  REMAINDER,
} from './beatmap-pick.js';
import { accuracyOf } from './pp-accuracy.js';
import { closeOnBackdrop, hint, postJson } from './ui.js';
import { hideTooltip } from './tooltip.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/** osu!stable's mods, by ruleset, and the pairs it never allowed together (ScoreEntry.ManualMods). */
let stableMods = { modes: {}, exclusive: [] };

/** Pairs osu!'s mod select also keeps apart, where stable's bits would only make one of them. */
const ALSO_APART = [['DT', 'NC'], ['SD', 'PF']];

let beatmap = null;
let ruleset = 0;
let found = [];
let search = { q: '', more: false, loading: false };
/** The osu!stable mods chosen, by acronym. */
let mods = new Set();
/** A perfect play's judgements on the beatmap, ruleset and mods; null until osu! has counted them. */
let perfect = null;
/** Which start, and which price, is the latest: an older answer arriving late is dropped. */
let started = 0;
let priced = 0;
let searchTimer = 0;
let priceTimer = 0;
let onAdded = null;

const say = (message, isError) => hint('manualHint', message, isError);

/** The page's state names each ruleset's osu!stable mods, as the server checks them. */
export function setManualMods(list) {
  if (list) stableMods = list;
}

/** Open it with the beatmap still to pick. `added(d)` is told of a score once it is added. */
export function openManual(added) {
  onAdded = added;
  beatmap = null;
  found = [];
  search = { q: '', more: false, loading: false };
  mods = new Set();
  perfect = null;
  started++;
  priced++;
  $('manualBeatmapQuery').value = '';
  $('manualFind').hidden = false;
  $('manualBeatmapResults').hidden = true;
  $('manualChosen').hidden = true;
  $('manualForm').hidden = true;
  for (const id of ['manualCombo', 'manualTotal']) $(id).value = '';
  $('manualPlayedAt').value = toLocalInput(Date.now());
  $('manualAdd').disabled = true;
  say(' ');
  $('manualModal').hidden = false;
  $('manualBeatmapQuery').focus();
}

export function closeManual() {
  $('manualModal').hidden = true;
  clearTimeout(searchTimer);
  clearTimeout(priceTimer);
  started++;
  priced++;
}

/** A time as a datetime-local box takes it, in this computer's time zone. */
function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

/* ---------------------------------------------------------------- beatmap */

function renderFound(message) {
  hideTooltip();
  $('manualBeatmapResults').innerHTML =
    (message ? `<div class="setting__hint">${escapeHtml(message)}</div>` : '') +
    foundRows(found) +
    (search.more ? `<div class="setting__hint pp-calc__more">${escapeHtml(t('ppCalc.loadingMore'))}</div>` : '');
  $('manualBeatmapResults').hidden = false;
  void loadStars(found);
}

async function loadMore() {
  if (!search.more || search.loading) return;
  const q = search.q;
  search.loading = true;
  try {
    const d = await (await fetch(`/api/beatmaps/search?q=${encodeURIComponent(q)}&offset=${found.length}`)).json();
    if (search.q !== q) return;
    found = found.concat(d.beatmaps ?? []);
    search.more = d.more === true;
    const top = $('manualBeatmapResults').scrollTop;
    renderFound(null);
    $('manualBeatmapResults').scrollTop = top;
  } catch (err) {
    search.more = false;
    renderFound(err.message);
  } finally {
    search.loading = false;
  }
}

$('manualBeatmapResults').addEventListener('scroll', () => {
  const list = $('manualBeatmapResults');
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 60) void loadMore();
}, { passive: true });

$('manualBeatmapQuery').oninput = () => {
  clearTimeout(searchTimer);
  const q = $('manualBeatmapQuery').value.trim();
  found = [];
  search = { q, more: false, loading: false };
  if (!q) {
    $('manualBeatmapResults').hidden = true;
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

$('manualBeatmapQuery').onkeydown = async (e) => {
  // Back to the beatmap already chosen, rather than closing the dialog.
  if (e.key === 'Escape' && beatmap) {
    e.stopPropagation();
    showChosen();
    return;
  }
  if (e.key !== 'Enter') return;
  const q = $('manualBeatmapQuery').value.trim();
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

$('manualBeatmapResults').onclick = (e) => {
  const button = e.target.closest('[data-found]');
  if (button) void choose(found[Number(button.dataset.found)]);
};

function showChosen() {
  $('manualBeatmapResults').hidden = true;
  $('manualFind').hidden = true;
  $('manualChosen').hidden = false;
}

$('manualChosen').onclick = (e) => {
  if (!e.target.closest('#manualChange')) return;
  $('manualChosen').hidden = true;
  $('manualFind').hidden = false;
  if ($('manualBeatmapQuery').value.trim() && found.length) $('manualBeatmapResults').hidden = false;
  $('manualBeatmapQuery').focus();
  $('manualBeatmapQuery').select();
};

async function choose(chosen) {
  beatmap = chosen;
  clearTimeout(searchTimer);
  $('manualChosen').innerHTML = `${beatmapLine(chosen)}
    <button type="button" id="manualChange">${escapeHtml(t('manual.change'))}</button>`;
  $('manualChosen').style.cssText = coverVars(chosen, 'card');
  showChosen();
  void loadStars([chosen]);
  const modes = modesFor(chosen);
  ruleset = modes.includes(ruleset) ? ruleset : chosen.mode;
  $('manualModes').innerHTML = modeButtons(modes);
  markMode($('manualModes'), ruleset);
  renderMods();
  $('manualForm').hidden = false;
  say(' ');
  await startOver();
}

$('manualModes').onclick = (e) => {
  const button = e.target.closest('[data-mode]');
  if (!button || Number(button.dataset.mode) === ruleset) return;
  ruleset = Number(button.dataset.mode);
  markMode($('manualModes'), ruleset);
  renderMods();
  void startOver();
};

/* ------------------------------------------------------------------- mods */

const offered = () => stableMods.modes?.[ruleset] ?? [];

function renderMods() {
  const available = offered();
  for (const acronym of [...mods]) if (!available.includes(acronym)) mods.delete(acronym);
  $('manualMods').innerHTML = modGrid(available.filter((a) => modDefinition(a)));
  markMods($('manualMods'), (a) => mods.has(a));
}

$('manualMods').onclick = (e) => {
  const chip = e.target.closest('[data-mod]');
  if (!chip) return;
  const acronym = chip.dataset.mod;
  if (mods.has(acronym)) {
    mods.delete(acronym);
  } else {
    for (const [a, b] of [...(stableMods.exclusive ?? []), ...ALSO_APART]) {
      if (a === acronym) mods.delete(b);
      if (b === acronym) mods.delete(a);
    }
    mods.add(acronym);
  }
  markMods($('manualMods'), (a) => mods.has(a));
  // A key mod changes a converted mania beatmap's notes, so the play starts again.
  void startOver();
};

/** The mods as the calculator takes them, and as the server takes them: stable's acronyms, run together. */
const requestMods = () => [...mods].map((acronym) => ({ acronym }));
const modsText = () => [...mods].join('');

/* ------------------------------------------------------------- judgements */

function renderCounts(counts) {
  const remainder = REMAINDER[ruleset];
  $('manualCounts').innerHTML = (JUDGEMENT_FIELDS[ruleset] ?? [])
    .map(([key, label]) => {
      const auto = perfect && key === remainder;
      return `<label class="field"><span>${escapeHtml(label())}</span>
        <input type="number" id="manual-${key}" data-count="${key}" min="0" step="1" value="${counts?.[key] ?? ''}"${
          auto ? ' readonly class="pp-calc__auto"' : ''}></label>`;
    })
    .join('');
}

function typedCounts() {
  const out = {};
  for (const input of $('manualCounts').querySelectorAll('[data-count]')) out[input.dataset.count] = input.value === '' ? 0 : Number(input.value);
  return out;
}

/** The best judgement is whatever the others leave of a perfect play's. */
function fillRemainder() {
  if (!perfect) return true;
  const { key, total, left } = remainderOf(ruleset, perfect, typedCounts());
  $(`manual-${key}`).value = String(Math.max(0, left));
  if (left < 0) {
    say(t('ppCalc.tooMany', { total: fmt(total) }), true);
    return false;
  }
  return true;
}

/** A perfect, full-combo play on the beatmap as this ruleset and these mods make it. */
async function startOver() {
  if (!beatmap) return;
  const mine = ++started;
  // A price of the play before is no longer the play.
  priced++;
  clearTimeout(priceTimer);
  perfect = null;
  renderCounts(null);
  $('manualCombo').value = '';
  $('manualMaxCombo').textContent = '';
  $('manualWorth').textContent = '';
  renderSummary();
  try {
    const d = await postJson('/api/pp-calculator', { md5: beatmap.md5, mode: ruleset, mods: requestMods(), classic: true, counts: null, combo: '' });
    if (mine !== started) return;
    perfect = d.perfect ?? null;
    renderCounts(d.counts);
    $('manualCombo').value = String(d.maxCombo);
    $('manualMaxCombo').textContent = `/ ${fmt(d.maxCombo)}x`;
    showWorth(d);
    say(' ');
  } catch (err) {
    if (mine !== started) return;
    // With no count of the beatmap's judgements, they are typed in full.
    renderCounts(null);
    say(err.message, true);
  }
  renderSummary();
}

/** What the play typed is worth, priced a moment after the typing stops. */
function schedulePrice() {
  clearTimeout(priceTimer);
  priceTimer = setTimeout(() => void price(), 300);
}

async function price() {
  if (!beatmap || !renderSummary()) return;
  const mine = ++priced;
  try {
    const d = await postJson('/api/pp-calculator', {
      md5: beatmap.md5,
      mode: ruleset,
      mods: requestMods(),
      classic: true,
      counts: typedCounts(),
      combo: $('manualCombo').value,
      score: ruleset === 0 ? $('manualTotal').value : '',
    });
    if (mine !== priced) return;
    showWorth(d);
    say(' ');
  } catch (err) {
    if (mine !== priced) return;
    $('manualWorth').textContent = '';
    say(err.message, true);
  }
}

function showWorth(d) {
  $('manualWorth').textContent = d?.pp == null ? '' : t('manual.worth', { pp: fmt(d.pp, 2) });
}

/** The accuracy of what is typed, and whether it can be added. True when there is a play to price. */
function renderSummary() {
  const counts = typedCounts();
  const judged = Object.values(counts).reduce((a, b) => a + b, 0);
  $('manualAccuracy').textContent = judged > 0
    ? t('manual.accuracy', { acc: pct(accuracyOf(ruleset, counts)) })
    : t('manual.accuracyUnknown');
  const ready = Boolean(beatmap) && judged > 0 && $('manualCombo').value !== '';
  $('manualAdd').disabled = !ready;
  return ready;
}

$('manualCounts').oninput = (e) => {
  if (!e.target.closest('[data-count]')) return;
  const fits = fillRemainder();
  renderSummary();
  if (fits) schedulePrice();
};
$('manualCombo').oninput = $('manualTotal').oninput = () => {
  renderSummary();
  schedulePrice();
};

/* -------------------------------------------------------------------- add */

$('manualAdd').onclick = async () => {
  if (!beatmap) return;
  $('manualAdd').disabled = true;
  say(t('manual.adding'));
  try {
    const d = await postJson('/api/manual-score', {
      md5: beatmap.md5,
      mode: ruleset,
      counts: typedCounts(),
      maxCombo: $('manualCombo').value,
      mods: modsText(),
      totalScore: $('manualTotal').value,
      playedAt: new Date($('manualPlayedAt').value).getTime(),
    });
    if (d.status === 'added') {
      closeManual();
      await onAdded?.(d);
    } else {
      say(t('manual.already'), true);
    }
  } catch (err) {
    say(err.message, true);
  } finally {
    renderSummary();
  }
};

$('manualCancel').onclick = closeManual;
closeOnBackdrop($('manualModal'), closeManual);
