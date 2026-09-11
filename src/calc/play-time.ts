import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import type { LazerMod, Ruleset } from '../osr.ts';
import { visibleSql } from './eligibility.ts';

/**
 * Total Play Time, computed the way osu! computes it.
 *
 * osu!'s own rule lives in `osu-queue-score-statistics` (`PlayValidityHelper.GetPlayLength`,
 * applied by `PlayTimeProcessor`, which runs on failed scores too). For every play:
 *
 *     min(beatmap length / rate, time from the play's token to its submission)
 *
 * where the rate is the product of every rate-adjust mod's speed change (DT and NC 1.5x,
 * HT and DC 0.75x by default). The cap is what stops an idle pause from counting; the
 * beatmap length is what stops a quit two seconds in from counting as the whole map.
 *
 * Two approximations, both small and both said here rather than hidden:
 *
 * - **A finished score counts its whole length.** The replay does not record when the play
 *   started, so there is no wall-clock time to take the minimum against. For a map played
 *   to the end the length is the smaller of the two anyway -- loading and lead-in only add
 *   to the elapsed side -- so this is what osu! would have counted, give or take a pause.
 * - **The length ends at the last object's start**, or its end for a spinner or a mania
 *   hold. A slider's end needs its path length and the timing points under it; what that
 *   leaves out is one slider's duration at the end of a map.
 *
 * Incomplete plays (quits, retries, HP fails) are exactly where the elapsed time matters,
 * and lazer's log records both ends of them. Rows ingested before `started_at` existed have
 * no start to measure from and contribute nothing -- an unknown duration is not guessed.
 */

/** The default speed of each rate-adjust mod when lazer wrote no setting for it. */
const DEFAULT_RATE: Readonly<Record<string, number>> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

/**
 * How fast the play ran. Only osu!'s `ModRateAdjust` mods count, as in `GetPlayLength`;
 * Wind Up/Down and Adaptive Speed change speed mid-play and are left out there too.
 */
export function playRate(mods: readonly LazerMod[]): number {
  let rate = 1;
  for (const mod of mods) {
    const fallback = DEFAULT_RATE[mod.acronym];
    if (fallback === undefined) continue;
    const setting = mod.settings?.['speed_change'];
    rate *= typeof setting === 'number' && setting > 0 ? setting : fallback;
  }
  return rate;
}

/**
 * First hit object to last, in milliseconds, from a `.osu` file's `[HitObjects]` section.
 * 0 when the file cannot be read or has no objects, which callers treat as "unknown".
 */
export function beatmapLengthMs(text: string): number {
  const start = text.indexOf('[HitObjects]');
  if (start < 0) return 0;

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const raw of text.slice(start + '[HitObjects]'.length).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('[')) break;

    const fields = line.split(',');
    const time = Number(fields[2]);
    const type = Number(fields[3]);
    if (!Number.isFinite(time) || !Number.isFinite(type)) continue;

    let end = time;
    // Spinner (bit 3) and mania hold (bit 7) carry their end time in the sixth field; a
    // hold writes it as `end:hitSample`, so only the part before the colon is the time.
    if ((type & 8) !== 0 || (type & 128) !== 0) {
      const value = Number((fields[5] ?? '').split(':')[0]);
      if (Number.isFinite(value) && value > end) end = value;
    }

    if (time < first) first = time;
    if (end > last) last = end;
  }

  return Number.isFinite(first) && last > first ? Math.round(last - first) : 0;
}

/**
 * Give every cached beatmap a length, reading each `.osu` at most once.
 *
 * Done lazily rather than at ingest so that beatmaps cached before the column existed are
 * covered too, with no migration pass over the whole store. A file that cannot be read is
 * stored as 0 so it is not retried on every request.
 *
 * Every cached beatmap, whoever played it: the cache only holds beatmaps some play has
 * resolved, so this is bounded. Narrowing it to one profile and mode meant gathering every
 * beatmap they had played, on every request, to find the few still unread.
 */
function fillBeatmapLengths(db: Db): void {
  const missing = db
    .prepare('SELECT md5, osu_path FROM beatmaps WHERE length_ms IS NULL AND osu_path IS NOT NULL')
    .all() as { md5: string; osu_path: string }[];
  if (missing.length === 0) return;

  const update = db.prepare('UPDATE beatmaps SET length_ms = ? WHERE md5 = ?');
  for (const row of missing) {
    let length = 0;
    try {
      length = beatmapLengthMs(fs.readFileSync(row.osu_path, 'utf8'));
    } catch {
      /* moved or deleted since it was indexed: unknown, and remembered as such */
    }
    update.run(length, row.md5);
  }
}

/** Total seconds played in one mode, scored plays and incomplete ones together. */
export function playTimeSeconds(db: Db, profileId: number, mode: Ruleset): number {
  fillBeatmapLengths(db);

  let ms = 0;

  const scores = db
    .prepare(
      `SELECT s.mods_json, b.length_ms
         FROM scores s LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}`,
    )
    .all(profileId, mode) as { mods_json: string; length_ms: number | null }[];

  // A profile's scores use a handful of distinct mod lists, so each is parsed once.
  const rates = new Map<string, number>();
  const rateOf = (json: string): number => {
    let rate = rates.get(json);
    if (rate === undefined) {
      let mods: LazerMod[] = [];
      try {
        mods = JSON.parse(json) as LazerMod[];
      } catch {
        /* unreadable mods: treat as nomod rather than drop the play */
      }
      rate = playRate(mods);
      rates.set(json, rate);
    }
    return rate;
  };

  for (const row of scores) {
    if (!row.length_ms) continue;
    ms += row.length_ms / rateOf(row.mods_json);
  }

  const incomplete = db
    .prepare(
      `SELECT s.started_at, s.played_at, b.length_ms
         FROM incomplete_plays s LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()} AND s.started_at IS NOT NULL`,
    )
    .all(profileId, mode) as { started_at: number; played_at: number; length_ms: number | null }[];

  for (const row of incomplete) {
    const elapsed = Math.max(0, row.played_at - row.started_at);
    // The log never names the mods, so the cap is the map at its own speed. That only ever
    // lets a sped-up play count slightly longer than osu! would, never a quit count as more
    // than the time actually spent in it.
    ms += row.length_ms ? Math.min(row.length_ms, elapsed) : elapsed;
  }

  return Math.floor(ms / 1000);
}
