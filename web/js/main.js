/**
 * Page controller: fetches state, renders, and keeps up with live scores over SSE.
 *
 * There is no framework here on purpose (see docs/phase-2-handoff.md). Every update is a
 * refetch followed by a re-render of the affected block, which is plenty for a page that
 * changes once every few minutes when a play lands.
 */
import { MODE_NAMES, escapeHtml, fmt, fullDate, pct, shortDate } from './format.js';
import {
  coverUrl,
  generatedAvatar,
  gradeBadge,
  levelBadge,
  medalPlaceholder,
} from './badges.js';
import { playcountChart, ppChart, rankChart } from './charts.js';
import {
  aboutHtml,
  activityList,
  beatmapPlaycountList,
  countingNoteText,
  playList,
} from './sections.js';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  ['me', 'me!'],
  ['recent', 'Recent'],
  ['top_ranks', 'Top Ranks'],
  ['medals', 'Medals'],
  ['historical', 'Historical'],
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
    label: 'Unfinished plays in Recent',
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

let mode = 0;
let tracking = false;
let modesWithPlays = [];
let profile = null;
let stats = null;
let settings = {};
let counting = null;
let staleScores = 0;
let hiddenScoreCount = 0;
let sharing = { onNetwork: false, addresses: [], canScreenshot: false };

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
    // The flag image is decoration: if it fails, or there is no network, the code pill
    // beside it still says which country this is.
    bits.push(`<span class="profile-info__flag">
      <span class="profile-info__flag-code">${escapeHtml(code)}</span>
    </span>`);
  }
  if (profile.tagline) bits.push(`<span class="profile-info__tagline">${escapeHtml(profile.tagline)}</span>`);
  $('pflags').innerHTML = bits.join('');
}

/**
 * osu! shows a user-chosen cover here. A fresh profile has none, so it falls back to the
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
  renderModes();
  loadProfile();
});

/* ----------------------------------------------------------- detail block */

function renderStats(next) {
  stats = next;
  $('totalPp').textContent = fmt(stats.totalPp, 0);
  $('rankedMaps').textContent = fmt(stats.distinctRankedBeatmaps);
  $('bonusPp').textContent = fmt(stats.bonusPp, 0);

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
  $('countingNote').textContent = text;
  $('countingNote').hidden = text === '';
}

/**
 * The Medals section, grouped the way osu! groups it.
 *
 * osu!'s own icon is used where it loads, over a generated placeholder that stays visible
 * if it does not -- the same arrangement as beatmap covers, and for the same reason: the
 * page has to be complete with no network.
 */

/** Labels for each family, and the order they appear in. */
const MEDAL_GROUPS = [
  ['combo', 'Combo'],
  ['hits', 'Hits'],
  ['plays', 'Plays'],
  ['rank', 'Rank'],
  ['pass', 'Beatmap Pass'],
  ['fc', 'Beatmap Full Combo'],
];

/** What a locked medal still needs, said in the family's own terms. */
function medalRequirement(medal) {
  switch (medal.family) {
    case 'combo':
      return `Reach a combo of ${fmt(medal.threshold)}`;
    case 'plays':
      return `Play ${fmt(medal.threshold)} times`;
    case 'hits':
      return `Land ${fmt(medal.threshold)} hits`;
    case 'rank':
      return `Reach the top ${fmt(medal.threshold)}`;
    case 'pass':
      return `Pass a ${medal.threshold}-star beatmap`;
    case 'fc':
      return `Full combo a ${medal.threshold}-star beatmap`;
    default:
      return '';
  }
}

function medalTile(medal) {
  const earned = medal.achievedAt !== null;

  /*
   * Earned medals show the date and nothing else. The beatmap that earned it is worth
   * knowing but not worth five wrapped lines in a 104px tile, so it goes in the tooltip.
   */
  const detail = earned ? shortDate(medal.achievedAt) : medalRequirement(medal);

  // A percentage only means something for the families that are a running total.
  const bar =
    !earned && medal.progress !== null && medal.progress > 0
      ? `<div class="medal__progress" title="${Math.round(medal.progress * 100)}% of the way there">
           <div class="medal__progress-fill" style="width: ${Math.round(medal.progress * 100)}%"></div>
         </div>`
      : '';

  const tooltip = [
    medal.name,
    medal.description,
    earned
      ? `Earned ${fullDate(medal.achievedAt)}${medal.earnedOn ? ` on ${medal.earnedOn}` : ''}`
      : medalRequirement(medal),
  ].join(' - ');

  return `<div class="medal${earned ? '' : ' medal--locked'}" title="${escapeHtml(tooltip)}">
    <div class="medal__icon">
      ${medalPlaceholder(medal)}
      <!-- Not lazy: a full-page screenshot renders below the fold without ever
           scrolling there, and lazy icons never loaded. 32 small PNGs is nothing. -->
      <img src="${escapeHtml(medal.icon)}" alt="">
    </div>
    <div class="medal__name u-ellipsis">${escapeHtml(medal.name)}</div>
    <div class="medal__detail">${escapeHtml(detail)}</div>
    ${bar}
  </div>`;
}

function renderMedals(summary) {
  if (!summary) return;

  $('medalCount').textContent = `${fmt(summary.earned)} / ${fmt(summary.total)}`;

  /*
   * An FC cannot be told from a near-miss without the beatmap's own maximum combo, which
   * older scores were never given. Say so rather than quietly under-awarding, and point at
   * the fix.
   */
  const note = $('medalsNote');
  if (summary.fcUnknown > 0) {
    note.hidden = false;
    note.textContent =
      `${fmt(summary.fcUnknown)} play${summary.fcUnknown === 1 ? '' : 's'} ` +
      `${summary.fcUnknown === 1 ? 'was' : 'were'} tracked before this app recorded each ` +
      "beatmap's maximum combo, so a full combo cannot be told apart from a near-miss on " +
      'them. Settings can recalculate those from their replay files.';
  } else {
    note.hidden = true;
  }

  const groups = MEDAL_GROUPS.map(([family, label]) => {
    const medals = summary.medals.filter((m) => m.family === family);
    if (medals.length === 0) return '';
    const earned = medals.filter((m) => m.achievedAt !== null).length;
    return `<h3 class="title title--sub">${escapeHtml(label)}
        <span class="title__count">${fmt(earned)} / ${fmt(medals.length)}</span>
      </h3>
      <div class="medal-grid">${medals.map(medalTile).join('')}</div>`;
  }).join('');

  $('medalGroups').innerHTML =
    groups || '<div class="u-empty">No medals apply to this mode yet.</div>';
}

/* ------------------------------------------------------------------ data */

async function loadProfile() {
  const data = await (await fetch(`/api/profile?mode=${mode}`)).json();

  renderStats(data.stats);
  renderCover(data.top);

  renderRank(data);

  // osu-web charts global rank; fall back to pp when no rank curve exists for this mode.
  const rankPoints = (data.rankHistory ?? []).filter((p) => p.rank != null);
  $('ppChart').innerHTML = rankPoints.length
    ? rankChart(rankPoints)
    : ppChart(data.ppHistory, data.stats.playcount > 0 ? 'no ranked plays yet' : 'unranked');

  $('recentActivity').innerHTML = activityList(data.events);

  renderCountingNote(data.counting);
  renderMedals(data.medals);

  // Held for the menu's Move up / Move down and for drag reordering, both of which work in
  // terms of positions in this list.
  pinnedIds = (data.pinned ?? []).map((p) => p.id);
  $('pinnedCount').textContent = fmt(pinnedIds.length);
  $('pinnedPlays').innerHTML = playList(data.pinned, {
    actions: true,
    reorderable: true,
    empty: 'Nothing pinned. Use the menu on any score to pin it here.',
  });

  $('topCount').textContent = fmt(data.top.length);
  $('topRanks').innerHTML = playList(data.top, {
    showWeight: true,
    actions: true,
    empty:
      settings.includeUnrankedMods || settings.includeUnrankedMaps?.length
        ? 'No plays with a pp value tracked yet.'
        : 'No ranked plays tracked yet.',
  });

  const chart = playcountChart(data.monthlyPlaycounts);
  $('playcountChart').innerHTML = chart;
  $('playcountChart').hidden = chart === '';

  $('mostPlayedCount').textContent = fmt(data.mostPlayed.length);
  $('mostPlayed').innerHTML = beatmapPlaycountList(data.mostPlayed);

  $('recentCount').textContent = fmt(data.recent.length);
  $('recentPlays').innerHTML = playList(data.recent, {
    actions: true,
    empty: 'Nothing yet - go set a play.',
  });
}

async function loadState() {
  const s = await (await fetch('/api/state')).json();
  profile = s.profile;
  profiles = s.profiles ?? [];
  settings = s.settings ?? {};
  staleScores = s.staleScores ?? 0;
  hiddenScoreCount = s.hiddenScores ?? 0;
  sharing = s.sharing ?? sharing;
  modesWithPlays = s.modesWithPlays ?? [];

  const kinds = s.installs.map((i) => i.kind).join(' + ') || 'no client found';
  $('optInfo').textContent = `${s.profile.name} - watching ${kinds} - ${s.scoresThisSession} score${
    s.scoresThisSession === 1 ? '' : 's'
  } this session`;

  setTracking(s.tracking);
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
  const r = await (
    await fetch('/api/tracking', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !tracking }),
    })
  ).json();
  setTracking(r.tracking);
};

/* ----------------------------------------------------------------- toast */

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
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
  setMenuOpen(false);
  if (!$('resetModal').hidden) closeReset();
  if (!$('backfillModal').hidden) closeBackfill();
  if (!$('profilesModal').hidden) closeProfiles();
  if (!$('settingsModal').hidden) closeSettings();
  if (!$('playMenu').hidden) closePlayMenu();
  if (!$('identityModal').hidden) closeIdentity();
  if (!$('shareModal').hidden) closeShare();
});

/* ------------------------------------------------------------------ share */

/*
 * Three ways to hand this profile to someone else, in order of how well they survive.
 *
 * 1. A standalone .html file. One file, opens anywhere, needs neither this app nor a
 *    network. It is built from the *live page* rather than re-rendered on the server, so
 *    it captures exactly what is on screen -- the section order, the medals, everything --
 *    and cannot drift from it.
 * 2. A PNG, rendered by a browser that is already installed.
 * 3. The page itself, over the local network, which is off by default.
 */

/** Elements that only make sense while you are using the page, not while reading it. */
const EXPORT_STRIP = [
  '#optionsBtn', '.menu-wrap', '#toggle', '.backdrop', '#playMenu', '#toast',
  '#identityFile', '.section-order', '.play-detail__menu', '.play-detail__grip',
  '#aboutEdit', 'script',
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

  // Anything served by this app has to be carried, or the file breaks the moment it moves.
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
<!-- osu! fresh profile - "${profile?.name ?? 'profile'}" as of ${when}. Not an osu! page. -->
${clone.outerHTML}`;
}

/** Hand the browser a file to save, without going near the server. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const safeName = () =>
  `${(profile?.name ?? 'profile').replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}`;

function shareHint(message, isError = false) {
  const el = $('shareHint');
  el.textContent = message;
  el.classList.toggle('profile-hint--error', isError);
}

function openShare() {
  setMenuOpen(false);
  shareHint(' ');

  const addresses = sharing.addresses ?? [];
  $('shareNetwork').innerHTML = sharing.onNetwork
    ? `<p>Anyone on your network can open this profile at:</p>
       ${addresses.map((a) => `<code class="share-url">${escapeHtml(a)}</code>`).join('') ||
         '<p class="setting__hint">No network address was found for this machine.</p>'}
       <p class="setting__hint">
         Sharing is on. Remember that anyone who can open the page can also use it &mdash;
         including resetting this profile. Turn it off in <code>data/config.json</code>.
       </p>`
    : `<p class="setting__hint">
         This profile is private to this machine. To let someone on the same network open
         it live, set <code>"shareOnNetwork": true</code> in <code>data/config.json</code>
         and restart.
       </p>
       <p class="setting__hint">
         It is off by default because the page can reset this profile, delete a profile and
         remove scores, and none of that asks who is calling.
       </p>`;

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
 * read: ids that no longer exist are dropped and new ones are appended. That is what makes
 * adding a section later safe -- a saved order from before it existed still works, and the
 * new section simply turns up at the bottom instead of vanishing.
 */

const DEFAULT_ORDER = SECTIONS.map(([id]) => id);

function reconcileOrder(saved) {
  const seen = new Set();
  const out = [];
  for (const id of saved ?? []) {
    if (!DEFAULT_ORDER.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of DEFAULT_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

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
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionOrder: order }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'saving the order failed');
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
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aboutMe: $('aboutText').value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'saving failed');
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

function identityHint(message, isError = false) {
  const el = $('identityHint');
  el.textContent = message;
  el.classList.toggle('profile-hint--error', isError);
}

async function identityAction(payload) {
  const r = await fetch('/api/identity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? 'that did not work');
  return d;
}

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

/** What can be offered without touching the network: the osu! session, and any link. */
function renderIdentitySuggestions() {
  const bits = [];
  for (const session of identitySuggestions.sessions ?? []) {
    bits.push(
      `<button type="button" class="identity-suggestion" data-query="${escapeHtml(session.username)}">
         Use <b>${escapeHtml(session.username)}</b>
         <span>signed in to osu!${escapeHtml(session.client)}</span>
       </button>`,
    );
  }
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
  $('identityQuery').value = '';
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

  const suggestion = e.target.closest('[data-query]');
  if (suggestion) {
    $('identityQuery').value = suggestion.dataset.query;
    $('identityLookup').click();
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

/* --- borrowing from an osu! account ------------------------------------- */

$('identityLookup').onclick = async () => {
  const query = $('identityQuery').value.trim();
  if (!query) {
    identityHint('Type a username, a user id, or a link to a profile.', true);
    return;
  }

  $('identityLookup').disabled = true;
  identityHint(`Looking up "${query}" on osu.ppy.sh...`);
  try {
    const { user } = await identityAction({ action: 'lookup', query });
    // Shown before anything is applied: one press to look, another to use what was found.
    $('identityFound').innerHTML = `<div class="identity-candidate">
      <img class="identity-candidate__avatar" src="${escapeHtml(user.avatarUrl ?? '')}" alt="">
      <div class="identity-candidate__detail">
        <b>${escapeHtml(user.username)}</b>
        <span>#${fmt(user.id)}${user.countryCode ? ` &middot; ${escapeHtml(user.countryCode)}` : ''}</span>
      </div>
      <button type="button" id="identityUse">Use this</button>
    </div>`;
    identityHint('Found. "Use this" copies the picture and banner here.');
  } catch (err) {
    $('identityFound').innerHTML = '';
    identityHint(err.message, true);
  } finally {
    $('identityLookup').disabled = false;
  }
};

$('identityFound').addEventListener('click', async (e) => {
  if (!e.target.closest('#identityUse')) return;
  const query = $('identityQuery').value.trim();

  identityHint('Copying the picture and banner...');
  try {
    const d = await identityAction({ action: 'link', query });
    identitySuggestions.linked = { id: d.user.id, username: d.user.username };
    await loadState();
    renderIdentityPreviews();
    renderIdentitySuggestions();
    await loadProfile();
    identityHint(
      d.failures?.length
        ? `Linked to ${d.user.username}, but ${d.failures.join('; ')}`
        : `Linked to ${d.user.username}.`,
      Boolean(d.failures?.length),
    );
  } catch (err) {
    identityHint(err.message, true);
  }
});

/* ---------------------------------------------------------------- settings */

function settingsHint(message, isError = false) {
  const el = $('settingsHint');
  el.textContent = message;
  el.classList.toggle('profile-hint--error', isError);
}

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
        </div>`,
      )
      .join('');
  } catch (err) {
    $('removedList').innerHTML = `<div class="setting__hint">${escapeHtml(err.message)}</div>`;
  }
}

$('removedList').onclick = async (e) => {
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
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'saving failed');

    // Only free text can be rejected; a checkbox or a select cannot hold a bad value.
    const rejected = SETTINGS_FIELDS.filter(
      (f) =>
        (f.type ?? 'text') === 'text' &&
        String(patch[f.key]).trim() !== '' &&
        String(d.settings[f.key] ?? '') === '',
    );
    settings = d.settings;
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

async function scoreAction(payload) {
  const r = await fetch('/api/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? 'that did not work');
  return d;
}

function closePlayMenu() {
  $('playMenu').hidden = true;
  $('playMenu').dataset.id = '';
}

/**
 * Open the shared popover beside the button that asked for it.
 *
 * Positioned in viewport coordinates and clamped to the right edge, because the row it
 * belongs to is inside a panel that would otherwise clip it.
 */
function openPlayMenu(button) {
  const menu = $('playMenu');
  const id = Number(button.dataset.id);
  const pinned = button.dataset.pinned === '1';
  const index = pinnedIds.indexOf(id);

  menu.dataset.id = String(id);
  menu.querySelector('[data-act="pin"]').hidden = pinned;
  menu.querySelector('[data-act="unpin"]').hidden = !pinned;
  // Reordering only means something for a pin that has somewhere to go.
  menu.querySelector('[data-act="move-up"]').hidden = !pinned || index <= 0;
  menu.querySelector('[data-act="move-down"]').hidden =
    !pinned || index < 0 || index >= pinnedIds.length - 1;

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
    const open = !$('playMenu').hidden && $('playMenu').dataset.id === button.dataset.id;
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
  const act = button.dataset.act;
  closePlayMenu();

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
    await Promise.all([loadProfile(), loadState()]);
  } catch (err) {
    toast(err.message);
  }
};

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

async function runRecompute() {
  recomputing = true;
  toast('Recalculating stored scores from their replays...');
  try {
    const r = await fetch('/api/recompute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'recompute failed');
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

function profileHint(message, isError = false) {
  const el = $('profileHint');
  el.textContent = message;
  el.classList.toggle('profile-hint--error', isError);
}

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
  const r = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? 'that did not work');
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
    const r = await fetch('/api/backfill/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'preview failed');

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
    const r = await fetch('/api/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since, confirm: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? 'import failed');
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
    const r = await fetch('/api/profile/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'reset failed');
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
es.addEventListener('settings', () => loadState());
es.addEventListener('identity', () => loadState());
// Pin, unpin and remove all change what the page should be showing.
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
