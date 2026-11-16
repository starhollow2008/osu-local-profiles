/**
 * Options -> pp calculator: what a play would be worth on any beatmap here.
 *
 * Pick a beatmap (searched among every client's, by a link osu! is asked for, or a .osu file),
 * then the mods and the judgements. It starts at a perfect play: osu! counts the beatmap's
 * judgements for the ruleset and mods, and the 300s (MAX in mania) are whatever the other
 * judgements leave, so the total always matches the beatmap. A blank combo is a full one.
 *
 * Every number comes from dotnet/App/PpCalculation.cs, which prices the play with the calculator
 * the app prices scores with: osu!'s release, or the player's own source (roadmap 5.70). The
 * play is scored as osu!stable scores it, with osu!'s mods and their settings beside it, as
 * McOsu's custom speeds are. Nothing is stored.
 */
import { escapeHtml, fmt, MODE_NAMES, pct } from './format.js';
import { gradeBadge, modDefinition, modPill } from './badges.js';
import { MOD_DEFINITIONS } from './mod-definitions.js';
import { original } from './metadata.js';
import { hint, postJson } from './ui.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

/**
 * Not offered: Autoplay and Cinema have no player, ScoreV2 is a system mod, and Classic is on
 * already, since the play is scored as osu!stable scores it.
 */
const LEFT_OUT = new Set(['AT', 'CN', 'SV2', 'CL']);

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

/** The judgement that is whatever the others leave: the best one. */
const REMAINDER = { 0: 'c300', 1: 'c300', 2: 'c300', 3: 'geki' };

let beatmap = null;
let found = [];
/** Chosen mods: acronym -> its settings. */
let mods = new Map();
/** A perfect play's judgements on this beatmap, ruleset and mods; null when the calculator cannot say. */
let perfect = null;
/** Which request is the latest: an older answer arriving late is dropped. */
let asked = 0;
let calcTimer = 0;
let searchTimer = 0;

const say = (message, isError) => hint('ppCalcHint', message, isError);
const mode = () => Number($('ppCalcMode').value);

export const ppCalculatorOpen = () => !$('ppCalcModal').hidden;

export function openPpCalculator() {
  beatmap = null;
  found = [];
  mods = new Map();
  perfect = null;
  $('ppCalcQuery').value = '';
  $('ppCalcFind').hidden = false;
  $('ppCalcResults').hidden = true;
  $('ppCalcChosen').hidden = true;
  $('ppCalcForm').hidden = true;
  say(' ');
  $('ppCalcModal').hidden = false;
  $('ppCalcQuery').focus();
}

export function closePpCalculator() {
  $('ppCalcModal').hidden = true;
  clearTimeout(calcTimer);
  asked++;
}

/* ---------------------------------------------------------------- beatmap */

/** A beatmap link or bare id, which osu! is asked about, rather than words to search for. */
const looksLikeLink = (q) => /^\d+$/.test(q) || /osu\.ppy\.sh\//i.test(q);

function renderFound(message) {
  $('ppCalcResults').innerHTML =
    (message ? `<div class="setting__hint">${escapeHtml(message)}</div>` : '') +
    found
      .map(
        (b, i) => `<button type="button" class="manual-beatmap" data-found="${i}">
          <span class="u-ellipsis">${escapeHtml(original(b.title, b.titleOriginal))}</span>
          <span class="manual-beatmap__mode">${escapeHtml(MODE_NAMES[b.mode])}</span>
        </button>`,
      )
      .join('');
  $('ppCalcResults').hidden = false;
}

function choose(chosen) {
  beatmap = chosen;
  mods = new Map();
  $('ppCalcResults').hidden = true;
  $('ppCalcFind').hidden = true;
  $('ppCalcChosen').innerHTML = `<span class="u-ellipsis">${escapeHtml(original(chosen.title, chosen.titleOriginal))}</span>
    <button type="button" id="ppCalcChange">${escapeHtml(t('manual.change'))}</button>`;
  $('ppCalcChosen').hidden = false;
  // A beatmap made for osu! can be played in any ruleset; the others only in their own.
  const modes = chosen.mode === 0 ? [0, 1, 2, 3] : [chosen.mode];
  $('ppCalcMode').innerHTML = modes.map((m) => `<option value="${m}">${escapeHtml(MODE_NAMES[m])}</option>`).join('');
  $('ppCalcMode').value = String(chosen.mode);
  $('ppCalcMode').disabled = modes.length === 1;
  $('ppCalcForm').hidden = false;
  renderMods();
  startOver();
}

$('ppCalcQuery').oninput = () => {
  clearTimeout(searchTimer);
  const q = $('ppCalcQuery').value.trim();
  found = [];
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
      if ($('ppCalcQuery').value.trim() !== q) return;
      found = d.beatmaps ?? [];
      renderFound(found.length ? null : t('manual.noneFound'));
    } catch (err) {
      renderFound(err.message);
    }
  }, 250);
};

$('ppCalcQuery').onkeydown = async (e) => {
  if (e.key !== 'Enter') return;
  const q = $('ppCalcQuery').value.trim();
  if (!looksLikeLink(q)) {
    if (found.length === 1) choose(found[0]);
    return;
  }
  renderFound(t('manual.lookingUp'));
  try {
    choose(await postJson('/api/beatmaps/find', { link: q }));
  } catch (err) {
    renderFound(err.message);
  }
};

$('ppCalcResults').onclick = (e) => {
  const button = e.target.closest('[data-found]');
  if (button) choose(found[Number(button.dataset.found)]);
};

$('ppCalcChosen').onclick = (e) => {
  if (!e.target.closest('#ppCalcChange')) return;
  beatmap = null;
  asked++;
  $('ppCalcChosen').hidden = true;
  $('ppCalcForm').hidden = true;
  $('ppCalcFind').hidden = false;
  say(' ');
  $('ppCalcQuery').focus();
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
    say(' ');
    choose(d);
  } catch (err) {
    say(err.message, true);
  }
};

/* ------------------------------------------------------------------- mods */

const offered = (m) =>
  Object.entries(MOD_DEFINITIONS)
    .filter(([acronym, d]) => d.playable && d.modes.includes(m) && !LEFT_OUT.has(acronym))
    .map(([acronym]) => acronym);

function renderMods() {
  const available = offered(mode());
  // A mod the ruleset does not have goes when the ruleset changes.
  for (const acronym of [...mods.keys()]) if (!available.includes(acronym)) mods.delete(acronym);
  $('ppCalcMods').innerHTML = MOD_GROUPS.map(([type, label]) => {
    const inGroup = available.filter((a) => modDefinition(a).type === type).sort();
    if (inGroup.length === 0) return '';
    return `<div class="mod-grid__group">
      <div class="mod-grid__label">${escapeHtml(label())}</div>
      <div class="mod-grid__row">${inGroup
        .map((a) => `<button type="button" class="mod-chip" data-mod="${escapeHtml(a)}" aria-pressed="false"
            title="${escapeHtml(modDefinition(a).name)}">${modPill(a)}</button>`)
        .join('')}</div>
    </div>`;
  }).join('');
  renderModState();
}

function renderModState() {
  for (const chip of $('ppCalcMods').querySelectorAll('[data-mod]')) {
    const on = mods.has(chip.dataset.mod);
    chip.classList.toggle('mod-chip--required', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  renderModSettings();
}

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
  if (mods.has(acronym)) {
    mods.delete(acronym);
  } else {
    for (const set of EXCLUSIVE) if (set.includes(acronym)) for (const other of set) if (other !== acronym) mods.delete(other);
    mods.set(acronym, {});
  }
  renderModState();
  // A mania key mod changes how many notes a converted beatmap has, so the play starts again.
  if (mode() === 3 && beatmap?.mode !== 3) startOver();
  else schedule();
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
  $('ppCalcCounts').innerHTML = (FIELDS[mode()] ?? [])
    .map(([key, label]) => {
      const auto = perfect && key === remainder;
      return `<label class="field"><span>${escapeHtml(label())}</span>
        <input type="number" data-count="${key}" min="0" step="1" value="${counts?.[key] ?? ''}"${auto ? ' readonly class="pp-calc__auto"' : ''}></label>`;
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

/** The best judgement is whatever the others leave of a perfect play's. */
function fillRemainder() {
  if (!perfect) return true;
  const key = REMAINDER[mode()];
  const total = Object.values(perfect).reduce((a, b) => a + b, 0);
  const counts = typedCounts();
  const others = Object.entries(counts).reduce((sum, [k, n]) => (k === key ? sum : sum + n), 0);
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
$('ppCalcCombo').oninput = () => schedule();
$('ppCalcMode').onchange = () => {
  renderMods();
  startOver();
};

/* ------------------------------------------------------------ calculating */

/** A perfect, full-combo play: the judgements osu! counts on the beatmap, and no combo typed. */
function startOver() {
  perfect = null;
  $('ppCalcCombo').value = '';
  renderCounts(null);
  void calculate(true);
}

function schedule() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(() => void calculate(false), 200);
}

async function calculate(fresh) {
  if (!beatmap) return;
  const mine = ++asked;
  try {
    const d = await postJson('/api/pp-calculator', {
      md5: beatmap.md5,
      mode: mode(),
      mods: requestMods(),
      counts: fresh ? null : typedCounts(),
      combo: $('ppCalcCombo').value,
    }, t('ppCalc.failed'));
    if (mine !== asked) return;
    perfect = d.perfect ?? null;
    if (fresh) renderCounts(d.counts);
    $('ppCalcCombo').placeholder = fmt(d.maxCombo);
    $('ppCalcMaxCombo').textContent = `/ ${fmt(d.maxCombo)}x`;
    renderResult(d);
    say(' ');
  } catch (err) {
    if (mine !== asked) return;
    // With no count of the beatmap's judgements, they are typed in full.
    if (fresh) renderCounts(null);
    $('ppCalcResult').innerHTML = '';
    say(err.message, true);
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
