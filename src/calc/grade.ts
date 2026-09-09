import type { LazerMod, ReplayScore, Ruleset } from '../osr.ts';

export type Grade = 'XH' | 'X' | 'SH' | 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * What each judgement is worth, from osu!lazer's `Judgement.ToNumericResult`.
 *
 * lazer judges things stable never did -- slider tails, slider ticks -- and counts them
 * toward accuracy. Ignoring them understates accuracy: a play that lazer calls 90.81%
 * comes out as 89.11% on the legacy 300/100/50 formula.
 *
 * Judgements worth nothing (`ignore_hit`, bonuses) are listed explicitly so that an
 * unrecognised key is visibly absent rather than silently treated as zero.
 */
const HIT_VALUES: Readonly<Record<string, number>> = {
  perfect: 350,
  great: 300,
  good: 200,
  ok: 100,
  meh: 50,
  miss: 0,
  slider_tail_hit: 150,
  slider_tail_miss: 0,
  large_tick_hit: 30,
  large_tick_miss: 0,
  small_tick_hit: 10,
  small_tick_miss: 0,
  ignore_hit: 0,
  ignore_miss: 0,
  combo_break: 0,
  large_bonus: 0,
  small_bonus: 0,
};

function weighJudgements(stats: Record<string, number>): { total: number; unknown: string[] } {
  let total = 0;
  const unknown: string[] = [];
  for (const [key, count] of Object.entries(stats)) {
    const value = HIT_VALUES[key];
    if (value === undefined) unknown.push(key);
    else total += value * count;
  }
  return { total, unknown };
}

/**
 * lazer's accuracy: the judgements you earned over the best you could have earned.
 * Returns null when the replay has no extended block (osu!stable), or when it uses a
 * judgement we do not recognise -- guessing there would silently produce a wrong number.
 */
export function lazerAccuracy(score: ReplayScore): number | null {
  const stats = score.extras?.statistics;
  const max = score.extras?.maximum_statistics;
  if (!stats || !max) return null;

  const achieved = weighJudgements(stats);
  const possible = weighJudgements(max);
  if (achieved.unknown.length > 0 || possible.unknown.length > 0) return null;
  if (possible.total <= 0) return null;

  return Math.min(1, achieved.total / possible.total);
}

/** Accuracy as a 0..1 fraction. Prefers lazer's own weighting when the score has it. */
export function accuracy(score: ReplayScore, mode: Ruleset): number {
  const lazer = lazerAccuracy(score);
  if (lazer !== null) return lazer;

  return legacyAccuracy(score, mode);
}

/** The osu!stable formula, used for stable replays and as a fallback. */
export function legacyAccuracy(score: ReplayScore, mode: Ruleset): number {
  const { count300: c300, count100: c100, count50: c50, countGeki: geki, countKatu: katu, countMiss: miss } = score;

  switch (mode) {
    case 0: {
      const total = c300 + c100 + c50 + miss;
      return total === 0 ? 0 : (300 * c300 + 100 * c100 + 50 * c50) / (300 * total);
    }
    case 1: {
      const total = c300 + c100 + miss;
      return total === 0 ? 0 : (c300 + 0.5 * c100) / total;
    }
    case 2: {
      const caught = c300 + c100 + c50;
      const total = caught + miss + katu;
      return total === 0 ? 0 : caught / total;
    }
    case 3: {
      const total = geki + c300 + katu + c100 + c50 + miss;
      return total === 0
        ? 0
        : (300 * (geki + c300) + 200 * katu + 100 * c100 + 50 * c50) / (300 * total);
    }
  }
}

function silver(mods: LazerMod[]): boolean {
  return mods.some((m) => m.acronym === 'HD' || m.acronym === 'FL');
}

/**
 * Derive the letter grade. lazer reports this directly in its extended block, so this is
 * only needed for osu!stable replays.
 */
export function computeGrade(score: ReplayScore, mode: Ruleset, mods: LazerMod[]): Grade {
  if (!passed(score)) return 'F';

  const acc = accuracy(score, mode);
  const hi = silver(mods);

  if (mode === 0) {
    const total = score.count300 + score.count100 + score.count50 + score.countMiss;
    if (total === 0) return 'D';
    const r300 = score.count300 / total;
    const r50 = score.count50 / total;
    if (r300 === 1) return hi ? 'XH' : 'X';
    if (r300 > 0.9 && r50 < 0.01 && score.countMiss === 0) return hi ? 'SH' : 'S';
    if ((r300 > 0.8 && score.countMiss === 0) || r300 > 0.9) return 'A';
    if ((r300 > 0.7 && score.countMiss === 0) || r300 > 0.8) return 'B';
    if (r300 > 0.6) return 'C';
    return 'D';
  }

  // taiko / catch / mania are graded on accuracy alone.
  if (acc === 1) return hi ? 'XH' : 'X';
  if (acc > 0.95) return hi ? 'SH' : 'S';
  if (acc > 0.9) return 'A';
  if (acc > 0.8) return 'B';
  if (acc > 0.7) return 'C';
  return 'D';
}

/**
 * Whether the play was completed. lazer's extended block is authoritative here: its legacy
 * header reports rank "F" even for plays that actually ranked A.
 */
export function passed(score: ReplayScore): boolean {
  const rank = score.extras?.rank;
  if (rank) return rank !== 'F';
  // osu!stable only ever writes a replay for a play that was completed.
  return true;
}

export function gradeOf(score: ReplayScore, mode: Ruleset, mods: LazerMod[]): Grade {
  const reported = score.extras?.rank;
  if (reported && isGrade(reported)) return reported;
  return computeGrade(score, mode, mods);
}

function isGrade(v: string): v is Grade {
  return ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D', 'F'].includes(v);
}
