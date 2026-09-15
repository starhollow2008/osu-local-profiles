import fs from 'node:fs';
import type { Db } from './db/index.ts';
import type { Ruleset } from './osr.ts';
import { playById, type Play } from './calc/stats.ts';
import { VANILLA, visibleSql, type Eligibility } from './calc/eligibility.ts';
import { detailsFor, ratingNeutral } from './favorites.ts';
import type { PpPart } from './calc/official.ts';

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
 * A removed score can then be deleted for good (`deleteRemovedScores`), and that keeps the
 * same promise another way: the row goes, its `dedupe_key` stays in `deleted_scores`, and
 * ingest refuses anything listed there.
 *
 * Pins are per mode, as on osu!, and a pinned score does not have to be in the top 100 --
 * pinning is how you show a play you are proud of that pp does not reward.
 *
 * A play osu! counted with no score -- Didn't finish, or Not submitted -- can be removed the
 * same way, and on the same terms: a hide on `incomplete_plays.hidden_at`, put back or deleted
 * for good from the same list. Its log is still on disk, so a deleted one is remembered too.
 */

export type ScoreAction = 'pin' | 'unpin' | 'hide' | 'restore';

/** Which table a row the user acts on lives in: a score, or a play osu! counted with no score. */
export type RowKind = 'score' | 'incomplete';

/**
 * How an unfinished play's key is remembered in `deleted_scores`. Prefixed, so it can never be
 * mistaken for a replay's key, and a replay's check can never match an unfinished play.
 */
export const deletedIncompleteKey = (dedupeKey: string): string => `incomplete:${dedupeKey}`;

/**
 * Remove unfinished plays from the profile, or put them back.
 *
 * Takes every id a Recent Plays row stands for, because a collapsed row is several attempts:
 * removing the row removes all of them, and the play count falls by as many. All or nothing --
 * an id this profile does not own refuses the whole request, rather than half-applying it.
 */
export function setIncompleteHidden(db: Db, profileId: number, ids: number[], hidden: boolean): number {
  const wanted = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (wanted.length === 0) throw new Error('no play named');

  const marks = wanted.map(() => '?').join(',');
  const owned = db
    .prepare(`SELECT COUNT(*) AS n FROM incomplete_plays WHERE profile_id = ? AND id IN (${marks})`)
    .get(profileId, ...wanted) as { n: number };
  if (owned.n !== wanted.length) throw new Error('no such play on this profile');

  db.prepare(`UPDATE incomplete_plays SET hidden_at = ? WHERE profile_id = ? AND id IN (${marks})`).run(
    hidden ? Date.now() : null,
    profileId,
    ...wanted,
  );
  return wanted.length;
}

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
  kind: 'score';
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

/** Unfinished plays removed together -- one Recent Plays row, which may be several attempts. */
export interface HiddenIncomplete {
  kind: 'incomplete';
  ids: number[];
  mode: number;
  title: string;
  version: string | null;
  unsubmitted: boolean;
  attempts: number;
  playedAt: number;
  hiddenAt: number;
}

export type HiddenRow = HiddenScore | HiddenIncomplete;

/**
 * Everything removed from the profile, newest removal first, so it can be put back.
 *
 * Without this a removal is indistinguishable from data loss: the play is gone from every
 * section, and nothing on the page would ever mention it again.
 */
export function hiddenScores(db: Db, profileId: number, limit = 200): HiddenRow[] {
  const rows: HiddenRow[] = [...hiddenScoreRows(db, profileId, limit), ...hiddenIncompleteRows(db, profileId, limit)];
  return rows.sort((a, b) => b.hiddenAt - a.hiddenAt).slice(0, limit);
}

/**
 * Removed unfinished plays, one entry per removal. A collapsed row's attempts are hidden in one
 * statement and so share `hidden_at`, which is what folds them back into the row they were.
 */
function hiddenIncompleteRows(db: Db, profileId: number, limit: number): HiddenIncomplete[] {
  const rows = db
    .prepare(
      `SELECT GROUP_CONCAT(s.id) AS ids, COUNT(*) AS attempts, MIN(s.mode) AS mode,
              MAX(s.played_at) AS played_at, s.hidden_at, s.unsubmitted,
              MAX(s.beatmap_name) AS beatmap_name, MAX(b.artist) AS artist, MAX(b.title) AS title,
              MAX(b.version) AS version
         FROM incomplete_plays s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.hidden_at IS NOT NULL
        GROUP BY s.hidden_at, COALESCE(s.beatmap_md5, s.beatmap_name, s.id), s.unsubmitted
        ORDER BY s.hidden_at DESC
        LIMIT ?`,
    )
    .all(profileId, limit) as Record<string, string | number | null>[];

  return rows.map((r) => ({
    kind: 'incomplete',
    ids: String(r['ids']).split(',').map(Number),
    mode: r['mode'] as number,
    // What the log called the map stands in when the beatmap itself is not resolvable.
    title:
      [r['artist'], r['title']].filter(Boolean).join(' - ') ||
      ((r['beatmap_name'] as string | null) ?? 'an unknown beatmap'),
    version: (r['version'] as string | null) ?? null,
    unsubmitted: r['unsubmitted'] === 1,
    attempts: r['attempts'] as number,
    playedAt: r['played_at'] as number,
    hiddenAt: r['hidden_at'] as number,
  }));
}

function hiddenScoreRows(db: Db, profileId: number, limit: number): HiddenScore[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.mode, s.mods_label, s.client, s.accuracy, s.grade, s.pp, s.played_at, s.hidden_at,
              b.artist, b.title, b.version
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND s.hidden_at IS NOT NULL
        ORDER BY s.hidden_at DESC
        LIMIT ?`,
    )
    .all(profileId, limit) as Record<string, string | number | null>[];

  return rows.map((r) => ({
    kind: 'score',
    id: r['id'] as number,
    mode: r['mode'] as number,
    title:
      [r['artist'], r['title']].filter(Boolean).join(' - ') || `beatmap ${String(r['id'])}`,
    version: (r['version'] as string | null) ?? null,
    // Named as osu! names it: a stable play carries Classic (see withClassicMod).
    modsLabel: classicLabel(r['mods_label'] as string, r['client'] === 'stable'),
    accuracy: r['accuracy'] as number,
    grade: r['grade'] as string,
    pp: (r['pp'] as number | null) ?? null,
    playedAt: r['played_at'] as number,
    hiddenAt: r['hidden_at'] as number,
  }));
}

/**
 * Delete removed scores for good -- the ones listed, or every one when `ids` is 'all'.
 *
 * Only a score that has already been removed can go: deleting is the second, deliberate step
 * after a removal, never a shortcut past it. Returns how many were deleted.
 *
 * `kind` says which table the listed ids are in. 'all' empties both: Delete all permanently
 * means everything in the removed list, unfinished plays included.
 */
export function deleteRemovedScores(
  db: Db,
  profileId: number,
  ids: number[] | 'all',
  now = Date.now(),
  kind: RowKind = 'score',
): number {
  const wanted = ids === 'all' ? null : [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (wanted !== null && wanted.length === 0) return 0;

  const tables: { table: string; key: (k: string) => string }[] = [];
  if (ids === 'all' || kind === 'score') tables.push({ table: 'scores', key: (k) => k });
  if (ids === 'all' || kind === 'incomplete') tables.push({ table: 'incomplete_plays', key: deletedIncompleteKey });

  const doomed = tables.map(({ table, key }) => {
    const rows = db
      .prepare(
        `SELECT id, dedupe_key, hidden_at FROM ${table}
          WHERE profile_id = ? ${wanted === null ? 'AND hidden_at IS NOT NULL' : `AND id IN (${wanted.map(() => '?').join(',')})`}`,
      )
      .all(profileId, ...(wanted ?? [])) as { id: number; dedupe_key: string; hidden_at: number | null }[];

    if (wanted !== null) {
      if (rows.length !== wanted.length) throw new Error(`no such ${kind === 'score' ? 'score' : 'play'} on this profile`);
      if (rows.some((r) => r.hidden_at === null)) {
        throw new Error(`only a removed ${kind === 'score' ? 'score' : 'play'} can be deleted`);
      }
    }
    return { table, key, rows };
  });

  db.exec('BEGIN');
  try {
    const remember = db.prepare(
      'INSERT OR IGNORE INTO deleted_scores (profile_id, dedupe_key, deleted_at) VALUES (?, ?, ?)',
    );
    for (const { table, key, rows } of doomed) {
      const drop = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const r of rows) {
        remember.run(profileId, key(r.dedupe_key), now);
        drop.run(r.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return doomed.reduce((n, d) => n + d.rows.length, 0);
}

/** Whether a replay with this key was deleted from the profile, and must not come back. */
export function wasDeleted(db: Db, profileId: number, dedupeKey: string): boolean {
  return db.prepare('SELECT 1 AS hit FROM deleted_scores WHERE profile_id = ? AND dedupe_key = ?').get(profileId, dedupeKey) !== undefined;
}

/** A stored mods label as osu! shows it for that client. */
function classicLabel(label: string, stable: boolean): string {
  if (!stable || /\bCL\b/.test(label)) return label;
  return label === 'None' ? 'CL' : `${label}CL`;
}

/** How many plays are removed: scores, and each attempt of a removed unfinished play. */
export function hiddenCount(db: Db, profileId: number): number {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ? AND hidden_at IS NOT NULL)
            + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ? AND hidden_at IS NOT NULL) AS n`,
    )
    .get(profileId, profileId) as { n: number };
  return row.n;
}

/* ------------------------------------------------------------ View Details */

/** lazer's judgement counts, keyed as osu! keys them (`great`, `large_tick_hit`, ...). */
export type Statistics = Record<string, number>;

/**
 * Everything osu!'s score page shows about one score, as far as this machine knows it.
 *
 * The row's `Play` plus the judgement breakdown, which client set it, and the beatmap's own
 * star rating for the difficulty badge -- which is not the score's, because a score's stored
 * rating includes its mods.
 */
export interface ScoreDetail extends Play {
  mode: Ruleset;
  /** Which client set the score. osu-web's "Played on", and what picks the dial or the letter. */
  client: 'lazer' | 'stable';
  statistics: Statistics;
  /** Empty for a stable score: its replay records what was hit, not what could have been. */
  maximumStatistics: Statistics;
  /** A full combo, when the beatmap's maximum is known; null when it is not. */
  perfectCombo: boolean | null;
  /** The difficulty's own star rating, or null when nothing here knows it. */
  difficultyStars: number | null;
  /** The mapper's osu! id, when osu.ppy.sh has described the set; otherwise the name only. */
  creatorId: number | null;
  /** Whether the replay file is on disk right now, not just whether one was recorded. */
  replayAvailable: boolean;
  /**
   * osu!'s own parts of the pp shown -- the stripped-mod calculation's when that is the pp
   * shown. Null until the score has been calculated since breakdowns were kept.
   */
  ppBreakdown: PpPart[] | null;
  /** The osu! release whose calculator produced this score's pp; null if not recorded. */
  ppVersion: string | null;
}

/**
 * A stable score's judgements, named the way lazer names them.
 *
 * stable replays carry only the six legacy counters, and which counter means what depends
 * on the ruleset. This is the mapping lazer applies when it imports one, so a stable score
 * reads the same as a lazer score of the same ruleset: 300 -> great in osu!, but a mania
 * geki is a `perfect` and a catch 100 is a droplet (`large_tick_hit`).
 */
export function legacyStatistics(
  mode: number,
  c: { count300: number; count100: number; count50: number; countGeki: number; countKatu: number; countMiss: number },
): Statistics {
  switch (mode) {
    case 1: // taiko
      return { great: c.count300, ok: c.count100, miss: c.countMiss };
    case 2: // catch
      return {
        great: c.count300,
        large_tick_hit: c.count100,
        small_tick_hit: c.count50,
        small_tick_miss: c.countKatu,
        miss: c.countMiss,
      };
    case 3: // mania
      return {
        perfect: c.countGeki,
        great: c.count300,
        good: c.countKatu,
        ok: c.count100,
        meh: c.count50,
        miss: c.countMiss,
      };
    default:
      return { great: c.count300, ok: c.count100, meh: c.count50, miss: c.countMiss };
  }
}

function parseBreakdown(json: string | null): PpPart[] | null {
  if (!json) return null;
  try {
    const parts = JSON.parse(json) as PpPart[];
    return Array.isArray(parts) ? parts.filter((p) => typeof p?.pp === 'number' && typeof p.name === 'string') : null;
  } catch {
    return null;
  }
}

function parseStatistics(json: string | null): Statistics | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Statistics = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The difficulty's own star rating: osu!'s, from the set's page when it was favourited, or
 * from any score on it whose mods leave the rating alone. Never this score's rating when its
 * mods changed it -- a DT score's stars are not the map's.
 */
function difficultyStars(
  db: Db,
  profileId: number,
  md5: string,
  mode: number,
  beatmapId: number | null,
  beatmapsetId: number | null,
): number | null {
  if (beatmapsetId !== null && beatmapId !== null) {
    const known = detailsFor(db, beatmapsetId)?.difficulties.find((d) => d.id === beatmapId);
    // A converted play is rated in its own ruleset, which the set's page does not list.
    const ruleset = ['osu', 'taiko', 'fruits', 'mania'][mode];
    if (known && known.mode === ruleset) return known.stars;
  }

  const scores = db
    .prepare(
      `SELECT s.stars, s.mods_json FROM scores s
        WHERE s.profile_id = ? AND s.beatmap_md5 = ? AND s.mode = ? AND s.stars IS NOT NULL
          AND ${visibleSql()}`,
    )
    .all(profileId, md5, mode) as { stars: number; mods_json: string }[];
  return scores.find((s) => ratingNeutral(s.mods_json))?.stars ?? null;
}

export function scoreDetail(
  db: Db,
  profileId: number,
  id: number,
  e: Eligibility = VANILLA,
): ScoreDetail | null {
  const play = playById(db, profileId, id, e);
  if (!play) return null;

  const row = db
    .prepare(
      `SELECT mode, client, statistics_json, max_statistics_json, beatmap_max_combo, replay_path,
              count300, count100, count50, count_geki, count_katu, count_miss,
              pp_parts, pp_nomod_parts, pp_version
         FROM scores WHERE id = ?`,
    )
    .get(id) as Record<string, string | number | null>;

  const mode = row['mode'] as Ruleset;
  const statistics =
    parseStatistics(row['statistics_json'] as string | null) ??
    legacyStatistics(mode, {
      count300: row['count300'] as number,
      count100: row['count100'] as number,
      count50: row['count50'] as number,
      countGeki: row['count_geki'] as number,
      countKatu: row['count_katu'] as number,
      countMiss: row['count_miss'] as number,
    });

  const mapMax = row['beatmap_max_combo'] as number | null;
  const replayPath = row['replay_path'] as string | null;
  const details = play.beatmapsetId === null ? null : detailsFor(db, play.beatmapsetId);
  const parts = row[play.ppBasis === 'without-unranked-mods' ? 'pp_nomod_parts' : 'pp_parts'] as string | null;

  return {
    ...play,
    mode,
    client: row['client'] === 'stable' ? 'stable' : 'lazer',
    statistics,
    maximumStatistics: parseStatistics(row['max_statistics_json'] as string | null) ?? {},
    // The medals' definition of a full combo, so the card and the FC medals never disagree.
    perfectCombo: mapMax === null || mapMax <= 0 ? null : play.maxCombo >= mapMax,
    difficultyStars: difficultyStars(db, profileId, play.beatmapMd5, mode, play.beatmapId, play.beatmapsetId),
    creatorId: details?.userId ?? null,
    replayAvailable: replayPath !== null && fs.existsSync(replayPath),
    ppBreakdown: parseBreakdown(parts),
    ppVersion: (row['pp_version'] as string | null) ?? null,
  };
}

/**
 * Which profile a visible score belongs to.
 *
 * A score's link (`/scores/<id>`) has to keep working after the page switches to another
 * profile -- ids are unique across the whole database, as osu!'s are across its site -- so
 * the read-only views of a score answer as the profile that owns it, not the active one.
 */
export function scoreOwner(db: Db, id: number): number | null {
  const row = db
    .prepare(`SELECT s.profile_id FROM scores s WHERE s.id = ? AND ${visibleSql()}`)
    .get(id) as { profile_id: number } | undefined;
  return row?.profile_id ?? null;
}

/* --------------------------------------------------------- Download Replay */

/**
 * Characters Windows will not have in a file name. lazer strips the same set before it writes
 * an exported replay (`GetValidFilename`), and a browser would otherwise substitute its own.
 */
const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/** lazer caps an export's name so the whole path stays writable. */
const MAX_FILENAME = 200;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The name lazer gives a replay it exports: `<player> playing <artist> - <title> (<mapper>)
 * [<version>] (<yyyy-MM-dd_HH-mm>).osr`, dated in local time -- `LegacyScoreExporter` and
 * `ScoreInfoExtensions.GetDisplayTitle` in ppy/osu.
 *
 * osu-web names a download after the online score id instead, which most local scores do not
 * have: a play set offline, or on a stable install, was never given one. lazer's name is
 * what the same file would be called had it been exported from the game, and it says what
 * the replay is.
 */
export function replayFileName(s: {
  player: string;
  artist: string | null;
  title: string | null;
  creator: string | null;
  version: string | null;
  playedAt: number;
}): string {
  const artist = s.artist || 'unknown artist';
  const title = s.title || 'unknown title';
  const creator = s.creator ? ` (${s.creator})` : '';
  const version = s.version ? ` [${s.version}]` : '';
  const d = new Date(s.playedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

  const base = `${s.player} playing ${artist} - ${title}${creator}${version} (${stamp})`
    .replace(INVALID_FILENAME, '')
    .trim();
  return `${base.slice(0, MAX_FILENAME).trim()}.osr`;
}

/**
 * `Content-Disposition` for a name that may not be ASCII: an ASCII fallback for anything
 * old, and the exact name as RFC 5987 UTF-8 for everything else. Beatmap titles are very
 * often Japanese, so the fallback is not a corner case.
 */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The replay to hand the browser for one of this profile's scores, or why there is none.
 *
 * The path comes from the database and only from the database: the request names a score,
 * never a file, so nothing a URL says can make this read anything but a replay that was
 * ingested for this profile.
 */
export function replayDownload(
  db: Db,
  profileId: number,
  id: number,
  player: string,
): { path: string; fileName: string } | { error: string } {
  const row = db
    .prepare(
      `SELECT s.replay_path, s.played_at, b.artist, b.title, b.creator, b.version
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.id = ? AND s.profile_id = ? AND ${visibleSql()}`,
    )
    .get(id, profileId) as Record<string, string | number | null> | undefined;

  if (!row) return { error: `no score ${id} on this profile` };
  const file = row['replay_path'] as string | null;
  if (!file) return { error: 'no replay was recorded for this score' };
  if (!fs.existsSync(file)) {
    return { error: "the replay is no longer in osu!'s files - it may have been deleted from osu!" };
  }

  return {
    path: file,
    fileName: replayFileName({
      player,
      artist: row['artist'] as string | null,
      title: row['title'] as string | null,
      creator: row['creator'] as string | null,
      version: row['version'] as string | null,
      playedAt: row['played_at'] as number,
    }),
  };
}

/**
 * How many of a profile's scores were priced by a different osu! calculator than `current`, or
 * before the version was recorded -- after an update that brings a pp rework, the ones still
 * on the old algorithm. Only scores with a replay count: they are the ones a recalculation
 * can reach.
 */
export function outdatedPpCount(db: Db, profileId: number, current: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores s
        WHERE s.profile_id = ? AND s.replay_path IS NOT NULL AND s.pp IS NOT NULL AND ${visibleSql()}
          AND (s.pp_version IS NULL OR s.pp_version <> ?)`,
    )
    .get(profileId, current) as { n: number };
  return row.n;
}
