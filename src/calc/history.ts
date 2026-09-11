import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { bonusPp, weightedTotal } from './pp.ts';
import { levelFromScore } from './level.ts';
import { countsSql, ppColumn, visibleSql, VANILLA, type Eligibility } from './eligibility.ts';
import type { Medal, MedalFamily } from './medals.ts';

/**
 * The time-series and activity feed behind the profile page's chart, the Historical
 * section's monthly play counts, and the Recent section.
 *
 * All three come from one chronological pass over the profile's scores, because they are
 * answers to the same question: what did this profile look like at each point in time?
 * There is no stored history to read -- a stored one would be wrong after a reingest -- so
 * it is replayed from the scores themselves, which are the source of truth.
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
  | { type: 'first'; at: number }
  | {
      type: 'medal';
      at: number;
      slug: string;
      name: string;
      description: string;
      icon: string;
      family: MedalFamily;
      threshold: number;
    };

/**
 * The Recent-feed entries for a mode's medals: one per medal, at the moment it was earned.
 *
 * Only medals with a real date. A rank medal is decided from the current total rather than
 * replayed score by score (see `computeMedals`), so its "date" is merely the latest play and
 * would keep sliding to the top of the feed.
 */
export function medalEvents(medals: readonly Medal[]): ActivityEvent[] {
  return medals
    .filter((m) => m.achievedAt !== null && m.dated)
    .map((m) => ({
      type: 'medal' as const,
      at: m.achievedAt!,
      slug: m.slug,
      name: m.name,
      description: m.description,
      icon: m.icon,
      family: m.family,
      threshold: m.threshold,
    }));
}

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

/**
 * Total pp for per-beatmap bests already sorted highest first, exactly as `computeStats`
 * derives it: the weighted top 100, plus the bonus for how many there are.
 */
function totalPp(bestsDescending: number[]): number {
  return weightedTotal(bestsDescending.slice(0, 100)) + bonusPp(bestsDescending.length);
}

/** Where `value` belongs in a list sorted highest first: after every entry at least as large. */
function insertionPoint(list: readonly number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! >= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first position holding `value` in a list sorted highest first (it must be there). */
function positionOf(list: readonly number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! > value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildHistory(
  db: Db,
  profileId: number,
  mode: Ruleset,
  maxEvents = 15,
  e: Eligibility = VANILLA,
  /** Events derived elsewhere -- medals -- merged into the feed by time. */
  extraEvents: readonly ActivityEvent[] = [],
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
  /*
   * The same bests, kept sorted highest first as each improves, so a day's total reads the
   * top 100 instead of re-sorting every map played so far. That re-sort, once per day of
   * history, was most of what this function cost on a large profile. A map's best only
   * ever rises, so each improvement is one removal and one insertion.
   */
  const ranked: number[] = [];
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
      pp.push({ at: pendingDay, pp: totalPp(ranked) });
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
    if (previous === undefined || row.pp > previous) {
      bestByMap.set(row.beatmap_md5, row.pp);
      if (previous !== undefined) ranked.splice(positionOf(ranked, previous), 1);
      ranked.splice(insertionPoint(ranked, row.pp), 0, row.pp);
    }

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

  if (pendingDay !== null) pp.push({ at: pendingDay, pp: totalPp(ranked) });

  // A stable sort, so a medal earned by the same play as a new best lands after it, the way
  // osu! would announce the score before the medal it unlocked.
  events.push(...extraEvents);
  events.sort((a, b) => a.at - b.at);

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
