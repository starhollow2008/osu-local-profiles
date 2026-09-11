import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver, indexBeatmapFiles, type IndexProgress } from '../src/clients/beatmaps.ts';
import { Tracker, type IndexState } from '../src/tracker/index.ts';

/*
 * The beatmap index runs beside the app instead of before it (so the page is up at once on a
 * first launch), and anything that needs it waits for it. See `indexBeatmapFiles` and
 * `Tracker.indexBeatmaps`.
 */

const OSU = (title: string) => `osu file format v14\r\n\r\n[Metadata]\r\nTitle:${title}\r\n`;

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
    assert.deepEqual(result, { scanned: 2, indexed: 1 });
    assert.equal(h.count('osu_files'), 1);
    assert.equal(h.count('not_beatmaps'), 1, 'the audio is remembered, so it is never opened again');

    const last = seen[seen.length - 1]!;
    assert.deepEqual([last.phase, last.scanned, last.total, last.firstRun], ['indexing', 2, 2, true]);

    // Everything is known now: a second run does no work and is not a first run.
    const again: IndexProgress[] = [];
    assert.deepEqual(
      await indexBeatmapFiles(h.db, [{ path: path.join(h.tmp, 'files'), byExtension: false }], (p) => again.push(p)),
      { scanned: 2, indexed: 0 },
    );
    assert.equal(again[again.length - 1]!.firstRun, false);
  } finally {
    h.cleanup();
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
    assert.deepEqual(result, { scanned: 3, indexed: 2 }, 'only the three .osu names were looked at');
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
