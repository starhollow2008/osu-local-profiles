/** Types for web/js/ranked-play.js. */

export interface RankedPlayPool {
  poolId: number;
  name: string;
  rulesetId: number;
  variantId: number;
  active: boolean;
  rank: number;
  rating: number;
  plays: number;
  firstPlacements: number;
  provisional: boolean;
  recentHistory: { id: number; result: 'win' | 'loss' | 'draw'; roomId: number | null; at: number }[];
  ratingHistory: { at: number; rating: number }[];
}

export interface DailyChallengeStats {
  playcount: number;
  dailyStreakCurrent: number;
  dailyStreakBest: number;
  weeklyStreakCurrent: number;
  weeklyStreakBest: number;
  top10pPlacements: number;
  top50pPlacements: number;
  lastUpdate: number | null;
}

export type LevelTier = 'iron' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'rhodium' | 'radiant' | 'lustrous';

export function rankedPlayTier(rating: number): { colour: LevelTier; title: string };
export function highestRankPool(pools: RankedPlayPool[] | null | undefined): RankedPlayPool | null;
export function tierBadge(pool: RankedPlayPool | null | undefined): string;
export function tierBadges(pools: RankedPlayPool[] | null | undefined): Set<string>;
export function dailyChallengeTier(days: number): LevelTier;
export function participationTier(count: number): LevelTier;
export function weeklyTier(weeks: number): LevelTier;
export function playedToday(stats: DailyChallengeStats | null | undefined, now?: number): boolean;
