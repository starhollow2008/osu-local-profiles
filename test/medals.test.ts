import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { computeMedals, type Medal } from '../src/calc/medals.ts';
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
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-medals-'));
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
       VALUES (?,?,?,?,'lazer','[]','None',?,0,0,0,0,?,0.99,?,500000,?,'S',?,?,?,?,1,1,1,?)`,
    ).run(
      profileId, `key-${n}`, f.mode ?? 0, f.md5 ?? `md5-${n}`,
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
    // osu!standard: 4 combo + 4 plays + 10 pass + 10 fc + 4 rank.
    assert.equal(summary.total, 32);
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
      assert.deepEqual([...families].sort(), ['fc', 'hits', 'pass', 'rank']);
      // 4 hits + 8 pass + 8 fc + 4 rank.
      assert.equal(h.medals(mode).total, 24);
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

test('a locked running-total medal reports how far along it is', () => {
  const h = harness();
  try {
    h.add({ combo: 250 });
    const medal = find(h.medals().medals, 'osu-combo-500');
    assert.equal(medal.progress, 0.5);
    assert.equal(medal.achievedAt, null);
  } finally {
    h.cleanup();
  }
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
