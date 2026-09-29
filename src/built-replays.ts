import type { OsuWebScore } from './clients/osu-web.ts';
import { encodeLegacyMods } from './calc/pp.ts';
import { legacyCounts } from './tracker/online-import.ts';
import { appBlock, encodeReplay, lazerBlock, readAppBlock, type LegacyCounts } from './replay-writer.ts';
import { BUILT_REPLAY_VERSION } from './clients/mcosu.ts';
import type { Ruleset } from './osr.ts';

/**
 * Replays this app builds for a score that has none: one imported from its osu! link, and one
 * entered by hand.
 *
 * **Why build a replay at all.** osu!'s calculator is handed a replay file and nothing else, and
 * everything it prices from is what a replay's header and lazer's block hold -- judgements,
 * combo, mods, and for a stable play the total osu!stable recorded. Where a slider broke, or
 * any cursor data, never enters pp; osu! estimates slider breaks from the combo whether or not a
 * replay exists. So a replay built from osu!'s own record of a score gives osu!'s calculator
 * exactly what the real one would, and from then on the score is a replay like any other: priced
 * here, repriced here after a pp rework, offline, by the same calculator as every other score.
 * McOsu's plays have been built the same way from the start (src/clients/mcosu.ts).
 *
 * - **From a link** (`buildLinkedReplay`): a stable score is built as a stable replay, carrying
 *   its legacy id and osu!stable's own total; a lazer score as a lazer replay, carrying its full
 *   statistics, mods and settings in lazer's own block.
 * - **By hand** (`buildManualReplay`): always a stable replay, of the judgements typed in -- the
 *   counts osu!stable shows on its results screen -- priced without a total unless one was given.
 *
 * Either way a block of this app's own (`BUILT_BLOCK`) goes last, saying which it was. That is
 * what marks a typed-in score "Manually entered by hand" wherever it is shown, keeps it out
 * of Download Replay -- there is no cursor data to download -- and tells the pricing whether the
 * header's total is osu!stable's own.
 */

export const BUILT_BLOCK = 'osu-local-profiles:built';

/** A lazer version, from when lazer's block carried everything read here. */
const LAZER_BUILT_VERSION = 30000017;

export type BuiltOrigin = 'link' | 'manual';

export interface BuiltFacts {
  origin: BuiltOrigin;
  /** Whether the header's total is the one osu!stable recorded, which stable pricing reads. */
  legacyTotal: boolean;
}

export function readBuiltBlock(rest: Buffer): BuiltFacts | null {
  const raw = readAppBlock(rest, BUILT_BLOCK) as Partial<BuiltFacts> | null;
  if (raw === null || (raw.origin !== 'link' && raw.origin !== 'manual')) return null;
  return { origin: raw.origin, legacyTotal: raw.legacyTotal === true };
}

/** Who set a score, as osu!'s page for it says. */
export interface LinkedPlayer {
  id: number | null;
  name: string;
}

/** The replay for a score imported from its osu! link. Null for a stable score whose mods have no stable bits. */
export function buildLinkedReplay(score: OsuWebScore, player: LinkedPlayer): Buffer | null {
  const counts = legacyCounts(score.statistics, score.mode);
  const base = {
    mode: score.mode,
    beatmapMD5: score.beatmapMD5,
    player: player.name,
    replayMD5: null,
    counts,
    maxCombo: score.maxCombo,
    perfect: score.legacyPerfect,
    playedAt: score.playedAt,
  };

  if (score.legacyScoreId !== null) {
    // Set on osu!stable: a stable replay, as osu!stable itself would have written it.
    const legacyMods = encodeLegacyMods(score.mods);
    if (legacyMods === null) return null;
    const total = score.legacyTotalScore ?? 0;
    return encodeReplay(
      {
        ...base,
        version: BUILT_REPLAY_VERSION,
        totalScore: total,
        legacyMods,
        onlineId: BigInt(score.legacyScoreId),
      },
      [appBlock(BUILT_BLOCK, { origin: 'link', legacyTotal: total > 0 } satisfies BuiltFacts)],
    );
  }

  // Set on lazer: its own block carries the statistics, mods and settings osu! prices from.
  return encodeReplay(
    {
      ...base,
      version: LAZER_BUILT_VERSION,
      totalScore: score.totalScore,
      legacyMods: 0,
      onlineId: BigInt(score.id),
    },
    [
      lazerBlock({
        online_id: Number(score.id),
        mods: score.mods,
        statistics: score.statistics,
        maximum_statistics: score.maximumStatistics,
        rank: score.grade,
        user_id: player.id ?? undefined,
      }),
      appBlock(BUILT_BLOCK, { origin: 'link', legacyTotal: false } satisfies BuiltFacts),
    ],
  );
}

/** A score typed in by hand, as osu!stable's results screen shows one. */
export interface ManualEntry {
  mode: Ruleset;
  beatmapMD5: string;
  player: string;
  counts: LegacyCounts;
  maxCombo: number;
  legacyMods: number;
  /** The score shown on the results screen, when it was typed in; stable pricing reads it. */
  totalScore: number | null;
  playedAt: number;
}

export function buildManualReplay(entry: ManualEntry): Buffer {
  return encodeReplay(
    {
      mode: entry.mode,
      version: BUILT_REPLAY_VERSION,
      beatmapMD5: entry.beatmapMD5,
      player: entry.player,
      replayMD5: null,
      counts: entry.counts,
      totalScore: entry.totalScore ?? 0,
      maxCombo: entry.maxCombo,
      perfect: false,
      legacyMods: entry.legacyMods,
      playedAt: entry.playedAt,
      onlineId: 0n,
    },
    [appBlock(BUILT_BLOCK, { origin: 'manual', legacyTotal: entry.totalScore !== null } satisfies BuiltFacts)],
  );
}
