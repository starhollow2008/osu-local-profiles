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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-test-'));
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
