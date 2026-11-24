/**
 * Ranked Play and Daily Challenge on the profile (Show more details), as osu-web draws them:
 * ported from osu-web's `resources/js/profile-page/matchmaking.tsx` and `daily-challenge.tsx`
 * (the boxes beside the ranks, and their popups), and `detail-stats-v2/matchmaking.tsx` (the
 * Ranked Play card) and `daily-challenge.tsx`'s `renderV2` (the big box in the third column).
 *
 * `online` is `/api/profile`'s `online`: the linked account's figures as last read from osu!
 * (dotnet/App/OnlineStats.cs), or null when none has been read. Without them every place still
 * draws, with a dash, so the layout is osu!'s either way.
 */
import { escapeHtml, fmt, timeAgo } from './format.js';
import { t } from './i18n.js';
import { ratingChart } from './charts.js';
import {
  highestRankPool,
  participationTier,
  playedToday,
  rankedPlayTier,
  dailyChallengeTier,
  tierBadge,
  weeklyTier,
} from './ranked-play.js';

/* osu-web's `rulesetVariantIdToName`: mania's key-count pools. */
const VARIANTS = { 0: '', 4: '4k', 7: '7k' };

const fancy = (tier) => `style="--colour: var(--level-tier-${tier})"`;

/** osu-web's `formatRank`: `#1,234`, or a dash for none. */
const rankText = (rank) => (Number.isFinite(rank) && rank > 0 ? `#${fmt(rank)}` : '-');

/** What a place with nothing read says when pointed at. */
const noData = () => t('detail.noData');

/** A day count in the language's unit, the number wrapped as `wrap` says ("47d", "47 T"). */
function days(value, wrap = (n) => n) {
  const [before, after = ''] = t('dailyChallenge.days', { value: '\u0000' }).split('\u0000');
  return `${escapeHtml(before)}${wrap(fmt(value))}${escapeHtml(after)}`;
}

function weeks(value) {
  const [before, after = ''] = t('dailyChallenge.weeks', { value: '\u0000' }).split('\u0000');
  return `${escapeHtml(before)}${fmt(value)}${escapeHtml(after)}`;
}

/** The pool to show: the one picked from mania's key counts, else the active one ranked best. */
export function shownPool(online, poolId = null) {
  const pools = online?.rankedPlay ?? [];
  return (poolId !== null && pools.find((p) => p.poolId === poolId)) || highestRankPool(pools);
}

/* ------------------------------------------------------------ the popups */

/** matchmaking.tsx's popup: every pool, newest first, with its rank, wins, plays and rating. */
function rankedPlayPopup(pools) {
  const sorted = [...pools].sort((a, b) => b.poolId - a.poolId);
  const rating = (p) => (p.provisional
    ? `<span title="${escapeHtml(t('rankedPlay.provisional'))}">${fmt(p.rating)}*</span>`
    : fmt(p.rating));
  const rank = (p) => (p.provisional ? '-' : `<span class="u-fancy-text" ${fancy(rankedPlayTier(p.rating).colour)}>${rankText(p.rank)}</span>`);
  return `<div class="detail-popup matchmaking-popup" role="tooltip">
    <div class="matchmaking-popup__row">
      <div class="matchmaking-popup__key"></div>
      <div class="matchmaking-popup__value"></div>
      <div class="matchmaking-popup__value">${escapeHtml(t('rankedPlay.popupWins'))}</div>
      <div class="matchmaking-popup__value">${escapeHtml(t('rankedPlay.popupPlays'))}</div>
      <div class="matchmaking-popup__value">${escapeHtml(t('rankedPlay.popupRating'))}</div>
    </div>
    ${sorted.map((p) => `<div class="matchmaking-popup__row">
      <div class="matchmaking-popup__key">${escapeHtml(`${VARIANTS[p.variantId] ? `[${VARIANTS[p.variantId]}] ` : ''}${p.name}`)}</div>
      <div class="matchmaking-popup__value">${rank(p)}</div>
      <div class="matchmaking-popup__value">${fmt(p.firstPlacements)}</div>
      <div class="matchmaking-popup__value">${fmt(p.plays)}</div>
      <div class="matchmaking-popup__value">${rating(p)}</div>
    </div>`).join('')}
  </div>`;
}

/** daily-challenge.tsx's popup: participation and the current streaks, then the bests and placements. */
function dailyChallengePopup(stats) {
  const top = [
    [t('dailyChallenge.playcount'), participationTier(stats.playcount), days(stats.playcount)],
    [t('dailyChallenge.dailyStreakCurrent'), dailyChallengeTier(stats.dailyStreakCurrent), days(stats.dailyStreakCurrent)],
    [t('dailyChallenge.weeklyStreakCurrent'), weeklyTier(stats.weeklyStreakCurrent), weeks(stats.weeklyStreakCurrent)],
  ];
  const rows = [
    [t('dailyChallenge.dailyStreakBest'), days(stats.dailyStreakBest), dailyChallengeTier(stats.dailyStreakBest)],
    [t('dailyChallenge.weeklyStreakBest'), weeks(stats.weeklyStreakBest), weeklyTier(stats.weeklyStreakBest)],
    [t('dailyChallenge.top10p'), fmt(stats.top10pPlacements), null],
    [t('dailyChallenge.top50p'), fmt(stats.top50pPlacements), null],
  ];
  return `<div class="detail-popup daily-challenge-popup" role="tooltip">
    <div class="daily-challenge-popup__content daily-challenge-popup__content--top">
      ${top.map(([title, tier, value]) => `<div class="daily-challenge-popup__top-entry">
        <div class="daily-challenge-popup__top-title">${escapeHtml(title)}</div>
        <div class="daily-challenge-popup__value daily-challenge-popup__value--fancy daily-challenge-popup__value--top" ${fancy(tier)}>${value}</div>
      </div>`).join('')}
    </div>
    <div class="daily-challenge-popup__content daily-challenge-popup__content--main">
      ${rows.map(([key, value, tier]) => `<div class="daily-challenge-popup__row">
        <div class="daily-challenge-popup__key">${escapeHtml(key)}</div>
        <div class="daily-challenge-popup__value${tier ? ' daily-challenge-popup__value--fancy' : ''}" ${tier ? fancy(tier) : ''}>${value}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

/* --------------------------------------------- beside the ranks (less details) */

/** matchmaking.tsx: the best rank, in its tier's colours, and every pool on hover. */
export function rankedPlayBox(online) {
  const pools = online?.rankedPlay ?? [];
  const best = highestRankPool(pools);
  const value = best && !best.provisional
    ? `<span class="u-fancy-text" ${fancy(rankedPlayTier(best.rating).colour)}>${rankText(best.rank)}</span>`
    : '-';
  const popup = pools.length > 0 ? rankedPlayPopup(pools) : '';
  return `<div class="daily-challenge${popup ? ' detail-popup-owner' : ''}"${popup ? ' tabindex="0"' : ` title="${escapeHtml(noData())}"`}>
    <div class="daily-challenge__name">${escapeHtml(t('rankedPlay.title'))}</div>
    <div class="daily-challenge__value-box">
      <div class="daily-challenge__value daily-challenge__value--plain">${value}</div>
    </div>
    ${popup}
  </div>`;
}

/** daily-challenge.tsx's renderV1: total participation, ticked when the account took part today. */
export function dailyChallengeBox(online, now = Date.now()) {
  const stats = online?.dailyChallenge ?? null;
  const today = playedToday(stats, now);
  const name = t('dailyChallenge.title').split('\n').map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  const value = stats
    ? `<div class="daily-challenge__value" ${fancy(participationTier(stats.playcount))}>${days(stats.playcount)}</div>`
    : '<div class="daily-challenge__value daily-challenge__value--plain">-</div>';
  return `<div class="daily-challenge${today ? ' daily-challenge--played-today' : ''}${stats ? ' detail-popup-owner' : ''}"${stats ? ' tabindex="0"' : ` title="${escapeHtml(noData())}"`}>
    <div class="daily-challenge__name">${name}</div>
    <div class="daily-challenge__value-box">${value}</div>
    ${stats ? dailyChallengePopup(stats) : ''}
  </div>`;
}

/* ------------------------------------------------------- more details */

/** detail-stats-v2/matchmaking.tsx: the Ranked Play card. */
export function rankedPlayCard(online, poolId = null) {
  const pools = online?.rankedPlay ?? [];
  const pool = shownPool(online, poolId);
  const provisional = pool?.provisional ?? true;
  const tier = pool && !provisional ? rankedPlayTier(pool.rating) : null;
  const badge = tier ? tierBadge(pool) : 'Placeholder';
  const lustrous = tier?.title === 'Lustrous'
    ? `<div class="matchmaking-tier-badge__lustrous-rank-container"><span class="matchmaking-tier-badge__lustrous-rank">${fmt(pool.rank)}</span></div>`
    : '';

  // Mania's key counts, when there is more than one to pick from.
  const variants = pool && pool.rulesetId === 3 && pools.length > 1
    ? `<small class="profile-detail-stats-card__variants">${[...pools]
      .sort((a, b) => a.variantId - b.variantId)
      .map((p) => `<button type="button" class="profile-detail-stats-card__variant${p.poolId === pool.poolId ? ' profile-detail-stats-card__variant--active' : ''}" data-ranked-pool="${p.poolId}">${escapeHtml(VARIANTS[p.variantId] ?? '')}</button>`)
      .join('')}</small>`
    : '';

  const rating = pool
    ? provisional ? `<span title="${escapeHtml(t('rankedPlay.provisional'))}">${fmt(pool.rating)}*</span>` : fmt(pool.rating)
    : '-';
  const plays = pool?.plays ?? 0;
  const wins = pool?.firstPlacements ?? 0;

  let middle;
  if (!pool) {
    middle = '';
  } else if (provisional) {
    middle = `<div class="matchmaking-result matchmaking-result--provisional">
      <span class="matchmaking-result__provisional-icon">${GHOST}</span>
      <span>${escapeHtml(t('rankedPlay.provisionalHistory'))}</span>
    </div>`;
  } else {
    middle = `<div class="matchmaking-result">
      <div class="matchmaking-result__title">${escapeHtml(t('rankedPlay.recentHistory'))}</div>
      <div class="matchmaking-result__icons">${pool.recentHistory.map((m) => {
        const title = escapeHtml(timeAgo(m.at));
        const cls = `matchmaking-result-icon matchmaking-result-icon--result-${m.result}`;
        return Number.isFinite(m.roomId)
          ? `<a class="${cls}" href="https://osu.ppy.sh/multiplayer/rooms/${m.roomId}" target="_blank" rel="noopener" title="${title}"></a>`
          : `<span class="${cls}" title="${title}"></span>`;
      }).join('')}</div>
    </div>`;
  }

  let bottom;
  if (!pool || pool.recentHistory.length === 0) {
    bottom = `<div class="profile-detail-stats-card__empty-chart">${escapeHtml(t('rankedPlay.noRecentPlays'))}</div>`;
  } else if (provisional) {
    bottom = '<div class="profile-detail-stats-card__empty-chart"><strong>-</strong></div>';
  } else {
    bottom = `<div class="profile-detail-stats-card__chart">${ratingChart(pool.ratingHistory ?? [])}</div>`;
  }

  return `<div class="profile-detail-stats-card__top">
      <div class="profile-detail-stats-card__matchmaking-tier-badge">
        ${provisional && !pool ? '' : `<div class="matchmaking-tier-badge matchmaking-tier-badge--${badge}">${lustrous}</div>`}
      </div>
      <div class="profile-detail-stats-card__title"${pool ? '' : ` title="${escapeHtml(noData())}"`}>
        <div class="profile-detail-stats-card__title-icon"><span class="svg-icon svg-icon--multi"></span></div>
        <div class="u-relative">${escapeHtml(t('rankedPlay.title'))}${variants}</div>
      </div>
      <div class="profile-detail-stats-card__values profile-detail-stats-card__values--matchmaking-rating">
        <div class="value-display value-display--rank">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.rank'))}</div>
          <div class="value-display__value"><div class="rank-value rank-value--${tier?.colour ?? 'base'}"${tier ? ` ${fancy(tier.colour)}` : ''}>${rankText(provisional ? null : pool?.rank)}</div></div>
        </div>
        <div></div>
        <div class="value-display value-display--rank value-display--rank-small${provisional && pool ? ' value-display--provisional' : ''}">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.rating'))}</div>
          <div class="value-display__value">${rating}</div>
        </div>
        <div class="value-display value-display--rank value-display--rank-small">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.tier'))}</div>
          <div class="value-display__value">${escapeHtml(tier?.title ?? '-')}</div>
        </div>
      </div>
      <div class="profile-detail-stats-card__values profile-detail-stats-card__values--matchmaking-matches">
        <div class="value-display value-display--plain">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.plays'))}</div>
          <div class="value-display__value">${pool ? fmt(plays) : '-'}</div>
        </div>
        <div class="value-display value-display--plain">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.wins'))}</div>
          <div class="value-display__value">${pool ? fmt(wins) : '-'}</div>
        </div>
        <div class="value-display value-display--plain">
          <div class="value-display__label">${escapeHtml(t('rankedPlay.losses'))}</div>
          <div class="value-display__value">${pool ? fmt(plays - wins) : '-'}</div>
        </div>
      </div>
    </div>
    <div class="profile-detail-stats-card__middle profile-detail-stats-card__middle--matchmaking-play">${middle}</div>
    <div class="profile-detail-stats-card__bottom">${bottom}</div>`;
}

/** daily-challenge.tsx's renderV2: the big Daily Challenge box over the stats. */
export function dailyChallengeBig(online, now = Date.now()) {
  const stats = online?.dailyChallenge ?? null;
  const label = t('dailyChallenge.title').replace(/\n+/g, ' ');
  const badge = stats
    ? `<div class="profile-detail-stats-big__fancy-text" ${fancy(participationTier(stats.playcount))}>${days(stats.playcount, (n) => `<strong>${n}</strong>`)}</div>`
    : '<div class="profile-detail-stats-big__plain-text"><strong>-</strong></div>';
  return `<div class="profile-detail-stats-big${stats ? ' detail-popup-owner' : ''}"${stats ? ' tabindex="0"' : ` title="${escapeHtml(noData())}"`}>
    <div class="profile-detail-stats-big__icon"><div class="svg-icon svg-icon--daily-challenge"></div></div>
    <div class="profile-detail-stats-big__title-container">
      <div class="profile-detail-stats-big__label">${escapeHtml(label)}</div>
      ${escapeHtml(t('dailyChallenge.playcount'))}
    </div>
    <div class="profile-detail-stats-big__badge${playedToday(stats, now) ? ' profile-detail-stats-big__badge--daily-challenge-played' : ''}">${badge}</div>
    ${stats ? dailyChallengePopup(stats) : ''}
  </div>`;
}

/* Font Awesome Free's `ghost` (solid), as osu-web's `fas fa-ghost`: CC BY 4.0, see THIRD-PARTY-NOTICES.md. */
const GHOST = '<svg viewBox="0 0 384 512" aria-hidden="true"><path fill="currentColor" d="M186.1.09C81.01 3.24 0 94.92 0 200.05v263.92c0 14.26 17.23 21.39 27.31 11.31l24.92-18.53c6.66-4.95 16-3.99 21.51 2.21l42.95 48.35c6.25 6.25 16.38 6.25 22.63 0l40.72-45.85c6.37-7.17 17.56-7.17 23.92 0l40.72 45.85c6.25 6.25 16.38 6.25 22.63 0l42.95-48.35c5.51-6.2 14.85-7.17 21.51-2.21l24.92 18.53c10.08 10.08 27.31 2.94 27.31-11.31V192C384 84 294.83-3.17 186.1.09zM128 224c-17.67 0-32-14.33-32-32s14.33-32 32-32 32 14.33 32 32-14.33 32-32 32zm128 0c-17.67 0-32-14.33-32-32s14.33-32 32-32 32 14.33 32 32-14.33 32-32 32z"/></svg>';
