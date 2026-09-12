import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openReadOnly, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { detectInstalls } from '../src/clients/detect.ts';
import { BeatmapResolver, awardsPp } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { parseReplay, looksLikeReplay } from '../src/osr.ts';
import { modsAwardPp, scoreMods } from '../src/calc/pp.ts';
import { computeStats } from '../src/calc/stats.ts';
import { OfficialCalculator } from '../src/calc/official.ts';
import { updateSettings } from '../src/settings.ts';

const REAL_DB = path.join(process.cwd(), 'data', 'profiles.db');

function readHead(file: string, n: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(n);
    const read = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Copy the prebuilt .osu index so the test does not have to rescan 63k files. */
function seedIndex(db: Db): number {
  const real = openReadOnly(REAL_DB);
  if (!real) return 0;
  const rows = real.prepare('SELECT path, md5, size FROM osu_files').all() as
    { path: string; md5: string; size: number }[];
  const insert = db.prepare(
    'INSERT OR REPLACE INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  for (const r of rows) insert.run(r.path, r.md5, r.size, Date.now());
  db.exec('COMMIT');
  real.close();
  return rows.length;
}

/** Find a real replay whose map is ranked and whose mods keep it pp-eligible. */
async function findScorableReplay(db: Db, resolver: BeatmapResolver): Promise<string | null> {
  const real = openReadOnly(REAL_DB);
  if (!real) return null;
  // Every non-.osu file the indexer examined lands here, replays included.
  const candidates = real.prepare('SELECT path FROM not_beatmaps LIMIT 4000').all() as
    { path: string }[];
  real.close();

  for (const { path: p } of candidates) {
    const head = readHead(p, 8);
    if (!head || !looksLikeReplay(head)) continue;
    let score;
    try {
      score = await parseReplay(fs.readFileSync(p));
    } catch {
      continue;
    }
    const map = resolver.resolve(score.beatmapMD5);
    if (!map.osuPath || !awardsPp(map.status)) continue;
    if (!modsAwardPp(scoreMods(score))) continue;
    return p;
  }
  return null;
}

test('watcher ingests a new replay and computes pp offline', { timeout: 120_000 }, async (t) => {
  const installs = detectInstalls();
  if (installs.length === 0) return t.skip('no osu! installation on this machine');
  if (!fs.existsSync(REAL_DB)) return t.skip('run the app once to build the beatmap index');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-test-'));
  const watchDir = path.join(tmp, 'watch');
  fs.mkdirSync(watchDir);

  const db = openDb(path.join(tmp, 'test.db'));
  const indexed = seedIndex(db);
  if (indexed === 0) return t.skip('beatmap index is empty');

  const profileId = getOrCreateProfile(db, 'Test Profile');
  const resolver = new BeatmapResolver(db, installs);

  const official = await OfficialCalculator.create();
  const source = await findScorableReplay(db, resolver);
  if (!source) return t.skip('no pp-eligible replay available to replay through the watcher');

  const tracker = new Tracker({
    db,
    resolver,
    installs: [{ ...installs[0]!, replayDir: watchDir }],
    profileId,
    trackingSince: 0, // accept the historical replay we are about to drop in
    official,
  });

  const gotScore = new Promise<{ pp: number | null; grade: string; accuracy: number; title: string }>(
    (resolve, reject) => {
      tracker.on('score', resolve);
      tracker.on('error', reject);
      // unref so a passing test does not hold the process open until the deadline.
      setTimeout(() => reject(new Error('watcher did not report a score within 30s')), 30_000).unref();
    },
  );

  tracker.start();
  // Give the recursive watch a moment to arm before the file lands.
  await new Promise((r) => setTimeout(r, 300));
  fs.copyFileSync(source, path.join(watchDir, 'incoming-replay'));

  const score = await gotScore;
  tracker.stop();

  assert.ok(score.pp !== null && score.pp > 0, `expected pp, got ${score.pp}`);
  assert.ok(score.accuracy > 0 && score.accuracy <= 1, `accuracy out of range: ${score.accuracy}`);
  assert.ok(score.title.length > 0);

  // The score must actually be persisted and reflected in the profile totals.
  const stats = computeStats(db, profileId, 0);
  assert.equal(stats.playcount, 1);
  assert.ok(stats.totalPp > 0, 'total pp should be above zero after one ranked play');
  assert.ok(stats.bonusPp > 0, 'one distinct ranked beatmap earns a little bonus pp');
  assert.ok(stats.totalScore > 0);

  // A second copy of the same replay is the same play and must not double-count.
  const again = new Promise<string>((resolve) => tracker.on('skip', (s) => resolve(s.reason)));
  tracker.start();
  await new Promise((r) => setTimeout(r, 300));
  fs.copyFileSync(source, path.join(watchDir, 'incoming-replay-copy'));
  assert.equal(await again, 'duplicate');
  tracker.stop();

  assert.equal(computeStats(db, profileId, 0).playcount, 1);

  official?.dispose();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/*
 * The play tracking filter, end to end, on a real replay through the real watcher.
 *
 * The thing worth proving here is the *absence*: a declined play must leave nothing at all
 * behind -- no score row, no pp, no play count -- because that is the whole promise of the
 * feature and the one thing a unit test on the matching rule cannot show. The filter is read
 * from the profile's settings on every ingest, so it is written there rather than handed to
 * the tracker, which is also how the page changes it while the app runs.
 */
test('a play the filter declines is not recorded at all', { timeout: 120_000 }, async (t) => {
  const installs = detectInstalls();
  if (installs.length === 0) return t.skip('no osu! installation on this machine');
  if (!fs.existsSync(REAL_DB)) return t.skip('run the app once to build the beatmap index');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-filter-e2e-'));
  const watchDir = path.join(tmp, 'watch');
  fs.mkdirSync(watchDir);

  const db = openDb(path.join(tmp, 'test.db'));
  if (seedIndex(db) === 0) return t.skip('beatmap index is empty');
  const profileId = getOrCreateProfile(db, 'Test Profile');
  const resolver = new BeatmapResolver(db, installs);
  const source = await findScorableReplay(db, resolver);
  if (!source) return t.skip('no replay available to drop through the watcher');

  // A keyword no beatmap on this machine can contain, so the rejection is unambiguous.
  updateSettings(db, profileId, {
    trackingFilter: { enabled: true, keywords: 'zzz-not-a-real-beatmap-zzz' },
  });

  const tracker = new Tracker({
    db,
    resolver,
    installs: [{ ...installs[0]!, replayDir: watchDir }],
    profileId,
    trackingSince: 0,
    official: null,
  });

  const declined = new Promise<{ title: string; criterion: string; kind: string }>(
    (resolve, reject) => {
      tracker.on('filtered', resolve);
      tracker.on('score', () => reject(new Error('the filter let a play through')));
      tracker.on('error', reject);
      setTimeout(() => reject(new Error('nothing reported within 30s')), 30_000).unref();
    },
  );

  try {
    tracker.start();
    // The watch has to be up before the file lands; see the fs.watch notes in CLAUDE.md.
    await new Promise((r) => setTimeout(r, 300));
    fs.copyFileSync(source, path.join(watchDir, 'incoming-replay'));

    const play = await declined;
    assert.equal(play.criterion, 'keywords');
    assert.equal(play.kind, 'score');
    assert.ok(play.title.length > 0, 'a declined play still has to say which map it was');

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n,
      0,
      'a filtered play must leave no score row',
    );
    assert.equal(computeStats(db, profileId, 0).playcount, 0);
    assert.equal(tracker.playsFiltered, 1);

    /*
     * And the same replay with the filter switched off is tracked, which is what makes the
     * first half a statement about the filter rather than about this particular replay.
     */
    updateSettings(db, profileId, { trackingFilter: { enabled: false } });
    const tracked = new Promise<{ title: string }>((resolve, reject) => {
      tracker.on('score', resolve);
      setTimeout(() => reject(new Error('no score reported within 30s')), 30_000).unref();
    });
    fs.copyFileSync(source, path.join(watchDir, 'incoming-replay-again'));
    assert.ok((await tracked).title.length > 0);
    assert.equal(computeStats(db, profileId, 0).playcount, 1);
  } finally {
    tracker.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/*
 * The other half of detection, end to end: a play that osu! counted but lazer kept no
 * replay for. Nothing here touches a real osu! installation -- the log directory, the
 * beatmap and the play are all synthetic -- because the point is the wiring between the
 * log watcher, the ingest and the profile totals.
 */
test('the tracker counts a play that finished without a score', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-incomplete-e2e-'));
  const logs = path.join(tmp, 'logs');
  const watchDir = path.join(tmp, 'files');
  fs.mkdirSync(logs);
  fs.mkdirSync(watchDir);

  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Test Profile');
  // Seeded straight into the cache, which is where md5ForBeatmapId looks first, so this
  // needs neither online.db nor a .osu on disk.
  db.prepare(
    `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator,
       status, cached_at) VALUES ('md5-a', 5438074, 900, 'Artist', 'Title', 'Insane', 'C', 1, 0)`,
  ).run();

  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [
      { kind: 'lazer', root: tmp, replayDir: watchDir, beatmapRoots: [], onlineDb: null },
    ],
    profileId,
    trackingSince: 0,
    official: null,
  });

  const token = '1775729216';
  const gotPlay = new Promise<{ title: string; mode: number }>((resolve, reject) => {
    tracker.on('incomplete', resolve);
    tracker.on('error', reject);
    setTimeout(() => reject(new Error('no incomplete play reported within 15s')), 15_000).unref();
  });

  const runtime = path.join(logs, '1000.runtime.log');
  fs.writeFileSync(runtime, '');
  fs.writeFileSync(
    path.join(logs, '1000.network.log'),
    `2026-09-10 01:12:59 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores/${token} successfully completed!\n`,
  );

  tracker.start();
  await new Promise((r) => setTimeout(r, 300));
  fs.appendFileSync(
    runtime,
    `2026-09-10 01:11:55 [verbose]: Game-wide working beatmap updated to Artist - Title (C) [Insane]
2026-09-10 01:11:56 [verbose]: Score submission token retrieved (${token})
2026-09-10 01:11:56 [verbose]: OsuScreenStack#658(depth:6) entered SoloPlayer#414
2026-09-10 01:12:59 [verbose]: Score submission completed! (token:${token} id:7446699999)
2026-09-10 01:12:59 [verbose]: OsuScreenStack#658(depth:5) exit from SoloPlayer#414
`,
  );

  try {
    const play = await gotPlay;
    assert.equal(play.title, 'Artist - Title [Insane]');
    assert.equal(play.mode, 0);

    // It is a play: it counts, and it brings none of a score's numbers with it.
    const stats = computeStats(db, profileId, 0);
    assert.equal(stats.playcount, 1);
    assert.equal(stats.totalScore, 0);
    assert.equal(stats.totalPp, 0);
  } finally {
    // The watchers hold the event loop open, so a failed assertion would hang the run
    // rather than reporting itself.
    tracker.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
