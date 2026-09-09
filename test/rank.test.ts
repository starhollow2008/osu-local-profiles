import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateRank, rankTable } from '../src/calc/rank.ts';

/** A miniature stand-in for a real curve: ascending pp, descending rank. */
const CURVE: [number, number][] = [
  [10, 4_000_000],
  [100, 1_000_000],
  [1000, 100_000],
  [5000, 10_000],
  [10_000, 1000],
  [20_000, 1],
];

test('rank interpolation is monotonic and bounded by the curve', () => {
  // Off the ladder entirely.
  assert.equal(interpolateRank(CURVE, 0), null);
  assert.equal(interpolateRank(CURVE, -5), null);
  assert.equal(interpolateRank(CURVE, Number.NaN), null);

  // Beyond either end, clamp rather than extrapolate into nonsense.
  assert.equal(interpolateRank(CURVE, 1), 4_000_000);
  assert.equal(interpolateRank(CURVE, 999_999), 1);

  // Exact points come back exactly.
  assert.equal(interpolateRank(CURVE, 1000), 100_000);

  // More pp is never a worse rank.
  let previous = Infinity;
  for (let pp = 10; pp <= 20_000; pp += 37) {
    const rank = interpolateRank(CURVE, pp)!;
    assert.ok(rank <= previous, `rank went backwards at ${pp}pp: ${rank} > ${previous}`);
    previous = rank;
  }
});

test('interpolation is logarithmic in rank, not linear', () => {
  // Halfway between 100pp (#1,000,000) and 1000pp (#100,000). A linear reading would say
  // #550,000; the log reading says ~#316,000, which is the right shape for a ladder whose
  // rank spans orders of magnitude while pp does not.
  const midpoint = interpolateRank(CURVE, 550)!;
  assert.ok(midpoint > 250_000 && midpoint < 400_000, `unexpected midpoint: ${midpoint}`);
});

test('a degenerate curve is refused rather than guessed at', () => {
  assert.equal(interpolateRank([], 500), null);
  assert.equal(interpolateRank([[100, 1000]], 500), null);
});

test('a built rank table is well formed', (t) => {
  const table = rankTable(0);
  if (!table) return t.skip('no osu! rank table built -- run scripts/build-rank-table.mjs');

  assert.ok(table.points.length >= 2);
  assert.match(table.dump, /^\d{4}_\d{2}_\d{2}$/);

  let lastPp = -Infinity;
  let lastRank = Infinity;
  for (const [pp, rank] of table.points) {
    assert.ok(pp > lastPp, `pp must ascend: ${pp} after ${lastPp}`);
    assert.ok(rank <= lastRank, `rank must not worsen as pp rises: ${rank} after ${lastRank}`);
    assert.ok(rank >= 1, 'rank must be at least 1');
    lastPp = pp;
    lastRank = rank;
  }
});
