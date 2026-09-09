import fs from 'node:fs';
import type { Db } from '../db/index.ts';
import { parseReplay, type ReplayScore, type Ruleset } from '../osr.ts';
import { awardsPp, type BeatmapResolver } from '../clients/beatmaps.ts';
import { calculateScorePp, modsAwardPp, modsLabel, scoreMods } from '../calc/pp.ts';
import type { OfficialCalculator } from '../calc/official.ts';
import { accuracy, gradeOf, passed } from '../calc/grade.ts';

export interface IngestContext {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  /** Replays from before this instant are ignored. */
  trackingSince: number;
  /** osu!'s own pp calculator. When null, scores are stored with no pp rather than a guess. */
  official: OfficialCalculator | null;
}

export interface IngestedScore {
  id: number;
  mode: Ruleset;
  title: string;
  modsLabel: string;
  accuracy: number;
  grade: string;
  pp: number | null;
  ppSource: 'official' | null;
  stars: number | null;
  ranked: boolean;
  playedAt: number;
}

export type IngestOutcome =
  | { status: 'added'; score: IngestedScore }
  | { status: 'skipped'; reason: 'too-old' | 'duplicate' | 'unparseable' | 'not-passed' };

/** A replay identifies itself; fall back to map+time for stable replays with no hash. */
function dedupeKey(score: ReplayScore): string {
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

  const key = dedupeKey(score);
  const already = ctx.db
    .prepare('SELECT id FROM scores WHERE profile_id = ? AND dedupe_key = ?')
    .get(ctx.profileId, key);
  if (already) return { status: 'skipped', reason: 'duplicate' };

  const mode = score.mode;
  const beatmap = ctx.resolver.resolve(score.beatmapMD5);
  const mods = scoreMods(score);
  const label = modsLabel(mods);
  const didPass = passed(score);
  const grade = gradeOf(score, mode, mods);
  const acc = accuracy(score, mode);

  // pp is only real when the map is ranked AND the mods keep the score ranked.
  const eligible = awardsPp(beatmap.status) && modsAwardPp(mods);
  const computed =
    eligible && beatmap.osuPath
      ? await calculateScorePp(replayPath, beatmap.osuPath, ctx.official)
      : null;

  ctx.db
    .prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         statistics_json, max_statistics_json,
         accuracy, max_combo, total_score, passed, grade, stars, pp, pp_source, ranked,
         played_at, online_score_id, replay_path)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      ctx.profileId, key, mode, score.beatmapMD5, beatmap.beatmapId, score.client,
      JSON.stringify(mods), label,
      score.count300, score.count100, score.count50, score.countGeki, score.countKatu, score.countMiss,
      score.extras?.statistics ? JSON.stringify(score.extras.statistics) : null,
      score.extras?.maximum_statistics ? JSON.stringify(score.extras.maximum_statistics) : null,
      acc, score.maxCombo, score.totalScore, didPass ? 1 : 0, grade,
      computed?.stars ?? null, computed?.pp ?? null, computed ? 'official' : null,
      eligible ? 1 : 0,
      playedAt,
      score.onlineScoreId === null ? null : String(score.onlineScoreId),
      replayPath,
    );

  const id = (ctx.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

  const title = [beatmap.artist, beatmap.title].filter(Boolean).join(' - ') || score.beatmapMD5.slice(0, 12);

  return {
    status: 'added',
    score: {
      id,
      mode,
      title: beatmap.version ? `${title} [${beatmap.version}]` : title,
      modsLabel: label,
      accuracy: acc,
      grade,
      pp: computed?.pp ?? null,
      ppSource: computed ? 'official' : null,
      stars: computed?.stars ?? null,
      ranked: eligible,
      playedAt,
    },
  };
}
