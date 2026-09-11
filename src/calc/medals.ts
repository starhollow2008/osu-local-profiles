import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { countsSql, ppColumn, starsColumn, visibleSql, VANILLA, type Eligibility } from './eligibility.ts';
import { estimateRank } from './rank.ts';
import { bonusPp, weightedTotal } from './pp.ts';
import definitions from './medal-definitions.json' with { type: 'json' };

/**
 * The medals a profile has earned, derived from its scores.
 *
 * **Derived, never stored.** The same reasoning as `history.ts`: a reingest, a removed
 * score, or a settings change must not leave a medal behind that the profile can no longer
 * justify. So they are recomputed from the scores every time, and the date on a medal is
 * the date of the first score that satisfied it.
 *
 * The definitions -- names, descriptions, icons, thresholds -- come from osu!'s own
 * achievement list, rebuilt by `scripts/build-medal-table.mjs`. What exists is not the same
 * in every mode: combo and play-count medals are osu!standard's, the other modes have
 * hit-count medals instead, and star pass/FC medals run 1..10 for osu!standard and 1..8
 * elsewhere. That asymmetry is osu!'s, and is reproduced rather than smoothed over.
 *
 * Two families are only as good as their inputs, and say so:
 * - **Rank** medals use the estimated pp-to-rank curve, so they inherit its approximation.
 * - **FC** medals need the beatmap's own maximum combo, which is only stored for scores
 *   ingested since that column existed. Older scores can be filled in by a recompute.
 */

export type MedalFamily = 'combo' | 'plays' | 'hits' | 'pass' | 'fc' | 'rank';

export interface Medal {
  slug: string;
  name: string;
  description: string;
  /** osu!'s own icon. Remote, and optional -- the page draws its own if it cannot load. */
  icon: string;
  family: MedalFamily;
  /** The combo, play count, hit count, star level or rank this medal asks for. */
  threshold: number;
  /** When it was first earned, or null while it is still locked. */
  achievedAt: number | null;
  /**
   * Whether `achievedAt` is the real moment it was earned. False for rank medals, which are
   * decided once from the current total rather than replayed score by score -- so they have
   * no date worth announcing in the Recent feed.
   */
  dated: boolean;
  /** Filled in for an earned medal: the play that earned it, where there is one. */
  earnedOn: string | null;
}

/** osu!'s group for every medal this app can award, and what its medal card is headed. */
export const MEDAL_GROUPING = 'Skill & Dedication';

export interface MedalSummary {
  medals: Medal[];
  earned: number;
  total: number;
  /**
   * True when some scores predate `beatmap_max_combo`, so an FC cannot be told from a
   * near-miss on them. The page offers a recompute rather than quietly under-awarding.
   */
  fcUnknown: number;
}

interface Definition {
  slug: string;
  name: string;
  description: string;
  icon: string;
  threshold: number;
}

interface ModeDefinitions {
  combo?: Definition[];
  plays?: Definition[];
  hits?: Definition[];
  pass?: Definition[];
  fc?: Definition[];
}

const TABLE = definitions as {
  rank: Definition[];
  modes: Record<string, ModeDefinitions>;
};

/** One score, reduced to what any medal could possibly need. */
interface MedalRow {
  played_at: number;
  beatmap_md5: string;
  max_combo: number;
  hits: number;
  stars: number | null;
  pp: number | null;
  counts: number;
  passed: number;
  miss: number;
  beatmap_max_combo: number | null;
  title: string | null;
  artist: string | null;
}

/**
 * A full combo: nothing missed, and the whole combo reached.
 *
 * The beatmap's own maximum is required rather than assumed. lazer scores can drop slider
 * ends without breaking combo, and a "no misses" test alone would award an FC medal to a
 * run that dropped a hundred of them. Returns null when the map's maximum is unknown, so
 * the caller can report that rather than guess in either direction.
 */
function isFullCombo(row: MedalRow): boolean | null {
  if (row.miss > 0) return false;
  if (row.beatmap_max_combo === null || row.beatmap_max_combo <= 0) return null;
  return row.max_combo >= row.beatmap_max_combo;
}

function title(row: MedalRow): string | null {
  const name = [row.artist, row.title].filter(Boolean).join(' - ');
  return name.length > 0 ? name : null;
}

/**
 * Every medal for one mode, in the order osu! groups them.
 *
 * One chronological pass over the profile's scores answers all of them at once, exactly as
 * `buildHistory` does, because they are all the same question: when did this profile first
 * look like *that*?
 */
export function computeMedals(
  db: Db,
  profileId: number,
  mode: Ruleset,
  e: Eligibility = VANILLA,
): MedalSummary {
  const rows = db
    .prepare(
      `SELECT s.played_at, s.beatmap_md5, s.max_combo, s.passed, s.count_miss AS miss,
              s.beatmap_max_combo,
              (s.count300 + s.count100 + s.count50 + s.count_geki + s.count_katu) AS hits,
              ${starsColumn(e)} AS stars,
              ${ppColumn(e)} AS pp,
              ${countsSql(e)} AS counts,
              b.title, b.artist
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
        ORDER BY s.played_at ASC`,
    )
    .all(profileId, mode) as unknown as MedalRow[];

  const family = TABLE.modes[String(mode)] ?? {};
  const medals: Medal[] = [];
  let fcUnknown = 0;

  /* --- running totals, advanced one score at a time -------------------- */

  const bestByMap = new Map<string, number>();
  let playcount = 0;
  let totalHits = 0;
  let bestCombo = 0;

  /** first[threshold] = when that threshold was first reached, and on what. */
  const comboAt = new Map<number, MedalRow>();
  const playsAt = new Map<number, MedalRow>();
  const hitsAt = new Map<number, MedalRow>();
  const passAt = new Map<number, MedalRow>();
  const fcAt = new Map<number, MedalRow>();

  const comboTargets = (family.combo ?? []).map((m) => m.threshold);
  const playTargets = (family.plays ?? []).map((m) => m.threshold);
  const hitTargets = (family.hits ?? []).map((m) => m.threshold);

  const remember = (into: Map<number, MedalRow>, threshold: number, row: MedalRow) => {
    if (!into.has(threshold)) into.set(threshold, row);
  };

  for (const row of rows) {
    playcount++;
    totalHits += row.hits;
    if (row.max_combo > bestCombo) bestCombo = row.max_combo;

    for (const target of comboTargets) if (bestCombo >= target) remember(comboAt, target, row);
    for (const target of playTargets) if (playcount >= target) remember(playsAt, target, row);
    for (const target of hitTargets) if (totalHits >= target) remember(hitsAt, target, row);

    /*
     * Star medals are about the beatmap that was played, not about the profile's totals, so
     * they need a real star rating and a passing score. An unranked map still counts: osu!
     * awards these on any beatmap, and so does this.
     */
    if (row.passed === 1 && row.stars !== null) {
      const level = Math.floor(row.stars);
      for (let star = 1; star <= level; star++) remember(passAt, star, row);

      const fc = isFullCombo(row);
      if (fc === null) fcUnknown++;
      else if (fc) for (let star = 1; star <= level; star++) remember(fcAt, star, row);
    }

    // Rank needs the profile's pp, which is the weighted total of its best score on each
    // distinct beatmap -- keyed by beatmap, exactly as `computeStats` derives it. Keying by
    // anything else would count every attempt on a map and inflate the total.
    if (row.counts === 1 && row.pp !== null) {
      const previous = bestByMap.get(row.beatmap_md5);
      if (previous === undefined || row.pp > previous) bestByMap.set(row.beatmap_md5, row.pp);
    }
  }

  /*
   * Rank medals, computed once at the end.
   *
   * Deliberately not replayed per score: recomputing a weighted top-100 on every row is
   * quadratic, and unlike the pp chart there is nothing to draw in between. So a rank medal
   * carries no date -- it says what the profile has reached, not when.
   */
  const bests = [...bestByMap.values()].sort((a, b) => b - a);
  const totalPp = weightedTotal(bests.slice(0, 100)) + bonusPp(bests.length);
  const currentRank = estimateRank(totalPp, mode)?.rank ?? null;

  /* --- turn the running totals into medals ----------------------------- */

  const add = (
    definitions: Definition[] | undefined,
    familyName: MedalFamily,
    earnedOn: Map<number, MedalRow>,
  ) => {
    for (const definition of definitions ?? []) {
      const row = earnedOn.get(definition.threshold);
      medals.push({
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        family: familyName,
        threshold: definition.threshold,
        achievedAt: row?.played_at ?? null,
        dated: true,
        earnedOn: row ? title(row) : null,
      });
    }
  };

  const addRank = () => {
    for (const definition of TABLE.rank) {
      // Lower is better: the medal is earned once the estimated rank is inside the threshold.
      const earned = currentRank !== null && currentRank <= definition.threshold;
      medals.push({
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        family: 'rank',
        threshold: definition.threshold,
        achievedAt: earned ? (rows[rows.length - 1]?.played_at ?? null) : null,
        dated: false,
        earnedOn: null,
      });
    }
  };

  // osu!'s own `ordering` within Skill & Dedication: combo 0, plays 1, rank 2, hits 3,
  // pass 4, fc 5. Each ordering is one row of medals on osu!'s profile page.
  add(family.combo, 'combo', comboAt);
  add(family.plays, 'plays', playsAt);
  addRank();
  add(family.hits, 'hits', hitsAt);
  add(family.pass, 'pass', passAt);
  add(family.fc, 'fc', fcAt);

  return {
    medals,
    earned: medals.filter((m) => m.achievedAt !== null).length,
    total: medals.length,
    fcUnknown,
  };
}

/**
 * How many medals the profile holds across every mode -- osu!'s header figure, which is the
 * length of the account's whole achievement list and does not change with the mode tab.
 *
 * Counted by slug, so a rank medal reached in two modes is still one medal, exactly as osu!
 * awards it once.
 */
export function earnedMedalCount(db: Db, profileId: number, e: Eligibility = VANILLA): number {
  const earned = new Set<string>();
  for (const mode of [0, 1, 2, 3] as Ruleset[]) {
    for (const medal of computeMedals(db, profileId, mode, e).medals) {
      if (medal.achievedAt !== null) earned.add(medal.slug);
    }
  }
  return earned.size;
}
