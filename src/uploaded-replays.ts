import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db/index.ts';
import { looksLikeReplay } from './osr.ts';

/**
 * Replay files the user chose or dropped into Import past plays.
 *
 * Usually ones they downloaded -- from osu!'s website, a friend, an old backup -- that osu! no
 * longer has. The file they picked may be in Downloads, and gone next week, so a copy is kept in
 * the app's own `data/replays/`, where a score's `replay_path` can point at it for good: a
 * recalculation re-reads it, Download Replay serves it, and Back up everything carries it (see
 * src/backup.ts), because this copy may be the only one there is.
 *
 * Named by the MD5 of its bytes, so the same file uploaded twice is one file -- and then one
 * score, by the ordinary duplicate check.
 */

export const UPLOADED_DIR = 'replays';

/** Far above any real replay -- an hour of lazer frames is a few MB -- and a bound all the same. */
export const MAX_REPLAY_BYTES = 64 * 1024 * 1024;

/** A stored replay's path relative to `data/`, as a backup lists it. */
export const isUploadedReplay = (relative: string): boolean => /^replays\/[0-9a-f]{32}\.osr$/.test(relative);

/**
 * Keep a copy of an uploaded replay, or null when the bytes are not one. Only the first few
 * bytes are judged here; whether the whole file reads is the ingest's question, as for any
 * replay osu! wrote.
 */
export function storeUploadedReplay(dataDir: string, bytes: Buffer): string | null {
  if (!looksLikeReplay(bytes.subarray(0, 8))) return null;
  const dir = path.join(dataDir, UPLOADED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash('md5').update(bytes).digest('hex')}.osr`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return file;
}

/**
 * Remove a stored copy nothing points at: an upload that turned out to be a play already here
 * under osu!'s own file, or deleted for good, or not readable after all. One a score or a play
 * not tracked still points at is kept -- a recalculation and Track anyway both need it.
 */
export function releaseUploadedReplay(db: Db, file: string | null): void {
  // Only ever one of this app's own copies. osu!stable names its replays `<hash>-<time>.osr`
  // and lazer's store has no extensions, so neither can match -- whatever a caller hands in.
  if (file === null || !/[\\/]replays[\\/][0-9a-f]{32}\.osr$/.test(file)) return;
  const used = db
    .prepare(
      `SELECT 1 AS hit FROM scores WHERE replay_path = ?
       UNION ALL SELECT 1 FROM declined_plays WHERE replay_path = ? LIMIT 1`,
    )
    .get(file, file);
  if (used) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* in use elsewhere; harmless to leave */
  }
}

/**
 * Every stored copy nothing points at any more, removed: at launch, when nothing is mid-import.
 * The releases above catch almost all of them as they happen; this catches what goes in bulk --
 * a profile deleted or reset, a list emptied -- and anything a crash left half-way.
 */
export function pruneUploadedReplays(db: Db, dataDir: string): number {
  const dir = path.join(dataDir, UPLOADED_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.osr$/.test(name)) continue;
    const file = path.join(dir, name);
    releaseUploadedReplay(db, file);
    if (!fs.existsSync(file)) removed++;
  }
  return removed;
}
