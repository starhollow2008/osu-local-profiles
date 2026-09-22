import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { backfillOriginalMetadata, BeatmapResolver } from '../src/clients/beatmaps.ts';
import { beatmapName, beatmapNameOriginal, names } from '../src/calc/metadata.ts';
import { mostPlayed, recentPlays } from '../src/calc/stats.ts';

/*
 * Beatmap metadata in the song's own script -- osu!'s "prefer metadata in original language".
 *
 * The rule under test everywhere here is that an original-language name is reported only when
 * it is *different*. Most beatmaps repeat their romanised title in `TitleUnicode` or carry no
 * `TitleUnicode` at all, and a page that had to compare the two on every row would be paying
 * for a field that says the same thing twice.
 */

const OSU_FILE = (meta: Record<string, string>) =>
  [
    'osu file format v14',
    '',
    '[General]',
    'Mode: 0',
    '',
    '[Metadata]',
    ...Object.entries(meta).map(([k, v]) => `${k}:${v}`),
    '',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:',
  ].join('\n');

interface Harness {
  db: Db;
  profileId: number;
  resolver: BeatmapResolver;
  /** Write a .osu, index it, and return the MD5 a score would name it by. */
  beatmap: (meta: Record<string, string>) => string;
  addScore: (md5: string) => void;
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-metadata-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Metadata');
  const resolver = new BeatmapResolver(db, []);
  let n = 0;

  return {
    db,
    profileId,
    resolver,
    beatmap(meta) {
      const file = path.join(tmp, `map-${++n}.osu`);
      const text = OSU_FILE(meta);
      fs.writeFileSync(file, text);
      // The MD5 of the file's bytes, which is what a replay names its beatmap by.
      const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
      db.prepare(
        'INSERT OR REPLACE INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, 0, NULL, ?, ?)',
      ).run(file, md5, text.length, Date.now());
      return md5;
    },
    addScore(md5) {
      db.prepare(
        `INSERT INTO scores
           (profile_id, mode, beatmap_md5, dedupe_key, accuracy, max_combo, total_score, grade,
            ranked, passed, played_at, client, mods_json, mods_label,
            count300, count100, count50, count_geki, count_katu, count_miss)
         VALUES (?, 0, ?, ?, 0.99, 100, 500000, 'S', 1, 1, ?, 'lazer', '[]', '', 100, 0, 0, 0, 0, 0)`,
      ).run(profileId, md5, `${md5}:1`, Date.now());
    },
    cleanup() {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a .osu with an original-language title stores both, and reports only the difference', () => {
  const h = harness();
  try {
    const md5 = h.beatmap({
      Artist: 'YOASOBI',
      ArtistUnicode: 'YOASOBI',
      Title: 'Yoru ni Kakeru',
      TitleUnicode: '夜に駆ける',
      Creator: 'mapper',
      Version: 'Insane',
    });

    const resolved = h.resolver.resolve(md5);
    assert.equal(resolved.title, 'Yoru ni Kakeru');
    assert.equal(resolved.titleUnicode, '夜に駆ける');
    // The artist is written the same in both, so there is nothing to offer.
    assert.equal(resolved.artistUnicode, 'YOASOBI');

    const row = h.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(md5) as Record<string, string>;
    const n = names(row);
    assert.equal(beatmapName(n), 'YOASOBI - Yoru ni Kakeru');
    assert.equal(beatmapNameOriginal(n), 'YOASOBI - 夜に駆ける');
    assert.equal(n.artistUnicode, null, 'an identical artist is not a second name');
  } finally {
    h.cleanup();
  }
});

test('a beatmap with no original-language metadata offers none, and is never re-read for it', () => {
  const h = harness();
  try {
    const md5 = h.beatmap({
      Artist: 'Camellia',
      Title: 'Ghost',
      Creator: 'mapper',
      Version: 'Expert',
    });
    h.resolver.resolve(md5);

    const row = h.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(md5) as Record<string, string>;
    // '' rather than NULL: looked at, and there was nothing there. NULL would make the
    // backfill read the file again on every launch for the rest of the profile's life.
    assert.equal(row['title_unicode'], '');
    assert.equal(row['artist_unicode'], '');
    assert.equal(beatmapNameOriginal(names(row)), null);
  } finally {
    h.cleanup();
  }
});

test('a play carries the original-language name to the page only where it differs', () => {
  const h = harness();
  try {
    const md5 = h.beatmap({
      Artist: 'サカナクション',
      ArtistUnicode: 'サカナクション',
      Title: 'Shin Takarajima',
      TitleUnicode: '新宝島',
      Creator: 'mapper',
      Version: 'Hard',
    });
    // Romanised-only maps have to be in the list too: the page must be able to show a mixed
    // feed without one of them going blank.
    const plain = h.beatmap({ Artist: 'Camellia', Title: 'Ghost', Creator: 'm', Version: 'E' });
    h.resolver.resolve(md5);
    h.resolver.resolve(plain);
    h.addScore(md5);
    h.addScore(plain);

    const plays = recentPlays(h.db, h.profileId, 0, 10);
    const jp = plays.find((p) => p.title === 'Shin Takarajima')!;
    assert.equal(jp.titleUnicode, '新宝島');
    assert.equal(jp.artistUnicode, null, 'the artist reads the same in both');

    const romanised = plays.find((p) => p.title === 'Ghost')!;
    assert.equal(romanised.titleUnicode, null);
    assert.equal(romanised.artistUnicode, null);

    // Most Played reads the same columns through a different query, so it is checked too.
    const played = mostPlayed(h.db, h.profileId, 0, 10);
    assert.equal(played.find((m) => m.title === 'Shin Takarajima')!.titleUnicode, '新宝島');
  } finally {
    h.cleanup();
  }
});

test('beatmaps cached before the columns existed are filled in once', async () => {
  const h = harness();
  try {
    const md5 = h.beatmap({
      Artist: 'Yorushika',
      Title: 'Dakara Boku wa Ongaku wo Yameta',
      TitleUnicode: 'だから僕は音楽を辞めた',
      Creator: 'mapper',
      Version: 'Insane',
    });
    h.resolver.resolve(md5);

    // Exactly what an older database holds: the romanised names, and NULL where the new
    // columns would be.
    h.db.prepare('UPDATE beatmaps SET artist_unicode = NULL, title_unicode = NULL').run();

    assert.equal(await backfillOriginalMetadata(h.db), 1);
    const row = h.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(md5) as Record<string, string>;
    assert.equal(row['title_unicode'], 'だから僕は音楽を辞めた');

    // And it is a one-off: with nothing left NULL there is no second pass to make.
    assert.equal(await backfillOriginalMetadata(h.db), 0);
  } finally {
    h.cleanup();
  }
});

test('a beatmap whose file has gone is settled rather than retried for ever', async () => {
  const h = harness();
  try {
    h.db
      .prepare(
        `INSERT INTO beatmaps (md5, artist, title, osu_path, cached_at)
         VALUES ('deadbeef', 'Artist', 'Title', ?, ?)`,
      )
      .run(path.join(os.tmpdir(), 'olp-metadata-gone', 'nothing.osu'), Date.now());

    assert.equal(await backfillOriginalMetadata(h.db), 1);
    const row = h.db.prepare("SELECT * FROM beatmaps WHERE md5 = 'deadbeef'").get() as Record<string, string>;
    assert.equal(row['title_unicode'], '');
    assert.equal(await backfillOriginalMetadata(h.db), 0, 'an unreadable file costs one attempt, not one per launch');
  } finally {
    h.cleanup();
  }
});
