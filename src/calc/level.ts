/**
 * osu! level, derived purely from total score.
 *
 *   score(n) = 5000/3 * (4n^3 - 3n^2 - n) + 1.25 * 1.8^(n-60)   for n <= 100
 *   score(n) = 26,931,190,827 + 99,999,999,999 * (n - 100)      for n >  100
 *
 * `score(n)` is the total score required to *reach* level n. The game rounds slightly
 * differently using a precomputed difference table, so values sitting right on a boundary
 * can be off by one; that is not worth reproducing.
 */

const MAX_TABLE_LEVEL = 200;

/** Total score required to reach `level`. */
export function requiredScore(level: number): number {
  if (level <= 1) return 0;
  if (level <= 100) {
    return (5000 / 3) * (4 * level ** 3 - 3 * level ** 2 - level) + 1.25 * 1.8 ** (level - 60);
  }
  return 26_931_190_827 + 99_999_999_999 * (level - 100);
}

const TABLE: number[] = (() => {
  const t = new Array<number>(MAX_TABLE_LEVEL + 2);
  for (let n = 0; n <= MAX_TABLE_LEVEL + 1; n++) t[n] = requiredScore(n);
  return t;
})();

export interface Level {
  current: number;
  /** Fraction of the way to the next level, 0..1. */
  progress: number;
}

export function levelFromScore(totalScore: number): Level {
  if (totalScore <= 0) return { current: 1, progress: 0 };

  // Binary search the largest level whose requirement we have met.
  let lo = 1;
  let hi = MAX_TABLE_LEVEL;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (TABLE[mid]! <= totalScore) lo = mid;
    else hi = mid - 1;
  }

  const base = TABLE[lo]!;
  const next = TABLE[lo + 1]!;
  const span = next - base;
  return {
    current: lo,
    progress: span > 0 ? Math.min(1, Math.max(0, (totalScore - base) / span)) : 0,
  };
}
