/**
 * The Scores view (roadmap 5.86): every score of a mode, or the best on each beatmap, as a table
 * or as osu!'s rows, sorted and narrowed as the profile last set it up. A page of its own beside
 * the profile, reached from the header's tabs or Best Performance's All scores.
 *
 * The view (`settings.scoreList`, dotnet/App/Settings/ScoreListView.cs) is saved with the profile
 * as it changes. Reset puts back everything but the layout, which is how the list is looked at
 * rather than what it lists. The server decides what is listed (dotnet/App/Calc/ScoreList.cs);
 * this only asks and draws.
 */
import { escapeHtml, fmt, fullDate, pct, timeAgo } from './format.js';
import { gradeBadge, modList, modPill } from './badges.js';
import { plural, t, tOwn } from './i18n.js';
import { beatmapArtist, beatmapName, beatmapTitle } from './metadata.js';
import { playMenuButton, playRow } from './sections.js';
import { postJson } from './ui.js';

const $ = (id) => document.getElementById(id);

/** Best Performance without its cap: the best on each beatmap, among scores that count, by pp. */
export const DEFAULT_VIEW = Object.freeze({
  show: 'best',
  uncounted: false,
  sort: 'pp',
  order: 'desc',
  search: '',
  mods: [],
  grades: [],
  clients: [],
  starsMin: null,
  starsMax: null,
  from: null,
  to: null,
  layout: 'rows',
  pageSize: 100,
});

/** How many rows at a time can be picked: the first page, and each show more. */
export const PAGE_SIZES = [25, 50, 100, 250, 500, 1000];

/** How the list is looked at rather than what it lists: kept by Reset, and not asked of the server. */
const DISPLAY_KEYS = new Set(['layout', 'pageSize']);

/** The most rows one request asks for (the server's cap): show all asks in pieces of this. */
const MOST_AT_ONCE = 10000;

/** Every sort, as the Sort menu lists them. */
export const SORTS = ['pp', 'score', 'accuracy', 'grade', 'combo', 'stars', 'misses', 'playcount', 'date', 'beatmap'];

/** Sorts that read naturally smallest first: a new one starts that way. */
const ASCENDING_FIRST = new Set(['misses', 'beatmap']);

/** A saved or partial view, with every field there. */
export function normaliseView(view) {
  const v = { ...DEFAULT_VIEW, ...(view ?? {}) };
  for (const key of ['mods', 'grades', 'clients']) v[key] = Array.isArray(v[key]) ? [...v[key]] : [];
  return v;
}

/** Whether anything Reset would change is off its default. The layout and page size never count. */
export function viewChanged(view) {
  const v = normaliseView(view);
  return Object.keys(DEFAULT_VIEW).some((key) => {
    if (DISPLAY_KEYS.has(key)) return false;
    const a = v[key];
    const b = DEFAULT_VIEW[key];
    return Array.isArray(b) ? a.length > 0 : a !== b;
  });
}

/** Everything back to the default, but the layout and page size as they were. */
export function resetView(view) {
  const v = normaliseView(view);
  return normaliseView({ layout: v.layout, pageSize: v.pageSize });
}

/** A day as a date input shows it, in local time. */
export function dayOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The filters in force, each a chip with its own x: what it is, and how to take it away. Sort
 * is not one: it is on show in the toolbar already, and Reset puts it back.
 */
export function activeFilters(view) {
  const v = normaliseView(view);
  const chips = [];
  if (v.show === 'every') chips.push({ key: 'show', label: t('scoreList.every') });
  if (v.uncounted) chips.push({ key: 'uncounted', label: t('scoreList.chipUncounted') });
  if (v.search) chips.push({ key: 'search', label: t('scoreList.chipSearch', { text: v.search }) });
  for (const mod of v.mods) chips.push({ key: 'mods', value: mod, label: mod === 'NM' ? t('scoreList.noMod') : mod });
  for (const grade of v.grades) chips.push({ key: 'grades', value: grade, label: gradeName(grade) });
  for (const client of v.clients) chips.push({ key: 'clients', value: client, label: clientName(client) });
  if (v.starsMin !== null || v.starsMax !== null) {
    chips.push({ key: 'stars', label: t('scoreList.chipStars', { range: range(v.starsMin, v.starsMax, (n) => fmt(n, 2)) }) });
  }
  if (v.from !== null || v.to !== null) {
    chips.push({ key: 'played', label: t('scoreList.chipPlayed', { range: range(v.from, v.to, dayOf) }) });
  }
  return chips;
}

function range(min, max, show) {
  if (min !== null && max !== null) return `${show(min)} – ${show(max)}`;
  return min !== null ? `≥ ${show(min)}` : `≤ ${show(max)}`;
}

/** The view without one chip's filter. */
export function withoutFilter(view, key, value) {
  const v = normaliseView(view);
  if (key === 'show') v.show = 'best';
  else if (key === 'uncounted') v.uncounted = false;
  else if (key === 'search') v.search = '';
  else if (key === 'stars') v.starsMin = v.starsMax = null;
  else if (key === 'played') v.from = v.to = null;
  else if (key in v && Array.isArray(v[key])) v[key] = v[key].filter((x) => x !== value);
  return v;
}

/** Sorting by a column: the other way round when it is the one already sorted by. */
export function sortedBy(view, sort) {
  const v = normaliseView(view);
  if (v.sort === sort) v.order = v.order === 'desc' ? 'asc' : 'desc';
  else {
    v.sort = sort;
    v.order = ASCENDING_FIRST.has(sort) ? 'asc' : 'desc';
  }
  return v;
}

/** The address of the list, or its export, for this view and mode. */
export function scoreListUrl(path, view, mode, extra = {}) {
  const v = normaliseView(view);
  const asked = Object.fromEntries(Object.entries(v).filter(([key]) => !DISPLAY_KEYS.has(key)));
  const query = new URLSearchParams({ mode: String(mode), view: JSON.stringify(asked) });
  for (const [k, value] of Object.entries(extra)) query.set(k, String(value));
  return `${path}?${query}`;
}

const GRADE_NAMES = { XH: 'SS', X: 'SS', SH: 'S', S: 'S' };
const SILVER = new Set(['XH', 'SH']);

function gradeName(grade) {
  const name = GRADE_NAMES[grade] ?? grade;
  return SILVER.has(grade) ? t('export.silver', { grade: name }) : name;
}

const CLIENT_NAMES = { stable: 'osu!stable', lazer: 'osu!lazer', mcosu: 'McOsu', neki: 'neki', neomod: 'neomod' };

function clientName(client) {
  return CLIENT_NAMES[client] ?? client;
}

/** "4 plays", by the language's own plural rules. */
export function playsText(n) {
  const count = { n: fmt(n) };
  return plural(
    n,
    () => t('scoreList.playsOne', count),
    () => tOwn('scoreList.playsFew', count),
    () => t('scoreList.playsMany', count),
  );
}

/** The table's columns: the sort each one is, where it is one. */
const COLUMNS = [
  { key: 'place', label: '', className: 'score-table__place' },
  { key: 'grade', label: () => t('scoreList.colGrade'), sort: 'grade' },
  { key: 'beatmap', label: () => t('scoreList.colBeatmap'), sort: 'beatmap', className: 'score-table__beatmap' },
  { key: 'mods', label: () => t('scoreList.colMods') },
  { key: 'accuracy', label: () => t('scoreList.colAccuracy'), sort: 'accuracy', className: 'num' },
  { key: 'combo', label: () => t('scoreList.colCombo'), sort: 'combo', className: 'num' },
  { key: 'stars', label: () => t('scoreList.colStars'), sort: 'stars', className: 'num' },
  { key: 'pp', label: () => 'pp', sort: 'pp', className: 'num' },
  { key: 'playcount', label: () => t('scoreList.playcount'), sort: 'playcount', className: 'num' },
  { key: 'date', label: () => t('scoreList.colPlayed'), sort: 'date' },
  { key: 'menu', label: '' },
];

/** The table: a header that sorts, and a row per score, numbered from `offset`. */
export function tableHtml(plays, view, offset = 0) {
  const v = normaliseView(view);
  const head = COLUMNS.map((c) => {
    const label = typeof c.label === 'function' ? c.label() : c.label;
    const cls = c.className ? ` class="${c.className}"` : '';
    if (!c.sort) return `<th${cls} scope="col">${escapeHtml(label)}</th>`;
    const active = v.sort === c.sort;
    const aria = active ? ` aria-sort="${v.order === 'asc' ? 'ascending' : 'descending'}"` : '';
    const arrow = active ? `<span class="score-table__arrow" aria-hidden="true">${v.order === 'asc' ? '&#9652;' : '&#9662;'}</span>` : '';
    return `<th${cls} scope="col"${aria}><button type="button" class="score-table__sort${active ? ' score-table__sort--active' : ''}" data-sort="${c.sort}">${escapeHtml(label)}${arrow}</button></th>`;
  }).join('');
  return `<div class="score-table__scroll"><table class="score-table">
  <thead><tr>${head}</tr></thead>
  <tbody>${plays.map((p, i) => tableRow(p, offset + i + 1)).join('')}</tbody>
</table></div>`;
}

function tableRow(play, place) {
  const artist = beatmapArtist(play);
  const title = beatmapTitle(play) ?? beatmapName(play) ?? (play.beatmapMd5 ?? '').slice(0, 12);
  const full = `${artist ? `${artist} - ` : ''}${title} [${play.version ?? ''}]`;
  const pp = play.pp == null
    ? '<span class="score-table__muted">-</span>'
    : `${fmt(play.pp)}<small>pp</small>`;
  return `<tr class="score-table__row${play.counted ? '' : ' score-table__row--uncounted'}" data-score-id="${play.id}">
  <td class="score-table__place">${place}</td>
  <td class="score-table__grade">${gradeBadge(play.grade)}</td>
  <td class="score-table__beatmap" title="${escapeHtml(full)}">
    <span class="score-table__title">${escapeHtml(title)}</span>${artist ? ` <small>by ${escapeHtml(artist)}</small>` : ''}
    <span class="score-table__version">[${escapeHtml(play.version ?? '')}]</span>${play.creator ? ` <small>${escapeHtml(play.creator)}</small>` : ''}
  </td>
  <td><div class="score-table__mods">${modList(play.mods)}</div></td>
  <td class="num">${pct(play.accuracy)}</td>
  <td class="num">${fmt(play.maxCombo ?? 0)}x</td>
  <td class="num">${play.stars == null ? '' : `${fmt(play.stars, 2)}&#9733;`}</td>
  <td class="num score-table__pp">${pp}</td>
  <td class="num">${fmt(play.playcount ?? 1)}</td>
  <td class="score-table__date" title="${escapeHtml(fullDate(play.playedAt))}">${escapeHtml(timeAgo(play.playedAt))}</td>
  <td class="score-table__menu">${playMenuButton(play)}</td>
</tr>`;
}

/** osu!'s rows, each with its beatmap's playcount beside the date. */
export function rowsHtml(plays, { starRating = false } = {}) {
  return plays.map((p) => playRow(p, { actions: true, starRating, playcount: playsText(Number(p.playcount ?? 1)) })).join('');
}

/* ------------------------------------------------------------------ the page */

/** What the page lends this view: the mode, the profile's settings, and the score card. */
let ctx = null;
let view = normaliseView(null);
let rows = [];
let total = 0;
/** Whether the first page has arrived: until then the list says nothing rather than "no scores". */
let loaded = false;
let choices = { mods: [], grades: [], clients: [] };
/** Bumped by each load, so an answer that arrives after a newer request is dropped. */
let generation = 0;
let saveTimer = null;
let searchTimer = null;

export function scoreListOpen() {
  return document.body.classList.contains('view-scores');
}

/** How many rows a page holds, as picked under the list: 100 unless changed. */
function pageSize() {
  return PAGE_SIZES.includes(view.pageSize) ? view.pageSize : DEFAULT_VIEW.pageSize;
}

/**
 * The first page, or the next one after what is shown (`append`), or everything left (`all`):
 * asked for in pieces of the server's cap, so many thousands of scores come in a few requests.
 */
async function load({ append = false, all = false } = {}) {
  const mine = ++generation;
  for (const id of ['scoreListMore', 'scoreListAll']) $(id).disabled = true;
  try {
    let next = append || all ? rows : [];
    do {
      const limit = all ? MOST_AT_ONCE : pageSize();
      const r = await fetch(scoreListUrl('/api/score-list', view, ctx.getMode(), { offset: next.length, limit }));
      const d = await r.json();
      if (mine !== generation) return;
      next = [...next, ...d.rows];
      total = d.total;
      if (d.choices) choices = d.choices;
      if (d.rows.length === 0) break;
    } while (all && next.length < total);
    rows = next;
    loaded = true;
    render();
  } catch {
    /* the app stopped; the page says so elsewhere */
  } finally {
    if (mine === generation) for (const id of ['scoreListMore', 'scoreListAll']) $(id).disabled = false;
  }
}

/** A changed view: drawn, saved with the profile a moment later, and the list asked for again. */
function change(next) {
  view = normaliseView(next);
  renderControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const saved = { ...view };
    ctx.setSettings({ ...ctx.getSettings(), scoreList: saved });
    postJson('/api/settings', { scoreList: saved }, 'saving that failed').catch(() => {});
  }, 400);
  void load();
}

function render() {
  renderControls();
  const body = $('scoreListBody');
  if (!loaded) {
    body.innerHTML = '';
  } else if (rows.length === 0) {
    body.innerHTML = `<div class="u-empty">${escapeHtml(viewChanged(view) ? t('scoreList.noMatch') : t('scoreList.empty'))}</div>`;
  } else {
    body.innerHTML = view.layout === 'rows'
      ? `<div class="score-list__rows">${rowsHtml(rows, { starRating: ctx.getConfig()?.starRating === true })}</div>`
      : tableHtml(rows, view);
  }
  const more = rows.length < total;
  $('scoreListMore').hidden = !more;
  $('scoreListAll').hidden = !more;
  $('scoreListAllCount').textContent = more ? `(${fmt(total)})` : '';
  $('scoreListPaging').hidden = rows.length === 0;
  $('scoreListPageSize').value = String(pageSize());
}

/** The toolbar, the filters and the chips, as the view stands. */
function renderControls() {
  for (const b of $('scoreListShow').querySelectorAll('[data-show]')) {
    b.setAttribute('aria-pressed', String(b.dataset.show === view.show));
  }
  for (const b of $('scoreListLayout').querySelectorAll('[data-layout]')) {
    b.setAttribute('aria-pressed', String(b.dataset.layout === view.layout));
  }
  $('scoreListSort').value = view.sort;
  $('scoreListOrder').dataset.order = view.order;
  $('scoreListOrder').title = view.order === 'asc' ? t('scoreList.ascending') : t('scoreList.descending');
  $('scoreListOrder').setAttribute('aria-label', $('scoreListOrder').title);
  if (document.activeElement !== $('scoreListSearch')) $('scoreListSearch').value = view.search;

  $('scoreListUncounted').checked = view.uncounted;
  const toggles = (id, values, picked, label) => {
    $(id).innerHTML = values.map((value) => `<button type="button" class="score-list__choice" data-value="${escapeHtml(value)}"
      aria-pressed="${picked.includes(value)}">${label(value)}</button>`).join('') || `<span class="score-list__none">-</span>`;
  };
  toggles('scoreListMods', ['NM', ...choices.mods], view.mods,
    (m) => (m === 'NM' ? escapeHtml(t('scoreList.noMod')) : modPill({ acronym: m })));
  toggles('scoreListGrades', choices.grades, view.grades, (g) => gradeBadge(g, { title: gradeName(g) }));
  toggles('scoreListClients', choices.clients, view.clients, (c) => escapeHtml(clientName(c)));
  const number = (id, value) => {
    if (document.activeElement !== $(id)) $(id).value = value === null ? '' : String(value);
  };
  number('scoreListStarsMin', view.starsMin);
  number('scoreListStarsMax', view.starsMax);
  $('scoreListFrom').value = view.from === null ? '' : dayOf(view.from);
  $('scoreListTo').value = view.to === null ? '' : dayOf(view.to);

  const chips = activeFilters(view);
  $('scoreListFiltersCount').textContent = chips.filter((c) => c.key !== 'show' && c.key !== 'search').length || '';
  const changed = viewChanged(view);
  $('scoreListChips').hidden = !changed;
  $('scoreListChips').innerHTML = chips.map((c) => `<span class="score-list__chip">${escapeHtml(c.label)}
      <button type="button" data-chip="${c.key}" data-value="${escapeHtml(c.value ?? '')}"
        aria-label="${escapeHtml(t('scoreList.remove', { filter: c.label }))}">&times;</button></span>`).join('')
    + (changed ? `<button type="button" class="score-list__reset" id="scoreListReset">${escapeHtml(t('scoreList.reset'))}</button>` : '');

  for (const format of ['csv', 'xlsx', 'json']) {
    const link = $(`scoreListExport-${format}`);
    if (link) link.href = scoreListUrl('/api/score-list/export', view, ctx.getMode(), { format, lang: document.documentElement.lang || 'en' });
  }
}

function closePopovers(except = null) {
  for (const id of ['scoreListFilters', 'scoreListExport']) {
    if (id !== except) {
      $(id).hidden = true;
      $(`${id}Btn`).setAttribute('aria-expanded', 'false');
    }
  }
}

function togglePopover(id) {
  const open = $(id).hidden;
  closePopovers(id);
  $(id).hidden = !open;
  $(`${id}Btn`).setAttribute('aria-expanded', String(open));
}

/** Whether a popover is open, so Escape closes that first. */
export function scoreListPopoverOpen() {
  return !$('scoreListFilters').hidden || !$('scoreListExport').hidden;
}

export function closeScoreListPopovers() {
  closePopovers();
}

/** Show the view, with the profile's saved setup, and ask for its first page. */
export function openScoreList() {
  view = normaliseView(ctx.getSettings().scoreList);
  rows = [];
  loaded = false;
  document.body.classList.add('view-scores');
  renderViewTabs();
  render();
  void load();
}

export function closeScoreList() {
  closePopovers();
  document.body.classList.remove('view-scores');
  renderViewTabs();
}

function renderViewTabs() {
  const scores = scoreListOpen();
  for (const link of document.querySelectorAll('[data-view-tab]')) {
    const on = (link.dataset.viewTab === 'scores') === scores;
    link.classList.toggle('header-nav-v4__link--active', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Ask again, as it stands: a new score, another tab's change, a different mode. */
export function refreshScoreList() {
  if (scoreListOpen()) void load();
}

/**
 * Wire the view up once. `context` lends what lives in main.js: `getMode`, `getSettings`,
 * `setSettings`, `getConfig` and `openScore`.
 */
export function bindScoreList(context) {
  ctx = context;
  $('scoreListShow').onclick = (e) => {
    const b = e.target.closest('[data-show]');
    if (b && b.dataset.show !== view.show) change({ ...view, show: b.dataset.show });
  };
  $('scoreListLayout').onclick = (e) => {
    const b = e.target.closest('[data-layout]');
    if (!b || b.dataset.layout === view.layout) return;
    view = { ...view, layout: b.dataset.layout };
    // The same rows, drawn the other way: nothing to ask for.
    render();
    ctx.setSettings({ ...ctx.getSettings(), scoreList: { ...view } });
    postJson('/api/settings', { scoreList: { ...view } }, 'saving that failed').catch(() => {});
  };
  $('scoreListSort').onchange = () => {
    const sort = $('scoreListSort').value;
    change({ ...view, sort, order: ASCENDING_FIRST.has(sort) ? 'asc' : 'desc' });
  };
  $('scoreListOrder').onclick = () => change({ ...view, order: view.order === 'asc' ? 'desc' : 'asc' });
  $('scoreListSearch').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => change({ ...view, search: $('scoreListSearch').value.trim() }), 250);
  };
  $('scoreListFiltersBtn').onclick = (e) => {
    e.stopPropagation();
    togglePopover('scoreListFilters');
  };
  $('scoreListExportBtn').onclick = (e) => {
    e.stopPropagation();
    togglePopover('scoreListExport');
  };
  $('scoreListExport').onclick = () => closePopovers();
  $('scoreListFilters').onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-value]');
    if (!b) return;
    const list = { scoreListMods: 'mods', scoreListGrades: 'grades', scoreListClients: 'clients' }[b.parentElement.id];
    if (!list) return;
    const value = b.dataset.value;
    const picked = view[list].includes(value) ? view[list].filter((x) => x !== value) : [...view[list], value];
    change({ ...view, [list]: picked });
  };
  $('scoreListUncounted').onchange = () => change({ ...view, uncounted: $('scoreListUncounted').checked });
  const stars = () => {
    const read = (id) => {
      const raw = $(id).value.trim();
      const n = Number(raw);
      return raw === '' || !Number.isFinite(n) || n < 0 ? null : n;
    };
    change({ ...view, starsMin: read('scoreListStarsMin'), starsMax: read('scoreListStarsMax') });
  };
  $('scoreListStarsMin').onchange = $('scoreListStarsMax').onchange = stars;
  $('scoreListFrom').onchange = $('scoreListTo').onchange = () => {
    // A day from its start, to its end, in local time.
    const day = (id, end) => {
      const raw = $(id).value;
      if (!raw) return null;
      const [y, m, d] = raw.split('-').map(Number);
      return end ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime();
    };
    change({ ...view, from: day('scoreListFrom', false), to: day('scoreListTo', true) });
  };
  $('scoreListChips').onclick = (e) => {
    if (e.target.closest('#scoreListReset')) {
      change(resetView(view));
      return;
    }
    const b = e.target.closest('[data-chip]');
    if (b) change(withoutFilter(view, b.dataset.chip, b.dataset.value));
  };
  $('scoreListBody').addEventListener('click', (e) => {
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      change(sortedBy(view, sort.dataset.sort));
      return;
    }
    // A table row opens its score, as a row on the profile does; the menu keeps its own job.
    const row = e.target.closest('tr[data-score-id]');
    if (!row || e.target.closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    ctx.openScore(Number(row.dataset.scoreId));
  });
  $('scoreListMore').onclick = () => void load({ append: true });
  $('scoreListAll').onclick = () => void load({ all: true });
  // How many at a time: the first page drawn again at that size, and each show more after.
  $('scoreListPageSize').onchange = () => change({ ...view, pageSize: Number($('scoreListPageSize').value) });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.score-list__pop')) closePopovers();
  });
}
