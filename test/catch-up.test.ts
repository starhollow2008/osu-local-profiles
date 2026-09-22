import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openReadOnly, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { detectInstalls } from '../src/clients/detect.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { catchUpSince, lastRunAt, markRunning } from '../src/tracker/catch-up.ts';
import { updateSettings } from '../src/settings.ts';
import { computeStats } from '../src/calc/stats.ts';
import { looksLikeReplay, parseReplay } from '../src/osr.ts';

/*
 * Importing the plays set while the app was closed -- `importPlaysWhileClosed`.
 *
 * Roadmap 5.49 made live tracking start at the launch and stay there, because closing the app
 * is how somebody stops tracking. This is that decision made once instead of every time, so
 * the thing most worth pinning down is the *default*: a profile that has not asked for this
 * must come back from a gap with nothing new in it.
 */

const HOUR = 3_600_000;
const REAL_DB = path.join(process.cwd(), 'data', 'profiles.db');

function harness(replayDir: string, tmp: string, trackingSince = 0) {
  const installs = detectInstalls();
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Catch Up');
  const tracker = new Tracker({
    db,
    // The resolver keeps the real install, because turning a replay's beatmap into a title
    // needs this machine's beatmaps. The *tracked* install is rooted in the temp directory,
    // so the catch-up reads only the replay dropped there -- not this machine's own logs,
    // which hold hundreds of real unfinished plays and would drown the assertion.
    resolver: new BeatmapResolver(db, installs),
    installs: installs[0]
      ? [{ ...installs[0], root: path.join(tmp, 'osu'), replayDir, beatmapRoots: [] }]
      : [],
    profileId,
    // In the future, so nothing can reach the profile through the live path: whatever lands
    // can only have come from the catch-up.
    trackingSince: trackingSince || Date.now() + HOUR,
    official: null,
  });
  return { db, profileId, tracker };
}

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

/** Any parseable replay off this machine; this is about selection, not scoring. */
async function findReplay(): Promise<{ file: string; playedAt: number } | null> {
  const real = openReadOnly(REAL_DB);
  if (!real) return null;
  const candidates = real.prepare('SELECT path FROM not_beatmaps LIMIT 4000').all() as { path: string }[];
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

function tmpDb(): { db: Db; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-catchup-'));
  const db = openDb(path.join(tmp, 'test.db'));
  return { db, cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('a first launch has no gap on record, so there is nothing to catch up on', () => {
  const h = tmpDb();
  try {
    assert.equal(lastRunAt(h.db), null);
    // Null rather than some invented date: reaching back to one would import a replay store
    // nobody asked for on the very first launch.
    assert.equal(catchUpSince(null, 0), null);

    markRunning(h.db, 1_700_000_000_000);
    assert.equal(lastRunAt(h.db), 1_700_000_000_000);
    // Written again rather than accumulating rows.
    markRunning(h.db, 1_700_000_060_000);
    assert.equal(lastRunAt(h.db), 1_700_000_060_000);
  } finally {
    h.cleanup();
  }
});

test('the gap never reaches back past the profile itself', () => {
  const lastRun = 1_000;
  const now = 9_000;
  assert.equal(catchUpSince(lastRun, 0, now), lastRun);
  // A profile created (or reset) after the app last ran starts there instead: a reset is how
  // somebody says "this profile starts now", and a catch-up must not undo it.
  assert.equal(catchUpSince(lastRun, 5_000, now), 5_000);
  // A stamp from the future -- a clock that moved backwards -- is not a gap.
  assert.equal(catchUpSince(20_000, 0, now), null);
});

test('with the setting off a launch brings in nothing, and says so by returning null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-catchup-off-'));
  const replayDir = path.join(tmp, 'replays');
  fs.mkdirSync(replayDir);
  const { db, profileId, tracker } = harness(replayDir, tmp);
  try {
    // The default, stated rather than assumed: this is the half of the feature that matters.
    assert.equal(await tracker.catchUp(Date.now() - HOUR), null);
    assert.equal(computeStats(db, profileId, 0).playcount, 0);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('with the setting on, a play set during the gap is imported and announced', async (t) => {
  if (detectInstalls().length === 0) return t.skip('no osu! installation on this machine');
  const replay = await findReplay();
  if (!replay) return t.skip('no parseable replay available');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-catchup-on-'));
  const replayDir = path.join(tmp, 'replays');
  fs.mkdirSync(replayDir);
  fs.copyFileSync(replay.file, path.join(replayDir, 'played-while-closed'));

  const { db, profileId, tracker } = harness(replayDir, tmp);
  try {
    // Off: the play sits there and the profile stays empty, however long the app was shut.
    assert.equal(await tracker.catchUp(replay.playedAt - 1000), null);
    assert.equal(computeStats(db, profileId, 0).playcount, 0, 'the default must not import');

    updateSettings(db, profileId, { importPlaysWhileClosed: true });

    const announced: number[] = [];
    tracker.on('caughtUp', (r) => announced.push(r.imported));

    const result = await tracker.catchUp(replay.playedAt - 1000);
    assert.equal(result?.imported, 1);
    assert.equal(computeStats(db, profileId, 0).playcount, 1);
    // Announced, because nobody pressed a button for this one.
    assert.deepEqual(announced, [1]);

    // A second launch over the same gap is a no-op: it is an import, with an import's dedupe.
    const again = await tracker.catchUp(replay.playedAt - 1000);
    assert.equal(again?.imported, 0);
    assert.equal(computeStats(db, profileId, 0).playcount, 1, 'a relaunch must not double-count');
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a play set before the gap stays out, however the app was closed', async (t) => {
  if (detectInstalls().length === 0) return t.skip('no osu! installation on this machine');
  const replay = await findReplay();
  if (!replay) return t.skip('no parseable replay available');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-catchup-older-'));
  const replayDir = path.join(tmp, 'replays');
  fs.mkdirSync(replayDir);
  fs.copyFileSync(replay.file, path.join(replayDir, 'played-long-ago'));

  const { db, profileId, tracker } = harness(replayDir, tmp);
  try {
    updateSettings(db, profileId, { importPlaysWhileClosed: true });
    // The gap begins after the play: this reaches back to when the app last ran and no
    // further, which is what keeps it from quietly absorbing a whole history.
    const result = await tracker.catchUp(replay.playedAt + 1000);
    assert.equal(result?.imported, 0);
    assert.equal(computeStats(db, profileId, 0).playcount, 0);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
