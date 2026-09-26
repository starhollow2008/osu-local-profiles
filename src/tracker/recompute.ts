import fs from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import type { Db } from '../db/index.ts';
import { parseReplay, parseReplayHeader, type LazerMod } from '../osr.ts';
import { awardsPp, type BeatmapResolver } from '../clients/beatmaps.ts';
import { decodeLegacyMods, scoreMods, scorePricing } from '../calc/pp.ts';
import type { OfficialCalculator } from '../calc/official.ts';
import {
  BEATMAP_PRICED,
  priceAsPlayed,
  pricedColumns,
  priceTheRest,
  type PricedColumns,
} from './pricing.ts';
import { outdatedPpSql } from '../scores.ts';

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

/*
 * `imported_at IS NULL` on both queries below: a score taken from osu.ppy.sh carries osu!'s
 * own pp for the play and no replay to recalculate it from, so it is not stale and there is
 * nothing here to recompute. Stated rather than relied on -- `replay_path IS NOT NULL`
 * happens to exclude them today, and would stop doing so the moment an imported score were
 * ever given the replay that turned up for it later.
 */
export function countStale(db: Db, profileId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores
        WHERE profile_id = ? AND replay_path IS NOT NULL AND imported_at IS NULL
          AND ${MISSING_CLAUSE}`,
    )
    .get(profileId) as { n: number };
  return row.n;
}

/**
 * An UPDATE of these columns of one score, generated from the values themselves: the priced
 * row (`pricedColumns`, shared with ingest) is the column list, so a column cannot be added
 * without its value or bound to the wrong one. That happened once, when the list was kept by
 * hand: two columns joined the SET clause without their values, which left `WHERE id = ?`
 * bound to NULL, and the recompute wrote nothing at all while reporting every row as updated.
 */
function updater(db: Db): (id: number, values: Partial<PricedColumns>) => void {
  const statements = new Map<string, ReturnType<Db['prepare']>>();
  return (id, values) => {
    const columns = Object.keys(values);
    const sql = `UPDATE scores SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    statement.run(...(Object.values(values) as SQLInputValue[]), id);
  };
}

/**
 * What a score whose `.osu` is gone -- the map deleted since, or its file not found -- may have
 * rewritten: everything but what only a beatmap file can produce (`BEATMAP_PRICED`). A
 * recalculation after a pp rework once erased the pp of every such score for good, while a
 * score whose *replay* was gone was deliberately left alone.
 */
function withoutBeatmapPricing(values: PricedColumns): Partial<PricedColumns> {
  return Object.fromEntries(
    Object.entries(values).filter(([column]) => !BEATMAP_PRICED.has(column as keyof PricedColumns)),
  ) as Partial<PricedColumns>;
}

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
        WHERE profile_id = ? AND replay_path IS NOT NULL AND imported_at IS NULL
          ${opts.onlyMissing ? `AND ${MISSING_CLAUSE}` : ''}
          ${opts.ids ? `AND id IN (${opts.ids.map(() => '?').join(',') || 'NULL'})` : ''}
        ORDER BY played_at ASC`,
    )
    .all(opts.profileId, ...(opts.ids ?? [])) as unknown as StoredRow[];

  const update = updater(opts.db);
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
    const mods = scoreMods(score, beatmap.osuPath);
    const pricing = scorePricing(score, beatmap.osuPath);
    const computed = await priceAsPlayed(row.replay_path, beatmap, opts.official, pricing);
    const { stripped, modsRanked } = await priceTheRest(score, row.replay_path, beatmap, mods, opts.official, pricing);
    const values = pricedColumns({
      mods,
      beatmap,
      computed,
      stripped,
      modsRanked,
      calculatorVersion: opts.official.version,
    });

    if (beatmap.osuPath) {
      update(row.id, values);
      result.updated++;
    } else {
      // Still worth writing the eligibility columns: without them the row stays "stale"
      // for ever and every recompute would examine it again. Its pricing stays as it was.
      update(row.id, withoutBeatmapPricing(values));
      result.skipped++;
    }
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
 * An osu!stable score's stored mods are what decodeLegacyMods read when it was tracked; the
 * replay, when there is one, is the authority.
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

/* --------------------------------------------------- after a new calculator */

/**
 * How many scores one queued recalculation step takes. The whole run is several of these, so
 * a play set meanwhile waits for one step -- seconds -- rather than for every score there is.
 */
export const RECALCULATE_BATCH = 50;

/** One step of a recalculation: some of one profile's scores. */
export interface RecalculateBatch {
  profileId: number;
  ids: number[];
}

/**
 * What to recalculate, across every profile, in steps of `RECALCULATE_BATCH`: every score a
 * replay can price again, or with `outdatedFor`, only those priced by another release than it
 * (`outdatedPpSql`). Hidden scores are included -- one put back later should not come back
 * priced by an algorithm the rest of the profile has moved on from.
 */
export function recalculationBatches(db: Db, outdatedFor: string | null): RecalculateBatch[] {
  const rows = (
    outdatedFor === null
      ? db
          .prepare(
            `SELECT id, profile_id FROM scores
              WHERE replay_path IS NOT NULL AND imported_at IS NULL
              ORDER BY profile_id, played_at`,
          )
          .all()
      : db
          .prepare(`SELECT s.id, s.profile_id FROM scores s WHERE ${outdatedPpSql('s')} ORDER BY s.profile_id, s.played_at`)
          .all(outdatedFor)
  ) as { id: number; profile_id: number }[];
  return toBatches(rows);
}

/* ------------------------------------------------ repairs, from the replays */

/**
 * Scores stored without their beatmap's file, whose file the index has found since.
 *
 * A play on a beatmap the index did not have yet -- one osu!stable extracted mid-session,
 * before anything watched its Songs folder -- was stored as an unknown beatmap with no pp,
 * and nothing ever looked again. Now `BeatmapResolver.resolve` does look again, so
 * recalculating these is all it takes. Cheap enough to ask on every launch: it is one query,
 * and it finds nothing once they are put right.
 */
export function foundBeatmapIds(db: Db): { id: number; profile_id: number }[] {
  return db
    .prepare(
      `SELECT s.id, s.profile_id FROM scores s JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE b.osu_path IS NULL AND s.replay_path IS NOT NULL AND s.imported_at IS NULL
          AND EXISTS (SELECT 1 FROM osu_files f WHERE f.md5 = s.beatmap_md5)
        ORDER BY s.profile_id, s.played_at`,
    )
    .all() as { id: number; profile_id: number }[];
}

/**
 * osu!stable and McOsu scores whose stored mods an older version decoded wrongly.
 *
 * `decodeLegacyMods` once read only the first fifteen bits and ignored the ruleset, so a
 * ScoreV2 play was stored as nomod and a mania one lost its key count. Which scores that
 * touched is decided from each replay's own bitmask -- the old reading is the new one given
 * only those fifteen bits in osu!standard, which has a mod for every one of them -- so only
 * the rows it actually changes are recalculated. Reads a few hundred bytes of each replay.
 */
export function misdecodedIds(
  db: Db,
  readHeader: (file: string) => { mode: number; legacyMods: number } | null = readReplayHeader,
): { id: number; profile_id: number }[] {
  const rows = db
    .prepare(
      `SELECT id, profile_id, replay_path FROM scores
        WHERE client IN ('stable', 'mcosu') AND replay_path IS NOT NULL AND imported_at IS NULL
        ORDER BY profile_id, played_at`,
    )
    .all() as { id: number; profile_id: number; replay_path: string }[];
  const label = (mods: LazerMod[]) => mods.map((m) => m.acronym).join(',');
  return rows.filter((row) => {
    const header = readHeader(row.replay_path);
    if (header === null) return false;
    const before = decodeLegacyMods(header.legacyMods & 0x7fff, 0);
    return label(before) !== label(decodeLegacyMods(header.legacyMods, header.mode));
  });
}

/** A replay file's ruleset and mod bitmask, from its first bytes; null when it cannot be read. */
export function readReplayHeader(file: string): { mode: number; legacyMods: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseReplayHeader(buf.subarray(0, read));
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

/** Rows as recalculation steps, one profile at a time, in the order given. Duplicates are dropped. */
export function toBatches(rows: { id: number; profile_id: number }[]): RecalculateBatch[] {
  const seen = new Set<number>();
  const batches: RecalculateBatch[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const last = batches.at(-1);
    if (last && last.profileId === row.profile_id && last.ids.length < RECALCULATE_BATCH) {
      last.ids.push(row.id);
    } else {
      batches.push({ profileId: row.profile_id, ids: [row.id] });
    }
  }
  return batches;
}

const RECALCULATED_KEY = 'pp_recalculated_for';

/**
 * The osu! release the last recalculation after an update was for.
 *
 * Kept so that the recalculation happens once per release, on the first launch that has it,
 * rather than on every launch: a score whose replay has since been deleted stays priced by
 * the old release for good, and would otherwise be retried -- and announced -- every time.
 */
export function recalculatedFor(db: Db): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(RECALCULATED_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function markRecalculatedFor(db: Db, release: string): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(RECALCULATED_KEY, release);
}
