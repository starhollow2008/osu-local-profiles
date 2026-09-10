import type { Db } from './db/index.ts';

/**
 * Several tracked playstyles in one install: "left hand", "mouse only", "tablet again".
 *
 * Each is a separate profile with its own scores, pp, level and start date. The schema has
 * always supported this -- `scores.profile_id` -- so this is mostly about choosing which
 * one is live and letting the page manage the set.
 *
 * The active profile is kept in `kv` rather than in config.json, because it is app state
 * rather than a user setting: renaming a profile should not orphan the selection, and
 * editing config.json by hand should not be able to point at a profile that is not there.
 */

const ACTIVE_KEY = 'activeProfileId';

export interface Profile {
  id: number;
  name: string;
  createdAt: number;
  /** Scores older than this are never accepted; moving it forward is what "fresh" means. */
  trackingSince: number;
  scoreCount: number;
  active: boolean;
}

export function listProfiles(db: Db): Profile[] {
  const active = activeProfileId(db);
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.tracking_since,
              ((SELECT COUNT(*) FROM scores s WHERE s.profile_id = p.id)
               + (SELECT COUNT(*) FROM incomplete_plays i WHERE i.profile_id = p.id))
                AS score_count
         FROM profiles p
        ORDER BY p.created_at ASC`,
    )
    .all() as {
    id: number;
    name: string;
    created_at: number;
    tracking_since: number;
    score_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    trackingSince: r.tracking_since,
    scoreCount: r.score_count,
    active: r.id === active,
  }));
}

export function getProfile(db: Db, id: number): Profile | null {
  return listProfiles(db).find((p) => p.id === id) ?? null;
}

/**
 * The profile currently being tracked.
 *
 * Falls back to the oldest profile when the stored id is missing or points at a profile
 * that has since been deleted, so the app always has somewhere to write.
 */
export function activeProfileId(db: Db): number {
  const stored = db.prepare('SELECT value FROM kv WHERE key = ?').get(ACTIVE_KEY) as
    | { value: string }
    | undefined;

  if (stored) {
    const id = Number(stored.value);
    const exists = db.prepare('SELECT 1 AS hit FROM profiles WHERE id = ?').get(id);
    if (exists) return id;
  }

  const first = db.prepare('SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (!first) throw new Error('no profiles exist');

  setActiveProfile(db, first.id);
  return first.id;
}

export function setActiveProfile(db: Db, id: number): void {
  const exists = db.prepare('SELECT 1 AS hit FROM profiles WHERE id = ?').get(id);
  if (!exists) throw new Error(`no profile with id ${id}`);
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(
    ACTIVE_KEY,
    String(id),
    String(id),
  );
}

function cleanName(name: unknown): string {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length === 0) throw new Error('a profile needs a name');
  if (trimmed.length > 60) throw new Error('that name is too long (60 characters max)');
  return trimmed;
}

/** A new profile starts empty and tracks from now, never from earlier plays. */
export function createProfile(db: Db, name: unknown): Profile {
  const clean = cleanName(name);
  const clash = db.prepare('SELECT 1 AS hit FROM profiles WHERE name = ?').get(clean);
  if (clash) throw new Error(`a profile called "${clean}" already exists`);

  const now = Date.now();
  db.prepare(
    'INSERT INTO profiles (name, created_at, tracking_since, default_mode) VALUES (?, ?, ?, 0)',
  ).run(clean, now, now);

  const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return getProfile(db, id)!;
}

export function renameProfile(db: Db, id: number, name: unknown): Profile {
  const clean = cleanName(name);
  const clash = db.prepare('SELECT id FROM profiles WHERE name = ?').get(clean) as
    | { id: number }
    | undefined;
  if (clash && clash.id !== id) throw new Error(`a profile called "${clean}" already exists`);

  const changed = db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(clean, id);
  if (changed.changes === 0) throw new Error(`no profile with id ${id}`);
  return getProfile(db, id)!;
}

/**
 * Delete a profile and everything it tracked.
 *
 * The last profile cannot be deleted: the app must always have somewhere to put the next
 * score, and an empty profile list would leave it with nothing to fall back to.
 */
export function deleteProfile(db: Db, id: number): { deletedScores: number; nextActive: number } {
  const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number };
  if (count.n <= 1) throw new Error('this is the only profile -- reset it instead of deleting it');

  // Everything the profile has tracked, abandoned attempts included -- they are plays, and
  // the confirmation has to say how much is about to go.
  const scores = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ?)
            + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ?) AS n`,
    )
    .get(id, id) as { n: number };

  db.exec('BEGIN');
  try {
    // scores and snapshots are ON DELETE CASCADE, so they go with it.
    const changed = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    if (changed.changes === 0) throw new Error(`no profile with id ${id}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // activeProfileId repairs a dangling selection by falling back to the oldest profile.
  return { deletedScores: scores.n, nextActive: activeProfileId(db) };
}
