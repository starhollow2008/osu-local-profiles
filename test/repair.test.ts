import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { parseReplay, parseReplayHeader } from '../src/osr.ts';
import { foundBeatmapIds, misdecodedIds, readReplayHeader } from '../src/tracker/recompute.ts';
import { Tracker } from '../src/tracker/index.ts';
import { OfficialCalculator } from '../src/calc/official.ts';

/*
 * Two things older versions stored wrongly, put right from the replays after the beatmap
 * index runs (Tracker.repairScores): stable mods decoded from only the first fifteen bits --
 * ScoreV2 among the rest -- and plays on a beatmap the index had not found yet.
 */

const SV2 = 1 << 29;
const HD = 1 << 3;

/** A minimal osu!stable replay: the header, no frames. */
function stableReplay(mode: number, legacyMods: number): Buffer {
  const str = (s: string) => Buffer.concat([Buffer.from([0x0b, Buffer.byteLength(s)]), Buffer.from(s)]);
  const head = Buffer.alloc(5);
  head.writeUInt8(mode, 0);
  head.writeInt32LE(20250107, 1);
  const stats = Buffer.alloc(6 * 2 + 4 + 2 + 1 + 4);
  stats.writeUInt16LE(300, 0); // 300s
  stats.writeInt32LE(1_000_000, 12); // total score
  stats.writeUInt16LE(500, 16); // max combo
  stats.writeInt32LE(legacyMods, 19);
  const tail = Buffer.alloc(1 + 8 + 4 + 8);
  tail.writeUInt8(0x00, 0); // no life bar
  tail.writeBigInt64LE(638_000_000_000_000_000n, 1);
  tail.writeInt32LE(0, 9); // no frames
  tail.writeBigInt64LE(0n, 13); // never submitted
  return Buffer.concat([head, str('a'.repeat(32)), str('Tangy'), str('b'.repeat(32)), stats, tail]);
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-repair-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Repairs');
  const insert = db.prepare(
    `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
      mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
      max_combo, total_score, passed, grade, ranked, played_at, replay_path)
     VALUES (?,?,?,?,?,'[]','None',300,0,0,0,0,0,1,500,1000000,1,'S',0,0,?)`,
  );
  /** A stored score as an older version wrote it: mods decoded from the low bits only. */
  const score = (key: string, mode: number, legacyMods: number, client = 'stable', md5 = 'x'.repeat(32)) => {
    const file = path.join(tmp, `${key}.osr`);
    fs.writeFileSync(file, stableReplay(mode, legacyMods));
    return Number(insert.run(profileId, key, mode, md5, client, file).lastInsertRowid);
  };
  return {
    tmp,
    db,
    profileId,
    score,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

test('the replay header gives the same mods and ruleset as the whole replay', async () => {
  const buf = stableReplay(3, SV2 | HD | (1 << 18));
  const whole = await parseReplay(buf);
  const header = parseReplayHeader(buf.subarray(0, 200));
  assert.deepEqual(header, { mode: whole.mode, version: whole.version, legacyMods: whole.legacyMods });
  assert.equal(header.legacyMods, SV2 | HD | (1 << 18));
});

test('only the stable plays the old decoder read wrongly are picked for repair', () => {
  const h = harness();
  try {
    const sv2 = h.score('sv2', 0, SV2 | HD);
    const maniaKeys = h.score('mania7k', 3, 1 << 18);
    const maniaRelax = h.score('maniarx', 3, 1 << 7); // Relax has no mania mod: osu! drops it
    h.score('plain', 0, HD); // read right the first time
    h.score('taikoHd', 1, HD); // likewise
    const mcosu = h.score('mcosu', 0, SV2, 'mcosu');
    h.score('lazer', 0, SV2, 'lazer'); // lazer replays carry their own mod list

    assert.deepEqual(ids(misdecodedIds(h.db)), [sv2, maniaKeys, maniaRelax, mcosu]);
    // A replay that has gone is left as it is rather than guessed at.
    fs.rmSync(path.join(h.tmp, 'sv2.osr'));
    assert.deepEqual(ids(misdecodedIds(h.db)), [maniaKeys, maniaRelax, mcosu]);
    assert.equal(readReplayHeader(path.join(h.tmp, 'sv2.osr')), null);
  } finally {
    h.cleanup();
  }
});

test('a play stored with no beatmap file is picked once the index has the file', () => {
  const h = harness();
  try {
    const md5 = 'e444bcc62948b67f5c97c995df58321c';
    const unknown = h.score('unknown', 0, 1, 'stable', md5);
    const resolver = new BeatmapResolver(h.db, []);
    resolver.resolve(md5); // cached as a miss, the way a mid-session download was
    assert.deepEqual(ids(foundBeatmapIds(h.db)), [], 'nothing to repair while the file is still missing');

    h.db
      .prepare('INSERT INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, 0, ?, 1, 0)')
      .run(path.join(h.tmp, 'map.osu'), md5, '');
    assert.deepEqual(ids(foundBeatmapIds(h.db)), [unknown]);
  } finally {
    h.cleanup();
  }
});

/*
 * End to end: what the stored row says after a launch has run the repair. Needs osu!'s
 * calculator, which is what decides whether the mods are ranked.
 */
test('a stored stable ScoreV2 play is relabelled, and the repair runs only once', { timeout: 120_000 }, async (t) => {
  const official = await OfficialCalculator.create();
  if (!official) return t.skip('osu-pp helper not built (run: npm run build:pp:local)');
  const h = harness();
  try {
    const id = h.score('sv2', 0, SV2 | HD);
    const tracker = new Tracker({
      db: h.db,
      resolver: new BeatmapResolver(h.db, []),
      installs: [],
      profileId: h.profileId,
      trackingSince: 0,
      official,
    });

    const first = await tracker.repairScores();
    assert.equal(first?.considered, 1);
    const row = h.db.prepare('SELECT mods_json, mods_label, mods_ranked FROM scores WHERE id = ?').get(id) as {
      mods_json: string;
      mods_label: string;
      mods_ranked: number;
    };
    assert.deepEqual(JSON.parse(row.mods_json), [{ acronym: 'HD' }, { acronym: 'SV2' }]);
    assert.equal(row.mods_label, 'HDSV2');
    assert.equal(row.mods_ranked, 0, 'osu! does not rank ScoreV2');

    assert.equal((await tracker.repairScores())?.considered, 0, 'recorded as done');
  } finally {
    official.dispose();
    h.cleanup();
  }
});
