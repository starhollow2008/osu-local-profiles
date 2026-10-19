import type { Db } from './db/index.ts';
import type { Ruleset } from './osr.ts';
import { getSettings } from './settings.ts';
import { fetchRankEvents, type RankEvent } from './clients/osu-web.ts';
import type { PlayerIdentity } from './player-identity.ts';
import { visibleSql } from './calc/eligibility.ts';
import { beatmapName, beatmapNameOriginal, NAME_COLUMNS, names } from './calc/metadata.ts';
import type { ActivityEvent } from './calc/history.ts';

/**
 * "achieved rank #488 on Yorushika - Tomin [Collab Extra] (osu!)" in Recent (roadmap 5.79).
 *
 * Only osu! knows where a play placed on a beatmap's leaderboard, so this is the one part of
 * the feed that needs the network, and it is entirely optional: a profile with no osu! account
 * linked, or with no connection, shows exactly what it always did.
 *
 * - **Whose:** the linked account, and only when it is the player's own -- osu! is signed in here
 *   as it, or the profile has plays under one of its names. A link made for someone else's
 *   banner is never asked about (`rankAccount`).
 * - **Which:** osu!'s events are the account's, and a profile is one playstyle. An event is kept
 *   only when it matches a play this profile tracked: same beatmap and mode, set within
 *   `MATCH_WINDOW_MS`. A left-hand profile shows no ranks from the right hand.
 * - **When:** one request a while after a play osu! could rank (`RankEventWatcher.played`), and
 *   one when the app starts. Never on a timer, and through the request gate like everything else
 *   asked of osu!. What matches is kept, since osu! lists only its newest 100 events, so a player
 *   online now and then catches up on whatever is still listed.
 */

/** How far apart a play and osu!'s event for it may be: the event is made as osu! takes the score. */
export const MATCH_WINDOW_MS = 15 * 60_000;

/** How long after a play to ask, so osu! has processed it, and so a run of plays asks once. */
export const ASK_AFTER_PLAY_MS = 90_000;

/** The osu! account whose rank events this profile shows, or null for none. */
export function rankAccount(db: Db, profileId: number, identity: PlayerIdentity): number | null {
  const settings = getSettings(db, profileId);
  if (settings.linkedUserId <= 0) return null;
  // The linked account is the one osu! says is signed in here.
  if (identity.source === 'linked') return settings.linkedUserId;
  const accountNames = [settings.linkedUsername, ...settings.linkedPreviousNames]
    .filter((name) => name !== '')
    .map((name) => name.toLowerCase());
  if (accountNames.length === 0) return null;
  // Or the profile's own plays were set under it.
  const played = db
    .prepare(
      `SELECT 1 AS hit FROM scores
        WHERE profile_id = ? AND LOWER(player_name) IN (${accountNames.map(() => '?').join(', ')}) LIMIT 1`,
    )
    .get(profileId, ...accountNames);
  return played === undefined ? null : settings.linkedUserId;
}

/**
 * Keep the events that match one of this profile's plays. Returns how many are new. A play
 * McOsu set never reached osu!, so never matches.
 */
export function saveRankEvents(db: Db, profileId: number, events: readonly RankEvent[]): number {
  const find = db.prepare(
    `SELECT s.dedupe_key FROM scores s
      WHERE s.profile_id = ? AND s.beatmap_id = ? AND s.mode = ? AND s.client <> 'mcosu'
        AND s.played_at BETWEEN ? AND ? AND ${visibleSql()}
      ORDER BY ABS(s.played_at - ?) ASC, s.id DESC LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO rank_events (profile_id, event_id, dedupe_key, rank, grade, achieved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const event of events) {
    const play = find.get(
      profileId,
      event.beatmapId,
      event.mode,
      event.at - MATCH_WINDOW_MS,
      event.at + MATCH_WINDOW_MS,
      event.at,
    ) as { dedupe_key: string } | undefined;
    if (play === undefined) continue;
    added += Number(
      insert.run(profileId, event.id, play.dedupe_key, event.rank, event.grade, event.at).changes,
    );
  }
  return added;
}

/** The profile's rank events for one mode, as Recent shows them, for plays still showing. */
export function rankActivityEvents(db: Db, profileId: number, mode: Ruleset): ActivityEvent[] {
  // Only the linked account's events are ever kept (`rankAccount`), so it is whose they are.
  const { linkedUserId, linkedUsername } = getSettings(db, profileId);
  const rows = db
    .prepare(
      `SELECT r.rank, r.grade, r.achieved_at, s.beatmap_id, ${NAME_COLUMNS}, b.version
         FROM rank_events r
         JOIN scores s ON s.profile_id = r.profile_id AND s.dedupe_key = r.dedupe_key
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE r.profile_id = ? AND s.mode = ? AND ${visibleSql()}`,
    )
    .all(profileId, mode) as {
    rank: number;
    grade: string;
    achieved_at: number;
    beatmap_id: number | null;
    title: string | null;
    artist: string | null;
    artist_unicode: string | null;
    title_unicode: string | null;
    version: string | null;
  }[];
  return rows.map((row) => ({
    type: 'rank' as const,
    at: row.achieved_at,
    userId: linkedUserId > 0 ? linkedUserId : null,
    username: linkedUsername,
    rank: row.rank,
    grade: row.grade,
    mode,
    beatmapId: row.beatmap_id,
    // A beatmap whose name was never read, as the best-performance entry falls back.
    title: beatmapName(names(row)) || (row.beatmap_id === null ? '?' : `beatmap ${row.beatmap_id}`),
    titleOriginal: beatmapNameOriginal(names(row)),
    version: row.version,
  }));
}

/** Forget a profile's rank events: a reset, which clears the plays they belong to. */
export function clearRankEvents(db: Db, profileId: number): void {
  db.prepare('DELETE FROM rank_events WHERE profile_id = ?').run(profileId);
}

export interface RankEventOptions {
  db: Db;
  /** The profile on screen, and who it belongs to, read when it is time to ask. */
  profileId: () => number;
  identity: () => PlayerIdentity;
  fetch?: (userId: number) => Promise<RankEvent[]>;
  /** Told when new events were kept, so the page can redraw Recent. */
  onNew?: (added: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * When to ask osu!: once at start (`catchUp`), and `ASK_AFTER_PLAY_MS` after the last of a run of
 * plays (`played`). Plays that come quicker than that push the one request back rather than
 * adding more. A failure -- offline, osu! down -- is quiet: the next play or launch asks again.
 */
export class RankEventWatcher {
  private readonly opts: RankEventOptions;
  private timer: unknown = null;
  private asking = false;

  constructor(opts: RankEventOptions) {
    this.opts = opts;
  }

  /** A play was just tracked. Only one osu! could rank is worth asking about. */
  played(play: { client: string; grade: string }): void {
    if (play.client === 'mcosu' || play.grade === 'F') return;
    if (this.account() === null) return;
    const clear = this.opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    if (this.timer !== null) clear(this.timer);
    this.timer = set(() => {
      this.timer = null;
      void this.catchUp();
    }, ASK_AFTER_PLAY_MS);
  }

  /** Ask now. Returns how many new events were kept; 0 when there was nobody to ask about. */
  async catchUp(): Promise<number> {
    if (this.asking) return 0;
    this.asking = true;
    try {
      const account = this.account();
      if (account === null) return 0;
      const events = await (this.opts.fetch ?? fetchRankEvents)(account);
      const added = saveRankEvents(this.opts.db, this.opts.profileId(), events);
      if (added > 0) this.opts.onNew?.(added);
      return added;
    } catch {
      return 0;
    } finally {
      this.asking = false;
    }
  }

  private account(): number | null {
    return rankAccount(this.opts.db, this.opts.profileId(), this.opts.identity());
  }
}
