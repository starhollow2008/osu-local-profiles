import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bonusPp,
  weightedTotal,
  weightedAccuracy,
  decodeLegacyMods,
  modsAwardPp,
  withClassicMod,
} from '../src/calc/pp.ts';
import { levelFromScore, requiredScore } from '../src/calc/level.ts';

test('bonus pp tops out at the documented 413.894', () => {
  assert.equal(bonusPp(0), 0);
  assert.ok(Math.abs(bonusPp(1000) - 413.894) < 0.01, `got ${bonusPp(1000)}`);
  // Capped: playing more than 1000 ranked maps adds nothing.
  assert.equal(bonusPp(5000), bonusPp(1000));
  // Roughly half the bonus is reached around 138 maps.
  assert.ok(bonusPp(138) / bonusPp(1000) > 0.49 && bonusPp(138) / bonusPp(1000) < 0.51);
});

test('total pp weights each successive play by 0.95', () => {
  assert.equal(weightedTotal([]), 0);
  assert.equal(weightedTotal([100]), 100);
  assert.ok(Math.abs(weightedTotal([100, 100]) - 195) < 1e-9);
  assert.ok(Math.abs(weightedTotal([100, 100, 100]) - (100 + 95 + 90.25)) < 1e-9);
});

test('profile accuracy is weighted, not averaged', () => {
  assert.equal(weightedAccuracy([]), 0);
  assert.ok(Math.abs(weightedAccuracy([0.99, 0.99]) - 0.99) < 1e-9);
  // A great top play pulls the number above the plain mean of 0.95.
  const w = weightedAccuracy([1.0, 0.9]);
  assert.ok(w > 0.95 && w < 1.0, `got ${w}`);
});

test('level formula joins its two branches at n=100', () => {
  // Above 100 the game switches to a linear formula seeded with a rounded constant, so
  // the polynomial branch does not land on it exactly -- the published constant is
  // 26,931,190,827 while the polynomial evaluates to ~26,931,190,829.6. A ~3 point step
  // in 26.9 billion is far below one play's worth of score, so we only assert that the
  // branches agree to within rounding rather than pretending they are continuous.
  assert.ok(Math.abs(requiredScore(100) - 26_931_190_827) < 5, `got ${requiredScore(100)}`);
  const step = requiredScore(101) - requiredScore(100);
  assert.ok(Math.abs(step - 99_999_999_999) < 5, `got ${step}`);
  // Requirements must still increase monotonically across the seam.
  assert.ok(requiredScore(99) < requiredScore(100));
  assert.ok(requiredScore(100) < requiredScore(101));
});

test('level derives from total score', () => {
  assert.deepEqual(levelFromScore(0), { current: 1, progress: 0 });
  assert.equal(levelFromScore(-5).current, 1);

  // Sitting exactly on a level's requirement means you just reached it.
  const atL10 = requiredScore(10);
  assert.equal(levelFromScore(atL10).current, 10);
  assert.ok(levelFromScore(atL10).progress < 0.001);

  // Halfway between two requirements reads as ~50% progress.
  const mid = (requiredScore(10) + requiredScore(11)) / 2;
  const lvl = levelFromScore(mid);
  assert.equal(lvl.current, 10);
  assert.ok(Math.abs(lvl.progress - 0.5) < 0.01, `got ${lvl.progress}`);

  assert.equal(levelFromScore(requiredScore(100)).current, 100);
});

test('legacy mod bitmask decodes, collapsing implied bits', () => {
  assert.deepEqual(decodeLegacyMods(0), []);
  assert.deepEqual(decodeLegacyMods(8).map((m) => m.acronym), ['HD']);
  assert.deepEqual(decodeLegacyMods(8 | 64).map((m) => m.acronym), ['HD', 'DT']);
  // Nightcore sets the DoubleTime bit too; only NC should surface.
  assert.deepEqual(decodeLegacyMods(64 | 512).map((m) => m.acronym), ['NC']);
  // Perfect sets SuddenDeath; only PF should surface.
  assert.deepEqual(decodeLegacyMods(32 | 16384).map((m) => m.acronym), ['PF']);
  // 8256 is the DT+AP combination seen in the real replay corpus.
  assert.deepEqual(decodeLegacyMods(8256).map((m) => m.acronym), ['DT', 'AP']);
});

test('unranked mods make a score award no pp', () => {
  assert.equal(modsAwardPp([]), true);
  assert.equal(modsAwardPp([{ acronym: 'HD' }, { acronym: 'DT' }]), true);
  assert.equal(modsAwardPp([{ acronym: 'AP' }]), false);
  assert.equal(modsAwardPp([{ acronym: 'RX' }]), false);
  assert.equal(modsAwardPp([{ acronym: 'DT' }, { acronym: 'AP' }]), false);
});

test('osu! scores a stable play with Classic, and the page says so', () => {
  // Display only: what the player chose stays in mods_json, which medals and play time read.
  assert.deepEqual(withClassicMod([{ acronym: 'HD' }, { acronym: 'DT' }], 'stable'), [
    { acronym: 'HD' },
    { acronym: 'DT' },
    { acronym: 'CL' },
  ]);
  assert.deepEqual(withClassicMod([], 'stable'), [{ acronym: 'CL' }]);
  // A lazer play is left exactly as it was, and CL is never added twice.
  assert.deepEqual(withClassicMod([{ acronym: 'HD' }], 'lazer'), [{ acronym: 'HD' }]);
  assert.deepEqual(withClassicMod([{ acronym: 'CL' }], 'stable'), [{ acronym: 'CL' }]);
});
