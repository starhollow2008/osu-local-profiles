import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  dailyChallengeTier,
  highestRankPool,
  participationTier,
  playedToday,
  rankedPlayTier,
  tierBadge,
  tierBadges,
  weeklyTier,
  type RankedPlayPool,
} from '../web/js/ranked-play.js';

/*
 * Ranked Play and Daily Challenge (Show more details), as osu-web's matchmaking.tsx and
 * daily-challenge.tsx work them out.
 */

const pool = (over: Partial<RankedPlayPool>): RankedPlayPool => ({
  poolId: 1, name: 'RP: Season 1', rulesetId: 0, variantId: 0, active: true, rank: 10, rating: 1500,
  plays: 20, firstPlacements: 8, provisional: false, recentHistory: [], ratingHistory: [], ...over,
});

test('a rating is a tier of three levels per hundred, from 600, and Lustrous from 2400', () => {
  assert.deepEqual(rankedPlayTier(0), { colour: 'bronze', title: 'Bronze I' });
  assert.deepEqual(rankedPlayTier(699), { colour: 'bronze', title: 'Bronze I' });
  assert.deepEqual(rankedPlayTier(800), { colour: 'bronze', title: 'Bronze III' });
  assert.deepEqual(rankedPlayTier(900), { colour: 'silver', title: 'Silver I' });
  assert.deepEqual(rankedPlayTier(1500), { colour: 'platinum', title: 'Platinum I' });
  assert.deepEqual(rankedPlayTier(2399), { colour: 'radiant', title: 'Radiant III' });
  assert.deepEqual(rankedPlayTier(2400), { colour: 'lustrous', title: 'Lustrous' });
});

test('the pool shown first is the active one ranked best', () => {
  const old = pool({ poolId: 1, rank: 1, active: false });
  const four = pool({ poolId: 2, rank: 50, variantId: 4 });
  const seven = pool({ poolId: 3, rank: 20, variantId: 7 });
  assert.equal(highestRankPool([old, four, seven]), seven);
  assert.equal(highestRankPool([old]), null);
  assert.equal(highestRankPool(null), null);
});

test('the badge is the tier in the ruleset, or the placeholder while provisional', () => {
  assert.equal(tierBadge(pool({ rating: 1234, rulesetId: 3 })), 'Gold-I-3');
  assert.equal(tierBadge(pool({ rating: 2635 })), 'Lustrous-0');
  assert.equal(tierBadge(pool({ provisional: true })), 'Placeholder');
  assert.equal(tierBadge(null), 'Placeholder');
  assert.deepEqual([...tierBadges([pool({ rating: 1234 })])], ['Placeholder', 'Gold-I-0']);
});

test('every badge the page can show has a picture', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'css', 'osu-web-art.css'), 'utf8');
  for (let rating = 0; rating <= 2500; rating += 100) {
    for (const rulesetId of [0, 1, 2, 3]) {
      const badge = tierBadge(pool({ rating, rulesetId }));
      assert.match(css, new RegExp(`\\.matchmaking-tier-badge--${badge} \\{ background-image`), badge);
    }
  }
  assert.match(css, /\.matchmaking-tier-badge--Placeholder \{ background-image/);
});

test("Daily Challenge's colours go by days, participation by a third of them, weeks as days", () => {
  assert.equal(dailyChallengeTier(0), 'iron');
  assert.equal(dailyChallengeTier(5), 'bronze');
  assert.equal(dailyChallengeTier(29), 'silver');
  assert.equal(dailyChallengeTier(360), 'lustrous');
  assert.equal(participationTier(90), 'gold');
  assert.equal(participationTier(89), 'silver');
  assert.equal(weeklyTier(1), 'iron');
  assert.equal(weeklyTier(2), 'bronze');
  assert.equal(weeklyTier(5), 'silver');
  assert.equal(weeklyTier(6), 'gold');
});

test('took part today is the same UTC day', () => {
  const now = Date.parse('2026-11-23T05:00:00Z');
  assert.equal(playedToday({ lastUpdate: Date.parse('2026-11-23T00:00:00Z') } as never, now), true);
  assert.equal(playedToday({ lastUpdate: Date.parse('2026-11-22T23:59:00Z') } as never, now), false);
  assert.equal(playedToday(null, now), false);
});
