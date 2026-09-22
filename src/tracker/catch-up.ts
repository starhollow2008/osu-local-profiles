import type { Db } from '../db/index.ts';

/**
 * When the app was last running, so a launch can offer to bring in what happened since.
 *
 * Roadmap 5.49 established the rule this works inside: live tracking never reaches back past
 * the launch, because closing the app is how somebody stops tracking. `importPlaysWhileClosed`
 * is that decision made once instead of every time -- and it is still an *import*, run through
 * `Tracker.backfill` with the same filter, the same duplicate checks and the same owner check
 * as Options -> Import past plays, rather than a widening of what live tracking accepts.
 *
 * ## Why the stamp is written at shutdown, and not continuously
 *
 * The gap is `[lastRunAt, now]`, so the stamp only has to be *no later* than the moment the
 * app stopped. Writing it every few seconds would be more precise and would cost the profile
 * cache on every tick -- `/api/profile` is stamped with SQLite's own change counter, so any
 * write throws it away (src/http/server.ts).
 *
 * Erring early is also the safe direction. A stamp left behind by a crash, or by a machine
 * losing power, is older than the true shutdown, so the next launch scans a little further
 * back than it needed to -- and everything in that overlap was already tracked, so dedupe
 * turns it away. The opposite error would silently lose plays.
 *
 * The heartbeat exists only for the person who never shuts the app down cleanly at all: half
 * an hour is short enough that the scan stays bounded, and long enough that the cache never
 * notices.
 */

const LAST_RUN_KEY = 'lastRunAt';

/** How often a long-running app writes the stamp anyway, in case it is never shut down. */
export const HEARTBEAT_MS = 30 * 60 * 1000;

/**
 * When the app last recorded that it was running, or null if it never has.
 *
 * Null is a first launch (or a database from before this existed), and means *no catch-up*:
 * there is no gap on record, and reaching back to some invented date would import an entire
 * replay store the user never asked for. The stamp written moments later makes the next
 * launch the first one that can catch up.
 */
export function lastRunAt(db: Db): number | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(LAST_RUN_KEY) as
    | { value: string }
    | undefined;
  const at = Number(row?.value);
  return Number.isFinite(at) && at > 0 ? at : null;
}

export function markRunning(db: Db, at: number = Date.now()): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(LAST_RUN_KEY, String(at));
}

/**
 * The cutoff a catch-up should import from, or null when there is nothing to catch up on.
 *
 * Never earlier than the profile's own start, so a profile created after the gap does not
 * absorb plays from before it existed -- the same guarantee `Tracker.liveCutoff` makes, since
 * a reset is exactly how somebody says "this profile starts now".
 */
export function catchUpSince(stamp: number | null, trackingSince: number, now = Date.now()): number | null {
  if (stamp === null) return null;
  const since = Math.max(stamp, trackingSince);
  return since < now ? since : null;
}
