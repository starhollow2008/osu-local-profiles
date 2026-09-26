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
import { buildMcosuReplays, McosuWatcher } from './mcosu-watcher.ts';
import { logDirOf, type ResolvedLoggedPlay, type SessionAttempt } from '../clients/lazer-log.ts';
import {
  checkIncompletePlay,
  checkUnsubmittedAttempt,
  ingestIncompletePlay,
  ingestUnsubmittedAttempt,
  type IncompleteCheck,
  type IncompleteContext,
  type IngestedIncomplete,
} from './incomplete.ts';
import { ingestReplayFile, type IngestedScore } from './ingest.ts';
import { scanForReplays, type BackfillScan } from './backfill.ts';
import { scanLogsForPlays } from './log-backfill.ts';
import {
  countStale,
  markRecalculatedFor,
  recalculatedFor,
  recalculationBatches,
  recomputeScores,
  type RecomputeResult,
} from './recompute.ts';
import type { OfficialCalculator } from '../calc/official.ts';
import { getSettings } from '../settings.ts';
import {
  defaultTrackingFilter,
  filterNarrows,
  type FilterCriterion,
  type TrackingFilter,
} from '../tracking-filter.ts';
import { resolveIdentity, type PlayerIdentity } from '../player-identity.ts';

export interface TrackerOptions {
  db: Db;
  resolver: BeatmapResolver;
  installs: OsuInstall[];
  profileId: number;
  trackingSince: number;
  /** osu!'s own pp calculator. When null, scores are stored with no pp rather than a guess. */
  official: OfficialCalculator | null;
  /**
   * Overrides the instant live tracking starts accepting plays from, which is otherwise the
   * moment `start()` is called -- see `liveCutoff`.
   *
   * For tests that replay a historical replay through the watcher. Nothing in the app passes
   * it: an app that could be told to accept the past live would be the very behaviour
   * `liveCutoff` exists to prevent.
   */
  liveSince?: number;
}

export interface TrackerEvents {
  score: [IngestedScore];
  /**
   * A play that finished without a score: a quit, a retry, or an HP fail. Either one osu!
   * counted, or -- `unsubmitted` -- one it had no token for and never counted.
   */
  incomplete: [IngestedIncomplete];
  skip: [{ reason: string }];
  /**
   * A play the profile's tracking filter turned away, which is deliberately not a `skip`: a
   * skip means the play was already here or could not be read, while this one is the user's
   * own rule doing what it was set up to do -- and it is the only trace of a play that was
   * never written down, so it names the beatmap and the criterion.
   */
  filtered: [FilteredPlay];
  /**
   * A replay that arrived and was not tracked for a reason the user would want to hear about:
   * someone else set it, or it could not be read. Its own event rather than a `skip` for the
   * same reason as `filtered` -- nothing is written, so this is the only trace of it -- while
   * the skips that are the app working as meant (a duplicate, a watched replay from before the
   * launch) stay quiet.
   */
  refused: [RefusedPlay];
  error: [Error];
  /** How far the beatmap index has got; sent while it runs and once when it finishes. */
  indexing: [IndexState];
  /**
   * A launch brought in the plays set while the app was closed, because the profile asked it
   * to. Announced rather than silent: this is the only kind of import nobody pressed a button
   * for, so it has to say what it added and be visible on a page that is already open.
   */
  caughtUp: [BackfillResult];
  /**
   * How far a recalculation of every profile's scores has got: after an update brings a new
   * pp calculator, or from Other settings. Sent as it starts and after each step.
   */
  recalculating: [{ done: number; total: number }];
  /** A recalculation of every profile's scores finished. */
  recalculated: [RecomputeResult];
}

/** A play that was not tracked because the filter said so. */
export interface FilteredPlay {
  title: string;
  /** The same beatmap in the song's own script, or null where it reads the same. */
  titleOriginal: string | null;
  criterion: FilterCriterion;
  /** Whether it was a finished score or a play that left no replay. */
  kind: 'score' | 'incomplete';
  at: number;
}

/** A replay that was not tracked, and why. */
export type RefusedPlay =
  | {
      reason: 'another-player';
      /** The name written in the replay. */
      player: string;
      title: string;
      /** The same beatmap in the song's own script, or null where it reads the same. */
      titleOriginal: string | null;
      at: number;
    }
  | { reason: 'unparseable'; at: number };

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
  /** Finished plays imported from their replays. */
  imported: number;
  /** Unfinished plays osu! counted, imported from lazer's logs. */
  unfinished: number;
  /** Attempts osu! could not submit, imported from lazer's logs. */
  attempts: number;
  /** Already tracked, rejected by the parser, or on a beatmap that is not installed. */
  skipped: number;
  /**
   * Declined by the play tracking filter. Counted apart from `skipped`, because the answer to
   * "why did my import bring in three of forty plays" is the filter, and the dialog has to be
   * able to say so -- the way to import everything is to switch the filter off first.
   */
  filtered: number;
  /** Replays found that somebody else set -- watched, not played. Never imported. */
  otherPlayers: number;
  scanned: number;
  since: number;
}

/**
 * Which kinds of past play an import brings in. Separate, because they are separate decisions:
 * bringing in last week's offline retries says nothing about wanting last week's replays too.
 */
export interface BackfillSources {
  replays: boolean;
  unfinished: boolean;
  attempts: boolean;
}

/** Replays alone: what an import meant before it read logs, and what naming nothing still gets. */
export const REPLAYS_ONLY: BackfillSources = { replays: true, unfinished: false, attempts: false };

/** The logs' half of a preview, counted by the same checks the import makes before it writes. */
export interface LogBackfillPreview {
  unfinished: number;
  attempts: number;
  /** Already in this profile. */
  alreadyTracked: number;
  /** On a beatmap that is not installed, so there is no mode to file it under. */
  unresolved: number;
  filtered: number;
  sessions: number;
  earliest: number | null;
  latest: number | null;
}

export type BackfillPreview = BackfillScan & { log: LogBackfillPreview };

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
  private mcosuWatchers: McosuWatcher[] = [];
  private enabled = false;
  /** When this run started watching. Zero until `start()` -- see `liveCutoff`. */
  private liveSince = 0;
  /** Serialises ingestion so two replays landing together cannot interleave writes. */
  private queue: Promise<void> = Promise.resolve();
  private added = 0;
  /** Plays the filter has turned away since the app started, so the dialog can say so. */
  private filtered = 0;
  /** Replays turned away since the app started, as another player's or unreadable. */
  private refused = 0;
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

  /**
   * The earliest a play may have happened and still be tracked live: the later of the
   * profile's own start and the moment this run began watching.
   *
   * The second half is the point. Closing the app is how someone stops tracking -- they are
   * switching to a playstyle, a smurf routine or a warm-up they do not want in the profile --
   * so a play set while it was closed was, by their own action, not being tracked. Catching
   * up on those at the next launch would silently overrule that decision, and there is no
   * undoing it: the scores are in, and the profile has to be picked through by hand.
   *
   * Each watcher already starts from *now* on its own -- the replay watcher never scans the
   * store, and the log watcher tails from the current end of the session (`LogWatcher`) --
   * but those are two separate promises made in two separate files, and either could be
   * weakened by a change that looks unrelated: a directory listing added for warm-up, a
   * session re-read after the game restarts. This is the same promise made once, at the only
   * place every live play passes through, where it costs one comparison and cannot be
   * sidestepped.
   *
   * Import past plays is unaffected. It supplies its own cutoff and is the way to bring in
   * an evening played with the app closed -- chosen, previewed and confirmed, which is
   * exactly the difference.
   */
  get liveCutoff(): number {
    return Math.max(this.opts.trackingSince, this.liveSince);
  }

  get scoresAdded(): number {
    return this.added;
  }

  /**
   * How many plays the tracking filter has declined since the app started.
   *
   * A running count rather than a stored one: these plays leave no row anywhere by design, so
   * there is nothing to count later. It is what stops a filter that is too tight from looking
   * like tracking having stopped.
   */
  get playsFiltered(): number {
    return this.filtered;
  }

  /**
   * How many replays were not tracked since the app started because someone else set them or
   * they could not be read. Running, like `playsFiltered`, and for the same reason: they leave
   * no row, and a play the owner thinks was theirs must not just disappear.
   */
  get playsRefused(): number {
    return this.refused;
  }

  /**
   * This profile's play tracking filter, read from its settings on every ingest rather than
   * captured once -- the page can change it while the app runs, and the play landing a second
   * later must be judged by what is saved now.
   */
  private currentFilter(): TrackingFilter {
    return getSettings(this.opts.db, this.opts.profileId).trackingFilter;
  }

  /** Whether the filter can actually turn a play away, for the console's start-up line. */
  get filterNarrowing(): boolean {
    return filterNarrows(this.currentFilter());
  }

  /**
   * Who this profile's plays belong to, read per ingest for the same reason the filter is:
   * linking an osu! account from the page must take effect on the next play, not the next
   * launch. It reads settings and, at most, one small config file.
   */
  private currentIdentity(): PlayerIdentity {
    return resolveIdentity(this.opts.db, this.opts.profileId, this.opts.installs);
  }

  /** The profile's own identity, for the start-up line and the page. */
  get playerIdentity(): PlayerIdentity {
    return this.currentIdentity();
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
    this.filtered = 0;
    this.refused = 0;
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
      this.filtered = 0;
      this.refused = 0;
    });
  }

  get profileId(): number {
    return this.opts.profileId;
  }

  start(): void {
    if (this.watcher) return;
    /*
     * Live tracking covers from here on, and nothing before it. Set on each start rather
     * than once in the constructor, so that turning tracking off and on again leaves the
     * same gap that closing and reopening the app does -- it is the same decision.
     */
    this.liveSince = this.opts.liveSince ?? Date.now();
    // McOsu's replay folder is the app's own, of replays it builds; McosuWatcher feeds it.
    const dirs = this.opts.installs.filter((i) => i.kind !== 'mcosu').map((i) => i.replayDir);
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
        onAttempts: (attempts) => this.handleUnsubmittedAttempts(attempts),
        onError: (e) => this.emit('error', e),
      });
      this.logWatcher.start();
    }

    /*
     * McOsu keeps no replays and no log -- only its scores.db, rewritten after each finished
     * play. Each new entry there becomes a built replay and takes the same path as any other.
     */
    for (const install of this.opts.installs.filter((i) => i.kind === 'mcosu')) {
      const watcher = new McosuWatcher({
        root: install.root,
        dir: install.replayDir,
        onReplay: (file) => this.handleReplay(file),
        onError: (e) => this.emit('error', e),
      });
      this.mcosuWatchers.push(watcher);
      void watcher.start();
    }

    this.enabled = true;
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.logWatcher?.stop();
    this.logWatcher = null;
    for (const w of this.mcosuWatchers) w.stop();
    this.mcosuWatchers = [];
    this.enabled = false;
  }

  setTracking(on: boolean): void {
    if (on) this.start();
    else this.stop();
  }

  /**
   * The filter this import runs under.
   *
   * The play tracking filter normally applies to an import exactly as it does to live
   * tracking, so the two agree. But it is a rule about how you play *now*, and an import
   * reaches back to evenings it was never meant to judge -- so the dialog can turn it off for
   * one import. Off means a filter that permits everything, not a missing one, so every path
   * below still has a filter to consult.
   */
  private importFilter(applyFilter: boolean): TrackingFilter {
    return applyFilter ? this.currentFilter() : defaultTrackingFilter();
  }

  /** Preview what an import would bring in, without changing anything. */
  previewBackfill(since: number, applyFilter = true): Promise<BackfillPreview> {
    return this.enqueue(async () => {
      const filter = this.importFilter(applyFilter);
      await this.buildMcosuReplays(since);
      const replays = await scanForReplays(
        this.opts.db,
        this.opts.profileId,
        this.replayDirs(),
        since,
        {
          resolver: this.opts.resolver,
          // So the preview counts what the import will actually decline, rather than promising
          // plays the same filter is about to turn away.
          filter,
        },
        this.currentIdentity(),
      );
      return { ...replays, log: this.previewLogs(since, filter) };
    });
  }

  /**
   * The logs' half of a preview. Every play goes through the check its import runs before
   * writing, so each number here is one the import reproduces.
   */
  private previewLogs(since: number, filter: TrackingFilter): LogBackfillPreview {
    const scan = scanLogsForPlays(this.opts.db, this.opts.profileId, this.logDirs(), since);
    const ctx = this.importContext(since, filter);
    const preview: LogBackfillPreview = {
      unfinished: 0,
      attempts: 0,
      alreadyTracked: scan.alreadyTracked,
      unresolved: 0,
      filtered: 0,
      sessions: scan.sessions,
      earliest: null,
      latest: null,
    };
    const tally = (checked: IncompleteCheck, kind: 'unfinished' | 'attempts', at: number) => {
      if (checked.status === 'ready') {
        preview[kind]++;
        preview.earliest = preview.earliest === null ? at : Math.min(preview.earliest, at);
        preview.latest = preview.latest === null ? at : Math.max(preview.latest, at);
      } else if (checked.status === 'filtered') {
        preview.filtered++;
      } else if (checked.reason === 'unresolved') {
        preview.unresolved++;
      } else if (checked.reason === 'duplicate') {
        preview.alreadyTracked++;
      }
    };
    for (const play of scan.unfinished) {
      tally(checkIncompletePlay(play, ctx), 'unfinished', play.countedAt);
    }
    for (const attempt of scan.attempts) {
      tally(checkUnsubmittedAttempt(attempt, ctx), 'attempts', attempt.endedAt);
    }
    return preview;
  }

  /** An import's context: its chosen cutoff stands in for the profile's own, as for replays. */
  private importContext(since: number, filter: TrackingFilter): IncompleteContext {
    return {
      db: this.opts.db,
      resolver: this.opts.resolver,
      profileId: this.opts.profileId,
      trackingSince: since,
      filter,
    };
  }

  /**
   * Import past plays since `since`: finished plays from their replays, and -- when asked -- the
   * unfinished plays osu! counted and the attempts it could not submit, from lazer's logs.
   *
   * Runs through the same serialised queue as live ingestion, so a play landing mid-import
   * cannot interleave its writes. Individual plays are not emitted: importing a session can
   * add dozens at once, and a toast per play would bury the page. Naming no sources means
   * replays alone, which is what an import meant before it read logs.
   */
  backfill(
    since: number,
    sources: BackfillSources = REPLAYS_ONLY,
    applyFilter = true,
  ): Promise<BackfillResult> {
    return this.enqueue(async () => {
      let imported = 0;
      let unfinished = 0;
      let attempts = 0;
      let skipped = 0;
      let filtered = 0;
      let scanned = 0;
      let otherPlayers = 0;
      // The filter applies to an import too, unless this one was told not to: see
      // `importFilter`. The preview was given the same answer, so its counts are these.
      const filter = this.importFilter(applyFilter);
      // As does the owner check. An import walks osu!'s folders, which is exactly where the
      // replays you have *watched* are cached, so this is where it matters most.
      const owner = this.currentIdentity();

      if (sources.replays) {
        await this.buildMcosuReplays(since);
        const scan = await scanForReplays(
          this.opts.db,
          this.opts.profileId,
          this.replayDirs(),
          since,
          undefined,
          owner,
        );
        scanned = scan.scanned;
        otherPlayers = scan.otherPlayers.reduce((n, p) => n + p.count, 0);
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
            filter,
            identity: owner,
          });
          if (result.status === 'added') {
            imported++;
            this.added++;
          } else if (result.status === 'filtered') {
            filtered++;
            this.filtered++;
          } else {
            skipped++;
          }
        }
      }

      if (sources.unfinished || sources.attempts) {
        const scan = scanLogsForPlays(this.opts.db, this.opts.profileId, this.logDirs(), since);
        const ctx = this.importContext(since, filter);
        const tally = (status: 'added' | 'skipped' | 'filtered'): boolean => {
          if (status === 'filtered') {
            filtered++;
            this.filtered++;
          } else if (status === 'skipped') {
            skipped++;
          }
          return status === 'added';
        };
        if (sources.unfinished) {
          for (const play of scan.unfinished) {
            if (tally(ingestIncompletePlay(play, ctx).status)) unfinished++;
          }
        }
        if (sources.attempts) {
          for (const attempt of scan.attempts) {
            if (tally(ingestUnsubmittedAttempt(attempt, ctx).status)) attempts++;
          }
        }
      }

      return { imported, unfinished, attempts, skipped, filtered, otherPlayers, scanned, since };
    });
  }

  /**
   * Bring in the plays set while the app was closed, if this profile asks for it.
   *
   * Deliberately `backfill` and nothing new: same scan, same filter, same duplicate and owner
   * checks, same queue. The only thing this adds is *who decides* -- the profile's
   * `importPlaysWhileClosed`, off by default -- and *from when*, which is the moment the app
   * last recorded that it was running and never earlier than the profile's own start.
   *
   * Every source, because the gap is a gap: a quit or an offline retry set while the app was
   * closed is exactly as much a missing play as a finished one, and bringing in half of them
   * would leave the play count disagreeing with osu!'s.
   *
   * Returns null when nothing was asked for or there is no gap on record, so a caller can
   * tell "turned off" from "turned on and found nothing".
   */
  async catchUp(since: number | null): Promise<BackfillResult | null> {
    if (since === null) return null;
    if (!getSettings(this.opts.db, this.opts.profileId).importPlaysWhileClosed) return null;

    const result = await this.backfill(since, {
      replays: true,
      unfinished: true,
      attempts: true,
    });
    this.emit('caughtUp', result);
    return result;
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

  private recalculation: Promise<RecomputeResult> | null = null;

  /** Whether every profile's scores are being recalculated right now. */
  get recalculating(): boolean {
    return this.recalculation !== null;
  }

  /**
   * Recalculate every profile's scores from their replays with the calculator running now:
   * all of them, or with `outdatedOnly` those priced by another osu! release.
   *
   * Queued a step at a time (`RECALCULATE_BATCH` scores) rather than as one task, so a play
   * set while a few thousand scores are recalculated is ingested within seconds, between two
   * steps, instead of after all of them. Only one runs at once.
   */
  recalculate(outdatedOnly: boolean): Promise<RecomputeResult> {
    const official = this.opts.official;
    if (!official) {
      return Promise.reject(new Error('the pp calculator is not available -- run: npm run build:pp'));
    }
    if (this.recalculation) return Promise.reject(new Error('scores are already being recalculated'));

    const db = this.opts.db;
    // With no release to compare against, nothing can be said to be outdated.
    const batches = outdatedOnly
      ? official.version === null
        ? []
        : recalculationBatches(db, official.version)
      : recalculationBatches(db, null);
    const total = batches.reduce((n, b) => n + b.ids.length, 0);

    const run = (async () => {
      const sum: RecomputeResult = { considered: 0, updated: 0, skipped: 0, gainedPp: 0 };
      let done = 0;
      this.emit('recalculating', { done, total });
      for (const batch of batches) {
        const step = await this.enqueue(() =>
          recomputeScores({ db, resolver: this.opts.resolver, profileId: batch.profileId, official, ids: batch.ids }),
        );
        sum.considered += step.considered;
        sum.updated += step.updated;
        sum.skipped += step.skipped;
        sum.gainedPp += step.gainedPp;
        done += batch.ids.length;
        this.emit('recalculating', { done, total });
      }
      this.emit('recalculated', sum);
      return sum;
    })();
    this.recalculation = run.finally(() => {
      this.recalculation = null;
    });
    return this.recalculation;
  }

  /**
   * The first launch with a new pp calculator recalculates what the old one priced, so every
   * score is ranked against the others by one algorithm. Once per release (`recalculatedFor`),
   * and recorded only when it finishes, so a launch closed half-way picks up where it stopped.
   *
   * Null when there was nothing to do: no calculator, this release already done, or no score
   * priced by another one -- which is every fresh install, recorded so it is not asked again.
   */
  async recalculateAfterUpdate(): Promise<{ release: string; result: RecomputeResult } | null> {
    const release = this.opts.official?.version ?? null;
    if (release === null || recalculatedFor(this.opts.db) === release) return null;
    if (recalculationBatches(this.opts.db, release).length === 0) {
      markRecalculatedFor(this.opts.db, release);
      return null;
    }
    const result = await this.recalculate(true);
    markRecalculatedFor(this.opts.db, release);
    return { release, result };
  }

  /** The osu! release the pp calculator comes from, or null when there is no calculator. */
  get calculatorVersion(): string | null {
    return this.opts.official?.version ?? null;
  }

  /**
   * Build the replays for McOsu's plays since `since`, so an import's scan finds them where it
   * finds every other replay. The preview does it too, or it would count none of them: this
   * writes only into the app's own `data/mcosu/`, and changes nothing a profile holds.
   */
  private async buildMcosuReplays(since: number): Promise<void> {
    for (const install of this.opts.installs.filter((i) => i.kind === 'mcosu')) {
      try {
        await buildMcosuReplays(install.root, install.replayDir, since);
      } catch (e) {
        this.emit('error', e as Error);
      }
    }
  }

  private logDirs(): string[] {
    return this.opts.installs.map((i) => logDirOf(i)).filter((d): d is string => d !== null);
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
            trackingSince: this.liveCutoff,
            filter: this.currentFilter(),
          });
          if (result.status === 'added') this.emit('incomplete', result.play);
          else if (result.status === 'filtered') this.reportFiltered(result, 'incomplete');
          // A passed play is not a skip worth reporting: its replay is the event.
          else if (result.reason !== 'passed') this.emit('skip', { reason: result.reason });
        }
      })
      .catch((e: unknown) => {
        this.emit('error', e as Error);
      });
  }

  /**
   * Record the attempts osu! logged it had no token for.
   *
   * Queued exactly like the plays osu! did count, so the two can never interleave their writes,
   * and an attempt and a replay arriving together are handled in the order they happened.
   */
  private handleUnsubmittedAttempts(attempts: SessionAttempt[]): void {
    this.arrived();
    this.queue = this.queue
      .then(() => {
        for (const attempt of attempts) {
          const result = ingestUnsubmittedAttempt(attempt, {
            db: this.opts.db,
            resolver: this.opts.resolver,
            profileId: this.opts.profileId,
            trackingSince: this.liveCutoff,
            filter: this.currentFilter(),
          });
          if (result.status === 'added') this.emit('incomplete', result.play);
          else if (result.status === 'filtered') this.reportFiltered(result, 'incomplete');
          else this.emit('skip', { reason: result.reason });
        }
      })
      .catch((e: unknown) => {
        this.emit('error', e as Error);
      });
  }

  /** Count a declined play and say so, once, for either kind of play. */
  private reportFiltered(
    result: { criterion: FilterCriterion; title: string; titleOriginal: string | null },
    kind: 'score' | 'incomplete',
  ): void {
    this.filtered++;
    this.emit('filtered', {
      title: result.title,
      titleOriginal: result.titleOriginal,
      criterion: result.criterion,
      kind,
      at: Date.now(),
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
          trackingSince: this.liveCutoff,
          official: this.opts.official,
          filter: this.currentFilter(),
          identity: this.currentIdentity(),
        });
        if (result.status === 'added') {
          this.added++;
          this.emit('score', result.score);
        } else if (result.status === 'filtered') {
          this.reportFiltered(result, 'score');
        } else if (result.reason === 'another-player') {
          this.refused++;
          this.emit('refused', {
            reason: result.reason,
            player: result.player,
            title: result.title,
            titleOriginal: result.titleOriginal,
            at: Date.now(),
          });
        } else if (result.reason === 'unparseable') {
          this.refused++;
          this.emit('refused', { reason: result.reason, at: Date.now() });
        } else {
          this.emit('skip', { reason: result.reason });
        }
      })
      .catch((e: unknown) => {
        this.emit('error', e as Error);
      });
  }
}
