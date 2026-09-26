import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver, refreshBeatmapStatuses, Status, UNRESOLVED_STATUS } from '../src/clients/beatmaps.ts';
import type { OsuInstall } from '../src/clients/detect.ts';

/*
 * Ranked status comes from lazer's online.db, a snapshot it downloads about once a month. A map
 * ranked since was stored with no status and stayed that way; and while the app held the file
 * open, lazer could not replace it at all. See `refreshBeatmapStatuses` and `fromOnline`.
 */

const MD5 = 'a'.repeat(32);

/** An online.db with just the columns this app reads, holding these beatmaps. */
function writeOnlineDb(file: string, beatmaps: { md5: string; id: number; set: number; approved: number }[]) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE osu_beatmaps (beatmap_id INTEGER PRIMARY KEY, beatmapset_id INTEGER,
             checksum TEXT, approved INTEGER, filename TEXT, user_id INTEGER);
           CREATE TABLE osu_beatmapsets (beatmapset_id INTEGER PRIMARY KEY, submit_date TEXT, approved_date TEXT);`);
  for (const b of beatmaps) {
    db.prepare('INSERT INTO osu_beatmaps VALUES (?, ?, ?, ?, ?, 1)').run(b.id, b.set, b.md5, b.approved, 'a - b (c) [d].osu');
    db.prepare('INSERT OR IGNORE INTO osu_beatmapsets VALUES (?, ?, ?)').run(
      b.set, '2026-08-01 00:00:00+00:00', '2026-09-20 00:00:00+00:00',
    );
  }
  db.close();
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-online-'));
  const onlineDb = path.join(tmp, 'online.db');
  writeOnlineDb(onlineDb, []);
  const install: OsuInstall = { kind: 'lazer', root: tmp, replayDir: tmp, beatmapRoots: [], onlineDb };
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Statuses');
  return {
    tmp,
    onlineDb,
    install,
    db,
    profileId,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('online.db is not held open between lookups, so lazer can replace it', () => {
  const h = harness();
  try {
    writeOnlineDb(h.onlineDb, [{ md5: MD5, id: 11, set: 22, approved: Status.RANKED }]);
    const resolver = new BeatmapResolver(h.db, [h.install]);
    assert.equal(resolver.resolve(MD5).status, Status.RANKED);

    // What lazer's refresh amounts to. On Windows this failed while the app ran, because the
    // resolver kept the file open for its whole life.
    const fresh = `${h.onlineDb}.new`;
    writeOnlineDb(fresh, []);
    fs.renameSync(fresh, h.onlineDb);
    assert.equal(resolver.beatmapsetDates(22), null, 'and the next lookup reads the new file');
  } finally {
    h.cleanup();
  }
});

test('a map ranked after the snapshot is updated once lazer has a newer one', () => {
  const h = harness();
  try {
    const resolver = new BeatmapResolver(h.db, [h.install]);
    // Played before the snapshot had it: no status, counted as never submitted.
    assert.equal(resolver.resolve(MD5).status, null);
    h.db.prepare(
      `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss, accuracy, max_combo,
         total_score, passed, grade, pp, map_status, mods_ranked, ranked, played_at)
       VALUES (?, 'k', 0, ?, 'lazer', '[]', 'None', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 100, ?, 1, 0, 0)`,
    ).run(h.profileId, MD5, UNRESOLVED_STATUS);
    // The filter looked for its ranked date and found none.
    h.db.prepare('UPDATE beatmaps SET ranked_at = 0 WHERE md5 = ?').run(MD5);

    // The first look records the file as it is; nothing to change yet.
    assert.deepEqual(refreshBeatmapStatuses(h.db, resolver), { beatmaps: 0, scores: 0 });
    assert.equal(refreshBeatmapStatuses(h.db, resolver), null, 'unchanged file, no second pass');

    // lazer downloads a snapshot that has it.
    writeOnlineDb(h.onlineDb, [{ md5: MD5, id: 11, set: 22, approved: Status.RANKED }]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(h.onlineDb, later, later);

    assert.deepEqual(refreshBeatmapStatuses(h.db, resolver), { beatmaps: 1, scores: 1 });
    const beatmap = h.db.prepare('SELECT status, beatmap_id, beatmapset_id, ranked_at FROM beatmaps WHERE md5 = ?').get(MD5);
    assert.deepEqual({ ...beatmap }, { status: Status.RANKED, beatmap_id: 11, beatmapset_id: 22, ranked_at: null });
    const score = h.db.prepare('SELECT map_status, ranked, pp FROM scores WHERE beatmap_md5 = ?').get(MD5);
    assert.deepEqual({ ...score }, { map_status: Status.RANKED, ranked: 1, pp: 100 });

    assert.equal(refreshBeatmapStatuses(h.db, resolver), null);
  } finally {
    h.cleanup();
  }
});

test('a score on unranked mods stays unranked when its map becomes ranked', () => {
  const h = harness();
  try {
    const resolver = new BeatmapResolver(h.db, [h.install]);
    resolver.resolve(MD5);
    h.db.prepare(
      `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss, accuracy, max_combo,
         total_score, passed, grade, map_status, mods_ranked, ranked, played_at)
       VALUES (?, 'rx', 0, ?, 'lazer', '[{"acronym":"RX"}]', 'RX', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', ?, 0, 0, 0)`,
    ).run(h.profileId, MD5, UNRESOLVED_STATUS);

    writeOnlineDb(h.onlineDb, [{ md5: MD5, id: 11, set: 22, approved: Status.RANKED }]);
    refreshBeatmapStatuses(h.db, resolver);
    const score = h.db.prepare('SELECT map_status, ranked FROM scores WHERE beatmap_md5 = ?').get(MD5);
    assert.deepEqual({ ...score }, { map_status: Status.RANKED, ranked: 0 });
  } finally {
    h.cleanup();
  }
});

test('with no online.db there is nothing to refresh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-online-'));
  const db = openDb(path.join(tmp, 'test.db'));
  try {
    assert.equal(refreshBeatmapStatuses(db, new BeatmapResolver(db, [])), null);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
