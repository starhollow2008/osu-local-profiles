import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { computeMedals, earnedMedalCount, earnsIntroMedal, type Medal } from '../src/calc/medals.ts';
import { medalEvents } from '../src/calc/history.ts';
import { VANILLA } from '../src/calc/eligibility.ts';
import { applyScoreAction } from '../src/scores.ts';
import { Status } from '../src/clients/beatmaps.ts';

interface Fixture {
  combo?: number;
  /** The beatmap's own maximum combo. Undefined means "not recorded", as older rows are. */
  beatmapMaxCombo?: number | null;
  miss?: number;
  stars?: number | null;
  hits?: number;
  passed?: boolean;
  mode?: number;
  pp?: number | null;
  md5?: string;
  at?: number;
  mods?: { acronym: string; settings?: Record<string, unknown> }[];
  client?: 'lazer' | 'stable';
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-medals-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  let n = 0;

  const add = (f: Fixture = {}): number => {
    n++;
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, stars, pp,
         beatmap_max_combo, map_status, mods_ranked, mods_countable, ranked, played_at)
       VALUES (?,?,?,?,?,?,'',?,0,0,0,0,?,0.99,?,500000,?,'S',?,?,?,?,1,1,1,?)`,
    ).run(
      profileId, `key-${n}`, f.mode ?? 0, f.md5 ?? `md5-${n}`,
      f.client ?? 'lazer', JSON.stringify(f.mods ?? []),
      f.hits ?? 100,
      f.miss ?? 0,
      f.combo ?? 100,
      (f.passed ?? true) ? 1 : 0,
      f.stars === undefined ? 5.0 : f.stars,
      f.pp === undefined ? 100 : f.pp,
      f.beatmapMaxCombo === undefined ? null : f.beatmapMaxCombo,
      Status.RANKED,
      f.at ?? 1_700_000_000_000 + n * 60_000,
    );
    return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  };

  return {
    db,
    profileId,
    add,
    medals: (mode = 0) => computeMedals(db, profileId, mode as 0, VANILLA),
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const find = (medals: Medal[], slug: string): Medal => {
  const medal = medals.find((m) => m.slug === slug);
  assert.ok(medal, `no medal with slug ${slug}`);
  return medal;
};

const earned = (medals: Medal[]) =>
  medals.filter((m) => m.achievedAt !== null).map((m) => m.slug).sort();

/* --------------------------------------------------------------- the set */

test('an empty profile has every medal locked, and none missing', () => {
  const h = harness();
  try {
    const summary = h.medals();
    assert.equal(summary.earned, 0);
    // osu!standard: 13 Mod Introduction, then 4 combo + 4 plays + 10 pass + 10 fc + 4 rank.
    assert.equal(summary.total, 45);
    assert.ok(summary.medals.every((m) => m.achievedAt === null));
  } finally {
    h.cleanup();
  }
});

/*
 * osu! itself only has combo and play-count medals for osu!standard; the other modes have
 * hit-count medals instead, and 8 star tiers rather than 10. That asymmetry is reproduced
 * rather than smoothed over, so it is worth pinning down.
 */
test('the other modes have the medals osu! actually gives them', () => {
  const h = harness();
  try {
    for (const mode of [1, 2, 3]) {
      const families = new Set(h.medals(mode).medals.map((m) => m.family));
      assert.deepEqual([...families].sort(), ['fc', 'hits', 'intro', 'pass', 'rank']);
      // 13 Mod Introduction (every mode shows them), 4 hits + 8 pass + 8 fc + 4 rank.
      assert.equal(h.medals(mode).total, 37);
    }
  } finally {
    h.cleanup();
  }
});

/* ---------------------------------------------------------------- combo */

test('combo medals unlock at their thresholds and not before', () => {
  const h = harness();
  try {
    // Only the combo family: the fixture's default star rating earns pass medals too.
    const combos = () => earned(h.medals().medals).filter((s) => s.startsWith('osu-combo'));

    h.add({ combo: 499 });
    assert.deepEqual(combos(), []);

    h.add({ combo: 500 });
    assert.deepEqual(combos(), ['osu-combo-500']);

    h.add({ combo: 2000 });
    assert.deepEqual(combos(), [
      'osu-combo-1000', 'osu-combo-2000', 'osu-combo-500', 'osu-combo-750',
    ]);
  } finally {
    h.cleanup();
  }
});

test('a combo medal is dated to the play that first reached it', () => {
  const h = harness();
  try {
    h.add({ combo: 100, at: 1000 });
    h.add({ combo: 600, at: 2000, md5: 'the-one' });
    h.add({ combo: 700, at: 3000 });

    const medal = find(h.medals().medals, 'osu-combo-500');
    assert.equal(medal.achievedAt, 2000);
  } finally {
    h.cleanup();
  }
});

test("families come in osu!'s own ordering, rank between plays and the star medals", () => {
  const h = harness();
  try {
    h.add({ combo: 250 });
    const families = [...new Set(h.medals().medals.map((m) => m.family))];
    // Mod Introduction's group first, as osu! lists its groups; then Skill & Dedication's
    // `ordering`: combo 0, plays 1, rank 2, hits 3, pass 4, fc 5.
    assert.deepEqual(families, ['intro', 'combo', 'plays', 'rank', 'pass', 'fc']);
  } finally {
    h.cleanup();
  }
});

test('an earned medal becomes one Recent entry, at the moment it was earned', () => {
  const h = harness();
  try {
    h.add({ combo: 100, at: 1000 });
    h.add({ combo: 600, at: 2000 });
    const events = medalEvents(h.medals().medals);
    const combo = events.find((e) => e.type === 'medal' && e.slug === 'osu-combo-500');
    assert.ok(combo, 'the 500 combo medal is announced');
    assert.equal(combo.at, 2000);
    // Locked medals never appear.
    assert.equal(events.some((e) => e.type === 'medal' && e.slug === 'osu-combo-750'), false);
  } finally {
    h.cleanup();
  }
});

test("the header's medal count is the whole profile's, not one mode's", () => {
  const h = harness();
  try {
    h.add({ combo: 600, mode: 0 }); // 500 combo, plus star pass 1..5
    h.add({ hits: 40_000, mode: 1 }); // taiko's first hit-count medal, plus its star passes
    const perMode = [0, 1].map(
      (mode) => h.medals(mode).medals.filter((m) => m.achievedAt !== null).length,
    );
    assert.ok(perMode[0]! > 0 && perMode[1]! > 0, 'both modes earned something');
    assert.equal(earnedMedalCount(h.db, h.profileId, VANILLA), perMode[0]! + perMode[1]!);
  } finally {
    h.cleanup();
  }
});

test('a rank medal carries no date, so it never slides to the top of Recent', () => {
  const rank: Medal = {
    slug: 'all-skill-highranker-1',
    name: 'I Can See The Top',
    description: '',
    icon: '',
    family: 'rank',
    grouping: 'Skill & Dedication',
    threshold: 50_000,
    achievedAt: 5000,
    dated: false,
    earnedOn: null,
  };
  assert.deepEqual(medalEvents([rank]), []);
});

/* ---------------------------------------------------------------- plays */

test('play-count medals count every play, passed or not', () => {
  const h = harness();
  try {
    for (let i = 0; i < 5000; i++) h.add({ passed: i % 2 === 0, combo: 1 });
    assert.ok(find(h.medals().medals, 'osu-plays-5000').achievedAt !== null);
    assert.equal(find(h.medals().medals, 'osu-plays-15000').achievedAt, null);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------ star pass */

test('passing an n-star map awards every star medal up to n', () => {
  const h = harness();
  try {
    h.add({ stars: 5.9, combo: 1 });
    assert.deepEqual(
      earned(h.medals().medals).filter((s) => s.startsWith('osu-skill-pass')),
      ['osu-skill-pass-1', 'osu-skill-pass-2', 'osu-skill-pass-3', 'osu-skill-pass-4', 'osu-skill-pass-5'],
    );
  } finally {
    h.cleanup();
  }
});

test('failing a map awards no star medal, however hard it was', () => {
  const h = harness();
  try {
    h.add({ stars: 9.5, passed: false, combo: 1 });
    assert.deepEqual(
      earned(h.medals().medals).filter((s) => s.includes('skill')),
      [],
    );
  } finally {
    h.cleanup();
  }
});

test('a play with no star rating awards no star medal', () => {
  const h = harness();
  try {
    // No local .osu, so the calculator was never asked and there is no difficulty to judge.
    h.add({ stars: null, combo: 1 });
    assert.deepEqual(earned(h.medals().medals).filter((s) => s.includes('skill')), []);
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------------- star FC */

/*
 * The reason `beatmap_max_combo` is stored at all: a lazer score can drop slider ends
 * without breaking combo, so "no misses" alone would award an FC to a run that dropped a
 * hundred of them.
 */
test('a full combo needs the whole combo, not just no misses', () => {
  const h = harness();
  try {
    h.add({ stars: 3.2, miss: 0, combo: 400, beatmapMaxCombo: 500 });
    assert.deepEqual(earned(h.medals().medals).filter((s) => s.includes('-fc-')), []);

    h.add({ stars: 3.2, miss: 0, combo: 500, beatmapMaxCombo: 500 });
    assert.deepEqual(
      earned(h.medals().medals).filter((s) => s.includes('-fc-')),
      ['osu-skill-fc-1', 'osu-skill-fc-2', 'osu-skill-fc-3'],
    );
  } finally {
    h.cleanup();
  }
});

test('a miss disqualifies an FC even at full combo', () => {
  const h = harness();
  try {
    h.add({ stars: 3.2, miss: 1, combo: 500, beatmapMaxCombo: 500 });
    assert.deepEqual(earned(h.medals().medals).filter((s) => s.includes('-fc-')), []);
    assert.equal(h.medals().fcUnknown, 0, 'a missed play needs no beatmap maximum to judge');
  } finally {
    h.cleanup();
  }
});

/* A score from before the column existed must be reported, not guessed either way. */
test('a play with no recorded beatmap maximum is counted as unknown, not as an FC', () => {
  const h = harness();
  try {
    h.add({ stars: 6.5, miss: 0, combo: 900, beatmapMaxCombo: null });

    const summary = h.medals();
    assert.equal(summary.fcUnknown, 1);
    assert.deepEqual(earned(summary.medals).filter((s) => s.includes('-fc-')), []);
    // The pass medals still work: those need only the star rating.
    assert.ok(find(summary.medals, 'osu-skill-pass-6').achievedAt !== null);
  } finally {
    h.cleanup();
  }
});

/* ----------------------------------------------------------------- rank */

test('rank medals follow the estimated rank, hardest last', () => {
  const h = harness();
  try {
    // A handful of small scores is nowhere near the top 50,000.
    h.add({ pp: 20 });
    assert.deepEqual(earned(h.medals().medals).filter((s) => s.includes('top')), []);

    // Enough pp to be well inside it. The exact rank comes from the sampled curve.
    for (let i = 0; i < 100; i++) h.add({ pp: 700, md5: `big-${i}` });
    const medals = h.medals().medals.filter((m) => m.family === 'rank');
    assert.ok(medals.some((m) => m.achievedAt !== null), 'a strong profile should earn a rank medal');
    // They are ordered easiest to hardest, so anything earned must be a prefix.
    const flags = medals.map((m) => m.achievedAt !== null);
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)));
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------- coherence */

/*
 * Medals are derived, never stored, precisely so this holds: a score removed from the
 * profile can no longer justify a medal, and the medal has to go with it.
 */
test('removing the score that earned a medal takes the medal away', () => {
  const h = harness();
  try {
    const id = h.add({ combo: 800 });
    assert.ok(find(h.medals().medals, 'osu-combo-750').achievedAt !== null);

    applyScoreAction(h.db, h.profileId, id, 'hide');
    assert.equal(find(h.medals().medals, 'osu-combo-750').achievedAt, null);

    applyScoreAction(h.db, h.profileId, id, 'restore');
    assert.ok(find(h.medals().medals, 'osu-combo-750').achievedAt !== null);
  } finally {
    h.cleanup();
  }
});

test('medals belong to one mode and do not leak between them', () => {
  const h = harness();
  try {
    h.add({ mode: 0, combo: 800 });
    assert.ok(find(h.medals(0).medals, 'osu-combo-750').achievedAt !== null);
    // taiko has no combo medals at all, and its own families stay locked.
    assert.equal(h.medals(1).earned, 0);
  } finally {
    h.cleanup();
  }
});

test('the earned count agrees with the medals it reports', () => {
  const h = harness();
  try {
    h.add({ combo: 800, stars: 4.4, miss: 0, beatmapMaxCombo: 800 });
    const summary = h.medals();
    assert.equal(summary.earned, summary.medals.filter((m) => m.achievedAt !== null).length);
    assert.equal(summary.total, summary.medals.length);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------- mod introduction */


/*
 * Mod Introduction, by osu!'s own rules (ppy/osu-queue-score-statistics): pass a map with
 * that mod and nothing else, at its defaults -- System mods and Classic aside -- or, in lazer,
 * with any Conversion or any Fun mod.
 */
test('a Mod Introduction medal needs that mod alone, at its defaults', () => {
  const HR = { mod: 'HR' };
  const mods = (...a: string[]) => a.map((acronym) => ({ acronym }));
  assert.equal(earnsIntroMedal(HR, mods('HR'), 0, 'lazer'), true);
  assert.equal(earnsIntroMedal(HR, mods('HR', 'HD'), 0, 'lazer'), false, 'not alone');
  assert.equal(earnsIntroMedal(HR, mods(), 0, 'lazer'), false);
  // Classic and System mods do not count against "alone": a stable score is played with CL.
  assert.equal(earnsIntroMedal(HR, mods('HR', 'CL'), 0, 'stable'), true);
  assert.equal(earnsIntroMedal(HR, mods('HR', 'TD'), 0, 'lazer'), true);
  assert.equal(earnsIntroMedal(HR, mods('HR', 'SV2'), 1, 'lazer'), true);
  // A customised mod is not the mod at its defaults.
  assert.equal(
    earnsIntroMedal({ mod: 'DT' }, [{ acronym: 'DT', settings: { speed_change: 1.2 } }], 0, 'lazer'),
    false,
  );
  // Nightcore is its own medal, not Double Time's.
  assert.equal(earnsIntroMedal({ mod: 'DT' }, mods('NC'), 0, 'lazer'), false);
  assert.equal(earnsIntroMedal({ mod: 'NC' }, mods('NC'), 0, 'lazer'), true);
  // Spun Out is osu!standard's.
  assert.equal(earnsIntroMedal({ mod: 'SO', ruleset: 0 }, mods('SO'), 0, 'lazer'), true);
  assert.equal(earnsIntroMedal({ mod: 'SO', ruleset: 0 }, mods('SO'), 1, 'lazer'), false);
});

test("the Conversion and Fun medals are lazer's, and take the ruleset's own mod types", () => {
  const conversion = { type: 'Conversion' } as const;
  const fun = { type: 'Fun' } as const;
  assert.equal(earnsIntroMedal(conversion, [{ acronym: 'MR' }, { acronym: 'HD' }], 0, 'lazer'), true);
  assert.equal(earnsIntroMedal(fun, [{ acronym: 'BR' }], 0, 'lazer'), true);
  // The mania key mods are Conversion in mania.
  assert.equal(earnsIntroMedal(conversion, [{ acronym: '4K' }], 3, 'lazer'), true);
  // osu! never runs these on stable scores.
  assert.equal(earnsIntroMedal(conversion, [{ acronym: 'MR' }], 0, 'stable'), false);
});

test('Mod Introduction medals are earned from any mode, and only by passes', () => {
  const h = harness();
  try {
    h.add({ mods: [{ acronym: 'HD' }], passed: false });
    assert.equal(find(h.medals().medals, 'all-intro-hidden').achievedAt, null, 'a failed play does not count');

    const at = 1_700_000_500_000;
    h.add({ mods: [{ acronym: 'HD' }], mode: 1, at });
    // Set in taiko, and shown -- earned, with that date -- whichever mode is open.
    for (const mode of [0, 1, 3]) {
      const medal = find(h.medals(mode).medals, 'all-intro-hidden');
      assert.equal(medal.achievedAt, at);
      assert.equal(medal.grouping, 'Mod Introduction');
    }
    // And it is one medal in the header's count, not one per mode it shows in: the total is
    // the distinct medals earned across all four modes.
    const distinct = new Set([0, 1, 2, 3].flatMap((mode) => earned(h.medals(mode).medals)));
    assert.ok(distinct.has('all-intro-hidden'));
    assert.equal(earnedMedalCount(h.db, h.profileId, VANILLA), distinct.size);
  } finally {
    h.cleanup();
  }
});
