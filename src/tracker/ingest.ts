import { wasDeleted } from '../scores.ts';
import { findExistingScore, replayIdentity } from './online-import.ts';
import { ownsPlay, replayPlayer, UNKNOWN_IDENTITY, type PlayerIdentity } from '../player-identity.ts';
import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import { parseReplay, type ReplayScore, type Ruleset } from '../osr.ts';
import { awardsPp, UNRESOLVED_STATUS, type BeatmapResolver } from '../clients/beatmaps.ts';
import {
  calculateScorePp,
  modsCountable,
  modsLabel,
  rankedByOsu,
  scoreMods,
  strippableMods,
} from '../calc/pp.ts';
import type { OfficialCalculator } from '../calc/official.ts';
import { accuracy, gradeOf, passed } from '../calc/grade.ts';
import {
  beatmapFilterFacts,
  defaultTrackingFilter,
  filterRejects,
  playFacts,
  type FilterCriterion,
  type TrackingFilter,
} from '../tracking-filter.ts';

export interface IngestContext {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  /** Replays from before this instant are ignored. */
  trackingSince: number;
  /** osu!'s own pp calculator. When null, scores are stored with no pp rather than a guess. */
  official: OfficialCalculator | null;
  /**
   * Which plays this profile tracks at all (src/tracking-filter.ts). Omitted means no
   * filtering, which is the safe default for a caller that is re-ingesting *stored* scores --
   * `scripts/reingest.mjs` rebuilds every row it already has, and a filter applied there
   * would delete scores rather than decline new ones.
   */
  filter?: TrackingFilter;
  /**
   * Who this profile's plays belong to, so a replay someone else set is not tracked as one
   * of them. Omitted means nothing is known and every replay is taken, which is both the
   * old behaviour and the right answer for a re-ingest of rows already here.
   */
  identity?: PlayerIdentity;
}

export interface IngestedScore {
  id: number;
  mode: Ruleset;
  title: string;
  modsLabel: string;
  accuracy: number;
  grade: string;
  /** pp for the play as it happened, which now exists even for scores osu! would not rank. */
  pp: number | null;
  /** pp with Relax/Autopilot removed, when the score carries one. */
  ppNomod: number | null;
  ppSource: 'official' | null;
  stars: number | null;
  /** Whether osu! itself would rank this score. Unranked ones still carry a pp value. */
  ranked: boolean;
  /** Whether the *beatmap* allows pp, which no mod setting can override. */
  mapRanked: boolean;
  playedAt: number;
}

export type IngestOutcome =
  | { status: 'added'; score: IngestedScore }
  | {
      status: 'skipped';
      reason: 'too-old' | 'duplicate' | 'deleted' | 'unparseable' | 'not-passed' | 'another-player';
      /** Who set it, on `another-player`, so the console can name them rather than hint. */
      player?: string;
    }
  /**
   * Turned away by the profile's play tracking filter, which is not the same event as a skip:
   * the others are "this is already here" or "this is not readable", while this one is a
   * decision the user made. It carries what the play was and which criterion rejected it, so
   * the console and the page can say so rather than the play vanishing silently.
   */
  | { status: 'filtered'; criterion: FilterCriterion; title: string };

/**
 * What to call the play in a message. Hoisted out of the result because a play the filter
 * turns away needs naming too, and there is nothing else to identify it by.
 */
function describe(beatmap: { artist: string | null; title: string | null; version: string | null }, md5: string): string {
  const title = [beatmap.artist, beatmap.title].filter(Boolean).join(' - ') || md5.slice(0, 12);
  return beatmap.version ? `${title} [${beatmap.version}]` : title;
}

/** A replay identifies itself; fall back to map+time for stable replays with no hash. */
export function dedupeKey(score: ReplayScore): string {
  return score.replayMD5 ?? `${score.beatmapMD5}:${score.playedAt.getTime()}`;
}

export async function ingestReplayFile(file: string, ctx: IngestContext): Promise<IngestOutcome> {
  let score: ReplayScore;
  try {
    score = await parseReplay(fs.readFileSync(file));
  } catch {
    return { status: 'skipped', reason: 'unparseable' };
  }
  return await ingestScore(score, file, ctx);
}

export async function ingestScore(
  score: ReplayScore,
  replayPath: string,
  ctx: IngestContext,
): Promise<IngestOutcome> {
  const playedAt = score.playedAt.getTime();
  if (playedAt < ctx.trackingSince) return { status: 'skipped', reason: 'too-old' };

  /*
   * Someone else's play.
   *
   * osu! keeps the replays you watch in the same folders as the ones you set -- stable caches
   * a downloaded leaderboard replay in `Data/r`, lazer imports one into its store -- and
   * nothing about the file says which it is. Only the name inside it does. Checked before
   * anything is read or priced, because a play that is not yours is not a play at all.
   *
   * `ownsPlay` answers null when the profile cannot say who it belongs to, and null is taken
   * as yours: not knowing must never cost anybody a play. See src/player-identity.ts.
   */
  const player = replayPlayer(score);
  if (ownsPlay(ctx.identity ?? UNKNOWN_IDENTITY, player) === false) {
    return { status: 'skipped', reason: 'another-player', player: player.name.trim() };
  }

  const key = dedupeKey(score);
  const already = ctx.db
    .prepare('SELECT id FROM scores WHERE profile_id = ? AND dedupe_key = ?')
    .get(ctx.profileId, key);
  if (already) return { status: 'skipped', reason: 'duplicate' };
  // Deleted for good from Settings: the replay is still on disk, and must stay out.
  if (wasDeleted(ctx.db, ctx.profileId, key)) return { status: 'skipped', reason: 'deleted' };
  /*
   * The same play, already here under osu!'s own record of it.
   *
   * `dedupe_key` cannot catch this: a replay keys on its own hash and an imported score on
   * osu!'s id, so the two never collide however much they describe the same play. This is
   * what stops Import past plays from doubling every best performance an import brought in.
   * The imported row is left as it stands -- osu! priced that play itself, and matching what
   * the website shows is the whole point of having imported it.
   */
  if (findExistingScore(ctx.db, ctx.profileId, replayIdentity(score)) !== null) {
    return { status: 'skipped', reason: 'duplicate' };
  }

  const mode = score.mode;
  const beatmap = ctx.resolver.resolve(score.beatmapMD5);
  const mods = scoreMods(score);
  const label = modsLabel(mods);
  const didPass = passed(score);
  const grade = gradeOf(score, mode, mods);
  const acc = accuracy(score, mode);

  const mapRanked = awardsPp(beatmap.status);
  const countable = modsCountable(mods);

  const named = describe(beatmap, score.beatmapMD5);

  /*
   * The play tracking filter, in two halves, because the star rating is the one criterion
   * that costs a round trip to osu!'s calculator: everything else is decided first, so a play
   * rejected on its mods or its length is never priced at all.
   *
   * Nothing is looked up while the filter is off, which is the default -- `beatmapFilterFacts`
   * reads the beatmap file the first time it sees each map.
   */
  const filter = ctx.filter ?? defaultTrackingFilter();
  let facts = null;
  if (filter.enabled) {
    facts = beatmapFilterFacts(ctx.db, ctx.resolver, beatmap);
    const rejected = filterRejects(filter, playFacts(facts, mode, mods));
    if (rejected) return { status: 'filtered', criterion: rejected, title: named };
  }

  /*
   * pp is calculated for *every* score we can calculate one for, not only the ranked ones.
   *
   * The alternative -- calculating lazily when a setting is turned on -- would make that
   * toggle a minutes-long job needing the pp helper running, on scores whose replays may no
   * longer be on disk. Storing the number and deciding at query time makes including or
   * excluding a class of score instant and reversible.
   */
  const computed = beatmap.osuPath
    ? await calculateScorePp(replayPath, beatmap.osuPath, ctx.official)
    : null;

  // The filter's second half: the star rating as played, now that osu! has produced one. A
  // play whose rating could not be calculated is not rejected on it -- see filterRejects.
  if (facts !== null && computed !== null) {
    const rejected = filterRejects(filter, { stars: computed.stars });
    if (rejected) return { status: 'filtered', criterion: rejected, title: named };
  }

  /*
   * A second pass with Relax/Autopilot removed, which is what "count it as if the mod were
   * not on" means. osu!'s difficulty calculator is relax-aware, so this is a genuinely
   * different number and not a rescaling: 6.26 stars and 111pp as played, 7.83 and 239 with
   * RX stripped, on the same replay.
   */
  const strippable = strippableMods(mods);
  const stripped =
    strippable.length > 0 && beatmap.osuPath
      ? await calculateScorePp(replayPath, beatmap.osuPath, ctx.official, strippable)
      : null;

  // Asked of osu! after the filter, so a play it turns away costs no round trip.
  const modsRanked = await rankedByOsu(score, ctx.official);
  // What osu! itself would say. Kept as `ranked` so nothing downstream shifts meaning. Mods
  // osu! could not be asked about are not ranked until a recompute asks again.
  const eligible = mapRanked && modsRanked === true;

  ctx.db
    .prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         statistics_json, max_statistics_json,
         accuracy, max_combo, total_score, score_standard, score_classic, passed, grade, stars, pp, pp_source,
         pp_nomod, stars_nomod, beatmap_max_combo, map_status, mods_ranked, mods_ranked_by,
         mods_countable, ranked, played_at, online_score_id, replay_path, pp_parts, pp_nomod_parts,
         pp_version, player_name, player_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      ctx.profileId, key, mode, score.beatmapMD5, beatmap.beatmapId, score.client,
      JSON.stringify(mods), label,
      score.count300, score.count100, score.count50, score.countGeki, score.countKatu, score.countMiss,
      score.extras?.statistics ? JSON.stringify(score.extras.statistics) : null,
      score.extras?.maximum_statistics ? JSON.stringify(score.extras.maximum_statistics) : null,
      acc, score.maxCombo, score.totalScore,
      // osu!'s own two scales, so the profile can be read on either without a recalculation.
      computed?.standardisedScore ?? null, computed?.classicScore ?? null,
      didPass ? 1 : 0, grade,
      computed?.stars ?? null, computed?.pp ?? null, computed ? 'official' : null,
      stripped?.pp ?? null, stripped?.stars ?? null,
      computed?.maxCombo ?? null,
      beatmap.status ?? UNRESOLVED_STATUS,
      modsRanked === null ? null : modsRanked ? 1 : 0,
      modsRanked === null ? null : (ctx.official?.version ?? 'unknown'),
      countable ? 1 : 0,
      eligible ? 1 : 0,
      playedAt,
      /*
       * The id osu! gave the score, preferring lazer's own block over the legacy header --
       * lazer writes 0 in the header and the real one inside. Reading only the header stored
       * a 0 for every lazer play, which both hid whether the play was ever submitted and
       * left the match against an imported osu! score leaning on its weaker fallback.
       */
      player.onlineId === null ? null : String(player.onlineId),
      replayPath,
      computed ? JSON.stringify(computed.breakdown) : null,
      stripped ? JSON.stringify(stripped.breakdown) : null,
      computed?.version ?? null,
      // Recorded on the row so the clean-up and the identity inference never have to go back
      // to a replay file that may no longer be on disk.
      player.name,
      player.userId,
    );

  const id = (ctx.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  return {
    status: 'added',
    score: {
      id,
      mode,
      title: named,
      modsLabel: label,
      accuracy: acc,
      grade,
      pp: computed?.pp ?? null,
      ppNomod: stripped?.pp ?? null,
      ppSource: computed ? 'official' : null,
      stars: computed?.stars ?? null,
      ranked: eligible,
      mapRanked,
      playedAt,
    },
  };
}
