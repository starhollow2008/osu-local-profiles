import type { Db } from '../db/index.ts';
import type { Ruleset } from '../osr.ts';
import { beatmapMode, type BeatmapResolver } from '../clients/beatmaps.ts';
import type { ResolvedLoggedPlay } from '../clients/lazer-log.ts';

/**
 * Turning a play read out of lazer's log into a tracked one.
 *
 * These are the plays osu! counts and the replay watcher can never see -- a quit, a retry,
 * or an HP fail outside multiplayer. What is knowable about them is only what the log says:
 * which beatmap, when, and that osu! accepted the submission. There is no accuracy, no
 * combo, no mod list and no pp, because lazer never writes any of it down. Nothing here
 * invents a substitute for the missing numbers.
 */

export interface IncompleteContext {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  /** Plays from before this instant are ignored, exactly as for replays. */
  trackingSince: number;
}

export interface IngestedIncomplete {
  id: number;
  mode: Ruleset;
  title: string;
  playedAt: number;
}

export type IncompleteOutcome =
  | { status: 'added'; play: IngestedIncomplete }
  | { status: 'skipped'; reason: 'passed' | 'too-old' | 'duplicate' | 'unresolved' };

/**
 * Find the beatmap by the only two handles the log offers.
 *
 * The submission URL's beatmap id is the good one, and `online.db` turns it into the MD5
 * everything else in this app is keyed by. The log's display name is the fallback for a map
 * lazer's cached `online.db` has not heard of yet; it only matches a beatmap already
 * resolved from a real score, which is exactly the case where the name is trustworthy.
 */
function findBeatmap(play: ResolvedLoggedPlay, ctx: IncompleteContext): string | null {
  if (play.beatmapId !== null) {
    const md5 = ctx.resolver.md5ForBeatmapId(play.beatmapId);
    if (md5) return md5;
  }

  if (!play.beatmapName) return null;
  // `BeatmapInfo.ToString()` is "{artist} - {title} ({creator}) [{version}]", built from the
  // same romanised metadata the cache stores, so this is an equality test and not a guess.
  const row = ctx.db
    .prepare(
      `SELECT md5 FROM beatmaps
        WHERE artist IS NOT NULL AND title IS NOT NULL
              AND creator IS NOT NULL AND version IS NOT NULL
              AND artist || ' - ' || title || ' (' || creator || ') [' || version || ']' = ?
        LIMIT 1`,
    )
    .get(play.beatmapName) as { md5: string } | undefined;
  return row?.md5 ?? null;
}

export function ingestIncompletePlay(
  play: ResolvedLoggedPlay,
  ctx: IncompleteContext,
): IncompleteOutcome {
  // A passed play was imported by lazer and reaches this app as a replay. Counting it here
  // as well would double every play in the profile.
  if (play.passed) return { status: 'skipped', reason: 'passed' };

  if (play.countedAt < ctx.trackingSince) return { status: 'skipped', reason: 'too-old' };

  const already = ctx.db
    .prepare('SELECT id FROM incomplete_plays WHERE profile_id = ? AND dedupe_key = ?')
    .get(ctx.profileId, play.token);
  if (already) return { status: 'skipped', reason: 'duplicate' };

  const md5 = findBeatmap(play, ctx);
  /*
   * Without a beatmap there is no mode to file the play under, and this app is arranged by
   * mode all the way down. Rather than park it in osu!standard and quietly inflate one
   * mode's play count, the play is dropped and says so. It needs lazer's `online.db` to be
   * missing the beatmap *and* the map to have never been resolved from a real score, which
   * in practice means a beatmap submitted more recently than the client's cached copy.
   */
  if (!md5) return { status: 'skipped', reason: 'unresolved' };

  const beatmap = ctx.resolver.resolve(md5);
  const mode = beatmap.osuPath ? beatmapMode(beatmap.osuPath) : 0;

  ctx.db
    .prepare(
      `INSERT INTO incomplete_plays
        (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, beatmap_name,
         played_at, started_at, online_score_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      ctx.profileId,
      play.token,
      mode,
      md5,
      beatmap.beatmapId,
      play.beatmapName,
      play.countedAt,
      play.startedAt,
      play.onlineScoreId,
    );

  const id = (ctx.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  const title = [beatmap.artist, beatmap.title].filter(Boolean).join(' - ') || md5.slice(0, 12);

  return {
    status: 'added',
    play: {
      id,
      mode,
      title: beatmap.version ? `${title} [${beatmap.version}]` : title,
      playedAt: play.countedAt,
    },
  };
}
