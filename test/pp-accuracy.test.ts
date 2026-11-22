import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyOf, countsFromStatistics, judgementsForAccuracy, sliderMisses } from '../web/js/pp-accuracy.js';

/*
 * The pp calculator's accuracy field (web/js/pp-accuracy.js): an accuracy typed in becomes
 * judgements as a player loses accuracy, with the misses kept as typed.
 */

/** osu!stable's accuracy in osu!. */
const stableAcc = (c: Record<string, number>) =>
  (300 * (c.c300 ?? 0) + 100 * (c.c100 ?? 0) + 50 * (c.c50 ?? 0)) / (300 * ((c.c300 ?? 0) + (c.c100 ?? 0) + (c.c50 ?? 0) + (c.miss ?? 0)));

test('osu!: 100s first, keeping the misses', () => {
  const { counts, reached } = judgementsForAccuracy(0, 0.98, { perfect: { c300: 1000 }, counts: { miss: 2 } });
  assert.equal(reached, true);
  assert.deepEqual(counts, { c300: 971, c100: 27, c50: 0, miss: 2 });
  assert.ok(Math.abs(stableAcc(counts) - 0.98) < 0.0005);
});

test('osu!: 50s only once every hit is a 100, and the nearest when it cannot be reached', () => {
  const low = judgementsForAccuracy(0, 0.25, { perfect: { c300: 100 } });
  assert.deepEqual(low.counts, { c300: 0, c100: 50, c50: 50, miss: 0 });
  assert.ok(Math.abs(stableAcc(low.counts) - 0.25) < 0.005);

  const never = judgementsForAccuracy(0, 0.05, { perfect: { c300: 100 }, counts: { miss: 10 } });
  assert.equal(never.reached, false);
  assert.deepEqual(never.counts, { c300: 0, c100: 0, c50: 90, miss: 10 });

  const tooHigh = judgementsForAccuracy(0, 1, { perfect: { c300: 100 }, counts: { miss: 1 } });
  assert.equal(tooHigh.reached, false);
  assert.deepEqual(tooHigh.counts, { c300: 99, c100: 0, c50: 0, miss: 1 });
});

test('osu! without Classic: the slider ends and ticks missed count toward it', () => {
  const ends = { sliders: 100, ticks: 200 };
  const perfect = { c300: 400 };
  const { counts } = judgementsForAccuracy(0, 0.97, { perfect, counts: { tailMiss: 10, tickMiss: 5 }, ends });
  const max = 300 * 400 + 30 * 200 + 150 * 100;
  const got = (300 * counts.c300! + 100 * counts.c100! + 50 * counts.c50! + 30 * (200 - 5) + 150 * (100 - 10)) / max;
  assert.ok(Math.abs(got - 0.97) < 0.0005, `${got}`);
  assert.equal(counts.tailMiss, 10);
  assert.equal(counts.tickMiss, 5);
});

test('taiko: goods; catch: droplets; mania: 200s first, keeping the 300s typed', () => {
  assert.deepEqual(judgementsForAccuracy(1, 0.95, { perfect: { c300: 100 } }).counts, { c300: 90, c100: 10, miss: 0 });

  const fruits = judgementsForAccuracy(2, 0.99, { perfect: { c300: 500, c100: 100, c50: 400 }, counts: { miss: 2 } });
  assert.deepEqual(fruits.counts, { c300: 498, c100: 100, c50: 392, katu: 8, miss: 2 });
  assert.equal(fruits.reached, true);
  assert.equal(judgementsForAccuracy(2, 0.5, { perfect: { c300: 500, c100: 100, c50: 400 } }).reached, false);

  const keys = judgementsForAccuracy(3, 0.96, { perfect: { geki: 1000 }, counts: { c300: 300 } });
  assert.deepEqual(keys.counts, { geki: 580, c300: 300, katu: 120, c100: 0, c50: 0, miss: 0 });
});

test('a score\'s statistics as replay counters, and lazer\'s slider misses', () => {
  assert.deepEqual(countsFromStatistics(0, { great: 900, ok: 10, meh: 1, miss: 2, slider_tail_hit: 200 }), { c300: 900, c100: 10, c50: 1, miss: 2 });
  assert.deepEqual(countsFromStatistics(3, { perfect: 5, great: 4, good: 3, ok: 2, meh: 1, miss: 0 }), { geki: 5, c300: 4, katu: 3, c100: 2, c50: 1, miss: 0 });
  assert.deepEqual(sliderMisses({ slider_tail_hit: 195, large_tick_miss: 3 }, { slider_tail_hit: 200 }), { tailMiss: 5, tickMiss: 3 });
  // A stable score has no maximum statistics, and so no slider end missed.
  assert.deepEqual(sliderMisses({ great: 900 }, {}), { tailMiss: 0, tickMiss: 0 });
});

test('the accuracy of judgements, as osu!stable works it out, and lazer in osu! without Classic', () => {
  assert.equal(accuracyOf(0, { c300: 3, c100: 1 }), (900 + 100) / 1200);
  assert.equal(accuracyOf(0, { c50: 10 }), 1 / 6);
  assert.equal(accuracyOf(1, { c300: 9, c100: 2, miss: 1 }), 10 / 12);
  assert.equal(accuracyOf(2, { c300: 90, c50: 5, katu: 5 }), 0.95);
  assert.equal(accuracyOf(3, { geki: 1, c300: 1, katu: 1, miss: 1 }), 800 / 1200);
  assert.equal(accuracyOf(0, { c300: 10, tailMiss: 2 }, { sliders: 4, ticks: 0 }), (3000 + 300) / (3000 + 600));
  // Each accuracy reached is the one these judgements make.
  for (const [mode, perfect] of [[0, { c300: 500 }], [1, { c300: 500 }], [3, { geki: 500 }]] as const) {
    const { counts } = judgementsForAccuracy(mode, 0.9, { perfect });
    assert.ok(Math.abs(accuracyOf(mode, counts) - 0.9) < 0.002, `${mode}: ${accuracyOf(mode, counts)}`);
  }
});
