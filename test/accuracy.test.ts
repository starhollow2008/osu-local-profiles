import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracy, lazerAccuracy, legacyAccuracy } from '../src/calc/grade.ts';
import type { ReplayScore } from '../src/osr.ts';

/**
 * A real tracked play: WONDERFUL WONDER (TV Size) [Simple Heart] +DT.
 * osu! itself reports 90.81% for it; the legacy formula gives 89.11%.
 */
function wonderfulWonder(overrides: Partial<ReplayScore> = {}): ReplayScore {
  return {
    client: 'lazer',
    mode: 0,
    version: 30000019,
    beatmapMD5: '8f91aa532b943ceaf29a5d761366130d',
    username: 'Tangy',
    replayMD5: 'test-replay',
    count300: 174,
    count100: 10,
    count50: 0,
    countGeki: 0,
    countKatu: 0,
    countMiss: 15,
    totalScore: 617915,
    maxCombo: 128,
    perfectCombo: false,
    legacyMods: 64,
    playedAt: new Date(),
    onlineScoreId: 7441175612n,
    extras: {
      rank: 'A',
      mods: [{ acronym: 'DT' }],
      statistics: { miss: 15, ok: 10, great: 174, large_tick_hit: 3, ignore_hit: 73, slider_tail_hit: 73 },
      maximum_statistics: { great: 199, large_tick_hit: 3, ignore_hit: 73, slider_tail_hit: 73 },
    },
    ...overrides,
  };
}

test('lazer accuracy matches what osu! reports for a real play', () => {
  const acc = lazerAccuracy(wonderfulWonder());
  assert.ok(acc !== null);
  // (300*174 + 100*10 + 150*73 + 30*3) / (300*199 + 150*73 + 30*3) = 64240/70740
  assert.ok(Math.abs(acc - 0.908114) < 1e-5, `expected 90.8114%, got ${(acc * 100).toFixed(4)}%`);
  assert.equal((acc * 100).toFixed(2), '90.81');
});

test('the legacy formula is what produced the wrong 89.11%', () => {
  // Kept as a regression marker: slider tails and ticks are exactly what it misses.
  const legacy = legacyAccuracy(wonderfulWonder(), 0);
  assert.equal((legacy * 100).toFixed(2), '89.11');
});

test('accuracy() prefers lazer weighting and falls back for stable', () => {
  assert.equal((accuracy(wonderfulWonder(), 0) * 100).toFixed(2), '90.81');

  // A stable replay has no extended block, so the legacy formula is correct there.
  const stable = wonderfulWonder({ client: 'stable', version: 20210520, extras: null });
  assert.equal((accuracy(stable, 0) * 100).toFixed(2), '89.11');
});

test('a perfect play is exactly 100%', () => {
  const perfect = wonderfulWonder({
    extras: {
      statistics: { great: 199, large_tick_hit: 3, ignore_hit: 73, slider_tail_hit: 73 },
      maximum_statistics: { great: 199, large_tick_hit: 3, ignore_hit: 73, slider_tail_hit: 73 },
    },
  });
  assert.equal(lazerAccuracy(perfect), 1);
});

test('an unrecognised judgement refuses to guess rather than under-report', () => {
  const odd = wonderfulWonder({
    extras: {
      statistics: { great: 100, some_future_judgement: 5 },
      maximum_statistics: { great: 100, some_future_judgement: 5 },
    },
  });
  assert.equal(lazerAccuracy(odd), null);
  // It falls back to the legacy formula instead of returning a silently wrong figure.
  assert.equal((accuracy(odd, 0) * 100).toFixed(2), '89.11');
});

test('missing maximum_statistics falls back instead of dividing by zero', () => {
  const noMax = wonderfulWonder({
    extras: { statistics: { great: 174, ok: 10, miss: 15 } },
  });
  assert.equal(lazerAccuracy(noMax), null);
  assert.ok(Number.isFinite(accuracy(noMax, 0)));
});
