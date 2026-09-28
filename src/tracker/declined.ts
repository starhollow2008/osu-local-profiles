import type { Db } from '../db/index.ts';
import { deletedIncompleteKey, wasDeleted } from '../scores.ts';
import { releaseUploadedReplay } from '../uploaded-replays.ts';
import type { FilterCriterion } from '../tracking-filter.ts';
import type { Recording } from './incomplete.ts';

/**
 * Plays the app turned away, kept so they can be looked at and tracked anyway.
 *
 * A declined play used to leave nothing but a toast, a console line and a count that reset at
 * the next launch. That is enough while the page is open and watched, and no help at all a day
 * later, when someone asks why a play never appeared: the tray launcher hides the console, a
 * toast reaches only a visible tab, and an import declines hundreds at once without a word per
 * play. So each one is recorded here, with its reason, and Settings lists them.
 *
 * **The filter still decides what is written.** Nothing here counts toward anything -- it is
 * not a score, not a play, and no query that computes a figure reads it. A row becomes a play
 * only when someone presses Track anyway on it, one play at a time, which writes it through the
 * same ingest as any other and takes it out of here. That is the one exception to "the filter's
 * decision cannot be undone", and it is deliberate: see docs/architecture.md.
 *
 * Three reasons are recorded, the three the app announces. The skips that are the app working
 * as meant -- already tracked, deleted for good, set before the cutoff -- are not: a list full
 * of them would bury the few worth reading.
 *
 * A play here can be deleted for good, exactly as a removed score can (`deleteDeclines`): its
 * key goes into `deleted_scores`, so it is never tracked, and never listed here, again.
 */

/** What was running when a play was turned away. */
export type DeclineSource = 'live' | 'import' | 'catch-up';

export type DeclineReason = 'filtered' | 'another-player' | 'unparseable';

export interface Decline {
  kind: 'score' | 'incomplete';
  dedupeKey: string;
  reason: DeclineReason;
  criterion: FilterCriterion | null;
  /** The name written in the replay, whatever the reason. An unfinished play has none. */
  player: string | null;
  source: DeclineSource;
  title: string | null;
  titleOriginal: string | null;
  mode: number | null;
  playedAt: number | null;
  replayPath: string | null;
  recording: Recording | null;
}

/** A recorded decline, as Settings lists it. */
export interface DeclinedPlay {
  id: number;
  kind: 'score' | 'incomplete';
  reason: DeclineReason;
  criterion: FilterCriterion | null;
  player: string | null;
  source: DeclineSource;
  title: string | null;
  titleOriginal: string | null;
  mode: number | null;
  playedAt: number | null;
  declinedAt: number;
  /** The replay's file name, for a replay that could not be read and so has no title. */
  fileName: string | null;
}

/**
 * How many are kept per profile, newest first.
 *
 * A bound, because an import walks osu!'s folders and every replay watched there is somebody
 * else's: 88 on the machine this was written on, and nothing stops it being thousands. A
 * thousand is weeks of live declines beside a large import, and far more than anyone reads.
 */
export const MAX_DECLINES = 1000;

/** How a decline's play is remembered in `deleted_scores`, by the same keys ingest checks. */
const deletedKey = (kind: 'score' | 'incomplete', dedupeKey: string): string =>
  kind === 'incomplete' ? deletedIncompleteKey(dedupeKey) : dedupeKey;

/**
 * A replay that could not be read has no play to key it by, only its path, so there is no key
 * ingest would ever check. Deleting one for good takes it off the list and nothing more.
 */
const unkeyed = (dedupeKey: string): boolean => dedupeKey.startsWith('file:');

/**
 * Record a play turned away. The same play declined again -- a second import over the same
 * evening -- is the same row, brought up to date and to the top.
 *
 * Nor is one already in the profile, or one deleted for good. Most such plays never get this
 * far -- ingest refuses them first -- but another player's replay is turned away before
 * anything asks, and one tracked anyway, or deleted from this list, must not reappear in it at
 * the next import.
 */
export function recordDecline(db: Db, profileId: number, d: Decline, at = Date.now()): void {
  if (wasDeleted(db, profileId, deletedKey(d.kind, d.dedupeKey))) return;
  // What this play was listed with before, if anything: an uploaded copy it may no longer need.
  const before = pathsOf(db, 'profile_id = ? AND kind = ? AND dedupe_key = ?', profileId, d.kind, d.dedupeKey);
  const table = d.kind === 'incomplete' ? 'incomplete_plays' : 'scores';
  if (db.prepare(`SELECT 1 AS hit FROM ${table} WHERE profile_id = ? AND dedupe_key = ?`).get(profileId, d.dedupeKey)) {
    // And a row left from before this was checked goes, the next time the play turns up.
    forgetDecline(db, profileId, d.kind, d.dedupeKey);
    return;
  }
  db.prepare(
    `INSERT INTO declined_plays
       (profile_id, kind, dedupe_key, reason, criterion, player, source, title, title_original,
        mode, played_at, declined_at, replay_path, recording)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (profile_id, kind, dedupe_key) DO UPDATE SET
       reason = excluded.reason, criterion = excluded.criterion, player = excluded.player,
       source = excluded.source, title = excluded.title, title_original = excluded.title_original,
       mode = excluded.mode, played_at = excluded.played_at, declined_at = excluded.declined_at,
       replay_path = excluded.replay_path, recording = excluded.recording`,
  ).run(
    profileId,
    d.kind,
    d.dedupeKey,
    d.reason,
    d.criterion,
    d.player,
    d.source,
    d.title,
    d.titleOriginal,
    d.mode,
    d.playedAt,
    at,
    d.replayPath,
    d.recording === null ? null : JSON.stringify(d.recording),
  );
  const pruned = pathsOf(
    db,
    `profile_id = ? AND id NOT IN
       (SELECT id FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC LIMIT ?)`,
    profileId,
    profileId,
    MAX_DECLINES,
  );
  db.prepare(
    `DELETE FROM declined_plays WHERE profile_id = ? AND id NOT IN
       (SELECT id FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC LIMIT ?)`,
  ).run(profileId, profileId, MAX_DECLINES);
  release(db, [...before, ...pruned]);
}

/** The replay files the rows matching `where` point at. */
function pathsOf(db: Db, where: string, ...params: (string | number)[]): string[] {
  return (db.prepare(`SELECT replay_path FROM declined_plays WHERE ${where}`).all(...params) as { replay_path: string | null }[])
    .map((r) => r.replay_path)
    .filter((p): p is string => p !== null);
}

/**
 * Let go of the uploaded copies these rows pointed at, once nothing else does: a replay uploaded
 * and turned away is kept only for as long as it is listed here (src/uploaded-replays.ts). A
 * path that is not one of those copies -- osu!'s own files -- is never touched.
 */
function release(db: Db, paths: string[]): void {
  for (const p of new Set(paths)) releaseUploadedReplay(db, p);
}

/**
 * A play is tracked after all -- anyway, or because the filter was loosened and it was
 * imported -- so it is no longer one the app turned away.
 */
export function forgetDecline(db: Db, profileId: number, kind: 'score' | 'incomplete', dedupeKey: string): void {
  const paths = pathsOf(db, 'profile_id = ? AND kind = ? AND dedupe_key = ?', profileId, kind, dedupeKey);
  db.prepare('DELETE FROM declined_plays WHERE profile_id = ? AND kind = ? AND dedupe_key = ?').run(
    profileId,
    kind,
    dedupeKey,
  );
  release(db, paths);
}

export function forgetDeclineById(db: Db, profileId: number, id: number): void {
  const paths = pathsOf(db, 'profile_id = ? AND id = ?', profileId, id);
  db.prepare('DELETE FROM declined_plays WHERE profile_id = ? AND id = ?').run(profileId, id);
  release(db, paths);
}

/** Empty the list without deleting anything for good -- what a profile reset does. */
export function clearDeclines(db: Db, profileId: number): number {
  const paths = pathsOf(db, 'profile_id = ?', profileId);
  const cleared = Number(db.prepare('DELETE FROM declined_plays WHERE profile_id = ?').run(profileId).changes);
  release(db, paths);
  return cleared;
}

/**
 * Delete plays not tracked for good -- the ones listed, or every one when `ids` is 'all'.
 *
 * The same promise as deleting a removed score (`deleteRemovedScores`): the row goes, and the
 * play's key is kept in `deleted_scores`, so no import, live or by hand, brings it in or lists
 * it again. Track anyway cannot either. All or nothing: an id this profile does not have
 * refuses the whole request. Returns how many were deleted.
 */
export function deleteDeclines(db: Db, profileId: number, ids: number[] | 'all', now = Date.now()): number {
  const wanted = ids === 'all' ? null : [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (wanted !== null && wanted.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, kind, dedupe_key, replay_path FROM declined_plays WHERE profile_id = ?
        ${wanted === null ? '' : `AND id IN (${wanted.map(() => '?').join(',')})`}`,
    )
    .all(profileId, ...(wanted ?? [])) as Pick<DeclineRow, 'id' | 'kind' | 'dedupe_key' | 'replay_path'>[];
  if (wanted !== null && rows.length !== wanted.length) throw new Error('that play is not in the list any more');

  db.exec('BEGIN');
  try {
    const remember = db.prepare(
      'INSERT OR IGNORE INTO deleted_scores (profile_id, dedupe_key, deleted_at) VALUES (?, ?, ?)',
    );
    const drop = db.prepare('DELETE FROM declined_plays WHERE id = ?');
    for (const r of rows) {
      if (!unkeyed(r.dedupe_key)) remember.run(profileId, deletedKey(r.kind, r.dedupe_key), now);
      drop.run(r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  release(db, rows.map((r) => r.replay_path).filter((p): p is string => p !== null));
  return rows.length;
}

export function declineCount(db: Db, profileId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM declined_plays WHERE profile_id = ?').get(profileId) as { n: number }).n;
}

interface DeclineRow {
  id: number;
  kind: 'score' | 'incomplete';
  dedupe_key: string;
  reason: DeclineReason;
  criterion: FilterCriterion | null;
  player: string | null;
  source: DeclineSource;
  title: string | null;
  title_original: string | null;
  mode: number | null;
  played_at: number | null;
  declined_at: number;
  replay_path: string | null;
  recording: string | null;
}

/** The file name alone: the page has no business with where osu! keeps its files. */
const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;

export function listDeclines(db: Db, profileId: number): DeclinedPlay[] {
  const rows = db
    .prepare('SELECT * FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC')
    .all(profileId) as unknown as DeclineRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    reason: r.reason,
    criterion: r.criterion,
    player: r.player,
    source: r.source,
    title: r.title,
    titleOriginal: r.title_original,
    mode: r.mode,
    playedAt: r.played_at,
    declinedAt: r.declined_at,
    fileName: r.title === null && r.replay_path !== null ? baseName(r.replay_path) : null,
  }));
}

/** The name in the replay one decline was for, when it was turned away as another player's. */
export function declinedPlayer(db: Db, profileId: number, id: number): string | null {
  const row = db
    .prepare(`SELECT player FROM declined_plays WHERE profile_id = ? AND id = ? AND reason = 'another-player'`)
    .get(profileId, id) as Pick<DeclineRow, 'player'> | undefined;
  return row?.player ?? null;
}

/** Every play turned away as another player's, for judging again once more names are known. */
export function otherPlayerDeclines(
  db: Db,
  profileId: number,
): { id: number; player: string | null; replayPath: string | null; source: DeclineSource }[] {
  const rows = db
    .prepare(
      `SELECT id, player, replay_path, source FROM declined_plays
        WHERE profile_id = ? AND kind = 'score' AND reason = 'another-player'
        ORDER BY played_at, id`,
    )
    .all(profileId) as Pick<DeclineRow, 'id' | 'player' | 'replay_path' | 'source'>[];
  return rows.map((r) => ({ id: r.id, player: r.player, replayPath: r.replay_path, source: r.source }));
}

/** What tracking one anyway needs, or null when this profile has no such decline. */
export function declineToTrack(
  db: Db,
  profileId: number,
  id: number,
): { kind: 'score'; replayPath: string | null } | { kind: 'incomplete'; recording: Recording | null } | null {
  const row = db
    .prepare('SELECT kind, replay_path, recording FROM declined_plays WHERE profile_id = ? AND id = ?')
    .get(profileId, id) as Pick<DeclineRow, 'kind' | 'replay_path' | 'recording'> | undefined;
  if (!row) return null;
  if (row.kind === 'score') return { kind: 'score', replayPath: row.replay_path };
  return { kind: 'incomplete', recording: row.recording === null ? null : (JSON.parse(row.recording) as Recording) };
}
