import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { indexOneFile } from '../clients/beatmaps.ts';
import { watchablePath } from './watcher.ts';

/** How long a set folder must go without another change before its beatmaps are read. */
const SETTLE_MS = 1500;

/** Set folders remembered for `flush`: plenty for a session, and a bound on what it re-reads. */
const RECENT_LIMIT = 100;

export interface SongsWatcherOptions {
  db: Db;
  /** osu!stable `Songs` folders (McOsu's is usually the same one). */
  roots: string[];
  onError?: (err: Error) => void;
}

/**
 * Keeps the beatmap index current for osu!stable while the app runs.
 *
 * lazer puts a new beatmap into the file store the replay watcher already watches, so it is
 * indexed the moment it lands. stable extracts one into a new folder under `Songs`, which
 * nothing watched -- and the index only walks `Songs` at launch. A map downloaded mid-session
 * (osu!direct, and every multiplayer pick you did not have) was played before the app knew
 * its file, and the score was stored as "Unknown beatmap" with no pp.
 *
 * The watch is on `Songs` itself, not recursive. A new or changed set folder is an entry of
 * `Songs`, which is all this needs to hear about, and one watch stays one watch however many
 * thousand sets there are -- a recursive one on Linux is an inotify watch per folder, which a
 * large library would run out of (see `explainWatchError`).
 */
export class SongsWatcher {
  private readonly opts: SongsWatcherOptions;
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** Folders touched this session, oldest first, for `flush` to read again. */
  private readonly recent = new Set<string>();

  constructor(opts: SongsWatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    for (const root of this.opts.roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const w = fs.watch(watchablePath(root), (_event, filename) => {
          if (filename) this.touched(path.join(root, filename.toString()));
        });
        w.on('error', (e) => this.opts.onError?.(e as Error));
        this.watchers.push(w);
      } catch (e) {
        this.opts.onError?.(e as Error);
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.length = 0;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.recent.clear();
  }

  /**
   * Read every set folder touched this session again, now: a beatmap is being looked up and
   * has no file yet. The timer may not have fired, or may have fired while osu! was still
   * extracting the set -- the order it writes a set's files in is not the order this needs.
   */
  flush(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const entry of this.recent) this.read(entry);
  }

  private touched(entry: string): void {
    this.recent.delete(entry);
    this.recent.add(entry);
    if (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.values().next().value!);

    const existing = this.pending.get(entry);
    if (existing) clearTimeout(existing);
    this.pending.set(
      entry,
      setTimeout(() => {
        this.pending.delete(entry);
        this.read(entry);
      }, SETTLE_MS),
    );
  }

  /** Index the `.osu` files of a set folder, or a loose `.osu` dropped into `Songs`. */
  private read(entry: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry);
    } catch {
      return; // gone again: a temporary file, or a set being replaced
    }
    if (stat.isFile()) {
      if (isOsu(entry)) this.index(entry, stat.size);
      return;
    }
    let names: string[];
    try {
      names = fs.readdirSync(entry);
    } catch {
      return;
    }
    // A set's difficulties sit at its top level; nothing osu! plays is deeper.
    for (const name of names) {
      if (!isOsu(name)) continue;
      const file = path.join(entry, name);
      try {
        this.index(file, fs.statSync(file).size);
      } catch {
        /* gone since it was listed */
      }
    }
  }

  /**
   * Index one `.osu`, unless it is already indexed as it is. `flush` reads the same folders
   * again on every miss, and a write for nothing would still count as a change to the
   * database -- which is what invalidates the page's cached profile.
   */
  private index(file: string, size: number): void {
    const known = this.opts.db.prepare('SELECT size FROM osu_files WHERE path = ?').get(file) as
      | { size: number }
      | undefined;
    if (known?.size !== size) indexOneFile(this.opts.db, file);
  }
}

const isOsu = (name: string) => name.toLowerCase().endsWith('.osu');
