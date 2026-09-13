import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import { parseReplay, type LazerMod } from '../osr.ts';
import { awardsPp, UNRESOLVED_STATUS, type BeatmapResolver } from '../clients/beatmaps.ts';
import {
  calculateScorePp,
  modsCountable,
  modsLabel,
  rankedByOsu,
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
 * `map_status` is one marker: it is written for every score from now on, including the
 * `UNRESOLVED_STATUS` sentinel, so NULL means "ingested before this existed".
 * `mods_ranked_by` is the other: NULL means osu! has not yet said whether the mods are ranked,
 * because the row predates asking it or the helper could not answer.
 */
const MISSING_CLAUSE = '(map_status IS NULL OR mods_ranked_by IS NULL)';

export function countStale(db: Db, profileId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores
        WHERE profile_id = ? AND replay_path IS NOT NULL AND ${MISSING_CLAUSE}`,
    )
    .get(profileId) as { n: number };
  return row.n;
}

/**
 * The columns a recompute rewrites, in the order the statement binds them.
 *
 * The SQL is generated from this list and the values are read back out by name, so a column
 * added without its value -- or a value without its column -- cannot silently shift every
 * parameter after it. That happened once: two columns joined the SET clause without their
 * values, which left `WHERE id = ?` bound to NULL, and the recompute wrote nothing at all
 * while reporting every row as updated.
 */
const UPDATE_COLUMNS = [
  'mods_json',
  'mods_label',
  'stars',
  'pp',
  'pp_source',
  'score_standard',
  'score_classic',
  'pp_nomod',
  'stars_nomod',
  'beatmap_max_combo',
  'map_status',
  'mods_ranked',
  'mods_ranked_by',
  'mods_countable',
  'ranked',
  'beatmap_id',
  'pp_parts',
  'pp_nomod_parts',
  'pp_version',
] as const;

type UpdateValues = Record<(typeof UPDATE_COLUMNS)[number], string | number | null>;

interface StoredRow {
  id: number;
  replay_path: string;
  pp: number | null;
  mode: number;
  mods_json: string | null;
  map_status: number | null;
}

export async function recomputeScores(opts: RecomputeOptions): Promise<RecomputeResult> {
  const rows = opts.db
    .prepare(
      `SELECT id, replay_path, pp, mode, mods_json, map_status FROM scores
        WHERE profile_id = ? AND replay_path IS NOT NULL
          ${opts.onlyMissing ? `AND ${MISSING_CLAUSE}` : ''}
          ${opts.ids ? `AND id IN (${opts.ids.map(() => '?').join(',') || 'NULL'})` : ''}
        ORDER BY played_at ASC`,
    )
    .all(opts.profileId, ...(opts.ids ?? [])) as unknown as StoredRow[];

  const update = opts.db.prepare(
    `UPDATE scores SET ${UPDATE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  );
  const updateRanked = opts.db.prepare(
    'UPDATE scores SET mods_ranked = ?, mods_ranked_by = ?, ranked = ? WHERE id = ?',
  );

  const result: RecomputeResult = { considered: rows.length, updated: 0, skipped: 0, gainedPp: 0 };

  for (const row of rows) {
    opts.onProgress?.(result.updated + result.skipped, rows.length);

    let score;
    try {
      score = await parseReplay(fs.readFileSync(row.replay_path));
    } catch {
      // The replay has been deleted or is unreadable. Leave the stored score untouched, except
      // for asking osu! about the mods it keeps -- see recheckStoredMods.
      await recheckStoredMods(row, opts.official, updateRanked);
      result.skipped++;
      continue;
    }

    const beatmap = opts.resolver.resolve(score.beatmapMD5);
    const mods = scoreMods(score);
    const modsRanked = await rankedByOsu(score, opts.official);
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

    const values: UpdateValues = {
      mods_json: JSON.stringify(mods),
      mods_label: modsLabel(mods),
      stars: computed?.stars ?? null,
      pp: computed?.pp ?? null,
      pp_source: computed ? 'official' : null,
      score_standard: computed?.standardisedScore ?? null,
      score_classic: computed?.classicScore ?? null,
      pp_nomod: stripped?.pp ?? null,
      stars_nomod: stripped?.stars ?? null,
      beatmap_max_combo: computed?.maxCombo ?? null,
      map_status: beatmap.status ?? UNRESOLVED_STATUS,
      mods_ranked: modsRanked === null ? null : modsRanked ? 1 : 0,
      mods_ranked_by: modsRanked === null ? null : (opts.official.version ?? 'unknown'),
      mods_countable: countable ? 1 : 0,
      ranked: awardsPp(beatmap.status) && modsRanked === true ? 1 : 0,
      beatmap_id: beatmap.beatmapId,
      pp_parts: computed ? JSON.stringify(computed.breakdown) : null,
      pp_nomod_parts: stripped ? JSON.stringify(stripped.breakdown) : null,
      pp_version: computed?.version ?? null,
    };
    update.run(...UPDATE_COLUMNS.map((column) => values[column]), row.id);

    if (beatmap.osuPath) result.updated++;
    if (row.pp === null && computed?.pp != null) result.gainedPp++;
  }

  opts.onProgress?.(rows.length, rows.length);
  return result;
}

/**
 * A score whose replay is gone keeps everything it has, but the mods it was played with are
 * stored, so osu! can still say whether they are ranked. Without this such a score would stay
 * judged by the old hand-kept list, and stale for ever: the page would keep offering a
 * recompute that can never finish it.
 *
 * An osu!stable score's stored mods are what decodeLegacyMods reads, which leaves out mania's
 * key-count and Random bits. The replay, when there is one, carries them all.
 */
async function recheckStoredMods(
  row: StoredRow,
  official: OfficialCalculator,
  update: ReturnType<Db['prepare']>,
): Promise<void> {
  if (row.map_status === null || row.mods_json === null) return;
  let mods: LazerMod[];
  try {
    mods = JSON.parse(row.mods_json) as LazerMod[];
  } catch {
    return;
  }
  const answer = await official.ranked({ ruleset: row.mode, mods });
  if (!answer) return;
  update.run(
    answer.ranked ? 1 : 0,
    official.version ?? 'unknown',
    awardsPp(row.map_status) && answer.ranked ? 1 : 0,
    row.id,
  );
}
