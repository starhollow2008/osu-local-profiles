import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { bonusPp, weightedTotal } from './pp.ts';
import { levelFromScore } from './level.ts';
import { countsSql, ppColumn, visibleSql, VANILLA, type Eligibility } from './eligibility.ts';

/**
 * The time-series and activity feed behind the profile page's chart, the Historical
 * section's monthly play counts, and the Recent section.
 *
 * All three come from one chronological pass over the profile's scores, because they are
 * answers to the same question: what did this profile look like at each point in time?
 * There is no stored history to read -- `snapshots` only ever gets written going forward,
 * and would be wrong after a reingest -- so it is replayed from the scores themselves,
 * which are the source of truth.
 */

export interface PpPoint {
  /** UTC midnight of the day this value was reached. */
  at: number;
  pp: number;
}

export interface MonthlyPlaycount {
  /** UTC month start. */
  at: number;
  count: number;
}

export type ActivityEvent =
  | { type: 'best'; at: number; pp: number; title: string; version: string | null }
  | { type: 'level'; at: number; level: number }
  | { type: 'first'; at: number };

export interface History {
  pp: PpPoint[];
  monthlyPlaycounts: MonthlyPlaycount[];
  /** The most recent `maxEvents`, newest first. */
  events: ActivityEvent[];
  /** How many there are in total, so the page can offer to show more of them. */
  eventsTotal: number;
}

const DAY = 86_400_000;

function utcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

function utcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Every month between two month-starts inclusive, so a gap renders as zero, not a jump. */
function monthsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  const d = new Date(from);
  while (d.getTime() <= to) {
    out.push(d.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Total pp for a set of per-beatmap bests, exactly as `computeStats` derives it. */
function totalPp(bests: number[]): number {
  const sorted = [...bests].sort((a, b) => b - a);
  return weightedTotal(sorted.slice(0, 100)) + bonusPp(sorted.length);
}

export function buildHistory(
  db: Db,
  profileId: number,
  mode: Ruleset,
  maxEvents = 15,
  e: Eligibility = VANILLA,
): History {
  const rows = db
    .prepare(
      // `counts` is the same predicate the totals use, selected rather than filtered on:
      // level and monthly play counts are about everything played, pp only about what
      // counts, and both come out of this one chronological pass.
      `SELECT s.played_at, ${ppColumn(e)} AS pp, s.total_score, s.beatmap_md5,
              ${countsSql(e)} AS counts,
              b.title, b.artist, b.version
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at ASC`,
    )
    .all(profileId, mode) as {
    played_at: number;
    pp: number | null;
    total_score: number;
    beatmap_md5: string;
    counts: number;
    title: string | null;
    artist: string | null;
    version: string | null;
  }[];

  /*
   * The plays that finished without a score. They belong in the monthly play counts for the
   * same reason they belong in the play count -- osu! counts them -- but nowhere else in
   * this function: they carry no pp to move the chart and no total score to raise a level.
   */
  const abandoned = db
    .prepare(
      `SELECT s.played_at
         FROM incomplete_plays s
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at ASC`,
    )
    .all(profileId, mode) as { played_at: number }[];

  if (rows.length === 0 && abandoned.length === 0) {
    return { pp: [], monthlyPlaycounts: [], events: [], eventsTotal: 0 };
  }

  const bestByMap = new Map<string, number>();
  const pp: PpPoint[] = [];
  const monthly = new Map<number, number>();
  const events: ActivityEvent[] = [];

  let runningScore = 0;
  let level = 1;
  let bestPlay = 0;
  let pendingDay: number | null = null;

  for (const play of abandoned) {
    const month = utcMonth(play.played_at);
    monthly.set(month, (monthly.get(month) ?? 0) + 1);
  }

  // The profile started when it was first played, which an abandoned attempt counts as.
  const firstAt = Math.min(
    rows[0]?.played_at ?? Number.POSITIVE_INFINITY,
    abandoned[0]?.played_at ?? Number.POSITIVE_INFINITY,
  );
  events.push({ type: 'first', at: firstAt });

  for (const row of rows) {
    const day = utcDay(row.played_at);
    // One pp point per day: recomputing the weighted total costs a sort, and a chart
    // 90 days wide gains nothing from finer resolution.
    if (pendingDay !== null && day !== pendingDay) {
      pp.push({ at: pendingDay, pp: totalPp([...bestByMap.values()]) });
    }
    pendingDay = day;

    const month = utcMonth(row.played_at);
    monthly.set(month, (monthly.get(month) ?? 0) + 1);

    runningScore += row.total_score;
    const nextLevel = levelFromScore(runningScore).current;
    if (nextLevel > level) {
      level = nextLevel;
      events.push({ type: 'level', at: row.played_at, level });
    }

    if (row.counts !== 1 || row.pp === null) continue;

    const previous = bestByMap.get(row.beatmap_md5);
    if (previous === undefined || row.pp > previous) bestByMap.set(row.beatmap_md5, row.pp);

    if (row.pp > bestPlay) {
      bestPlay = row.pp;
      events.push({
        type: 'best',
        at: row.played_at,
        pp: row.pp,
        title: [row.artist, row.title].filter(Boolean).join(' - ') || row.beatmap_md5.slice(0, 12),
        version: row.version,
      });
    }
  }

  if (pendingDay !== null) pp.push({ at: pendingDay, pp: totalPp([...bestByMap.values()]) });

  const months = [...monthly.keys()].sort((a, b) => a - b);
  const monthlyPlaycounts = monthsBetween(months[0]!, months[months.length - 1]!).map((at) => ({
    at,
    count: monthly.get(at) ?? 0,
  }));

  return {
    pp,
    monthlyPlaycounts,
    events: events.slice(-maxEvents).reverse(),
    eventsTotal: events.length,
  };
}
