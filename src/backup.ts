import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, type Db } from './db/index.ts';
import { listProfiles } from './profiles.ts';
import { entryData, readZipEntries, writeZip } from './update/zip.ts';

/**
 * Backing up every profile, and restoring a backup.
 *
 * **A backup is `data/` as far as the profiles go**: the database, and the pictures and me!
 * images that live beside it as files rather than in it. The archive holds them under the
 * same names they have in `data/`, so "copy the data folder" and "Back up everything" are
 * the same thing, and a backup unzipped by hand into `data/` is a restore. `config.json` is
 * left out on purpose: it is this install's osu! paths, port and language, and would be
 * wrong on another machine.
 *
 * **A restore is applied at startup, never under a running app.** The open database handle
 * is shared by the tracker, the server and every cache stamped by `total_changes()`, so
 * swapping the file beneath them would leave each holding the old one. Instead the upload is
 * checked and staged in `data/restore/`, the app exits for its launcher to start it again
 * (the updater's exit code), and `applyPendingRestore` swaps the files before `openDb`.
 * Nothing is deleted: what was there moves to `data/before-restore-<time>/`.
 */

export const DB_FILE = 'profiles.db';
const RESTORE_DIR = 'restore';
const STAGED = 'files';
const READY = 'ready';
const ASIDE_PREFIX = 'before-restore-';

/** SQLite's own header, for a bare `.db` backup from before backups were zips. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Whether a path relative to `data/` is profile data, and so goes into a backup and comes
 * out of one. Everything else in a backup archive is ignored, so a restore can only ever
 * write these names.
 */
export function isProfileFile(relative: string): boolean {
  return (
    relative === DB_FILE ||
    /^profile-\d+-(avatar|cover)\.(png|jpe?g|webp|gif)$/i.test(relative) ||
    // The pre-profile pictures src/identity.ts still honours.
    /^(avatar|cover)\.(png|jpe?g|webp)$/i.test(relative) ||
    /^about-images\/\d+\/[\w.-]+$/.test(relative)
  );
}

/** Every file under `dir`, relative to it, with forward slashes. */
function filesUnder(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(dir, relative) : [relative];
  });
}

/** The pictures and me! images in `data/`: the profile data that is not the database. */
function profileImages(dataDir: string): string[] {
  const top = filesUnder(dataDir).filter((f) => !f.includes('/'));
  return [...top, ...filesUnder(dataDir, 'about-images')].filter((f) => f !== DB_FILE && isProfileFile(f));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-09-23`, in local time: the day on the user's own clock. */
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** `osu-local-profiles-backup-2026-09-23.zip`. */
export function backupFileName(at = new Date()): string {
  return `osu-local-profiles-backup-${localDay(at)}.zip`;
}

/**
 * The whole backup, as zip bytes.
 *
 * `VACUUM INTO` rather than reading the file: the database runs in WAL mode, so the .db on
 * disk is not self-contained and a plain copy can miss the most recent writes.
 */
export function createBackup(db: Db, dataDir: string, at = new Date()): Buffer {
  const snapshot = path.join(dataDir, `backup-${process.pid}-${at.getTime()}.db`);
  let database: Buffer;
  try {
    fs.rmSync(snapshot, { force: true });
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    database = fs.readFileSync(snapshot);
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
  return writeZip(
    [
      { name: DB_FILE, data: database },
      ...profileImages(dataDir).map((name) => ({ name, data: fs.readFileSync(path.join(dataDir, name)) })),
    ],
    at,
  );
}

export interface BackupSummary {
  /** Each profile with its play count, counted as Options -> Profiles counts it. */
  profiles: { name: string; plays: number }[];
  /** Pictures and me! images that came with it. */
  images: number;
}

/**
 * What a staged database holds, or an error saying why it is not one of this app's.
 *
 * The tables are checked on a read-only handle *before* `openDb` touches it, because
 * `openDb` creates every table it is missing -- it would turn any SQLite file at all into
 * an empty profile database and call that a backup.
 */
function summarise(file: string): Omit<BackupSummary, 'images'> {
  let probe: DatabaseSync;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new Error('the database in it could not be opened');
  }
  try {
    const check = probe.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
    if (check?.quick_check !== 'ok') throw new Error('the database in it is damaged');
    const tables = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    if (!tables.has('profiles') || !tables.has('scores')) {
      throw new Error('that is not an osu! local profiles backup');
    }
  } finally {
    probe.close();
  }

  // Brought up to this version's schema now, so a backup from an older release is known to
  // open before anything is swapped for it.
  const db = openDb(file);
  try {
    const profiles = listProfiles(db);
    if (profiles.length === 0) throw new Error('that backup has no profiles in it');
    return { profiles: profiles.map((p) => ({ name: p.name, plays: Number(p.scoreCount) })) };
  } finally {
    db.close();
  }
}

/**
 * Check an uploaded backup and stage it in `data/restore/`, without applying it.
 *
 * Takes the `.zip` "Back up everything" writes, or a bare `.db` from a version that wrote
 * those. Anything already staged is discarded first: only the latest upload can be applied.
 */
export function stageRestore(dataDir: string, upload: Buffer): BackupSummary {
  discardRestore(dataDir);
  const staged = path.join(dataDir, RESTORE_DIR, STAGED);
  fs.mkdirSync(staged, { recursive: true });

  try {
    let images = 0;
    if (upload.subarray(0, 4).equals(ZIP_MAGIC)) {
      let entries;
      try {
        entries = readZipEntries(upload);
      } catch (e) {
        throw new Error(`the zip file could not be read (${(e as Error).message})`);
      }
      for (const entry of entries) {
        if (entry.isDirectory || !isProfileFile(entry.name)) continue;
        const target = path.join(staged, ...entry.name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const data = entryData(upload, entry);
        if (data.length !== entry.size) throw new Error(`the zip file is damaged (${entry.name})`);
        fs.writeFileSync(target, data);
        if (entry.name !== DB_FILE) images += 1;
      }
    } else if (upload.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      fs.writeFileSync(path.join(staged, DB_FILE), upload);
    } else {
      throw new Error('that is not a backup: choose the .zip that Back up everything saved');
    }

    const database = path.join(staged, DB_FILE);
    if (!fs.existsSync(database)) throw new Error('that zip file has no profiles.db in it');
    return { ...summarise(database), images };
  } catch (e) {
    discardRestore(dataDir);
    throw e;
  }
}

/** Whether a checked backup is waiting to be applied. */
export function hasStagedRestore(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, RESTORE_DIR, STAGED, DB_FILE));
}

/** Ask for the staged backup to be applied at the next start. */
export function markRestoreReady(dataDir: string): void {
  if (!hasStagedRestore(dataDir)) throw new Error('no backup has been uploaded to restore');
  fs.writeFileSync(path.join(dataDir, RESTORE_DIR, READY), '');
}

export function discardRestore(dataDir: string): void {
  fs.rmSync(path.join(dataDir, RESTORE_DIR), { recursive: true, force: true });
}

export type RestoreResult =
  | { applied: false; error?: string }
  | { applied: true; aside: string };

/**
 * Swap a staged backup in, before the database is opened. Called once, at startup.
 *
 * Everything it replaces is moved, not deleted, to `data/before-restore-<time>/`, and if
 * any move fails every one already made is undone, so a restore either happens whole or
 * leaves `data/` as it was. Either way the staging folder goes: a backup that cannot be
 * applied must not be retried on every launch.
 */
export function applyPendingRestore(dataDir: string, at = new Date()): RestoreResult {
  const root = path.join(dataDir, RESTORE_DIR);
  const staged = path.join(root, STAGED);
  if (!fs.existsSync(path.join(root, READY)) || !hasStagedRestore(dataDir)) {
    // An upload nobody confirmed, left by a page that was closed.
    discardRestore(dataDir);
    return { applied: false };
  }

  const stamp = `${localDay(at)}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const aside = path.join(dataDir, `${ASIDE_PREFIX}${stamp}`);
  const moved: [from: string, to: string][] = [];
  const move = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved.push([from, to]);
  };

  try {
    const current = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, ...profileImages(dataDir)];
    for (const name of current) {
      const file = path.join(dataDir, ...name.split('/'));
      if (fs.existsSync(file)) move(file, path.join(aside, ...name.split('/')));
    }
    for (const name of filesUnder(staged)) {
      move(path.join(staged, ...name.split('/')), path.join(dataDir, ...name.split('/')));
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch {
        /* the aside folder still holds it, and the error below says where */
      }
    }
    discardRestore(dataDir);
    return { applied: false, error: (e as Error).message };
  }

  discardRestore(dataDir);
  return { applied: true, aside };
}
