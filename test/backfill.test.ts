import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openReadOnly, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { detectInstalls } from '../src/clients/detect.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { looksLikeReplay, parseReplay } from '../src/osr.ts';
import { computeStats } from '../src/calc/stats.ts';

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

/** Any parseable replay will do here: this exercises selection, not scoring. */
async function findReplay(): Promise<{ file: string; playedAt: number } | null> {
  const real = openReadOnly(REAL_DB);
  if (!real) return null;
  const candidates = real.prepare('SELECT path FROM not_beatmaps LIMIT 4000').all() as
    { path: string }[];
  real.close();

  for (const { path: p } of candidates) {
    const head = readHead(p, 8);
    if (!head || !looksLikeReplay(head)) continue;
    try {
      const score = await parseReplay(fs.readFileSync(p));
      return { file: p, playedAt: score.playedAt.getTime() };
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function harness(watchDir: string, tmp: string) {
  const installs = detectInstalls();
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Backfill Test');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, installs),
    installs: [{ ...installs[0]!, replayDir: watchDir }],
    profileId,
    // Deliberately in the future: nothing should reach the profile through the *live*
    // path, so anything that lands can only have come from the explicit import.
    trackingSince: Date.now() + 3_600_000,
    official: null,
  });
  return { db, profileId, tracker };
}

test('backfill imports only replays newer than the chosen cutoff', async (t) => {
  if (detectInstalls().length === 0) return t.skip('no osu! installation on this machine');
  const replay = await findReplay();
  if (!replay) return t.skip('no parseable replay available');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-backfill-'));
  const watchDir = path.join(tmp, 'replays');
  fs.mkdirSync(watchDir);
  const dropped = path.join(watchDir, 'past-replay');
  fs.copyFileSync(replay.file, dropped);

  const { db, profileId, tracker } = harness(watchDir, tmp);

  // A cutoff after the play was set must find nothing, however recently the file itself
  // was written -- the timestamp inside the replay is what counts.
  const tooLate = await tracker.previewBackfill(replay.playedAt + 1000);
  assert.equal(tooLate.importable, 0, 'a cutoff after the play should exclude it');

  const inRange = await tracker.previewBackfill(replay.playedAt - 1000);
  assert.equal(inRange.importable, 1, 'a cutoff before the play should find it');
  assert.equal(inRange.duplicates, 0);
  assert.ok(inRange.scanned >= 1);

  // Preview must not change anything.
  assert.equal(computeStats(db, profileId, 0).playcount, 0, 'preview must not import');

  const result = await tracker.backfill(replay.playedAt - 1000);
  assert.equal(result.imported, 1);

  const modes = db
    .prepare('SELECT mode, COUNT(*) AS n FROM scores WHERE profile_id = ? GROUP BY mode')
    .all(profileId) as { mode: number; n: number }[];
  assert.equal(modes.reduce((sum, m) => sum + m.n, 0), 1, 'exactly one score stored');

  // Running it again is a no-op: the same replay is the same play.
  const second = await tracker.backfill(replay.playedAt - 1000);
  assert.equal(second.imported, 0, 'a repeated import must not double-count');
  assert.equal(second.skipped, 1);

  const after = await tracker.previewBackfill(replay.playedAt - 1000);
  assert.equal(after.importable, 0);
  assert.equal(after.duplicates, 1, 'the stored score is reported as already tracked');

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the same replay in two places counts once', async (t) => {
  if (detectInstalls().length === 0) return t.skip('no osu! installation on this machine');
  const replay = await findReplay();
  if (!replay) return t.skip('no parseable replay available');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-backfill-dupe-'));
  const watchDir = path.join(tmp, 'replays');
  fs.mkdirSync(path.join(watchDir, 'nested'), { recursive: true });
  // lazer keeps its own copy of anything imported, so one play really can exist twice.
  fs.copyFileSync(replay.file, path.join(watchDir, 'copy-a'));
  fs.copyFileSync(replay.file, path.join(watchDir, 'nested', 'copy-b'));

  const { db, profileId, tracker } = harness(watchDir, tmp);

  const scan = await tracker.previewBackfill(replay.playedAt - 1000);
  assert.equal(scan.importable, 1, 'two files holding one play are one importable score');

  const result = await tracker.backfill(replay.playedAt - 1000);
  assert.equal(result.imported, 1);
  assert.equal(computeStats(db, profileId, 0).playcount, 1);

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
