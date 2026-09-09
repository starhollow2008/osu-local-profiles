import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { bonusPp, weightedAccuracy, weightedTotal } from './pp.ts';
import { levelFromScore, type Level } from './level.ts';
import type { Grade } from './grade.ts';

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
  mods: string[];
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

/** The columns every play row needs, joined to its beatmap. */
const PLAY_COLUMNS = `s.id, s.beatmap_md5, s.beatmap_id, s.mods_json, s.accuracy, s.max_combo,
        s.total_score, s.grade, s.stars, s.ranked, s.passed, s.played_at,
        b.beatmapset_id, b.artist, b.title, b.version, b.creator`;

type Row = Record<string, string | number | null>;

function toPlay(r: Row): Play {
  let mods: string[] = [];
  try {
    // mods_json holds lazer mod objects; the acronym is all the page needs.
    mods = (JSON.parse(String(r['mods_json'] ?? '[]')) as { acronym?: string }[])
      .map((m) => m.acronym ?? '')
      .filter(Boolean);
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
  };
}

/**
 * The best pp score on each distinct beatmap. osu! only ever counts one score per map
 * toward pp, so everything downstream works from this set.
 */
function bestPerBeatmap(db: Db, profileId: number, mode: Ruleset) {
  return db
    .prepare(
      `SELECT beatmap_md5, MAX(pp) AS pp, accuracy, grade
         FROM scores
        WHERE profile_id = ? AND mode = ? AND ranked = 1 AND passed = 1 AND pp IS NOT NULL
        GROUP BY beatmap_md5
        ORDER BY pp DESC`,
    )
    .all(profileId, mode) as { beatmap_md5: string; pp: number; accuracy: number; grade: Grade }[];
}

export function computeStats(db: Db, profileId: number, mode: Ruleset): ProfileStats {
  const best = bestPerBeatmap(db, profileId, mode);

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
         FROM scores
        WHERE profile_id = ? AND mode = ?`,
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
         SELECT MAX(total_score) AS best
           FROM scores
          WHERE profile_id = ? AND mode = ? AND ranked = 1 AND passed = 1
          GROUP BY beatmap_md5)`,
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

export function topPlays(db: Db, profileId: number, mode: Ruleset, limit = TOP_PLAY_LIMIT): Play[] {
  const rows = db
    .prepare(
      `SELECT ${PLAY_COLUMNS}, MAX(s.pp) AS pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND s.ranked = 1 AND s.passed = 1 AND s.pp IS NOT NULL
        GROUP BY s.beatmap_md5
        ORDER BY pp DESC
        LIMIT ?`,
    )
    .all(profileId, mode, limit) as Row[];

  return rows.map((r, i) => {
    const play = toPlay(r);
    play.weight = 0.95 ** i;
    play.weightedPp = (play.pp ?? 0) * play.weight;
    return play;
  });
}

export function recentPlays(db: Db, profileId: number, mode: Ruleset, limit = 25): Play[] {
  const rows = db
    .prepare(
      `SELECT ${PLAY_COLUMNS}, s.pp
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ?
        ORDER BY s.played_at DESC
        LIMIT ?`,
    )
    .all(profileId, mode, limit) as Row[];

  return rows.map(toPlay);
}

/** osu-web's "Most Played Beatmaps": every attempt counts, passed or not. */
export function mostPlayed(db: Db, profileId: number, mode: Ruleset, limit = 15): MostPlayed[] {
  const rows = db
    .prepare(
      `SELECT s.beatmap_md5, s.beatmap_id, COUNT(*) AS count, MAX(s.played_at) AS last_played,
              b.beatmapset_id, b.artist, b.title, b.version, b.creator
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ?
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
    .prepare('SELECT mode FROM scores WHERE profile_id = ? ORDER BY played_at DESC LIMIT 1')
    .get(profileId) as { mode: number } | undefined;
  return ((row?.mode ?? 0) as Ruleset);
}

/** Modes with at least one tracked play, so the tab bar can mark which are in use. */
export function modesWithPlays(db: Db, profileId: number): Ruleset[] {
  const rows = db
    .prepare('SELECT DISTINCT mode FROM scores WHERE profile_id = ? ORDER BY mode')
    .all(profileId) as { mode: number }[];
  return rows.map((r) => r.mode as Ruleset);
}
