/**
 * Page controller: fetches state, renders, and keeps up with live scores over SSE.
 *
 * There is no framework here on purpose (see docs/phase-2-handoff.md). Every update is a
 * refetch followed by a re-render of the affected block, which is plenty for a page that
 * changes once every few minutes when a play lands.
 */
import { MODE_NAMES, escapeHtml, fmt, pct } from './format.js';
import { coverUrl, generatedAvatar, gradeBadge, levelBadge } from './badges.js';
import { playcountChart, ppChart } from './charts.js';
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

/* ------------------------------------------------------------------ data */

async function loadProfile() {
  const data = await (await fetch(`/api/profile?mode=${mode}`)).json();

  renderStats(data.stats);
  renderCover(data.top);

  $('ppChart').innerHTML = ppChart(
    data.ppHistory,
    data.stats.playcount > 0 ? 'no ranked plays yet' : 'unranked',
  );

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
});

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

/* ------------------------------------------------------------------ boot */

renderSectionTabs();
await loadState();
await loadProfile();
setInterval(loadState, 15000);
