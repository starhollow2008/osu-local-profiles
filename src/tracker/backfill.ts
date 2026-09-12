import { wasDeleted } from '../scores.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { looksLikeReplay, parseReplay, type ReplayScore } from '../osr.ts';
import { dedupeKey } from './ingest.ts';
import type { BeatmapResolver } from '../clients/beatmaps.ts';
import { scoreMods } from '../calc/pp.ts';
import {
  beatmapFilterFacts,
  filterRejects,
  playFacts,
  type TrackingFilter,
} from '../tracking-filter.ts';

/**
 * Importing replays that were played while the app was closed.
 *
 * This is deliberately a manual action with an explicit cutoff, never something that runs
 * on startup. A profile that scanned and imported by itself would quietly absorb every
 * play made with the user's *normal* playstyle, which is the one thing a separate profile
 * must not contain. Asking for a cutoff makes the user state which session they mean.
 */

export interface BackfillCandidate {
  file: string;
  playedAt: number;
  mode: number;
  /** Already in this profile, so importing would be a no-op. */
  duplicate: boolean;
  /** Turned away by the profile's play tracking filter, so importing would not bring it in. */
  filtered: boolean;
}

export interface BackfillScan {
  candidates: BackfillCandidate[];
  /** Files examined, so the UI can say why a scan took as long as it did. */
  scanned: number;
  importable: number;
  duplicates: number;
  /**
   * How many of the plays found the tracking filter would decline. Everything but the star
   * rating: that one costs a call to osu!'s calculator per play, so it is left to the import
   * itself, and the dialog says so rather than promising a count it did not check.
   */
  filtered: number;
  /** Whether the filter constrains the star rating, which is what makes that caveat worth saying. */
  starsUnchecked: boolean;
  earliest: number | null;
  latest: number | null;
}

/** What the scan needs to apply the filter. Omitted, it reports every play as unfiltered. */
export interface BackfillFilterContext {
  resolver: BeatmapResolver;
  filter: TrackingFilter;
}

function readHead(file: string, n: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function* walk(dir: string): Generator<{ path: string; mtimeMs: number }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
      continue;
    }
    try {
      const st = fs.statSync(p);
      yield { path: p, mtimeMs: st.mtimeMs };
    } catch {
      /* vanished mid-walk */
    }
  }
}

/**
 * Find replays played at or after `since`.
 *
 * A replay file is written when the play ends, so its mtime can never precede the moment
 * it was played -- which makes mtime a sound cheap filter over lazer's ~63k-file store.
 * It is only a filter, though: lazer stamps *imported* replays with the import time, so
 * the authoritative timestamp is the one inside the file, and every surviving candidate is
 * parsed before it counts.
 */
export async function scanForReplays(
  db: Db,
  profileId: number,
  dirs: string[],
  since: number,
  filtering?: BackfillFilterContext,
): Promise<BackfillScan> {
  const candidates: BackfillCandidate[] = [];
  let scanned = 0;
  const filter = filtering?.filter;
  const applyFilter = filter !== undefined && filter.enabled;

  const seenKeys = new Set<string>();
  const isStored = db.prepare('SELECT 1 AS hit FROM scores WHERE profile_id = ? AND dedupe_key = ?');

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of walk(dir)) {
      scanned++;
      if (entry.mtimeMs < since) continue;

      const head = readHead(entry.path, 8);
      if (!head || !looksLikeReplay(head)) continue;

      let score: ReplayScore;
      try {
        score = await parseReplay(fs.readFileSync(entry.path));
      } catch {
        continue;
      }

      const playedAt = score.playedAt.getTime();
      if (playedAt < since) continue;

      const key = dedupeKey(score);
      // Two paths can hold the same replay (lazer keeps its own copy of an import), so
      // dedupe within the scan as well as against what is already stored.
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // Deleted for good from Settings: not offered, and not counted as already tracked.
      if (wasDeleted(db, profileId, key)) continue;
      const already = isStored.get(profileId, key) !== undefined;

      let filtered = false;
      if (applyFilter && filtering && !already) {
        const beatmap = filtering.resolver.resolve(score.beatmapMD5);
        const facts = beatmapFilterFacts(db, filtering.resolver, beatmap);
        filtered = filterRejects(filter, playFacts(facts, score.mode, scoreMods(score))) !== null;
      }

      candidates.push({
        file: entry.path,
        playedAt,
        mode: score.mode,
        duplicate: already,
        filtered,
      });
    }
  }
  candidates.sort((a, b) => a.playedAt - b.playedAt);
  const importable = candidates.filter((c) => !c.duplicate && !c.filtered);

  return {
    candidates,
    scanned,
    importable: importable.length,
    duplicates: candidates.filter((c) => c.duplicate).length,
    filtered: candidates.filter((c) => !c.duplicate && c.filtered).length,
    starsUnchecked: applyFilter && (filter.stars.min > 0 || filter.stars.max !== null),
    earliest: importable[0]?.playedAt ?? null,
    latest: importable[importable.length - 1]?.playedAt ?? null,
  };
}
