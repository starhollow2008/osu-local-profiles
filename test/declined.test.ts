import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver, indexBeatmapFiles } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { ingestReplayFile } from '../src/tracker/ingest.ts';
import { deleteDeclines, listDeclines, MAX_DECLINES, recordDecline } from '../src/tracker/declined.ts';
import { updateSettings } from '../src/settings.ts';
import { defaultTrackingFilter, type TrackingFilter } from '../src/tracking-filter.ts';

/*
 * Plays not tracked (src/tracker/declined.ts).
 *
 * A play the app turned away used to leave a toast and a count that reset at the next launch,
 * so "why is my play missing?" had no answer a day later. Each is now recorded -- live, by an
 * import and by the catch-up at launch -- and can be tracked anyway, one play at a time.
 *
 * What must hold: nothing recorded here counts toward anything; a preview records nothing; a
 * play tracked by any route leaves the list; and Track anyway skips only the three checks that
 * turn a play away -- the filter, the owner check and the cutoff -- never the duplicate check.
 */

const MAP = 'Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]';
const SESSION = '1788778412';
const SINCE = Date.UTC(2026, 8, 7);

const OSU_FILE = [
  'osu file format v14',
  '',
  '[General]',
  'Mode: 0',
  '',
  '[Metadata]',
  'Title:Shoujo wa Yoru to Azayaka ni',
  'Artist:Reji',
  'Creator:ADoorNob',
  'Version:Vivid Collab',
  'BeatmapID:4000001',
  'BeatmapSetID:2000001',
  '',
  '[HitObjects]',
  '256,192,1000,1,0,0:0:0:0:',
  '256,192,31000,1,0,0:0:0:0:',
  '',
].join('\r\n');
const MD5 = crypto.createHash('md5').update(OSU_FILE).digest('hex');

// One attempt osu! could not submit, on the map above.
const RUNTIME = `2026-09-07 10:54:08 [verbose]: Game-wide working beatmap updated to ${MAP}
2026-09-07 10:54:10 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#109
2026-09-07 10:54:47 [verbose]: No token, skipping score submission
2026-09-07 10:54:47 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#109
`;

/** .NET ticks at the unix epoch, which is how osu!stable dates a replay. */
const TICKS_AT_EPOCH = 621355968000000000n;

/** An osu!stable replay with no frames: enough for everything but pp, which needs no helper here. */
function stableReplay(o: { player: string; playedAt: number; onlineId?: bigint; total?: number; hash?: string }): Buffer {
  const parts: Buffer[] = [];
  const byte = (v: number) => parts.push(Buffer.from([v]));
  const short = (v: number) => parts.push(Buffer.from(new Int16Array([v]).buffer));
  const int = (v: number) => parts.push(Buffer.from(new Int32Array([v]).buffer));
  const long = (v: bigint) => parts.push(Buffer.from(new BigInt64Array([v]).buffer));
  const string = (s: string) => {
    const d = Buffer.from(s, 'utf8');
    parts.push(Buffer.from([0x0b, d.length]), d);
  };
  byte(0);
  int(20230504);
  string(MD5);
  string(o.player);
  string(o.hash ?? crypto.randomBytes(16).toString('hex'));
  for (const c of [2, 0, 0, 0, 0, 0]) short(c);
  int(o.total ?? 1_000_000);
  short(2);
  byte(1);
  int(0);
  byte(0); // no life bar
  long(BigInt(o.playedAt) * 10_000n + TICKS_AT_EPOCH);
  int(0); // no frames
  long(o.onlineId ?? 0n);
  return Buffer.concat(parts);
}

/** A filter that turns away every osu!standard play and judges on nothing it might not know. */
const TAIKO_ONLY: Partial<TrackingFilter> = { enabled: true, modes: [1] };

interface Harness {
  db: Db;
  profileId: number;
  tracker: Tracker;
  replays: string;
  write: (name: string, buf: Buffer) => string;
  count: (table: string) => number;
  cleanup: () => void;
}

async function harness(): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-declined-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Declined Test');

  const files = path.join(tmp, 'files');
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, 'reji'), OSU_FILE);
  await indexBeatmapFiles(db, [{ path: files, byExtension: false }]);

  // A lazer install rooted here, signed in as Tangy, so its logs and its owner are this test's.
  fs.writeFileSync(path.join(tmp, 'game.ini'), 'Username = Tangy\n');
  const logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, `${SESSION}.runtime.log`), RUNTIME);
  const replays = path.join(tmp, 'replays');
  fs.mkdirSync(replays);

  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [{ kind: 'lazer', root: tmp, replayDir: replays, beatmapRoots: [files], onlineDb: null }],
    profileId,
    // In the future: nothing may arrive by the live path, so anything stored came from here.
    trackingSince: Date.now() + 3_600_000,
    official: null,
  });

  return {
    db,
    profileId,
    tracker,
    replays,
    write: (name, buf) => {
      const file = path.join(replays, name);
      fs.writeFileSync(file, buf);
      return file;
    },
    count: (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a play the filter declines live is listed, and counts toward nothing', async () => {
  const h = await harness();
  try {
    updateSettings(h.db, h.profileId, { trackingFilter: TAIKO_ONLY });
    const file = h.write('mine.osr', stableReplay({ player: 'Tangy', playedAt: SINCE }));
    const ctx = {
      db: h.db,
      resolver: h.tracker.beatmaps,
      profileId: h.profileId,
      trackingSince: 0,
      official: null,
      filter: { ...defaultTrackingFilter(), ...TAIKO_ONLY },
      declines: 'live' as const,
    };

    assert.equal((await ingestReplayFile(file, ctx)).status, 'filtered');
    assert.equal(h.count('scores'), 0, 'declined, so still not a score');

    const [listed, ...rest] = listDeclines(h.db, h.profileId);
    assert.equal(rest.length, 0);
    assert.equal(listed!.reason, 'filtered');
    assert.equal(listed!.criterion, 'mode');
    assert.equal(listed!.source, 'live');
    assert.equal(listed!.kind, 'score');
    assert.equal(listed!.title, 'Reji - Shoujo wa Yoru to Azayaka ni [Vivid Collab]');

    // The same play turned away again is the same row, not a second one.
    await ingestReplayFile(file, { ...ctx, declines: 'import' as const });
    const again = listDeclines(h.db, h.profileId);
    assert.equal(again.length, 1);
    assert.equal(again[0]!.source, 'import', 'brought up to date');

    // Without `declines` -- a re-ingest, a preview -- nothing is recorded.
    const other = h.write('other.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 1000 }));
    await ingestReplayFile(other, { ...ctx, declines: undefined });
    assert.equal(listDeclines(h.db, h.profileId).length, 1);
  } finally {
    h.cleanup();
  }
});

test('Track anyway brings a declined replay in past the filter and the owner check', async () => {
  const h = await harness();
  try {
    updateSettings(h.db, h.profileId, { trackingFilter: TAIKO_ONLY });
    // One of your own the filter declined, and one a downloaded replay of somebody else's.
    h.write('mine.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 60_000, total: 900_000 }));
    h.write('mrekk.osr', stableReplay({ player: 'mrekk', playedAt: SINCE + 120_000, onlineId: 900_000_001n }));

    const imported = await h.tracker.backfill(SINCE);
    assert.equal(imported.imported, 0);
    assert.equal(imported.filtered, 1);
    assert.equal(imported.otherPlayers, 1);

    const listed = listDeclines(h.db, h.profileId);
    assert.deepEqual(listed.map((d) => d.reason).sort(), ['another-player', 'filtered']);
    assert.ok(listed.every((d) => d.source === 'import'));
    const theirs = listed.find((d) => d.reason === 'another-player')!;
    assert.equal(theirs.player, 'mrekk');
    // Named whatever the reason, so the list says whose replay each one is.
    assert.equal(listed.find((d) => d.reason === 'filtered')!.player, 'Tangy');

    // The filter still stands, and Track anyway goes past it for this one play.
    const mine = listed.find((d) => d.reason === 'filtered')!;
    const tracked = await h.tracker.trackAnyway(mine.id);
    assert.deepEqual(tracked, { status: 'tracked', kind: 'score' });
    assert.equal(h.count('scores'), 1);

    // And past the owner check, when asked by name.
    assert.equal((await h.tracker.trackAnyway(theirs.id)).status, 'tracked');
    const names = h.db.prepare('SELECT player_name FROM scores ORDER BY played_at').all() as { player_name: string }[];
    assert.deepEqual(names.map((r) => r.player_name), ['Tangy', 'mrekk']);

    // Tracked, so neither is a play that was turned away any more -- not even when the next
    // import turns the other player's replay away again, before asking whether it is here.
    assert.equal(listDeclines(h.db, h.profileId).length, 0);
    await h.tracker.backfill(SINCE);
    assert.equal(listDeclines(h.db, h.profileId).length, 0);
    await assert.rejects(h.tracker.trackAnyway(mine.id), /not in the list/);
  } finally {
    h.cleanup();
  }
});

test('Track anyway never adds a play twice, and says when its replay is gone', async () => {
  const h = await harness();
  try {
    updateSettings(h.db, h.profileId, { trackingFilter: TAIKO_ONLY });
    const hash = 'b'.repeat(32);
    const file = h.write('mine.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 60_000, hash }));
    const gone = h.write('gone.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 120_000, total: 800_000 }));
    await h.tracker.backfill(SINCE);
    assert.equal(listDeclines(h.db, h.profileId).length, 2);

    // The replay is deleted after it was declined: nothing to track it from, and it stays listed.
    fs.rmSync(gone);
    const missing = listDeclines(h.db, h.profileId).find((d) => d.playedAt === SINCE + 120_000)!;
    assert.deepEqual(await h.tracker.trackAnyway(missing.id), { status: 'missing' });
    assert.equal(listDeclines(h.db, h.profileId).length, 2);

    // The other is imported with the filter off, which takes it off the list by itself...
    await h.tracker.backfill(SINCE, undefined, false);
    assert.equal(h.count('scores'), 1);
    const left = listDeclines(h.db, h.profileId);
    assert.deepEqual(left.map((d) => d.id), [missing.id], 'a play tracked by any route leaves the list');

    // ...and a stale row for it can never add it a second time.
    recordDecline(h.db, h.profileId, {
      kind: 'score',
      dedupeKey: 'stale',
      reason: 'filtered',
      criterion: 'mode',
      player: null,
      source: 'live',
      title: null,
      titleOriginal: null,
      mode: 0,
      playedAt: SINCE,
      replayPath: file,
      recording: null,
    });
    const stale = listDeclines(h.db, h.profileId).find((d) => d.id !== missing.id)!;
    assert.deepEqual(await h.tracker.trackAnyway(stale.id), { status: 'already' });
    assert.equal(h.count('scores'), 1);
  } finally {
    h.cleanup();
  }
});

test('an unfinished play the filter declines can be tracked anyway from what was recorded', async () => {
  const h = await harness();
  try {
    updateSettings(h.db, h.profileId, { trackingFilter: TAIKO_ONLY });

    // The preview turns nothing away, so it records nothing.
    const preview = await h.tracker.previewBackfill(SINCE);
    assert.equal(preview.log.filtered, 1);
    assert.equal(listDeclines(h.db, h.profileId).length, 0, 'a preview records nothing');

    const result = await h.tracker.backfill(SINCE, { replays: false, unfinished: true, attempts: true });
    assert.equal(result.filtered, 1);
    assert.equal(h.count('incomplete_plays'), 0);

    const [listed] = listDeclines(h.db, h.profileId);
    assert.equal(listed!.kind, 'incomplete');
    assert.equal(listed!.reason, 'filtered');
    assert.equal(listed!.mode, 0);

    const played: unknown[] = [];
    h.tracker.on('incomplete', (play) => played.push(play));
    assert.deepEqual(await h.tracker.trackAnyway(listed!.id), { status: 'tracked', kind: 'incomplete' });
    assert.equal(played.length, 1, 'announced like a play that just arrived');
    const row = h.db.prepare('SELECT unsubmitted, beatmap_md5 FROM incomplete_plays').get() as {
      unsubmitted: number;
      beatmap_md5: string;
    };
    assert.deepEqual({ ...row }, { unsubmitted: 1, beatmap_md5: MD5 });
    assert.equal(listDeclines(h.db, h.profileId).length, 0);

    // The log still names it, and a later import finds it already here rather than declining it.
    await h.tracker.backfill(SINCE, { replays: false, unfinished: true, attempts: true });
    assert.equal(listDeclines(h.db, h.profileId).length, 0);
    assert.equal(h.count('incomplete_plays'), 1);
  } finally {
    h.cleanup();
  }
});

/*
 * The red minus: deleted for good, as a removed score is. Its key goes into deleted_scores, so
 * no import tracks it or lists it again -- another player's replay included, which the import's
 * scan turns away before any ingest asks whether it was deleted.
 */
test('a play not tracked, deleted for good, is never listed or tracked again', async () => {
  const h = await harness();
  try {
    updateSettings(h.db, h.profileId, { trackingFilter: TAIKO_ONLY });
    h.write('mine.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 60_000 }));
    h.write('mrekk.osr', stableReplay({ player: 'mrekk', playedAt: SINCE + 120_000, onlineId: 900_000_001n }));
    const everything = { replays: true, unfinished: true, attempts: true };
    await h.tracker.backfill(SINCE, everything);
    assert.equal(listDeclines(h.db, h.profileId).length, 3, 'a replay, an unfinished play and a watched replay');

    const mine = listDeclines(h.db, h.profileId).find((d) => d.reason === 'filtered' && d.kind === 'score')!;
    assert.equal(deleteDeclines(h.db, h.profileId, [mine.id]), 1);
    assert.throws(() => deleteDeclines(h.db, h.profileId, [mine.id]), /not in the list/);
    assert.equal(deleteDeclines(h.db, h.profileId, 'all'), 2);

    // Imported again -- filtered, and then with the filter off -- and none of them comes back.
    await h.tracker.backfill(SINCE, everything);
    assert.equal(listDeclines(h.db, h.profileId).length, 0, 'never listed again');
    const unfiltered = await h.tracker.backfill(SINCE, everything, false);
    assert.equal(unfiltered.imported + unfiltered.unfinished + unfiltered.attempts, 0, 'never tracked again');
    assert.equal(h.count('scores') + h.count('incomplete_plays'), 0);
    assert.equal(listDeclines(h.db, h.profileId).length, 0);
  } finally {
    h.cleanup();
  }
});

test('the list keeps the newest plays, up to its bound, per profile', async () => {
  const h = await harness();
  try {
    const other = getOrCreateProfile(h.db, 'Someone Else');
    const decline = (profileId: number, n: number) =>
      recordDecline(
        h.db,
        profileId,
        {
          kind: 'score',
          dedupeKey: `play-${n}`,
          reason: 'another-player',
          criterion: null,
          player: 'mrekk',
          source: 'import',
          title: `Play ${n}`,
          titleOriginal: null,
          mode: 0,
          playedAt: n,
          replayPath: null,
          recording: null,
        },
        n,
      );
    decline(other, 0);
    for (let n = 1; n <= MAX_DECLINES + 5; n++) decline(h.profileId, n);

    const kept = listDeclines(h.db, h.profileId);
    assert.equal(kept.length, MAX_DECLINES);
    assert.equal(kept[0]!.title, `Play ${MAX_DECLINES + 5}`, 'newest first');
    assert.equal(kept.at(-1)!.title, 'Play 6', 'the oldest went');
    assert.equal(listDeclines(h.db, other).length, 1, 'another profile’s list is its own');
  } finally {
    h.cleanup();
  }
});
