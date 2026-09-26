import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/index.ts';
import { SongsWatcher } from '../src/tracker/songs-watcher.ts';

/*
 * osu!stable extracts a downloaded beatmap into a new folder under Songs, which only the
 * launch index used to read. A play on it -- a multiplayer pick you did not have -- was stored
 * as an unknown beatmap with no pp. See src/tracker/songs-watcher.ts.
 */

/** Long enough for a watch to be armed on every platform CI runs. */
const SETTLED_MS = 1200;
/** The watcher's own settle delay, plus a margin. */
const READ_MS = 2500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OSU = (title: string) => `osu file format v14\r\n\r\n[Metadata]\r\nTitle:${title}\r\n`;

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-songs-'));
  const songs = path.join(tmp, 'Songs');
  fs.mkdirSync(songs);
  const db = openDb(path.join(tmp, 'test.db'));
  const watcher = new SongsWatcher({ db, roots: [songs] });
  const indexed = () =>
    (db.prepare('SELECT path FROM osu_files ORDER BY path').all() as { path: string }[]).map((r) =>
      path.relative(songs, r.path),
    );
  return {
    songs,
    db,
    watcher,
    indexed,
    cleanup: () => {
      watcher.stop();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a beatmap set extracted into Songs while the app runs is indexed', { timeout: 20_000 }, async () => {
  const h = harness();
  try {
    h.watcher.start();
    await sleep(SETTLED_MS);

    const set = path.join(h.songs, '123 Artist - Title');
    fs.mkdirSync(set);
    fs.writeFileSync(path.join(set, 'Artist - Title (mapper) [Insane].osu'), OSU('Title'));
    fs.writeFileSync(path.join(set, 'audio.mp3'), 'ID3 not a beatmap');

    await sleep(READ_MS);
    assert.deepEqual(h.indexed(), [path.join('123 Artist - Title', 'Artist - Title (mapper) [Insane].osu')]);
  } finally {
    h.cleanup();
  }
});

/*
 * The play can land before the settle delay has passed, or while osu! is still writing the
 * set, so a lookup that finds nothing flushes: every folder touched this session is read now.
 */
test('flush indexes what has arrived without waiting for the settle delay', { timeout: 20_000 }, async () => {
  const h = harness();
  try {
    h.watcher.start();
    await sleep(SETTLED_MS);

    const set = path.join(h.songs, '456 Set');
    fs.mkdirSync(set);
    fs.writeFileSync(path.join(set, 'a.osu'), OSU('A'));
    await sleep(300); // the event is in, the settle delay is not over
    h.watcher.flush();
    assert.deepEqual(h.indexed(), [path.join('456 Set', 'a.osu')]);

    // A difficulty written after the folder was first read is found by the next flush.
    fs.writeFileSync(path.join(set, 'b.osu'), OSU('B'));
    h.watcher.flush();
    assert.deepEqual(h.indexed(), [path.join('456 Set', 'a.osu'), path.join('456 Set', 'b.osu')]);
  } finally {
    h.cleanup();
  }
});

test('a Songs folder that does not exist is not an error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-songs-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const errors: Error[] = [];
  const watcher = new SongsWatcher({ db, roots: [path.join(tmp, 'nowhere')], onError: (e) => errors.push(e) });
  try {
    watcher.start();
    watcher.flush();
    assert.deepEqual(errors, []);
  } finally {
    watcher.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
