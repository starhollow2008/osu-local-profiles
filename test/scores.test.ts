import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { createProfile } from '../src/profiles.ts';
import {
  applyScoreAction,
  hiddenCount,
  hiddenScores,
  reorderPins,
} from '../src/scores.ts';
import {
  computeStats,
  modesWithPlays,
  mostPlayed,
  mostRecentMode,
  pinnedPlays,
  recentPlays,
  topPlays,
} from '../src/calc/stats.ts';
import { buildHistory } from '../src/calc/history.ts';
import { VANILLA } from '../src/calc/eligibility.ts';
import { Status } from '../src/clients/beatmaps.ts';

interface Fixture {
  md5?: string;
  pp?: number | null;
  mode?: number;
  mapStatus?: number;
  totalScore?: number;
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-scores-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  let n = 0;

  const add = (f: Fixture = {}): number => {
    n++;
    const mapStatus = f.mapStatus ?? Status.RANKED;
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, stars, pp,
         map_status, mods_ranked, mods_countable, ranked, played_at)
       VALUES (?,?,?,?,'lazer','[]','None',100,0,0,0,0,0,0.99,100,?,1,'S',5.0,?,?,1,1,?,?)`,
    ).run(
      profileId, `key-${n}`, f.mode ?? 0, f.md5 ?? `md5-${n}`,
      f.totalScore ?? 500_000,
      f.pp === undefined ? 100 : f.pp,
      mapStatus,
      mapStatus === Status.RANKED || mapStatus === Status.APPROVED ? 1 : 0,
      Date.now() + n * 1000,
    );
    return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  };

  return {
    db,
    profileId,
    add,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/* ----------------------------------------------------------------- hiding */

/*
 * The whole point of a hide: the score has to leave *everything*, not just Top Ranks.
 * Missing one of these would leave a play count that disagrees with the list under it.
 */
test('a removed score disappears from every section and every total', () => {
  const h = harness();
  try {
    h.add({ md5: 'keep' });
    const doomed = h.add({ md5: 'remove' });

    const before = computeStats(h.db, h.profileId, 0, VANILLA);
    assert.equal(before.playcount, 2);

    applyScoreAction(h.db, h.profileId, doomed, 'hide');

    const after = computeStats(h.db, h.profileId, 0, VANILLA);
    assert.equal(after.playcount, 1);
    assert.equal(after.distinctRankedBeatmaps, 1);
    assert.ok(after.totalScore < before.totalScore);
    assert.ok(after.totalPp < before.totalPp);

    assert.equal(topPlays(h.db, h.profileId, 0, 100, VANILLA).length, 1);
    assert.equal(recentPlays(h.db, h.profileId, 0, 25, VANILLA).length, 1);
    assert.equal(mostPlayed(h.db, h.profileId, 0, 15).length, 1);
    assert.equal(buildHistory(h.db, h.profileId, 0, 15, VANILLA).monthlyPlaycounts.at(-1)!.count, 1);
  } finally {
    h.cleanup();
  }
});

/*
 * A DELETE would be re-ingested from the replay still on disk -- and with its dedupe key
 * gone it would come back looking like a brand new score.
 */
test('removing keeps the row, so the replay cannot resurrect it', () => {
  const h = harness();
  try {
    const id = h.add();
    applyScoreAction(h.db, h.profileId, id, 'hide');

    const row = h.db.prepare('SELECT hidden_at, dedupe_key FROM scores WHERE id = ?').get(id) as
      | { hidden_at: number | null; dedupe_key: string }
      | undefined;
    assert.ok(row, 'the row must still exist');
    assert.ok(row.hidden_at! > 0);
    assert.equal(row.dedupe_key, 'key-1');
  } finally {
    h.cleanup();
  }
});

test('a removed score can be put back, and returns to the totals', () => {
  const h = harness();
  try {
    const id = h.add();
    applyScoreAction(h.db, h.profileId, id, 'hide');
    assert.equal(hiddenCount(h.db, h.profileId), 1);
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 0);

    applyScoreAction(h.db, h.profileId, id, 'restore');
    assert.equal(hiddenCount(h.db, h.profileId), 0);
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 1);
  } finally {
    h.cleanup();
  }
});

test('the removed list describes what was removed, newest first', () => {
  const h = harness();
  try {
    const first = h.add();
    const second = h.add();
    applyScoreAction(h.db, h.profileId, first, 'hide');
    applyScoreAction(h.db, h.profileId, second, 'hide');

    const listed = hiddenScores(h.db, h.profileId);
    assert.equal(listed.length, 2);
    assert.equal(listed[0]!.id, second);
    assert.equal(listed[0]!.grade, 'S');
    assert.ok(listed[0]!.hiddenAt >= listed[1]!.hiddenAt);
  } finally {
    h.cleanup();
  }
});

test('the mode tabs and default mode ignore removed scores', () => {
  const h = harness();
  try {
    h.add({ mode: 0 });
    const taiko = h.add({ mode: 1 });

    assert.deepEqual(modesWithPlays(h.db, h.profileId), [0, 1]);
    assert.equal(mostRecentMode(h.db, h.profileId), 1);

    applyScoreAction(h.db, h.profileId, taiko, 'hide');
    assert.deepEqual(modesWithPlays(h.db, h.profileId), [0]);
    assert.equal(mostRecentMode(h.db, h.profileId), 0);
  } finally {
    h.cleanup();
  }
});

/* ---------------------------------------------------------------- pinning */

test('pinning keeps the order things were pinned in', () => {
  const h = harness();
  try {
    const a = h.add();
    const b = h.add();
    const c = h.add();
    for (const id of [c, a, b]) applyScoreAction(h.db, h.profileId, id, 'pin');

    assert.deepEqual(
      pinnedPlays(h.db, h.profileId, 0, VANILLA).map((p) => p.id),
      [c, a, b],
    );
  } finally {
    h.cleanup();
  }
});

/* An unranked play is exactly the kind of thing pinning exists for. */
test('a pin does not have to be a score that counts', () => {
  const h = harness();
  try {
    const loved = h.add({ mapStatus: Status.LOVED });
    applyScoreAction(h.db, h.profileId, loved, 'pin');

    const pinned = pinnedPlays(h.db, h.profileId, 0, VANILLA);
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0]!.counted, false);
    // ...and it still contributes nothing to the totals.
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).distinctRankedBeatmaps, 0);
  } finally {
    h.cleanup();
  }
});

test('reordering follows the list it is given', () => {
  const h = harness();
  try {
    const ids = [h.add(), h.add(), h.add()];
    for (const id of ids) applyScoreAction(h.db, h.profileId, id, 'pin');

    reorderPins(h.db, h.profileId, [ids[2]!, ids[0]!, ids[1]!]);
    assert.deepEqual(
      pinnedPlays(h.db, h.profileId, 0, VANILLA).map((p) => p.id),
      [ids[2], ids[0], ids[1]],
    );
  } finally {
    h.cleanup();
  }
});

/*
 * A page that has not seen a newly pinned score must not be able to unpin it by leaving it
 * out of the order it sends.
 */
test('a partial reorder pushes the rest after, it does not drop them', () => {
  const h = harness();
  try {
    const ids = [h.add(), h.add(), h.add()];
    for (const id of ids) applyScoreAction(h.db, h.profileId, id, 'pin');

    reorderPins(h.db, h.profileId, [ids[1]!]);
    const after = pinnedPlays(h.db, h.profileId, 0, VANILLA).map((p) => p.id);
    assert.equal(after.length, 3);
    assert.equal(after[0], ids[1]);
    assert.deepEqual(after.slice(1).sort(), [ids[0], ids[2]].sort());
  } finally {
    h.cleanup();
  }
});

test('unpinning leaves the score alone otherwise', () => {
  const h = harness();
  try {
    const id = h.add();
    applyScoreAction(h.db, h.profileId, id, 'pin');
    applyScoreAction(h.db, h.profileId, id, 'unpin');

    assert.equal(pinnedPlays(h.db, h.profileId, 0, VANILLA).length, 0);
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 1);
  } finally {
    h.cleanup();
  }
});

/* A pin left behind on a removed score would be a gap nothing on screen could explain. */
test('removing a pinned score unpins it too', () => {
  const h = harness();
  try {
    const id = h.add();
    applyScoreAction(h.db, h.profileId, id, 'pin');
    applyScoreAction(h.db, h.profileId, id, 'hide');

    assert.equal(pinnedPlays(h.db, h.profileId, 0, VANILLA).length, 0);
    // Putting it back does not silently re-pin it either.
    applyScoreAction(h.db, h.profileId, id, 'restore');
    assert.equal(pinnedPlays(h.db, h.profileId, 0, VANILLA).length, 0);
  } finally {
    h.cleanup();
  }
});

test('pins are per mode', () => {
  const h = harness();
  try {
    const std = h.add({ mode: 0 });
    const taiko = h.add({ mode: 1 });
    applyScoreAction(h.db, h.profileId, std, 'pin');
    applyScoreAction(h.db, h.profileId, taiko, 'pin');

    assert.deepEqual(pinnedPlays(h.db, h.profileId, 0, VANILLA).map((p) => p.id), [std]);
    assert.deepEqual(pinnedPlays(h.db, h.profileId, 1, VANILLA).map((p) => p.id), [taiko]);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------- ownership */

test('a score belonging to another profile cannot be touched', () => {
  const h = harness();
  try {
    const id = h.add();
    const other = createProfile(h.db, 'Left hand');

    assert.throws(() => applyScoreAction(h.db, other.id, id, 'hide'), /no score/);
    assert.equal(hiddenCount(h.db, h.profileId), 0);

    // Reordering is filtered by profile rather than throwing, so the pin is simply not moved.
    applyScoreAction(h.db, h.profileId, id, 'pin');
    reorderPins(h.db, other.id, [id]);
    assert.deepEqual(pinnedPlays(h.db, h.profileId, 0, VANILLA).map((p) => p.id), [id]);
  } finally {
    h.cleanup();
  }
});

test('an unknown action is refused rather than ignored', () => {
  const h = harness();
  try {
    const id = h.add();
    assert.throws(
      () => applyScoreAction(h.db, h.profileId, id, 'destroy' as never),
      /unknown action/,
    );
  } finally {
    h.cleanup();
  }
});
