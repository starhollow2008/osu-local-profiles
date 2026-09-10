import type { Db } from './db/index.ts';

/**
 * What the user can do to an individual tracked score: pin it, order the pins, and remove
 * it from the profile.
 *
 * **Removing is a hide, not a `DELETE`.** The replay is still in osu!'s file store, so a
 * deleted row would be re-ingested the next time that file was noticed -- and worse,
 * `dedupe_key` would no longer suppress it, so the score would come back as if it were new.
 * Keeping the row with `hidden_at` set means the removal sticks, costs nothing, and can be
 * undone. Every query filters on it at the source; see `visibleSql` in calc/eligibility.ts.
 *
 * Pins are per mode, as on osu!, and a pinned score does not have to be in the top 100 --
 * pinning is how you show a play you are proud of that pp does not reward.
 */

export type ScoreAction = 'pin' | 'unpin' | 'hide' | 'restore';

/** Confirm the score belongs to this profile before touching it. */
function ownedScore(db: Db, profileId: number, id: number): { id: number; mode: number } {
  const row = db
    .prepare('SELECT id, mode FROM scores WHERE id = ? AND profile_id = ?')
    .get(id, profileId) as { id: number; mode: number } | undefined;
  if (!row) throw new Error(`no score ${id} on this profile`);
  return row;
}

export function applyScoreAction(db: Db, profileId: number, id: number, action: ScoreAction): void {
  const score = ownedScore(db, profileId, id);
  const now = Date.now();

  switch (action) {
    case 'pin': {
      // New pins go to the end of the user's ordering rather than jumping to the top.
      const last = db
        .prepare(
          `SELECT COALESCE(MAX(pin_order), -1) AS last FROM scores
            WHERE profile_id = ? AND mode = ? AND pinned_at IS NOT NULL`,
        )
        .get(profileId, score.mode) as { last: number };
      db.prepare('UPDATE scores SET pinned_at = ?, pin_order = ? WHERE id = ?').run(
        now,
        last.last + 1,
        id,
      );
      return;
    }

    case 'unpin':
      db.prepare('UPDATE scores SET pinned_at = NULL, pin_order = NULL WHERE id = ?').run(id);
      return;

    case 'hide':
      // A removed score must not stay pinned: it would leave a gap in the pinned list that
      // nothing on screen could explain.
      db.prepare(
        'UPDATE scores SET hidden_at = ?, pinned_at = NULL, pin_order = NULL WHERE id = ?',
      ).run(now, id);
      return;

    case 'restore':
      db.prepare('UPDATE scores SET hidden_at = NULL WHERE id = ?').run(id);
      return;

    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
}

/**
 * Set the pin order from a list of score ids, first to last.
 *
 * Ids not in the list keep their pins but are pushed after the ones that are, so a stale
 * page reordering three of four pins cannot silently unpin the fourth.
 */
export function reorderPins(db: Db, profileId: number, ids: number[]): void {
  const unique = [...new Set(ids.map(Number).filter(Number.isInteger))];

  db.exec('BEGIN');
  try {
    const update = db.prepare(
      'UPDATE scores SET pin_order = ? WHERE id = ? AND profile_id = ? AND pinned_at IS NOT NULL',
    );
    unique.forEach((id, index) => update.run(index, id, profileId));
    // Anything the caller did not mention goes after them, keeping its relative order.
    db.prepare(
      `UPDATE scores SET pin_order = ? + pin_order
        WHERE profile_id = ? AND pinned_at IS NOT NULL
          AND id NOT IN (${unique.map(() => '?').join(',') || 'NULL'})`,
    ).run(unique.length, profileId, ...unique);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface HiddenScore {
  id: number;
  mode: number;
  title: string;
  version: string | null;
  modsLabel: string;
  accuracy: number;
  grade: string;
  pp: number | null;
  playedAt: number;
  hiddenAt: number;
}

/**
 * Scores removed from the profile, newest removal first, so they can be put back.
 *
 * Without this a removal is indistinguishable from data loss: the score is gone from every
 * section, and nothing on the page would ever mention it again.
 */
export function hiddenScores(db: Db, profileId: number, limit = 200): HiddenScore[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.mode, s.mods_label, s.accuracy, s.grade, s.pp, s.played_at, s.hidden_at,
              b.artist, b.title, b.version
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.hidden_at IS NOT NULL
        ORDER BY s.hidden_at DESC
        LIMIT ?`,
    )
    .all(profileId, limit) as Record<string, string | number | null>[];

  return rows.map((r) => ({
    id: r['id'] as number,
    mode: r['mode'] as number,
    title:
      [r['artist'], r['title']].filter(Boolean).join(' - ') || `beatmap ${String(r['id'])}`,
    version: (r['version'] as string | null) ?? null,
    modsLabel: r['mods_label'] as string,
    accuracy: r['accuracy'] as number,
    grade: r['grade'] as string,
    pp: (r['pp'] as number | null) ?? null,
    playedAt: r['played_at'] as number,
    hiddenAt: r['hidden_at'] as number,
  }));
}

export function hiddenCount(db: Db, profileId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM scores WHERE profile_id = ? AND hidden_at IS NOT NULL')
    .get(profileId) as { n: number };
  return row.n;
}
