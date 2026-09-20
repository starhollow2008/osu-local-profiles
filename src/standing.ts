import type { Db } from './db/index.ts';
import type { Ruleset } from './osr.ts';
import type { OsuWebStanding } from './clients/osu-web.ts';

/**
 * What osu! itself said a linked account stood at, kept so a profile can borrow one number
 * from it: the part of its total pp that imported scores cannot account for.
 *
 * osu! awards bonus pp for how many distinct ranked beatmaps an account has ever played --
 * thousands of them. An import brings 200 best performances, so a profile working its own
 * bonus out from those earns the bonus for 200 and lands hundreds of pp, and tens of
 * thousands of places, below the account it was copied from. osu!'s own total minus the
 * weighted sum this app computes from the very scores osu! handed over is that shortfall
 * exactly, so it is recorded rather than guessed at (`borrowedBonusPp`).
 *
 * It is borrowed, and the page says so wherever it is shown. `computeStats` takes whichever
 * bonus is larger -- this one, or the one the profile's own plays have earned -- so tracking
 * or importing a real play history supersedes it gradually, with nothing to clear and no
 * moment where the figure jumps backwards.
 *
 * A module of its own, beside the other things a profile owns, because both the importer
 * that writes it and the totals that read it need it, and neither should have to reach
 * through the other.
 */

/** Remember what osu! said this account stands at, for one ruleset. */
export function saveStanding(
  db: Db,
  profileId: number,
  mode: Ruleset,
  bonusPp: number,
  standing: OsuWebStanding,
): void {
  db.prepare(
    `INSERT INTO imported_standing
       (profile_id, mode, bonus_pp, osu_total_pp, osu_global_rank, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (profile_id, mode) DO UPDATE SET
       bonus_pp = excluded.bonus_pp,
       osu_total_pp = excluded.osu_total_pp,
       osu_global_rank = excluded.osu_global_rank,
       imported_at = excluded.imported_at`,
  ).run(profileId, mode, bonusPp, standing.totalPp, standing.globalRank, Date.now());
}

/** The borrowed figure for one mode, or null when nothing has been imported for it. */
export function importedBonusPp(db: Db, profileId: number, mode: Ruleset): number | null {
  const row = db
    .prepare('SELECT bonus_pp FROM imported_standing WHERE profile_id = ? AND mode = ?')
    .get(profileId, mode) as { bonus_pp: number } | undefined;
  return row ? row.bonus_pp : null;
}

/** What osu! reported for one mode, for the page to name what it is borrowing from. */
export function importedStanding(
  db: Db,
  profileId: number,
  mode: Ruleset,
): { bonusPp: number; osuTotalPp: number | null; osuGlobalRank: number | null; importedAt: number } | null {
  const row = db
    .prepare(
      `SELECT bonus_pp, osu_total_pp, osu_global_rank, imported_at
         FROM imported_standing WHERE profile_id = ? AND mode = ?`,
    )
    .get(profileId, mode) as
    | { bonus_pp: number; osu_total_pp: number | null; osu_global_rank: number | null; imported_at: number }
    | undefined;
  if (!row) return null;
  return {
    bonusPp: row.bonus_pp,
    osuTotalPp: row.osu_total_pp,
    osuGlobalRank: row.osu_global_rank,
    importedAt: row.imported_at,
  };
}

/**
 * Forget what was borrowed.
 *
 * A reset starts the profile from zero, and a borrowed total is one of the things that has
 * to go with it -- otherwise a cleared profile would still be priced against an account it
 * no longer holds a single score from.
 */
export function clearStanding(db: Db, profileId: number): void {
  db.prepare('DELETE FROM imported_standing WHERE profile_id = ?').run(profileId);
}
