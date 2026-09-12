import type { Db } from '../db/index.ts';
import type { LazerMod, Ruleset } from '../osr.ts';
import { bonusPp, weightedAccuracy, weightedTotal, withClassicMod } from './pp.ts';
import { levelFromScore, type Level } from './level.ts';
import { playTimeSeconds } from './play-time.ts';
import type { Grade } from './grade.ts';
import {
  countsSql,
  ppColumn,
  scoreColumn,
  starsColumn,
  visibleSql,
  VANILLA,
  type Eligibility,
} from './eligibility.ts';

/** osu! weights only the top 100 plays. */
const TOP_PLAY_LIMIT = 100;

/** One score as the profile page renders it. Shared by Top Ranks and Recent Plays. */
export interface Play {
  /** Distinguishes a real score from the score-less rows Recent Plays also carries. */
  kind: 'score';
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
  /**
   * Whether a replay file was recorded for this score, so the row's menu can offer to
   * download it. The file itself is checked when it is asked for: osu! can delete it.
   */
  hasReplay: boolean;
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
  /** Seconds, by osu!'s own per-play rule -- see src/calc/play-time.ts. */
  playTime: number;
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
  return `s.id, s.beatmap_md5, s.beatmap_id, s.mods_json, s.client, s.accuracy, s.max_combo,
        ${scoreColumn(e)} AS total_score, s.grade, s.ranked, s.passed, s.played_at,
        ${starsColumn(e)} AS stars,
        ${countsSql(e)} AS counts,
        s.pp_nomod IS NOT NULL AS has_nomod,
        s.pinned_at IS NOT NULL AS pinned,
        s.replay_path IS NOT NULL AS has_replay,
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
  // As osu! lists a stable play: with Classic, which osu! itself scored it with.
  mods = withClassicMod(mods, r['client'] === 'stable' ? 'stable' : 'lazer');

  return {
    kind: 'score',
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
    hasReplay: r['has_replay'] === 1,
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
              COALESCE(SUM(${scoreColumn(e)}), 0)                  AS total_score,
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

  /*
   * Plays that finished without a score -- a quit, a retry, an HP fail. osu! counts these
   * and so does this, because the alternative is a play count that disagrees with the
   * website by more than half. See src/clients/lazer-log.ts for where they come from.
   */
  const incomplete = db
    .prepare(
      `SELECT COUNT(*) AS n FROM incomplete_plays s
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}`,
    )
    .get(profileId, mode) as { n: number };

  // Ranked score counts the best score on each ranked map, not every attempt.
  const ranked = db
    .prepare(
      `SELECT COALESCE(SUM(best), 0) AS ranked_score FROM (
         SELECT MAX(${scoreColumn(e)}) AS best
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
    playcount: totals.playcount + incomplete.n,
    totalScore: totals.total_score,
    rankedScore: ranked.ranked_score,
    totalHits: totals.total_hits,
    /*
     * Divided by the *scored* plays, not the play count above. osu!'s own figure includes
     * the hits from failed plays; ours cannot, because a play with no replay records no
     * hits anywhere. Dividing the hits we do have by a play count swollen with plays that
     * contribute none would bias this low by the whole size of that gap, so the ratio is
     * taken over the subset where both halves are known.
     *
     * osu-web floors this rather than rounding (Stats.getHitsPerPlay).
     */
    hitsPerPlay: totals.playcount > 0 ? Math.floor(totals.total_hits / totals.playcount) : 0,
    maxCombo: totals.max_combo,
    playTime: playTimeSeconds(db, profileId, mode),
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
 * One visible score, exactly as a row would show it -- the pp, stars and eligibility follow
 * the same settings. Null when it is not this profile's, or has been removed.
 */
export function playById(
  db: Db,
  profileId: number,
  id: number,
  e: Eligibility = VANILLA,
): Play | null {
  const row = db
    .prepare(
      `SELECT ${playColumns(e)}, ${ppColumn(e)} AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.id = ? AND s.profile_id = ? AND ${visibleSql()}`,
    )
    .get(id, profileId) as Row | undefined;
  return row ? toPlay(row, e) : null;
}

/**
 * How Recent Plays treats the plays that finished without a score.
 *
 * A setting rather than a fixed answer because it genuinely depends on how someone plays:
 * on the session this feature was built from there were 26 abandoned attempts against 19
 * finished ones, so showing every one of them turns the feed into a list of retries.
 * `collapse` folds a consecutive run on one beatmap into a single row that says how many.
 */
export type IncompleteDisplay = 'yes' | 'collapse' | 'no';

/** A play osu! counted that has no score attached to it. */
export interface IncompletePlay {
  kind: 'incomplete';
  id: number;
  beatmapMd5: string | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  playedAt: number;
  /** Consecutive attempts on this beatmap folded into this row; 1 unless collapsed. */
  attempts: number;
}

export type RecentEntry = Play | IncompletePlay;

/**
 * How many rows to pull from each side before merging.
 *
 * Collapsing shrinks the list, so the answer cannot be built from exactly `limit` rows of
 * each: a run of forty attempts on one map would otherwise fill the whole feed and leave
 * nothing else to show. Bounded so a profile with a long history still costs one indexed
 * read per side.
 */
const RECENT_SOURCE_ROWS = 200;

/**
 * Every recent play, counting or not -- this is a log of what was played, so an unranked
 * map or a relax attempt belongs in it. Each row carries `counted` so the page can say
 * which of them reached Best Performance.
 *
 * Abandoned attempts are merged in by time, subject to `incomplete`. They carry none of the
 * numbers a score does, because lazer never writes them down for a play it does not keep.
 */
export function recentPlays(
  db: Db,
  profileId: number,
  mode: Ruleset,
  limit = 25,
  e: Eligibility = VANILLA,
  incomplete: IncompleteDisplay = 'collapse',
): RecentEntry[] {
  const want = incomplete === 'no' ? limit : Math.min(RECENT_SOURCE_ROWS, Math.max(limit * 8, limit));

  const rows = db
    .prepare(
      `SELECT ${playColumns(e)}, ${ppColumn(e)} AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at DESC
        LIMIT ?`,
    )
    .all(profileId, mode, want) as Row[];

  const scores: RecentEntry[] = rows.map((r) => toPlay(r, e));
  if (incomplete === 'no') return scores.slice(0, limit);

  const abandoned = db
    .prepare(
      `SELECT s.id, s.beatmap_md5, s.beatmap_id, s.beatmap_name, s.played_at,
              b.beatmapset_id, b.artist, b.title, b.version, b.creator
         FROM incomplete_plays s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at DESC
        LIMIT ?`,
    )
    .all(profileId, mode, want) as Row[];

  const merged: RecentEntry[] = [...scores, ...abandoned.map(toIncomplete)].sort(
    (a, b) => b.playedAt - a.playedAt,
  );

  return (incomplete === 'collapse' ? collapseRuns(merged) : merged).slice(0, limit);
}

function toIncomplete(r: Row): IncompletePlay {
  return {
    kind: 'incomplete',
    id: r['id'] as number,
    beatmapMd5: (r['beatmap_md5'] as string | null) ?? null,
    beatmapId: (r['beatmap_id'] as number | null) ?? null,
    beatmapsetId: (r['beatmapset_id'] as number | null) ?? null,
    artist: (r['artist'] as string | null) ?? null,
    // Whatever the log called the map stands in when the beatmap itself is not resolvable,
    // so the row still names something rather than showing a hash.
    title: (r['title'] as string | null) ?? (r['beatmap_name'] as string | null) ?? null,
    version: (r['version'] as string | null) ?? null,
    creator: (r['creator'] as string | null) ?? null,
    playedAt: r['played_at'] as number,
    attempts: 1,
  };
}

/**
 * Fold each run of abandoned attempts on one beatmap into a single row.
 *
 * Only *consecutive* ones, so a finished run in the middle of a grind still breaks the
 * feed up the way it happened. The row keeps the time of the most recent attempt, since
 * the list is newest first and that is where it sits.
 */
function collapseRuns(entries: RecentEntry[]): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const entry of entries) {
    const previous = out[out.length - 1];
    if (
      entry.kind === 'incomplete' &&
      previous?.kind === 'incomplete' &&
      previous.beatmapMd5 !== null &&
      previous.beatmapMd5 === entry.beatmapMd5
    ) {
      previous.attempts++;
      continue;
    }
    out.push(entry.kind === 'incomplete' ? { ...entry } : entry);
  }
  return out;
}

/**
 * How many rows each paged section has in total.
 *
 * The page loads five of each and asks for more as the user expands, so the lists it holds
 * are deliberately short -- but the headings still show a count, and the "show more" button
 * only exists while there is more. Both need the real total, which is a `COUNT` rather than
 * the length of a page.
 */
export function recentPlayTotal(db: Db, profileId: number, mode: Ruleset): number {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM scores s
                WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()})
            + (SELECT COUNT(*) FROM incomplete_plays s
                WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}) AS n`,
    )
    .get(profileId, mode, profileId, mode) as { n: number };
  return row.n;
}

/** Distinct beatmaps played, which is how many rows Most Played can ever show. */
export function mostPlayedTotal(db: Db, profileId: number, mode: Ruleset): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT s.beatmap_md5 FROM scores s
          WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
          UNION
         SELECT s.beatmap_md5 FROM incomplete_plays s
          WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
                AND s.beatmap_md5 IS NOT NULL)`,
    )
    .get(profileId, mode, profileId, mode) as { n: number };
  return row.n;
}

/**
 * osu-web's "Most Played Beatmaps": every attempt counts, passed or not.
 *
 * "Every attempt" has to mean the abandoned ones too, or the map someone spent an evening
 * retrying twenty times shows up as the two runs they managed to finish -- which is the
 * opposite of what this section is for.
 */
export function mostPlayed(db: Db, profileId: number, mode: Ruleset, limit = 15): MostPlayed[] {
  const rows = db
    .prepare(
      `SELECT p.beatmap_md5, MAX(p.beatmap_id) AS beatmap_id,
              COUNT(*) AS count, MAX(p.played_at) AS last_played,
              b.beatmapset_id, b.artist, b.title, b.version, b.creator
         FROM (SELECT s.beatmap_md5, s.beatmap_id, s.played_at
                 FROM scores s
                WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
                UNION ALL
               SELECT s.beatmap_md5, s.beatmap_id, s.played_at
                 FROM incomplete_plays s
                WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
                      AND s.beatmap_md5 IS NOT NULL) p
         LEFT JOIN beatmaps b ON b.md5 = p.beatmap_md5
        GROUP BY p.beatmap_md5
        ORDER BY count DESC, last_played DESC
        LIMIT ?`,
    )
    .all(profileId, mode, profileId, mode, limit) as Row[];

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

/**
 * Which mode to show on load: whichever the most recent tracked play was set on.
 *
 * Scores only, deliberately. An abandoned attempt is enough to say a mode has been played
 * (see `modesWithPlays`) but not enough to open the page on it, since every section but the
 * play count would be empty.
 */
export function mostRecentMode(db: Db, profileId: number): Ruleset {
  const row = db
    .prepare(`SELECT mode FROM scores s WHERE s.profile_id = ? AND ${visibleSql()}
       ORDER BY s.played_at DESC LIMIT 1`)
    .get(profileId) as { mode: number } | undefined;
  return ((row?.mode ?? 0) as Ruleset);
}

/**
 * Modes with at least one tracked play, so the tab bar can mark which are in use.
 *
 * A play that was quit still happened, and it is in the mode's play count, so the mode has
 * to be reachable -- otherwise the profile would hold plays with no tab to see them under.
 */
export function modesWithPlays(db: Db, profileId: number): Ruleset[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT mode FROM (
         SELECT s.mode FROM scores s WHERE s.profile_id = ? AND ${visibleSql()}
         UNION ALL
         SELECT s.mode FROM incomplete_plays s WHERE s.profile_id = ? AND ${visibleSql()})
       ORDER BY mode`,
    )
    .all(profileId, profileId) as { mode: number }[];
  return rows.map((r) => r.mode as Ruleset);
}
