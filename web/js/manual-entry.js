/**
 * Import past plays -> Manually enter a score: the last resort, for a play with no replay and no
 * score link. Laid out as the pp calculator is (pp-calculator.js), from the same parts
 * (beatmap-pick.js).
 *
 * Pick a beatmap -- searched among the installed ones, or a link osu! is asked for -- then the
 * client it was played on, the ruleset, the mods, and the judgements, which start at a perfect
 * play: osu! counts the beatmap's judgements for the ruleset and mods, and the best one is whatever
 * the others leave, so the total always matches. The combo starts full. An osu!stable play has
 * stable's mods and is kept as stable's replay; an osu!lazer play has every mod the pp calculator
 * has, with their settings and Classic, and is kept as lazer's. What the play is worth is priced
 * as it is typed, by the pp calculator's own request, built as the score will be. Everything is
 * checked again by the server (POST /api/manual-score), and the pp stored comes from osu!'s
 * calculator, never from this form.
 */
import { escapeHtml, fmt, pct } from './format.js';
import { modDefinition } from './badges.js';
import {
  beatmapLine,
  coverVars,
  foundRows,
  JUDGEMENT_FIELDS,
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
/** The client the play was set on: 'stable' or 'lazer'. */
let client = 'stable';
/** The mods chosen: acronym -> its settings, which only a lazer play has. Classic is `classic`. */
let mods = new Map();
/** A lazer play in osu! or taiko: whether Classic was one of its mods. */
let classic = false;
/** A lazer play's accuracy, as osu! worked it out when it was last priced. */
let lastAccuracy = null;
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
  client = 'stable';
  mods = new Map();
  classic = false;
  lastAccuracy = null;
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
  renderClient();
  renderMods();
  $('manualForm').hidden = false;
  say(' ');
  perfect = null;
  await startOver();
}

$('manualModes').onclick = (e) => {
  const button = e.target.closest('[data-mode]');
  if (!button || Number(button.dataset.mode) === ruleset) return;
  ruleset = Number(button.dataset.mode);
  markMode($('manualModes'), ruleset);
  renderMods();
  // Another ruleset's judgements: nothing typed carries over.
  perfect = null;
  void startOver();
};

/* ------------------------------------------------------------- the client */

/**
 * osu!stable or osu!lazer. A stable play has stable's mods, and is kept as stable's replay; a lazer
 * play has every mod lazer has, their settings and Classic among them, and is kept as lazer's.
 */
function renderClient() {
  for (const button of $('manualClient').querySelectorAll('[data-client]')) {
    const on = button.dataset.client === client;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', String(on));
  }
  // osu!stable's own score, which only a stable play has.
  $('manualTotalField').hidden = client === 'lazer';
}

$('manualClient').onclick = (e) => {
  const button = e.target.closest('[data-client]');
  if (!button || button.dataset.client === client) return;
  client = button.dataset.client;
  renderClient();
  renderMods();
  void startOver();
};

/* ------------------------------------------------------------------- mods */

/** The mods a play on this client and ruleset could have had. Classic is lazer's in osu! and taiko only. */
const offered = () =>
  client === 'lazer'
    ? lazerMods(ruleset).filter((a) => a !== 'CL' || ruleset <= 1)
    : (stableMods.modes?.[ruleset] ?? []);

function renderMods() {
  const available = offered();
  for (const acronym of [...mods.keys()]) if (!available.includes(acronym)) mods.delete(acronym);
  // A stable play's mods have no settings.
  if (client === 'stable') for (const acronym of mods.keys()) mods.set(acronym, {});
  $('manualMods').innerHTML = modGrid(available.filter((a) => modDefinition(a)));
  renderModState();
}

function renderModState() {
  markMods($('manualMods'), (a) => (a === 'CL' ? classic : mods.has(a)));
  const fields = client === 'lazer' ? modSettingsFields(mods, ruleset) : '';
  $('manualModSettings').innerHTML = fields;
  $('manualModSettings').hidden = fields === '';
}

$('manualMods').onclick = (e) => {
  const chip = e.target.closest('[data-mod]');
  if (!chip) return;
  const acronym = chip.dataset.mod;
  if (acronym === 'CL') {
    classic = !classic;
    renderModState();
    schedulePrice();
    return;
  }
  if (client === 'lazer') {
    toggleMod(mods, acronym);
  } else if (mods.has(acronym)) {
    mods.delete(acronym);
  } else {
    for (const [a, b] of [...(stableMods.exclusive ?? []), ...ALSO_APART]) {
      if (a === acronym) mods.delete(b);
      if (b === acronym) mods.delete(a);
    }
    mods.set(acronym, {});
  }
  renderModState();
  // A key mod changes a converted mania beatmap's notes: the judgements typed stay only while the total does.
  void startOver();
};

$('manualModSettings').oninput = (e) => {
  if (readModSetting(mods, e.target.closest('[data-mod-setting]'))) schedulePrice();
};
showSeedOnLeave($('manualModSettings'), () => mods);

/** The play as the pp calculator and the server read it: which client, its mods, and Classic. */
function playOf() {
  return client === 'lazer'
    ? { md5: beatmap.md5, mode: ruleset, client: 'lazer', classic, mods: modsForRequest(mods) }
    : { md5: beatmap.md5, mode: ruleset, classic: true, mods: [...mods.keys()].map((acronym) => ({ acronym })) };
}

/* ------------------------------------------------------------- judgements */

/** Each ruleset's judgements, and in osu! on lazer, the slider ends and ticks missed. */
const fieldsNow = () => [...(JUDGEMENT_FIELDS[ruleset] ?? []), ...(client === 'lazer' && ruleset === 0 ? SLIDER_FIELDS : [])];

function renderCounts(counts) {
  const remainder = REMAINDER[ruleset];
  $('manualCounts').innerHTML = fieldsNow()
    .map(([key, label]) => {
      const auto = perfect && key === remainder;
      const value = counts?.[key] ?? (key.endsWith('Miss') ? 0 : '');
      return `<label class="field"><span>${escapeHtml(label())}</span>
        <input type="number" id="manual-${key}" data-count="${key}" min="0" step="1" value="${value}"${
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

const totalOf = (counts) => (JUDGEMENT_FIELDS[ruleset] ?? []).reduce((sum, [key]) => sum + (counts?.[key] ?? 0), 0);

/**
 * A perfect, full-combo play on the beatmap as this client, ruleset and mods make it. Judgements
 * already typed stay when the beatmap still has as many: only the mods changed, not the play.
 */
async function startOver() {
  if (!beatmap) return;
  const mine = ++started;
  // A price of the play before is no longer the play.
  priced++;
  clearTimeout(priceTimer);
  // The perfect play so far stays until the new one is counted, so what is typed meanwhile still adds up.
  const kept = perfect !== null;
  try {
    const d = await postJson('/api/pp-calculator', { ...playOf(), counts: null, combo: '' });
    if (mine !== started) return;
    const typed = kept ? typedCounts() : null;
    const typedCombo = $('manualCombo').value;
    perfect = d.perfect ?? null;
    const keep = typed && totalOf(typed) === totalOf(d.counts);
    renderCounts(keep ? typed : d.counts);
    $('manualCombo').value = keep && typedCombo !== '' ? typedCombo : String(d.maxCombo);
    $('manualMaxCombo').textContent = `/ ${fmt(d.maxCombo)}x`;
    if (keep) {
      fillRemainder();
      renderSummary();
      void price();
    } else {
      showWorth(d);
    }
    say(' ');
  } catch (err) {
    if (mine !== started) return;
    // With no count of the beatmap's judgements, they are typed in full.
    perfect = null;
    renderCounts(null);
    $('manualWorth').textContent = '';
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
      ...playOf(),
      counts: typedCounts(),
      combo: $('manualCombo').value,
      score: client === 'stable' && ruleset === 0 ? $('manualTotal').value : '',
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

/** The pp, and lazer's accuracy as osu! works it out (stable's is worked out here as it is typed). */
function showWorth(d) {
  lastAccuracy = d?.accuracy ?? null;
  $('manualWorth').textContent = d?.pp == null ? '' : t('manual.worth', { pp: fmt(d.pp, 2) });
  renderSummary();
}

/** The accuracy of what is typed, and whether it can be added. True when there is a play to price. */
function renderSummary() {
  const counts = typedCounts();
  const judged = totalOf(counts);
  const accuracy = client === 'lazer' ? lastAccuracy : judged > 0 ? accuracyOf(ruleset, counts) : null;
  $('manualAccuracy').textContent = judged > 0 && accuracy != null
    ? t('manual.accuracy', { acc: pct(accuracy) })
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
  const when = { counts: typedCounts(), maxCombo: $('manualCombo').value, playedAt: new Date($('manualPlayedAt').value).getTime() };
  try {
    const d = await postJson('/api/manual-score', client === 'lazer'
      ? { ...playOf(), ...when }
      // osu!stable's mods as the server has always taken them: their acronyms, run together.
      : { md5: beatmap.md5, mode: ruleset, mods: [...mods.keys()].join(''), totalScore: $('manualTotal').value, ...when });
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
