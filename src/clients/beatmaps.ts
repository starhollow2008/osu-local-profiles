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

/** One difficulty of a beatmapset, as lazer's `online.db` records it. */
export interface OnlineSetBeatmap {
  beatmapId: number;
  md5: string | null;
  version: string | null;
  userId: number | null;
  status: number | null;
}

export interface ResolvedBeatmap {
  md5: string;
  osuPath: string | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
  status: number | null;
  artist: string | null;
  title: string | null;
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
  for (const r of db.prepare('SELECT path FROM osu_files').all() as { path: string }[]) {
    known.add(r.path);
  }
  const firstRun = known.size === 0;
  for (const r of db.prepare('SELECT path FROM not_beatmaps').all() as { path: string }[]) {
    known.add(r.path);
  }

  const insertOsu = db.prepare(
    'INSERT OR REPLACE INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
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
            const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
            write(insertOsu, file, md5, size, Date.now());
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
    const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    db.prepare(
      'INSERT OR REPLACE INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
    ).run(file, md5, fs.statSync(file).size, Date.now());
  } catch {
    /* ignore */
  }
}

interface OsuMetadata {
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  beatmapId: number | null;
  beatmapsetId: number | null;
}

function parseOsuMetadata(file: string): OsuMetadata {
  const out: OsuMetadata = {
    artist: null,
    title: null,
    version: null,
    creator: null,
    beatmapId: null,
    beatmapsetId: null,
  };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const start = text.indexOf('[Metadata]');
  if (start < 0) return out;
  const nextSection = text.indexOf('[', start + 1);
  const section = text.slice(start, nextSection < 0 ? undefined : nextSection);

  for (const line of section.split(NEWLINE)) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === 'Artist') out.artist = value;
    else if (key === 'Title') out.title = value;
    else if (key === 'Version') out.version = value;
    else if (key === 'Creator') out.creator = value;
    else if (key === 'BeatmapID') out.beatmapId = Number(value) || null;
    else if (key === 'BeatmapSetID') out.beatmapsetId = Number(value) || null;
  }
  return out;
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

  const start = text.indexOf('[General]');
  if (start < 0) return 0;
  // The next section header, so a `Mode:` further down the file cannot be picked up.
  const nextSection = text.indexOf('[', start + 1);
  const section = text.slice(start, nextSection < 0 ? undefined : nextSection);

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
  private readonly onlineDbs: Db[] = [];
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
    return this.onlineDbs.length > 0;
  }

  constructor(db: Db, installs: OsuInstall[]) {
    this.db = db;
    for (const i of installs) {
      if (!i.onlineDb) continue;
      const handle = openReadOnly(i.onlineDb);
      if (handle) this.onlineDbs.push(handle);
    }
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
    // A map already cached locally answers without opening online.db at all.
    const cached = this.db
      .prepare('SELECT md5 FROM beatmaps WHERE beatmap_id = ? LIMIT 1')
      .get(beatmapId) as { md5: string } | undefined;
    if (cached) return cached.md5;

    for (const online of this.onlineDbs) {
      const row = online
        .prepare('SELECT checksum FROM osu_beatmaps WHERE beatmap_id = ?')
        .get(beatmapId) as { checksum: string | null } | undefined;
      if (row?.checksum) return row.checksum;
    }
    return null;
  }

  /**
   * Every difficulty of a beatmapset that lazer's `online.db` knows, for a Favorite
   * Beatmaps card built without a network. `online.db` has no star ratings or modes, only
   * ids, checksums, the `.osu` filename (which carries the difficulty name) and the status.
   */
  beatmapsInSet(beatmapsetId: number): OnlineSetBeatmap[] {
    for (const online of this.onlineDbs) {
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
      if (rows.length === 0) continue;
      return rows.map((r) => ({
        beatmapId: r.beatmap_id,
        md5: r.checksum,
        // `Artist - Title (Creator) [Version].osu`: the version is the last bracketed part.
        version: /\[([^\]]*)\]\.osu$/i.exec(r.filename ?? '')?.[1] ?? null,
        userId: r.user_id,
        status: r.approved,
      }));
    }
    return [];
  }

  /** A mapper's username from `online.db`'s `users` table, or null. */
  username(userId: number): string | null {
    for (const online of this.onlineDbs) {
      try {
        const row = online.prepare('SELECT username FROM users WHERE user_id = ?').get(userId) as
          | { username: string }
          | undefined;
        if (row?.username) return row.username;
      } catch {
        /* an older online.db without the table */
      }
    }
    return null;
  }

  resolve(md5: string): ResolvedBeatmap {
    const cached = this.db.prepare('SELECT * FROM beatmaps WHERE md5 = ?').get(md5) as
      | Record<string, string | number | null>
      | undefined;
    if (cached) {
      return {
        md5,
        osuPath: (cached['osu_path'] as string | null) ?? null,
        beatmapId: (cached['beatmap_id'] as number | null) ?? null,
        beatmapsetId: (cached['beatmapset_id'] as number | null) ?? null,
        status: (cached['status'] as number | null) ?? null,
        artist: (cached['artist'] as string | null) ?? null,
        title: (cached['title'] as string | null) ?? null,
        version: (cached['version'] as string | null) ?? null,
        creator: (cached['creator'] as string | null) ?? null,
      };
    }

    const fileRow = this.db
      .prepare('SELECT path FROM osu_files WHERE md5 = ? LIMIT 1')
      .get(md5) as { path: string } | undefined;

    const result: ResolvedBeatmap = {
      md5,
      osuPath: fileRow?.path ?? null,
      beatmapId: null,
      beatmapsetId: null,
      status: null,
      artist: null,
      title: null,
      version: null,
      creator: null,
    };

    // online.db is authoritative for id and ranked status.
    for (const online of this.onlineDbs) {
      const row = online
        .prepare(
          'SELECT beatmap_id, beatmapset_id, approved FROM osu_beatmaps WHERE checksum = ?',
        )
        .get(md5) as
        | { beatmap_id: number; beatmapset_id: number; approved: number }
        | undefined;
      if (row) {
        result.beatmapId = row.beatmap_id;
        result.beatmapsetId = row.beatmapset_id;
        result.status = row.approved;
        break;
      }
    }

    // The .osu file fills in titles, and ids for maps online.db does not know about.
    if (result.osuPath) {
      const meta = parseOsuMetadata(result.osuPath);
      result.artist = meta.artist;
      result.title = meta.title;
      result.version = meta.version;
      result.creator = meta.creator;
      result.beatmapId ??= meta.beatmapId;
      result.beatmapsetId ??= meta.beatmapsetId;
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO beatmaps
         (md5, beatmap_id, beatmapset_id, artist, title, version, creator, status, osu_path, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        md5,
        result.beatmapId,
        result.beatmapsetId,
        result.artist,
        result.title,
        result.version,
        result.creator,
        result.status,
        result.osuPath,
        Date.now(),
      );

    return result;
  }
}
