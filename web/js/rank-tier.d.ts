/** Types for web/js/rank-tier.js. */

export type RankTier = 'lustrous' | 'radiant' | 'rhodium' | 'platinum' | 'gold' | 'silver' | 'bronze' | 'iron';

export function rankTier(rank: number | null | undefined, players: number | null | undefined): RankTier | null;
