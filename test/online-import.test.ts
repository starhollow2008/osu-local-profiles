import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import {
  extractStanding,
  scoreFromJson,
  type OsuWebScore,
  type OsuWebStanding,
} from '../src/clients/osu-web.ts';
import {
  borrowedBonusPp,
  findExistingScore,
  importMode,
  importScore,
  replayIdentity,
} from '../src/tracker/online-import.ts';
import { ingestScore } from '../src/tracker/ingest.ts';
import { importedBonusPp } from '../src/standing.ts';
import { computeStats } from '../src/calc/stats.ts';
import type { ReplayScore } from '../src/osr.ts';

/*
 * Importing an osu! account's own record of its plays.
 *
 * Nothing here touches the network: every function that reaches osu.ppy.sh is a thin page
 * loop around the pure readers below, which is the same split identity.test.ts keeps. The
 * payloads are the real shape, taken from what osu.ppy.sh actually answered for
 * /users/3119700/scores/best -- field names, judgement names and the two score scales
 * included -- so a change to that shape fails here rather than in the wild.
 *
 * The weight of it is deduplication. The same play can arrive twice, once from osu!'s record
 * and once from its replay when a whole history is imported off this machine later, and the
 * two have nothing in common to key on: a replay knows its own hash, osu! knows its score id.
 * Most of what follows is about that.
 */

const MD5 = 'd4e23a5746b9a780f9faa10189521498';

/** One score object, in the shape osu-web serialises. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1716608692,
    legacy_score_id: 4430944113,
    ruleset_id: 0,
    beatmap_id: 2403946,
    rank: 'S',
    pp: 378.504,
    accuracy: 0.993169,
    max_combo: 1298,
    total_score: 1051812,
    legacy_total_score: 40966260,
    classic_total_score: 32738070,
    mods: [{ acronym: 'HR' }, { acronym: 'CL' }],
    statistics: { ok: 10, great: 966 },
    maximum_statistics: { great: 976, legacy_combo_increase: 323 },
    ended_at: '2023-05-04T10:10:36Z',
    passed: true,
    ranked: true,
    weight: { percentage: 100, pp: 378.504 },
    beatmap: {
      id: 2403946,
      beatmapset_id: 1140099,
      checksum: MD5,
      version: "Kowari's Confession",
      status: 'ranked',
      difficulty_rating: 5.76727,
    },
    beatmapset: {
      id: 1140099,
      artist: 'CHiCO with HoneyWorks',
      title: 'Heart no Shuchou',
      creator: 'Nathan',
    },
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): OsuWebScore {
  const score = scoreFromJson(payload(over));
  assert.ok(score, 'the payload should parse');
  return score;
}

interface Harness {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-online-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Test Profile');
  return {
    db,
    resolver: new BeatmapResolver(db, []),
    profileId,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Import one score and hand back the row it landed on, refusing a `skipped` outcome. */
function importedId(h: Harness, score: OsuWebScore): number {
  const outcome = importScore(h.db, h.resolver, h.profileId, score);
  assert.ok(outcome.status !== 'skipped', `expected a row, got ${outcome.status}`);
  return outcome.id;
}

/** The replay of that same play, as osu!stable would have written it. */
function stableReplay(over: Partial<ReplayScore> = {}): ReplayScore {
  return {
    client: 'stable',
    mode: 0,
    version: 20230504,
    beatmapMD5: MD5,
    username: 'Tangy',
    replayMD5: 'a-replay-hash',
    count300: 966,
    count100: 10,
    count50: 0,
    countGeki: 0,
    countKatu: 0,
    countMiss: 0,
    // What a stable replay carries is osu!'s old uncapped total, which is the scale an
    // imported row stores for a stable play -- the whole basis of matching them without ids.
    totalScore: 40966260,
    maxCombo: 1298,
    perfectCombo: false,
    legacyMods: 16,
    playedAt: new Date('2023-05-04T10:10:36Z'),
    onlineScoreId: 4430944113n,
    extras: null,
    mcosu: null,
    ...over,
  };
}

test('a score is read from the shape osu-web actually answers with', () => {
  const score = parsed();

  assert.equal(score.id, '1716608692');
  assert.equal(score.legacyScoreId, '4430944113');
  assert.equal(score.mode, 0);
  assert.equal(score.beatmapMD5, MD5);
  assert.equal(score.artist, 'CHiCO with HoneyWorks');
  assert.equal(score.version, "Kowari's Confession");
  // 'ranked' as osu-web names it is 1 in osu!'s own approved enum.
  assert.equal(score.mapStatus, 1);
  assert.equal(score.grade, 'S');
  assert.equal(score.pp, 378.504);
  assert.deepEqual(
    score.mods.map((m) => m.acronym),
    ['HR', 'CL'],
  );
  assert.equal(score.playedAt, Date.parse('2023-05-04T10:10:36Z'));
  assert.equal(score.weightPercentage, 100);
});

test('a score with no usable id is dropped rather than imported unidentifiable', () => {
  // An id that JSON.parse would have had to round is not that id, and a score that cannot be
  // matched to its replay is the one thing an import must not write.
  assert.equal(scoreFromJson(payload({ id: Number.MAX_SAFE_INTEGER + 2 })), null);
  assert.equal(scoreFromJson(payload({ id: 'not-a-number' })), null);
  // The legacy id is optional: a lazer-era play has none.
  assert.equal(parsed({ legacy_score_id: null }).legacyScoreId, null);
});

test('a beatmap status osu! has renamed counts as unresolved, never as ranked', () => {
  const score = parsed({ beatmap: { ...(payload()['beatmap'] as object), status: 'something-new' } });
  assert.equal(score.mapStatus, -3);
});

test('an imported score stores osu! pp, and the total on the scale its replay would have', () => {
  const h = harness();
  try {
    const outcome = importScore(h.db, h.resolver, h.profileId, parsed());
    assert.equal(outcome.status, 'added');

    const row = h.db.prepare('SELECT * FROM scores WHERE id = ?').get(outcome.id) as Record<string, unknown>;
    assert.equal(row['pp'], 378.504);
    assert.equal(row['pp_source'], 'osu-web');
    // No replay here, so no breakdown -- and the rule is that parts always belong to the pp
    // printed beside them, so there must be none rather than a mismatched set.
    assert.equal(row['pp_parts'], null);
    assert.equal(row['pp_version'], null);
    assert.ok(row['imported_at'] !== null, 'an imported row has to be marked as one');
    assert.equal(row['replay_path'], null);

    assert.equal(row['online_score_id'], '1716608692');
    assert.equal(row['legacy_score_id'], '4430944113');
    // A stable play, so total_score is osu!'s old uncapped number -- exactly what the replay
    // of it carries. Both of osu!'s own scales sit beside it.
    assert.equal(row['total_score'], 40966260);
    assert.equal(row['score_standard'], 1051812);
    assert.equal(row['score_classic'], 32738070);
    assert.equal(row['client'], 'stable');
    assert.equal(row['grade'], 'S');
    assert.equal(row['ranked'], 1);
    assert.equal(row['count300'], 966);
    assert.equal(row['count100'], 10);
  } finally {
    h.cleanup();
  }
});

test('a play wearing mods that change difficulty stores no star rating at all', () => {
  const h = harness();
  try {
    // HR changes the rating, and osu! hands over only the unmodded one, so claiming it would
    // be claiming a number that is wrong.
    const hardRock = importedId(h, parsed());
    assert.equal(
      (h.db.prepare('SELECT stars FROM scores WHERE id = ?').get(hardRock) as { stars: number | null }).stars,
      null,
    );

    // Hidden and Classic leave it exactly as it is, so the beatmap's own rating stands.
    const hidden = importedId(h, parsed({ id: 22, legacy_score_id: null, mods: [{ acronym: 'HD' }] }));
    assert.equal(
      (h.db.prepare('SELECT stars FROM scores WHERE id = ?').get(hidden) as { stars: number | null }).stars,
      5.76727,
    );
  } finally {
    h.cleanup();
  }
});

test("a beatmap this machine does not have still gets its name from osu!", () => {
  const h = harness();
  try {
    importScore(h.db, h.resolver, h.profileId, parsed());
    const beatmap = h.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(MD5) as Record<string, unknown>;
    // The case this whole feature exists for: a best performance set years ago on another
    // PC, on a map that was never installed here.
    assert.equal(beatmap['osu_path'], null);
    assert.equal(beatmap['artist'], 'CHiCO with HoneyWorks');
    assert.equal(beatmap['title'], 'Heart no Shuchou');
    assert.equal(beatmap['version'], "Kowari's Confession");
    assert.equal(beatmap['status'], 1);
    assert.equal(beatmap['stars'], 5.76727);
  } finally {
    h.cleanup();
  }
});

test('importing the same list twice updates and never duplicates', () => {
  const h = harness();
  try {
    assert.equal(importScore(h.db, h.resolver, h.profileId, parsed()).status, 'added');
    // osu! reworks pp and re-ranks beatmaps, so a second import is how a profile picks that
    // up -- an update rather than a skip, and never a second row.
    const again = importScore(h.db, h.resolver, h.profileId, parsed({ pp: 401.2 }));
    assert.equal(again.status, 'updated');

    const rows = h.db.prepare('SELECT pp FROM scores').all() as { pp: number }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.pp, 401.2);
  } finally {
    h.cleanup();
  }
});

test('a play already tracked from its replay is recognised, not imported over', async () => {
  const h = harness();
  try {
    // Tracked first, from the replay on this machine.
    const tracked = await ingestScore(stableReplay(), '/replays/one.osr', {
      db: h.db,
      resolver: h.resolver,
      profileId: h.profileId,
      trackingSince: 0,
      official: null,
    });
    assert.equal(tracked.status, 'added');

    // osu!'s record of the very same play must land on that row and leave it alone: it was
    // priced by osu!'s calculator on this machine and carries the replay to prove it.
    const imported = importScore(h.db, h.resolver, h.profileId, parsed());
    assert.equal(imported.status, 'tracked');

    const rows = h.db.prepare('SELECT imported_at, replay_path FROM scores').all() as
      { imported_at: number | null; replay_path: string | null }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.imported_at, null, 'the tracked row must stay a tracked row');
    assert.equal(rows[0]!.replay_path, '/replays/one.osr');
  } finally {
    h.cleanup();
  }
});

test('importing past plays later does not add an imported score a second time', async () => {
  const h = harness();
  try {
    assert.equal(importScore(h.db, h.resolver, h.profileId, parsed()).status, 'added');

    // The user now imports their whole replay history off this machine. The replay of that
    // same play has to be recognised -- its dedupe_key cannot match, because a replay keys on
    // its own hash and an imported score on osu!'s id.
    const again = await ingestScore(stableReplay(), '/replays/one.osr', {
      db: h.db,
      resolver: h.resolver,
      profileId: h.profileId,
      trackingSince: 0,
      official: null,
    });
    assert.deepEqual(again, { status: 'skipped', reason: 'duplicate' });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 1);
  } finally {
    h.cleanup();
  }
});

test('a replay too old to carry an id is still matched by the play itself', async () => {
  const h = harness();
  try {
    importScore(h.db, h.resolver, h.profileId, parsed());

    // osu!stable only began recording an online id in 2014; before that there is nothing to
    // match on but the play. Same map, same total, same combo, same moment.
    const ancient = await ingestScore(
      stableReplay({ onlineScoreId: null, replayMD5: 'another-hash' }),
      '/replays/old.osr',
      { db: h.db, resolver: h.resolver, profileId: h.profileId, trackingSince: 0, official: null },
    );
    assert.deepEqual(ancient, { status: 'skipped', reason: 'duplicate' });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 1);
  } finally {
    h.cleanup();
  }
});

test('a genuinely different play on the same map is not swallowed', async () => {
  const h = harness();
  try {
    importScore(h.db, h.resolver, h.profileId, parsed());

    // A later run on the same beatmap, scoring differently. Nothing about it says it is the
    // imported play, and a dedupe that ate it would lose a play silently -- the one failure
    // worse than a duplicate, because a duplicate can at least be seen and removed.
    const different = await ingestScore(
      stableReplay({
        onlineScoreId: null,
        replayMD5: 'a-different-hash',
        totalScore: 39000000,
        maxCombo: 1100,
        playedAt: new Date('2024-01-01T00:00:00Z'),
      }),
      '/replays/two.osr',
      { db: h.db, resolver: h.resolver, profileId: h.profileId, trackingSince: 0, official: null },
    );
    assert.equal(different.status, 'added');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 2);
  } finally {
    h.cleanup();
  }
});

test('a lazer replay matches by its own id, a stable one by the legacy id', () => {
  const h = harness();
  try {
    const id = importedId(h, parsed());

    // lazer numbers a score one way, osu!stable another, and a replay carries whichever its
    // client used -- so an imported row keeps both and is matched on either.
    const byLazerId = findExistingScore(h.db, h.profileId, {
      onlineIds: ['1716608692'],
      beatmapMD5: 'unrelated',
      playedAt: 0,
      maxCombo: 0,
      totals: [],
    });
    assert.deepEqual(byLazerId, { id, imported: true });

    const byLegacyId = findExistingScore(h.db, h.profileId, {
      onlineIds: ['4430944113'],
      beatmapMD5: 'unrelated',
      playedAt: 0,
      maxCombo: 0,
      totals: [],
    });
    assert.deepEqual(byLegacyId, { id, imported: true });

    // Stable wrote 0 for a play it never submitted; that is not an id and must match nothing.
    assert.equal(
      findExistingScore(h.db, h.profileId, {
        onlineIds: ['0'],
        beatmapMD5: 'unrelated',
        playedAt: 0,
        maxCombo: 0,
        totals: [],
      }),
      null,
    );
  } finally {
    h.cleanup();
  }
});

test('a replay describes its play the same way osu! does', () => {
  const identity = replayIdentity(stableReplay());
  assert.deepEqual(identity.onlineIds, ['4430944113']);
  assert.equal(identity.beatmapMD5, MD5);
  assert.deepEqual(identity.totals, [40966260]);
});

test('pinned scores are imported whether or not they are best performances', () => {
  const h = harness();
  try {
    const best = [parsed()];
    // Pinning is how you show a play pp does not reward, so a pinned score may be on a loved
    // map and worth nothing -- and would be in no other list.
    const loved = parsed({
      id: 999,
      legacy_score_id: null,
      pp: null,
      ranked: false,
      beatmap: { ...(payload()['beatmap'] as object), checksum: 'b'.repeat(32), status: 'loved' },
    });
    const result = importMode(h.db, h.resolver, h.profileId, 0, best, [parsed(), loved], null);

    assert.equal(result.added, 2, 'the best performance and the loved pin');
    assert.equal(result.pinned, 2);

    const pins = h.db
      .prepare('SELECT online_score_id, pin_order FROM scores WHERE pinned_at IS NOT NULL ORDER BY pin_order')
      .all() as { online_score_id: string; pin_order: number }[];
    // Pinned in osu!'s own order, because pinning appends and they are walked in that order.
    assert.deepEqual(pins.map((p) => p.online_score_id), ['1716608692', '999']);
    assert.deepEqual(pins.map((p) => p.pin_order), [0, 1]);
  } finally {
    h.cleanup();
  }
});

test("bonus pp is what osu!'s total has that the imported scores cannot account for", () => {
  // The real figures from the account this was built on.
  const standing: OsuWebStanding = { totalPp: 7380.07, globalRank: 31049, countryRank: 6122 };
  const one = parsed();

  // One score worth 378.504 at full weight leaves the rest as the borrowed remainder.
  const bonus = borrowedBonusPp([one], standing);
  assert.ok(bonus !== null);
  assert.ok(Math.abs(bonus - (7380.07 - 378.504)) < 0.001, `got ${bonus}`);

  // No standing to read means nothing is borrowed rather than something invented.
  assert.equal(borrowedBonusPp([one], { totalPp: null, globalRank: null, countryRank: null }), null);

  // A garbled total must not price the profile below zero.
  assert.equal(borrowedBonusPp([one], { totalPp: 1, globalRank: null, countryRank: null }), 0);
});

test("the borrowed bonus lands the profile's total on osu!'s own", () => {
  const h = harness();
  try {
    const standing: OsuWebStanding = { totalPp: 7380.07, globalRank: 31049, countryRank: 6122 };
    importMode(h.db, h.resolver, h.profileId, 0, [parsed()], [], standing);

    assert.ok(importedBonusPp(h.db, h.profileId, 0) !== null);
    const stats = computeStats(h.db, h.profileId, 0);
    assert.equal(stats.bonusPpBorrowed, true);
    // The point of borrowing: the profile reads what osu! reads, rather than hundreds short.
    assert.ok(
      Math.abs(stats.totalPp - 7380.07) < 0.01,
      `expected osu!'s own total, got ${stats.totalPp}`,
    );
  } finally {
    h.cleanup();
  }
});

test("a profile's own plays supersede the borrowed bonus without anything being cleared", () => {
  const h = harness();
  try {
    // A modest borrowed figure: 428.504 total against one score worth 378.504 leaves 50,
    // which beats the 2.08 a single distinct ranked beatmap earns.
    importMode(h.db, h.resolver, h.profileId, 0, [parsed()], [], {
      totalPp: 428.504,
      globalRank: 1,
      countryRank: 1,
    });
    const borrowed = computeStats(h.db, h.profileId, 0);
    assert.equal(borrowed.bonusPpBorrowed, true);
    assert.ok(Math.abs(borrowed.bonusPp - 50) < 0.001, `got ${borrowed.bonusPp}`);

    // Enough distinct ranked beatmaps of its own and the profile's earned bonus overtakes it,
    // with no moment where the figure jumps backwards: 60 maps earn 108pp against the 50
    // borrowed, and `Math.max` hands over at the crossing.
    for (let i = 0; i < 60; i++) {
      importScore(
        h.db,
        h.resolver,
        h.profileId,
        parsed({
          id: 100000 + i,
          legacy_score_id: null,
          pp: 10,
          beatmap: { ...(payload()['beatmap'] as object), checksum: String(i).padStart(32, '0') },
        }),
      );
    }
    const stats = computeStats(h.db, h.profileId, 0);
    assert.equal(stats.bonusPpBorrowed, false);
    assert.ok(stats.bonusPp > 50, `the profile's own bonus should have taken over: ${stats.bonusPp}`);
  } finally {
    h.cleanup();
  }
});

test("osu!'s standing is read off the profile payload, and a missing one is not an error", () => {
  const page = (json: string) => `<div data-initial-data="${json.replaceAll('"', '&quot;')}"></div>`;

  const standing = extractStanding(
    page(JSON.stringify({ user: { statistics: { pp: 7380.07, global_rank: 31049, country_rank: 6122 } } })),
  );
  assert.deepEqual(standing, { totalPp: 7380.07, globalRank: 31049, countryRank: 6122 });

  // An account that has never played a ruleset has no rank there, which is normal.
  assert.deepEqual(extractStanding(page(JSON.stringify({ user: { statistics: {} } }))), {
    totalPp: null,
    globalRank: null,
    countryRank: null,
  });
  assert.deepEqual(extractStanding('<html>not the page this reads</html>'), {
    totalPp: null,
    globalRank: null,
    countryRank: null,
  });
});
