import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openReadOnly, type Db } from '../src/db/index.ts';
import { OfficialCalculator } from '../src/calc/official.ts';
import { parseReplay, looksLikeReplay, type ReplayScore } from '../src/osr.ts';
import { accuracy } from '../src/calc/grade.ts';

const REAL_DB = path.join(process.cwd(), 'data', 'profiles.db');

/**
 * A real submitted play, with the values osu! itself reported for it:
 * WONDERFUL WONDER (TV Size) [Simple Heart] +DT -> 6.93 stars, 90.81%, 151pp.
 *
 * rosu-pp gave 7.03 stars / 142pp for the same score because it still implements the
 * 2025-10-29 algorithm rather than osu!'s 2026-07-03 rework. This is what would catch the
 * helper breaking, silently returning nothing, or a package bump changing the algorithm.
 */
const REFERENCE = {
  beatmapMd5: '8f91aa532b943ceaf29a5d761366130d',
  count300: 174,
  maxCombo: 128,
  stars: 6.93,
  pp: 151.23,
  accuracy: '90.81',
};

function head(file: string, n: number): Buffer | null {
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

/** Walk the indexed non-.osu files looking for replays matching a predicate. */
async function findReplay(
  db: Db,
  match: (score: ReplayScore) => boolean,
  limit = 4000,
): Promise<{ replayPath: string; beatmapPath: string; score: ReplayScore } | null> {
  const rows = db.prepare('SELECT path FROM not_beatmaps LIMIT ?').all(limit) as { path: string }[];
  for (const { path: p } of rows) {
    const h = head(p, 8);
    if (!h || !looksLikeReplay(h)) continue;
    let score: ReplayScore;
    try {
      score = await parseReplay(fs.readFileSync(p));
    } catch {
      continue;
    }
    if (!match(score)) continue;
    const beatmap = db
      .prepare('SELECT path FROM osu_files WHERE md5 = ? LIMIT 1')
      .get(score.beatmapMD5) as { path: string } | undefined;
    if (!beatmap) continue;
    return { replayPath: p, beatmapPath: beatmap.path, score };
  }
  return null;
}

test('official calculator reproduces the values osu! reported', { timeout: 180_000 }, async (t) => {
  const db = openReadOnly(REAL_DB);
  if (!db) return t.skip('run the app once to build the beatmap index');

  const calc = await OfficialCalculator.create();
  if (!calc) {
    db.close();
    return t.skip('osu-pp helper not built (run: npm run build:pp)');
  }

  try {
    // Live-detected replays never enter not_beatmaps, so look the score up by the
    // replay path recorded when it was tracked.
    const row = db
      .prepare(
        `SELECT s.replay_path AS replay, f.path AS beatmap
           FROM scores s JOIN osu_files f ON f.md5 = s.beatmap_md5
          WHERE s.beatmap_md5 = ? AND s.count300 = ? AND s.max_combo = ?
          LIMIT 1`,
      )
      .get(REFERENCE.beatmapMd5, REFERENCE.count300, REFERENCE.maxCombo) as
      | { replay: string | null; beatmap: string }
      | undefined;

    if (!row?.replay || !fs.existsSync(row.replay)) {
      return t.skip('reference score not tracked in this profile');
    }

    const result = await calc.calculate({ replayPath: row.replay, beatmapPath: row.beatmap });
    assert.ok(result, `calculator failed: ${calc.lastError ?? 'no result'}`);
    assert.ok(result.pp !== null, 'calculator returned no pp');

    assert.ok(
      Math.abs(result.stars - REFERENCE.stars) < 0.005,
      `expected ~${REFERENCE.stars} stars, got ${result.stars.toFixed(4)}`,
    );
    assert.ok(
      Math.abs(result.pp! - REFERENCE.pp) < 0.5,
      `expected ~${REFERENCE.pp}pp, got ${result.pp!.toFixed(2)}`,
    );
    assert.equal((result.accuracy * 100).toFixed(2), REFERENCE.accuracy);
    assert.equal(result.isLegacy, false, 'a lazer replay must not be treated as legacy');
  } finally {
    calc.dispose();
    db.close();
  }
});

test('osu!stable replays are scored as legacy, not as lazer', { timeout: 180_000 }, async (t) => {
  const db = openReadOnly(REAL_DB);
  if (!db) return t.skip('run the app once to build the beatmap index');

  const calc = await OfficialCalculator.create();
  if (!calc) {
    db.close();
    return t.skip('osu-pp helper not built (run: npm run build:pp)');
  }

  try {
    const found = await findReplay(db, (s) => s.client === 'stable');
    if (!found) return t.skip('no osu!stable replay available');

    const result = await calc.calculate({
      replayPath: found.replayPath,
      beatmapPath: found.beatmapPath,
    });
    assert.ok(result, `calculator failed: ${calc.lastError ?? 'no result'}`);

    assert.equal(result.isLegacy, true, 'stable replay should be flagged legacy');
    // osu! applies the Classic mod to legacy scores; that flag is what switches the
    // performance calculator onto classic slider accuracy and legacy miss estimation.
    assert.ok(
      result.mods.includes('CL'),
      `expected the Classic mod on a legacy score, got [${result.mods.join(', ')}]`,
    );
    assert.ok(result.pp !== null && result.pp > 0, 'stable scores should still produce pp');
    assert.ok(result.stars > 0);
  } finally {
    calc.dispose();
    db.close();
  }
});

test('our accuracy agrees with osu! on both clients', { timeout: 180_000 }, async (t) => {
  const db = openReadOnly(REAL_DB);
  if (!db) return t.skip('run the app once to build the beatmap index');

  const calc = await OfficialCalculator.create();
  if (!calc) {
    db.close();
    return t.skip('osu-pp helper not built (run: npm run build:pp)');
  }

  try {
    for (const client of ['lazer', 'stable'] as const) {
      const found = await findReplay(db, (s) => s.client === client);
      if (!found) continue;
      const result = await calc.calculate({
      replayPath: found.replayPath,
      beatmapPath: found.beatmapPath,
    });
      assert.ok(result, `calculator failed for ${client}`);
      const ours = accuracy(found.score, found.score.mode);
      assert.ok(
        Math.abs(ours - result.accuracy) < 1e-6,
        `${client}: ours ${(ours * 100).toFixed(4)}% vs osu! ${(result.accuracy * 100).toFixed(4)}%`,
      );
    }
  } finally {
    calc.dispose();
    db.close();
  }
});
