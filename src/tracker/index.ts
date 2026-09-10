import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.ts';
import type { OsuInstall } from '../clients/detect.ts';
import { BeatmapResolver, indexOneFile } from '../clients/beatmaps.ts';
import { ReplayWatcher } from './watcher.ts';
import { LogWatcher } from './log-watcher.ts';
import { logDirOf, type ResolvedLoggedPlay } from '../clients/lazer-log.ts';
import { ingestIncompletePlay, type IngestedIncomplete } from './incomplete.ts';
import { ingestReplayFile, type IngestedScore } from './ingest.ts';
import { scanForReplays, type BackfillScan } from './backfill.ts';
import { countStale, recomputeScores, type RecomputeResult } from './recompute.ts';
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
  /** A play osu! counted that finished without a score: a quit, a retry, or an HP fail. */
  incomplete: [IngestedIncomplete];
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
  private logWatcher: LogWatcher | null = null;
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

  /**
   * Point tracking at a different profile.
   *
   * Queued behind any ingest already in flight, so a score that landed a moment before the
   * switch is still written to the profile it was actually played under.
   */
  switchProfile(profileId: number, trackingSince: number): Promise<void> {
    return this.enqueue(async () => {
      this.opts.profileId = profileId;
      this.opts.trackingSince = trackingSince;
      this.added = 0;
    });
  }

  get profileId(): number {
    return this.opts.profileId;
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

    /*
     * The second half of detection. lazer writes a replay only for a map played to the end,
     * so a quit, a retry or an HP fail exists nowhere on disk except its own log -- and on
     * a real session those outnumbered the replays. Nothing is read unless the install is
     * lazer and its log directory is actually there.
     */
    const logDirs = this.opts.installs
      .map((i) => logDirOf(i))
      .filter((d): d is string => d !== null);
    if (logDirs.length > 0) {
      this.logWatcher = new LogWatcher({
        dirs: logDirs,
        onPlays: (plays) => this.handleLoggedPlays(plays),
        onError: (e) => this.emit('error', e),
      });
      this.logWatcher.start();
    }

    this.enabled = true;
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.logWatcher?.stop();
    this.logWatcher = null;
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

  /**
   * How many stored scores predate the eligibility columns, so the page can offer a
   * recompute only when there is something to gain from it.
   */
  get staleScores(): number {
    return countStale(this.opts.db, this.opts.profileId);
  }

  /**
   * Recalculate stored scores from their replays. Queued like everything else, so a play
   * landing mid-recompute is ingested before or after it, never during.
   */
  recompute(
    onlyMissing: boolean,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RecomputeResult> {
    return this.enqueue(async () => {
      if (!this.opts.official) {
        // Without the calculator this would blank every pp value it touched.
        throw new Error('the pp calculator is not available -- run: npm run build:pp');
      }
      return await recomputeScores({
        db: this.opts.db,
        resolver: this.opts.resolver,
        profileId: this.opts.profileId,
        official: this.opts.official,
        onlyMissing,
        onProgress,
      });
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

  /**
   * Record the plays osu! counted that left no replay.
   *
   * Queued behind replay ingestion like everything else -- and it has to be, because a
   * passing play in the same batch is only recognised as one by the score its replay
   * writes, so the two must never be in flight together.
   */
  private handleLoggedPlays(plays: ResolvedLoggedPlay[]): void {
    this.queue = this.queue
      .then(() => {
        for (const play of plays) {
          const result = ingestIncompletePlay(play, {
            db: this.opts.db,
            resolver: this.opts.resolver,
            profileId: this.opts.profileId,
            trackingSince: this.opts.trackingSince,
          });
          if (result.status === 'added') this.emit('incomplete', result.play);
          // A passed play is not a skip worth reporting: its replay is the event.
          else if (result.reason !== 'passed') this.emit('skip', { reason: result.reason });
        }
      })
      .catch((e: unknown) => {
        this.emit('error', e as Error);
      });
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
