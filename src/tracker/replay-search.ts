import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import { looksLikeReplay, parseReplay, parseReplayHeader, type ReplayScore } from '../osr.ts';
import { readHead, walk } from './backfill.ts';
import { findExistingScore, replaces, replayIdentity, TIME_TOLERANCE_MS } from './online-import.ts';

/**
 * Finding the replays osu! wrote for plays a profile holds without one.
 *
 * An import from an osu! profile, or from a score's link, brings a play in from osu!'s own
 * record of it -- and the replay osu! wrote at the time is very often on this machine already,
 * in the very folders the app watches. Import past plays would find it, but only if asked
 * for exactly the right range, and it would bring in every other play of that range with it.
 * This looks for those plays' replays and nothing else.
 *
 * A match is `findExistingScore`'s, the same test Import past plays makes: osu!'s id for the
 * play, or the same beatmap, total, combo and moment. So what is found here is what an import
 * would have put in that row's place, and the caller writes it through the same ingest.
 *
 * Cheap where it can be. A replay file is written when its play ends, so one older than the
 * oldest play wanted is skipped on its mtime; the rest are read a header at a time, and only a
 * replay on one of the wanted beatmaps is read whole -- lazer's store holds tens of thousands
 * of files, and inflating every replay among them would take minutes.
 */

/** Enough for the header up to the mods: two 32-character hashes and a player name. */
const HEAD_BYTES = 512;

export interface ReplayMatch {
  /** The row it belongs to: a play held as osu!'s figures, or as a replay built from them. */
  rowId: number;
  file: string;
  score: ReplayScore;
}

/**
 * The replays in `dirs` of this profile's plays that have none osu! wrote: every such play, or
 * only the rows named in `only`. At most one per row, the first found.
 */
export async function findLocalReplays(
  db: Db,
  profileId: number,
  dirs: readonly string[],
  only?: readonly number[],
): Promise<ReplayMatch[]> {
  const wanted = rowsWithoutReplay(db, profileId, only);
  if (wanted.length === 0) return [];

  const ids = new Set(wanted.map((r) => r.id));
  const beatmaps = new Set(wanted.map((r) => r.beatmap_md5));
  // Clocks drift, as `findExistingScore` allows for: a file a little older than the play is still it.
  const since = Math.min(...wanted.map((r) => r.played_at)) - TIME_TOLERANCE_MS;

  const matches = new Map<number, ReplayMatch>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of walk(dir)) {
      if (entry.mtimeMs < since) continue;
      const head = readHead(entry.path, HEAD_BYTES);
      if (!head || !looksLikeReplay(head)) continue;
      try {
        if (!beatmaps.has(parseReplayHeader(head).beatmapMD5)) continue;
      } catch {
        continue;
      }

      let score: ReplayScore;
      try {
        score = await parseReplay(fs.readFileSync(entry.path));
      } catch {
        continue;
      }
      // A replay this app built is no better a record than the row it was built for.
      if (score.built) continue;
      const found = findExistingScore(db, profileId, replayIdentity(score));
      if (found === null || !ids.has(found.id) || matches.has(found.id)) continue;
      if (!replaces(found, 'replay')) continue;
      matches.set(found.id, { rowId: found.id, file: entry.path, score });
      if (matches.size === ids.size) return [...matches.values()];
    }
  }
  return [...matches.values()];
}

/**
 * Plays with no replay osu! wrote: imported with best performances (`imported_at`), or brought
 * in from a score's link (`origin = 'link'`), whose replay this app built. A score entered by
 * hand is left alone -- it has no id, and its moment is only as exact as whoever typed it.
 */
function rowsWithoutReplay(
  db: Db,
  profileId: number,
  only?: readonly number[],
): { id: number; beatmap_md5: string; played_at: number }[] {
  const rows = db
    .prepare(
      `SELECT id, beatmap_md5, played_at FROM scores
        WHERE profile_id = ? AND (imported_at IS NOT NULL OR origin = 'link')`,
    )
    .all(profileId) as { id: number; beatmap_md5: string; played_at: number }[];
  if (only === undefined) return rows;
  const named = new Set(only);
  return rows.filter((r) => named.has(r.id));
}
