import fs from 'node:fs';
import path from 'node:path';
import { watchablePath } from './watcher.ts';
import {
  LogSession,
  listLogSessions,
  parseSubmissionBeatmaps,
  type LoggedPlay,
  type LogSessionFiles,
  type ResolvedLoggedPlay,
  type SessionAttempt,
} from '../clients/lazer-log.ts';

/** A single write produces several change events; wait for them to stop. */
const SETTLE_MS = 400;

/**
 * How much of the network log to re-read when looking up a token.
 *
 * Only the tail can matter: the submission that names a beatmap is written within a second
 * of the play being reported, so the answer is always at the very end of the file. A cap
 * keeps this bounded no matter how long the session has been running -- these reach a
 * megabyte over an evening.
 */
const NETWORK_TAIL_BYTES = 512 * 1024;

export interface LogWatcherOptions {
  /** lazer log directories, one per install. */
  dirs: string[];
  onPlays: (plays: ResolvedLoggedPlay[]) => void;
  /**
   * Attempts osu! logged it had no token for -- offline, signed out, or an unsubmittable
   * beatmap. Optional, so a caller that only wants what osu! counted need not handle them.
   */
  onAttempts?: (attempts: SessionAttempt[]) => void;
  onError?: (err: Error) => void;
}

interface Followed {
  /** The `<unix seconds>` lazer named the session with; only ever moves forward. */
  id: string;
  runtime: string;
  network: string | null;
  /** Bytes of the runtime log already consumed. */
  offset: number;
  /** A read can stop mid-line; the remainder waits here for the rest of it to arrive. */
  partial: string;
  session: LogSession;
}

function readFrom(file: string, offset: number): { text: string; next: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    // A shrinking file is a different file: lazer rotating, or the log being cleared.
    if (size < offset) return { text: '', next: 0 };
    if (size === offset) return { text: '', next: offset };
    const buf = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.subarray(0, read).toString('utf8'), next: offset + read };
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

function readTail(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - from);
    const read = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
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

/**
 * Follows osu!lazer's session log so that plays leaving no replay are still seen.
 *
 * Only appends count. Following starts at the *current end* of the log rather than its
 * beginning, for the same reason the replay watcher never scans the store on startup: a
 * profile is a record of what was played while it was tracking, and reading back through a
 * log written before the app opened would retroactively import an evening of plays nobody
 * asked for. Importing the past stays an explicit, previewed action.
 *
 * lazer opens one `<unix seconds>.runtime.log` per launch and appends for the life of the
 * session, so there is exactly one file worth following at a time -- but the game may be
 * started and restarted underneath a running app, which is why a newer session takes over.
 */
export class LogWatcher {
  private readonly opts: LogWatcherOptions;
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly followed = new Map<string, Followed>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(opts: LogWatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const dir of this.opts.dirs) {
      if (!fs.existsSync(dir)) continue;

      // Take up the session already in progress at its current end, so the first play read
      // is one played after this moment.
      const sessions = listLogSessions(dir);
      const latest = sessions[sessions.length - 1];
      if (latest) this.follow(dir, latest, fileSize(latest.runtime));

      try {
        // See `watchablePath`: an unresolved path here aborts the process on Windows.
        const w = fs.watch(watchablePath(dir), (_event, filename) => {
          if (!filename) return;
          this.queue(dir, filename.toString());
        });
        w.on('error', (e) => this.opts.onError?.(e as Error));
        this.watchers.push(w);
      } catch (e) {
        this.opts.onError?.(e as Error);
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.length = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.followed.clear();
  }

  private follow(dir: string, files: LogSessionFiles, offset: number): void {
    this.followed.set(dir, {
      id: files.id,
      runtime: files.runtime,
      network: files.network,
      offset,
      partial: '',
      session: new LogSession(),
    });
  }

  private queue(dir: string, filename: string): void {
    if (!/^\d+\.(runtime|network)\.log$/.test(path.basename(filename))) return;
    const existing = this.timers.get(dir);
    if (existing) clearTimeout(existing);
    this.timers.set(
      dir,
      setTimeout(() => {
        this.timers.delete(dir);
        this.read(dir);
      }, SETTLE_MS),
    );
  }

  private read(dir: string): void {
    if (!this.running) return;

    try {
      this.switchSessionIfNewer(dir);

      const follow = this.followed.get(dir);
      if (!follow) return;

      const chunk = readFrom(follow.runtime, follow.offset);
      if (!chunk) return;
      if (chunk.next < follow.offset) {
        // The file was replaced under us; start again from where it now ends.
        follow.offset = chunk.next;
        follow.partial = '';
        return;
      }
      follow.offset = chunk.next;
      if (!chunk.text) return;

      const lines = (follow.partial + chunk.text).split(/\r?\n/);
      // The last element is whatever came after the final newline: either an empty string,
      // or the start of a line still being written.
      follow.partial = lines.pop() ?? '';

      const { plays, attempts } = follow.session.feedEvents(lines);
      if (plays.length > 0) this.opts.onPlays(this.attachBeatmaps(follow, plays));
      // The session id is what makes an attempt unique: it has no token to be keyed by.
      if (attempts.length > 0) {
        this.opts.onAttempts?.(attempts.map((a) => ({ ...a, session: follow.id })));
      }
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
  }

  /** Take over a session started after this one, e.g. the game being restarted. */
  private switchSessionIfNewer(dir: string): void {
    const sessions = listLogSessions(dir);
    const latest = sessions[sessions.length - 1];
    if (!latest) return;

    const follow = this.followed.get(dir);
    // Strictly newer only. Anything else -- the same session, or an older file that somehow
    // sorted last -- must not restart a read, or a finished session would be replayed from
    // the top and every play in it counted again.
    if (follow && Number(latest.id) <= Number(follow.id)) return;

    // A session that began while this app was running is followed from its first line:
    // every play in it was played under tracking.
    this.follow(dir, latest, 0);
  }

  /**
   * Attach the beatmap each play was submitted against.
   *
   * The token is the join: the submission `PUT` in the network log is the one place lazer
   * writes a token and a beatmap id together. Multiplayer submits through a different URL
   * and so resolves to nothing here, which costs nothing -- a multiplayer play is always
   * imported as a replay and is dropped by the caller regardless.
   */
  private attachBeatmaps(follow: Followed, plays: LoggedPlay[]): ResolvedLoggedPlay[] {
    const wanted = plays.filter((p) => !p.passed);
    const ids =
      wanted.length > 0 && follow.network
        ? parseSubmissionBeatmaps(readTail(follow.network, NETWORK_TAIL_BYTES))
        : new Map<string, number>();

    return plays.map((play) => ({ ...play, beatmapId: ids.get(play.token) ?? null }));
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
