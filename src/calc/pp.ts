import type { LazerMod, ReplayScore } from '../osr.ts';
import type { OfficialCalculator } from './official.ts';

/** Each successive play in the top 100 is worth 5% less than the one above it. */
export const WEIGHT = 0.95;

/**
 * Mods that award pp *at their default settings*. Anything outside this set (Relax,
 * Autopilot, Autoplay, Difficulty Adjust and the lazer-only fun mods) makes a score
 * unranked in osu!.
 */
const RANKED_MODS = new Set([
  'NF', 'EZ', 'HD', 'HR', 'SD', 'PF', 'DT', 'NC', 'HT', 'DC', 'FL', 'SO', 'TD', 'MR', 'CL',
]);

/**
 * Mods whose removal leaves a score osu! can still be asked to price: the play's hit
 * statistics scored as if the mod had not been on. Relax at 1.5x DT becomes a DT score.
 *
 * Deliberately just these two. Stripping a mod only makes sense where the remaining mod set
 * describes a play someone could have made, and where the *reason* osu! refuses to rank it
 * is the assistance rather than the map or the score being meaningless.
 */
const STRIPPABLE_MODS = ['RX', 'AP'] as const;

/**
 * Mods that can never count toward a profile, however permissive the settings.
 *
 * Autoplay and Cinema are not plays -- the computer set them -- so including them would
 * make the whole profile meaningless rather than merely unofficial.
 */
const NEVER_COUNTABLE = new Set(['AT', 'CN']);

/**
 * lazer only writes `settings` when the player changed the mod from its defaults, which is
 * exactly the condition that unranks an otherwise-ranked mod (`Mod.Ranked` is
 * `UsesDefaultConfiguration` for the configurable ones). So the presence of any setting is
 * the signal -- DT at 1.45x, HT at 0.5x, HD with faded approach circles.
 */
export function isCustomised(mod: LazerMod): boolean {
  return mod.settings !== undefined && Object.keys(mod.settings).length > 0;
}

/** Would osu! itself rank a score set with these mods? */
export function modsAwardPp(mods: LazerMod[]): boolean {
  return mods.every((m) => RANKED_MODS.has(m.acronym) && !isCustomised(m));
}

/**
 * Could this mod combination count toward the profile if the user opts in? True for
 * everything except Autoplay and Cinema.
 */
export function modsCountable(mods: LazerMod[]): boolean {
  return mods.every((m) => !NEVER_COUNTABLE.has(m.acronym));
}

/**
 * Which of the strippable mods this score carries, in the order osu! lists them. Empty
 * means there is no second pp value worth calculating.
 */
export function strippableMods(mods: LazerMod[]): string[] {
  const present = new Set(mods.map((m) => m.acronym));
  return STRIPPABLE_MODS.filter((acronym) => present.has(acronym));
}

/** Legacy bitmask -> acronyms, for stable replays with no extended block. */
const LEGACY_MOD_BITS: readonly string[] = [
  'NF', 'EZ', 'TD', 'HD', 'HR', 'SD', 'DT', 'RX', 'HT', 'NC', 'FL', 'AT', 'SO', 'AP', 'PF',
];

export function decodeLegacyMods(bitmask: number): LazerMod[] {
  const out: LazerMod[] = [];
  for (let i = 0; i < LEGACY_MOD_BITS.length; i++) {
    if (bitmask & (1 << i)) out.push({ acronym: LEGACY_MOD_BITS[i]! });
  }
  // NC implies DT and PF implies SD in the bitmask; keep only the visible one.
  const acronyms = new Set(out.map((m) => m.acronym));
  return out.filter(
    (m) => !(m.acronym === 'DT' && acronyms.has('NC')) && !(m.acronym === 'SD' && acronyms.has('PF')),
  );
}

/** The mods actually in effect, preferring lazer's structured list (which carries settings). */
export function scoreMods(score: ReplayScore): LazerMod[] {
  return score.extras?.mods ?? decodeLegacyMods(score.legacyMods);
}

export function modsLabel(mods: LazerMod[]): string {
  return mods.length === 0 ? 'None' : mods.map((m) => m.acronym).join('');
}

export interface PpResult {
  pp: number;
  stars: number;
  /** The beatmap's maximum achievable combo. */
  maxCombo: number;
  accuracy: number;
  rank: string;
  isLegacy: boolean;
  /** True when mods were removed before scoring, so this is not the play as it happened. */
  stripped: boolean;
}

/**
 * Compute pp with osu!'s own calculator.
 *
 * This is the only pp path. There is deliberately no fallback implementation: a fallback
 * that disagrees by a few percent would leave a single profile holding scores calculated
 * two different ways, ranked against each other and weighted together, with nothing on
 * screen to say which was which. A missing pp value is recoverable -- `reingest.mjs`
 * recomputes everything from the replays -- whereas a silently wrong one is not.
 *
 * Works offline and for both clients: the helper reads local files only, and osu!'s
 * LegacyScoreDecoder handles osu!stable and osu!lazer replays alike.
 */
export async function calculateScorePp(
  replayPath: string,
  osuPath: string,
  official: OfficialCalculator | null,
  stripMods?: string[],
): Promise<PpResult | null> {
  if (!official) return null;

  const result = await official.calculate(
    stripMods && stripMods.length > 0
      ? { replayPath, beatmapPath: osuPath, stripMods }
      : { replayPath, beatmapPath: osuPath },
  );
  if (!result || result.pp === null) return null;

  return {
    pp: result.pp,
    stars: result.stars,
    maxCombo: result.maxCombo,
    accuracy: result.accuracy,
    rank: result.rank,
    isLegacy: result.isLegacy,
    stripped: result.stripped,
  };
}

/** Weighted sum of the top plays: pp[1]*0.95^0 + pp[2]*0.95^1 + ... */
export function weightedTotal(ppDescending: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < ppDescending.length; i++) total += ppDescending[i]! * WEIGHT ** i;
  return total;
}

/**
 * Bonus pp for breadth of play: 416.6667 * (1 - 0.995^min(N, 1000)), N being the number of
 * distinct ranked beatmaps with a score. Tops out at 413.894pp.
 */
export function bonusPp(distinctRankedBeatmaps: number): number {
  return 416.6667 * (1 - 0.995 ** Math.min(distinctRankedBeatmaps, 1000));
}

/** Profile accuracy uses the same 0.95 weighting as pp, over the same top plays. */
export function weightedAccuracy(accuraciesByPpDescending: readonly number[]): number {
  let weighted = 0;
  let divisor = 0;
  for (let i = 0; i < accuraciesByPpDescending.length; i++) {
    const w = WEIGHT ** i;
    weighted += accuraciesByPpDescending[i]! * w;
    divisor += w;
  }
  return divisor > 0 ? weighted / divisor : 0;
}
