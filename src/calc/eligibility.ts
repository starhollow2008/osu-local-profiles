import { Status, UNRANKED_MAP_STATUSES } from '../clients/beatmaps.ts';
import type { Settings } from '../settings.ts';

/**
 * Which stored scores count toward this profile's pp, and which pp value to count.
 *
 * There is exactly one definition of "counts", and it lives here. It used to be the
 * `scores.ranked` column, which was decided once at ingest -- fine while the answer was
 * always osu!'s answer, but the moment the user can opt into relax plays or unranked maps,
 * baking the verdict into the row means every change of mind is a reingest. So the row now
 * stores the *facts* (`map_status`, `mods_ranked`, `mods_countable`, both pp values) and
 * this module turns settings into the SQL that reads them.
 *
 * Everything below returns a fragment with the values already inlined. They are booleans
 * and integers derived from a closed set of settings, never user text, so there is nothing
 * to parameterise and prepared statements stay cacheable per setting combination.
 */

export interface Eligibility {
  /** Count scores whose mods osu! refuses to rank (relax, a customised rate, ...). */
  includeUnrankedMods: boolean;
  /** Score relax/autopilot plays as if the mod were off, rather than as osu! prices them. */
  preferStrippedPp: boolean;
  /** Beatmap `approved` values to count beyond ranked and approved. Empty by default. */
  extraMapStatuses: number[];
  /**
   * Which of osu!'s two score scales every score-shaped number is read on, exactly as osu!'s
   * own profile page switches between them: `lazer` is standardised (a nomod SS is
   * 1,000,000), `classic` the uncapped older scale. It moves the score on every row and card,
   * Total Score, Ranked Score and the level, because all of them are the same number summed.
   */
  scoring: 'lazer' | 'classic';
}

/** osu!'s own rules: ranked and approved maps, default settings on ranked mods, nothing else. */
export const VANILLA: Eligibility = {
  includeUnrankedMods: false,
  preferStrippedPp: false,
  extraMapStatuses: [],
  scoring: 'lazer',
};

export function eligibilityOf(settings: Settings): Eligibility {
  const includeUnrankedMods = settings.includeUnrankedMods;
  return {
    includeUnrankedMods,
    // Only meaningful while unranked mods are being counted at all.
    preferStrippedPp: includeUnrankedMods && settings.unrankedModPp === 'without-the-mod',
    extraMapStatuses: mapStatuses(settings.includeUnrankedMaps),
    scoring: settings.scoring === 'classic' ? 'classic' : 'lazer',
  };
}

/**
 * Turn the setting's status names into osu!'s numeric values.
 *
 * `getSettings` already validates, but this is the one place where a stored setting reaches
 * generated SQL, so it validates again rather than trusting its caller. Anything unknown is
 * dropped; duplicates are collapsed; the result is sorted so the SQL is stable and prepared
 * statements stay cacheable rather than varying with the order the boxes were ticked.
 */
function mapStatuses(names: readonly string[] | undefined): number[] {
  if (!Array.isArray(names)) return [];
  const out = new Set<number>();
  for (const name of names) {
    const status = UNRANKED_MAP_STATUSES[name as keyof typeof UNRANKED_MAP_STATUSES];
    if (typeof status === 'number') out.add(status);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Scores the user has not removed from the profile.
 *
 * This belongs on *every* query over `scores`, not only the ones that decide pp: a removed
 * score must vanish from Recent Plays, Most Played, the play count and the level bar too,
 * or it has not really been removed. It is separate from `countsSql` because it applies to
 * queries that have nothing to do with eligibility.
 */
export function visibleSql(alias = 's'): string {
  return `${alias}.hidden_at IS NULL`;
}

/** Statuses that award pp in osu!. */
const RANKED_STATUSES = [Status.RANKED, Status.APPROVED];

/**
 * The pp column to rank and weight by.
 *
 * `COALESCE` is safe in both directions: `pp_nomod` is only ever set on a score carrying
 * Relax or Autopilot, and such a score is filtered out entirely unless unranked mods are
 * being counted -- so the fallback can never quietly substitute a stripped value into an
 * otherwise-official profile.
 */
export function ppColumn(e: Eligibility, alias = 's'): string {
  return e.preferStrippedPp ? `COALESCE(${alias}.pp_nomod, ${alias}.pp)` : `${alias}.pp`;
}

/**
 * The score column, on whichever of osu!'s scales the profile is reading.
 *
 * Rows tracked before both scales were stored have neither, and fall back to the number the
 * replay itself carried -- stable's own score for a stable play, the standardised one for a
 * lazer play, which is what this app showed before. Settings' recalculation fills them in.
 */
export function scoreColumn(e: Eligibility, alias = 's'): string {
  const osuScale = e.scoring === 'classic' ? 'score_classic' : 'score_standard';
  return `COALESCE(${alias}.${osuScale}, ${alias}.total_score)`;
}

/** The matching star rating, so a stripped-pp play does not show its as-played difficulty. */
export function starsColumn(e: Eligibility, alias = 's'): string {
  return e.preferStrippedPp ? `COALESCE(${alias}.stars_nomod, ${alias}.stars)` : `${alias}.stars`;
}

/**
 * Whether the beatmap allows pp.
 *
 * Rows ingested before `map_status` existed have NULL there; for those the old `ranked`
 * column is the only evidence available, so it stands in. `/api/recompute` replaces the
 * guess with the real status.
 */
function mapSql(e: Eligibility, alias: string): string {
  // Numbers from a closed set -- osu!'s own enum plus the unresolved sentinel -- so there
  // is nothing here to parameterise.
  const allowed = [...RANKED_STATUSES, ...e.extraMapStatuses].join(', ');
  return `(${alias}.map_status IN (${allowed})
           OR (${alias}.map_status IS NULL AND ${alias}.ranked = 1))`;
}

/** Whether the mod combination allows pp, under these settings. */
function modsSql(e: Eligibility, alias: string): string {
  const official = `COALESCE(${alias}.mods_ranked, ${alias}.ranked) = 1`;
  if (!e.includeUnrankedMods) return `(${official})`;
  // Autoplay and Cinema are excluded even here: they are not plays. Legacy rows have no
  // mods_countable, and a score old enough to predate the column is not an autoplay.
  return `(${official} OR COALESCE(${alias}.mods_countable, 1) = 1)`;
}

/**
 * The full `WHERE` fragment for "this score counts toward pp": a passed score, on a map and
 * with mods these settings allow, that actually has a pp value.
 *
 * Returned without a leading `AND` so callers read as `WHERE ... AND ${countsSql(e)}`.
 */
export function countsSql(e: Eligibility, alias = 's'): string {
  return `(${visibleSql(alias)}
           AND ${alias}.passed = 1
           AND ${mapSql(e, alias)}
           AND ${modsSql(e, alias)}
           AND ${ppColumn(e, alias)} IS NOT NULL)`;
}
