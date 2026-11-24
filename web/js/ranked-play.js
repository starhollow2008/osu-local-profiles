/**
 * osu!'s Ranked Play and Daily Challenge, as osu-web's profile page works them out: ported from
 * osu-web's `resources/js/profile-page/matchmaking.tsx` (`tier`, `getHighestRankStats`),
 * `components/matchmaking-tier-badge.tsx` (the badge's picture) and
 * `profile-page/daily-challenge.tsx` (`tier`, `tierStylePlaycount`, `tierStyleWeekly`).
 *
 * The figures are the linked account's, read off its osu! profile page (dotnet/App/OnlineStats.cs),
 * with osu-web's names in camelCase: `rulesetId`, `firstPlacements`, `provisional`.
 */

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Rhodium', 'Radiant'];
const LEVELS = ['I', 'II', 'III'];

/** A rating's tier: its colour (a `--level-tier-*`) and its name, "Gold II". */
export function rankedPlayTier(rating) {
  if (rating >= 2400) return { colour: 'lustrous', title: 'Lustrous' };
  const base = Math.floor(Math.min(Math.max(rating, 600), 2399) / 100) - 6;
  const main = TIERS[Math.floor(base / 3)];
  return { colour: main.toLowerCase(), title: `${main} ${LEVELS[base % 3]}` };
}

/** The pool the profile shows first: the active one with the best rank, or null for none. */
export function highestRankPool(pools) {
  let best = null;
  for (const pool of pools ?? []) {
    if (pool.active && (best === null || pool.rank < best.rank)) best = pool;
  }
  return best;
}

/**
 * The tier badge's picture (`matchmaking-tier-badge--*`): the tier and the ruleset, "Gold-II-0",
 * or the placeholder while the rating is provisional.
 */
export function tierBadge(pool) {
  if (!pool || pool.provisional) return 'Placeholder';
  return `${rankedPlayTier(pool.rating).title.split(' ').join('-')}-${pool.rulesetId}`;
}

/** Every badge a profile's Ranked Play can show, for Share to carry: one per pool, and the placeholder. */
export function tierBadges(pools) {
  return new Set(['Placeholder', ...(pools ?? []).map(tierBadge)]);
}

const DAILY_TIERS = [
  [360, 'lustrous'],
  [240, 'radiant'],
  [120, 'rhodium'],
  [60, 'platinum'],
  [30, 'gold'],
  [10, 'silver'],
  [5, 'bronze'],
];

/** A streak's colour, by days. */
export function dailyChallengeTier(days) {
  for (const [min, tier] of DAILY_TIERS) if (days >= min) return tier;
  return 'iron';
}

/** Total Participation's colour: a third of the days, as osu-web counts it. */
export const participationTier = (count) => dailyChallengeTier(Math.floor(count / 3));

/** A weekly streak's colour: weeks as days, one week fewer so the first is iron. */
export const weeklyTier = (weeks) => dailyChallengeTier((weeks - 1) * 7);

/** Whether the account took part today (osu! counts days in UTC), for the green tick. */
export function playedToday(stats, now = Date.now()) {
  if (!Number.isFinite(stats?.lastUpdate)) return false;
  const day = (ms) => Math.floor(ms / 86_400_000);
  return day(stats.lastUpdate) === day(now);
}
