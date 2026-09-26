import { scoredAsStable, type LazerMod, type ReplayScore } from '../osr.ts';
import type { OfficialCalculator, PpPart } from './official.ts';
import { mcosuMods, readBaseDifficulty } from '../clients/mcosu.ts';

/** Each successive play in the top 100 is worth 5% less than the one above it. */
export const WEIGHT = 0.95;

/**
 * How many scores are weighted into pp.
 *
 * Here beside `WEIGHT` rather than with the profile totals, because it is half of the same
 * rule and an import has to borrow against it: what a profile cannot compute from osu!'s own
 * scores depends on how many of them it weighs. See `borrowedBonusPp`.
 */
export const TOP_PLAY_LIMIT = 100;

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
 * Did the player change any of this mod's settings? lazer only writes `settings` when they
 * did. This is *not* whether the mod is still ranked -- a changed speed unranks Double Time
 * but a changed pitch does not -- which only osu! can say (`rankedByOsu`).
 */
export function isCustomised(mod: LazerMod): boolean {
  return mod.settings !== undefined && Object.keys(mod.settings).length > 0;
}

/**
 * Would osu! itself rank a score set with these mods? Asked of osu!'s own mod classes through
 * the helper, because the answer differs by ruleset (Mirror is ranked only in mania, Hard Rock
 * everywhere but mania) and by setting, and osu! changes it between releases. A hand-kept
 * list here once missed Alternate, Single Tap, Traceable and the rest of lazer's newer ranked
 * mods, and counted Classic chosen on lazer, which osu! does not rank.
 *
 * Null when the helper cannot answer: unknown, which counts as unranked until a recompute.
 */
export async function rankedByOsu(
  score: ReplayScore,
  official: OfficialCalculator | null,
  osuPath: string | null = null,
): Promise<boolean | null> {
  if (!official) return null;
  // The same choice as scoreMods: a lazer replay's own mod list, else stable's bitmask, which
  // osu! converts itself, so the question never depends on this app's decoding. A McOsu
  // play is its mods as osu! would write them, a custom rate or McOsu's own MC included.
  const mods = score.mcosu ? scoreMods(score, osuPath) : score.extras?.mods;
  const result = await official.ranked(
    mods ? { ruleset: score.mode, mods } : { ruleset: score.mode, legacyMods: score.legacyMods },
  );
  return result?.ranked ?? null;
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
/**
 * osu!stable's mod bits, as osu! numbers them (`LegacyMods`), and lazer's acronym for each.
 *
 * All 31 of them. The first version stopped at Perfect (bit 14), which quietly dropped
 * ScoreV2, mania's key counts, Fade In, Random and Mirror: a stable ScoreV2 play was stored,
 * labelled and judged as a plain nomod one -- while osu!, asked about the raw bitmask, rightly
 * called it unranked, so it read as greyed out for no reason anyone could see.
 */
const LEGACY_MOD_BITS: readonly string[] = [
  'NF', 'EZ', 'TD', 'HD', 'HR', 'SD', 'DT', 'RX', 'HT', 'NC', 'FL', 'AT', 'SO', 'AP', 'PF',
  '4K', '5K', '6K', '7K', '8K', 'FI', 'RD', 'CN', 'TP', '9K', 'DS', '1K', '3K', '2K', 'SV2', 'MR',
];

/** Everything a bit can mean in every ruleset, so each one lists only what it does not have. */
const NOT_IN_RULESET: Readonly<Record<number, ReadonlySet<string>>> = {
  0: new Set(['4K', '5K', '6K', '7K', '8K', '9K', '1K', '2K', '3K', 'DS', 'FI', 'RD', 'MR']),
  1: new Set(['TD', 'SO', 'AP', 'TP', '4K', '5K', '6K', '7K', '8K', '9K', '1K', '2K', '3K', 'DS', 'FI', 'RD', 'MR']),
  2: new Set(['TD', 'SO', 'AP', 'TP', '4K', '5K', '6K', '7K', '8K', '9K', '1K', '2K', '3K', 'DS', 'FI', 'RD', 'MR']),
  3: new Set(['TD', 'RX', 'SO', 'AP', 'TP']),
};

/**
 * A stable bitmask as the mods osu! itself reads it for that ruleset: each ruleset's
 * `ConvertFromLegacyMods`, so a bit a ruleset has no mod for (Random outside mania, Relax in
 * it) is dropped exactly where osu! drops it. Kept in bit order, which is how every label
 * stored so far reads.
 */
export function decodeLegacyMods(bitmask: number, ruleset: number): LazerMod[] {
  const absent = NOT_IN_RULESET[ruleset] ?? NOT_IN_RULESET[0]!;
  const out: LazerMod[] = [];
  for (let i = 0; i < LEGACY_MOD_BITS.length; i++) {
    const acronym = LEGACY_MOD_BITS[i]!;
    if (bitmask & (1 << i) && !absent.has(acronym)) out.push({ acronym });
  }
  // NC implies DT, PF implies SD and CN implies AT in the bitmask; keep only the visible one.
  const acronyms = new Set(out.map((m) => m.acronym));
  return out.filter(
    (m) =>
      !(m.acronym === 'DT' && acronyms.has('NC')) &&
      !(m.acronym === 'SD' && acronyms.has('PF')) &&
      !(m.acronym === 'AT' && acronyms.has('CN')),
  );
}

/**
 * The mods actually in effect, preferring lazer's structured list (which carries settings).
 *
 * A McOsu play's are worked out from what McOsu recorded (`mcosuMods`), and telling an
 * override from the map's own values takes the map: `osuPath`, where there is one.
 */
export function scoreMods(score: ReplayScore, osuPath: string | null = null): LazerMod[] {
  if (score.mcosu) return mcosuModsFor(score, osuPath).mods;
  return score.extras?.mods ?? decodeLegacyMods(score.legacyMods, score.mode);
}

function mcosuModsFor(score: ReplayScore, osuPath: string | null) {
  return mcosuMods(score.legacyMods, score.mcosu!, osuPath ? readBaseDifficulty(osuPath) : null);
}

/** How osu!'s calculator is to price a replay, beyond decoding it. */
export interface Pricing {
  /** Mods to price with in place of the ones the replay decodes to. */
  mods?: LazerMod[];
  /** Price without the total osu!stable recorded; see the helper's `ignoreLegacyTotalScore`. */
  ignoreLegacyTotalScore?: boolean;
  /** osu!'s mods cannot say what was played, so there is no honest pp to ask for. */
  unpriceable?: boolean;
}

/**
 * Nothing for a replay osu! set: its own file says it all. A McOsu play's replay is one this
 * app built, and a speed or override its mod bits could not hold is priced from here.
 */
export function scorePricing(score: ReplayScore, osuPath: string | null): Pricing {
  if (!score.mcosu) return {};
  const derived = mcosuModsFor(score, osuPath);
  if (derived.priced === null) return { unpriceable: true };
  return { mods: derived.priced, ignoreLegacyTotalScore: derived.ignoreLegacyTotalScore };
}

/**
 * osu! scores every stable play with Classic on, and shows it that way.
 *
 * `LegacyScoreDecoder` adds CL to a legacy score's mods before the calculators ever see it
 * -- it is what selects classic slider accuracy and legacy miss estimation -- so osu!'s own
 * pages list a stable play as `HDDTCL`. This says the same thing on this page, for display
 * only: `mods_json` keeps what the player actually chose, which is what medals, play time
 * and eligibility read.
 */
export function withClassicMod(mods: LazerMod[], client: string): LazerMod[] {
  if (!scoredAsStable(client) || mods.some((m) => m.acronym === 'CL')) return mods;
  return [...mods, { acronym: 'CL' }];
}

export function modsLabel(mods: LazerMod[]): string {
  return mods.length === 0 ? 'None' : mods.map((m) => m.acronym).join('');
}

export interface PpResult {
  pp: number;
  /** osu!'s standardised score for this play (a nomod SS is 1,000,000). */
  standardisedScore: number | null;
  /**
   * The play on osu!'s classic scale: what osu!stable recorded when it set the play, and
   * osu!'s own classic conversion for a play set on lazer.
   */
  classicScore: number | null;
  stars: number;
  /** The beatmap's maximum achievable combo. */
  maxCombo: number;
  accuracy: number;
  rank: string;
  isLegacy: boolean;
  /** True when mods were removed before scoring, so this is not the play as it happened. */
  stripped: boolean;
  /** osu!'s own parts of `pp` (aim, speed, ...); empty from a helper that sends none. */
  breakdown: PpPart[];
  /** The osu! release that calculated it, or null if the helper did not say. */
  version: string | null;
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
  pricing: Pricing = {},
): Promise<PpResult | null> {
  if (!official || pricing.unpriceable) return null;

  const result = await official.calculate({
    replayPath,
    beatmapPath: osuPath,
    ...(stripMods && stripMods.length > 0 ? { stripMods } : {}),
    ...(pricing.mods ? { mods: pricing.mods } : {}),
    ...(pricing.ignoreLegacyTotalScore ? { ignoreLegacyTotalScore: true } : {}),
  });
  if (!result || result.pp === null) return null;

  return {
    pp: result.pp,
    // osu!'s own two scales for the same play; see PpResult.
    standardisedScore: result.standardisedScore,
    classicScore: result.legacyTotalScore ?? result.classicScore,
    stars: result.stars,
    maxCombo: result.maxCombo,
    accuracy: result.accuracy,
    rank: result.rank,
    isLegacy: result.isLegacy,
    stripped: result.stripped,
    breakdown: result.breakdown,
    version: official.version,
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
