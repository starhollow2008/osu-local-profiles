import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.ts';
import type { OsuInstall } from '../clients/detect.ts';
import { BeatmapResolver, indexOneFile } from '../clients/beatmaps.ts';
import { ReplayWatcher } from './watcher.ts';
import { ingestReplayFile, type IngestedScore } from './ingest.ts';
import { scanForReplays, type BackfillScan } from './backfill.ts';
import type { OfficialCalculator } from '../calc/official.ts';

export interface TrackerOptions {
  db: Db;
  resolver: BeatmapResolver;
  installs: OsuInstall[];
  profileId: number;
  trackingSince: number;
  /** osu!'s own pp calculator. When null, scores are stored with no pp rather than a guess. */
  official: OfficialCalculator | null;
}

export interface TrackerEvents {
  score: [IngestedScore];
  skip: [{ reason: string }];
  error: [Error];
}

export interface BackfillResult {
  imported: number;
  /** Already tracked, or rejected by the parser. */
  skipped: number;
  scanned: number;
  since: number;
}

/**
 * Watches every detected osu! install and turns new replays into tracked scores.
 *
 * Detection is entirely local, so this works with the game logged out -- which matters
 * because an offline play is never submitted and therefore never appears in the osu! API,
 * not even after reconnecting.
 */
export class Tracker extends EventEmitter<TrackerEvents> {
  private readonly opts: TrackerOptions;
  private watcher: ReplayWatcher | null = null;
  private enabled = false;
  /** Serialises ingestion so two replays landing together cannot interleave writes. */
  private queue: Promise<void> = Promise.resolve();
  private added = 0;

  constructor(opts: TrackerOptions) {
    super();
    this.opts = opts;
  }

  get isTracking(): boolean {
    return this.enabled;
  }

  get scoresAdded(): number {
    return this.added;
  }

  /**
   * Move the cutoff forward after a profile reset. Without this the watcher would keep
   * accepting replays from before the reset, quietly refilling the profile it just cleared.
   */
  setTrackingSince(at: number): void {
    this.opts.trackingSince = at;
    this.added = 0;
  }

  start(): void {
    if (this.watcher) return;
    const dirs = this.opts.installs.map((i) => i.replayDir);
    this.watcher = new ReplayWatcher({
      dirs,
      onReplay: (file) => this.handleReplay(file),
      // A brand new beatmap can arrive moments before the first score on it.
      onOtherFile: (file) => indexOneFile(this.opts.db, file),
      onError: (e) => this.emit('error', e),
    });
    this.watcher.start();
    this.enabled = true;
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.enabled = false;
  }

  setTracking(on: boolean): void {
    if (on) this.start();
    else this.stop();
  }

  /** Preview what an import would bring in, without changing anything. */
  previewBackfill(since: number): Promise<BackfillScan> {
    return this.enqueue(() =>
      scanForReplays(this.opts.db, this.opts.profileId, this.replayDirs(), since),
    );
  }

  /**
   * Import replays played since `since`.
   *
   * Runs through the same serialised queue as live ingestion, so a play landing mid-import
   * cannot interleave its writes. Individual scores are not emitted: importing a session
   * can add dozens at once, and a toast per score would bury the page.
   */
  backfill(since: number): Promise<BackfillResult> {
    return this.enqueue(async () => {
      const scan = await scanForReplays(
        this.opts.db,
        this.opts.profileId,
        this.replayDirs(),
        since,
      );

      let imported = 0;
      let skipped = 0;
      for (const candidate of scan.candidates) {
        if (candidate.duplicate) {
          skipped++;
          continue;
        }
        const result = await ingestReplayFile(candidate.file, {
          db: this.opts.db,
          resolver: this.opts.resolver,
          profileId: this.opts.profileId,
          // The chosen cutoff replaces the profile's own, which is the whole point: these
          // are plays from before tracking started that the user has asked for by hand.
          trackingSince: since,
          official: this.opts.official,
        });
        if (result.status === 'added') {
          imported++;
          this.added++;
        } else {
          skipped++;
        }
      }

      return { imported, skipped, scanned: scan.scanned, since };
    });
  }

  private replayDirs(): string[] {
    return this.opts.installs.map((i) => i.replayDir);
  }

  /** Append to the ingest queue and hand back this task's own result. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    // The queue itself must survive a failed task, or every later ingest is rejected too.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private handleReplay(file: string): void {
    this.queue = this.queue
      .then(async () => {
        const result = await ingestReplayFile(file, {
          db: this.opts.db,
          resolver: this.opts.resolver,
          profileId: this.opts.profileId,
          trackingSince: this.opts.trackingSince,
          official: this.opts.official,
        });
        if (result.status === 'added') {
          this.added++;
          this.emit('score', result.score);
        } else {
          this.emit('skip', { reason: result.reason });
        }
      })
      .catch((e: unknown) => {
        this.emit('error', e as Error);
      });
  }
}
