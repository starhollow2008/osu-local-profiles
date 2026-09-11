import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { beatmapLengthMs, playRate, playTimeSeconds } from '../src/calc/play-time.ts';

/** A .osu file whose objects run from `first` to `last` ms, the last being a spinner. */
function osuFile(first: number, last: number): string {
  return [
    'osu file format v14',
    '',
    '[General]',
    'Mode: 0',
    '',
    '[HitObjects]',
    `256,192,${first},1,0,0:0:0:0:`,
    `100,100,${first + 500},2,0,B|200:200,1,100`,
    `256,192,${last - 1000},12,0,${last},0:0:0:0:`,
    '',
  ].join('\n');
}

test('a beatmap runs from its first object to the end of its last', () => {
  assert.equal(beatmapLengthMs(osuFile(1000, 91_000)), 90_000);
});

test('a mania hold note ends at the time before its colon', () => {
  const text = '[HitObjects]\n64,192,0,1,0,0:0:0:0:\n64,192,5000,128,0,65000:0:0:0:0:\n';
  assert.equal(beatmapLengthMs(text), 65_000);
});

test('a file with no objects has no length, rather than a made-up one', () => {
  assert.equal(beatmapLengthMs('osu file format v14\n[General]\nMode: 0\n'), 0);
});

test("only osu!'s rate-adjust mods change the rate, at their defaults or as customised", () => {
  assert.equal(playRate([]), 1);
  assert.equal(playRate([{ acronym: 'DT' }]), 1.5);
  assert.equal(playRate([{ acronym: 'HT' }]), 0.75);
  assert.equal(playRate([{ acronym: 'DT', settings: { speed_change: 1.2 } }]), 1.2);
  // Wind Up is a time ramp, not a rate adjust; osu! leaves it out of play time too.
  assert.equal(playRate([{ acronym: 'HD' }, { acronym: 'WU' }]), 1);
});

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-playtime-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const osuPath = path.join(tmp, 'map.osu');
  fs.writeFileSync(osuPath, osuFile(0, 120_000)); // a two-minute map
  db.prepare(
    `INSERT INTO beatmaps (md5, title, osu_path, cached_at) VALUES ('m', 'Map', ?, 0)`,
  ).run(osuPath);

  let n = 0;
  const score = (mods: string) =>
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, played_at)
       VALUES (?, ?, 0, 'm', 'lazer', ?, '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1)`,
    ).run(profileId, `s${++n}`, mods);
  const incomplete = (startedAt: number | null, playedAt: number) =>
    db.prepare(
      `INSERT INTO incomplete_plays (profile_id, dedupe_key, mode, beatmap_md5, played_at, started_at)
       VALUES (?, ?, 0, 'm', ?, ?)`,
    ).run(profileId, `i${++n}`, playedAt, startedAt);

  return {
    db,
    profileId,
    score,
    incomplete,
    total: () => playTimeSeconds(db, profileId, 0),
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a finished score counts the length of its map at the speed it was played', () => {
  const h = harness();
  try {
    h.score('[]');
    assert.equal(h.total(), 120);
    h.score('[{"acronym":"DT"}]'); // 120s at 1.5x
    assert.equal(h.total(), 120 + 80);
  } finally {
    h.cleanup();
  }
});

test('an abandoned play counts the time spent in it, never more than the map', () => {
  const h = harness();
  try {
    h.incomplete(0, 30_000); // quit after 30 seconds
    assert.equal(h.total(), 30);
    h.incomplete(0, 600_000); // ten minutes, most of it paused: capped at the map's two
    assert.equal(h.total(), 30 + 120);
    h.incomplete(null, 50_000); // no start time recorded: unknown, and not guessed at
    assert.equal(h.total(), 150);
  } finally {
    h.cleanup();
  }
});

test("a beatmap's length is read once and remembered", () => {
  const h = harness();
  try {
    h.score('[]');
    h.total();
    const row = h.db.prepare(`SELECT length_ms FROM beatmaps WHERE md5 = 'm'`).get() as {
      length_ms: number;
    };
    assert.equal(row.length_ms, 120_000);
  } finally {
    h.cleanup();
  }
});
