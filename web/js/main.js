/**
 * Page controller: fetches state, renders, and keeps up with live scores over SSE.
 *
 * There is no framework here on purpose (see docs/phase-2-handoff.md). Every update is a
 * refetch followed by a re-render of the affected block, which is plenty for a page that
 * changes once every few minutes when a play lands.
 */
import { assetUrl, isStatic, snapshot } from './static-mode.js';
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
  guestAvatar,
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
import {
  DEFAULT_LOCALE,
  availableLocales,
  currentLocale,
  knownLocale,
  matchLocale,
  storedLocale,
  t,
  useLocale,
} from './i18n.js';
import {
  bindLanguagePicker,
  chooseLanguage,
  chooseOriginalMetadata,
  refreshLanguageButton,
} from './language-picker.js';
import { original, preferOriginalMetadata, setPreferOriginalMetadata } from './metadata.js';
import { bindOsuFolders, closeOsuFolders, openOsuFolders, osuFoldersOpen } from './osu-folders.js';
import { bbcodeHtml } from './bbcode.js';
import { buildInteractiveHtml } from './share-copy.js';
import { renderMedals } from './medals.js';
import { setPopupCards } from './beatmaps-popup.js';
import {
  closeTrackingFilter,
  openTrackingFilter,
  resetTrackingFilter,
  saveTrackingFilter,
  trackingFilterOpen,
} from './tracking-filter.js';
import { syncPlayers } from './audio-player.js';
import {
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
  ['me', () => t('section.me')],
  ['recent_plays', () => t('section.recentPlays')],
  // The id is kept from when osu! called this Top Ranks: saved section orders refer to it.
  ['top_ranks', () => t('section.scores')],
  ['historical', () => t('section.historical')],
  // The id is kept from when this was called Recent: saved section orders refer to it.
  ['recent', () => t('section.milestones')],
  ['beatmaps', () => t('section.beatmaps')],
  // Last by default, at the user's request.
  ['medals', () => t('section.medals')],
];

/* The five grades osu! counts on a profile. XH/X and SH/S are the silver variants. */
const GRADE_ORDER = ['XH', 'X', 'SH', 'S', 'A'];

/**
 * The Other settings dialog is generated from this list, so adding a setting is one entry here
 * plus one entry in `DEFS` in src/settings.ts. `key` matches the setting name exactly --
 * the dialog posts the whole field set as a patch and the server ignores anything it does
 * not recognise.
 */
const SETTINGS_FIELDS = [
  {
    key: 'includeUnrankedMods',
    type: 'toggle',
    label: () => t('setting.unrankedMods'),
    hint: () =>
      t('setting.unrankedModsHint'),
  },
  {
    key: 'showCountingNote',
    type: 'toggle',
    label: () => t('setting.warnIncomparable'),
    hint: () =>
      t('setting.warnIncomparableHint'),
  },
  {
    key: 'unrankedModPp',
    type: 'choice',
    label: () => t('setting.priceRelax'),
    dependsOn: 'includeUnrankedMods',
    options: [
      ['without-the-mod', () => t('setting.asIfModOff')],
      ['as-played', () => t('setting.asOsuScores')],
    ],
    hint: () =>
      t('setting.priceRelaxHint'),
  },
  {
    key: 'showIncompleteInRecent',
    type: 'choice',
    label: () => t('setting.unfinishedPlays'),
    options: [
      ['collapse', () => t('setting.groupRetries')],
      ['yes', () => t('setting.showEveryAttempt')],
      ['no', () => t('setting.hideThem')],
    ],
    hint: () =>
      t('setting.unfinishedPlaysHint'),
  },
  {
    key: 'countUnsubmittedAttempts',
    type: 'toggle',
    label: () => t('setting.countUnsubmitted'),
    // A function, so it can say how many have been recorded before anyone decides to count them.
    hint: () =>
      t('setting.countUnsubmittedHint') +
      (unsubmittedAttempts > 0
        ? t('setting.countUnsubmittedSoFar', { n: fmt(unsubmittedAttempts) })
        : t('setting.countUnsubmittedNone')),
  },
  {
    key: 'importPlaysWhileClosed',
    type: 'toggle',
    label: () => t('setting.importWhileClosed'),
    hint: () => t('setting.importWhileClosedHint'),
  },
  {
    key: 'includeUnrankedMaps',
    type: 'checkboxes',
    label: () => t('setting.unrankedMaps'),
    // Roughly osu!'s own ordering, most-established first.
    options: [
      ['loved', () => t('status.loved')],
      ['qualified', () => t('status.qualified')],
      ['pending', () => t('status.pending')],
      ['wip', () => t('filter.workInProgress')],
      ['graveyard', () => t('filter.graveyarded')],
      ['unsubmitted', () => t('filter.neverSubmitted')],
    ],
    hint: () =>
      t('setting.unrankedMapsHint'),
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
/** A brand-new install's one-time offer to import from an osu! account (src/welcome.ts). */
let welcomeOffered = false;
/** Which osu! release prices scores, and how many of this profile's another one priced. */
let ppCalculator = { version: null, outdated: 0 };
let hiddenScoreCount = 0;
/** Whether the play tracking filter can turn a play away, and how many it has. */
let filterNarrowing = false;
let playsFiltered = 0;
/** Attempts osu! could not submit that this profile has recorded, counted or not. */
let unsubmittedAttempts = 0;
/** Which clients were found, so the page can say how the one being watched behaves. */
let installKinds = [];
let sharing = { canScreenshot: false };

/* ---------------------------------------------------------------- header */

function renderIdentity() {
  if (!profile) return;

  $('pname').textContent = profile.name;

  $('avatar').innerHTML = profile.hasAvatar
    ? `<img src="${assetUrl('/api/image/avatar')}" alt="${escapeHtml(profile.name)}">`
    : guestAvatar(profile.name);

  const bits = [];
  if (profile.country) {
    const code = profile.country.toUpperCase();
    const name = countryName(code);
    // The flag is a background image on a span, as it is on osu!: the sheen overlay in
    // `.flag-country::after` inherits it. A code we have no flag for renders nothing and
    // leaves the name beside it, which is still the whole answer.
    bits.push(`<span class="profile-info__flag">
      <span class="flag-country" role="img" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}"
            style="background-image: url('${assetUrl(`/flags/${escapeHtml(code.toLowerCase())}.svg`)}')"></span>
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
    el.style.setProperty('--cover', `url('${assetUrl('/api/image/cover')}')`);
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
function renderStats(next, medalTotal, imported) {
  stats = next;
  $('medalTotal').textContent = fmt(medalTotal ?? 0);
  $('totalPp').textContent = fmt(stats.totalPp, 0);
  /*
   * The bonus half of the tooltip says where the number came from, because it may not have
   * been earned here. Bonus pp is awarded for how many distinct ranked beatmaps an account
   * has ever played, which is a fact about a whole play history -- so a profile holding
   * imported best performances borrows osu!'s figure rather than showing the bonus for the
   * two hundred maps it happens to hold. A borrowed number has to admit it.
   */
  const maps = { n: fmt(stats.distinctRankedBeatmaps) };
  const bonus = stats.bonusPpBorrowed
    ? t('stats.bonusBorrowed', {
        pp: fmt(stats.bonusPp, 0),
      }) +
      (imported?.osuTotalPp
        ? t('stats.bonusBorrowedThere', {
            pp: fmt(imported.osuTotalPp, 0),
          })
        : '')
    : stats.distinctRankedBeatmaps === 1
      ? t('stats.bonusOneMap', {
          pp: fmt(stats.bonusPp, 0),
          ...maps,
        })
      : t('stats.bonusMaps', {
          pp: fmt(stats.bonusPp, 0),
          ...maps,
        });
  $('totalPp').title = t('stats.ppTitle', {
    pp: fmt(stats.weightedPp, 0),
    bonus,
  });

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
    [t('stats.rankedScore'), fmt(stats.rankedScore)],
    [t('stats.hitAccuracy'), pct(stats.accuracy)],
    [t('stats.playCount'), fmt(stats.playcount)],
    [t('stats.totalScore'), fmt(stats.totalScore)],
    [t('stats.totalHits'), fmt(stats.totalHits)],
    [t('stats.hitsPerPlay'), fmt(stats.hitsPerPlay)],
    [t('stats.maximumCombo'), `${fmt(stats.maxCombo)}x`],
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
      t('rank.estimatedFrom', { dump: data.rankSource?.dump ?? data.rank.dump }) +
      (data.rankSource
        ? t('rank.sampleSize', { n: fmt(data.rankSource.sampled) })
        : '') +
      '. ' +
      t('rank.approximate');
  } else {
    el.textContent = '-';
    el.title = stats?.totalPp > 0
      ? t('rank.noCurve')
      : t('rank.noPp');
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
  // The count goes with it: the play-count sentence is only worth saying once attempts exist.
  const text = countingNoteText(counting && { ...counting, unsubmittedAttempts });
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
      <button type="button" class="counting-note__dismiss" data-dismiss-note>${escapeHtml(
        t('common.dontShowAgain'),
      )}</button>
      <button type="button" class="counting-note__close" data-dismiss-note
              aria-label="${escapeHtml(t('common.dontShowThisAgain'))}">&times;</button>
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
      <button type="button" class="counting-note__dismiss" data-dismiss-note>${escapeHtml(
        t('common.dontShowAgain'),
      )}</button>
      <button type="button" class="counting-note__close" data-dismiss-note
              aria-label="${escapeHtml(t('common.dontShowThisAgain'))}">&times;</button>
    </div>`;
}

$('favoritesNote').onclick = async (e) => {
  if (e.target.closest('[data-import-favorites]')) {
    openProfiles({ section: 'import', favoritesOnly: true });
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

/**
 * How osu!stable reaches this page, said once where it matters.
 *
 * Both facts were measured on a real stable install (roadmap 5.12), and neither is something
 * this app can do anything about: stable writes the replay only when the results screen is
 * left, so a score appears seconds after the play rather than at the moment it ends; and it
 * keeps no usable record of a play that was quit, failed or retried, so those are not counted
 * at all. lazer has neither limitation, so the note is shown only where stable was found.
 *
 * McOsu has the second limitation too, worse: it keeps nothing at all of a play it did not
 * save. So a McOsu install gets its own paragraph in the same note, and one dismissal covers
 * both -- they are the same news about the same kind of play.
 */
function renderStableNote() {
  const paragraphs = [
    ...(installKinds.includes('stable') ? [t('stableNote.text')] : []),
    ...(installKinds.includes('mcosu') ? [t('mcosuNote.text')] : []),
  ];
  const show = paragraphs.length > 0 && settings.showStableNote !== false;
  for (const note of document.querySelectorAll('[data-stable-note]')) {
    note.hidden = !show;
    if (!show) {
      note.innerHTML = '';
      continue;
    }
    note.innerHTML = `<div class="counting-note__text">${paragraphs.join('<br><br>')}</div>
      <div class="counting-note__actions">
        <button type="button" class="counting-note__dismiss" data-dismiss-stable>${escapeHtml(
          t('common.dontShowAgain'),
        )}</button>
        <button type="button" class="counting-note__close" data-dismiss-stable
                aria-label="${escapeHtml(t('common.dontShowThisAgain'))}">&times;</button>
      </div>`;
  }
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-dismiss-stable]')) return;

  settings = { ...settings, showStableNote: false };
  renderStableNote();
  try {
    const d = await postJson('/api/settings', { showStableNote: false }, 'saving that failed');
    settings = d.settings;
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------------------------------------------ data */

async function loadProfile() {
  const query = new URLSearchParams({ mode: String(mode) });
  for (const section of PAGED) query.set(section, String(shown[section]));
  const data = await (await fetch(`/api/profile?${query}`)).json();

  // A profile that has never been paged has no totals; fall back to what arrived, so the
  // page still renders against an older server.
  const totals = data.totals ?? {};
  const totalFor = (section, list) => totals[section] ?? list.length;

  renderStats(data.stats, data.medalTotal, data.imported);
  renderCover(data.top);

  renderRank(data);

  // osu-web charts global rank; fall back to pp when no rank curve exists for this mode.
  const rankPoints = (data.rankHistory ?? []).filter((p) => p.rank != null);
  $('ppChart').innerHTML = rankPoints.length
    ? rankChart(rankPoints)
    : ppChart(
        data.ppHistory,
        data.stats.playcount > 0 ? t('chart.noRankedPlays') : t('chart.unranked'),
      );

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
          ? t('empty.noPpPlays')
          : t('empty.noRankedPlays'),
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
      empty: t('empty.goSetAPlay'),
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
  unsubmittedAttempts = s.unsubmittedAttempts ?? 0;
  sharing = s.sharing ?? sharing;
  modesWithPlays = s.modesWithPlays ?? [];
  welcomeOffered = Boolean(s.welcome);
  refreshOpenProfiles();

  app = s.app ?? app;
  // The app's own answer, which outranks what this browser remembered. Not awaited: the
  // rest of this render is in the language already on screen, and a change re-runs it.
  void applyConfigLanguage();
  applyConfigOriginalMetadata();
  $('footerVersion').textContent = app.version
    ? `osu! local profiles v${app.version}`
    : 'osu! local profiles';
  if (isStatic) {
    $('footerVersion').textContent += t('footer.copyAsOf', {
      date: shortDate(Date.parse(snapshot.exportedAt)),
    });
  }
  renderUpdate();

  renderLazerScoring();
  installKinds = s.installs.map((i) => i.kind);
  renderStableNote();
  const kinds = installKinds.join(' + ') || t('menu.noClientFound');
  const session = { name: s.profile.name, kinds, n: s.scoresThisSession };
  $('optInfo').textContent =
    (s.scoresThisSession === 1
      ? t('menu.watchingOne', session)
      : t('menu.watchingMany', session)) +
    // Only when there are any: a filter that is declining plays is the explanation for a score
    // that never appeared, and it should not have to be gone looking for.
    (playsFiltered > 0
      ? t('menu.filteredOut', { n: playsFiltered })
      : '');

  filterNarrowing = Boolean(s.filterNarrowing);
  playsFiltered = s.playsFiltered ?? 0;
  renderFilterMenu();

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
    $('indexTitle').textContent = state.firstRun
      ? t('index.finding')
      : t('index.updating');
    const done = state.total > 0 ? Math.min(1, state.scanned / state.total) : 0;
    $('indexDetail').textContent =
      state.phase === 'counting'
        ? t('index.counting', {
            n: fmt(state.total),
          })
        : t('index.progress', {
            percent: Math.floor(done * 100),
            done: fmt(state.scanned),
            total: fmt(state.total),
          });
    $('indexFill').style.setProperty('--fill', state.phase === 'counting' ? '30%' : `${done * 100}%`);
    const waitingCount = { n: fmt(state.waiting) };
    const waiting =
      state.waiting > 0
        ? ` ${
            state.waiting === 1
              ? t('index.waitingOne', waitingCount)
              : t('index.waitingMany', waitingCount)
          }`
        : '';
    $('indexNote').textContent =
      (state.firstRun
        ? t('index.firstRun')
        : t('index.newBeatmaps')) +
      ' ' +
      t('index.meanwhile') +
      waiting;
    return;
  }

  // It was on screen and has finished: say so once, and show whatever it was holding back.
  if (indexShown && !state.active) {
    indexShown = false;
    toast(
      state.error
        ? t('index.stopped', { error: state.error })
        : t('index.ready') +
          (state.indexed ? t('index.indexedCount', { n: fmt(state.indexed) }) : ''),
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
  if (trackingFilterOpen()) closeTrackingFilter();
  if (!$('profilesModal').hidden) closeProfiles();
  if (!$('settingsModal').hidden) closeSettings();
  if (osuFoldersOpen()) closeOsuFolders();
  if (!$('playMenu').hidden) closePlayMenu();
  if (!$('welcomeModal').hidden) closeWelcome();
  if (!$('shareModal').hidden) closeShare();
  if (!$('updateModal').hidden) closeUpdate();
});

/* ---------------------------------------------------------- lazer scoring */

/*
 * osu!'s own toggle, in the same place osu! puts it: the options menu, on by default.
 *
 * It picks which of osu!'s two scales every score is read on -- standardised, where a nomod
 * SS is 1,000,000, or the uncapped classic scale. Both are stored per score, so this is a
 * settings change and a redraw, never a recalculation. It moves every score-shaped number:
 * the rows, the card, Total Score, Ranked Score, and the level, which is a function of score.
 */
function renderLazerScoring() {
  $('optLazerScoring').setAttribute('aria-checked', String(settings.scoring !== 'classic'));
}

$('optLazerScoring').onclick = async () => {
  const next = settings.scoring === 'classic' ? 'lazer' : 'classic';
  settings = { ...settings, scoring: next };
  renderLazerScoring();
  try {
    const d = await postJson('/api/settings', { scoring: next }, 'saving that failed');
    settings = d.settings;
    renderLazerScoring();
    await loadProfile();
    toast(next === 'classic' ? t('scoring.classic') : t('scoring.lazer'));
  } catch (err) {
    settings = { ...settings, scoring: next === 'classic' ? 'lazer' : 'classic' };
    renderLazerScoring();
    toast(err.message);
  }
};

/* ------------------------------------------------------- open on start */

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
    ? `<a href="${escapeHtml(u.releaseUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(
        t('update.releaseNotes'),
      )}</a>`
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
  $('updateHint').textContent = t('update.downloading');
  try {
    const d = await postJson('/api/update/apply', {}, 'the update failed');
    $('updateHint').textContent = `${d.message} ${t('update.startYourself')}`;
  } catch (err) {
    $('updateHint').textContent = err.message;
    $('updateConfirm').disabled = false;
  }
};

/* ------------------------------------------------------------------- quit */

/** Set once this page has stopped the app, so nothing reconnects to a port nobody holds. */
let quitHere = false;

/**
 * Say the app is not running: `byThisPage` after Quit here, otherwise because the stream
 * dropped -- quit from its tray icon, or on its way back from an update.
 */
function showStopped(byThisPage) {
  $('stoppedTitle').textContent = byThisPage
    ? t('quit.stopped')
    : t('quit.notRunning');
  $('stoppedText').textContent = byThisPage
    ? t('quit.trackingOff')
    : t('quit.picksUp');
  $('stoppedNotice').hidden = false;
}

/** Where else the app can be stopped from, so Quit's tooltip is also how to find it. */
function quitTitle() {
  if (app.launcher !== 'tray') {
    return t('quit.titleNoTray');
  }
  const where =
    app.platform === 'darwin'
      ? t('quit.menuBar')
      : t('quit.systemTray');
  return t('quit.titleTray', { where });
}

$('quitBtn').onmouseenter = () => {
  $('quitBtn').title = quitTitle();
};

$('quitBtn').onclick = async () => {
  const button = $('quitBtn');
  if (!armed(button, t('quit.confirm'))) return;
  button.disabled = true;
  try {
    await postJson('/api/quit', {}, 'the app did not stop');
    quitHere = true;
    closeEvents();
    showStopped(true);
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
};

/* ------------------------------------------------------------------ share */

/*
 * Two ways to hand this profile to someone else.
 *
 * 1. A web page: this page as one .html file that works like it -- show more, the mode
 *    tabs, View Details -- built by share-copy.js, and fit to put online as it is.
 * 2. A PNG, rendered by a browser that is already installed.
 *
 * The live page is never served to anyone else: it can reset and delete profiles, and none
 * of that asks who is calling.
 */

/**
 * `?export=1` is the same page with its controls hidden. The screenshot endpoint loads it,
 * and so does anyone who just wants to look without the affordances getting in the way.
 */
function applyExportMode() {
  if (new URLSearchParams(location.search).get('export') !== '1') return;
  document.body.classList.add('export-mode');
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
    ? t('share.canRender')
    : t('share.needsBrowser');

  $('shareModal').hidden = false;
  $('shareClose').focus();
  void showDataFolder();
}

/** Asked for each time rather than kept in /api/state, which the saved web page is built from. */
async function showDataFolder() {
  try {
    const r = await fetch('/api/data-folder');
    $('dataFolderPath').textContent = r.ok ? (await r.json()).path : '';
  } catch {
    $('dataFolderPath').textContent = '';
  }
}

const closeShare = () => { $('shareModal').hidden = true; };

$('optShare').onclick = openShare;
$('shareClose').onclick = closeShare;
$('shareModal').onclick = (e) => {
  if (e.target === $('shareModal')) closeShare();
};

$('shareHtml').onclick = async () => {
  $('shareHtml').disabled = true;
  shareHint(t('share.building'));
  try {
    const html = await buildInteractiveHtml((message) => shareHint(message));
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeName()}.html`);
    shareHint(t('share.savedHtml', { size: fmt(Math.ceil(html.length / 1024)) }));
  } catch (err) {
    shareHint(err.message, true);
  } finally {
    $('shareHtml').disabled = false;
  }
};

$('shareScreenshot').onclick = async () => {
  $('shareScreenshot').disabled = true;
  shareHint(t('share.rendering'));
  try {
    const r = await fetch('/api/screenshot');
    if (!r.ok) throw new Error(((await r.json()).error) ?? t('share.renderFailed'));
    downloadBlob(await r.blob(), `${safeName()}.png`);
    shareHint(t('common.saved'));
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
  // A function rather than a string: the label is fetched when it is drawn, so switching
  // language redraws it rather than leaving the section nav in the old one.
  return SECTIONS.find(([sectionId]) => sectionId === id)?.[1]() ?? id;
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
 * The profile's own description: osu!'s me! box, edited the way osu! edits it.
 *
 * BBCode, with osu-web's toolbar -- every button wraps the selection exactly as osu-web's
 * post-box does -- a preview, and images pasted or dropped straight in. Rendered by
 * web/js/bbcode.js, which escapes everything first and emits only tags of its own, so a page
 * imported from someone else's osu! profile is as safe to show as one typed here.
 */

/** osu-web's post-box: what each toolbar button puts either side of the selection. */
const BBCODE_BUTTONS = {
  bold: ['[b]', '[/b]'],
  italic: ['[i]', '[/i]'],
  strikethrough: ['[s]', '[/s]'],
  heading: ['[heading]', '[/heading]'],
  link: ['[url]', '[/url]'],
  spoilerbox: ['[box=]', '[/box]'],
  'list-numbered': ['[list=1]\n[*]', '[/list]'],
  list: ['[list]\n[*]', '[/list]'],
  image: ['[img]', '[/img]'],
  imagemap: ['[imagemap]\nhttps://example.com/image.jpg\n0 10 10 50 https://example.com example\n', '[/imagemap]'],
};

/** The same cap the server applies (settings.ts), so the box stops where saving would. */
const ABOUT_LIMIT = 60000;

let editingAbout = false;

function renderAbout() {
  const html = bbcodeHtml(settings.aboutMe ?? '');
  $('aboutView').innerHTML = html
    ? `<div class="bbcode">${html}</div>`
    : '<div class="about__empty">Nothing here yet. Click to write something.</div>';
  $('aboutView').classList.toggle('about--empty', !html);
  // In a shared copy an empty me! is left out, tab and all: "click to write" is for its owner.
  document.documentElement.classList.toggle('static-copy--no-me', isStatic && !html);
  $('aboutView').title = editingAbout || isStatic ? '' : 'Click to edit';
}

/** Write and Preview: osu-web's two states for the same box. */
function setAboutState(state) {
  $('aboutEdit').dataset.state = state;
  $('aboutPreviewToggle').textContent = state === 'preview' ? 'Write' : 'Preview';
  if (state === 'preview') {
    const html = bbcodeHtml($('aboutText').value);
    $('aboutPreview').innerHTML = html || '<div class="about__empty">Nothing to preview yet.</div>';
  } else {
    $('aboutText').focus();
  }
}

function openAboutEditor() {
  if (editingAbout || isStatic) return;
  editingAbout = true;
  $('aboutText').value = settings.aboutMe ?? '';
  updateAboutCount();
  $('aboutView').hidden = true;
  $('aboutEdit').hidden = false;
  setAboutState('write');
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
  $('aboutCount').textContent = used > ABOUT_LIMIT - 5000 ? `${fmt(ABOUT_LIMIT - used)} characters left` : '';
}

/**
 * osu-web's insert: the tags either side of the selection, which stays selected with them;
 * with nothing selected the cursor lands between the two. Typed through execCommand so the
 * browser's own undo still works, with setRangeText as the fallback.
 */
function insertBbcode(open, close = '') {
  const box = $('aboutText');
  const start = box.selectionStart;
  const end = box.selectionEnd;
  const selected = box.value.slice(start, end);
  box.focus();
  box.setSelectionRange(start, end);
  const text = open + selected + close;
  if (!document.execCommand('insertText', false, text)) box.setRangeText(text, start, end, 'end');
  if (start === end) box.setSelectionRange(start + open.length, start + open.length);
  else box.setSelectionRange(start, start + text.length);
  updateAboutCount();
}

/** Upload images and put each in the text where the cursor is. True if there were any. */
async function uploadAboutImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (images.length === 0) return false;
  for (const file of images) {
    try {
      const r = await fetch('/api/about-image', { method: 'PUT', body: file });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? t('common.uploadFailed'));
      insertBbcode(`[img]${d.url}[/img]`);
    } catch (err) {
      toast(`${file.name || t('me.thatImage')}: ${err.message}`);
    }
  }
  return true;
}

// Links, spoiler boxes and players in the page work as themselves; anywhere else edits.
$('aboutView').onclick = (e) => {
  if (e.target.closest('a, summary, audio, iframe')) return;
  openAboutEditor();
};
$('aboutText').oninput = updateAboutCount;
$('aboutCancel').onclick = closeAboutEditor;
$('aboutPreviewToggle').onclick = () =>
  setAboutState($('aboutEdit').dataset.state === 'preview' ? 'write' : 'preview');

$('aboutToolbar').addEventListener('click', (e) => {
  const button = e.target.closest('[data-bb]');
  if (!button) return;
  const box = $('aboutText');
  // With nothing selected, Image asks for a file; pasting and dropping one work as well.
  if (button.dataset.bb === 'image' && box.selectionStart === box.selectionEnd) {
    $('aboutImageFile').value = '';
    $('aboutImageFile').click();
    return;
  }
  const [open, close] = BBCODE_BUTTONS[button.dataset.bb];
  insertBbcode(open, close);
});

// osu-web's size select: choosing wraps the selection, then the select goes back to its label.
$('aboutSize').onchange = () => {
  const size = $('aboutSize').value;
  $('aboutSize').value = '';
  if (size) insertBbcode(`[size=${size}]`, '[/size]');
};

$('aboutImageFile').onchange = () => void uploadAboutImages($('aboutImageFile').files ?? []);

$('aboutText').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.some((f) => f.type.startsWith('image/'))) return;
  e.preventDefault();
  void uploadAboutImages(files);
});
$('aboutText').addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault();
});
$('aboutText').addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.some((f) => f.type.startsWith('image/'))) return;
  e.preventDefault();
  void uploadAboutImages(files);
});

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
    toast(t('common.savedShort'));
  } catch (err) {
    toast(err.message);
  } finally {
    $('aboutSave').disabled = false;
  }
};

/* ---------------------------------------------------------------- identity */

/*
 * Options -> Profiles holds everything about a profile, in one dialog at the user's request:
 * which one is tracking, then Edit profile -- its name, flag, playstyle, picture and banner --
 * then Import from osu!, then how profiles share favorites. Those were once four places (Edit
 * profile, Import from osu!, Settings and Profiles). The avatar and the name open it at Edit
 * profile.
 *
 * Four sources for the picture and banner, in the order they cost the user anything: what osu!
 * is signed in as (read from its own config file, no network), a looked-up account, a file from
 * disk, or nothing at all -- which is the default, and shows osu!'s guest avatar.
 */

let identitySuggestions = { sessions: [], linked: null };
/** Which image an "Upload..." press is choosing a file for. */
let uploadKind = null;
/** The profile Edit profile was last filled from, so switching profiles fills it again. */
let editing = { id: null, name: null };

const identityHint = (message, isError) => hint('identityHint', message, isError);
const identityAction = (payload) => postJson('/api/identity', payload);

/** Cache-busted, because the file behind these URLs is replaced in place. */
function renderIdentityPreviews() {
  const stamp = Date.now();
  $('identityAvatar').innerHTML = profile?.hasAvatar
    ? `<img src="/api/image/avatar?v=${stamp}" alt="">`
    : guestAvatar(profile?.name ?? '');
  $('identityCover').style.backgroundImage = profile?.hasCover
    ? `url('/api/image/cover?v=${stamp}')`
    : 'none';
  $('identityCover').classList.toggle('identity-image__preview--empty', !profile?.hasCover);

  for (const kind of ['avatar', 'cover']) {
    const has = kind === 'avatar' ? profile?.hasAvatar : profile?.hasCover;
    $('profileEdit').querySelector(`[data-clear="${kind}"]`).disabled = !has;
  }
}

/** The osu! account this profile is linked to, if any. */
function renderIdentitySuggestions() {
  const bits = [];
  if (identitySuggestions.linked) {
    bits.push(
      `<div class="identity-linked">
         ${t('identity.linkedTo', {
           name: escapeHtml(identitySuggestions.linked.username),
           id: fmt(identitySuggestions.linked.id),
         })}
         <button type="button" id="identityUnlink">${escapeHtml(t('identity.unlink'))}</button>
       </div>`,
    );
  }
  $('identityFound').innerHTML = bits.join('');
}

/** Edit profile, filled from the profile being tracked. */
function renderProfileEdit() {
  editing = { id: profile?.id ?? null, name: profile?.name ?? null };
  const name = profile?.name ?? 'this profile';
  $('identityProfileName').textContent = name;
  $('importProfileName').textContent = name;
  $('identityName').value = profile?.name ?? '';
  $('identityCountry').value = settings.country ?? '';
  $('identityTagline').value = settings.tagline ?? '';
  identityHint('\u00a0');
  renderIdentityPreviews();
}

/** The linked account, and what osu! is signed in as. Read locally: nothing is asked of osu!. */
async function loadSuggestions() {
  try {
    identitySuggestions = await identityAction({ action: 'suggestions' });
  } catch {
    // A convenience; typing a name always works.
    return;
  }
  renderIdentitySuggestions();
  renderImportSuggestions();
}

/*
 * From loadState, while Profiles is open. Switching, creating or deleting a profile in the list
 * changes which profile the rest of the dialog is about, so it is filled again. A rename of that
 * profile updates its name, unless the name field has been typed over.
 */
function refreshOpenProfiles() {
  if ($('profilesModal').hidden) return;
  if (profile?.id !== editing.id) {
    renderProfileEdit();
    resetImport();
    void loadSuggestions();
    return;
  }
  if (profile?.name !== editing.name) {
    if ($('identityName').value === editing.name) $('identityName').value = profile?.name ?? '';
    editing = { ...editing, name: profile?.name ?? null };
    $('identityProfileName').textContent = profile?.name ?? 'this profile';
    $('importProfileName').textContent = profile?.name ?? 'this profile';
  }
}

$('avatar').onclick = () => openProfiles({ section: 'edit' });
$('pname').onclick = () => openProfiles({ section: 'edit' });
$('pname').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openProfiles({ section: 'edit' });
  }
};

/*
 * One Save for the three text fields. The name is a rename -- the list's Rename does the same.
 * Country and playstyle are this profile's settings: the server cleans them and hands them back,
 * and that is what is shown, so a rejected country code comes back empty rather than appearing
 * to have saved.
 */
$('identitySave').onclick = async () => {
  const name = $('identityName').value.trim();
  if (!name) {
    identityHint(t('identity.needName'), true);
    return;
  }
  const country = $('identityCountry').value.trim();
  const tagline = $('identityTagline').value.trim();

  $('identitySave').disabled = true;
  try {
    if (name !== profile?.name) await profileAction({ action: 'rename', id: profile.id, name });
    const d = await postJson('/api/settings', { country, tagline }, 'saving failed');
    settings = d.settings;
    await Promise.all([loadState(), loadProfile()]);
    renderProfileEdit();
    if (country !== '' && !d.settings.country) {
      identityHint(
        t('identity.badCountry'),
        true,
      );
    } else {
      identityHint(t('common.saved'));
    }
    toast(t('identity.profileSaved'));
  } catch (err) {
    identityHint(err.message, true);
  } finally {
    $('identitySave').disabled = false;
  }
};

for (const id of ['identityName', 'identityCountry', 'identityTagline']) {
  $(id).onkeydown = (e) => {
    if (e.key === 'Enter') $('identitySave').click();
  };
}

/* --- images ------------------------------------------------------------- */

$('profileEdit').addEventListener('click', async (e) => {
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
      identityHint(t('identity.removed'));
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
      identityHint(t('identity.unlinked'));
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

  identityHint(t('identity.uploading', { file: file.name }));
  try {
    const r = await fetch(`/api/image/${kind}`, { method: 'PUT', body: file });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? t('common.uploadFailed'));
    await loadState();
    renderIdentityPreviews();
    await loadProfile();
    identityHint(t('common.saved'));
  } catch (err) {
    identityHint(err.message, true);
  }
};

/* --- importing from an osu! account ------------------------------------ */

/*
 * Profiles -> Import from osu!: look an account up, then copy what was chosen from it. Nothing
 * happens until a button is pressed. It was once never a prompt at start-up, at the user's
 * request; later, at the user's request, a brand-new install shows this section once by itself
 * as the welcome (src/welcome.ts), and closing that in any way ends it for good.
 * Avatar, banner, flag and me! are ticked by default; favorites are not, because they add
 * to a list rather than replacing one thing.
 */
/*
 * Best performances and pinned scores start unticked, like favorites and unlike the four
 * decorative ones. They are the only part of an import that writes *plays*: they move pp,
 * accuracy and the play count, and a profile is meant to be a record of what was played
 * while it was tracking. Wanting that overruled is a decision worth ticking a box for.
 */
const IMPORT_DEFAULTS = {
  avatar: true, cover: true, country: true, aboutMe: true,
  favorites: false, bestPerformances: false, pinnedScores: false,
};
const IMPORT_FAVORITES_ONLY = {
  avatar: false, cover: false, country: false, aboutMe: false,
  favorites: true, bestPerformances: false, pinnedScores: false,
};

const importHint = (message, isError) => hint('importHint', message, isError);
/** The account the last Look up found, so Import copies from exactly that one. */
let importUser = null;

function importChoices() {
  const out = {};
  for (const box of $('importSection').querySelectorAll('[data-import]')) out[box.dataset.import] = box.checked;
  return out;
}

/** What pressing Import would do that is worth knowing first. */
function renderImportNote() {
  const choices = importChoices();
  const notes = [];
  if (choices.aboutMe && (settings.aboutMe ?? '').trim()) {
    notes.push(t('import.meReplaces'));
  }
  if (choices.favorites) {
    notes.push(
      app.config?.sharedFavorites === false
        ? "Favorites are added to this profile's list."
        : t('import.favoritesShared'),
    );
  }
  if (choices.bestPerformances) {
    notes.push(
      t('import.bestPerformances'),
    );
  }
  if (choices.pinnedScores) {
    notes.push(t('import.pinnedScores'));
  }
  if (choices.bestPerformances || choices.pinnedScores) {
    notes.push(t('import.noDuplicates'));
  }
  $('importNote').textContent = notes.join(' ');
  $('importGo').disabled = !Object.values(choices).some(Boolean);
}

const joinList = (items) =>
  items.length < 2
    ? items.join('')
    : t('filter.joinLast', { list: items.slice(0, -1).join(', '), last: items.at(-1) });

/** Nothing looked up, and the default ticks -- or favorites alone, from the favorites reminder. */
function resetImport({ favoritesOnly = false } = {}) {
  const choices = favoritesOnly ? IMPORT_FAVORITES_ONLY : IMPORT_DEFAULTS;
  for (const box of $('importSection').querySelectorAll('[data-import]')) box.checked = choices[box.dataset.import];
  $('importProfileName').textContent = profile?.name ?? 'this profile';
  $('importQuery').value = '';
  importUser = null;
  $('importFound').innerHTML = '';
  importHint('\u00a0');
  renderImportNote();
}

/** The linked account, or the one osu! is signed in as: neither costs a request. */
function renderImportSuggestions() {
  const found = identitySuggestions;
  if (found.linked && !$('importQuery').value) $('importQuery').value = found.linked.username;
  // An account already looked up is showing there; the suggestions would replace it.
  if (importUser) return;
  $('importFound').innerHTML = (found.sessions ?? [])
    .filter((session) => session.username !== found.linked?.username)
    .map(
      (session) => `<button type="button" class="identity-suggestion" data-query="${escapeHtml(session.username)}">
         Use <b>${escapeHtml(session.username)}</b>
         <span>signed in to osu!${escapeHtml(session.client)}</span>
       </button>`,
    )
    .join('');
}

$('importSection').addEventListener('change', (e) => {
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
    importHint(t('import.needQuery'), true);
    return;
  }

  $('importLookup').disabled = true;
  importHint(t('import.lookingUp', { query }));
  try {
    const { user } = await identityAction({ action: 'lookup', query });
    importUser = user;
    // Shown before anything is copied: one press to look, another to import.
    $('importFound').innerHTML = `<div class="identity-candidate">
      <img class="identity-candidate__avatar" src="${escapeHtml(user.avatarUrl ?? '')}" alt="">
      <div class="identity-candidate__detail">
        <b>${escapeHtml(user.username)}</b>
        <span>#${fmt(user.id)}${user.countryCode ? ` &middot; ${escapeHtml(countryName(user.countryCode))}` : ''}
          &middot; ${escapeHtml(
            user.pageRaw
              ? t('import.hasMePage')
              : t('import.noMePage'),
          )}</span>
      </div>
    </div>`;
    importHint(t('import.found'));
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
    importHint(t('import.needAccount'), true);
    return;
  }
  const choices = importChoices();

  $('importGo').disabled = true;
  const slow = choices.favorites || choices.bestPerformances || choices.pinnedScores;
  importHint(
    slow
      ? t('import.slow')
      : t('import.running'),
  );
  try {
    const d = await identityAction({ action: 'import', query, ...choices });
    settings = d.settings;
    await Promise.all([loadState(), loadProfile()]);
    renderAbout();
    const what = d.done.length ? `Imported ${joinList(d.done)} from ${d.user.username}` : `Linked to ${d.user.username}`;
    if (d.failures.length) {
      importHint(`${what}, but ${d.failures.join('; ')}`, true);
      return;
    }
    toast(`${what}.`);
    if (welcoming) {
      closeWelcome();
      return;
    }
    // In Profiles, Edit profile above shows what was just copied, and the new link.
    renderProfileEdit();
    void loadSuggestions();
    importHint(`${what}.`);
  } catch (err) {
    importHint(err.message, true);
  } finally {
    renderImportNote();
  }
};

/* --- the one-time welcome ----------------------------------------------- */

/** True while the welcome is showing, so leaving it in any way ends the welcome for good. */
let welcoming = false;

/*
 * The welcome borrows Import from osu! out of Profiles rather than keeping a copy of it: one
 * set of controls and one set of handlers. The section goes back where it came from when the
 * welcome closes.
 */
/**
 * The language row at the top of the welcome.
 *
 * Pre-selected from what the browser asks for, because on a first launch that is almost
 * always right -- somebody whose browser is in Polish wants the page in Polish, and should
 * have to do nothing to get it. Applied the moment it changes, including to the welcome
 * itself, so the rest of the dialog is read in the language just picked.
 */
function fillWelcomeLanguage() {
  const select = $('welcomeLang');
  const guess = currentLocale() === 'en' ? matchLocale(navigator.languages) ?? 'en' : currentLocale();
  select.innerHTML = availableLocales()
    .map((l) => `<option value="${l.code}" lang="${l.code}">${escapeHtml(l.native)}</option>`)
    .join('');
  select.value = guess;
  select.onchange = () => void chooseLanguage(select.value);
  // The guess is applied straight away rather than waiting for a change event that will
  // never come if it was already right.
  if (guess !== currentLocale()) void chooseLanguage(guess);
}

/**
 * The original-language switch under the language row.
 *
 * Applied as it is changed, like the language above it, so the choice is made against a page
 * that is already showing the result rather than described in a sentence.
 */
function fillWelcomeOriginal() {
  const box = $('welcomeOriginal');
  box.checked = preferOriginalMetadata();
  box.onchange = () => chooseOriginalMetadata(box.checked);
}

async function openWelcome() {
  welcoming = true;
  fillWelcomeLanguage();
  fillWelcomeOriginal();
  $('welcomeSlot').append($('importSection'));
  $('importHeading').hidden = true;
  resetImport();
  $('welcomeModal').hidden = false;
  $('importQuery').focus();
  await loadSuggestions();
}

function closeWelcome() {
  if (!welcoming) return;
  welcoming = false;
  $('welcomeModal').hidden = true;
  $('importHeading').hidden = false;
  $('sharedSection').before($('importSection'));
  // Whatever the language row ended on is the answer, including when the answer was to
  // leave it alone: `language` has to stop being empty, or "never chosen" stays true.
  if (!knownLocale(app.config?.language)) void chooseLanguage($('welcomeLang').value);
  // However it was left -- Skip, the x, Escape, the backdrop, or an import -- it is not
  // offered again. A save that fails only means it is offered once more next time.
  postJson('/api/welcome', {}).catch(() => {});
}

$('welcomeSkip').onclick = closeWelcome;
$('welcomeDismiss').onclick = closeWelcome;
$('welcomeModal').onclick = (e) => {
  if (e.target === $('welcomeModal')) closeWelcome();
};

/* --- every profile ------------------------------------------------------ */

/*
 * Belongs to the install rather than a profile, so it goes to config.json -- straight away, the
 * way a switch does: nothing else in Profiles waits for a Save either.
 */
$('sharedFavorites').onchange = async () => {
  const shareFavorites = $('sharedFavorites').checked;
  try {
    const c = await postJson('/api/app-config', { sharedFavorites: shareFavorites }, 'saving that failed');
    app = { ...app, config: c.config };
    renderImportNote();
    await loadProfile();
    toast(
      shareFavorites
        ? t('favorites.shared')
        : t('favorites.perProfile'),
    );
  } catch (err) {
    $('sharedFavorites').checked = !shareFavorites;
    toast(err.message);
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
            <span>${escapeHtml(label())}</span>
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
          }>${escapeHtml(label())}</option>`,
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

  /*
   * With osu!stable alone there is no source for a beatmap's status, so every beatmap counts
   * and these boxes cannot change anything. Dimmed and disabled rather than hidden: the
   * reason is worth reading, and it is the same treatment a dependent setting gets.
   */
  if (counting?.countUnresolved) {
    const field = $('set-includeUnrankedMaps');
    for (const box of field.querySelectorAll('input')) box.disabled = true;
    const setting = field.closest('.setting');
    setting.classList.add('setting--inactive');
    const hint = setting.querySelector('.setting__hint');
    const note = ` ${t('setting.noStatusSource')}`;
    if (!hint.textContent.includes(note.trim())) hint.textContent += note;
  }
}

function renderSettingsFields() {
  $('settingsFields').innerHTML = SETTINGS_FIELDS.map(
    (f) => `<div class="setting">
      <label class="field${f.type === 'checkboxes' ? ' field--stacked' : ''}">
        <span>${escapeHtml(f.label())}</span>
        ${settingControl(f)}
      </label>
      <div class="setting__hint">${escapeHtml(f.hint?.() ?? '')}</div>
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
  $('removedList').innerHTML = `<div class="setting__hint">${escapeHtml(
    t('common.loading'),
  )}</div>`;

  try {
    const d = await scoreAction({ action: 'list-hidden' });
    $('removedList').innerHTML = d.hidden
      .map((h) => {
        // A removed unfinished play has no grade, accuracy or pp to describe, only what it was.
        const incomplete = h.kind === 'incomplete';
        const ids = incomplete ? h.ids.join(',') : String(h.id);
        const meta = incomplete
          ? `${escapeHtml(
              h.unsubmitted
                ? t('play.notSubmitted')
                : t('play.didntFinish'),
            )}${
              h.attempts > 1
                ? ` &middot; ${escapeHtml(t('play.attempts', {
                    n: fmt(h.attempts),
                  }))}`
                : ''
            }`
          : `${escapeHtml(h.grade)} &middot; ${pct(h.accuracy)} &middot;
              ${escapeHtml(h.modsLabel)}${h.pp != null ? ` &middot; ${fmt(h.pp, 0)}pp` : ''}`;
        return `<div class="removed-row">
          <div class="removed-row__detail">
            <div class="u-ellipsis">${escapeHtml(original(h.title, h.titleOriginal))}${
              h.version ? ` <span class="removed-row__version">[${escapeHtml(h.version)}]</span>` : ''
            }</div>
            <div class="removed-row__meta">${meta}</div>
          </div>
          <button type="button" data-restore="${ids}" data-kind="${incomplete ? 'incomplete' : 'score'}">${escapeHtml(t('removed.putBack'))}</button>
          <button type="button" class="removed-row__delete" data-delete="${ids}" data-kind="${incomplete ? 'incomplete' : 'score'}"
                  title="${escapeHtml(t('removed.deletePermanently'))}" aria-label="${escapeHtml(t('removed.deletePermanently'))}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="2" rx="1" fill="currentColor"/></svg>
          </button>
        </div>`;
      })
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
    /*
     * Four whole sentences rather than a noun and a plural suffix stitched together. English
     * gets away with "1 score"/"2 scores"; most languages do not, and a capital letter
     * applied to the first character of a translated word is a guess at somebody else's
     * orthography.
     */
    const incomplete = payload.kind === 'incomplete';
    const count = { n: fmt(d.deleted) };
    toast(
      d.deleted === 1
        ? incomplete
          ? t('removed.deletedOnePlay')
          : t('removed.deletedOneScore')
        : incomplete
          ? t('removed.deletedPlays', count)
          : t('removed.deletedScores', count),
    );
    await Promise.all([loadState(), loadProfile()]);
    await renderRemovedScores();
  } catch (err) {
    settingsHint(err.message, true);
    button.disabled = false;
  }
}

$('removedDeleteAll').onclick = () => {
  const button = $('removedDeleteAll');
  if (!armed(button, t('removed.deleteAllConfirm', {
    n: fmt(hiddenScoreCount),
  }))) {
    return;
  }
  void deleteRemoved({ action: 'delete-all-removed' }, button);
};

/** A removed row's button, as the request it makes: a score by id, an unfinished play by its attempts. */
const removedTarget = (button, ids) => {
  const list = ids.split(',').map(Number);
  return button.dataset.kind === 'incomplete' ? { kind: 'incomplete', ids: list } : { id: list[0] };
};

$('removedList').onclick = async (e) => {
  const doomed = e.target.closest('[data-delete]');
  if (doomed) {
    if (armed(doomed, t('removed.deleteConfirm'))) {
      void deleteRemoved({ action: 'delete', ...removedTarget(doomed, doomed.dataset.delete) }, doomed);
    }
    return;
  }
  const button = e.target.closest('[data-restore]');
  if (!button) return;
  button.disabled = true;
  try {
    await scoreAction({ action: 'restore', ...removedTarget(button, button.dataset.restore) });
    toast(button.dataset.kind === 'incomplete' ? 'Play put back' : 'Score put back');
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
  $('openBrowserSetting').checked = app.config?.openBrowser !== false;
  $('originalMetadataSetting').checked = preferOriginalMetadata();
  settingsHint(' ');
  $('settingsModal').hidden = false;
  $('settingsCancel').focus();
}

const closeSettings = () => { $('settingsModal').hidden = true; };

$('optFolders').onclick = () => {
  setMenuOpen(false);
  void openOsuFolders();
};
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

    /*
     * "Open in browser on start" belongs to the install rather than the profile -- it decides
     * what happens before any profile is on screen -- so it goes to data/config.json, and only
     * when it changed.
     */
    const openBrowser = $('openBrowserSetting').checked;
    if (openBrowser !== (app.config?.openBrowser !== false)) {
      const c = await postJson('/api/app-config', { openBrowser }, 'saving that failed');
      app = { ...app, config: c.config };
    }

    /*
     * The same install-level answer as the switch in the flag menu, saved the same way. The
     * reload below redraws every title, so nothing here has to ask for a redraw of its own.
     */
    const originalMetadata = $('originalMetadataSetting').checked;
    if (setPreferOriginalMetadata(originalMetadata)) {
      refreshLanguageButton();
      const c = await postJson('/api/app-config', { originalMetadata }, 'saving that failed');
      app = { ...app, config: c.config };
    }

    closeSettings();
    // The eligibility settings change every number on the page, not just the header.
    await Promise.all([loadState(), loadProfile()]);
    toast(
      rejected.length
        ? t('setting.savedRejected', {
            fields: rejected.map((f) => f.label().toLowerCase()).join(' and '),
          })
        : t('setting.saved'),
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
        ? t('favorites.removed')
        : d.detailsError
          ? t('favorites.addedOffline', { error: d.detailsError })
          : t('favorites.added'),
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
  $('playMenu').dataset.ids = '';
  $('playMenu').dataset.key = '';
}

/** Which row a menu belongs to. Kind and id together: an incomplete play's id can equal a score's. */
const menuKey = (button) => `${button.dataset.kind ?? 'score'}:${button.dataset.id}`;

/**
 * Open the shared popover beside the button that asked for it.
 *
 * Positioned in page coordinates, so it scrolls with the row it belongs to -- in window
 * coordinates it stayed put on screen while the page scrolled away under it. Clamped to the
 * right edge, because the row is inside a panel that would otherwise clip it.
 *
 * A score row gets everything; an unfinished play has no score, so it offers the beatmap and
 * removing the play. Favouriting is offered wherever there is a beatmapset -- a
 * never-submitted map has none, and nothing to show a card for.
 */
function openPlayMenu(button) {
  // A shared copy offers only View Details, which an unfinished play does not have.
  if (isStatic && (button.dataset.kind ?? 'score') !== 'score') return;
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
  menu.dataset.kind = isScore ? 'score' : 'incomplete';
  menu.dataset.ids = button.dataset.ids ?? String(id);
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
  // Removable from a row, either kind; the card's own score is removed from its row too.
  menu.querySelector('[data-act="hide"]').hidden = false;
  menu.querySelector('[data-sep="hide"]').hidden = setId === null && !isScore;

  menu.hidden = false;
  const box = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${box.bottom + 4 + window.scrollY}px`;
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

// Its left edge is clamped to the window, which a resize moves.
window.addEventListener('resize', closePlayMenu);

$('playMenu').onclick = async (e) => {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const id = Number($('playMenu').dataset.id);
  const setId = Number($('playMenu').dataset.set);
  const fromCard = $('playMenu').dataset.context === 'card';
  const kind = $('playMenu').dataset.kind;
  const ids = ($('playMenu').dataset.ids ?? '').split(',').map(Number).filter(Number.isInteger);
  const act = button.dataset.act;
  closePlayMenu();

  // An unfinished play: every attempt the row stands for leaves the list and the play count.
  if (act === 'hide' && kind === 'incomplete') {
    try {
      await scoreAction({ action: 'hide', kind, ids });
      toast(
        ids.length === 1
          ? t('play.removed')
          : t('play.removedAttempts', { n: fmt(ids.length) }),
      );
      await Promise.all([loadProfile(), loadState()]);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

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
      if (act === 'hide') toast(t('play.removed'));
      if (act === 'pin') toast(t('play.pinned'));
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
    if (!r.ok) throw new Error(d.error ?? t('play.notLoaded'));
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
// The menu is placed in page coordinates, so it cannot follow the card, which scrolls by itself.
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

  const count = { n: fmt(staleScores) };
  const ok = confirm(
    `${
      staleScores === 1
        ? t('recompute.staleOne', count)
        : t('recompute.staleMany', count)
    }\n\n` +
      `${t('recompute.ask')}\n\n` +
      t('recompute.nothingDeleted'),
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
    ? t('recompute.calculatorVersion', { version: v })
    : t('recompute.noCalculator');
  const n = ppCalculator.outdated;
  $('ppCalculatorOutdated').hidden = !v || n === 0;
  const outdated = { n: fmt(n) };
  $('ppCalculatorOutdated').textContent =
    n === 1
      ? t('recompute.outdatedOne', outdated)
      : t('recompute.outdatedMany', outdated);
  $('ppCalculatorAll').hidden = !v;
  $('ppRecalculate').disabled = recomputing || ppCalculator.recalculating === true;
}

$('ppRecalculate').onclick = () => {
  closeSettings();
  void runRecompute(true);
};

/** What a finished recalculation did, for its toast. */
function recomputeDone(d) {
  const updated = { n: fmt(d.updated) };
  return (
    (d.updated === 1
      ? t('recompute.doneOne', updated)
      : t('recompute.doneMany', updated)) +
    (d.gainedPp > 0
      ? t('recompute.gained', { n: fmt(d.gainedPp) })
      : '') +
    (d.skipped > 0
      ? t('recompute.skipped', { n: fmt(d.skipped) })
      : '')
  );
}

/*
 * `all` is every score of every profile, and is announced by the `recompute` event it sends
 * to every open page (see below) rather than here -- the same run starts by itself after an
 * update that brings a new calculator, with no page having asked for it.
 */
async function runRecompute(all = false) {
  recomputing = true;
  toast(t('recompute.running'));
  try {
    const d = await postJson('/api/recompute', { confirm: true, all }, 'recompute failed');
    if (!all) toast(recomputeDone(d));
  } catch (err) {
    toast(t('recompute.failed', { error: err.message }));
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
      const count = { n: fmt(p.scoreCount) };
      const plays =
        p.scoreCount === 1
          ? t('profiles.onePlay', count)
          : t('profiles.plays', count);
      const since = new Date(p.trackingSince).toLocaleDateString(currentLocale());
      // The only profile cannot be deleted: the app must always have somewhere to write.
      const canDelete = profiles.length > 1;
      return `<div class="profile-row${p.active ? ' profile-row--active' : ''}">
        <div class="profile-row__name">
          ${escapeHtml(p.name)}
          <div class="profile-row__meta">${plays} &middot; ${escapeHtml(
            t('profiles.since', { date: since }),
          )}</div>
        </div>
        <div class="profile-row__actions">
          ${
            p.active
              ? ''
              : `<button type="button" data-act="switch" data-id="${p.id}">${escapeHtml(
                  t('profiles.switchTo'),
                )}</button>`
          }
          <button type="button" data-act="rename" data-id="${p.id}">${escapeHtml(t('profiles.rename'))}</button>
          <button type="button" class="danger" data-act="delete" data-id="${p.id}"
                  ${canDelete ? '' : `disabled title="${escapeHtml(t('profiles.onlyProfile'))}"`}>${escapeHtml(t('profiles.delete'))}</button>
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

/**
 * `section` opens it scrolled to Edit profile ('edit') or Import from osu! ('import'): the
 * avatar and the name open it at the first, the favorites reminder at the second, with only
 * favorites ticked.
 */
function openProfiles({ section = null, favoritesOnly = false } = {}) {
  // A shared copy is read-only.
  if (isStatic) return;
  setMenuOpen(false);
  $('newProfileName').value = '';
  profileHint(t('profiles.newStartsEmpty'));
  renderProfiles();
  renderProfileEdit();
  resetImport({ favoritesOnly });
  $('sharedFavorites').checked = app.config?.sharedFavorites !== false;
  $('profilesModal').hidden = false;
  $('profilesModal').querySelector('.modal').scrollTop = 0;
  $('profilesClose').focus({ preventScroll: true });
  if (section) $(section === 'import' ? 'importSection' : 'profileEdit').scrollIntoView({ block: 'start' });
  void loadSuggestions();
}

const closeProfiles = () => { $('profilesModal').hidden = true; };

$('optProfiles').onclick = () => openProfiles();
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
      toast(t('profiles.nowTracking', { name: profile.name }));
      await Promise.all([loadState(), loadProfile()]);
      profileHint(t('profiles.switched', { name: profile.name }));
      return;
    }

    if (button.dataset.act === 'rename') {
      const name = prompt(t('profiles.renamePrompt'), profile.name);
      if (name === null || name.trim() === profile.name) return;
      await profileAction({ action: 'rename', id, name });
      await loadState();
      profileHint(t('profiles.renamed', { name: name.trim() }));
      return;
    }

    if (button.dataset.act === 'delete') {
      const doomed = { name: profile.name, n: profile.scoreCount };
      const warning =
        profile.scoreCount > 0
          ? `${
              profile.scoreCount === 1
                ? t('profiles.deleteOneAsk', doomed)
                : t('profiles.deleteManyAsk', doomed)
            }\n\n${t('profiles.deleteWarning')}`
          : t('profiles.deleteEmptyAsk', doomed);
      if (!confirm(warning)) return;
      const data = await profileAction({ action: 'delete', id, confirm: true });
      toast(t('profiles.deletedToast', {
        name: profile.name,
        n: fmt(data.deletedScores),
      }));
      await Promise.all([loadState(), loadProfile()]);
      profileHint(t('profiles.deleted', { name: profile.name }));
    }
  } catch (err) {
    profileHint(err.message, true);
  }
};

$('profileCreate').onclick = async () => {
  const name = $('newProfileName').value.trim();
  if (!name) {
    profileHint(t('profiles.needName'), true);
    $('newProfileName').focus();
    return;
  }
  try {
    await profileAction({ action: 'create', name });
    $('newProfileName').value = '';
    toast(t('profiles.createdToast', { name }));
    await Promise.all([loadState(), loadProfile()]);
    profileHint(t('profiles.created', { name }));
  } catch (err) {
    profileHint(err.message, true);
  }
};

$('newProfileName').onkeydown = (e) => {
  if (e.key === 'Enter') $('profileCreate').click();
};

/* ------------------------------------------------------- export and backup */

/*
 * Both are plain downloads, from Share & back up. Navigating rather than fetching lets the browser handle the
 * save dialog and the filename from content-disposition, and keeps a 20MB database out
 * of the page's memory.
 */
$('shareExport').onclick = () => {
  window.location.href = '/api/export';
  toast(t('backup.exporting'));
};

$('shareBackup').onclick = () => {
  window.location.href = '/api/backup';
  toast(t('backup.backingUp'));
};

$('openDataFolder').onclick = async () => {
  try {
    await postJson('/api/data-folder/open', {}, t('backup.openFailed'));
  } catch (err) {
    shareHint(err.message, true);
  }
};

/*
 * Restore, in two steps: the file is uploaded and checked, the page says which profiles it
 * holds, and only a yes applies it. Applying restarts the app, because the backup is swapped
 * in before the database opens (src/backup.ts), and this page reloads once it is back.
 */
$('shareRestore').onclick = () => {
  $('restoreFile').value = '';
  $('restoreFile').click();
};

$('restoreFile').onchange = async () => {
  const file = $('restoreFile').files?.[0];
  if (!file) return;
  $('shareRestore').disabled = true;
  shareHint(t('restore.checking'));
  try {
    const r = await fetch('/api/restore', { method: 'PUT', body: file });
    const staged = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(staged.error ?? t('restore.failed'));

    const lines = staged.profiles.map((p) => {
      const values = { name: p.name, n: fmt(p.plays) };
      return p.plays === 1 ? t('restore.profileOne', values) : t('restore.profileMany', values);
    });
    if (!confirm(`${t('restore.ask')}\n\n${lines.join('\n')}\n\n${t('restore.nothingDeleted')}`)) {
      await fetch('/api/restore', { method: 'DELETE' });
      shareHint(t('restore.cancelled'));
      return;
    }

    const before = await (await fetch('/api/app')).json();
    const applied = await postJson('/api/restore/apply', {}, t('restore.failed'));
    if (!applied.restarting) {
      shareHint(t('restore.restartYourself'));
      return;
    }
    shareHint(t('restore.restarting'));
    await reloadWhenRestarted(before.pid);
  } catch (err) {
    shareHint(err.message, true);
  } finally {
    $('shareRestore').disabled = false;
  }
};

/** Reload once a different process answers, or say to restart by hand after a minute. */
async function reloadWhenRestarted(pid) {
  for (let waited = 0; waited < 60; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const now = await (await fetch('/api/app')).json();
      if (now.pid !== pid) {
        location.reload();
        return;
      }
    } catch {
      /* not back yet */
    }
  }
  shareHint(t('restore.restartYourself'));
}

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
  $('backfillSources').hidden = true;
  $('backfillSources').innerHTML = '';
  $('backfillConfirm').disabled = true;
  $('backfillConfirm').textContent = 'Import';
}

/**
 * Each kind of past play a preview found, a ticked box with its count. Replays, unfinished plays
 * osu! counted and attempts osu! could not submit are separate choices because they are separate
 * decisions: last week's offline retries say nothing about wanting last week's replays too.
 */
function renderBackfillSources(counts) {
  const kinds = [
    ['replays', t('backfill.finishedPlays'), counts.replays],
    ['unfinished', t('backfill.unfinishedPlays'), counts.unfinished],
    ['attempts', t('backfill.unsubmittedPlays'), counts.attempts],
  ].filter(([, , n]) => n > 0);
  $('backfillSources').innerHTML = kinds
    .map(
      ([kind, label, n]) =>
        `<label class="checkgroup__item"><input type="checkbox" data-source="${kind}" data-count="${n}" checked> ${escapeHtml(label)} (${fmt(n)})</label>`,
    )
    .join('');
  $('backfillSources').hidden = kinds.length === 0;
  updateBackfillConfirm();
}

/** Import names how much it will bring in, and is only on while that is something. */
function updateBackfillConfirm() {
  const ticked = [...$('backfillSources').querySelectorAll('input[data-source]:checked')];
  const total = ticked.reduce((sum, box) => sum + Number(box.dataset.count), 0);
  $('backfillConfirm').disabled = total === 0;
  $('backfillConfirm').textContent =
    total > 0
      ? t('backfill.importN', { n: fmt(total) })
      : t('backfill.import');
}

$('backfillSources').onchange = updateBackfillConfirm;

/** Whether this import should be judged by the play tracking filter. */
const backfillApplyFilter = () => $('backfillFiltered').checked;

/**
 * What ticking the box would actually do, said under it.
 *
 * Three states, because the box means something different in each: a filter that is set and
 * narrowing something, one that exists but lets everything through, and none at all. The last
 * is the one worth a prompt -- somebody who wants a filtered import has to be told where the
 * filter lives, since nothing on this dialog creates one.
 */
function renderBackfillFilterHint() {
  const hint = $('backfillFilterHint');
  const on = backfillApplyFilter();
  if (!filterNarrowing) {
    hint.innerHTML = t('backfill.noFilter');
    return;
  }
  hint.innerHTML = on
    ? t('backfill.filterOn')
    : t('backfill.filterOff');
}

$('backfillFiltered').onchange = () => {
  renderBackfillFilterHint();
  // The counts came from the other answer, so they are no longer the ones this would import.
  resetBackfillPreview(t('backfill.filterChanged'));
};

/* The prompt to the filter itself. One dialog at a time, so this closes on the way. */
$('backfillFilterHint').onclick = (e) => {
  if (!e.target.closest('#backfillOpenFilter')) return;
  closeBackfill();
  $('optFilter').click();
};

function openBackfill() {
  setMenuOpen(false);
  markPreset(3);
  $('backfillSince').value = toLocalInput(Date.now() - 3 * 3600_000);
  // Ticked every time it opens: an import agreeing with live tracking is the default, and a
  // decision to bypass the filter should be made for the import in front of you.
  $('backfillFiltered').checked = true;
  renderBackfillFilterHint();
  resetBackfillPreview(t('backfill.pickATime'));
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
  resetBackfillPreview(t('backfill.cutoffChanged'));
};

$('backfillSince').onchange = () => {
  markPreset(null);
  resetBackfillPreview(t('backfill.cutoffChanged'));
};

$('backfillCheck').onclick = async () => {
  const since = sinceValue();
  if (!Number.isFinite(since)) {
    resetBackfillPreview(t('backfill.badDate'));
    return;
  }

  $('backfillCheck').disabled = true;
  $('backfillSummary').textContent = t('backfill.scanning');
  try {
    const d = await postJson(
      '/api/backfill/preview',
      { since, applyFilter: backfillApplyFilter() },
      'preview failed',
    );

    /*
     * The tracking filter applies to an import too, so the preview has to account for it: the
     * answer to "why would only three of forty come in" is the filter, and switching it off is
     * the way to import everything.
     */
    // The star rating is the one criterion the preview does not check -- it costs a call to
    // osu!'s calculator per play -- so when it is set, the count is an upper bound and says so.
    const unchecked = d.starsUnchecked
      ? ` ${t('backfill.starsUnchecked')}`
      : '';

    // lazer's logs: the unfinished plays osu! counted and the attempts it could not submit.
    const log = d.log ?? { unfinished: 0, attempts: 0, alreadyTracked: 0, unresolved: 0, filtered: 0 };
    const found = d.importable + log.unfinished + log.attempts;
    const tracked = d.duplicates + log.alreadyTracked;
    const declined = d.filtered + log.filtered;
    /*
     * A count and its noun, as one translated sentence per noun and number. Gluing an "s"
     * onto a translated word is an English habit that produces nonsense everywhere else.
     *
     * Written out at each site rather than behind a helper taking key names: a key that is
     * not a literal argument to `t()` is one scripts/build-i18n.mjs cannot see, and a key
     * nothing can see is a key nobody notices has gone missing.
     */
    const replays = (n) =>
      n === 1 ? t('backfill.oneReplay', { n: fmt(n) }) : t('backfill.manyReplays', { n: fmt(n) });
    const plays = (n) =>
      n === 1 ? t('backfill.onePlay', { n: fmt(n) }) : t('backfill.manyPlays', { n: fmt(n) });
    const unfinishedPlays = (n) =>
      n === 1
        ? t('backfill.oneUnfinished', { n: fmt(n) })
        : t('backfill.manyUnfinished', { n: fmt(n) });
    /*
     * The tracking filter applies to an import too, so the preview says what it would decline:
     * the answer to "why only three of forty" is the filter, and switching it off imports them.
     */
    const filtered =
      declined > 0
        ? ` ${t('backfill.wouldBeFiltered', { n: fmt(declined) })}`
        : '';
    /*
     * Replays somebody else set. osu! caches the ones you watch in the same folders as the
     * ones you play, so a scan finds both -- and an import that brings in fewer plays than
     * the folder holds has to say why, or it just looks broken. Naming the players is the
     * quickest way to recognise them as replays you watched.
     */
    const others = d.otherPlayers ?? [];
    const otherTotal = others.reduce((n, p) => n + p.count, 0);
    const otherNames = others
      .slice(0, 3)
      .map((p) => p.name)
      .join(', ');
    const watched =
      otherTotal > 0
        ? ` ${t('backfill.othersFound', {
          replays: replays(otherTotal),
        })}` +
          `${
            otherNames
              ? ` (${otherNames}${
                  others.length > 3
                    ? t('backfill.andMore', { n: others.length - 3 })
                    : ''
                })`
              : ''
          }` +
          ` ${t('backfill.othersExplained')}`
        : '';

    if (found === 0) {
      resetBackfillPreview(
        tracked > 0 || declined > 0
          ? `${escapeHtml(t('backfill.nothingToImport'))}${escapeHtml(
              tracked > 0
                ? ` ${t('backfill.alreadyTracked', {
                  plays: plays(tracked),
                })}`
                : '',
            )}${escapeHtml(filtered)}${escapeHtml(watched)}`
          : `${escapeHtml(t('backfill.nonePlaysFound', { n: fmt(d.scanned) }))}${escapeHtml(watched)}`,
      );
      return;
    }

    const span =
      d.earliest && d.latest
        ? ` ${t('backfill.span', {
          from: new Date(d.earliest).toLocaleString(currentLocale()),
          to: new Date(d.latest).toLocaleString(currentLocale()),
        })}`
        : '';
    const dupes =
      tracked > 0
        ? ` ${t('backfill.leftAlone', { n: fmt(tracked) })}`
        : '';
    // A logged play on a beatmap no longer installed has no mode to be filed under.
    const unresolved =
      log.unresolved > 0
        ? ` ${t('backfill.unresolved', {
          plays: unfinishedPlays(log.unresolved),
        })}`
        : '';
    $('backfillSummary').innerHTML =
      t('backfill.foundHeadline', {
        plays: escapeHtml(plays(found)),
      }) +
      `${escapeHtml(span)}${escapeHtml(dupes)}${escapeHtml(filtered)}${escapeHtml(watched)}${escapeHtml(
        unresolved,
      )}${escapeHtml(unchecked)} ${escapeHtml(t('backfill.untick'))}`;
    renderBackfillSources({ replays: d.importable, unfinished: log.unfinished, attempts: log.attempts });
  } catch (err) {
    resetBackfillPreview(t('backfill.checkFailed', {
      error: escapeHtml(err.message),
    }));
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
    const sources = [...$('backfillSources').querySelectorAll('input[data-source]:checked')].map(
      (box) => box.dataset.source,
    );
    const d = await postJson(
      '/api/backfill',
      { since, confirm: true, sources, applyFilter: backfillApplyFilter() },
      'import failed',
    );
    const total = d.imported + (d.unfinished ?? 0) + (d.attempts ?? 0);
    toast(
      (total === 1
        ? t('backfill.importedOne', { n: fmt(total) })
        : t('backfill.importedMany', { n: fmt(total) })) +
        (d.filtered > 0
          ? t('backfill.importedFiltered', {
              n: fmt(d.filtered),
            })
          : ''),
    );
    closeBackfill();
    await Promise.all([loadProfile(), loadState()]);
  } catch (err) {
    resetBackfillPreview(t('backfill.importFailed', {
      error: escapeHtml(err.message),
    }));
  } finally {
    $('backfillCheck').disabled = false;
  }
};

/* ---------------------------------------------------- play tracking filter */

/*
 * Options -> Play tracking filter. The dialog itself lives in web/js/tracking-filter.js; this
 * is only the wiring, and the marker on the menu entry.
 *
 * The marker matters more than it looks: the filter is the one setting whose effect cannot be
 * undone later, so a profile that has one on must be able to see that from the menu rather
 * than by wondering where a play went. `filterNarrowing` comes from the server, which asks
 * src/tracking-filter.ts -- the page does not decide that for itself.
 */
function renderFilterMenu() {
  const button = $('optFilter');
  button.classList.toggle('menu__marked', Boolean(filterNarrowing));
  button.title = filterNarrowing
    ? t('filter.menuOn')
    : t('filter.menuOff');
}

$('optFilter').onclick = () => {
  setMenuOpen(false);
  openTrackingFilter({
    filter: settings.trackingFilter,
    profileName: profile?.name ?? 'this profile',
    hasLazer: installKinds.includes('lazer'),
    playsFiltered,
    onSaved: async (saved) => {
      settings = saved;
      await loadState();
    },
  });
};

$('filterCancel').onclick = closeTrackingFilter;
$('filterReset').onclick = resetTrackingFilter;
$('filterSave').onclick = () => void saveTrackingFilter();
$('filterModal').onclick = (e) => {
  if (e.target === $('filterModal')) closeTrackingFilter();
};

/* --------------------------------------------------------- reset profile */

let resetting = false;

function openReset() {
  setMenuOpen(false);
  const plays = stats?.playcount ?? 0;
  $('resetSummary').textContent =
    plays > 0
      ? plays === 1
        ? t('reset.oneWarning', { n: fmt(plays) })
        : t('reset.manyWarning', { n: fmt(plays) })
      : t('reset.nothingWarning');
  $('resetModal').hidden = false;
  $('resetCancel').focus();
}

function closeReset() {
  if (resetting) return;
  $('resetModal').hidden = true;
}

// From Profiles, under Edit profile, since it only touches the profile being tracked. Profiles
// closes first, so the question is not asked from behind it.
$('profileReset').onclick = () => {
  closeProfiles();
  openReset();
};
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
    toast(
      data.deleted === 1
        ? t('reset.doneOne', { n: fmt(data.deleted) })
        : t('reset.doneMany', { n: fmt(data.deleted) }),
    );
  } catch (err) {
    toast(t('reset.failed', { error: err.message }));
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

/*
 * One EventSource per tab, and a browser allows only six connections to an origin at once
 * (HTTP/1.1). A stream held open by every tab therefore spends the whole budget: at six tabs
 * nothing is left for the page itself, and a reload hangs forever with no error to show for
 * it. So only a *visible* tab keeps its stream; a hidden one gives the connection back and
 * picks a fresh one up when it returns, reloading to cover whatever it missed meanwhile.
 */
const handlers = {};
const on = (type, fn) => {
  handlers[type] = fn;
};

let es = null;

function openEvents() {
  if (es || quitHere) return;
  es = new EventSource('/api/events');
  for (const [type, fn] of Object.entries(handlers)) es.addEventListener(type, fn);
  /*
   * The stream is the first thing to notice the app going -- quit from its tray icon, or
   * restarting for an update. EventSource retries on its own, so the notice goes as soon as a
   * retry connects, and the page re-reads whatever changed while it was away.
   */
  es.addEventListener('error', () => {
    if (!document.hidden) showStopped(false);
  });
  es.addEventListener('open', () => {
    if ($('stoppedNotice').hidden) return;
    $('stoppedNotice').hidden = true;
    loadState();
    loadProfile();
  });
}

function closeEvents() {
  es?.close();
  es = null;
}
on('score', (e) => {
  const s = JSON.parse(e.data);
  // A play can now carry pp without counting toward the profile. Saying which keeps the
  // toast from reading as "+120pp" when the total underneath it has not moved.
  const counted = s.ranked || (settings.includeUnrankedMods && s.mapRanked);
  const shownPp = counting?.preferStrippedPp && s.ppNomod != null ? s.ppNomod : s.pp;
  const pp =
    shownPp == null
      ? ''
      : `${fmt(shownPp, 0)}pp${counted ? '' : ` ${t('live.notCounted')}`}`;
  toast(
    `${s.grade} ${pct(s.accuracy)} ${pp} - ${original(s.title, s.titleOriginal)}`.replace(/\s+/g, ' '),
  );
  if (s.mode === mode) loadProfile();
  loadState();
});
/*
 * A play that was started and never finished. It moves the play count and the charts, so
 * the page has to reload -- but there is nothing to put in a toast beyond which map it was,
 * and no grade or accuracy, because lazer keeps none of that for a play it discards.
 */
on('incomplete', (e) => {
  const play = JSON.parse(e.data);
  // An attempt osu! could not submit may not count at all, depending on the setting, so the
  // toast says which kind it was rather than reading like a counted play.
  toast(
    play.unsubmitted
      ? t('live.notSubmitted', { title: original(play.title, play.titleOriginal) })
      : t('live.didntFinish', { title: original(play.title, play.titleOriginal) }),
  );
  if (play.mode === mode) loadProfile();
  loadState();
});
/*
 * A play the tracking filter declined. Announced, because nothing else will ever mention it:
 * no row is written, so a silent drop is indistinguishable from tracking having stopped. The
 * criterion is named, so a filter set one notch too tight says which notch.
 */
on('filtered', (e) => {
  const play = JSON.parse(e.data);
  toast(t('live.notTracked', {
    criterion: play.criterion,
    title: original(play.title, play.titleOriginal),
  }));
  loadState();
});
on('tracking', (e) => setTracking(JSON.parse(e.data).tracking));
on('reset', () => {
  loadProfile();
  loadState();
});
// An import can add dozens of scores at once, so it refreshes the page rather than
// announcing each one the way a live play does.
on('backfill', () => {
  loadProfile();
  loadState();
});
/*
 * The same, for the import a launch runs by itself when the profile asks it to. Announced,
 * unlike the one above: nobody pressed a button for this one, so scores appearing without a
 * word would read as the app doing something it was not asked to.
 */
on('caught-up', (e) => {
  const r = JSON.parse(e.data);
  const added = r.imported + r.unfinished + r.attempts;
  if (added > 0) {
    toast(added === 1 ? t('catchUp.doneOne') : t('catchUp.doneMany', { n: fmt(added) }));
  }
  loadProfile();
  loadState();
});
on('profiles', () => {
  loadProfile();
  loadState();
});
// Settings only change the header, but a second tab open on the same profile should not
// be left showing the old country.
on('indexing', (e) => renderIndexing(JSON.parse(e.data)));
on('settings', () => loadState());
on('identity', () => loadState());
// A second tab should read the install's options as they now are.
on('app-config', (e) => {
  app = { ...app, config: JSON.parse(e.data) };
});
// Pin, unpin and remove all change what the page should be showing.
// Another tab favouriting or unfavouriting changes this one's cards and menus.
on('favorites', () => loadProfile());
on('scores', () => {
  loadProfile();
  loadState();
});
// A recompute can run for a while on a large profile; report progress rather than looking
// frozen. The final `recompute` event is handled by whoever started it.
on('recompute-progress', (e) => {
  const p = JSON.parse(e.data);
  if (p.percent < 100) {
    toast(t('recompute.progress', {
      percent: p.percent,
    }));
  }
});
// Every profile's scores recalculated: from Other settings, or by itself after an update.
on('recompute', (e) => {
  const d = JSON.parse(e.data);
  if (!d.everyProfile) return;
  toast(recomputeDone(d));
  void Promise.all([loadState(), loadProfile()]);
});

/* --- language ------------------------------------------------------------ */

/**
 * Get the page into the right language before anything is drawn in the wrong one.
 *
 * Three answers, in order, and the order is the point: what this browser last chose (in
 * `localStorage`, so it survives a reload and is available *now*), what the app's config
 * says (authoritative, but it arrives with the first API response, after first paint), and
 * what the browser's own `Accept-Language` implies. The last is only a guess, so it is
 * offered on the first launch rather than applied silently.
 */
async function startLanguage() {
  /*
   * Always loaded, even for English. `en.json` is not only the fallback -- it is where the
   * English lives for every string the *scripts* build, which the HTML has no copy of.
   * Skipping it when the answer was already English left `t('folders.inUse')` with nowhere
   * to look, and the page rendered its own key on a badge.
   */
  await useLocale(storedLocale() ?? DEFAULT_LOCALE);
  bindLanguagePicker(() => {
    // Everything the scripts drew is in the old language; the HTML has already been
    // re-translated in place by useLocale.
    renderAll();
  });
}

/**
 * Redraw everything the page builds itself, after the language changes underneath it.
 *
 * The HTML has already been re-translated in place by `useLocale`; this is the rest -- every
 * card, label and heading the scripts wrote, which is most of the page and is still in the
 * language it was drawn in.
 */
function renderAll() {
  refreshLanguageButton();
  void loadState();
  void loadProfile();
}

/**
 * The language the app has stored, applied once it arrives.
 *
 * `loadState` brings the config, which is after the first paint -- so this only does
 * anything when the app's answer differs from what this browser had remembered, which
 * happens on a machine's second browser, or after the choice was made elsewhere.
 */
async function applyConfigLanguage() {
  const wanted = app.config?.language;
  if (!knownLocale(wanted) || wanted === currentLocale()) return;
  await useLocale(wanted);
  renderAll();
}

/**
 * The app's answer on original-language metadata, applied once it arrives.
 *
 * The same arrangement as `applyConfigLanguage`, and for the same reason: this browser's own
 * `localStorage` is what the page started in, and the config -- which comes with the first
 * API response, after the first paint -- is what the *app* was told. It only does anything on
 * a second browser, or after the switch was thrown somewhere else.
 *
 * A config that has never said -- an older `config.json` -- leaves this browser's answer
 * alone rather than overruling it with a default.
 */
function applyConfigOriginalMetadata() {
  const wanted = app.config?.originalMetadata;
  if (typeof wanted !== 'boolean' || !setPreferOriginalMetadata(wanted)) return;
  refreshLanguageButton();
  void loadProfile();
}

/* ------------------------------------------------------------------ boot */

applyExportMode();
bindOsuFolders();
await startLanguage();
await loadState();
applySectionOrder();
await loadProfile();
// Tells the screenshot renderer the page has finished drawing itself.
document.body.dataset.rendered = 'true';

// A brand-new install is offered the account import once. Never on a shared copy, and never
// under ?export=1, which is what the Share image is rendered from.
if (welcomeOffered && !isStatic && !document.body.classList.contains('export-mode')) {
  void openWelcome();
}

openEvents();

/*
 * `visibilitychange` covers a background tab, `pagehide` a tab being navigated away or put
 * into the back/forward cache -- neither releases the connection on its own.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    closeEvents();
    return;
  }
  openEvents();
  // Events that arrived while the stream was shut are simply gone; re-read rather than
  // leave the tab showing whatever it had when it was hidden.
  loadState();
  loadProfile();
});
window.addEventListener('pagehide', closeEvents);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) openEvents();
});

setInterval(loadState, 15000);
