import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrCreateProfile, openDb, type Db } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import {
  markRecalculatedFor,
  recalculatedFor,
  recalculationBatches,
  RECALCULATE_BATCH,
} from '../src/tracker/recompute.ts';
import { outdatedPpCount } from '../src/scores.ts';
import type { OfficialCalculator } from '../src/calc/official.ts';

/**
 * A database with two profiles and scores in every state a recalculation has to tell apart.
 * Every replay path points at nothing, so a recalculation reads none of them: what it chose
 * to look at is the thing under test, not osu!'s calculator.
 */
function fixture(): { db: Db; left: number; mouse: number; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-recalc-'));
  const db = openDb(path.join(dir, 'profiles.db'));
  const left = getOrCreateProfile(db, 'Left');
  const mouse = getOrCreateProfile(db, 'Mouse');
  const insert = db.prepare(
    `INSERT INTO scores
      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
       count300, count100, count50, count_geki, count_katu, count_miss,
       accuracy, max_combo, total_score, passed, grade, stars, played_at,
       replay_path, pp, pp_version, hidden_at, imported_at)
     VALUES (?, ?, 0, 'm1', 'lazer', '[]', '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1, ?, ?, ?, ?, ?, ?)`,
  );
  const add = (
    profile: number,
    key: string,
    at: number,
    o: { replay?: boolean; pp?: number | null; version?: string | null; hidden?: boolean; imported?: boolean },
  ) =>
    insert.run(
      profile,
      key,
      at,
      o.replay === false ? null : path.join(dir, `${key}.osr`),
      o.pp === undefined ? 100 : o.pp,
      o.version === undefined ? 'old' : o.version,
      o.hidden ? 1 : null,
      o.imported ? 1 : null,
    );

  add(left, 'old', 3, {});
  add(left, 'current', 2, { version: 'new' });
  add(left, 'unversioned', 1, { version: null });
  add(left, 'hidden-old', 4, { hidden: true });
  add(left, 'no-pp', 5, { pp: null, version: null });
  add(left, 'no-replay', 6, { replay: false });
  add(left, 'imported', 7, { replay: false, imported: true });
  add(mouse, 'mouse-old', 1, {});
  return { db, left, mouse, dir };
}

const keysOf = (db: Db, ids: number[]) =>
  ids.map((id) => (db.prepare('SELECT dedupe_key FROM scores WHERE id = ?').get(id) as { dedupe_key: string }).dedupe_key);

/* ------------------------------------------------------------ what is picked */

test('after an update, only scores another release priced are picked, in every profile', () => {
  const { db, left, mouse } = fixture();
  const batches = recalculationBatches(db, 'new');
  assert.deepEqual(
    batches.map((b) => ({ profileId: b.profileId, keys: keysOf(db, b.ids) })),
    [
      // Oldest first; hidden ones too, so a score put back is not priced by the old algorithm.
      { profileId: left, keys: ['unversioned', 'old', 'hidden-old'] },
      { profileId: mouse, keys: ['mouse-old'] },
    ],
  );
  db.close();
});

test('recalculating everything takes every score a replay can price, whatever priced it', () => {
  const { db } = fixture();
  const keys = recalculationBatches(db, null).flatMap((b) => keysOf(db, b.ids));
  assert.deepEqual(keys.sort(), ['current', 'hidden-old', 'mouse-old', 'no-pp', 'old', 'unversioned'].sort());
  // Never a score with no replay behind it: osu!'s own pp for an imported one, or one whose
  // replay was never recorded, has nothing to recalculate from.
  assert.ok(!keys.includes('no-replay') && !keys.includes('imported'));
  db.close();
});

test('Other settings counts what an update would recalculate, less what is hidden', () => {
  const { db, left } = fixture();
  assert.equal(outdatedPpCount(db, left, 'new'), 2);
  db.close();
});

test('one step never holds more than a batch, or two profiles', () => {
  const { db, left, dir } = fixture();
  const insert = db.prepare(
    `INSERT INTO scores
      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
       count300, count100, count50, count_geki, count_katu, count_miss,
       accuracy, max_combo, total_score, passed, grade, stars, played_at, replay_path, pp, pp_version)
     VALUES (?, ?, 0, 'm1', 'lazer', '[]', '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1, ?, ?, 100, 'old')`,
  );
  for (let i = 0; i < RECALCULATE_BATCH * 2; i += 1) insert.run(left, `bulk-${i}`, 100 + i, path.join(dir, `b${i}.osr`));

  const batches = recalculationBatches(db, 'new');
  assert.ok(batches.every((b) => b.ids.length <= RECALCULATE_BATCH));
  assert.equal(batches.reduce((n, b) => n + b.ids.length, 0), RECALCULATE_BATCH * 2 + 4);
  assert.deepEqual(
    batches.map((b) => b.profileId),
    [left, left, left, batches.at(-1)!.profileId],
  );
  assert.notEqual(batches.at(-1)!.profileId, left);
  db.close();
});

/* ---------------------------------------------------- once per osu! release */

test('the release last recalculated for is remembered', () => {
  const { db } = fixture();
  assert.equal(recalculatedFor(db), null);
  markRecalculatedFor(db, '2026.916.0');
  markRecalculatedFor(db, '2026.1001.0');
  assert.equal(recalculatedFor(db), '2026.1001.0');
  db.close();
});

/** A calculator that answers nothing: every replay here is missing anyway. */
function calculator(version: string | null): OfficialCalculator {
  return { version, ranked: async () => null } as unknown as OfficialCalculator;
}

function trackerFor(db: Db, profileId: number, official: OfficialCalculator | null): Tracker {
  return new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [],
    profileId,
    trackingSince: 0,
    official,
  });
}

test('the first launch with a new calculator recalculates what the old one priced, once', async () => {
  const { db, left } = fixture();
  const tracker = trackerFor(db, left, calculator('new'));
  const progress: { done: number; total: number }[] = [];
  tracker.on('recalculating', (p) => progress.push(p));

  const first = await tracker.recalculateAfterUpdate();
  assert.equal(first?.release, 'new');
  assert.equal(first?.result.considered, 4);
  // The replays are missing, so every score keeps what it had rather than losing its pp.
  assert.equal(first?.result.skipped, 4);
  assert.equal((db.prepare("SELECT pp FROM scores WHERE dedupe_key = 'old'").get() as { pp: number }).pp, 100);
  assert.deepEqual(progress.at(0), { done: 0, total: 4 });
  assert.deepEqual(progress.at(-1), { done: 4, total: 4 });
  assert.equal(tracker.recalculating, false);

  // Those four are still priced by the old release, and will stay so: not retried every launch.
  assert.equal(await tracker.recalculateAfterUpdate(), null);
  db.close();
});

test('a fresh install, or one with nothing outdated, recalculates nothing and says so once', async () => {
  const { db, left } = fixture();
  db.exec("UPDATE scores SET pp_version = 'new'");
  const tracker = trackerFor(db, left, calculator('new'));
  let started = false;
  tracker.on('recalculating', () => (started = true));
  assert.equal(await tracker.recalculateAfterUpdate(), null);
  assert.equal(started, false);
  assert.equal(recalculatedFor(db), 'new');
  db.close();
});

test('with no calculator, or one that cannot name its release, nothing is recalculated', async () => {
  const { db, left } = fixture();
  assert.equal(await trackerFor(db, left, null).recalculateAfterUpdate(), null);
  assert.equal(await trackerFor(db, left, calculator(null)).recalculateAfterUpdate(), null);
  await assert.rejects(trackerFor(db, left, null).recalculate(false), /not available/);
  assert.equal(recalculatedFor(db), null);
  db.close();
});

test('only one recalculation runs at a time', async () => {
  const { db, left } = fixture();
  const tracker = trackerFor(db, left, calculator('new'));
  const all = tracker.recalculate(false);
  assert.equal(tracker.recalculating, true);
  await assert.rejects(tracker.recalculate(false), /already being recalculated/);
  const result = await all;
  assert.equal(result.considered, 6);
  assert.equal(tracker.recalculating, false);
  db.close();
});
