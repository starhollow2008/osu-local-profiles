import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import {
  listLogSessions,
  parseSessionEvents,
  parseSubmissionBeatmaps,
  type ResolvedLoggedPlay,
  type SessionAttempt,
} from '../clients/lazer-log.ts';
import { attemptKey } from './incomplete.ts';

/**
 * Past unfinished plays, read back out of osu!lazer's session logs for Import past plays.
 *
 * The live watcher follows a log from its current end, so a play made while this app was closed
 * exists only in a log already on disk. Reading those is the same decision as importing past
 * replays, and it gets the same treatment: an explicit cutoff, a preview, a confirmation, and
 * never on startup -- a profile must not quietly absorb plays made with someone's normal
 * playstyle.
 *
 * Both kinds come back: plays osu! counted (`Score submission completed!`) and attempts osu! could
 * not submit (`No token`). A pass is left out, because lazer imported it and it is a replay,
 * which Import past plays reads on its own.
 */

export interface LogBackfillScan {
  /** Unfinished plays osu! counted, from the cutoff on, not yet in this profile. */
  unfinished: ResolvedLoggedPlay[];
  /** Attempts osu! could not submit, from the cutoff on, not yet in this profile. */
  attempts: SessionAttempt[];
  /** Plays of either kind from the cutoff on that this profile already holds. */
  alreadyTracked: number;
  /** Session logs read. */
  sessions: number;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function scanLogsForPlays(
  db: Db,
  profileId: number,
  dirs: readonly string[],
  since: number,
): LogBackfillScan {
  const recorded = db.prepare(
    'SELECT 1 AS hit FROM incomplete_plays WHERE profile_id = ? AND dedupe_key = ?',
  );
  const isRecorded = (key: string) => recorded.get(profileId, key) !== undefined;

  const unfinished: ResolvedLoggedPlay[] = [];
  const attempts: SessionAttempt[] = [];
  const seen = new Set<string>();
  let alreadyTracked = 0;
  let sessions = 0;

  for (const dir of dirs) {
    for (const files of listLogSessions(dir)) {
      // A log last written before the cutoff cannot hold anything played after it.
      if (files.modifiedAt < since) continue;
      sessions++;

      const events = parseSessionEvents(readText(files.runtime));
      // The beatmap id of a counted play is only in the network log's submission request.
      const ids = files.network
        ? parseSubmissionBeatmaps(readText(files.network))
        : new Map<string, number>();

      for (const play of events.plays) {
        if (play.passed || play.countedAt < since || seen.has(play.token)) continue;
        seen.add(play.token);
        if (isRecorded(play.token)) {
          alreadyTracked++;
          continue;
        }
        unfinished.push({ ...play, beatmapId: ids.get(play.token) ?? null });
      }

      for (const found of events.attempts) {
        const attempt: SessionAttempt = { ...found, session: files.id };
        const key = attemptKey(attempt);
        if (attempt.endedAt < since || seen.has(key)) continue;
        seen.add(key);
        if (isRecorded(key)) {
          alreadyTracked++;
          continue;
        }
        attempts.push(attempt);
      }
    }
  }

  unfinished.sort((a, b) => a.countedAt - b.countedAt);
  attempts.sort((a, b) => a.endedAt - b.endedAt);
  return { unfinished, attempts, alreadyTracked, sessions };
}
