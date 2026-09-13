import fs from 'node:fs';
import path from 'node:path';
import type { OsuInstall } from './detect.ts';

/**
 * Reader for osu!lazer's own log files.
 *
 * This exists because more than half of what osu! calls a play leaves nothing on disk.
 * `Player.prepareAndImportScoreAsync` imports a score locally only for a map played to the
 * end; a fail, a quit or a retry is submitted to osu! and then discarded locally, unless
 * the user clicks "Save replay" by hand. Measured on one real session of this machine's
 * corpus: 54 plays started, 45 counted by osu!, 19 replays written.
 *
 * lazer's log is the only local record of the other 26. Like `osu-web.ts` this is a private
 * detail of osu! rather than a documented interface, so every pattern below is written to
 * *fail closed*: an unrecognised line is ignored, and something is only ever reported when the
 * game itself said so in as many words -- that osu! accepted a submission, or, for an attempt
 * made offline or signed out, that it had no token to submit with (`UnsubmittedAttempt`).
 * Inventing a play would be far worse than missing one.
 *
 * Timestamps in these logs are UTC. (The session file is named for the unix second it
 * started -- 1789001733 -> 2026-09-10T00:55:33Z -- and its first line reads
 * `2026-09-10 00:56:47`, which settles it.)
 */

/** A play osu! accepted, as the log describes it. */
export interface LoggedPlay {
  /**
   * lazer's submission token. Server-issued and unique to the play, which makes it a
   * natural dedupe key: re-reading a log can never duplicate a play.
   */
  token: string;
  /** When the play started. Null when the log was joined while it was already running. */
  startedAt: number | null;
  /** When osu! accepted the submission -- the instant osu! counted the play. */
  countedAt: number;
  /** osu!'s id for the submitted score. */
  onlineScoreId: string;
  /** The beatmap as the log named it: `Artist - Title (Creator) [Version]`. */
  beatmapName: string | null;
  /**
   * Whether the map was played to the end. A passed play is imported by lazer and reaches
   * this app as a replay, so the caller must drop it rather than count it twice.
   */
  passed: boolean;
}

/**
 * A logged play with the beatmap it was submitted against attached.
 *
 * The id is not in the runtime log at all: the only place lazer writes a token and a
 * beatmap id together is the submission request in the *network* log, so it is joined on
 * afterwards. Null when that request is absent -- multiplayer submits through a different
 * URL, and such a play is dropped anyway because it always writes a replay.
 */
export interface ResolvedLoggedPlay extends LoggedPlay {
  beatmapId: number | null;
}

/*
 * The grammar. Every one of these was read off real logs written by lazer 2026.804.2, and
 * each is anchored on wording that comes from a `Logger.Log` call in ppy/osu rather than on
 * line positions, so an unrelated line appearing between them changes nothing.
 */

/** `2026-09-10 04:21:12 [verbose]: <body>` */
const LINE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[[a-z]+\]: (.*)$/;

/** The beatmap the game is sitting on. Emitted well before the play starts. */
const BEATMAP = /^Game-wide working beatmap updated to (.+)$/;

/** `SubmittingPlayer.CreateTokenRequest` succeeded: a play is beginning. */
const TOKEN = /^Score submission token retrieved \((\d+)\)$/;

/** `SubmittingPlayer.submitScore` succeeded: **this is the play osu! counted**. */
const SUBMITTED = /^Score submission completed! \(token:(\d+) id:(\d+)\)$/;

/**
 * The screen stack suspending the gameplay screen in favour of a results screen -- the
 * game's own statement that the map was completed.
 *
 * `\w*Player#` cannot match `PlayerLoader#`, which is the screen the *loader* suspends on
 * the way in, so this only ever fires for the real thing.
 */
const REACHED_RESULTS = /suspended \w*Player#\d+ \(waiting on \w*ResultsScreen#/;

/** The gameplay screen going away. For anything but a pass, this ends the play. */
const LEFT_GAMEPLAY = /exit from \w*Player#\d+/;

/**
 * The submission `PUT`, which is the only place a token and a beatmap id appear together.
 * Multiplayer submits to `/rooms/...` instead and so is absent here -- which costs nothing,
 * because a multiplayer play always writes a replay and is dropped anyway.
 */
const SUBMISSION_URL =
  /Request to https:\/\/osu\.ppy\.sh\/api\/v2\/beatmaps\/(\d+)\/solo\/scores\/(\d+) successfully completed/;

function parseTimestamp(m: RegExpMatchArray): number {
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

/*
 * The second half of the grammar: solo gameplay screens, followed on their own so that a play
 * osu! had no token for can still be seen. `SoloPlayer` exactly, with a space before it --
 * watching a replay (`ReplayPlayer`), the skin editor's `EndlessPlayer`, multiplayer and the
 * daily challenge each enter a screen of their own, and none of them is a play to estimate.
 * Across this machine's logs that was 353 solo screens against 21 of all the others.
 */
const ENTERED_SOLO = / entered SoloPlayer#(\d+)/;
const LEFT_SOLO = / exit from SoloPlayer#(\d+)/;
const SOLO_REACHED_RESULTS = / suspended SoloPlayer#(\d+) \(waiting on \w*ResultsScreen#/;

/**
 * `SubmittingPlayer.submitScore` finding it has no token: osu! was offline or signed out, the
 * token request failed, or the beatmap is one osu! cannot submit. Distinct from `No hits
 * registered`, which is osu! discarding a play it *could* have submitted -- that one stays
 * uncounted, exactly as osu! leaves it.
 */
const NO_TOKEN = /^No token, skipping score submission$/;

/**
 * How late a `No token` line may still belong to the screen that just closed. Measured on
 * this machine's logs: 93 of 94 came just before their screen's exit, and the one exception
 * came after it, within a few seconds.
 */
const LATE_NO_TOKEN_MS = 5_000;

/**
 * A gameplay screen entered this recently cannot be the one a `No token` line is about,
 * because that line is written as a play *ends*. Log timestamps are whole seconds, so this
 * means "the same second or the next" -- which is what a quick retry looks like.
 */
const JUST_ENTERED_MS = 1_000;

/**
 * An attempt osu! logged it had no token for, and so never counted.
 *
 * Offline or signed out, lazer never asks for a token and never submits, so neither line the
 * plays above are built from is ever written. What *is* written, locally, is the screen stack
 * entering and leaving gameplay and `SubmittingPlayer` saying in as many words that it had no
 * token -- which is what this is built from, and nothing weaker. A play that reached a results
 * screen is excluded: lazer imported it, so it arrives as a replay.
 *
 * What the log cannot say is whether osu! *would* have counted it had it been online -- the
 * rule there is at least one non-miss judgement -- so an attempt quit before hitting anything
 * is included. On this machine's logs that was 7 of 59.
 */
export interface UnsubmittedAttempt {
  /** The gameplay screen's instance number: `217` in `SoloPlayer#217`. */
  player: string;
  /** When gameplay was entered. */
  startedAt: number;
  /** When it was left -- the quit, the fail or the retry. */
  endedAt: number;
  /** The beatmap the game was on as gameplay began, as `Artist - Title (Creator) [Version]`. */
  beatmapName: string | null;
}

/** An unsubmitted attempt and the session log it came from, which is what makes it unique. */
export interface SessionAttempt extends UnsubmittedAttempt {
  /** The `<unix seconds>` lazer named the session's log files with. */
  session: string;
}

/** Everything one stretch of the log produced. */
export interface LogEvents {
  plays: LoggedPlay[];
  attempts: UnsubmittedAttempt[];
}

/** For tests and batch reads: every counted play and every unsubmitted attempt in a session. */
export function parseSessionEvents(runtime: string): LogEvents {
  const session = new LogSession();
  const events = session.feedEvents(runtime.split(/\r?\n/));
  return { plays: [...events.plays, ...session.flush()], attempts: events.attempts };
}

interface OpenPlay {
  token: string;
  startedAt: number | null;
  beatmapName: string | null;
  countedAt: number | null;
  onlineScoreId: string | null;
  /** Set when gameplay ends; submission completion can be logged afterward. */
  outcome: boolean | null;
  reported: boolean;
}

interface OpenScreen {
  player: string;
  enteredAt: number;
  beatmapName: string | null;
  /** A token was retrieved for this screen, so a stray `No token` can never be about it. */
  hadToken: boolean;
  noToken: boolean;
  passed: boolean;
  endedAt: number | null;
  reported: boolean;
}

/**
 * The log read one line at a time.
 *
 * Stateful on purpose: following a live log means being handed arbitrary fragments of it,
 * and a play's start, its submission and its outcome are three lines that can be seconds
 * and hundreds of unrelated lines apart. Feeding whole files through the same object is
 * what keeps tailing and batch parsing on one code path.
 */
export class LogSession {
  private beatmap: string | null = null;
  private current: OpenPlay | null = null;
  /** The solo gameplay screen open now, if any. */
  private screen: OpenScreen | null = null;
  /** The one that closed most recently, for a `No token` line that lands just after it. */
  private lastScreen: OpenScreen | null = null;
  /** A token has been retrieved that no gameplay screen has claimed yet. */
  private tokenPending = false;

  /** Lines from the log, in order. Returns the plays that finished within them. */
  feed(lines: Iterable<string>): LoggedPlay[] {
    return this.feedEvents(lines).plays;
  }

  /** Lines from the log, in order: the plays osu! counted, and the attempts it could not submit. */
  feedEvents(lines: Iterable<string>): LogEvents {
    const plays: LoggedPlay[] = [];
    const attempts: UnsubmittedAttempt[] = [];
    for (const line of lines) this.line(line, plays, attempts);
    return { plays, attempts };
  }

  /**
   * Solo gameplay screens, followed independently of the submissions above.
   *
   * Independently on purpose. The play logic keys everything on a token, and an attempt
   * with no token has nothing for it to hold; sharing one state machine would mean every
   * change to either risked the other. This never returns early from `line()`, so each line
   * still reaches the play logic after it.
   */
  private trackScreen(at: number, body: string, attempts: UnsubmittedAttempt[]): void {
    if (TOKEN.test(body)) {
      this.tokenPending = true;
      return;
    }

    const entered = ENTERED_SOLO.exec(body);
    if (entered) {
      // A screen still open here missed its exit line; it is dropped unreported rather than
      // guessed at.
      this.screen = {
        player: entered[1]!,
        enteredAt: at,
        beatmapName: this.beatmap,
        hadToken: this.tokenPending,
        noToken: false,
        passed: false,
        endedAt: null,
        reported: false,
      };
      this.tokenPending = false;
      return;
    }

    if (NO_TOKEN.test(body)) {
      const current = this.screen;
      const last = this.lastScreen;
      /*
       * Nearly always logged just before the screen exits. The exception lands after -- and a
       * retry may already have entered the next screen by then, which cannot have ended the
       * instant it began. A screen that had a token cannot be the one osu! says had none.
       */
      const lateForLast =
        last !== null &&
        !last.noToken &&
        !last.hadToken &&
        last.endedAt !== null &&
        at - last.endedAt <= LATE_NO_TOKEN_MS &&
        (current === null || at - current.enteredAt <= JUST_ENTERED_MS);
      if (lateForLast) {
        last.noToken = true;
        this.reportAttempt(last, attempts);
      } else if (current) {
        current.noToken = true;
      }
      return;
    }

    const results = SOLO_REACHED_RESULTS.exec(body);
    if (results) {
      const screen = this.screen;
      if (screen && screen.player === results[1]) screen.passed = true;
      return;
    }

    const left = LEFT_SOLO.exec(body);
    const screen = this.screen;
    if (left && screen && screen.player === left[1]) {
      screen.endedAt = at;
      this.reportAttempt(screen, attempts);
      this.lastScreen = screen;
      this.screen = null;
    }
  }

  private reportAttempt(screen: OpenScreen, attempts: UnsubmittedAttempt[]): void {
    // Only a screen osu! itself said had no token, that did not reach results, and that has
    // actually closed -- a play still being played is not over.
    if (screen.reported || !screen.noToken || screen.passed || screen.endedAt === null) return;
    screen.reported = true;
    attempts.push({
      player: screen.player,
      startedAt: screen.enteredAt,
      endedAt: screen.endedAt,
      beatmapName: screen.beatmapName,
    });
  }

  private line(line: string, out: LoggedPlay[], attempts: UnsubmittedAttempt[]): void {
    const parsed = LINE.exec(line);
    if (!parsed) return;
    const at = parseTimestamp(parsed);
    const body = parsed[7]!;

    this.trackScreen(at, body, attempts);

    const beatmap = BEATMAP.exec(body);
    if (beatmap) {
      this.beatmap = beatmap[1]!.trim();
      return;
    }

    const token = TOKEN.exec(body);
    if (token) {
      // A play starting while another is open means we missed its ending; report what is
      // known about the old one rather than silently dropping it.
      this.close(out);
      this.current = {
        token: token[1]!,
        startedAt: at,
        beatmapName: this.beatmap,
        countedAt: null,
        onlineScoreId: null,
        outcome: null,
        reported: false,
      };
      return;
    }

    const submitted = SUBMITTED.exec(body);
    if (submitted) {
      if (!this.current || this.current.token !== submitted[1]) {
        // Joined mid-play: the token line is behind us, but the submission alone is enough
        // to know osu! counted this, and the beatmap comes from the network log.
        this.close(out);
        this.current = {
          token: submitted[1]!,
          startedAt: null,
          beatmapName: this.beatmap,
          countedAt: null,
          onlineScoreId: null,
          outcome: null,
          reported: false,
        };
      }
      this.current.countedAt = at;
      this.current.onlineScoreId = submitted[2]!;
      if (this.current.outcome !== null) this.report(out, this.current.outcome);
      return;
    }

    if (!this.current) return;

    // A pass is settled the moment the results screen is queued. Reporting it here rather
    // than on the eventual screen exit matters only for tidiness -- the caller drops it --
    // but it keeps a play from staying open for as long as the user reads their results.
    if (REACHED_RESULTS.test(body)) {
      this.current.outcome = true;
      if (this.current.countedAt !== null) this.report(out, true);
      return;
    }

    if (LEFT_GAMEPLAY.test(body)) {
      // In real logs submission completion can follow gameplay exit by a few lines. Leaving
      // the results screen exits the Player too, so a pass already settled must stay one --
      // reported as unfinished, it would be counted again beside its own replay.
      this.current.outcome ??= false;
      if (this.current.countedAt !== null) this.report(out, false);
    }
  }

  private close(out: LoggedPlay[]): void {
    this.report(out, this.current?.outcome ?? false);
    this.current = null;
  }

  private report(out: LoggedPlay[], passed: boolean): void {
    const play = this.current;
    // Only a play osu! itself accepted is a play. Without a submission the game either had
    // no token, registered no hits or scored zero -- and osu! did not count it either.
    if (!play || play.reported || play.countedAt === null || play.onlineScoreId === null) return;
    play.reported = true;
    out.push({
      token: play.token,
      startedAt: play.startedAt,
      countedAt: play.countedAt,
      onlineScoreId: play.onlineScoreId,
      beatmapName: play.beatmapName,
      passed,
    });
  }

  /**
   * Report a play still open at the end of the input, if osu! had already accepted it.
   *
   * Only for reading a finished session's file. A live log must never be flushed: the play
   * it ends on is still being played.
   */
  flush(): LoggedPlay[] {
    const out: LoggedPlay[] = [];
    this.close(out);
    return out;
  }
}

/** Token -> beatmap id, from the submission requests in a `.network.log`. */
export function parseSubmissionBeatmaps(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = SUBMISSION_URL.exec(line);
    if (m) out.set(m[2]!, Number(m[1]!));
  }
  return out;
}

/** Convenience for tests and batch reads: every counted play in one session's text. */
export function parseSession(runtime: string): LoggedPlay[] {
  const session = new LogSession();
  const plays = session.feed(runtime.split(/\r?\n/));
  return [...plays, ...session.flush()];
}

export interface LogSessionFiles {
  /** The `<unix seconds>` prefix lazer names a session's files with. */
  id: string;
  runtime: string;
  network: string | null;
  /** Last modification of the runtime log, used to find the session in progress. */
  modifiedAt: number;
}

/** lazer keeps its logs beside its file store. osu!stable has no equivalent. */
export function logDirOf(install: OsuInstall): string | null {
  if (install.kind !== 'lazer') return null;
  return path.join(install.root, 'logs');
}

/**
 * The session log files in a directory, newest last.
 *
 * lazer opens a fresh `<unix seconds>.runtime.log` per launch and appends to it for the
 * lifetime of the session, so the newest is the one to follow.
 *
 * Ordered by that name, not by modification time. The name is when the session *started*
 * and never changes; an mtime can move backwards relative to it -- an older log touched by
 * a backup or a stray flush would look newest, and following it would mean re-reading a
 * finished session from the top.
 */
export function listLogSessions(dir: string): LogSessionFiles[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out: LogSessionFiles[] = [];
  for (const name of names) {
    const m = /^(\d+)\.runtime\.log$/.exec(name);
    if (!m) continue;
    const runtime = path.join(dir, name);
    let modifiedAt: number;
    try {
      modifiedAt = fs.statSync(runtime).mtimeMs;
    } catch {
      continue;
    }
    // The network log is written by a different logger and can lag or be absent; without
    // it a play still counts, it just has to find its beatmap by name.
    const network = path.join(dir, `${m[1]!}.network.log`);
    out.push({
      id: m[1]!,
      runtime,
      network: fs.existsSync(network) ? network : null,
      modifiedAt,
    });
  }

  return out.sort((a, b) => Number(a.id) - Number(b.id));
}
