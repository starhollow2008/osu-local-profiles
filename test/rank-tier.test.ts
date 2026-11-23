import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTier } from '../web/js/rank-tier.js';

/*
 * A global rank's tier (issue #30), as osu-web's resources/js/profile-page/rank.tsx works it out:
 * the top 100 are lustrous, and the rest go by the share of the ruleset's ranked players ahead.
 */

test('the top 100 are lustrous, however few players there are', () => {
  assert.equal(rankTier(1, 3_000_000), 'lustrous');
  assert.equal(rankTier(100, 3_000_000), 'lustrous');
  assert.equal(rankTier(100, 150), 'lustrous');
  assert.notEqual(rankTier(101, 3_000_000), 'lustrous');
});

test('each tier starts where osu-web says, by the share of players', () => {
  const players = 1_000_000;
  // Just inside each tier, and the first rank past it.
  const steps: [number, string | null][] = [
    [499, 'radiant'], [500, 'rhodium'],
    [1_499, 'rhodium'], [1_500, 'platinum'],
    [4_999, 'platinum'], [5_000, 'gold'],
    [14_999, 'gold'], [15_000, 'silver'],
    [49_999, 'silver'], [50_000, 'bronze'],
    [149_999, 'bronze'], [150_000, 'iron'],
    [499_999, 'iron'], [500_000, null],
    [1_000_000, null],
  ];
  for (const [rank, tier] of steps) assert.equal(rankTier(rank, players), tier, `#${rank}`);
});

test('no rank, or nothing to measure it against, has no tier', () => {
  assert.equal(rankTier(null, 3_000_000), null);
  assert.equal(rankTier(5_000, undefined), null);
  assert.equal(rankTier(5_000, 0), null);
  assert.equal(rankTier(0, 3_000_000), null);
  assert.equal(rankTier(Number.NaN, 3_000_000), null);
});
