import type { Db } from './db/index.ts';
import type { EarnedMedal } from './clients/osu-web.ts';

/**
 * The medals an osu! account already holds, borrowed by an import from osu!.
 *
 * A profile's medals are derived from its plays (src/calc/medals.ts), which is right for every
 * play this app has seen and blind to every one it has not. Someone who imports their osu!
 * account's best performances gets a 9-star pass medal from one of them, and not the 1- to
 * 8-star ones they earned years ago on maps osu! does not list among their best -- so an import
 * can copy osu!'s own record of them instead, as it copies the bonus pp (src/standing.ts).
 *
 * Only asked for, never by default, and only the medals this app awards: the caller filters
 * with `isAppMedal`, so a medal the page has no place for is never stored at all. Borrowed and
 * said so -- a medal's card says it came from osu! -- while plays here still earn medals as ever.
 */

/** Keep what osu! said this account holds, in place of whatever an earlier import said. */
export function saveImportedMedals(db: Db, profileId: number, medals: readonly EarnedMedal[]): number {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO imported_medals (profile_id, slug, achieved_at, imported_at) VALUES (?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM imported_medals WHERE profile_id = ?').run(profileId);
    for (const m of medals) insert.run(profileId, m.slug, m.achievedAt, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return (db.prepare('SELECT COUNT(*) AS n FROM imported_medals WHERE profile_id = ?').get(profileId) as { n: number }).n;
}

/** The medals borrowed from osu!, by slug, with when osu! awarded each. */
export function importedMedals(db: Db, profileId: number): Map<string, number> {
  const rows = db
    .prepare('SELECT slug, achieved_at FROM imported_medals WHERE profile_id = ?')
    .all(profileId) as { slug: string; achieved_at: number }[];
  return new Map(rows.map((r) => [r.slug, r.achieved_at]));
}

/** Forget them: a reset starts the profile from zero, borrowed medals included. */
export function clearImportedMedals(db: Db, profileId: number): void {
  db.prepare('DELETE FROM imported_medals WHERE profile_id = ?').run(profileId);
}
