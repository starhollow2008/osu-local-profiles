/**
 * Page controller: fetches state, renders, and keeps up with live scores over SSE.
 *
 * There is no framework here on purpose (see docs/phase-2-handoff.md). Every update is a
 * refetch followed by a re-render of the affected block, which is plenty for a page that
 * changes once every few minutes when a play lands.
 */
import {
  MODE_NAMES,
  countryName,
  escapeHtml,
  fmt,
  pct,
  playTimeStrings,
  shortDate,
} from './format.js';
import {
  coverUrl,
  generatedAvatar,
  gradeBadge,
  levelBadge,
} from './badges.js';
import { bindCharts, playHistoryChart, ppChart, rankChart } from './charts.js';
import { favoriteList } from './beatmapsets.js';
import { scoreCard } from './score-card.js';
import {
  cardOwner,
  copyScoreImage,
  copyScoreLink,
  downloadReplay,
  saveScoreImage,
} from './score-share.js';
import { downloadBlob, hint, postJson, toast } from './ui.js';
import { medalFor, renderMedals } from './medals.js';
import { setPopupCards } from './beatmaps-popup.js';
import { syncPlayers } from './audio-player.js';
import {
  aboutHtml,
  activityList,
  beatmapPlaycountList,
  countingNoteText,
  playList,
  reconcileSectionOrder,
  showMore,
} from './sections.js';

const $ = (id) => document.getElementById(id);

/*
 * The sections, in their default order. Recent Plays sits near the top, since following the
 * plays is what this profile is for; Milestones -- osu!'s "Recent" feed of medals, bests and
 * levels -- sits under Historical. Both orders at the user's request.
 */
const SECTIONS = [
  ['me', 'me!'],
  ['recent_plays', 'Recent Plays'],
  // The id is kept from when osu! called this Top Ranks: saved section orders refer to it.
  ['top_ranks', 'Scores'],
  ['historical', 'Historical'],
  // The id is kept from when this was called Recent: saved section orders refer to it.
  ['recent', 'Milestones'],
  ['beatmaps', 'Beatmaps'],
  // Last by default, at the user's request.
  ['medals', 'Medals'],
];

/* The five grades osu! counts on a profile. XH/X and SH/S are the silver variants. */
const GRADE_ORDER = ['XH', 'X', 'SH', 'S', 'A'];

/**
 * The Settings dialog is generated from this list, so adding a setting is one entry here
 * plus one entry in `DEFS` in src/settings.ts. `key` matches the setting name exactly --
 * the dialog posts the whole field set as a patch and the server ignores anything it does
 * not recognise.
 */
const SETTINGS_FIELDS = [
  {
    key: 'country',
    type: 'text',
    label: 'Country',
    maxlength: 2,
    placeholder: 'e.g. US',
    hint: 'Two-letter code, shown beside the profile name. Leave empty for none.',
  },
  {
    key: 'tagline',
    type: 'text',
    label: 'Playstyle',
    maxlength: 120,
    placeholder: 'e.g. left hand, mouse only',
    hint: 'What this profile is tracking. Shown under the name.',
  },
  {
    key: 'includeUnrankedMods',
    type: 'toggle',
    label: 'Include pp for unranked mods',
    hint:
      'Count plays osu! refuses to rank because of their mods - Relax, Autopilot, or a ' +
      'customised rate such as DT at 1.45x. Off by default: with this on, the profile is ' +
      'no longer comparable with a real osu! account.',
  },
  {
    key: 'showCountingNote',
    type: 'toggle',
    label: 'Warn when scoring is not comparable',
    hint:
      'Shows a line in Scores when a setting has made this profile’s pp incomparable ' +
      'with a real osu! account. Turning it off hides that sentence only - the affected ' +
      'scores keep their *. This is also what the note’s "Don’t show again" sets.',
  },
  {
    key: 'unrankedModPp',
    type: 'choice',
    label: 'Price relax plays',
    dependsOn: 'includeUnrankedMods',
    options: [
      ['without-the-mod', 'as if the mod were off'],
      ['as-played', 'as osu! scores them'],
    ],
    hint:
      'Relax and Autopilot only. "As if the mod were off" makes relax count as nomod and ' +
      'relax + DT count as DT, which is usually what people mean - but it flatters the ' +
      'score, because a relax run reaches accuracy and combo the player could not by hand. ' +
      'Both numbers come from osu! itself and both are stored, so switching is instant.',
  },
  {
    key: 'showIncompleteInRecent',
    type: 'choice',
    label: 'Unfinished plays in Recent Plays',
    options: [
      ['collapse', 'group retries on one map'],
      ['yes', 'show every attempt'],
      ['no', 'hide them'],
    ],
    hint:
      'Plays that were started but never finished - quit, retried, or failed. They always ' +
      'count toward your play count, monthly play counts and Most Played, because osu! ' +
      'counts them too; this only decides whether they are listed here. There is no score ' +
      'to show for them: osu!lazer saves a replay only for a map played to the end.',
  },
  {
    key: 'includeUnrankedMaps',
    type: 'checkboxes',
    label: 'Include pp for unranked beatmaps',
    // Roughly osu!'s own ordering, most-established first.
    options: [
      ['loved', 'Loved'],
      ['qualified', 'Qualified'],
      ['pending', 'Pending'],
      ['wip', 'Work in progress'],
      ['graveyard', 'Graveyarded'],
      ['unsubmitted', 'Never submitted'],
    ],
    hint:
      'None by default. These are separate choices because they are not the same thing: a ' +
      'Loved map is played competitively, a graveyarded one may be a draft nobody finished, ' +
      'and a never-submitted one exists only on your machine. pp still comes from osu!, ' +
      'which will happily price any beatmap it is given.',
  },
];

/*
 * The paged sections, and how far each is currently expanded.
 *
 * Five rows to begin with, as on osu!, then a jump to 25 and 25 at a time after that. The
 * counts are sent with every profile request rather than the whole history being fetched
 * and sliced here, so a profile with thousands of plays costs the same to open as a new
 * one -- and expanding stays honest for however long the list actually is.
 */
const PAGE_FIRST = 5;
const PAGE_STEP = 25;

/*
 * Favorite Beatmaps pages as osu!'s does: its cards sit two to a row, so osu!'s three rows
 * are six cards, and "show more" goes to 25 rows (50 cards) and then 25 rows at a time.
 */
const PAGE_SIZES = { favorites: [6, 50] };
const PAGED = ['events', 'top', 'mostPlayed', 'recent', 'favorites'];
const firstPage = (section) => PAGE_SIZES[section]?.[0] ?? PAGE_FIRST;
const pageStep = (section) => PAGE_SIZES[section]?.[1] ?? PAGE_STEP;

const shown = Object.fromEntries(PAGED.map((s) => [s, firstPage(s)]));
const resetPaging = () => {
  // Favourites belong to the profile rather than a mode, so a mode switch leaves them be.
  for (const section of PAGED) if (section !== 'favorites') shown[section] = firstPage(section);
};

let mode = 0;
let tracking = false;
let modesWithPlays = [];
/** What this build is, from /api/state. `version` is null if package.json was unreadable. */
let app = { version: null };
let profile = null;
let stats = null;
let settings = {};
let counting = null;
let staleScores = 0;
/** Which osu! release prices scores, and how many of this profile's another one priced. */
let ppCalculator = { version: null, outdated: 0 };
let hiddenScoreCount = 0;
let sharing = { canScreenshot: false };

/* ---------------------------------------------------------------- header */

function renderIdentity() {
  if (!profile) return;

  $('pname').textContent = profile.name;

  $('avatar').innerHTML = profile.hasAvatar
    ? `<img src="/api/image/avatar" alt="${escapeHtml(profile.name)}">`
    : generatedAvatar(profile.name);

  const bits = [];
  if (profile.country) {
    const code = profile.country.toUpperCase();
    const name = countryName(code);
    // The flag is a background image on a span, as it is on osu!: the sheen overlay in
    // `.flag-country::after` inherits it. A code we have no flag for renders nothing and
    // leaves the name beside it, which is still the whole answer.
    bits.push(`<span class="profile-info__flag">
      <span class="flag-country" role="img" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}"
            style="background-image: url('/flags/${escapeHtml(code.toLowerCase())}.svg')"></span>
      <span class="profile-info__flag-text">${escapeHtml(name)}</span>
    </span>`);
  }
  if (profile.tagline) bits.push(`<span class="profile-info__tagline">${escapeHtml(profile.tagline)}</span>`);
  $('pflags').innerHTML = bits.join('');
}

/**
 * osu! shows a user-chosen cover here. A new profile has none, so it falls back to the
 * beatmap art of its best play -- and to the flat panel colour when offline.
 */
function renderCover(top) {
  const el = $('cover');
  if (profile?.hasCover) {
    el.style.setProperty('--cover', "url('/api/image/cover')");
    return;
  }
  const url = coverUrl(top?.[0]?.beatmapsetId, 'cover@2x');
  el.style.setProperty('--cover', url ? `url('${url}')` : 'none');
}

function renderModes() {
  $('modes').innerHTML = MODE_NAMES.map((name, i) => {
    const classes = ['game-mode__link'];
    if (i === mode) classes.push('game-mode__link--active');
    if (!modesWithPlays.includes(i)) classes.push('game-mode__link--empty');
    return `<a class="${classes.join(' ')}" href="#" data-mode="${i}">${escapeHtml(name)}</a>`;
  }).join('');
}

$('modes').addEventListener('click', (e) => {
  const link = e.target.closest('[data-mode]');
  if (!link) return;
  e.preventDefault();
  mode = Number(link.dataset.mode);
  // A different mode is a different set of lists; carrying an expansion across would ask
  // for 200 rows of a mode that has three.
  resetPaging();
  renderModes();
  loadProfile();
});

/* ----------------------------------------------------------- detail block */

/**
 * osu-web's three figures under the chart: Medals, pp, and Total Play Time. The medal count
 * is the whole profile's, as osu!'s is, so it does not move when the mode tab does.
 */
function renderStats(next, medalTotal) {
  stats = next;
  $('medalTotal').textContent = fmt(medalTotal ?? 0);
  $('totalPp').textContent = fmt(stats.totalPp, 0);
  $('totalPp').title =
    `${fmt(stats.weightedPp, 0)}pp from the top plays, plus ${fmt(stats.bonusPp, 0)} bonus pp ` +
    `for ${fmt(stats.distinctRankedBeatmaps)} beatmap${stats.distinctRankedBeatmaps === 1 ? '' : 's'}`;

  const playTime = playTimeStrings(stats.playTime);
  $('playTime').textContent = playTime.value;
  $('playTime').title = playTime.title;

  $('gradeCounts').innerHTML = GRADE_ORDER.map(
    (g) => `<div class="profile-rank-count__item">
      <div class="profile-rank-count__rank">${gradeBadge(g)}</div>
      ${fmt(stats.grades[g] ?? 0)}
    </div>`,
  ).join('');

  // osu-web's v1 stats box, minus play time (which it also omits) and replays watched
  // (which does not apply to a local profile).
  const entries = [
    ['Ranked Score', fmt(stats.rankedScore)],
    ['Hit Accuracy', pct(stats.accuracy)],
    ['Play Count', fmt(stats.playcount)],
    ['Total Score', fmt(stats.totalScore)],
    ['Total Hits', fmt(stats.totalHits)],
    ['Hits per Play', fmt(stats.hitsPerPlay)],
    ['Maximum Combo', `${fmt(stats.maxCombo)}x`],
  ];
  $('profileStats').innerHTML = entries
    .map(
      ([k, v]) => `<div class="profile-stats__entry">
        <dt class="profile-stats__key">${escapeHtml(k)}</dt>
        <dd class="profile-stats__value">${v}</dd>
      </div>`,
    )
    .join('');

  const progress = Math.round((stats.level.progress ?? 0) * 100);
  $('levelFill').style.width = `${progress}%`;
  $('levelText').textContent = `${progress}%`;
  $('levelBadge').innerHTML = levelBadge(stats.level.current);
}

/**
 * osu! shows a global and a country rank. The global one is estimated offline from a
 * data.ppy.sh sample; the country one is not shown at all, because a 10,000-user sample
 * spread over ~200 countries is far too thin to interpolate per country, and a made-up
 * number would be worse than an honest dash.
 */
function renderRank(data) {
  const el = $('globalRank');
  if (data.rank) {
    el.textContent = `#${fmt(data.rank.rank)}`;
    el.title =
      `Estimated from osu!'s ${data.rankSource?.dump ?? data.rank.dump} player sample` +
      `${data.rankSource ? ` (${fmt(data.rankSource.sampled)} users)` : ''}. ` +
      'Approximate, and drifts as the playerbase grows.';
  } else {
    el.textContent = '-';
    el.title = stats?.totalPp > 0
      ? 'No rank curve has been built for this mode yet - see scripts/build-rank-table.mjs'
      : 'A profile with no pp is not on the ladder yet';
  }
}

/**
 * Says, once, that this profile is not being scored the way osu! would.
 *
 * The individual rows are marked too, but a total on its own gives the reader no reason to
 * go looking at the rows it came from -- so the section that carries the total has to admit
 * it. The wording lives in sections.js; this only decides whether it is on screen.
 */
function renderCountingNote(next) {
  counting = next ?? null;
  const text = countingNoteText(counting);
  const note = $('countingNote');

  // Two conditions, and they are not the same one: there is something to warn about, and
  // this profile has not asked to stop being warned. Dismissing hides the sentence only --
  // the affected rows keep their `*`.
  note.hidden = text === '' || settings.showCountingNote === false;
  if (note.hidden) {
    note.innerHTML = '';
    return;
  }

  note.innerHTML = `<div class="counting-note__text">${escapeHtml(text)}</div>
    <div class="counting-note__actions">
      <button type="button" class="counting-note__dismiss" data-dismiss-note>Don't show again</button>
      <button type="button" class="counting-note__close" data-dismiss-note
              aria-label="Don't show this again">&times;</button>
    </div>`;
}

/*
 * Both controls do the same thing, and permanently: the X is the affordance people reach
 * for, the wording is what makes the consequence explicit. Saved per profile, so it can be
 * turned back on from Settings.
 */
$('countingNote').onclick = async (e) => {
  if (!e.target.closest('[data-dismiss-note]')) return;

  $('countingNote').hidden = true;
  settings = { ...settings, showCountingNote: false };
  try {
    const d = await postJson('/api/settings', { showCountingNote: false }, 'saving that failed');
    settings = d.settings;
  } catch (err) {
    // It is hidden for this view either way; a failed save just means it returns next load.
    toast(err.message);
  }
};

/**
 * An empty Favorite Beatmaps says how to fill it, until the profile says not to: the counting
 * note's shape, with an Import button beside Don't show again. Once there is a favorite the
 * reminder has done its job and steps aside on its own.
 */
function renderFavoritesNote(total) {
  const note = $('favoritesNote');
  note.hidden = total > 0 || settings.showFavoritesHint === false;
  if (note.hidden) {
    note.innerHTML = '';
    return;
  }
  note.innerHTML = `<div class="counting-note__text">
      Favorite a beatmap from the <b>&middot;&middot;&middot;</b> menu on any play in Recent Plays or
      Scores and it appears here. Already have favorites on osu!? Import them from your account.
    </div>
    <div class="counting-note__actions">
      <button type="button" class="counting-note__import" data-import-favorites>Import&hellip;</button>
      <button type="button" class="counting-note__dismiss" data-dismiss-note>Don't show again</button>
      <button type="button" class="counting-note__close" data-dismiss-note
              aria-label="Don't show this again">&times;</button>
    </div>`;
}

$('favoritesNote').onclick = async (e) => {
  if (e.target.closest('[data-import-favorites]')) {
    void openImport({ favoritesOnly: true });
    return;
  }
  if (!e.target.closest('[data-dismiss-note]')) return;

  $('favoritesNote').hidden = true;
  settings = { ...settings, showFavoritesHint: false };
  try {
    const d = await postJson('/api/settings', { showFavoritesHint: false }, 'saving that failed');
    settings = d.settings;
  } catch (err) {
    toast(err.message);
  }
};

/* ------------------------------------------------------------------ data */

async function loadProfile() {
  const query = new URLSearchParams({ mode: String(mode) });
  for (const section of PAGED) query.set(section, String(shown[section]));
  const data = await (await fetch(`/api/profile?${query}`)).json();

  // A profile that has never been paged has no totals; fall back to what arrived, so the
  // page still renders against an older server.
  const totals = data.totals ?? {};
  const totalFor = (section, list) => totals[section] ?? list.length;

  renderStats(data.stats, data.medalTotal);
  renderCover(data.top);

  renderRank(data);

  // osu-web charts global rank; fall back to pp when no rank curve exists for this mode.
  const rankPoints = (data.rankHistory ?? []).filter((p) => p.rank != null);
  $('ppChart').innerHTML = rankPoints.length
    ? rankChart(rankPoints)
    : ppChart(data.ppHistory, data.stats.playcount > 0 ? 'no ranked plays yet' : 'unranked');

  $('recentActivity').innerHTML =
    activityList(data.events) +
    showMore('events', data.events.length, shown.events, totalFor('events', data.events));

  renderCountingNote(data.counting);
  renderMedals(data.medals, mode);

  // Held for the menu's Move up / Move down and for drag reordering, both of which work in
  // terms of positions in this list.
  pinnedIds = (data.pinned ?? []).map((p) => p.id);
  $('pinnedCount').textContent = fmt(pinnedIds.length);
  // Nothing pinned leaves the space empty, as osu! does, rather than explaining itself.
  $('pinnedPlays').innerHTML = playList(data.pinned, {
    actions: true,
    reorderable: true,
    empty: '',
  });

  const topTotal = totalFor('top', data.top);
  $('topCount').textContent = fmt(topTotal);
  $('topRanks').innerHTML =
    playList(data.top, {
      showWeight: true,
      actions: true,
      empty:
        settings.includeUnrankedMods || settings.includeUnrankedMaps?.length
          ? 'No plays with a pp value tracked yet.'
          : 'No ranked plays tracked yet.',
    }) + showMore('top', data.top.length, shown.top, topTotal);

  const chart = playHistoryChart(data.monthlyPlaycounts);
  $('playcountChart').innerHTML = chart;
  $('playcountChart').hidden = chart === '';

  const mostPlayedTotal = totalFor('mostPlayed', data.mostPlayed);
  $('mostPlayedCount').textContent = fmt(mostPlayedTotal);
  $('mostPlayed').innerHTML =
    beatmapPlaycountList(data.mostPlayed) +
    showMore('mostPlayed', data.mostPlayed.length, shown.mostPlayed, mostPlayedTotal);

  const recentTotal = totalFor('recent', data.recent);
  $('recentCount').textContent = fmt(recentTotal);
  $('recentPlays').innerHTML =
    playList(data.recent, {
      actions: true,
      empty: 'Nothing yet - go set a play.',
    }) + showMore('recent', data.recent.length, shown.recent, recentTotal);

  // Favorite Beatmaps. An empty list is just the heading and its 0, as on osu!.
  favoriteSetIds = new Set(data.favoriteIds ?? []);
  const favoritesTotal = totalFor('favorites', data.favorites ?? []);
  $('favoriteCount').textContent = fmt(favoritesTotal);
  setPopupCards(data.favorites ?? []);
  $('favoriteBeatmaps').innerHTML =
    favoriteList(data.favorites) +
    showMore('favorites', (data.favorites ?? []).length, shown.favorites, favoritesTotal);
  renderFavoritesNote(favoritesTotal);
  // The redraw replaced the playing card with one showing play; give it back its state. If
  // the card is gone the clip plays on, as osu!'s does, with the bar still in charge of it.
  syncPlayers();

  // Every render above replaced markup wholesale, which discards the nodes any previous
  // hover listener was attached to. Re-arming here rather than per chart keeps it to one
  // call that cannot be forgotten when a chart moves.
  bindCharts(document);
}

async function loadState() {
  const s = await (await fetch('/api/state')).json();
  profile = s.profile;
  profiles = s.profiles ?? [];
  settings = s.settings ?? {};
  staleScores = s.staleScores ?? 0;
  ppCalculator = s.ppCalculator ?? ppCalculator;
  renderPpCalculator();
  hiddenScoreCount = s.hiddenScores ?? 0;
  sharing = s.sharing ?? sharing;
  modesWithPlays = s.modesWithPlays ?? [];

  app = s.app ?? app;
  renderOpenBrowser();
  $('footerVersion').textContent = app.version
    ? `osu! local profiles v${app.version}`
    : 'osu! local profiles';
  renderUpdate();

  const kinds = s.installs.map((i) => i.kind).join(' + ') || 'no client found';
  $('optInfo').textContent = `${s.profile.name} - watching ${kinds} - ${s.scoresThisSession} score${
    s.scoresThisSession === 1 ? '' : 's'
  } this session`;

  setTracking(s.tracking);
  renderIndexing(s.indexing);
  renderIdentity();
  // Never clobber what is being typed: a 15-second poll must not swallow a draft.
  if (!editingAbout) renderAbout();
  applySectionOrder();

  if (!window.__modeInit) {
    window.__modeInit = true;
    mode = s.defaultMode ?? 0;
  }
  renderModes();
}

/* -------------------------------------------------------------- tracking */

function setTracking(on) {
  tracking = on;
  $('toggle').className = `tracking-pill${on ? ' tracking-pill--on' : ''}`;
  $('tracklabel').textContent = on ? 'tracking' : 'paused';
  $('toggle').title = on ? 'Pause tracking' : 'Resume tracking';
}

$('toggle').onclick = async () => {
  try {
    setTracking((await postJson('/api/tracking', { enabled: !tracking })).tracking);
  } catch (err) {
    toast(err.message);
  }
};

/* ---------------------------------------------------------- beatmap index */

/*
 * The notice for the beatmap index, which runs beside the page. On a first launch the app
 * reads osu!'s whole folder once to match scores to their beatmaps; until it has, a new
 * score cannot be priced, so it is held rather than stored without pp. Without this the
 * page would just look broken: a score set, and nothing appearing.
 *
 * The server decides `visible` -- always on a first run, otherwise only once a routine
 * re-check has taken long enough to be worth mentioning.
 */
let indexShown = false;

function renderIndexing(state) {
  if (!state) return;
  const show = state.active && state.visible;
  $('indexNotice').hidden = !show;
  $('indexNotice').classList.toggle('index-notice--counting', show && state.phase === 'counting');

  if (show) {
    indexShown = true;
    $('indexTitle').textContent = state.firstRun ? 'Finding your beatmaps' : 'Updating the beatmap index';
    const done = state.total > 0 ? Math.min(1, state.scanned / state.total) : 0;
    $('indexDetail').textContent =
      state.phase === 'counting'
        ? `Looking through osu!'s files... ${fmt(state.total)} so far`
        : `${Math.floor(done * 100)}% - ${fmt(state.scanned)} of ${fmt(state.total)} files`;
    $('indexFill').style.setProperty('--fill', state.phase === 'counting' ? '30%' : `${done * 100}%`);
    const waiting = state.waiting > 0
      ? ` ${fmt(state.waiting)} play${state.waiting === 1 ? ' is' : 's are'} waiting to be added.`
      : '';
    $('indexNote').textContent =
      (state.firstRun
        ? "This happens once: the app reads your osu! folder to match each score to its beatmap. "
        : 'New beatmaps were found in your osu! folder. ') +
      'The page works meanwhile. Scores you set now are held and added, with pp, as soon as ' +
      `it finishes.${waiting}`;
    return;
  }

  // It was on screen and has finished: say so once, and show whatever it was holding back.
  if (indexShown && !state.active) {
    indexShown = false;
    toast(
      state.error
        ? `The beatmap index stopped: ${state.error}`
        : `Beatmaps ready${state.indexed ? ` - ${fmt(state.indexed)} indexed` : ''}`,
    );
    void loadProfile();
  }
}

/* ---------------------------------------------------------- options menu */

function setMenuOpen(open) {
  $('optionsMenu').hidden = !open;
  $('optionsBtn').setAttribute('aria-expanded', String(open));
}

$('optionsBtn').onclick = (e) => {
  e.stopPropagation();
  setMenuOpen($('optionsMenu').hidden);
};

// Clicking anywhere else, or Escape, closes the menu.
document.addEventListener('click', () => setMenuOpen(false));
$('optionsMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // The score card's own menu closes first; a second Escape closes the card.
  if (!$('scoreModal').hidden && $('playMenu').hidden) closeScoreCard();
  setMenuOpen(false);
  if (!$('resetModal').hidden) closeReset();
  if (!$('backfillModal').hidden) closeBackfill();
  if (!$('profilesModal').hidden) closeProfiles();
  if (!$('settingsModal').hidden) closeSettings();
  if (!$('playMenu').hidden) closePlayMenu();
  if (!$('identityModal').hidden) closeIdentity();
  if (!$('importModal').hidden) closeImport();
  if (!$('shareModal').hidden) closeShare();
  if (!$('updateModal').hidden) closeUpdate();
});

/* ------------------------------------------------------- open on start */

/*
 * "Open in browser on start": whether launching the app opens this page. It belongs to the
 * install, not the profile -- it decides what happens before any profile is on screen -- so
 * it is saved to data/config.json rather than with the profile's settings. On by default.
 *
 * The menu stays open when it is pressed, so the switch visibly flips under the pointer.
 */
function renderOpenBrowser() {
  const on = app.config?.openBrowser !== false;
  $('optOpenBrowser').setAttribute('aria-checked', String(on));
}

$('optOpenBrowser').onclick = async () => {
  const next = app.config?.openBrowser === false;
  app = { ...app, config: { ...app.config, openBrowser: next } };
  renderOpenBrowser();
  try {
    const d = await postJson('/api/app-config', { openBrowser: next }, 'saving that failed');
    app = { ...app, config: d.config };
    renderOpenBrowser();
    toast(next ? 'This page will open when the app starts' : 'The app will start without opening this page');
  } catch (err) {
    // Put back what the server actually has, rather than leaving the switch lying.
    app = { ...app, config: { ...app.config, openBrowser: !next } };
    renderOpenBrowser();
    toast(err.message);
  }
};

/* ----------------------------------------------------------------- update */

/*
 * The button only exists when there is something to install.
 *
 * `available` is the server's verdict, not the page's: it has already compared the versions,
 * confirmed there is a build for this platform, and confirmed this install is one that can
 * be replaced at all -- a source checkout cannot. A failed check leaves `available` false
 * and no button, which is the right outcome for "no network" and for "the repository is
 * private" alike.
 */
function renderUpdate() {
  const u = app.update ?? {};
  $('updateBtn').hidden = !u.available || u.blocked !== null;
}

function openUpdate() {
  const u = app.update ?? {};
  $('updateVersions').innerHTML =
    `<b>${escapeHtml(u.currentVersion ?? '?')}</b> &rarr; <b>${escapeHtml(u.latestVersion ?? '?')}</b>`;
  $('updateNotes').innerHTML = u.releaseUrl
    ? `<a href="${escapeHtml(u.releaseUrl)}" target="_blank" rel="noreferrer noopener">Release notes on GitHub</a>`
    : '';
  $('updateHint').innerHTML = '&nbsp;';
  $('updateConfirm').disabled = false;
  $('updateModal').hidden = false;
  $('updateCancel').focus();
}

const closeUpdate = () => { $('updateModal').hidden = true; };

$('updateBtn').onclick = openUpdate;
$('updateCancel').onclick = closeUpdate;
$('updateModal').onclick = (e) => {
  if (e.target === $('updateModal')) closeUpdate();
};

/*
 * The app exits as part of succeeding here, so the request is expected to be the last one
 * this page ever makes: a dropped connection after a 200 is the update working, not failing.
 */
$('updateConfirm').onclick = async () => {
  $('updateConfirm').disabled = true;
  $('updateHint').textContent = 'Downloading...';
  try {
    const d = await postJson('/api/update/apply', {}, 'the update failed');
    $('updateHint').textContent = `${d.message} If it does not come back, start it yourself.`;
  } catch (err) {
    $('updateHint').textContent = err.message;
    $('updateConfirm').disabled = false;
  }
};

/* ------------------------------------------------------------------ share */

/*
 * Two ways to hand this profile to someone else.
 *
 * 1. A standalone .html file. One file, opens anywhere, needs neither this app nor a
 *    network. It is built from the *live page* rather than re-rendered on the server, so
 *    it captures exactly what is on screen -- the section order, the medals, everything --
 *    and cannot drift from it.
 * 2. A PNG, rendered by a browser that is already installed.
 *
 * The live page is never served to anyone else: it can reset and delete profiles, and none
 * of that asks who is calling.
 */

/** Elements that only make sense while you are using the page, not while reading it. */
const EXPORT_STRIP = [
  '#optionsBtn', '.menu-wrap', '#toggle', '.backdrop', '#playMenu', '#toast',
  '#identityFile', '.section-order', '.play-detail__menu', '.play-detail__grip',
  '#aboutEdit', '#medalTooltip', '#beatmapsPopup', '[data-unfavorite]', '[data-audio-play]',
  '.beatmapset-panel__play-progress', '.audio-player-floating', '#indexNotice', 'script',
];

/**
 * `?export=1` is the same page with its controls hidden. The screenshot endpoint loads it,
 * and so does anyone who just wants to look without the affordances getting in the way.
 */
function applyExportMode() {
  if (new URLSearchParams(location.search).get('export') !== '1') return;
  document.body.classList.add('export-mode');
}

/** Read a same-origin file as text, for inlining. */
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  return r.text();
}

/** Read a same-origin image as a data: URI, so the export needs nothing from this app. */
async function fetchDataUri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read ${url}`);
  const blob = await r.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`could not encode ${url}`));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build a single self-contained HTML file from the page as it stands.
 *
 * Local images become data: URIs; osu!'s own cover art and medal icons stay as the absolute
 * URLs they already are, so the file is small and shows them to anyone with a connection,
 * and degrades to the drawn placeholders without one. Nothing same-origin is left behind,
 * so no part of the file depends on this app still running.
 */
async function buildStandaloneHtml() {
  const clone = document.documentElement.cloneNode(true);

  for (const selector of EXPORT_STRIP) {
    for (const el of clone.querySelectorAll(selector)) el.remove();
  }
  /*
   * The editor is gone, so the text it was editing must not be left hidden with it -- and
   * an empty description has nothing to say to a reader, so its whole section goes, tab and
   * all. "Click to write something" is an instruction to the owner, not to whoever opens
   * the file.
   */
  const about = clone.querySelector('#aboutView');
  if (about) about.hidden = false;
  if (about?.classList.contains('about--empty')) {
    clone.querySelector('#section-me')?.remove();
    clone.querySelector('#sectionTabs a[href="#section-me"]')?.remove();
  }

  // Stylesheets become one inline <style>, in the order they were linked.
  const hrefs = [...clone.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
  for (const el of clone.querySelectorAll('link[rel="stylesheet"]')) el.remove();
  const css = await Promise.all(hrefs.map((href) => fetchText(href)));

  const style = document.createElement('style');
  style.textContent = [
    ...css,
    // The exported file is a document, not an app: nothing in it is interactive.
    '.section-order, .play-detail__menu, .play-detail__grip { display: none !important; }',
    '.about { cursor: default; } .about:hover { background: none; }',
    '.profile-info__avatar::after { display: none; } .profile-info__name { cursor: default; }',
  ].join('\n');
  clone.querySelector('head').append(style);

  /*
   * The file has no script, so there is no medal card in it. A native title carries what the
   * card would have said, which is the next best thing for a document.
   */
  for (const badge of clone.querySelectorAll('[data-medal]')) {
    const medal = medalFor(badge.dataset.medal);
    if (!medal) continue;
    const when = medal.achievedAt === null ? 'Locked' : medal.dated ? `Achieved on ${shortDate(medal.achievedAt)}` : 'Achieved';
    badge.title = `${medal.name}\n${medal.description}\n${when}`;
    badge.removeAttribute('tabindex');
  }

  // Anything served by this app has to be carried, or the file breaks the moment it moves.
  for (const link of clone.querySelectorAll('link[rel="icon"]')) {
    try {
      link.href = await fetchDataUri(link.getAttribute('href'));
    } catch {
      link.remove();
    }
  }
  for (const img of clone.querySelectorAll('img[src^="/"], img[src^="./"]')) {
    try {
      img.src = await fetchDataUri(img.getAttribute('src'));
    } catch {
      img.remove();
    }
  }
  const cover = clone.querySelector('#cover');
  if (cover && profile?.hasCover) {
    try {
      cover.style.setProperty('--cover', `url('${await fetchDataUri('/api/image/cover')}')`);
    } catch {
      cover.style.setProperty('--cover', 'none');
    }
  }

  const when = new Date().toLocaleString();
  return `<!doctype html>
<!-- osu! local profiles - "${profile?.name ?? 'profile'}" as of ${when}. Not an osu! page. -->
${clone.outerHTML}`;
}

/** Hand the browser a file to save, without going near the server. */
const safeName = () =>
  `${(profile?.name ?? 'profile').replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;

const shareHint = (message, isError) => hint('shareHint', message, isError);

function openShare() {
  setMenuOpen(false);
  shareHint(' ');

  $('shareScreenshot').disabled = !sharing.canScreenshot;
  $('shareScreenshotNote').textContent = sharing.canScreenshot
    ? 'Rendered by the Chrome or Edge already on this machine.'
    : 'Needs Chrome, Edge or Chromium installed. The web page above needs nothing.';

  $('shareModal').hidden = false;
  $('shareClose').focus();
}

const closeShare = () => { $('shareModal').hidden = true; };

$('optShare').onclick = openShare;
$('shareClose').onclick = closeShare;
$('shareModal').onclick = (e) => {
  if (e.target === $('shareModal')) closeShare();
};

$('shareHtml').onclick = async () => {
  $('shareHtml').disabled = true;
  shareHint('Building the page...');
  try {
    const html = await buildStandaloneHtml();
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeName()}.html`);
    shareHint('Saved. That file opens on its own, with or without a connection.');
  } catch (err) {
    shareHint(err.message, true);
  } finally {
    $('shareHtml').disabled = false;
  }
};

$('shareScreenshot').onclick = async () => {
  $('shareScreenshot').disabled = true;
  shareHint('Rendering the image...');
  try {
    const r = await fetch('/api/screenshot');
    if (!r.ok) throw new Error(((await r.json()).error) ?? 'rendering failed');
    downloadBlob(await r.blob(), `${safeName()}.png`);
    shareHint('Saved.');
  } catch (err) {
    shareHint(err.message, true);
  } finally {
    $('shareScreenshot').disabled = false;
  }
};

/* --------------------------------------------------------- section order */

/*
 * Rearranging the profile, the way osu! lets you rearrange your own.
 *
 * The order is a list of section ids in settings, reconciled against SECTIONS on every
 * read: ids that no longer exist are dropped, and a new one joins after the section it
 * follows by default (`reconcileSectionOrder`). That is what makes adding a section later
 * safe -- a saved order from before it existed still works, with the new section where it
 * would have been rather than missing.
 */

const DEFAULT_ORDER = SECTIONS.map(([id]) => id);

/** Earlier versions' defaults: a page saved exactly as one of these was never rearranged. */
const RETIRED_DEFAULT_ORDERS = [
  ['me', 'recent', 'top_ranks', 'medals', 'historical'], // 1.1.0 - 1.6.0
  ['me', 'recent', 'top_ranks', 'historical', 'beatmaps', 'medals'], // 1.7.0 - 1.9.0
];

const reconcileOrder = (saved) => reconcileSectionOrder(saved, DEFAULT_ORDER, RETIRED_DEFAULT_ORDERS);

function currentOrder() {
  return reconcileOrder(settings.sectionOrder);
}

function sectionLabel(id) {
  return SECTIONS.find(([sectionId]) => sectionId === id)?.[1] ?? id;
}

/**
 * The controls that live in each section's heading.
 *
 * The grip is a convenience. Move up and move down are the real interface: they work from
 * the keyboard, they work on a touchscreen, and they cannot half-succeed the way a drag can.
 */
function sectionControls(id, index, total) {
  const first = index === 0;
  const last = index === total - 1;
  return `<span class="section-order">
    <span class="section-order__grip" data-grip="${id}" aria-hidden="true"
          title="Drag to move this section">&#8942;&#8942;</span>
    <button type="button" class="section-order__move" data-move="up" data-section="${id}"
            ${first ? 'disabled' : ''} aria-label="Move ${escapeHtml(sectionLabel(id))} up"
            title="Move up">&#9650;</button>
    <button type="button" class="section-order__move" data-move="down" data-section="${id}"
            ${last ? 'disabled' : ''} aria-label="Move ${escapeHtml(sectionLabel(id))} down"
            title="Move down">&#9660;</button>
  </span>`;
}

/** Put the sections and the tab bar in the saved order, and (re)draw their controls. */
function applySectionOrder() {
  const order = currentOrder();
  const main = document.querySelector('.user-profile-pages');

  order.forEach((id, index) => {
    const section = $(`section-${id}`);
    if (!section) return;
    // appendChild moves an existing node, so this ends up as exactly the wanted order.
    main.appendChild(section);

    // Placed on the section rather than inside the heading: `.title` is `width: max-content`
    // so that its underline hugs the text, and anything added inside it drags that rule out
    // under the controls.
    section.querySelector(':scope > .section-order')?.remove();
    section.insertAdjacentHTML('afterbegin', sectionControls(id, index, order.length));
  });

  $('sectionTabs').innerHTML = order
    .map((id) => `<a class="page-mode__item" href="#section-${id}">${escapeHtml(sectionLabel(id))}</a>`)
    .join('');
}

async function saveSectionOrder(order) {
  settings = { ...settings, sectionOrder: order };
  applySectionOrder();
  try {
    const d = await postJson('/api/settings', { sectionOrder: order }, 'saving the order failed');
    settings = d.settings;
  } catch (err) {
    toast(err.message);
    // Put back what the server actually has, rather than leaving the page lying.
    await loadState();
    applySectionOrder();
  }
}

function moveSection(id, delta) {
  const order = currentOrder();
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, ...order.splice(from, 1));
  void saveSectionOrder(order);
}

/*
 * Lengthen a paged section: five rows to twenty-five, then twenty-five at a time.
 *
 * The button is disabled while the request is in flight rather than removed, so the page
 * does not jump under a cursor that is about to press it again.
 */
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-show-more]');
  if (!button || button.disabled) return;

  const section = button.dataset.showMore;
  if (!PAGED.includes(section)) return;

  const step = pageStep(section);
  shown[section] = shown[section] < step ? step : shown[section] + step;
  button.disabled = true;
  await loadProfile();
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-move]');
  if (!button || button.disabled) return;
  moveSection(button.dataset.section, button.dataset.move === 'up' ? -1 : 1);
  // Keep the focus on the control that was pressed, which has just been re-rendered.
  const again = document.querySelector(
    `[data-move="${button.dataset.move}"][data-section="${button.dataset.section}"]`,
  );
  (again?.disabled ? document.querySelector(`[data-section="${button.dataset.section}"]`) : again)?.focus();
});

/*
 * Dragging. `draggable` is turned on only while the grip is held: setting it permanently on
 * a section makes selecting the text inside it start a drag instead.
 */
let draggingSection = null;

document.addEventListener('mousedown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  $(`section-${grip.dataset.grip}`).draggable = true;
});

document.addEventListener('dragstart', (e) => {
  const section = e.target.closest('.page-extra[draggable="true"]');
  if (!section) return;
  draggingSection = section.id.replace('section-', '');
  section.classList.add('page-extra--dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingSection);
});

document.addEventListener('dragover', (e) => {
  if (draggingSection === null) return;
  const over = e.target.closest('.page-extra');
  if (!over) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', (e) => {
  if (draggingSection === null) return;
  const over = e.target.closest('.page-extra');
  const moved = draggingSection;
  draggingSection = null;
  if (!over) return;
  e.preventDefault();

  const order = currentOrder();
  const from = order.indexOf(moved);
  const to = order.indexOf(over.id.replace('section-', ''));
  if (from < 0 || to < 0 || from === to) return;
  order.splice(to, 0, ...order.splice(from, 1));
  void saveSectionOrder(order);
});

document.addEventListener('dragend', () => {
  draggingSection = null;
  for (const el of document.querySelectorAll('.page-extra')) {
    el.draggable = false;
    el.classList.remove('page-extra--dragging');
  }
});

/* ------------------------------------------------------------------- me! */

/*
 * The profile's own description, click to edit.
 *
 * Stored and rendered as **plain text**. osu! itself accepts BBCode, but a local profile
 * gains nothing from an HTML sanitiser it would have to get exactly right, and everything
 * to lose by getting it wrong. So: escape everything, keep the line breaks, and turn bare
 * URLs into links. That is the whole feature.
 */

let editingAbout = false;

function renderAbout() {
  const text = settings.aboutMe ?? '';
  $('aboutView').innerHTML = text
    ? aboutHtml(text)
    : '<div class="about__empty">Nothing here yet. Click to write something.</div>';
  $('aboutView').classList.toggle('about--empty', !text);
  $('aboutView').title = editingAbout ? '' : 'Click to edit';
}

function openAboutEditor() {
  if (editingAbout) return;
  editingAbout = true;
  $('aboutText').value = settings.aboutMe ?? '';
  updateAboutCount();
  $('aboutView').hidden = true;
  $('aboutEdit').hidden = false;
  $('aboutText').focus();
}

function closeAboutEditor() {
  editingAbout = false;
  $('aboutEdit').hidden = true;
  $('aboutView').hidden = false;
  renderAbout();
}

function updateAboutCount() {
  const used = $('aboutText').value.length;
  // Only worth mentioning as the limit gets close; a counter on an empty box is noise.
  $('aboutCount').textContent = used > 3000 ? `${fmt(4000 - used)} characters left` : '';
}

$('aboutView').onclick = openAboutEditor;
$('aboutText').oninput = updateAboutCount;
$('aboutCancel').onclick = closeAboutEditor;

$('aboutText').onkeydown = (e) => {
  // Escape leaves without saving; the page-wide Escape handler must not also fire.
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeAboutEditor();
  }
};

$('aboutSave').onclick = async () => {
  $('aboutSave').disabled = true;
  try {
    const d = await postJson('/api/settings', { aboutMe: $('aboutText').value }, 'saving failed');
    settings = d.settings;
    closeAboutEditor();
    toast('Saved');
  } catch (err) {
    toast(err.message);
  } finally {
    $('aboutSave').disabled = false;
  }
};

/* ---------------------------------------------------------------- identity */

/*
 * The profile's name, picture and banner, and the optional osu! account they can be
 * borrowed from.
 *
 * Four sources, in the order they cost the user anything: what osu! is signed in as (read
 * from its own config file, no network), a looked-up account, a file from disk, or nothing
 * at all -- which is the default, and draws an avatar from the profile's name.
 */

let identitySuggestions = { sessions: [], linked: null };
/** Which image an "Upload..." press is choosing a file for. */
let uploadKind = null;

const identityHint = (message, isError) => hint('identityHint', message, isError);
const identityAction = (payload) => postJson('/api/identity', payload);

/** Cache-busted, because the file behind these URLs is replaced in place. */
function renderIdentityPreviews() {
  const stamp = Date.now();
  $('identityAvatar').innerHTML = profile?.hasAvatar
    ? `<img src="/api/image/avatar?v=${stamp}" alt="">`
    : generatedAvatar(profile?.name ?? '');
  $('identityCover').style.backgroundImage = profile?.hasCover
    ? `url('/api/image/cover?v=${stamp}')`
    : 'none';
  $('identityCover').classList.toggle('identity-image__preview--empty', !profile?.hasCover);

  for (const kind of ['avatar', 'cover']) {
    const has = kind === 'avatar' ? profile?.hasAvatar : profile?.hasCover;
    $('identityModal').querySelector(`[data-clear="${kind}"]`).disabled = !has;
  }
}

/** The osu! account this profile is linked to, if any. Importing has a dialog of its own. */
function renderIdentitySuggestions() {
  const bits = [];
  if (identitySuggestions.linked) {
    bits.push(
      `<div class="identity-linked">
         Linked to <b>${escapeHtml(identitySuggestions.linked.username)}</b>
         (#${fmt(identitySuggestions.linked.id)})
         <button type="button" id="identityUnlink">Unlink</button>
       </div>`,
    );
  }
  $('identityFound').innerHTML = bits.join('');
}

async function openIdentity() {
  setMenuOpen(false);
  $('identityProfileName').textContent = profile?.name ?? 'this profile';
  $('identityName').value = profile?.name ?? '';
  identityHint(' ');
  renderIdentityPreviews();
  $('identityFound').innerHTML = '';
  $('identityModal').hidden = false;
  $('identityClose').focus();

  try {
    identitySuggestions = await identityAction({ action: 'suggestions' });
    // Only render if the dialog is still open: reading osu!'s config is cheap but not free.
    if (!$('identityModal').hidden) renderIdentitySuggestions();
  } catch {
    /* suggestions are a convenience; typing a name always works */
  }
}

const closeIdentity = () => {
  $('identityModal').hidden = true;
};

$('optIdentity').onclick = openIdentity;
$('identityClose').onclick = closeIdentity;
$('identityModal').onclick = (e) => {
  if (e.target === $('identityModal')) closeIdentity();
};
$('avatar').onclick = openIdentity;
$('pname').onclick = openIdentity;
$('pname').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openIdentity();
  }
};

/* Renaming here is the same operation the Profiles dialog performs. */
$('identitySave').onclick = async () => {
  const name = $('identityName').value.trim();
  if (!name) {
    identityHint('Give the profile a name.', true);
    return;
  }
  if (name === profile?.name) {
    identityHint('That is already its name.');
    return;
  }
  try {
    await profileAction({ action: 'rename', id: profile.id, name });
    await loadState();
    $('identityProfileName').textContent = name;
    renderIdentityPreviews();
    toast(`Renamed to "${name}"`);
    identityHint(' ');
  } catch (err) {
    identityHint(err.message, true);
  }
};

$('identityName').onkeydown = (e) => {
  if (e.key === 'Enter') $('identitySave').click();
};

/* --- images ------------------------------------------------------------- */

$('identityModal').addEventListener('click', async (e) => {
  const upload = e.target.closest('[data-upload]');
  if (upload) {
    uploadKind = upload.dataset.upload;
    $('identityFile').value = '';
    $('identityFile').click();
    return;
  }

  const clear = e.target.closest('[data-clear]');
  if (clear) {
    try {
      await identityAction({ action: 'clear-image', kind: clear.dataset.clear });
      await loadState();
      renderIdentityPreviews();
      await loadProfile();
      identityHint('Removed.');
    } catch (err) {
      identityHint(err.message, true);
    }
    return;
  }

  if (e.target.id === 'identityUnlink') {
    try {
      await identityAction({ action: 'unlink' });
      identitySuggestions.linked = null;
      renderIdentitySuggestions();
      identityHint('Unlinked. The picture and banner already copied here are kept.');
    } catch (err) {
      identityHint(err.message, true);
    }
  }
});

/*
 * The file goes up as a raw PUT rather than a multipart form: there is one file and no
 * other fields, so multipart would only mean writing a parser for a body we already have.
 * The server sniffs the bytes -- the type the browser reports is not evidence.
 */
$('identityFile').onchange = async () => {
  const file = $('identityFile').files?.[0];
  const kind = uploadKind;
  if (!file || !kind) return;

  identityHint(`Uploading ${file.name}...`);
  try {
    const r = await fetch(`/api/image/${kind}`, { method: 'PUT', body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'upload failed');
    await loadState();
    renderIdentityPreviews();
    await loadProfile();
    identityHint('Saved.');
  } catch (err) {
    identityHint(err.message, true);
  }
};

/* --- importing from an osu! account ------------------------------------ */

$('identityImport').onclick = () => {
  closeIdentity();
  void openImport();
};

/*
 * Options -> Import from osu!: look an account up, then copy what was chosen from it. Never a
 * prompt at start-up, at the user's request -- nothing happens until a button is pressed.
 * Avatar, banner, flag and me! are ticked by default; favorites are not, because they add
 * to a list rather than replacing one thing.
 */
const IMPORT_DEFAULTS = { avatar: true, cover: true, country: true, aboutMe: true, favorites: false };
const IMPORT_FAVORITES_ONLY = { avatar: false, cover: false, country: false, aboutMe: false, favorites: true };

const importHint = (message, isError) => hint('importHint', message, isError);
/** The account the last Look up found, so Import copies from exactly that one. */
let importUser = null;

function importChoices() {
  const out = {};
  for (const box of $('importModal').querySelectorAll('[data-import]')) out[box.dataset.import] = box.checked;
  return out;
}

/** What pressing Import would do that is worth knowing first. */
function renderImportNote() {
  const choices = importChoices();
  const notes = [];
  if (choices.aboutMe && (settings.aboutMe ?? '').trim()) {
    notes.push("me! replaces what this profile's me! says now.");
  }
  if (choices.favorites) {
    notes.push(
      app.config?.sharedFavorites === false
        ? "Favorites are added to this profile's list."
        : 'Favorites are added to the list every profile shares.',
    );
  }
  $('importNote').textContent = notes.join(' ');
  $('importGo').disabled = !Object.values(choices).some(Boolean);
}

const joinList = (items) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

async function openImport({ favoritesOnly = false } = {}) {
  setMenuOpen(false);
  const choices = favoritesOnly ? IMPORT_FAVORITES_ONLY : IMPORT_DEFAULTS;
  for (const box of $('importModal').querySelectorAll('[data-import]')) box.checked = choices[box.dataset.import];
  $('importProfileName').textContent = profile?.name ?? 'this profile';
  importUser = null;
  $('importFound').innerHTML = '';
  importHint(' ');
  renderImportNote();
  $('importModal').hidden = false;
  $('importQuery').focus();

  // The linked account, or the one osu! is signed in as: neither costs a request.
  try {
    const found = await identityAction({ action: 'suggestions' });
    if ($('importModal').hidden) return;
    if (found.linked && !$('importQuery').value) $('importQuery').value = found.linked.username;
    $('importFound').innerHTML = (found.sessions ?? [])
      .filter((session) => session.username !== found.linked?.username)
      .map(
        (session) => `<button type="button" class="identity-suggestion" data-query="${escapeHtml(session.username)}">
           Use <b>${escapeHtml(session.username)}</b>
           <span>signed in to osu!${escapeHtml(session.client)}</span>
         </button>`,
      )
      .join('');
  } catch {
    /* a convenience; typing a name always works */
  }
}

const closeImport = () => {
  $('importModal').hidden = true;
};

$('optImport').onclick = () => void openImport();
$('importClose').onclick = closeImport;
$('importModal').onclick = (e) => {
  if (e.target === $('importModal')) closeImport();
};
$('importModal').addEventListener('change', (e) => {
  if (e.target.closest('[data-import]')) renderImportNote();
});
$('importFound').addEventListener('click', (e) => {
  const suggestion = e.target.closest('[data-query]');
  if (!suggestion) return;
  $('importQuery').value = suggestion.dataset.query;
  $('importLookup').click();
});
$('importQuery').onkeydown = (e) => {
  if (e.key === 'Enter') $('importLookup').click();
};
$('importQuery').oninput = () => {
  importUser = null;
};

$('importLookup').onclick = async () => {
  const query = $('importQuery').value.trim();
  if (!query) {
    importHint('Type a username, a user id, or a link to a profile.', true);
    return;
  }

  $('importLookup').disabled = true;
  importHint(`Looking up "${query}" on osu.ppy.sh...`);
  try {
    const { user } = await identityAction({ action: 'lookup', query });
    importUser = user;
    // Shown before anything is copied: one press to look, another to import.
    $('importFound').innerHTML = `<div class="identity-candidate">
      <img class="identity-candidate__avatar" src="${escapeHtml(user.avatarUrl ?? '')}" alt="">
      <div class="identity-candidate__detail">
        <b>${escapeHtml(user.username)}</b>
        <span>#${fmt(user.id)}${user.countryCode ? ` &middot; ${escapeHtml(countryName(user.countryCode))}` : ''}
          &middot; ${user.pageRaw ? 'has a me! page' : 'no me! page'}</span>
      </div>
    </div>`;
    importHint('Found. Choose what to copy, then Import.');
  } catch (err) {
    importUser = null;
    $('importFound').innerHTML = '';
    importHint(err.message, true);
  } finally {
    $('importLookup').disabled = false;
  }
};

$('importGo').onclick = async () => {
  const query = importUser ? String(importUser.id) : $('importQuery').value.trim();
  if (!query) {
    importHint('Type the account to import from first.', true);
    return;
  }
  const choices = importChoices();

  $('importGo').disabled = true;
  importHint(choices.favorites ? 'Importing - favorites can take a few seconds...' : 'Importing...');
  try {
    const d = await identityAction({ action: 'import', query, ...choices });
    settings = d.settings;
    await Promise.all([loadState(), loadProfile()]);
    renderAbout();
    const what = d.done.length ? `Imported ${joinList(d.done)} from ${d.user.username}` : `Linked to ${d.user.username}`;
    if (d.failures.length) {
      importHint(`${what}, but ${d.failures.join('; ')}`, true);
    } else {
      closeImport();
      toast(`${what}.`);
    }
  } catch (err) {
    importHint(err.message, true);
  } finally {
    renderImportNote();
  }
};

/* ---------------------------------------------------------------- settings */

const settingsHint = (message, isError) => hint('settingsHint', message, isError);

/** The control for one field. `settings` holds the cleaned values the server handed back. */
function settingControl(f) {
  const id = `set-${f.key}`;
  if (f.type === 'toggle') {
    return `<input type="checkbox" id="${id}"${settings[f.key] ? ' checked' : ''}>`;
  }
  if (f.type === 'checkboxes') {
    const chosen = new Set(settings[f.key] ?? []);
    return `<div class="checkgroup" id="${id}">${f.options
      .map(
        ([value, label]) =>
          `<label class="checkgroup__item">
            <input type="checkbox" value="${escapeHtml(value)}"${chosen.has(value) ? ' checked' : ''}>
            <span>${escapeHtml(label)}</span>
          </label>`,
      )
      .join('')}</div>`;
  }
  if (f.type === 'choice') {
    return `<select id="${id}">${f.options
      .map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}"${
            settings[f.key] === value ? ' selected' : ''
          }>${escapeHtml(label)}</option>`,
      )
      .join('')}</select>`;
  }
  return `<input type="text" id="${id}" value="${escapeHtml(String(settings[f.key] ?? ''))}"
      maxlength="${f.maxlength}" placeholder="${escapeHtml(f.placeholder ?? '')}">`;
}

function readSettingControl(f) {
  const el = $(`set-${f.key}`);
  if (f.type === 'toggle') return el.checked;
  if (f.type === 'checkboxes') {
    return [...el.querySelectorAll('input:checked')].map((i) => i.value);
  }
  return el.value;
}

/**
 * A field whose `dependsOn` toggle is off is dimmed rather than hidden: it still explains
 * what turning the toggle on would do, which is most of why someone opens this dialog.
 */
function applySettingDependencies() {
  for (const f of SETTINGS_FIELDS) {
    if (!f.dependsOn) continue;
    const enabled = Boolean($(`set-${f.dependsOn}`)?.checked);
    const el = $(`set-${f.key}`);
    el.disabled = !enabled;
    el.closest('.setting').classList.toggle('setting--inactive', !enabled);
  }
}

function renderSettingsFields() {
  $('settingsFields').innerHTML = SETTINGS_FIELDS.map(
    (f) => `<div class="setting">
      <label class="field${f.type === 'checkboxes' ? ' field--stacked' : ''}">
        <span>${escapeHtml(f.label)}</span>
        ${settingControl(f)}
      </label>
      <div class="setting__hint">${escapeHtml(f.hint ?? '')}</div>
    </div>`,
  ).join('');

  applySettingDependencies();
  $('settingsFields').onchange = applySettingDependencies;
}

/**
 * The list of scores removed from the profile, so a removal can be undone.
 *
 * Fetched when the dialog opens rather than carried in /api/state: it is usually empty, and
 * a profile that has removed a hundred scores should not send them with every poll.
 */
async function renderRemovedScores() {
  const panel = $('removedScores');
  panel.hidden = hiddenScoreCount === 0;
  if (panel.hidden) return;

  $('removedCount').textContent = fmt(hiddenScoreCount);
  $('removedList').innerHTML = '<div class="setting__hint">Loading...</div>';

  try {
    const d = await scoreAction({ action: 'list-hidden' });
    $('removedList').innerHTML = d.hidden
      .map(
        (h) => `<div class="removed-row">
          <div class="removed-row__detail">
            <div class="u-ellipsis">${escapeHtml(h.title)}${
              h.version ? ` <span class="removed-row__version">[${escapeHtml(h.version)}]</span>` : ''
            }</div>
            <div class="removed-row__meta">
              ${escapeHtml(h.grade)} &middot; ${pct(h.accuracy)} &middot;
              ${escapeHtml(h.modsLabel)}${h.pp != null ? ` &middot; ${fmt(h.pp, 0)}pp` : ''}
            </div>
          </div>
          <button type="button" data-restore="${h.id}">Put back</button>
          <button type="button" class="removed-row__delete" data-delete="${h.id}"
                  title="Delete permanently" aria-label="Delete permanently">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="2" rx="1" fill="currentColor"/></svg>
          </button>
        </div>`,
      )
      .join('');
  } catch (err) {
    $('removedList').innerHTML = `<div class="setting__hint">${escapeHtml(err.message)}</div>`;
  }
}

/**
 * Deleting cannot be undone, so it takes a second press: the first turns the button into
 * the question, and it goes back after a few seconds if the answer never comes. Nothing
 * blocks the page the way a confirm() box would.
 */
function armed(button, question) {
  if (button.dataset.armed === '1') return true;
  button.dataset.armed = '1';
  button.dataset.label = button.innerHTML;
  button.classList.add('is-armed');
  button.textContent = question;
  setTimeout(() => {
    if (!button.isConnected || button.dataset.armed !== '1') return;
    button.dataset.armed = '0';
    button.classList.remove('is-armed');
    button.innerHTML = button.dataset.label;
  }, 4000);
  return false;
}

async function deleteRemoved(payload, button) {
  button.disabled = true;
  try {
    const d = await scoreAction(payload);
    toast(d.deleted === 1 ? 'Score deleted permanently' : `${fmt(d.deleted)} scores deleted permanently`);
    await Promise.all([loadState(), loadProfile()]);
    await renderRemovedScores();
  } catch (err) {
    settingsHint(err.message, true);
    button.disabled = false;
  }
}

$('removedDeleteAll').onclick = () => {
  const button = $('removedDeleteAll');
  if (!armed(button, `Delete all ${fmt(hiddenScoreCount)} for good?`)) return;
  void deleteRemoved({ action: 'delete-all-removed' }, button);
};

$('removedList').onclick = async (e) => {
  const doomed = e.target.closest('[data-delete]');
  if (doomed) {
    if (armed(doomed, 'Delete?')) void deleteRemoved({ action: 'delete', id: Number(doomed.dataset.delete) }, doomed);
    return;
  }
  const button = e.target.closest('[data-restore]');
  if (!button) return;
  button.disabled = true;
  try {
    await scoreAction({ action: 'restore', id: Number(button.dataset.restore) });
    toast('Score put back');
    await Promise.all([loadState(), loadProfile()]);
    await renderRemovedScores();
  } catch (err) {
    settingsHint(err.message, true);
    button.disabled = false;
  }
};

function openSettings() {
  setMenuOpen(false);
  void renderRemovedScores();
  $('settingsProfileName').textContent = profile?.name ?? 'this profile';
  renderSettingsFields();
  $('sharedFavorites').checked = app.config?.sharedFavorites !== false;
  settingsHint(' ');
  $('settingsModal').hidden = false;
  $('settingsCancel').focus();
}

const closeSettings = () => { $('settingsModal').hidden = true; };

$('optSettings').onclick = openSettings;
$('settingsCancel').onclick = closeSettings;
$('settingsModal').onclick = (e) => {
  if (e.target === $('settingsModal')) closeSettings();
};

$('settingsSave').onclick = async () => {
  // The whole field set goes up as one patch: the server coerces each value and hands the
  // cleaned result back, which is what gets rendered -- so a rejected country code shows
  // as empty here rather than appearing to have saved.
  const patch = {};
  for (const f of SETTINGS_FIELDS) patch[f.key] = readSettingControl(f);

  $('settingsSave').disabled = true;
  try {
    const d = await postJson('/api/settings', patch, 'saving failed');

    // Only free text can be rejected; a checkbox or a select cannot hold a bad value.
    const rejected = SETTINGS_FIELDS.filter(
      (f) =>
        (f.type ?? 'text') === 'text' &&
        String(patch[f.key]).trim() !== '' &&
        String(d.settings[f.key] ?? '') === '',
    );
    settings = d.settings;

    // Belongs to the install rather than the profile, so it goes to config.json.
    const shareFavorites = $('sharedFavorites').checked;
    if (shareFavorites !== (app.config?.sharedFavorites !== false)) {
      const c = await postJson('/api/app-config', { sharedFavorites: shareFavorites }, 'saving that failed');
      app = { ...app, config: c.config };
    }
    closeSettings();
    // The eligibility settings change every number on the page, not just the header.
    await Promise.all([loadState(), loadProfile()]);
    toast(
      rejected.length
        ? `Saved - ${rejected.map((f) => f.label.toLowerCase()).join(' and ')} was not valid and was cleared`
        : 'Settings saved',
    );
    offerRecompute();
  } catch (err) {
    settingsHint(err.message, true);
  } finally {
    $('settingsSave').disabled = false;
  }
};

/* ------------------------------------------------------------ score actions */

/*
 * Pinning, ordering pins, and removing a score from the profile.
 *
 * Removing never deletes: the replay is still on disk, so a deleted row would come back on
 * the next ingest -- and with its dedupe key gone, it would come back looking new. The
 * server hides it instead, and the Settings dialog can put it back.
 */

let pinnedIds = [];

/* ------------------------------------------------------- favorite beatmaps */

/*
 * Favouriting is the profile's own list, never written to osu!. Adding asks osu.ppy.sh for
 * the set's details once (star ratings, modes, badges); offline the favourite is still kept
 * and its card is drawn from what is on this machine.
 */

/** Every favourited set id, for labelling the row menus. */
let favoriteSetIds = new Set();

async function favoriteAction(action, beatmapsetId) {
  if (!beatmapsetId) return;
  try {
    const d = await postJson('/api/favorites', { action, beatmapsetId });
    favoriteSetIds = new Set(d.favorites);
    toast(
      action === 'remove'
        ? 'Removed from Favorite Beatmaps'
        : d.detailsError
          ? `Added to Favorite Beatmaps - ${d.detailsError}, so it shows what is on this machine for now`
          : 'Added to Favorite Beatmaps',
    );
    await loadProfile();
  } catch (err) {
    toast(err.message);
  }
}

// The heart on a card: unfavourite it, as osu!'s does for your own favourites.
document.addEventListener('click', (e) => {
  const heart = e.target.closest('[data-unfavorite]');
  if (!heart) return;
  e.preventDefault();
  void favoriteAction('remove', Number(heart.dataset.unfavorite));
});

const scoreAction = (payload) => postJson('/api/scores', payload);

function closePlayMenu() {
  $('playMenu').hidden = true;
  $('playMenu').dataset.id = '';
  $('playMenu').dataset.key = '';
}

/** Which row a menu belongs to. Kind and id together: an incomplete play's id can equal a score's. */
const menuKey = (button) => `${button.dataset.kind ?? 'score'}:${button.dataset.id}`;

/**
 * Open the shared popover beside the button that asked for it.
 *
 * Positioned in viewport coordinates and clamped to the right edge, because the row it
 * belongs to is inside a panel that would otherwise clip it.
 *
 * A score row gets everything; an unfinished play has no score, so it offers only the
 * beatmap. Favouriting is offered wherever there is a beatmapset -- a never-submitted map has
 * none, and nothing to show a card for.
 */
function openPlayMenu(button) {
  const menu = $('playMenu');
  const id = Number(button.dataset.id);
  const isScore = (button.dataset.kind ?? 'score') === 'score';
  const pinned = button.dataset.pinned === '1';
  const index = pinnedIds.indexOf(id);
  const setId = Number(button.dataset.set) || null;
  const favourite = setId !== null && favoriteSetIds.has(setId);
  // The score card's own menu: it is already the details, and has the download as a button.
  const inCard = button.dataset.context === 'card';

  menu.dataset.id = String(id);
  menu.dataset.key = menuKey(button);
  menu.dataset.set = setId === null ? '' : String(setId);
  menu.dataset.context = inCard ? 'card' : 'row';
  menu.querySelector('[data-act="pin"]').hidden = !isScore || pinned;
  menu.querySelector('[data-act="unpin"]').hidden = !isScore || !pinned;
  // osu-web's order: pin, View Details, Download Replay -- the last only when the score has
  // a replay, which an unfinished play never does.
  menu.querySelector('[data-act="details"]').hidden = !isScore || inCard;
  menu.querySelector('[data-act="replay"]').hidden = !isScore || inCard || button.dataset.replay !== '1';
  // Sharing the score is the details card's: its link is its own page, and the image is it.
  for (const act of ['copy-link', 'save-image', 'copy-image']) {
    menu.querySelector(`[data-act="${act}"]`).hidden = !inCard;
  }
  // Reordering only means something for a pin that has somewhere to go, in the list itself.
  menu.querySelector('[data-act="move-up"]').hidden = !isScore || inCard || !pinned || index <= 0;
  menu.querySelector('[data-act="move-down"]').hidden =
    !isScore || inCard || !pinned || index < 0 || index >= pinnedIds.length - 1;
  menu.querySelector('[data-act="favorite"]').hidden = setId === null || favourite;
  menu.querySelector('[data-act="unfavorite"]').hidden = setId === null || !favourite;
  menu.querySelector('[data-act="hide"]').hidden = !isScore;
  menu.querySelector('[data-sep="hide"]').hidden = !isScore;

  menu.hidden = false;
  const box = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${box.bottom + 4}px`;
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-play-menu]');
  if (button) {
    e.stopPropagation();
    const open = !$('playMenu').hidden && $('playMenu').dataset.key === menuKey(button);
    closePlayMenu();
    if (!open) openPlayMenu(button);
    return;
  }
  if (!e.target.closest('#playMenu')) closePlayMenu();
});

$('playMenu').onclick = async (e) => {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const id = Number($('playMenu').dataset.id);
  const setId = Number($('playMenu').dataset.set);
  const fromCard = $('playMenu').dataset.context === 'card';
  const act = button.dataset.act;
  closePlayMenu();

  if (act === 'details') {
    void openScoreCard(id);
    return;
  }
  if (act === 'replay') {
    void downloadReplay(id);
    return;
  }
  if (act === 'copy-link') {
    void copyScoreLink(id);
    return;
  }
  if (act === 'save-image') {
    void saveScoreImage(id);
    return;
  }
  if (act === 'copy-image') {
    void copyScoreImage(id);
    return;
  }
  if (act === 'favorite' || act === 'unfavorite') {
    await favoriteAction(act === 'favorite' ? 'add' : 'remove', setId);
    return;
  }

  try {
    if (act === 'move-up' || act === 'move-down') {
      const from = pinnedIds.indexOf(id);
      const to = act === 'move-up' ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= pinnedIds.length) return;
      const next = [...pinnedIds];
      next.splice(to, 0, ...next.splice(from, 1));
      await scoreAction({ action: 'reorder', ids: next });
    } else {
      await scoreAction({ action: act, id });
      if (act === 'hide') toast('Removed from this profile - undo it in Settings');
      if (act === 'pin') toast('Pinned');
    }
    // A removed score has no details left to show; a pinned one's card has to say so.
    if (fromCard) {
      if (act === 'hide') closeScoreCard();
      else void openScoreCard(id);
    }
    await Promise.all([loadProfile(), loadState()]);
  } catch (err) {
    toast(err.message);
  }
};

/* ------------------------------------------------------------ score card */

/*
 * View Details. osu! opens a score in a page of its own; here it is a card over the profile,
 * so closing it leaves the page exactly as it was -- scrolled to the same row, with the same
 * sections expanded. Built by web/js/score-card.js from `/api/scores/<id>`.
 */
let scoreCardId = null;

async function openScoreCard(id) {
  const opening = scoreCardId !== id;
  scoreCardId = id;
  if (opening) {
    $('scoreCard').innerHTML = '<div class="score-modal__loading">Loading&hellip;</div>';
    $('scoreModal').hidden = false;
    $('scoreClose').focus();
  }
  try {
    const r = await fetch(`/api/scores/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'that score could not be loaded');
    // Closed, or another score opened, while this one was on its way.
    if (scoreCardId !== id) return;
    $('scoreCard').innerHTML = scoreCard(d.score, cardOwner(d.owner), d.calculator);
  } catch (err) {
    if (scoreCardId !== id) return;
    closeScoreCard();
    toast(err.message);
  }
}

function closeScoreCard() {
  scoreCardId = null;
  $('scoreModal').hidden = true;
  $('scoreCard').innerHTML = '';
  if (!$('playMenu').hidden && $('playMenu').dataset.context === 'card') closePlayMenu();
}

$('scoreClose').onclick = closeScoreCard;
// A click beside the card -- on the backdrop itself, not anything on it -- closes it.
$('scoreModal').onclick = (e) => {
  if (e.target === $('scoreModal')) closeScoreCard();
};
// The menu is placed in window coordinates, so it cannot follow the card as it scrolls.
$('scoreModal').querySelector('.score-modal').addEventListener('scroll', () => {
  if (!$('playMenu').hidden) closePlayMenu();
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-replay-download]');
  if (!link) return;
  e.preventDefault();
  void downloadReplay(Number(link.dataset.replayDownload));
});

/*
 * Dragging to reorder pins. Native HTML5 drag and drop, no library: the list is short, and
 * the menu's Move up / Move down does the same job for anyone not using a mouse.
 */
let draggingId = null;

$('pinnedPlays').addEventListener('dragstart', (e) => {
  const row = e.target.closest('[data-score-id]');
  if (!row) return;
  draggingId = Number(row.dataset.scoreId);
  row.classList.add('play-detail--dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Firefox will not start a drag without data on the transfer.
  e.dataTransfer.setData('text/plain', row.dataset.scoreId);
});

$('pinnedPlays').addEventListener('dragover', (e) => {
  if (draggingId === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});

$('pinnedPlays').addEventListener('drop', async (e) => {
  if (draggingId === null) return;
  e.preventDefault();
  const target = e.target.closest('[data-score-id]');
  const id = draggingId;
  draggingId = null;

  const from = pinnedIds.indexOf(id);
  const to = target ? pinnedIds.indexOf(Number(target.dataset.scoreId)) : pinnedIds.length - 1;
  if (from < 0 || to < 0 || from === to) {
    await loadProfile();
    return;
  }

  const next = [...pinnedIds];
  next.splice(to, 0, ...next.splice(from, 1));
  try {
    await scoreAction({ action: 'reorder', ids: next });
  } catch (err) {
    toast(err.message);
  }
  await loadProfile();
});

$('pinnedPlays').addEventListener('dragend', () => {
  draggingId = null;
  for (const el of $('pinnedPlays').querySelectorAll('.play-detail--dragging')) {
    el.classList.remove('play-detail--dragging');
  }
});

/* --------------------------------------------------------------- recompute */

/*
 * Scores tracked before the eligibility settings existed were never given a pp value for
 * anything osu! would not rank -- there was no reason to calculate one. So turning a
 * setting on can leave older plays missing from a section they now belong in, which looks
 * like a bug rather than a gap. Offer the fix at the moment it becomes relevant, and only
 * when there is actually something to fix.
 */
let recomputing = false;

function offerRecompute() {
  if (recomputing || staleScores === 0) return;
  if (!settings.includeUnrankedMods) return;

  const n = fmt(staleScores);
  const ok = confirm(
    `${n} tracked play${staleScores === 1 ? '' : 's'} ${
      staleScores === 1 ? 'was' : 'were'
    } recorded before this setting existed, so ${
      staleScores === 1 ? 'it has' : 'they have'
    } no pp for unranked mods yet.\n\n` +
      'Recalculate them from their replay files now?\n\n' +
      'Nothing is deleted. Plays whose replay is no longer on disk are left as they are.',
  );
  if (!ok) return;
  void runRecompute();
}

/*
 * Which osu! release prices this profile's scores. After an update that brings an osu! pp
 * rework, scores priced before it are still on the old algorithm -- ranked and weighted
 * against new ones -- so Settings says how many, and offers to recalculate them all from
 * their replays with the calculator that is running now.
 */
function renderPpCalculator() {
  const v = ppCalculator.version;
  $('footerPp').hidden = $('footerPpSep').hidden = v === null;
  $('footerPp').textContent = v ? `pp: osu! ${v}` : '';
  $('ppCalculatorVersion').textContent = v
    ? `pp is calculated by osu!'s own calculator, from osu! ${v}.`
    : 'The pp calculator is not available, so new scores are tracked with no pp.';
  const n = ppCalculator.outdated;
  $('ppCalculatorOutdated').hidden = !v || n === 0;
  $('ppCalculatorOutdatedText').textContent =
    `${fmt(n)} score${n === 1 ? ' was' : 's were'} priced by a different version of it, or before ` +
    'the version was recorded. Recalculating them from their replays puts every score on the ' +
    'same algorithm; scores whose replay is gone are left as they are.';
}

$('ppRecalculate').onclick = () => {
  closeSettings();
  void runRecompute(true);
};

async function runRecompute(all = false) {
  recomputing = true;
  toast('Recalculating stored scores from their replays...');
  try {
    const d = await postJson('/api/recompute', { confirm: true, all }, 'recompute failed');
    toast(
      `Recalculated ${fmt(d.updated)} play${d.updated === 1 ? '' : 's'}` +
        (d.gainedPp > 0 ? ` - ${fmt(d.gainedPp)} gained a pp value` : '') +
        (d.skipped > 0 ? ` (${fmt(d.skipped)} skipped, no replay or beatmap on disk)` : ''),
    );
  } catch (err) {
    toast(`Recalculating failed: ${err.message}`);
  } finally {
    recomputing = false;
    await Promise.all([loadState(), loadProfile()]);
  }
}

/* ---------------------------------------------------------------- profiles */

let profiles = [];

const profileHint = (message, isError) => hint('profileHint', message, isError);

function renderProfiles() {
  $('profileList').innerHTML = profiles
    .map((p) => {
      const plays = `${fmt(p.scoreCount)} play${p.scoreCount === 1 ? '' : 's'}`;
      const since = new Date(p.trackingSince).toLocaleDateString();
      // The only profile cannot be deleted: the app must always have somewhere to write.
      const canDelete = profiles.length > 1;
      return `<div class="profile-row${p.active ? ' profile-row--active' : ''}">
        <div class="profile-row__name">
          ${escapeHtml(p.name)}
          <div class="profile-row__meta">${plays} &middot; since ${escapeHtml(since)}</div>
        </div>
        <div class="profile-row__actions">
          ${p.active ? '' : `<button type="button" data-act="switch" data-id="${p.id}">Switch to</button>`}
          <button type="button" data-act="rename" data-id="${p.id}">Rename</button>
          <button type="button" class="danger" data-act="delete" data-id="${p.id}"
                  ${canDelete ? '' : 'disabled title="This is the only profile"'}>Delete</button>
        </div>
      </div>`;
    })
    .join('');
}

async function profileAction(payload) {
  const data = await postJson('/api/profiles', payload);
  if (data.profiles) {
    profiles = data.profiles;
    renderProfiles();
  }
  return data;
}

function openProfiles() {
  setMenuOpen(false);
  $('newProfileName').value = '';
  profileHint('A new profile starts empty and tracks from the moment you create it.');
  renderProfiles();
  $('profilesModal').hidden = false;
  $('profilesClose').focus();
}

const closeProfiles = () => { $('profilesModal').hidden = true; };

$('optProfiles').onclick = openProfiles;
$('profilesClose').onclick = closeProfiles;
$('profilesModal').onclick = (e) => {
  if (e.target === $('profilesModal')) closeProfiles();
};

$('profileList').onclick = async (e) => {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const id = Number(button.dataset.id);
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;

  try {
    if (button.dataset.act === 'switch') {
      await profileAction({ action: 'switch', id });
      toast(`Now tracking "${profile.name}"`);
      await Promise.all([loadState(), loadProfile()]);
      profileHint(`Switched to "${profile.name}".`);
      return;
    }

    if (button.dataset.act === 'rename') {
      const name = prompt('Rename this profile to:', profile.name);
      if (name === null || name.trim() === profile.name) return;
      await profileAction({ action: 'rename', id, name });
      await loadState();
      profileHint(`Renamed to "${name.trim()}".`);
      return;
    }

    if (button.dataset.act === 'delete') {
      const warning =
        profile.scoreCount > 0
          ? `Delete "${profile.name}" and its ${profile.scoreCount} tracked play${
              profile.scoreCount === 1 ? '' : 's'
            }?\n\nThis cannot be undone. Your replay files are not touched.`
          : `Delete "${profile.name}"? It has no tracked plays.`;
      if (!confirm(warning)) return;
      const data = await profileAction({ action: 'delete', id, confirm: true });
      toast(`Deleted "${profile.name}" (${fmt(data.deletedScores)} erased)`);
      await Promise.all([loadState(), loadProfile()]);
      profileHint(`Deleted "${profile.name}".`);
    }
  } catch (err) {
    profileHint(err.message, true);
  }
};

$('profileCreate').onclick = async () => {
  const name = $('newProfileName').value.trim();
  if (!name) {
    profileHint('Give the new profile a name first.', true);
    $('newProfileName').focus();
    return;
  }
  try {
    await profileAction({ action: 'create', name });
    $('newProfileName').value = '';
    toast(`Created "${name}" and switched to it`);
    await Promise.all([loadState(), loadProfile()]);
    profileHint(`Created "${name}". It is now the profile being tracked.`);
  } catch (err) {
    profileHint(err.message, true);
  }
};

$('newProfileName').onkeydown = (e) => {
  if (e.key === 'Enter') $('profileCreate').click();
};

/* ------------------------------------------------------- export and backup */

/*
 * Both are plain downloads. Navigating rather than fetching lets the browser handle the
 * save dialog and the filename from content-disposition, and keeps a 20MB database out
 * of the page's memory.
 */
$('optExport').onclick = () => {
  setMenuOpen(false);
  window.location.href = '/api/export';
  toast('Exporting this profile as JSON');
};

$('optBackup').onclick = () => {
  setMenuOpen(false);
  window.location.href = '/api/backup';
  toast('Backing up every profile');
};

/* ------------------------------------------------------ import past plays */

/** `datetime-local` wants a local-time ISO string with no zone suffix. */
function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

const sinceValue = () => new Date($('backfillSince').value).getTime();

/** Any change to the cutoff invalidates the preview, so Import has to be earned again. */
function resetBackfillPreview(message) {
  $('backfillSummary').innerHTML = message;
  $('backfillConfirm').disabled = true;
  $('backfillConfirm').textContent = 'Import';
}

function openBackfill() {
  setMenuOpen(false);
  markPreset(3);
  $('backfillSince').value = toLocalInput(Date.now() - 3 * 3600_000);
  resetBackfillPreview('Pick a time, then check what would be imported.');
  $('backfillModal').hidden = false;
  $('backfillCancel').focus();
}

function closeBackfill() {
  $('backfillModal').hidden = true;
}

function markPreset(hours) {
  for (const b of $('backfillPresets').querySelectorAll('button')) {
    b.classList.toggle('active', Number(b.dataset.hours) === hours);
  }
}

$('optBackfill').onclick = openBackfill;
$('backfillCancel').onclick = closeBackfill;
$('backfillModal').onclick = (e) => {
  if (e.target === $('backfillModal')) closeBackfill();
};

$('backfillPresets').onclick = (e) => {
  const b = e.target.closest('[data-hours]');
  if (!b) return;
  const hours = Number(b.dataset.hours);
  markPreset(hours);
  $('backfillSince').value = toLocalInput(Date.now() - hours * 3600_000);
  resetBackfillPreview('Cutoff changed - check again to see what would be imported.');
};

$('backfillSince').onchange = () => {
  markPreset(null);
  resetBackfillPreview('Cutoff changed - check again to see what would be imported.');
};

$('backfillCheck').onclick = async () => {
  const since = sinceValue();
  if (!Number.isFinite(since)) {
    resetBackfillPreview('That is not a valid date and time.');
    return;
  }

  $('backfillCheck').disabled = true;
  $('backfillSummary').textContent = 'Scanning your osu! folders...';
  try {
    const d = await postJson('/api/backfill/preview', { since }, 'preview failed');

    if (d.importable === 0) {
      resetBackfillPreview(
        d.duplicates > 0
          ? `Nothing new. All ${fmt(d.duplicates)} play${d.duplicates === 1 ? '' : 's'} found since then are already tracked.`
          : `No plays found since then (${fmt(d.scanned)} files checked).`,
      );
      return;
    }

    const span =
      d.earliest && d.latest
        ? ` They run from ${new Date(d.earliest).toLocaleString()} to ${new Date(d.latest).toLocaleString()}.`
        : '';
    const dupes = d.duplicates > 0 ? ` ${fmt(d.duplicates)} already tracked and will be left alone.` : '';
    $('backfillSummary').innerHTML =
      `<b>${fmt(d.importable)} play${d.importable === 1 ? '' : 's'}</b> would be imported.${escapeHtml(span)}${escapeHtml(dupes)}`;
    $('backfillConfirm').disabled = false;
    $('backfillConfirm').textContent = `Import ${fmt(d.importable)}`;
  } catch (err) {
    resetBackfillPreview(`Check failed: ${escapeHtml(err.message)}`);
  } finally {
    $('backfillCheck').disabled = false;
  }
};

$('backfillConfirm').onclick = async () => {
  const since = sinceValue();
  $('backfillConfirm').disabled = true;
  $('backfillCheck').disabled = true;
  $('backfillConfirm').textContent = 'Importing...';
  try {
    const d = await postJson('/api/backfill', { since, confirm: true }, 'import failed');
    toast(`Imported ${fmt(d.imported)} past play${d.imported === 1 ? '' : 's'}`);
    closeBackfill();
    await Promise.all([loadProfile(), loadState()]);
  } catch (err) {
    resetBackfillPreview(`Import failed: ${escapeHtml(err.message)}`);
  } finally {
    $('backfillCheck').disabled = false;
  }
};

/* --------------------------------------------------------- reset profile */

let resetting = false;

function openReset() {
  setMenuOpen(false);
  const plays = stats?.playcount ?? 0;
  $('resetSummary').textContent =
    plays > 0
      ? `${plays} tracked play${plays === 1 ? '' : 's'} will be erased and this profile will start from zero.`
      : 'Nothing has been tracked yet, so this only restarts tracking from now.';
  $('resetModal').hidden = false;
  $('resetCancel').focus();
}

function closeReset() {
  if (resetting) return;
  $('resetModal').hidden = true;
}

$('optReset').onclick = openReset;
$('resetCancel').onclick = closeReset;
// Clicking the dimmed background cancels; clicking inside the dialog does not.
$('resetModal').onclick = (e) => {
  if (e.target === $('resetModal')) closeReset();
};

$('resetConfirm').onclick = async () => {
  if (resetting) return;
  resetting = true;
  $('resetConfirm').disabled = true;
  $('resetCancel').disabled = true;
  $('resetConfirm').textContent = 'Erasing...';
  try {
    const data = await postJson('/api/profile/reset', { confirm: true }, 'reset failed');
    toast(`Profile reset - ${data.deleted} play${data.deleted === 1 ? '' : 's'} erased`);
  } catch (err) {
    toast(`Reset failed: ${err.message}`);
  } finally {
    resetting = false;
    $('resetConfirm').disabled = false;
    $('resetCancel').disabled = false;
    $('resetConfirm').textContent = 'Erase and start fresh';
    $('resetModal').hidden = true;
    await Promise.all([loadProfile(), loadState()]);
  }
};

/* ------------------------------------------------------------------- SSE */

const es = new EventSource('/api/events');
es.addEventListener('score', (e) => {
  const s = JSON.parse(e.data);
  // A play can now carry pp without counting toward the profile. Saying which keeps the
  // toast from reading as "+120pp" when the total underneath it has not moved.
  const counted = s.ranked || (settings.includeUnrankedMods && s.mapRanked);
  const shownPp = counting?.preferStrippedPp && s.ppNomod != null ? s.ppNomod : s.pp;
  const pp = shownPp == null ? '' : `${fmt(shownPp, 0)}pp${counted ? '' : ' (not counted)'}`;
  toast(`${s.grade} ${pct(s.accuracy)} ${pp} - ${s.title}`.replace(/\s+/g, ' '));
  if (s.mode === mode) loadProfile();
  loadState();
});
/*
 * A play that was started and never finished. It moves the play count and the charts, so
 * the page has to reload -- but there is nothing to put in a toast beyond which map it was,
 * and no grade or accuracy, because lazer keeps none of that for a play it discards.
 */
es.addEventListener('incomplete', (e) => {
  const play = JSON.parse(e.data);
  toast(`Didn't finish - ${play.title}`);
  if (play.mode === mode) loadProfile();
  loadState();
});
es.addEventListener('tracking', (e) => setTracking(JSON.parse(e.data).tracking));
es.addEventListener('reset', () => {
  loadProfile();
  loadState();
});
// An import can add dozens of scores at once, so it refreshes the page rather than
// announcing each one the way a live play does.
es.addEventListener('backfill', () => {
  loadProfile();
  loadState();
});
es.addEventListener('profiles', () => {
  loadProfile();
  loadState();
});
// Settings only change the header, but a second tab open on the same profile should not
// be left showing the old country.
es.addEventListener('indexing', (e) => renderIndexing(JSON.parse(e.data)));
es.addEventListener('settings', () => loadState());
es.addEventListener('identity', () => loadState());
// A second tab should not be left showing the switch the wrong way round.
es.addEventListener('app-config', (e) => {
  app = { ...app, config: JSON.parse(e.data) };
  renderOpenBrowser();
});
// Pin, unpin and remove all change what the page should be showing.
// Another tab favouriting or unfavouriting changes this one's cards and menus.
es.addEventListener('favorites', () => loadProfile());
es.addEventListener('scores', () => {
  loadProfile();
  loadState();
});
// A recompute can run for a while on a large profile; report progress rather than looking
// frozen. The final `recompute` event is handled by whoever started it.
es.addEventListener('recompute-progress', (e) => {
  const p = JSON.parse(e.data);
  if (p.percent < 100) toast(`Recalculating stored scores... ${p.percent}%`);
});

/* ------------------------------------------------------------------ boot */

applyExportMode();
await loadState();
applySectionOrder();
await loadProfile();
// Tells the screenshot renderer the page has finished drawing itself.
document.body.dataset.rendered = 'true';

setInterval(loadState, 15000);
