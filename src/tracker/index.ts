import { EventEmitter } from 'node:events';
import type { Db } from '../db/index.ts';
import type { OsuInstall } from '../clients/detect.ts';
import {
  BeatmapResolver,
  indexBeatmapFiles,
  indexOneFile,
  type IndexProgress,
  type IndexRoot,
} from '../clients/beatmaps.ts';
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
  /** How far the beatmap index has got; sent while it runs and once when it finishes. */
  indexing: [IndexState];
}

/** The beatmap index, as the page shows it. */
export interface IndexState extends IndexProgress {
  active: boolean;
  /** Whether the page should say so: always on a first run, otherwise only once it is slow. */
  visible: boolean;
  /** Plays that arrived meanwhile and are held until the index can price them. */
  waiting: number;
  error: string | null;
}

/**
 * How long a routine re-check of the index may take before the page mentions it. Every start
 * walks the store for new beatmaps, which is normally well under a second, and a notice that
 * flashes up and vanishes on every launch would only teach people to ignore it.
 */
const QUIET_INDEX_MS = 1500;

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
  private index: IndexState = {
    active: false,
    visible: false,
    phase: 'indexing',
    scanned: 0,
    total: 0,
    indexed: 0,
    firstRun: false,
    waiting: 0,
    error: null,
  };

  constructor(opts: TrackerOptions) {
    super();
    this.opts = opts;
  }

  /** The beatmap resolver the tracker ingests with, shared so nothing opens online.db twice. */
  get beatmaps(): BeatmapResolver {
    return this.opts.resolver;
  }

  get isTracking(): boolean {
    return this.enabled;
  }

  get scoresAdded(): number {
    return this.added;
  }

  get indexState(): IndexState {
    return { ...this.index };
  }

  /**
   * Build the beatmap index in the background, and hold every play until it is done.
   *
   * The index is what turns a score's beatmap into a `.osu` file, and so into pp, a title and
   * a length. Resolving a beatmap before its file is indexed would cache "not found" for good
   * and leave that score without pp -- so the queue waits on this, and a score set during a
   * first launch is added, priced, the moment the index finishes rather than being lost or
   * stored without pp. The page is up meanwhile and says what is happening.
   */
  indexBeatmaps(roots: IndexRoot[]): Promise<void> {
    const started = performance.now();
    let lastEmit = 0;
    this.index = { ...this.index, active: true, visible: false, error: null };
    const report = (final = false) => {
      this.index.visible =
        this.index.active && (this.index.firstRun || performance.now() - started > QUIET_INDEX_MS);
      const now = performance.now();
      if (final || now - lastEmit >= 250) {
        lastEmit = now;
        this.emit('indexing', this.indexState);
      }
    };

    const run = indexBeatmapFiles(this.opts.db, roots, (p) => {
      Object.assign(this.index, p);
      report();
    }).then(
      () => undefined,
      (e: unknown) => {
        this.index.error = (e as Error).message;
        this.emit('error', e as Error);
      },
    ).finally(() => {
      this.index.active = false;
      this.index.waiting = 0;
      report(true);
    });

    this.queue = this.queue.then(() => run);
    return run;
  }

  /** A play has arrived and is queued; while the index runs, the page counts it as waiting. */
  private arrived(): void {
    if (!this.index.active) return;
    this.index.waiting++;
    this.emit('indexing', this.indexState);
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

  /**
   * Recalculate one score with the current calculator: a score opened in View Details before
   * it had a pp breakdown gets one this way, and with it the calculator version, so the parts
   * always belong to the pp shown beside them. Queued like every other write.
   */
  recomputeScore(id: number, profileId: number): Promise<RecomputeResult | null> {
    return this.enqueue(async () => {
      if (!this.opts.official) return null;
      return await recomputeScores({
        db: this.opts.db,
        resolver: this.opts.resolver,
        profileId,
        official: this.opts.official,
        ids: [id],
      });
    });
  }

  /** The osu! release the pp calculator comes from, or null when there is no calculator. */
  get calculatorVersion(): string | null {
    return this.opts.official?.version ?? null;
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
    this.arrived();
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
    this.arrived();
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
