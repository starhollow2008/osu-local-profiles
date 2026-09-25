import fs from 'node:fs';
import path from 'node:path';
import {
  buildMcosuReplay,
  builtReplayPath,
  McosuVersionError,
  mcosuScoreFiles,
  parseMcosuScores,
  type McosuScore,
} from '../clients/mcosu.ts';
import { watchablePath } from './watcher.ts';

/**
 * McOsu plays, from McOsu's `scores.db`, as replays the rest of the tracker can take.
 *
 * McOsu keeps no replay and no log, only this database, which it rewrites whole after every
 * finished play. So "a new play" is an entry the file did not have before, and each one is
 * turned into a built replay under `data/mcosu/` (src/clients/mcosu.ts) and handed on like
 * any replay osu! wrote. See that module for why a built replay rather than anything else.
 */

/** How long after the last change to read the file: McOsu writes it in one go, but not atomically. */
const SETTLE_MS = 300;
/** A read that finds the file cut short is a write in progress; try again, but not for ever. */
const READ_ATTEMPTS = 10;

/** One play's identity inside McOsu: the beatmap, and the second it ended. */
const entryKey = (score: McosuScore) => `${score.beatmapMD5}:${score.playedAt}`;

/**
 * Read one McOsu scores file, waiting out a write in progress. An absent file is no plays --
 * McOsu creates it with its first. A newer format than this app knows is thrown as
 * `McosuVersionError`, which the caller reports rather than guessing at.
 */
export async function readMcosuScores(file: string): Promise<McosuScore[]> {
  for (let attempt = 0; ; attempt++) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return [];
    }
    if (buf.length === 0) return [];
    try {
      return parseMcosuScores(buf);
    } catch (e) {
      if (e instanceof McosuVersionError || attempt >= READ_ATTEMPTS - 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    }
  }
}

/**
 * The built replay for one play, written if it is not there already. A replay already built
 * is left alone: it is the same play, and rewriting it would only move its mtime.
 */
export function buildReplay(dir: string, score: McosuScore): string {
  const file = builtReplayPath(dir, score);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buildMcosuReplay(score));
  }
  return file;
}

/**
 * Build the replay for every McOsu play at or after `since` that is a McOsu play at all --
 * never the osu!stable scores McOsu copied in, which are stable's to track.
 *
 * For Import past plays, which then scans `dir` like any replay folder. Writes only into the
 * app's own `data/mcosu/`, never into McOsu's folder.
 */
export async function buildMcosuReplays(root: string, dir: string, since: number): Promise<string[]> {
  const built: string[] = [];
  for (const file of mcosuScoreFiles(root)) {
    for (const score of await readMcosuScores(file)) {
      if (score.importedLegacy || score.playedAt < since) continue;
      built.push(buildReplay(dir, score));
    }
  }
  return built;
}

export interface McosuWatcherOptions {
  /** The McOsu folder, whose `scores.db` and `scoresvr.db` are watched. */
  root: string;
  /** Where built replays go: `data/mcosu/`. */
  dir: string;
  onReplay: (file: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Watches McOsu's scores files and hands on each play that appears in one.
 *
 * What is already in the files when it starts is remembered and never handed on: live
 * tracking begins at the launch, and a play from before it is Import past plays' business.
 * The tracker's own cutoff would turn those away anyway; this keeps them from being built.
 */
export class McosuWatcher {
  private readonly opts: McosuWatcherOptions;
  private readonly known = new Map<string, Set<string>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private watcher: fs.FSWatcher | null = null;
  private running = false;
  /** Said once: a McOsu too new to read stays too new until this app is updated. */
  private reportedVersion = false;

  constructor(opts: McosuWatcherOptions) {
    this.opts = opts;
  }

  /** Resolves once the files have been read, so what is already there is never taken as new. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const file of mcosuScoreFiles(this.opts.root)) {
      const keys = new Set<string>();
      try {
        for (const score of await readMcosuScores(file)) keys.add(entryKey(score));
      } catch (e) {
        this.report(e as Error);
      }
      this.known.set(path.basename(file).toLowerCase(), keys);
    }
    if (!this.running) return;

    try {
      // The folder rather than the file: McOsu may not have created scores.db yet, and a
      // rewritten file can come back as a new one that a watch on the old one would miss.
      // See `watchablePath` -- an unresolved path here aborts the process on Windows.
      this.watcher = fs.watch(watchablePath(this.opts.root), (_event, filename) => {
        if (!filename) return;
        const name = filename.toString().toLowerCase();
        if (this.known.has(name)) this.queue(name);
      });
      this.watcher.on('error', (e) => this.opts.onError?.(e as Error));
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
  }

  stop(): void {
    this.running = false;
    try {
      this.watcher?.close();
    } catch {
      /* ignore */
    }
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** Debounce: one rewrite of the file is several change events. */
  private queue(name: string): void {
    const existing = this.pending.get(name);
    if (existing) clearTimeout(existing);
    this.pending.set(
      name,
      setTimeout(() => void this.read(name), SETTLE_MS),
    );
  }

  private async read(name: string): Promise<void> {
    this.pending.delete(name);
    if (!this.running) return;
    let scores: McosuScore[];
    try {
      scores = await readMcosuScores(path.join(this.opts.root, name));
    } catch (e) {
      this.report(e as Error);
      return;
    }
    if (!this.running) return;

    const known = this.known.get(name)!;
    for (const score of scores) {
      const key = entryKey(score);
      if (known.has(key)) continue;
      known.add(key);
      if (score.importedLegacy) continue;
      try {
        this.opts.onReplay(buildReplay(this.opts.dir, score));
      } catch (e) {
        this.opts.onError?.(e as Error);
      }
    }
  }

  private report(e: Error): void {
    if (e instanceof McosuVersionError) {
      if (this.reportedVersion) return;
      this.reportedVersion = true;
    }
    this.opts.onError?.(e);
  }
}
