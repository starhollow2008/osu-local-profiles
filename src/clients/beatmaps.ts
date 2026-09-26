import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/index.ts';
import { openReadOnly } from '../db/index.ts';
import type { OsuInstall } from './detect.ts';
import type { Ruleset } from '../osr.ts';

/** osu!'s `approved` enum. pp is only awarded on RANKED and APPROVED. */
export const Status = {
  GRAVEYARD: -2,
  WIP: -1,
  PENDING: 0,
  RANKED: 1,
  APPROVED: 2,
  QUALIFIED: 3,
  LOVED: 4,
} as const;

/**
 * Stored in `scores.map_status` when the beatmap is not in `online.db` at all -- it was
 * never submitted, or the local copy is newer than lazer's cache.
 *
 * A distinct value rather than NULL, because NULL in that column means the row was
 * ingested before the column existed. Outside osu!'s own enum range on purpose.
 */
export const UNRESOLVED_STATUS = -3;

export function awardsPp(status: number | null | undefined): boolean {
  return status === Status.RANKED || status === Status.APPROVED;
}

/**
 * The beatmap states a profile can choose to count, keyed by the name the setting uses.
 *
 * Offered separately rather than as one "unranked maps" switch, because they are not one
 * proposition: a Loved map has been through mapping and is played competitively, while a
 * graveyarded one may be a draft nobody ever finished. `unsubmitted` covers a beatmap with
 * no `online.db` row at all -- it still has a local `.osu`, so it can still be scored.
 */
export const UNRANKED_MAP_STATUSES = {
  loved: Status.LOVED,
  qualified: Status.QUALIFIED,
  pending: Status.PENDING,
  wip: Status.WIP,
  graveyard: Status.GRAVEYARD,
  unsubmitted: UNRESOLVED_STATUS,
} as const;

export type UnrankedMapStatus = keyof typeof UNRANKED_MAP_STATUSES;

/**
 * When a beatmapset was submitted, and when it was ranked, approved or loved.
 *
 * Both come from `online.db`'s second table, `osu_beatmapsets`, which holds only the sets
 * osu! has accepted -- 60,492 rows against `osu_beatmaps`' 234,457 here, with `approved`
 * values of 1, 2 and 4 only. A qualified, pending, WIP, graveyarded or unsubmitted set has
 * no row at all, so "not known" is the normal answer and never an error.
 */
export interface BeatmapsetDates {
  submittedAt: number | null;
  rankedAt: number | null;
}

/** One difficulty of a beatmapset, as lazer's `online.db` records it. */
export interface OnlineSetBeatmap {
  beatmapId: number;
  md5: string | null;
  version: string | null;
  userId: number | null;
  status: number | null;
}

/** What `online.db` knows of one beatmap. */
export interface OnlineBeatmap {
  beatmapId: number;
  beatmapsetId: number;
  status: number;
}

interface OnlineRow {
  beatmap_id: number;
  beatmapset_id: number;
  approved: number;
}

const onlineBeatmap = (row: OnlineRow): OnlineBeatmap => ({
  beatmapId: row.beatmap_id,
  beatmapsetId: row.beatmapset_id,
  status: row.approved,
});

export interface ResolvedBeatmap {
  md5: string;
  osuPath: string | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
  status: number | null;
  artist: string | null;
  title: string | null;
  /**
   * The song's artist and title in their own script, from the `.osu` file's `ArtistUnicode`
   * and `TitleUnicode`, for a profile that prefers metadata in its original language.
   *
   * `''` rather than null when the file was read and carried none -- an older beatmap, or one
   * whose title is romanised to begin with -- so "looked and found nothing" is distinct from
   * "never looked", and the romanised value above is the answer either way.
   */
  artistUnicode: string | null;
  titleUnicode: string | null;
  version: string | null;
  creator: string | null;
}

const OSU_MAGIC = 'osu file format v';

/** .osu files are CRLF in practice but not by rule. */
const NEWLINE = /\r?\n/;

function readHead(file: string, n: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function isBeatmapFile(file: string): boolean {
  const head = readHead(file, 64);
  return head !== null && head.toString('latin1').includes(OSU_MAGIC);
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** A folder to index, and whether its beatmaps can be told apart by name. */
export interface IndexRoot {
  path: string;
  /**
   * osu!stable's `Songs` names every beatmap `*.osu`, so nothing else there needs opening --
   * most of a set is audio, images and hitsounds. lazer's store names files by hash, with no
   * extension at all, so there every file has to be sniffed.
   */
  byExtension: boolean;
}

export interface IndexProgress {
  /** `counting` walks the folders to learn how much there is; `indexing` does the work. */
  phase: 'counting' | 'indexing';
  /** Files dealt with so far, already-known ones included. */
  scanned: number;
  /** Files there are to deal with; known once counting finishes. */
  total: number;
  /** New beatmaps added to the index this run. */
  indexed: number;
  /** Nothing had been indexed before this run: a first launch, or a fresh data folder. */
  firstRun: boolean;
}

/**
 * How long the indexer works before letting everything else run. It shares the event loop
 * with the page's server and the tracker, so a long unbroken run would freeze both.
 */
const SLICE_MS = 25;

const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

const isOsuName = (file: string) => file.toLowerCase().endsWith('.osu');

/**
 * Build (or top up) the MD5 -> path index of local .osu files.
 *
 * lazer names every stored file by its SHA-256, so a score's beatmap MD5 cannot be turned
 * into a path without either this index or lazer's Realm database. Files in the store are
 * content-addressed and therefore immutable, so anything already indexed is never re-read.
 *
 * It runs *beside* the app rather than before it: on a first launch it has to open every
 * file in the store once, which is seconds on a warm disk but can be an hour on a very large
 * library read cold. So the work is done in slices of `SLICE_MS`, each committed before the
 * pause -- the connection is shared, and a transaction left open across a pause would swallow
 * whatever else wrote in it. Anything that needs the index waits for this promise; see
 * `Tracker.indexBeatmaps`.
 */
export async function indexBeatmapFiles(
  db: Db,
  roots: IndexRoot[],
  onProgress?: (progress: IndexProgress) => void,
): Promise<{ scanned: number; indexed: number }> {
  const known = new Set<string>();
  const indexed = db.prepare('SELECT path, beatmap_id, name FROM osu_files').all() as {
    path: string;
    beatmap_id: number | null;
    name: string | null;
  }[];
  for (const r of indexed) {
    // Older rows have no id or name metadata. Re-read each once to backfill both.
    if (r.beatmap_id !== null && r.name !== null) known.add(r.path);
  }
  // Counted before the backfill filter: an upgrade re-reads every row, but the index has
  // been built before and must not be announced as a first run.
  const firstRun = indexed.length === 0;
  for (const r of db.prepare('SELECT path FROM not_beatmaps').all() as { path: string }[]) {
    known.add(r.path);
  }

  const insertOsu = db.prepare(
    'INSERT OR REPLACE INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertSkip = db.prepare('INSERT OR REPLACE INTO not_beatmaps (path, size) VALUES (?, ?)');

  const progress: IndexProgress = { phase: 'counting', scanned: 0, total: 0, indexed: 0, firstRun };
  const candidates = function* (): Generator<string> {
    for (const root of roots) {
      for (const file of walk(root.path)) if (!root.byExtension || isOsuName(file)) yield file;
    }
  };

  let sliceStart = performance.now();
  let inTransaction = false;
  const pauseIfDue = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return;
    if (inTransaction) {
      db.exec('COMMIT');
      inTransaction = false;
    }
    onProgress?.({ ...progress });
    await breathe();
    sliceStart = performance.now();
  };
  const write = (statement: typeof insertOsu, ...values: (string | number)[]) => {
    if (!inTransaction) {
      db.exec('BEGIN');
      inTransaction = true;
    }
    statement.run(...values);
  };

  try {
    // Counting first costs a directory listing, which is cheap next to opening files, and
    // is what lets the page show how far along it is rather than a spinner.
    for (const _file of candidates()) {
      progress.total++;
      await pauseIfDue();
    }

    progress.phase = 'indexing';
    for (const file of candidates()) {
      progress.scanned++;
      if (!known.has(file)) {
        let size = -1;
        try {
          size = fs.statSync(file).size;
        } catch {
          /* gone since it was listed */
        }
        if (size >= 0 && !isBeatmapFile(file)) {
          write(insertSkip, file, size);
        } else if (size >= 0) {
          try {
            const contents = fs.readFileSync(file);
            const md5 = crypto.createHash('md5').update(contents).digest('hex');
            const meta = parseOsuMetadataText(contents.toString('utf8'));
            write(insertOsu, file, md5, meta.beatmapId ?? 0, beatmapDisplayName(meta), size, Date.now());
            progress.indexed++;
          } catch {
            /* unreadable, skip */
          }
        }
      }
      await pauseIfDue();
    }
    if (inTransaction) db.exec('COMMIT');
  } catch (e) {
    if (inTransaction) db.exec('ROLLBACK');
    throw e;
  }
  // A folder can change while it is walked; the bar ends full either way.
  progress.total = progress.scanned;
  onProgress?.({ ...progress });
  return { scanned: progress.scanned, indexed: progress.indexed };
}

/** Add a single newly-seen file to the index (used by the watcher). */
export function indexOneFile(db: Db, file: string): void {
  try {
    if (!isBeatmapFile(file)) return;
    const contents = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(contents).digest('hex');
    const meta = parseOsuMetadataText(contents.toString('utf8'));
    db.prepare(
      'INSERT OR REPLACE INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(file, md5, meta.beatmapId ?? 0, beatmapDisplayName(meta), fs.statSync(file).size, Date.now());
  } catch {
    /* ignore */
  }
}

const ONLINE_STAMP_KEY = 'onlineDbStamp';

/** What a status refresh changed. */
export interface StatusRefresh {
  /** Played beatmaps whose status, id or dates `online.db` now says something new about. */
  beatmaps: number;
  /** Tracked scores on them whose stored status, and so whether they count, was updated. */
  scores: number;
}

/**
 * Bring the ranked status of every played beatmap up to date with lazer's `online.db`.
 *
 * A beatmap's status is read from `online.db` once, when it is first played, and cached. But
 * that file is a snapshot lazer downloads about once a month, so a map ranked since is not in
 * it: the play was stored with no status -- counted like a never-submitted map, or greyed out
 * on a profile that does not count those -- and it stayed that way after the snapshot had it.
 *
 * So when the file has changed since the last look (`onlineStamp`), every played beatmap is
 * looked up again, in one opening of the file, and each one it now says something new about
 * is updated with the scores on it. Their ranked dates are cleared to be read again the next
 * time the play tracking filter needs them. pp is not touched: every play already has one,
 * ranked or not, and status only decides whether it counts. Imported scores are left as osu!
 * reported them. A beatmap the snapshot does not have keeps what it had.
 *
 * Synchronous, and one transaction: nothing can interleave with it on the shared connection.
 * Null when there is no `online.db`, or it has not changed since the last time.
 */
export function refreshBeatmapStatuses(db: Db, resolver: BeatmapResolver): StatusRefresh | null {
  const stamp = resolver.onlineStamp();
  if (stamp === null) return null;
  const seen = db.prepare('SELECT value FROM kv WHERE key = ?').get(ONLINE_STAMP_KEY) as
    | { value: string }
    | undefined;
  if (seen?.value === stamp) return null;

  const rows = db
    .prepare('SELECT md5, beatmap_id, beatmapset_id, status, ranked_at FROM beatmaps')
    .all() as {
    md5: string;
    beatmap_id: number | null;
    beatmapset_id: number | null;
    status: number | null;
    ranked_at: number | null;
  }[];
  const online = resolver.onlineBeatmaps(rows.map((r) => r.md5));

  const updateBeatmap = db.prepare(
    `UPDATE beatmaps SET status = ?, beatmap_id = ?, beatmapset_id = ?, submitted_at = NULL, ranked_at = NULL
      WHERE md5 = ?`,
  );
  const updateScores = db.prepare(
    `UPDATE scores SET map_status = ?, ranked = CASE WHEN ? = 1 AND mods_ranked = 1 THEN 1 ELSE 0 END
      WHERE beatmap_md5 = ? AND imported_at IS NULL AND (map_status IS NOT ? OR ranked IS NOT
            (CASE WHEN ? = 1 AND mods_ranked = 1 THEN 1 ELSE 0 END))`,
  );

  const result: StatusRefresh = { beatmaps: 0, scores: 0 };
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const now = online.get(row.md5);
      if (!now) continue;
      const unchanged =
        now.status === row.status &&
        now.beatmapId === row.beatmap_id &&
        now.beatmapsetId === row.beatmapset_id &&
        // 0 is "looked, and online.db could not say": worth asking again now that it has the map.
        row.ranked_at !== 0;
      if (unchanged) continue;
      updateBeatmap.run(now.status, now.beatmapId, now.beatmapsetId, row.md5);
      const ranked = awardsPp(now.status) ? 1 : 0;
      result.scores += Number(updateScores.run(now.status, ranked, row.md5, now.status, ranked).changes);
      result.beatmaps++;
    }
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(ONLINE_STAMP_KEY, stamp);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

/**
 * Fill in the original-language artist and title for beatmaps cached before those columns
 * existed.
 *
 * Every other lazily-filled beatmap column -- `length_ms`, the three filter dates -- is read
 * on the first request that needs it, because each is needed for one beatmap at a time. This
 * one is not: the page draws a hundred titles in one query, and a setting that only took
 * effect on the maps someone happened to open would look broken rather than lazy.
 *
 * So it is a pass, and it is cheap for the same reason the beatmap index is expensive: this
 * table holds one row per beatmap actually *played*, not one per file in osu!'s store. A row
 * whose `.osu` cannot be read is written `''` like one that has no original-language title,
 * so a missing file costs one attempt and never another.
 *
 * Sliced like the index and with no transaction of its own: it shares the connection with the
 * tracker, and a transaction held open across a pause would swallow whatever the tracker
 * committed inside it. A row lost to an unrelated rollback is simply filled in on the next
 * launch.
 */
export async function backfillOriginalMetadata(db: Db): Promise<number> {
  const rows = db
    .prepare(
      `SELECT md5, osu_path FROM beatmaps
        WHERE title_unicode IS NULL OR artist_unicode IS NULL`,
    )
    .all() as { md5: string; osu_path: string | null }[];
  if (rows.length === 0) return 0;

  const update = db.prepare(
    'UPDATE beatmaps SET artist_unicode = ?, title_unicode = ? WHERE md5 = ?',
  );
  let filled = 0;
  let sliceStart = performance.now();
  for (const row of rows) {
    const meta = row.osu_path === null ? null : parseOsuMetadata(row.osu_path);
    update.run(meta?.artistUnicode ?? '', meta?.titleUnicode ?? '', row.md5);
    filled++;
    if (performance.now() - sliceStart >= SLICE_MS) {
      await breathe();
      sliceStart = performance.now();
    }
  }
  return filled;
}

interface OsuMetadata {
  artist: string | null;
  title: string | null;
  /** `ArtistUnicode` / `TitleUnicode`: the song's own script, where the file carries one. */
  artistUnicode: string | null;
  titleUnicode: string | null;
  version: string | null;
  creator: string | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
}

/**
 * One section of a .osu file: from its header line to the next line that *begins* with `[`.
 *
 * Not to the next `[` anywhere, which was the rule before and is wrong -- `[` is ordinary inside
 * a value: mappers named `cRyo[iceeicee]`, artists tagged `[CV. ...]`, audio files named
 * `[HD] ...`. Measured across this machine's 12,811 beatmaps, that rule lost or corrupted 327
 * names and filed 23 beatmaps under the wrong mode.
 */
export function osuSection(text: string, header: string): string | null {
  let body: number;
  if (text.startsWith(header)) {
    body = header.length;
  } else {
    const at = text.indexOf(`\n${header}`);
    if (at < 0) return null;
    body = at + 1 + header.length;
  }
  const next = text.indexOf('\n[', body);
  return text.slice(body, next < 0 ? undefined : next);
}

function parseOsuMetadataText(text: string): OsuMetadata {
  const out: OsuMetadata = {
    artist: null,
    title: null,
    artistUnicode: null,
    titleUnicode: null,
    version: null,
    creator: null,
    beatmapId: null,
    beatmapsetId: null,
  };
  const section = osuSection(text, '[Metadata]');
  if (section === null) return out;

  for (const line of section.split(NEWLINE)) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === 'Artist') out.artist = value;
    else if (key === 'Title') out.title = value;
    // Not every .osu has these, and plenty that do simply repeat the romanised value. Both
    // are kept as written: deciding they are "the same" is the reader's job, not the parser's.
    else if (key === 'ArtistUnicode') out.artistUnicode = value;
    else if (key === 'TitleUnicode') out.titleUnicode = value;
    else if (key === 'Version') out.version = value;
    else if (key === 'Creator') out.creator = value;
    else if (key === 'BeatmapID') out.beatmapId = Number(value) || null;
    else if (key === 'BeatmapSetID') out.beatmapsetId = Number(value) || null;
  }
  return out;
}

/**
 * lazer's own name for a beatmap -- `BeatmapInfo.ToString()`, `Artist - Title (Creator)
 * [Version]` from the romanised metadata -- which is exactly what its log writes when the game
 * changes beatmap. Building the same string from a `.osu` is therefore an equality test, not a
 * guess. Measured against this machine's logs it matched all 59 attempts osu! could not submit,
 * where the beatmap cache alone matched 12. '' when any of the four is missing.
 */
export function beatmapDisplayName(meta: {
  artist: string | null;
  title: string | null;
  creator: string | null;
  version: string | null;
}): string {
  if (!meta.artist || !meta.title || !meta.creator || !meta.version) return '';
  return `${meta.artist} - ${meta.title} (${meta.creator}) [${meta.version}]`;
}

function parseOsuMetadata(file: string): OsuMetadata {
  try {
    return parseOsuMetadataText(fs.readFileSync(file, 'utf8'));
  } catch {
    return parseOsuMetadataText('');
  }
}

/** `online.db`'s timestamp format -> epoch milliseconds, or null for anything unreadable. */
function parseOnlineDate(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
}

/**
 * The ruleset a beatmap was written for, from its `[General]` section.
 *
 * Only needed for a play with no replay, where nothing else says which mode it belongs to:
 * lazer's log never names the ruleset. A play on a *converted* beatmap therefore files
 * under the beatmap's own mode rather than the one it was played in. That is a known
 * limitation of the log, not a guess -- there is no second source to check it against.
 */
export function beatmapMode(file: string): Ruleset {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }

  // [General] alone, so a `Mode:` further down the file cannot be picked up.
  const section = osuSection(text, '[General]');
  if (section === null) return 0;

  for (const line of section.split(NEWLINE)) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    if (line.slice(0, sep).trim() !== 'Mode') continue;
    const mode = Number(line.slice(sep + 1).trim());
    return mode === 1 || mode === 2 || mode === 3 ? mode : 0;
  }
  return 0;
}

/**
 * Resolves a beatmap MD5 with no network access:
 *   local .osu index -> lazer's online.db -> the .osu file's own [Metadata] section.
 */
export class BeatmapResolver {
  private readonly onlineDbPaths: string[] = [];
  private readonly db: Db;

  /**
   * Whether anything here can say if a beatmap is ranked.
   *
   * Only lazer ships `online.db`; osu!stable records a beatmap's status nowhere this app can
   * read. So a stable-only install resolves every map to `UNRESOLVED_STATUS`, and the profile
   * has to be told that its beatmap settings cannot mean anything -- see `countUnresolved` in
   * src/calc/eligibility.ts.
   */
  get knowsStatus(): boolean {
    return this.onlineDbPaths.length > 0;
  }

  constructor(db: Db, installs: OsuInstall[]) {
    this.db = db;
    for (const i of installs) {
      if (!i.onlineDb) continue;
      // Opened once to prove it is a database this can read, and closed again: see fromOnline.
      const handle = openReadOnly(i.onlineDb);
      if (!handle) continue;
      handle.close();
      this.onlineDbPaths.push(i.onlineDb);
    }
  }

  /**
   * Ask each `online.db` in turn, opened for this one piece of work and closed straight after,
   * until one answers (anything but `undefined`).
   *
   * Not held open for the app's lifetime, as it once was: an open handle stops lazer from
   * refreshing the file. lazer rewrites it in place, asking Windows for exclusive access, once
   * the copy is a month old -- and that fails while any other process has it open (measured).
   * The app runs beside lazer for hours at a time, so the snapshot of ranked statuses it reads
   * could simply never update. A lookup that meets the file mid-rewrite, or a layout without
   * the table it asks for, finds nothing rather than failing the play being tracked.
   */
  private fromOnline<T>(lookup: (online: Db) => T | undefined): T | undefined {
    for (const file of this.onlineDbPaths) {
      const online = openReadOnly(file);
      if (!online) continue;
      try {
        const answer = lookup(online);
        if (answer !== undefined) return answer;
      } catch {
        /* being rewritten by lazer, or an older online.db without this table */
      } finally {
        online.close();
      }
    }
    return undefined;
  }

  /**
   * When each `online.db` was last written, or null with none: what says the snapshot of
   * ranked statuses has changed since the app last read it (`refreshBeatmapStatuses`).
   */
  onlineStamp(): string | null {
    if (this.onlineDbPaths.length === 0) return null;
    return this.onlineDbPaths
      .map((file) => {
        try {
          return `${file}@${fs.statSync(file).mtimeMs}`;
        } catch {
          return `${file}@missing`;
        }
      })
      .join('|');
  }

  /**
   * What `online.db` says about each of these beatmaps -- id, set and status -- for those it
   * has, from one opening of each file however many there are.
   */
  onlineBeatmaps(md5s: readonly string[]): Map<string, OnlineBeatmap> {
    const found = new Map<string, OnlineBeatmap>();
    for (const file of this.onlineDbPaths) {
      const online = openReadOnly(file);
      if (!online) continue;
      try {
        const query = online.prepare(
          'SELECT beatmap_id, beatmapset_id, approved FROM osu_beatmaps WHERE checksum = ?',
        );
        for (const md5 of md5s) {
          if (found.has(md5)) continue;
          const row = query.get(md5) as OnlineRow | undefined;
          if (row) found.set(md5, onlineBeatmap(row));
        }
      } catch {
        /* being rewritten by lazer: whatever it found so far stands */
      } finally {
        online.close();
      }
    }
    return found;
  }

  /**
   * The MD5 of an online beatmap id, from lazer's `online.db`.
   *
   * The reverse of the usual direction: a score names its beatmap by MD5, but a play read
   * out of lazer's log is only ever identified by its online id, because that is what the
   * submission URL carries. `osu_beatmaps.beatmap_id` is the primary key there, so this is
   * an index lookup rather than the scan the other direction would need.
   */
  md5ForBeatmapId(beatmapId: number): string | null {
    if (beatmapId <= 0) return null;

    // A map already cached locally answers without opening online.db at all.
    const cached = this.db
      .prepare('SELECT md5 FROM beatmaps WHERE beatmap_id = ? LIMIT 1')
      .get(beatmapId) as { md5: string } | undefined;
    if (cached) return cached.md5;

    const online = this.fromOnline(
      (o) =>
        (o.prepare('SELECT checksum FROM osu_beatmaps WHERE beatmap_id = ?').get(beatmapId) as
          | { checksum: string | null }
          | undefined)?.checksum || undefined,
    );
    if (online) return online;

    // online.db is an optional downloaded cache. Local .osu metadata works on every platform.
    // An edited copy can retain BeatmapID with a different checksum, so reject ambiguity.
    const local = this.db
      .prepare(
        `SELECT f.md5, EXISTS(SELECT 1 FROM beatmaps b WHERE b.md5 = f.md5) AS cached
           FROM osu_files f
          WHERE f.beatmap_id = ?
          GROUP BY f.md5
          ORDER BY cached DESC`,
      )
      .all(beatmapId) as { md5: string; cached: number }[];
    if (local.length === 1 || (local[0]?.cached === 1 && local[1]?.cached !== 1)) {
      return local[0]!.md5;
    }
    return null;
  }

  /**
   * The MD5 of a beatmap named as lazer names it in its log, `Artist - Title (Creator) [Version]`.
   *
   * The only handle an attempt osu! could not submit has: offline there is no submission
   * request, so no beatmap id. A beatmap already resolved from a real score answers first; then
   * every local `.osu`, by the name the index built from its own metadata, which is what makes
   * this work with no `online.db` and on every platform. A name shared by two different files --
   * an edited copy keeps its name under another checksum -- resolves to neither, the same rule
   * `md5ForBeatmapId` applies to ids.
   */
  md5ForBeatmapName(name: string): string | null {
    if (!name) return null;

    const cached = this.db
      .prepare(
        `SELECT DISTINCT md5 FROM beatmaps
          WHERE artist IS NOT NULL AND title IS NOT NULL
                AND creator IS NOT NULL AND version IS NOT NULL
                AND artist || ' - ' || title || ' (' || creator || ') [' || version || ']' = ?
          LIMIT 2`,
      )
      .all(name) as { md5: string }[];
    if (cached.length === 1) return cached[0]!.md5;
    if (cached.length > 1) return null;

    const local = this.db
      .prepare('SELECT DISTINCT md5 FROM osu_files WHERE name = ? LIMIT 2')
      .all(name) as { md5: string }[];
    return local.length === 1 ? local[0]!.md5 : null;
  }

  /**
   * A beatmapset's submission and ranked dates, from `online.db`, or null when it has no row
   * there -- which is every set osu! has not ranked, approved or loved.
   *
   * The timestamps are written `2007-10-06 17:46:31+00:00`: ISO but for the space, which
   * `Date` is not required to accept, so the space becomes a `T` before parsing rather than
   * relying on a browser-ism holding in Node.
   */
  beatmapsetDates(beatmapsetId: number): BeatmapsetDates | null {
    return (
      this.fromOnline((online) => {
        const row = online
          .prepare('SELECT submit_date, approved_date FROM osu_beatmapsets WHERE beatmapset_id = ?')
          .get(beatmapsetId) as { submit_date: string | null; approved_date: string | null } | undefined;
        if (!row) return undefined;
        return { submittedAt: parseOnlineDate(row.submit_date), rankedAt: parseOnlineDate(row.approved_date) };
      }) ?? null
    );
  }

  /**
   * Every difficulty of a beatmapset that lazer's `online.db` knows, for a Favorite
   * Beatmaps card built without a network. `online.db` has no star ratings or modes, only
   * ids, checksums, the `.osu` filename (which carries the difficulty name) and the status.
   */
  beatmapsInSet(beatmapsetId: number): OnlineSetBeatmap[] {
    return this.fromOnline((online) => {
      const rows = online
        .prepare(
          `SELECT beatmap_id, checksum, filename, user_id, approved
             FROM osu_beatmaps WHERE beatmapset_id = ?`,
        )
        .all(beatmapsetId) as {
        beatmap_id: number;
        checksum: string | null;
        filename: string | null;
        user_id: number | null;
        approved: number | null;
      }[];
      if (rows.length === 0) return undefined;
      return rows.map((r) => ({
        beatmapId: r.beatmap_id,
        md5: r.checksum,
        // `Artist - Title (Creator) [Version].osu`: the version is the last bracketed part.
        version: /\[([^\]]*)\]\.osu$/i.exec(r.filename ?? '')?.[1] ?? null,
        userId: r.user_id,
        status: r.approved,
      }));
    }) ?? [];
  }

  /** A mapper's username from `online.db`'s `users` table, or null. */
  username(userId: number): string | null {
    return (
      this.fromOnline(
        (online) =>
          (online.prepare('SELECT username FROM users WHERE user_id = ?').get(userId) as
            | { username: string }
            | undefined)?.username || undefined,
      ) ?? null
    );
  }

  /**
   * Asked before a beatmap is given up as having no local file, so whatever has just arrived on
   * disk can be indexed first. The tracker points it at the Songs watcher (`SongsWatcher.flush`):
   * osu!stable's `Songs` is not watched for replays, so a map downloaded moments before it is
   * played -- constantly, in multiplayer -- may not be in the index yet.
   */
  onMiss: (() => void) | null = null;

  /** The indexed `.osu` for this MD5, after giving `onMiss` one chance to index it. */
  private localFile(md5: string): string | null {
    const find = () =>
      (this.db.prepare('SELECT path FROM osu_files WHERE md5 = ? LIMIT 1').get(md5) as
        | { path: string }
        | undefined)?.path ?? null;
    const found = find();
    if (found !== null || !this.onMiss) return found;
    this.onMiss();
    return find();
  }

  resolve(md5: string): ResolvedBeatmap {
    const cached = this.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(md5) as
      | Record<string, string | number | null>
      | undefined;
    /*
     * A beatmap with no local file is cached too -- online.db may still know its id and status
     * -- but a miss is not the last word. It used to be: a map downloaded mid-session and played
     * before the index had it stayed "Unknown beatmap" with no pp for good, through every restart
     * and every recalculation. Now a cached miss is looked up again, and resolved properly the
     * moment its file is indexed.
     */
    const osuPath =
      cached && cached['osu_path'] !== null ? (cached['osu_path'] as string) : this.localFile(md5);
    if (cached && (cached['osu_path'] !== null || osuPath === null)) {
      return {
        md5,
        osuPath: (cached['osu_path'] as string | null) ?? null,
        beatmapId: (cached['beatmap_id'] as number | null) ?? null,
        beatmapsetId: (cached['beatmapset_id'] as number | null) ?? null,
        status: (cached['status'] as number | null) ?? null,
        artist: (cached['artist'] as string | null) ?? null,
        title: (cached['title'] as string | null) ?? null,
        artistUnicode: (cached['artist_unicode'] as string | null) ?? null,
        titleUnicode: (cached['title_unicode'] as string | null) ?? null,
        version: (cached['version'] as string | null) ?? null,
        creator: (cached['creator'] as string | null) ?? null,
      };
    }

    const result: ResolvedBeatmap = {
      md5,
      osuPath,
      beatmapId: null,
      beatmapsetId: null,
      status: null,
      artist: null,
      title: null,
      artistUnicode: null,
      titleUnicode: null,
      version: null,
      creator: null,
    };

    // online.db is authoritative for id and ranked status.
    const online = this.onlineBeatmaps([md5]).get(md5);
    if (online) {
      result.beatmapId = online.beatmapId;
      result.beatmapsetId = online.beatmapsetId;
      result.status = online.status;
    }

    // The .osu file fills in titles, and ids for maps online.db does not know about.
    if (result.osuPath) {
      const meta = parseOsuMetadata(result.osuPath);
      result.artist = meta.artist;
      result.title = meta.title;
      // '' for a file that carried neither, so the row is never read a second time for them.
      result.artistUnicode = meta.artistUnicode ?? '';
      result.titleUnicode = meta.titleUnicode ?? '';
      result.version = meta.version;
      result.creator = meta.creator;
      result.beatmapId ??= meta.beatmapId;
      result.beatmapsetId ??= meta.beatmapsetId;
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO beatmaps
         (md5, beatmap_id, beatmapset_id, artist, title, artist_unicode, title_unicode,
          version, creator, status, osu_path, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        md5,
        result.beatmapId,
        result.beatmapsetId,
        result.artist,
        result.title,
        result.artistUnicode,
        result.titleUnicode,
        result.version,
        result.creator,
        result.status,
        result.osuPath,
        Date.now(),
      );

    return result;
  }
}
