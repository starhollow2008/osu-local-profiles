import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { beatmapMode, type BeatmapResolver } from '../clients/beatmaps.ts';
import type { ResolvedLoggedPlay, SessionAttempt } from '../clients/lazer-log.ts';
import {
  beatmapFilterFacts,
  defaultTrackingFilter,
  filterRejects,
  playFacts,
  type FilterCriterion,
  type TrackingFilter,
} from '../tracking-filter.ts';

/**
 * Turning a play read out of lazer's log into a tracked one.
 *
 * These are the plays the replay watcher can never see -- a quit, a retry, or an HP fail
 * outside multiplayer. What is knowable about them is only what the log says: which beatmap,
 * when, and whether osu! could submit it. There is no accuracy, no combo, no mod list and no
 * pp, because lazer never writes any of it down. Nothing here invents a substitute for the
 * missing numbers.
 *
 * Two kinds arrive, and both are stored in `incomplete_plays`, never in `scores`:
 *
 * - **A play osu! counted** -- its submission completed. These always count, because osu!
 *   counts them.
 * - **An attempt osu! could not submit** -- `No token` -- stored with `unsubmitted = 1`. osu!
 *   never saw these, so whether this profile counts them is its own setting, read through
 *   `incompleteSql()` in src/calc/eligibility.ts. They are recorded either way, because the
 *   log is only ever followed live: an attempt skipped today could not be recovered by
 *   switching the setting on tomorrow.
 *
 * Each kind has a `check` and an `ingest`. The check does everything but write -- it is what
 * Import past plays previews with -- and the ingest is the check followed by the write, so a
 * preview can never promise a play the import then refuses.
 */

export interface IncompleteContext {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  /** Plays from before this instant are ignored, exactly as for replays. */
  trackingSince: number;
  /**
   * Which plays this profile tracks at all. Two of its nine criteria cannot judge a play
   * like this -- there is no mod list and no star rating to judge -- and the other seven
   * still do; see src/tracking-filter.ts for why that is the right way round.
   */
  filter?: TrackingFilter;
}

export interface IngestedIncomplete {
  id: number;
  mode: Ruleset;
  title: string;
  playedAt: number;
  /** An attempt osu! could not submit, rather than a play osu! counted. */
  unsubmitted: boolean;
}

export type IncompleteOutcome =
  | { status: 'added'; play: IngestedIncomplete }
  | { status: 'skipped'; reason: 'passed' | 'too-old' | 'duplicate' | 'unresolved' }
  /** Turned away by the play tracking filter, exactly as in tracker/ingest.ts. */
  | { status: 'filtered'; criterion: FilterCriterion; title: string };

/** What both kinds have in common once their beatmap is known. */
export interface Recording {
  dedupeKey: string;
  md5: string;
  beatmapName: string | null;
  playedAt: number;
  startedAt: number | null;
  onlineScoreId: string | null;
  unsubmitted: boolean;
}

/** A play checked and ready to write, with what writing it needs. */
export interface ReadyIncomplete {
  status: 'ready';
  recording: Recording;
  mode: Ruleset;
  title: string;
  beatmapId: number | null;
}

/** What a play comes to before anything is written: ready, or the reason it will not be. */
export type IncompleteCheck = ReadyIncomplete | Exclude<IncompleteOutcome, { status: 'added' }>;

/**
 * Find a counted play's beatmap by the only two handles the log offers.
 *
 * The submission URL's beatmap id is the good one, and `online.db` or the local index turns it
 * into the MD5 everything else in this app is keyed by. The log's display name is the fallback
 * for an id neither knows, matched exactly -- see `md5ForBeatmapName`.
 */
function findBeatmap(play: ResolvedLoggedPlay, ctx: IncompleteContext): string | null {
  if (play.beatmapId !== null) {
    const md5 = ctx.resolver.md5ForBeatmapId(play.beatmapId);
    if (md5) return md5;
  }
  return play.beatmapName ? ctx.resolver.md5ForBeatmapName(play.beatmapName) : null;
}

const isRecorded = (ctx: IncompleteContext, key: string): boolean =>
  ctx.db
    .prepare('SELECT 1 AS hit FROM incomplete_plays WHERE profile_id = ? AND dedupe_key = ?')
    .get(ctx.profileId, key) !== undefined;

/**
 * File and filter a play whose beatmap is known: the same rules for both kinds, so an attempt
 * osu! could not submit can never be judged by rules a counted play is not.
 */
function assess(entry: Recording, ctx: IncompleteContext): IncompleteCheck {
  const beatmap = ctx.resolver.resolve(entry.md5);
  const mode = beatmap.osuPath ? beatmapMode(beatmap.osuPath) : 0;
  const name =
    [beatmap.artist, beatmap.title].filter(Boolean).join(' - ') || entry.md5.slice(0, 12);
  const title = beatmap.version ? `${name} [${beatmap.version}]` : name;

  /*
   * The play tracking filter. `mods: null` is the whole point of passing it explicitly rather
   * than leaving it out: lazer records no mod list for a play it discards, and the filter
   * treats a fact it does not have as no reason to reject. The star rating is left out for the
   * same reason -- there is no replay to price.
   */
  const filter = ctx.filter ?? defaultTrackingFilter();
  if (filter.enabled) {
    const facts = beatmapFilterFacts(ctx.db, ctx.resolver, beatmap);
    const rejected = filterRejects(filter, playFacts(facts, mode, null));
    if (rejected) return { status: 'filtered', criterion: rejected, title };
  }

  return { status: 'ready', recording: entry, mode, title, beatmapId: beatmap.beatmapId };
}

function write(ready: ReadyIncomplete, ctx: IncompleteContext): IncompleteOutcome {
  const entry = ready.recording;
  ctx.db
    .prepare(
      `INSERT INTO incomplete_plays
        (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, beatmap_name,
         played_at, started_at, online_score_id, unsubmitted)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      ctx.profileId,
      entry.dedupeKey,
      ready.mode,
      entry.md5,
      ready.beatmapId,
      entry.beatmapName,
      entry.playedAt,
      entry.startedAt,
      entry.onlineScoreId,
      entry.unsubmitted ? 1 : 0,
    );

  const id = (ctx.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  return {
    status: 'added',
    play: {
      id,
      mode: ready.mode,
      title: ready.title,
      playedAt: entry.playedAt,
      unsubmitted: entry.unsubmitted,
    },
  };
}

/** Everything `ingestIncompletePlay` decides, without writing anything. */
export function checkIncompletePlay(
  play: ResolvedLoggedPlay,
  ctx: IncompleteContext,
): IncompleteCheck {
  // A passed play was imported by lazer and reaches this app as a replay. Counting it here
  // as well would double every play in the profile.
  if (play.passed) return { status: 'skipped', reason: 'passed' };

  if (play.countedAt < ctx.trackingSince) return { status: 'skipped', reason: 'too-old' };
  if (isRecorded(ctx, play.token)) return { status: 'skipped', reason: 'duplicate' };

  const md5 = findBeatmap(play, ctx);
  /*
   * Without a beatmap there is no mode to file the play under, and this app is arranged by
   * mode all the way down. Rather than park it in osu!standard and quietly inflate one mode's
   * play count, the play is dropped and says so. It needs the id to be unknown to `online.db`
   * and to every local `.osu`, *and* the name to match no installed beatmap exactly -- which in
   * practice means a beatmap that is not installed at all.
   */
  if (!md5) return { status: 'skipped', reason: 'unresolved' };

  return assess(
    {
      dedupeKey: play.token,
      md5,
      beatmapName: play.beatmapName,
      playedAt: play.countedAt,
      startedAt: play.startedAt,
      onlineScoreId: play.onlineScoreId,
      unsubmitted: false,
    },
    ctx,
  );
}

export function ingestIncompletePlay(
  play: ResolvedLoggedPlay,
  ctx: IncompleteContext,
): IncompleteOutcome {
  const checked = checkIncompletePlay(play, ctx);
  return checked.status === 'ready' ? write(checked, ctx) : checked;
}

/**
 * An attempt's dedupe key: it has no token, so the session log and the gameplay screen stand in.
 *
 * The screen's instance number alone is not enough -- lazer reuses them, `SoloPlayer#414`
 * appears twice in one day of this machine's logs -- so the second it was entered goes with
 * it. Re-reading the same log line produces the same key, which is all a dedupe key must do.
 */
export function attemptKey(attempt: SessionAttempt): string {
  return `unsubmitted:${attempt.session}:${attempt.player}:${attempt.startedAt}`;
}

/** Everything `ingestUnsubmittedAttempt` decides, without writing anything. */
export function checkUnsubmittedAttempt(
  attempt: SessionAttempt,
  ctx: IncompleteContext,
): IncompleteCheck {
  if (attempt.endedAt < ctx.trackingSince) return { status: 'skipped', reason: 'too-old' };

  const key = attemptKey(attempt);
  if (isRecorded(ctx, key)) return { status: 'skipped', reason: 'duplicate' };

  // No submission, so no beatmap id: the log's name for the map is the only handle there is.
  const md5 = attempt.beatmapName ? ctx.resolver.md5ForBeatmapName(attempt.beatmapName) : null;
  if (!md5) return { status: 'skipped', reason: 'unresolved' };

  return assess(
    {
      dedupeKey: key,
      md5,
      beatmapName: attempt.beatmapName,
      playedAt: attempt.endedAt,
      startedAt: attempt.startedAt,
      onlineScoreId: null,
      unsubmitted: true,
    },
    ctx,
  );
}

/**
 * Record an attempt osu! logged it had no token for.
 *
 * Always recorded, never conditionally on the setting that decides whether it counts: see the
 * module comment. What it reports as `playedAt` is the moment gameplay was left, the same
 * instant a counted play's submission marks.
 */
export function ingestUnsubmittedAttempt(
  attempt: SessionAttempt,
  ctx: IncompleteContext,
): IncompleteOutcome {
  const checked = checkUnsubmittedAttempt(attempt, ctx);
  return checked.status === 'ready' ? write(checked, ctx) : checked;
}
