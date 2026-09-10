import type { Db } from '../db/index.ts';
import type { LazerMod, Ruleset } from '../osr.ts';
import { bonusPp, weightedAccuracy, weightedTotal } from './pp.ts';
import { levelFromScore, type Level } from './level.ts';
import type { Grade } from './grade.ts';
import {
  countsSql,
  ppColumn,
  starsColumn,
  visibleSql,
  VANILLA,
  type Eligibility,
} from './eligibility.ts';

/** osu! weights only the top 100 plays. */
const TOP_PLAY_LIMIT = 100;

/** One score as the profile page renders it. Shared by Top Ranks and Recent Plays. */
export interface Play {
  id: number;
  beatmapMd5: string;
  beatmapId: number | null;
  beatmapsetId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  /** Full mod objects, not just acronyms: lazer carries settings such as DT at 1.3x. */
  mods: LazerMod[];
  accuracy: number;
  maxCombo: number;
  totalScore: number;
  grade: Grade;
  stars: number | null;
  pp: number | null;
  ranked: boolean;
  passed: boolean;
  playedAt: number;
  /** 0.95^index -- only set for Top Ranks, where the play's pp is weighted. */
  weight: number | null;
  weightedPp: number | null;
  /**
   * Whether this score counts toward *this profile's* pp, which is not the same question as
   * `ranked`: with unranked mods included, a relax play counts while osu! would not rank it.
   */
  counted: boolean;
  /**
   * Where the pp figure came from. `without-unranked-mods` means the play was priced with
   * Relax or Autopilot removed, so it must be shown as the estimate it is.
   */
  ppBasis: 'as-played' | 'without-unranked-mods' | null;
  /** Pinned to the profile by the user, so the row's menu offers to unpin it. */
  pinned: boolean;
}

export interface MostPlayed {
  beatmapMd5: string;
  beatmapId: number | null;
  beatmapsetId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  count: number;
}

export interface ProfileStats {
  mode: Ruleset;
  totalPp: number;
  /** The weighted top-100 portion, before the play-breadth bonus. */
  weightedPp: number;
  bonusPp: number;
  accuracy: number;
  playcount: number;
  totalScore: number;
  rankedScore: number;
  totalHits: number;
  hitsPerPlay: number;
  maxCombo: number;
  level: Level;
  grades: Record<Grade, number>;
  distinctRankedBeatmaps: number;
}

const EMPTY_GRADES = (): Record<Grade, number> => ({
  XH: 0, X: 0, SH: 0, S: 0, A: 0, B: 0, C: 0, D: 0, F: 0,
});

/**
 * The columns every play row needs, joined to its beatmap.
 *
 * `stars` and `counts` depend on the settings, so they are built per query: `stars` may be
 * the stripped-mod rating, and `counts` is the same predicate the totals use, selected
 * rather than filtered on so a row can say why it is or is not counting.
 */
function playColumns(e: Eligibility): string {
  return `s.id, s.beatmap_md5, s.beatmap_id, s.mods_json, s.accuracy, s.max_combo,
        s.total_score, s.grade, s.ranked, s.passed, s.played_at,
        ${starsColumn(e)} AS stars,
        ${countsSql(e)} AS counts,
        s.pp_nomod IS NOT NULL AS has_nomod,
        s.pinned_at IS NOT NULL AS pinned,
        b.beatmapset_id, b.artist, b.title, b.version, b.creator`;
}

type Row = Record<string, string | number | null>;

function toPlay(r: Row, e: Eligibility): Play {
  let mods: LazerMod[] = [];
  try {
    // Kept whole: lazer only writes `settings` when the player customised the mod, so a
    // score set on DT at 1.3x is indistinguishable from a default one without them.
    mods = (JSON.parse(String(r['mods_json'] ?? '[]')) as LazerMod[]).filter((m) => m?.acronym);
  } catch {
    /* a malformed row should not take the whole page down */
  }

  return {
    id: r['id'] as number,
    beatmapMd5: r['beatmap_md5'] as string,
    beatmapId: (r['beatmap_id'] as number | null) ?? null,
    beatmapsetId: (r['beatmapset_id'] as number | null) ?? null,
    artist: (r['artist'] as string | null) ?? null,
    title: (r['title'] as string | null) ?? null,
    version: (r['version'] as string | null) ?? null,
    creator: (r['creator'] as string | null) ?? null,
    mods,
    accuracy: r['accuracy'] as number,
    maxCombo: r['max_combo'] as number,
    totalScore: r['total_score'] as number,
    grade: r['grade'] as Grade,
    stars: (r['stars'] as number | null) ?? null,
    pp: (r['pp'] as number | null) ?? null,
    ranked: r['ranked'] === 1,
    passed: r['passed'] === 1,
    playedAt: r['played_at'] as number,
    weight: null,
    weightedPp: null,
    counted: r['counts'] === 1,
    pinned: r['pinned'] === 1,
    ppBasis:
      r['pp'] === null
        ? null
        : e.preferStrippedPp && r['has_nomod'] === 1
          ? 'without-unranked-mods'
          : 'as-played',
  };
}

/**
 * The best pp score on each distinct beatmap. osu! only ever counts one score per map
 * toward pp, so everything downstream works from this set.
 */
function bestPerBeatmap(db: Db, profileId: number, mode: Ruleset, e: Eligibility) {
  return db
    .prepare(
      `SELECT s.beatmap_md5, MAX(${ppColumn(e)}) AS pp, s.accuracy, s.grade
         FROM scores s
        WHERE s.profile_id = ? AND s.mode = ? AND ${countsSql(e)}
        GROUP BY s.beatmap_md5
        ORDER BY pp DESC`,
    )
    .all(profileId, mode) as { beatmap_md5: string; pp: number; accuracy: number; grade: Grade }[];
}

export function computeStats(
  db: Db,
  profileId: number,
  mode: Ruleset,
  e: Eligibility = VANILLA,
): ProfileStats {
  const best = bestPerBeatmap(db, profileId, mode, e);

  const top = best.slice(0, TOP_PLAY_LIMIT);
  const weighted = weightedTotal(top.map((r) => r.pp));
  const bonus = bonusPp(best.length);

  const totals = db
    .prepare(
      `SELECT COUNT(*)                                            AS playcount,
              COALESCE(SUM(total_score), 0)                       AS total_score,
              COALESCE(SUM(count300 + count100 + count50
                           + count_geki + count_katu), 0)         AS total_hits,
              COALESCE(MAX(max_combo), 0)                         AS max_combo
         FROM scores s
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}`,
    )
    .get(profileId, mode) as {
    playcount: number;
    total_score: number;
    total_hits: number;
    max_combo: number;
  };

  // Ranked score counts the best score on each ranked map, not every attempt.
  const ranked = db
    .prepare(
      `SELECT COALESCE(SUM(best), 0) AS ranked_score FROM (
         SELECT MAX(s.total_score) AS best
           FROM scores s
          WHERE s.profile_id = ? AND s.mode = ? AND ${countsSql(e)}
          GROUP BY s.beatmap_md5)`,
    )
    .get(profileId, mode) as { ranked_score: number };

  const grades = EMPTY_GRADES();
  for (const row of best) if (row.grade in grades) grades[row.grade]++;

  return {
    mode,
    totalPp: weighted + bonus,
    weightedPp: weighted,
    bonusPp: bonus,
    accuracy: weightedAccuracy(top.map((r) => r.accuracy)),
    playcount: totals.playcount,
    totalScore: totals.total_score,
    rankedScore: ranked.ranked_score,
    totalHits: totals.total_hits,
    // osu-web floors this rather than rounding (Stats.getHitsPerPlay).
    hitsPerPlay: totals.playcount > 0 ? Math.floor(totals.total_hits / totals.playcount) : 0,
    maxCombo: totals.max_combo,
    level: levelFromScore(totals.total_score),
    grades,
    distinctRankedBeatmaps: best.length,
  };
}

export function topPlays(
  db: Db,
  profileId: number,
  mode: Ruleset,
  limit = TOP_PLAY_LIMIT,
  e: Eligibility = VANILLA,
): Play[] {
  const rows = db
    .prepare(
      `SELECT ${playColumns(e)}, MAX(${ppColumn(e)}) AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${countsSql(e)}
        GROUP BY s.beatmap_md5
        ORDER BY pp DESC
        LIMIT ?`,
    )
    .all(profileId, mode, limit) as Row[];

  return rows.map((r, i) => {
    const play = toPlay(r, e);
    play.weight = 0.95 ** i;
    play.weightedPp = (play.pp ?? 0) * play.weight;
    return play;
  });
}

/**
 * Scores the user pinned, in the order they arranged them.
 *
 * Deliberately not filtered by eligibility: pinning is how you show a play you are proud of
 * that pp does not reward -- an unranked map, a relax run, a play outside the top 100. Each
 * row still carries `counted`, so a pin that contributes nothing to the total says so.
 */
export function pinnedPlays(
  db: Db,
  profileId: number,
  mode: Ruleset,
  e: Eligibility = VANILLA,
): Play[] {
  const rows = db
    .prepare(
      `SELECT ${playColumns(e)}, ${ppColumn(e)} AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()} AND s.pinned_at IS NOT NULL
        ORDER BY s.pin_order ASC, s.pinned_at ASC`,
    )
    .all(profileId, mode) as Row[];

  return rows.map((r) => toPlay(r, e));
}

/**
 * Every recent play, counting or not -- this is a log of what was played, so an unranked
 * map or a relax attempt belongs in it. Each row carries `counted` so the page can say
 * which of them reached Best Performance.
 */
export function recentPlays(
  db: Db,
  profileId: number,
  mode: Ruleset,
  limit = 25,
  e: Eligibility = VANILLA,
): Play[] {
  const rows = db
    .prepare(
      `SELECT ${playColumns(e)}, ${ppColumn(e)} AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at DESC
        LIMIT ?`,
    )
    .all(profileId, mode, limit) as Row[];

  return rows.map((r) => toPlay(r, e));
}

/** osu-web's "Most Played Beatmaps": every attempt counts, passed or not. */
export function mostPlayed(db: Db, profileId: number, mode: Ruleset, limit = 15): MostPlayed[] {
  const rows = db
    .prepare(
      `SELECT s.beatmap_md5, s.beatmap_id, COUNT(*) AS count, MAX(s.played_at) AS last_played,
              b.beatmapset_id, b.artist, b.title, b.version, b.creator
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        GROUP BY s.beatmap_md5
        ORDER BY count DESC, last_played DESC
        LIMIT ?`,
    )
    .all(profileId, mode, limit) as Row[];

  return rows.map((r) => ({
    beatmapMd5: r['beatmap_md5'] as string,
    beatmapId: (r['beatmap_id'] as number | null) ?? null,
    beatmapsetId: (r['beatmapset_id'] as number | null) ?? null,
    artist: (r['artist'] as string | null) ?? null,
    title: (r['title'] as string | null) ?? null,
    version: (r['version'] as string | null) ?? null,
    creator: (r['creator'] as string | null) ?? null,
    count: r['count'] as number,
  }));
}

/** Which mode to show on load: whichever the most recent tracked play was set on. */
export function mostRecentMode(db: Db, profileId: number): Ruleset {
  const row = db
    .prepare(`SELECT mode FROM scores s WHERE s.profile_id = ? AND ${visibleSql()}
       ORDER BY s.played_at DESC LIMIT 1`)
    .get(profileId) as { mode: number } | undefined;
  return ((row?.mode ?? 0) as Ruleset);
}

/** Modes with at least one tracked play, so the tab bar can mark which are in use. */
export function modesWithPlays(db: Db, profileId: number): Ruleset[] {
  const rows = db
    .prepare(`SELECT DISTINCT s.mode FROM scores s WHERE s.profile_id = ? AND ${visibleSql()}
       ORDER BY s.mode`)
    .all(profileId) as { mode: number }[];
  return rows.map((r) => r.mode as Ruleset);
}
