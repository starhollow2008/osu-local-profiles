import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import { parseReplay } from '../osr.ts';
import { awardsPp, UNRESOLVED_STATUS, type BeatmapResolver } from '../clients/beatmaps.ts';
import {
  calculateScorePp,
  modsAwardPp,
  modsCountable,
  modsLabel,
  scoreMods,
  strippableMods,
} from '../calc/pp.ts';
import type { OfficialCalculator } from '../calc/official.ts';

/**
 * Recalculate stored scores in place from their replay files.
 *
 * This exists because settings can now change *which* scores count, and scores ingested
 * before those settings existed were never given the values the new rules read: an
 * unranked play has no pp at all, because there was no reason to calculate one, and a relax
 * play has no stripped-mod pp. Turning the setting on without this would show an empty
 * section and look broken.
 *
 * Unlike `scripts/reingest.mjs` this **updates rows rather than replacing them**. That
 * distinction matters: the row id is what pinned and hidden scores will refer to, and
 * `played_at` and `dedupe_key` come from the replay and must not shift. It also means a
 * replay that has since been deleted leaves its score alone instead of losing it -- the
 * score stays exactly as it was, and is reported as skipped.
 */

export interface RecomputeOptions {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  official: OfficialCalculator;
  /** Only rows missing the newer columns, rather than every score. */
  onlyMissing?: boolean;
  /** Only these scores -- one score's details recalculated as it is opened. */
  ids?: number[];
  onProgress?: (done: number, total: number) => void;
}

export interface RecomputeResult {
  /** Rows examined. */
  considered: number;
  updated: number;
  /** Replay gone from disk, unreadable, or no local .osu to score against. */
  skipped: number;
  /** Scores that gained a pp value they did not have before. */
  gainedPp: number;
}

/**
 * A row is out of date if it has never been given the columns the eligibility rules read.
 * `map_status` is the marker: it is written for every score from now on, including the
 * `UNRESOLVED_STATUS` sentinel, so NULL means "ingested before this existed".
 */
const MISSING_CLAUSE = 'map_status IS NULL';

export function countStale(db: Db, profileId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores
        WHERE profile_id = ? AND replay_path IS NOT NULL AND ${MISSING_CLAUSE}`,
    )
    .get(profileId) as { n: number };
  return row.n;
}

export async function recomputeScores(opts: RecomputeOptions): Promise<RecomputeResult> {
  const rows = opts.db
    .prepare(
      `SELECT id, replay_path, pp FROM scores
        WHERE profile_id = ? AND replay_path IS NOT NULL
          ${opts.onlyMissing ? `AND ${MISSING_CLAUSE}` : ''}
          ${opts.ids ? `AND id IN (${opts.ids.map(() => '?').join(',') || 'NULL'})` : ''}
        ORDER BY played_at ASC`,
    )
    .all(opts.profileId, ...(opts.ids ?? [])) as { id: number; replay_path: string; pp: number | null }[];

  const update = opts.db.prepare(
    `UPDATE scores
        SET mods_json = ?, mods_label = ?,
            stars = ?, pp = ?, pp_source = ?,
            pp_nomod = ?, stars_nomod = ?, beatmap_max_combo = ?,
            map_status = ?, mods_ranked = ?, mods_countable = ?, ranked = ?,
            beatmap_id = ?, pp_parts = ?, pp_nomod_parts = ?, pp_version = ?
      WHERE id = ?`,
  );

  const result: RecomputeResult = { considered: rows.length, updated: 0, skipped: 0, gainedPp: 0 };

  for (const row of rows) {
    opts.onProgress?.(result.updated + result.skipped, rows.length);

    let score;
    try {
      score = await parseReplay(fs.readFileSync(row.replay_path));
    } catch {
      // The replay has been deleted or is unreadable. Leave the stored score untouched.
      result.skipped++;
      continue;
    }

    const beatmap = opts.resolver.resolve(score.beatmapMD5);
    const mods = scoreMods(score);
    const modsRanked = modsAwardPp(mods);
    const countable = modsCountable(mods);

    const computed = beatmap.osuPath
      ? await calculateScorePp(row.replay_path, beatmap.osuPath, opts.official)
      : null;
    const strippable = strippableMods(mods);
    const stripped =
      strippable.length > 0 && beatmap.osuPath
        ? await calculateScorePp(row.replay_path, beatmap.osuPath, opts.official, strippable)
        : null;

    if (!beatmap.osuPath) {
      // Still worth writing the eligibility columns: without them the row stays "stale"
      // for ever and every recompute would examine it again.
      result.skipped++;
    }

    update.run(
      JSON.stringify(mods), modsLabel(mods),
      computed?.stars ?? null, computed?.pp ?? null, computed ? 'official' : null,
      stripped?.pp ?? null, stripped?.stars ?? null,
      computed?.maxCombo ?? null,
      beatmap.status ?? UNRESOLVED_STATUS,
      modsRanked ? 1 : 0, countable ? 1 : 0,
      awardsPp(beatmap.status) && modsRanked ? 1 : 0,
      beatmap.beatmapId,
      computed ? JSON.stringify(computed.breakdown) : null,
      stripped ? JSON.stringify(stripped.breakdown) : null,
      computed?.version ?? null,
      row.id,
    );

    if (beatmap.osuPath) result.updated++;
    if (row.pp === null && computed?.pp != null) result.gainedPp++;
  }

  opts.onProgress?.(rows.length, rows.length);
  return result;
}
