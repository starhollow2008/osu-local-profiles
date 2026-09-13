import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver, indexBeatmapFiles } from '../src/clients/beatmaps.ts';
import { scanLogsForPlays } from '../src/tracker/log-backfill.ts';
import { Tracker } from '../src/tracker/index.ts';

/*
 * Import past plays, reading osu!lazer's old session logs.
 *
 * The live watcher only ever follows a log from its current end, so a quit, a fail or a retry
 * from before the app was running exists nowhere but a log on disk. Importing those is the same
 * decision as importing past replays and is held to the same rules: nothing happens without a
 * cutoff and a confirmation, the preview is exactly what the import will do, and each kind of
 * play is its own choice -- asking for last week's offline attempts must not bring last week's
 * replays in with them.
 */

const REJI = 'Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]';
const SESSION = '1788778412';
const SINCE = Date.UTC(2026, 8, 7);

/*
 * One real session's shape: an online quit osu! counted -- its beatmap id is only in the network
 * log's submission request -- and then four attempts made offline, three on REJI and one on YUARU.
 */
const RUNTIME = `2026-09-07 09:00:00 [verbose]: Game-wide working beatmap updated to ${REJI}
2026-09-07 09:00:01 [verbose]: Score submission token retrieved (1775729216)
2026-09-07 09:00:02 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
2026-09-07 09:01:00 [verbose]: Score submission completed! (token:1775729216 id:7446699999)
2026-09-07 09:01:00 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
2026-09-07 10:54:08 [verbose]: Game-wide working beatmap updated to ${REJI}
2026-09-07 10:54:10 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#109
2026-09-07 10:54:47 [verbose]: No token, skipping score submission
2026-09-07 10:54:47 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#109
2026-09-07 10:56:25 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#136
2026-09-07 10:57:21 [verbose]: No token, skipping score submission
2026-09-07 10:57:21 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#136
2026-09-07 10:57:27 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#273
2026-09-07 10:57:34 [verbose]: No token, skipping score submission
2026-09-07 10:57:34 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#273
2026-09-07 10:59:56 [verbose]: Game-wide working beatmap updated to Yuaru - Asu no Yozora Shoukaihan (Speed Up Ver.) (ShogunMoon) [Together]
2026-09-07 10:59:58 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#225
2026-09-07 11:00:06 [verbose]: No token, skipping score submission
2026-09-07 11:00:06 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#225
`;

const NETWORK =
  '2026-09-07 09:01:00 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/4000001/solo/scores/1775729216 successfully completed!\n';

const osuFile = (meta: { artist: string; title: string; creator: string; version: string; id: number }) =>
  [
    'osu file format v14',
    '',
    '[General]',
    'Mode: 0',
    '',
    '[Metadata]',
    `Title:${meta.title}`,
    `Artist:${meta.artist}`,
    `Creator:${meta.creator}`,
    `Version:${meta.version}`,
    `BeatmapID:${meta.id}`,
    'BeatmapSetID:2000001',
    '',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:',
    '256,192,31000,1,0,0:0:0:0:',
    '',
  ].join('\r\n');

interface Harness {
  db: Db;
  tracker: Tracker;
  runtime: string;
  scan: (since: number) => ReturnType<typeof scanLogsForPlays>;
  count: (where?: string) => number;
  cleanup: () => void;
}

async function harness({ installYuaru = true } = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-log-backfill-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Import Test');

  const files = path.join(tmp, 'files');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(
    path.join(files, 'reji'),
    osuFile({ artist: 'Reji', title: 'Shoujo wa Yoru to Azayaka ni', creator: 'ADoorNob', version: 'Vivid Collab', id: 4000001 }),
  );
  if (installYuaru) {
    fs.writeFileSync(
      path.join(files, 'yuaru'),
      osuFile({ artist: 'Yuaru', title: 'Asu no Yozora Shoukaihan (Speed Up Ver.)', creator: 'ShogunMoon', version: 'Together', id: 4000002 }),
    );
  }
  await indexBeatmapFiles(db, [{ path: files, byExtension: false }]);

  // A lazer install rooted here, so its logs are this test's logs and nothing on the machine.
  const logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);
  const runtime = path.join(logs, `${SESSION}.runtime.log`);
  fs.writeFileSync(runtime, RUNTIME);
  fs.writeFileSync(path.join(logs, `${SESSION}.network.log`), NETWORK);
  const replays = path.join(tmp, 'replays');
  fs.mkdirSync(replays);

  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [{ kind: 'lazer', root: tmp, replayDir: replays, beatmapRoots: [files], onlineDb: null }],
    profileId,
    // In the future: nothing may arrive by the live path, so anything stored came from an import.
    trackingSince: Date.now() + 3_600_000,
    official: null,
  });

  return {
    db,
    tracker,
    runtime,
    scan: (since) => scanLogsForPlays(db, profileId, [logs], since),
    count: (where = '1 = 1') =>
      (db.prepare(`SELECT COUNT(*) AS n FROM incomplete_plays WHERE ${where}`).get() as { n: number }).n,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('the logs yield the unfinished plays and the attempts made since the cutoff', async () => {
  const h = await harness();
  try {
    const all = h.scan(SINCE);
    assert.equal(all.sessions, 1);
    assert.equal(all.unfinished.length, 1);
    assert.equal(all.unfinished[0]!.beatmapId, 4000001, 'joined to the network log by its token');
    assert.equal(all.attempts.length, 4);
    assert.ok(all.attempts.every((a) => a.session === SESSION));
    assert.equal(all.alreadyTracked, 0);

    // A cutoff between the two leaves only what came after it.
    const later = h.scan(Date.UTC(2026, 8, 7, 10, 0));
    assert.equal(later.unfinished.length, 0);
    assert.equal(later.attempts.length, 4);
  } finally {
    h.cleanup();
  }
});

test('a log last written before the cutoff is not read at all', async () => {
  const h = await harness();
  try {
    const written = new Date(Date.UTC(2026, 8, 7, 11, 1));
    fs.utimesSync(h.runtime, written, written);
    assert.equal(h.scan(Date.UTC(2026, 8, 8)).sessions, 0);
  } finally {
    h.cleanup();
  }
});

test('the preview counts each kind by the same checks the import makes, and writes nothing', async () => {
  const h = await harness();
  try {
    const preview = await h.tracker.previewBackfill(SINCE);
    assert.equal(preview.importable, 0, 'no replays in this install');
    assert.deepEqual(
      { ...preview.log, earliest: undefined, latest: undefined },
      { unfinished: 1, attempts: 4, alreadyTracked: 0, unresolved: 0, filtered: 0, sessions: 1, earliest: undefined, latest: undefined },
    );
    assert.equal(h.count(), 0);
  } finally {
    h.cleanup();
  }
});

/* Every existing caller of the import meant replays. It must keep meaning that. */
test('an import that names no sources brings in replays alone, as it always has', async () => {
  const h = await harness();
  try {
    const result = await h.tracker.backfill(SINCE);
    assert.equal(result.unfinished, 0);
    assert.equal(result.attempts, 0);
    assert.equal(h.count(), 0);
  } finally {
    h.cleanup();
  }
});

test('attempts can be brought in on their own, and only once', async () => {
  const h = await harness();
  try {
    const first = await h.tracker.backfill(SINCE, { replays: false, unfinished: false, attempts: true });
    assert.deepEqual([first.imported, first.unfinished, first.attempts], [0, 0, 4]);
    assert.equal(h.count('unsubmitted = 1'), 4);
    assert.equal(h.count('unsubmitted = 0'), 0, 'the unfinished play was not asked for');

    const again = await h.tracker.backfill(SINCE, { replays: false, unfinished: false, attempts: true });
    assert.equal(again.attempts, 0, 'a repeated import must not double-count');

    const after = await h.tracker.previewBackfill(SINCE);
    assert.equal(after.log.attempts, 0);
    assert.equal(after.log.alreadyTracked, 4);
    assert.equal(after.log.unfinished, 1, 'still there to ask for');

    const unfinished = await h.tracker.backfill(SINCE, { replays: false, unfinished: true, attempts: false });
    assert.equal(unfinished.unfinished, 1);
    assert.equal(h.count(), 5);
  } finally {
    h.cleanup();
  }
});

/* No beatmap, no mode to file it under: said in the preview, skipped by the import. */
test('an attempt on a beatmap that is not installed is reported, not imported', async () => {
  const h = await harness({ installYuaru: false });
  try {
    const preview = await h.tracker.previewBackfill(SINCE);
    assert.equal(preview.log.attempts, 3);
    assert.equal(preview.log.unresolved, 1);

    const result = await h.tracker.backfill(SINCE, { replays: false, unfinished: false, attempts: true });
    assert.equal(result.attempts, 3);
    assert.equal(result.skipped, 1);
  } finally {
    h.cleanup();
  }
});
