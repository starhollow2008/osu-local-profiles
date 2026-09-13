import type { Db } from './db/index.ts';

/**
 * The one-time welcome: a brand-new install's page offers, once, to copy an avatar, banner,
 * flag, me! and favorites from an osu! account.
 *
 * Offered only when the database is created, so an install upgraded from a version without
 * the welcome never sees it -- those users have long since found Options -> Import from osu!.
 * Kept in `kv` rather than in a profile's settings, because it is about the install: a second
 * profile made later is not a new user.
 *
 * Every way out of it ends it, so there is no "remind me later". The page asks nothing of
 * osu.ppy.sh until a button in the dialog is pressed, welcome or not.
 */

const WELCOME_KEY = 'welcomePending';

/** Called when the database has just been created. */
export function offerWelcome(db: Db): void {
  db.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run(WELCOME_KEY, '1');
}

export function welcomePending(db: Db): boolean {
  return db.prepare('SELECT 1 AS hit FROM kv WHERE key = ?').get(WELCOME_KEY) !== undefined;
}

/** Closed, skipped or used: either way, never offered again. */
export function dismissWelcome(db: Db): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(WELCOME_KEY);
}
