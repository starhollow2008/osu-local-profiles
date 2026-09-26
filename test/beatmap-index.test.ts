import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver, indexBeatmapFiles, indexOneFile, type IndexProgress } from '../src/clients/beatmaps.ts';
import { Tracker, type IndexState } from '../src/tracker/index.ts';

/*
 * The beatmap index runs beside the app instead of before it (so the page is up at once on a
 * first launch), and anything that needs it waits for it. See `indexBeatmapFiles` and
 * `Tracker.indexBeatmaps`.
 */

const OSU = (title: string, beatmapId?: number) =>
  `osu file format v14\r\n\r\n[Metadata]\r\nTitle:${title}\r\n${
    beatmapId === undefined ? '' : `BeatmapID:${beatmapId}\r\n`
  }`;

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-index-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const file = (rel: string, content: string | Buffer) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    tmp,
    db,
    file,
    count,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("lazer's store is sniffed by content, since its files have no names", async () => {
  const h = harness();
  try {
    // Named by hash, as lazer names them: only the contents say which is a beatmap.
    h.file('files/a/ab/ab12', OSU('One'));
    h.file('files/c/cd/cd34', Buffer.from('ID3 not a beatmap'));
    const seen: IndexProgress[] = [];
    const result = await indexBeatmapFiles(h.db, [{ path: path.join(h.tmp, 'files'), byExtension: false }], (p) =>
      seen.push(p),
    );
    assert.deepEqual(result, { scanned: 2, indexed: 1, removed: 0 });
    assert.equal(h.count('osu_files'), 1);
    assert.equal(h.count('not_beatmaps'), 1, 'the audio is remembered, so it is never opened again');

    const last = seen[seen.length - 1]!;
    assert.deepEqual([last.phase, last.scanned, last.total, last.firstRun], ['indexing', 2, 2, true]);

    // Everything is known now: a second run does no work and is not a first run.
    const again: IndexProgress[] = [];
    assert.deepEqual(
      await indexBeatmapFiles(h.db, [{ path: path.join(h.tmp, 'files'), byExtension: false }], (p) => again.push(p)),
      { scanned: 2, indexed: 0, removed: 0 },
    );
    assert.equal(again[again.length - 1]!.firstRun, false);
  } finally {
    h.cleanup();
  }
});

test('local beatmap metadata resolves an online beatmap id without online.db', async () => {
  const h = harness();
  try {
    h.file('files/a/map', OSU('Offline', 5438074));
    await indexBeatmapFiles(h.db, [
      { path: path.join(h.tmp, 'files'), byExtension: false },
    ]);

    const row = h.db
      .prepare('SELECT md5, beatmap_id FROM osu_files WHERE path = ?')
      .get(path.join(h.tmp, 'files/a/map')) as { md5: string; beatmap_id: number };
    assert.equal(row.beatmap_id, 5438074);
    assert.equal(new BeatmapResolver(h.db, []).md5ForBeatmapId(5438074), row.md5);
  } finally {
    h.cleanup();
  }
});

test('local fallback rejects zero IDs and ambiguous edited copies', async () => {
  const h = harness();
  try {
    h.file('files/a/map', OSU('One', 5438074));
    h.file('files/b/map', OSU('Two', 5438074));
    await indexBeatmapFiles(h.db, [
      { path: path.join(h.tmp, 'files'), byExtension: false },
    ]);

    const resolver = new BeatmapResolver(h.db, []);
    assert.equal(resolver.md5ForBeatmapId(0), null);
    assert.equal(resolver.md5ForBeatmapId(5438074), null);

    const row = h.db.prepare('SELECT md5 FROM osu_files ORDER BY path LIMIT 1').get() as { md5: string };
    h.db.prepare(
      `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator,
         status, cached_at) VALUES (?, 5438074, 900, 'Artist', 'Title', 'Insane', 'C', 1, 0)`,
    ).run(row.md5);
    assert.equal(resolver.md5ForBeatmapId(5438074), row.md5);
  } finally {
    h.cleanup();
  }
});

test('an existing index backfills local beatmap ids once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-index-migration-'));
  const dbFile = path.join(tmp, 'test.db');
  const file = path.join(tmp, 'files/map');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, OSU('Migrated', 5438074));

  const old = new DatabaseSync(dbFile);
  old.exec(
    'CREATE TABLE osu_files (path TEXT PRIMARY KEY, md5 TEXT NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL)',
  );
  old.prepare(
    'INSERT INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
  ).run(file, 'old', 0, 0);
  old.close();

  const db = openDb(dbFile);
  try {
    const progress: IndexProgress[] = [];
    await indexBeatmapFiles(db, [
      { path: path.join(tmp, 'files'), byExtension: false },
    ], (p) => progress.push({ ...p }));
    assert.notEqual(new BeatmapResolver(db, []).md5ForBeatmapId(5438074), null);
    // The backfill re-reads every row, but this index was built by an earlier version and
    // must not be announced to the user as a first run.
    assert.equal(progress[progress.length - 1]!.firstRun, false);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("osu!stable's Songs opens only .osu files -- the audio and images are never read", async () => {
  const h = harness();
  try {
    h.file('Songs/1 Artist - Title/Artist - Title (m) [Hard].osu', OSU('Two'));
    h.file('Songs/1 Artist - Title/Artist - Title (m) [EASY].OSU', OSU('Three'));
    h.file('Songs/1 Artist - Title/audio.mp3', Buffer.alloc(64));
    h.file('Songs/1 Artist - Title/bg.jpg', Buffer.alloc(64));
    // Named like a beatmap but not one: still sniffed, and still refused.
    h.file('Songs/1 Artist - Title/broken.osu', 'nothing here');

    const result = await indexBeatmapFiles(h.db, [{ path: path.join(h.tmp, 'Songs'), byExtension: true }]);
    assert.deepEqual(result, { scanned: 3, indexed: 2, removed: 0 }, 'only the three .osu names were looked at');
    assert.equal(h.count('osu_files'), 2);
    assert.equal(h.count('not_beatmaps'), 1, 'the mp3 and jpg were skipped by name, not opened and recorded');
  } finally {
    h.cleanup();
  }
});

test('the index lets the app run while it works, and never holds a transaction across a pause', async () => {
  const h = harness();
  try {
    for (let i = 0; i < 1500; i++) h.file(`files/${i % 16}/${i}`, i % 3 === 0 ? OSU(`m${i}`) : Buffer.alloc(32, i));

    // Something else writing on the same connection whenever it gets the chance, as the
    // tracker and the page do. A transaction left open across a pause would make its BEGIN
    // throw ("cannot start a transaction within a transaction").
    let running = true;
    let interleaved = 0;
    let failure: unknown = null;
    const other = () => {
      if (!running) return;
      try {
        h.db.exec('BEGIN');
        h.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('probe', ?)").run(String(interleaved));
        h.db.exec('COMMIT');
        interleaved++;
      } catch (e) {
        failure = e;
      }
      setImmediate(other);
    };
    setImmediate(other);

    const result = await indexBeatmapFiles(h.db, [{ path: path.join(h.tmp, 'files'), byExtension: false }]);
    running = false;
    assert.equal(failure, null);
    assert.equal(result.indexed, 500);
    assert.equal(h.count('osu_files') + h.count('not_beatmaps'), 1500, 'every file written, none lost to a rollback');
  } finally {
    h.cleanup();
  }
});

test('nothing queued behind the index runs before it has finished', async () => {
  const h = harness();
  try {
    h.file('files/a/1', OSU('Held'));
    const profileId = getOrCreateProfile(h.db, 'P');
    const tracker = new Tracker({
      db: h.db,
      resolver: new BeatmapResolver(h.db, []),
      installs: [],
      profileId,
      trackingSince: 0,
      official: null,
    });
    const states: IndexState[] = [];
    tracker.on('indexing', (s) => states.push(s));

    const order: string[] = [];
    const indexing = tracker.indexBeatmaps([{ path: path.join(h.tmp, 'files'), byExtension: false }]).then(() =>
      order.push('index'),
    );
    // Anything that resolves beatmaps goes through the same queue; an import preview is one.
    const queued = tracker.previewBackfill(0).then(() => order.push('queued'));
    assert.equal(tracker.indexState.active, true);

    await Promise.all([indexing, queued]);
    assert.deepEqual(order, ['index', 'queued']);
    assert.equal(tracker.indexState.active, false);
    assert.equal(h.count('osu_files'), 1);
    // The page is told when it ends, so the notice can go.
    assert.equal(states[states.length - 1]!.active, false);
  } finally {
    h.cleanup();
  }
});

/*
 * A beatmap looked up before its file was indexed used to stay unknown for good: the miss was
 * cached like an answer, so a play on a map osu!stable had just extracted -- every multiplayer
 * pick you did not have -- kept "Unknown beatmap" and no pp through every restart.
 */
test('a beatmap missing when first looked up is found once its file is indexed', () => {
  const h = harness();
  try {
    const content = `${OSU('Fresh Download', 77)}Artist:Someone\r\nCreator:mapper\r\nVersion:Insane\r\n`;
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    const resolver = new BeatmapResolver(h.db, []);

    assert.equal(resolver.resolve(md5).osuPath, null, 'nothing indexed yet');

    const file = h.file('Songs/1 Someone - Fresh Download/map.osu', content);
    indexOneFile(h.db, file);
    const found = resolver.resolve(md5);
    assert.equal(found.osuPath, file);
    assert.equal(found.title, 'Fresh Download');
    assert.equal(found.beatmapId, 77);
    // And the cache now holds the answer, not the miss.
    assert.equal(new BeatmapResolver(h.db, []).resolve(md5).osuPath, file);
  } finally {
    h.cleanup();
  }
});

test('a miss gives the resolver one chance to index what has just arrived', () => {
  const h = harness();
  try {
    const content = OSU('Just Extracted');
    const md5 = crypto.createHash('md5').update(content).digest('hex');
    const file = h.file('Songs/2 Set/map.osu', content);
    const resolver = new BeatmapResolver(h.db, []);
    let asked = 0;
    resolver.onMiss = () => {
      asked++;
      indexOneFile(h.db, file);
    };

    assert.equal(resolver.resolve(md5).osuPath, file);
    assert.equal(asked, 1);
    // Found now, so a second lookup does not ask again.
    resolver.resolve(md5);
    assert.equal(asked, 1);
  } finally {
    h.cleanup();
  }
});

/*
 * The index only ever grew: lazer removes store files nothing uses, stable players delete sets,
 * and their rows stayed -- a beatmap indexed at two paths could be looked up at the dead one.
 */
test('files deleted since the last walk leave the index, and a cached beatmap looks again', async () => {
  const h = harness();
  try {
    const songs = path.join(h.tmp, 'Songs');
    const kept = h.file('Songs/1 Kept/kept.osu', OSU('Kept'));
    const doomed = h.file('Songs/2 Doomed/doomed.osu', OSU('Doomed'));
    const roots = [{ path: songs, byExtension: true }];
    await indexBeatmapFiles(h.db, roots);
    assert.equal(h.count('osu_files'), 2);

    // A played beatmap cached with the file about to go.
    const md5 = (h.db.prepare('SELECT md5 FROM osu_files WHERE path = ?').get(doomed) as { md5: string }).md5;
    new BeatmapResolver(h.db, []).resolve(md5);

    fs.rmSync(path.dirname(doomed), { recursive: true });
    const result = await indexBeatmapFiles(h.db, roots);
    assert.equal(result.removed, 1);
    assert.deepEqual(
      (h.db.prepare('SELECT path FROM osu_files').all() as { path: string }[]).map((r) => r.path),
      [kept],
    );
    assert.equal(
      (h.db.prepare('SELECT osu_path FROM beatmaps WHERE md5 = ?').get(md5) as { osu_path: string | null }).osu_path,
      null,
      'the cache no longer points at the deleted file',
    );
  } finally {
    h.cleanup();
  }
});

/*
 * An unplugged drive, or a Songs folder that cannot be read, yields nothing -- which is not
 * evidence that anything was deleted, and must not cost the whole index.
 */
test('a root that yields nothing keeps everything indexed under it', async () => {
  const h = harness();
  try {
    const songs = path.join(h.tmp, 'Songs');
    h.file('Songs/1 Set/a.osu', OSU('A'));
    await indexBeatmapFiles(h.db, [{ path: songs, byExtension: true }]);
    fs.renameSync(songs, path.join(h.tmp, 'Unplugged'));

    const result = await indexBeatmapFiles(h.db, [{ path: songs, byExtension: true }]);
    assert.equal(result.removed, 0);
    assert.equal(h.count('osu_files'), 1);
  } finally {
    h.cleanup();
  }
});

/*
 * not_beatmaps holds every non-beatmap file in lazer's store -- a million rows for a large
 * library -- and an ordinary table kept each path twice. An older database is rebuilt once.
 */
test('an older not_beatmaps is rebuilt WITHOUT ROWID, keeping every row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-rebuild-'));
  const file = path.join(tmp, 'test.db');
  try {
    let db = openDb(file);
    db.exec(`DROP TABLE not_beatmaps;
             CREATE TABLE not_beatmaps (path TEXT PRIMARY KEY, size INTEGER NOT NULL);
             INSERT INTO not_beatmaps VALUES ('C:/osu/files/b/bb/bbbb', 2), ('C:/osu/files/a/aa/aaaa', 1);`);
    db.close();

    db = openDb(file);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'not_beatmaps'").get() as { sql: string }).sql;
    assert.match(sql, /WITHOUT ROWID/);
    assert.deepEqual(
      (db.prepare('SELECT path, size FROM not_beatmaps ORDER BY path').all() as { path: string; size: number }[]).map((r) => ({ ...r })),
      [{ path: 'C:/osu/files/a/aa/aaaa', size: 1 }, { path: 'C:/osu/files/b/bb/bbbb', size: 2 }],
    );
    db.close();

    // And a database already rebuilt is left alone.
    db = openDb(file);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM not_beatmaps').get() as { n: number }).n, 2);
    db.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
