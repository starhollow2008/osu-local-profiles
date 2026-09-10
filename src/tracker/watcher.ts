import fs from 'node:fs';
import path from 'node:path';
import { looksLikeReplay } from '../osr.ts';

/** How long a file's size must stay unchanged before we treat the write as finished. */
const SETTLE_MS = 250;
const SETTLE_ATTEMPTS = 20;

export interface WatcherOptions {
  dirs: string[];
  onReplay: (file: string) => void;
  /** Called for every settled new file, replay or not (used to index new beatmaps). */
  onOtherFile?: (file: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Turn a watch failure into something worth reading.
 *
 * This exists for one error in particular. On Windows a recursive `fs.watch` is a single
 * `ReadDirectoryChangesW` handle for the whole tree; on Linux the kernel watches one
 * directory at a time, so Node implements recursion by adding an inotify watch per
 * directory -- and lazer's store is about 4,000 sharded directories. On a system whose
 * `max_user_watches` is low, that fails with `ENOSPC`, which reads as "the disk is full"
 * and means nothing of the sort. Someone hitting this deserves to be told the actual fix
 * rather than left to search for it.
 */
export function explainWatchError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC' && process.platform === 'linux') {
    return (
      `${err.message}\n` +
      "  This is the inotify watch limit, not disk space: osu!lazer's file store is\n" +
      '  thousands of directories and Linux watches them one at a time. Raise it with:\n' +
      '    sudo sysctl fs.inotify.max_user_watches=524288\n' +
      '  (add it to /etc/sysctl.conf to keep it across reboots)'
    );
  }
  return err.message;
}

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

/**
 * Watches the osu! client's storage for newly written replays.
 *
 * osu!lazer drops every file it stores -- beatmaps, audio, skins, replays -- into one
 * content-addressed tree of ~4000 sharded directories with hash names and no extensions,
 * so the watch is recursive and each new file is identified by its magic bytes rather than
 * its path. On Windows a recursive `fs.watch` is a single ReadDirectoryChangesW handle for
 * the whole tree, which is why this scales where per-directory watching would not.
 */
export class ReplayWatcher {
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly seen = new Set<string>();
  private readonly opts: WatcherOptions;
  private running = false;

  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const dir of this.opts.dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          this.queue(path.join(dir, filename.toString()));
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
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** Debounce: a single write produces several change events. */
  private queue(file: string): void {
    if (this.seen.has(file)) return;
    const existing = this.pending.get(file);
    if (existing) clearTimeout(existing);
    this.pending.set(
      file,
      setTimeout(() => void this.settle(file, 0, -1), SETTLE_MS),
    );
  }

  /** Wait for the file's size to stop changing, so we never parse a half-written replay. */
  private settle(file: string, attempt: number, lastSize: number): void {
    this.pending.delete(file);
    if (!this.running) return;

    let size: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      return; // vanished, or a directory event
    }

    if (size === 0 || size !== lastSize) {
      if (attempt >= SETTLE_ATTEMPTS) return;
      this.pending.set(
        file,
        setTimeout(() => void this.settle(file, attempt + 1, size), SETTLE_MS),
      );
      return;
    }

    if (this.seen.has(file)) return;
    this.seen.add(file);

    const head = readHead(file, 8);
    if (head && looksLikeReplay(head)) this.opts.onReplay(file);
    else this.opts.onOtherFile?.(file);
  }

  /**
   * Mark files as already-processed so a restart does not re-emit them. The tracker also
   * filters by timestamp, but this keeps the work down.
   */
  markSeen(files: Iterable<string>): void {
    for (const f of files) this.seen.add(f);
  }
}
