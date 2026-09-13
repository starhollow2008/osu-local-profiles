import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficialCalculator, type RankedRequest } from '../src/calc/official.ts';

/*
 * Which mods osu! ranks, asked of osu!'s own mod classes through the helper.
 *
 * The expectations are osu! 2026.730.0's `Mod.Ranked`, read off every mod in every ruleset and
 * with each ranked mod's settings moved off their defaults one at a time. They exist to catch
 * the question not reaching osu! -- a setting that fails to apply, the stable bitmask read
 * wrongly -- and to show, on a package bump, what osu! changed.
 */

const osu = 0;
const taiko = 1;
const mania = 3;

/** osu!stable's mod bits, as osu! numbers them. */
const LEGACY = { NF: 1, HD: 8, HR: 16, DT: 64, RX: 128, NC: 512 | 64, SO: 4096, K4: 32768, RD: 2097152, SV2: 536870912 };

const CASES: Array<[string, RankedRequest, boolean]> = [
  ['no mods', { ruleset: osu, mods: [] }, true],
  ['Alternate', { ruleset: osu, mods: [{ acronym: 'AL' }] }, true],
  ['No Fail with Alternate', { ruleset: osu, mods: [{ acronym: 'NF' }, { acronym: 'AL' }] }, true],
  ['Single Tap', { ruleset: osu, mods: [{ acronym: 'SG' }] }, true],
  ['Traceable', { ruleset: osu, mods: [{ acronym: 'TC' }] }, true],
  ['Blinds', { ruleset: osu, mods: [{ acronym: 'BL' }] }, true],
  ['Muted and No Scope', { ruleset: osu, mods: [{ acronym: 'MU' }, { acronym: 'NS' }] }, true],
  ['Swap in taiko', { ruleset: taiko, mods: [{ acronym: 'SW' }] }, true],
  ['Cover and 7K in mania', { ruleset: mania, mods: [{ acronym: 'CO' }, { acronym: '7K' }] }, true],
  ['Mirror in mania', { ruleset: mania, mods: [{ acronym: 'MR' }] }, true],
  ['Mirror in osu!', { ruleset: osu, mods: [{ acronym: 'MR' }] }, false],
  ['Hard Rock in mania', { ruleset: mania, mods: [{ acronym: 'HR' }] }, false],
  ['Classic chosen on lazer', { ruleset: osu, mods: [{ acronym: 'CL' }] }, false],
  ['Relax', { ruleset: osu, mods: [{ acronym: 'RX' }] }, false],
  ['Difficulty Adjust', { ruleset: osu, mods: [{ acronym: 'DA' }] }, false],
  ['an acronym the ruleset lacks', { ruleset: taiko, mods: [{ acronym: 'AL' }] }, false],

  // Settings: only some of them unrank.
  ['DT at 1.45x', { ruleset: osu, mods: [{ acronym: 'DT', settings: { speed_change: 1.45 } }] }, false],
  ['DT at its default 1.5x, written out', { ruleset: osu, mods: [{ acronym: 'DT', settings: { speed_change: 1.5 } }] }, true],
  ['DT with pitch adjusted', { ruleset: osu, mods: [{ acronym: 'DT', settings: { adjust_pitch: true } }] }, true],
  ['HD fading approach circles only', { ruleset: osu, mods: [{ acronym: 'HD', settings: { only_fade_approach_circles: true } }] }, false],
  ['SD restarting on fail', { ruleset: osu, mods: [{ acronym: 'SD', settings: { restart: true } }] }, true],
  ['Accuracy Challenge at 90%', { ruleset: osu, mods: [{ acronym: 'AC', settings: { minimum_accuracy: 0.9 } }] }, true],

  // osu!stable bitmasks, converted by osu!.
  ['stable HDDT', { ruleset: osu, legacyMods: LEGACY.HD | LEGACY.DT }, true],
  ['stable NC', { ruleset: osu, legacyMods: LEGACY.NC }, true],
  ['stable NF SO', { ruleset: osu, legacyMods: LEGACY.NF | LEGACY.SO }, true],
  ['stable relax', { ruleset: osu, legacyMods: LEGACY.RX | LEGACY.HR }, false],
  ['stable 4K in mania', { ruleset: mania, legacyMods: LEGACY.K4 }, true],
  ['stable Random in mania', { ruleset: mania, legacyMods: LEGACY.RD }, false],
  ['stable ScoreV2', { ruleset: osu, legacyMods: LEGACY.SV2 }, false],
];

test('osu! decides which mods are ranked, by ruleset and by setting', { timeout: 120_000 }, async (t) => {
  const calc = await OfficialCalculator.create();
  if (!calc) return t.skip('osu-pp helper not built (run: npm run build:pp:local)');

  try {
    for (const [name, request, expected] of CASES) {
      const result = await calc.ranked(request);
      assert.ok(result, `${name}: the helper did not answer (${calc.lastError ?? 'no error'})`);
      assert.equal(result.ranked, expected, `${name}: expected ${expected ? 'ranked' : 'unranked'}, unranked = [${result.unranked.join(', ')}]`);
    }
  } finally {
    calc.dispose();
  }
});

test('the helper names the mod osu! does not rank', { timeout: 120_000 }, async (t) => {
  const calc = await OfficialCalculator.create();
  if (!calc) return t.skip('osu-pp helper not built (run: npm run build:pp:local)');

  try {
    const result = await calc.ranked({ ruleset: osu, mods: [{ acronym: 'HD' }, { acronym: 'RX' }, { acronym: 'AL' }] });
    assert.deepEqual(result, { ranked: false, unranked: ['RX'] });
  } finally {
    calc.dispose();
  }
});

/*
 * A question osu! cannot answer is null, not a guess -- and it must not leave the line
 * protocol out of step: the next question still gets its own answer.
 */
test('an unanswerable question is null and the helper keeps answering', { timeout: 120_000 }, async (t) => {
  const calc = await OfficialCalculator.create();
  if (!calc) return t.skip('osu-pp helper not built (run: npm run build:pp:local)');

  try {
    assert.equal(await calc.ranked({ ruleset: 9, mods: [] }), null);
    assert.match(calc.lastError ?? '', /ruleset/);
    const next = await calc.ranked({ ruleset: osu, mods: [{ acronym: 'AL' }] });
    assert.deepEqual(next, { ranked: true, unranked: [] });
  } finally {
    calc.dispose();
  }
});

/*
 * osu! drops a setting value it cannot parse and keeps the mod at its default, which is what
 * it does reading such a replay itself. Verified while writing this: osu!'s logger, which that
 * path goes through, writes nothing to stdout, so the protocol survives it.
 */
test('a setting osu! cannot parse is dropped, as osu! drops it', { timeout: 120_000 }, async (t) => {
  const calc = await OfficialCalculator.create();
  if (!calc) return t.skip('osu-pp helper not built (run: npm run build:pp:local)');

  try {
    const result = await calc.ranked({ ruleset: osu, mods: [{ acronym: 'DT', settings: { speed_change: 'fast' } }] });
    assert.deepEqual(result, { ranked: true, unranked: [] });
    const next = await calc.ranked({ ruleset: osu, mods: [{ acronym: 'RX' }] });
    assert.deepEqual(next, { ranked: false, unranked: ['RX'] });
  } finally {
    calc.dispose();
  }
});
