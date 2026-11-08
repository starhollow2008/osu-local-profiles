import type { Db } from './db/index.ts';

/**
 * The one-time note that star ratings left the score rows.
 *
 * Every version before `starRating` (src/config.ts) showed a star rating beside each
 * difficulty, so an install that already had a database is told, once, that they are hidden now
 * and where to turn them back on. A brand-new install never saw them and is never told.
 *
 * Decided once per database and kept in `kv`: `pending` until the note is closed or the setting
 * is changed, then `done` for good.
 */
const KEY = 'starRatingNotice';

/** Called at every start, before anything reads it. Only the first call for a database decides. */
export function seedStarRatingNotice(db: Db, firstRun: boolean): void {
  db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(KEY, firstRun ? 'done' : 'pending');
}

export function starRatingNoticePending(db: Db): boolean {
  return db.prepare('SELECT 1 AS hit FROM kv WHERE key = ? AND value = ?').get(KEY, 'pending') !== undefined;
}

export function dismissStarRatingNotice(db: Db): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    KEY,
    'done',
  );
}
