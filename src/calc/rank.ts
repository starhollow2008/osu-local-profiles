import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ruleset } from '../osr.ts';

/**
 * Estimating what global rank this profile's pp would put it at.
 *
 * osu!'s rankings API only exposes the top 10,000, which never covers a fresh profile, so
 * the answer comes from a curve built offline from a data.ppy.sh random sample of the
 * whole ladder -- see `scripts/build-rank-table.mjs`. That keeps rank working with no
 * credentials and no network, like everything else here.
 *
 * It is an *estimate* and is labelled as one. Two things make it approximate: the curve is
 * a sample rather than the full ladder, and it ages, because ranks drift as the playerbase
 * plays on. A stale curve is a slowly-worsening approximation rather than a wrong number,
 * which is why this is allowed to exist where a second pp calculator is not: pp values are
 * ranked against each other, whereas rank is a single derived readout.
 */

const MODE_FILES: Record<Ruleset, string> = { 0: 'osu', 1: 'taiko', 2: 'catch', 3: 'mania' };

const tableDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rank-tables');

export interface RankTable {
  mode: string;
  /** The data.ppy.sh dump this was built from, e.g. "2026_09_01". */
  dump: string;
  source: string;
  sampled: number;
  generatedAt: string;
  /** [pp, global rank], ascending by pp. */
  points: [number, number][];
}

const cache = new Map<Ruleset, RankTable | null>();

/** The curve for a mode, or null when no table has been built for it. */
export function rankTable(mode: Ruleset): RankTable | null {
  const cached = cache.get(mode);
  if (cached !== undefined) return cached;

  let table: RankTable | null = null;
  try {
    const raw = fs.readFileSync(path.join(tableDir, `${MODE_FILES[mode]}.json`), 'utf8');
    const parsed = JSON.parse(raw) as RankTable;
    if (Array.isArray(parsed.points) && parsed.points.length >= 2) table = parsed;
  } catch {
    /* no table for this mode; rank is simply unavailable */
  }

  cache.set(mode, table);
  return table;
}

export interface RankEstimate {
  rank: number;
  /** The dump the curve came from, so the UI can say how old the answer is. */
  dump: string;
}

/**
 * Interpolate a global rank for `pp`.
 *
 * Interpolation is linear in log(rank), because rank spans six orders of magnitude across
 * the ladder while pp spans three -- interpolating rank directly would badly distort the
 * long tail where a fresh profile actually sits.
 */
export function estimateRank(pp: number, mode: Ruleset): RankEstimate | null {
  const table = rankTable(mode);
  if (!table) return null;
  const rank = interpolateRank(table.points, pp);
  return rank === null ? null : { rank, dump: table.dump };
}

/** The curve lookup itself, separated from where the curve is stored. */
export function interpolateRank(points: [number, number][], pp: number): number | null {
  // A profile with no pp is not on the ladder at all, which is what osu! shows too.
  if (!Number.isFinite(pp) || pp <= 0) return null;
  if (points.length < 2) return null;

  const first = points[0]!;
  const last = points[points.length - 1]!;

  if (pp <= first[0]) return first[1];
  if (pp >= last[0]) return last[1];

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= pp) lo = mid;
    else hi = mid;
  }

  const [ppLo, rankLo] = points[lo]!;
  const [ppHi, rankHi] = points[hi]!;
  const span = ppHi - ppLo;
  const t = span > 0 ? (pp - ppLo) / span : 0;
  const rank = Math.exp(Math.log(rankLo) + t * (Math.log(rankHi) - Math.log(rankLo)));

  return Math.max(1, Math.round(rank));
}
