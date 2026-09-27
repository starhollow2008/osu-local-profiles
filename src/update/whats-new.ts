import type { Db } from '../db/index.ts';
import { compareVersions } from './github.ts';
import { localNotes, notesBetween, updatedToFromLog, type NudgeDismissal, type VersionNotes } from './notes.ts';

/**
 * What changed, shown once after an update, and the "you are behind" notice's dismissal
 * (roadmap 5.66). Both are the install's, not a profile's, so both live in `kv`.
 */

const SEEN_KEY = 'lastSeenVersion';
const DISMISSED_KEY = 'updateNudgeDismissed';

function read(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function write(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * At startup: a first launch has nothing to announce, so it starts the record here. Unless
 * `data/update.log` says the last update installed this very version -- the update *to* the
 * first version that keeps a record, which had nothing earlier to compare with.
 */
export function seedSeenVersion(db: Db, current: string | null, dataDir: string): void {
  if (current === null || read(db, SEEN_KEY) !== null) return;
  if (updatedToFromLog(dataDir) === current) return;
  write(db, SEEN_KEY, current);
}

export interface WhatsNew {
  /** The version before, when it is known. */
  from: string | null;
  to: string;
  notes: VersionNotes[];
}

/** What this version brought since the last one this install ran, until it has been seen. */
export function whatsNew(db: Db, current: string | null, installDir: string, dataDir: string): WhatsNew | null {
  if (current === null) return null;
  const seen = read(db, SEEN_KEY);
  if (seen !== null && compareVersions(seen, current) >= 0) return null;
  if (seen === null && updatedToFromLog(dataDir) !== current) return null;
  return { from: seen, to: current, notes: notesBetween(localNotes(installDir), seen, current) };
}

export function markSeen(db: Db, current: string | null): void {
  if (current !== null) write(db, SEEN_KEY, current);
}

export function nudgeDismissal(db: Db): NudgeDismissal | null {
  try {
    const d = JSON.parse(read(db, DISMISSED_KEY) ?? 'null') as Partial<NudgeDismissal> | null;
    return typeof d?.version === 'string' && typeof d.at === 'number' ? { version: d.version, at: d.at } : null;
  } catch {
    return null;
  }
}

export function dismissNudge(db: Db, version: string, now = Date.now()): void {
  write(db, DISMISSED_KEY, JSON.stringify({ version, at: now }));
}
