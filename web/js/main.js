/**
 * Page controller: fetches state, renders, and keeps up with live scores over SSE.
 *
 * There is no framework here on purpose (see docs/phase-2-handoff.md). Every update is a
 * refetch followed by a re-render of the affected block, which is plenty for a page that
 * changes once every few minutes when a play lands.
 */
import { MODE_NAMES, escapeHtml, fmt, pct } from './format.js';
import { coverUrl, generatedAvatar, gradeBadge, levelBadge } from './badges.js';
import { playcountChart, ppChart, rankChart } from './charts.js';
import { activityList, beatmapPlaycountList, playList } from './sections.js';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  ['recent', 'Recent'],
  ['top_ranks', 'Top Ranks'],
  ['historical', 'Historical'],
];

/* The five grades osu! counts on a profile. XH/X and SH/S are the silver variants. */
const GRADE_ORDER = ['XH', 'X', 'SH', 'S', 'A'];

let mode = 0;
let tracking = false;
let modesWithPlays = [];
let profile = null;
let stats = null;

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

function renderSectionTabs() {
  $('sectionTabs').innerHTML = SECTIONS.map(
    ([id, label]) => `<a class="page-mode__item" href="#section-${id}">${escapeHtml(label)}</a>`,
  ).join('');
}

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

  $('topCount').textContent = fmt(data.top.length);
  $('topRanks').innerHTML = playList(data.top, {
    showWeight: true,
    empty: 'No ranked plays tracked yet.',
  });

  const chart = playcountChart(data.monthlyPlaycounts);
  $('playcountChart').innerHTML = chart;
  $('playcountChart').hidden = chart === '';

  $('mostPlayedCount').textContent = fmt(data.mostPlayed.length);
  $('mostPlayed').innerHTML = beatmapPlaycountList(data.mostPlayed);

  $('recentCount').textContent = fmt(data.recent.length);
  $('recentPlays').innerHTML = playList(data.recent, {
    empty: 'Nothing yet - go set a play.',
  });
}

async function loadState() {
  const s = await (await fetch('/api/state')).json();
  profile = s.profile;
  modesWithPlays = s.modesWithPlays ?? [];

  const kinds = s.installs.map((i) => i.kind).join(' + ') || 'no client found';
  $('optInfo').textContent = `${s.profile.name} - watching ${kinds} - ${s.scoresThisSession} score${
    s.scoresThisSession === 1 ? '' : 's'
  } this session`;

  setTracking(s.tracking);
  renderIdentity();

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
});

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
    toast(`Profile reset - ${data.deleted} score${data.deleted === 1 ? '' : 's'} erased`);
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
  toast(
    `${s.grade} ${pct(s.accuracy)} ${s.pp != null ? `${fmt(s.pp, 0)}pp` : ''} - ${s.title}`.replace(/\s+/g, ' '),
  );
  if (s.mode === mode) loadProfile();
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

/* ------------------------------------------------------------------ boot */

renderSectionTabs();
await loadState();
await loadProfile();
setInterval(loadState, 15000);
