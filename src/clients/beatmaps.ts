import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/index.ts';
import { openReadOnly } from '../db/index.ts';
import type { OsuInstall } from './detect.ts';

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

export function awardsPp(status: number | null | undefined): boolean {
  return status === Status.RANKED || status === Status.APPROVED;
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

/**
 * Build (or top up) the MD5 -> path index of local .osu files.
 *
 * lazer names every stored file by its SHA-256, so a score's beatmap MD5 cannot be turned
 * into a path without either this index or lazer's Realm database. Files in the store are
 * content-addressed and therefore immutable, so anything already indexed is never re-read.
 */
export function indexBeatmapFiles(
  db: Db,
  roots: string[],
  onProgress?: (scanned: number, indexed: number) => void,
): { scanned: number; indexed: number } {
  const known = new Set<string>();
  for (const r of db.prepare('SELECT path FROM osu_files').all() as { path: string }[]) {
    known.add(r.path);
  }
  for (const r of db.prepare('SELECT path FROM not_beatmaps').all() as { path: string }[]) {
    known.add(r.path);
  }

  const insertOsu = db.prepare(
    'INSERT OR REPLACE INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
  );
  const insertSkip = db.prepare('INSERT OR REPLACE INTO not_beatmaps (path, size) VALUES (?, ?)');

  let scanned = 0;
  let indexed = 0;
  db.exec('BEGIN');
  try {
    for (const root of roots) {
      for (const file of walk(root)) {
        if (known.has(file)) continue;
        scanned++;
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }

        if (!isBeatmapFile(file)) {
          insertSkip.run(file, size);
        } else {
          try {
            const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
            insertOsu.run(file, md5, size, Date.now());
            indexed++;
          } catch {
            /* unreadable, skip */
          }
        }
        if (scanned % 2000 === 0) onProgress?.(scanned, indexed);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  onProgress?.(scanned, indexed);
  return { scanned, indexed };
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

  for (const line of section.split(/\r?\n/)) {
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
 * Resolves a beatmap MD5 with no network access:
 *   local .osu index -> lazer's online.db -> the .osu file's own [Metadata] section.
 */
export class BeatmapResolver {
  private readonly onlineDbs: Db[] = [];
  private readonly db: Db;

  constructor(db: Db, installs: OsuInstall[]) {
    this.db = db;
    for (const i of installs) {
      if (!i.onlineDb) continue;
      const handle = openReadOnly(i.onlineDb);
      if (handle) this.onlineDbs.push(handle);
    }
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
