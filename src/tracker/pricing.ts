import type { LazerMod, ReplayScore } from '../osr.ts';
import { awardsPp, UNRESOLVED_STATUS, type ResolvedBeatmap } from '../clients/beatmaps.ts';
import {
  calculateScorePp,
  modsCountable,
  modsLabel,
  rankedByOsu,
  strippableMods,
  type Pricing,
  type PpResult,
} from '../calc/pp.ts';
import type { OfficialCalculator } from '../calc/official.ts';

/**
 * What pricing a replay puts on its score, defined once for the two places that do it: a play
 * being tracked (src/tracker/ingest.ts) and a stored one recalculated (src/tracker/recompute.ts).
 *
 * They used to build these columns separately, and nothing kept the two in step -- the kind of
 * drift the project has been bitten by before, when two columns joined recompute's UPDATE
 * without their values and it silently wrote nothing.
 */

/** A replay priced as it was played, by osu!'s own calculator. Null with no beatmap file. */
export async function priceAsPlayed(
  replayPath: string,
  beatmap: ResolvedBeatmap,
  official: OfficialCalculator | null,
  pricing: Pricing,
): Promise<PpResult | null> {
  return beatmap.osuPath
    ? await calculateScorePp(replayPath, beatmap.osuPath, official, undefined, pricing)
    : null;
}

/**
 * The rest: the pp with Relax or Autopilot taken off, when the play carries one, and whether
 * osu! ranks its mods at all. Kept apart from `priceAsPlayed` because ingest asks for them only
 * once the play tracking filter has let the play through -- a play it turns away costs no
 * round trip to the calculator.
 */
export async function priceTheRest(
  score: ReplayScore,
  replayPath: string,
  beatmap: ResolvedBeatmap,
  mods: LazerMod[],
  official: OfficialCalculator | null,
  pricing: Pricing,
): Promise<{ stripped: PpResult | null; modsRanked: boolean | null }> {
  const strippable = strippableMods(mods);
  const stripped =
    strippable.length > 0 && beatmap.osuPath
      ? await calculateScorePp(replayPath, beatmap.osuPath, official, strippable, pricing)
      : null;
  return { stripped, modsRanked: await rankedByOsu(score, official, beatmap.osuPath) };
}

/** The columns of `scores` that pricing a replay decides. */
export interface PricedColumns {
  mods_json: string;
  mods_label: string;
  stars: number | null;
  pp: number | null;
  pp_source: 'official' | null;
  score_standard: number | null;
  score_classic: number | null;
  pp_nomod: number | null;
  stars_nomod: number | null;
  beatmap_max_combo: number | null;
  map_status: number;
  mods_ranked: 0 | 1 | null;
  mods_ranked_by: string | null;
  mods_countable: 0 | 1;
  ranked: 0 | 1;
  beatmap_id: number | null;
  pp_parts: string | null;
  pp_nomod_parts: string | null;
  pp_version: string | null;
}

/**
 * The columns only a beatmap file can produce. A score whose `.osu` is gone keeps these as
 * they were when it is recalculated, rather than having them wiped.
 */
export const BEATMAP_PRICED: ReadonlySet<keyof PricedColumns> = new Set([
  'stars', 'pp', 'pp_source', 'score_standard', 'score_classic', 'pp_nomod', 'stars_nomod',
  'beatmap_max_combo', 'pp_parts', 'pp_nomod_parts', 'pp_version',
]);

export function pricedColumns(p: {
  mods: LazerMod[];
  beatmap: ResolvedBeatmap;
  computed: PpResult | null;
  stripped: PpResult | null;
  modsRanked: boolean | null;
  /** The osu! release asked whether the mods are ranked. */
  calculatorVersion: string | null;
}): PricedColumns {
  const { mods, beatmap, computed, stripped, modsRanked } = p;
  return {
    mods_json: JSON.stringify(mods),
    mods_label: modsLabel(mods),
    stars: computed?.stars ?? null,
    pp: computed?.pp ?? null,
    pp_source: computed ? 'official' : null,
    // osu!'s own two scales, so the profile can be read on either without a recalculation.
    score_standard: computed?.standardisedScore ?? null,
    score_classic: computed?.classicScore ?? null,
    pp_nomod: stripped?.pp ?? null,
    stars_nomod: stripped?.stars ?? null,
    beatmap_max_combo: computed?.maxCombo ?? null,
    map_status: beatmap.status ?? UNRESOLVED_STATUS,
    mods_ranked: modsRanked === null ? null : modsRanked ? 1 : 0,
    mods_ranked_by: modsRanked === null ? null : (p.calculatorVersion ?? 'unknown'),
    mods_countable: modsCountable(mods) ? 1 : 0,
    // What osu! itself would say: the map and the mods both allow pp. Mods osu! could not be
    // asked about are not ranked until a recalculation asks again.
    ranked: awardsPp(beatmap.status) && modsRanked === true ? 1 : 0,
    beatmap_id: beatmap.beatmapId,
    pp_parts: computed ? JSON.stringify(computed.breakdown) : null,
    pp_nomod_parts: stripped ? JSON.stringify(stripped.breakdown) : null,
    pp_version: computed?.version ?? null,
  };
}
