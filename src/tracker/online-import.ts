import type { Db } from '../db/index.ts';
import type { ReplayScore, Ruleset } from '../osr.ts';
import type { BeatmapResolver } from '../clients/beatmaps.ts';
import { UNRESOLVED_STATUS, awardsPp } from '../clients/beatmaps.ts';
import { modsCountable, modsLabel, TOP_PLAY_LIMIT, WEIGHT } from '../calc/pp.ts';
import { saveStanding } from '../standing.ts';
import { applyScoreAction, wasDeleted } from '../scores.ts';
import type { OsuWebScore, OsuWebStanding } from '../clients/osu-web.ts';

/**
 * Bringing an osu! account's own record of its plays into a profile.
 *
 * This is the one part of the app that learns about a play from somewhere other than this
 * machine, and it exists because the machine cannot always know. A best performance may have
 * been set years ago, on another PC, on a beatmap that was never installed here and whose
 * replay this computer has never held -- there is nothing local to read, and no amount of
 * scanning will find it. osu! still has it, so it is asked.
 *
 * Everything here follows the same rules as the rest of the osu! import: no credentials, no
 * API key, one request per list, and only ever because a button was pressed.
 *
 * **These scores carry osu!'s own pp, and nothing recomputes it.** The project's rule is that
 * pp comes only from osu!'s own code (`CLAUDE.md`), and a number osu! itself published is
 * exactly that -- more authoritative than anything this app could produce, since it priced
 * the play when it happened. What cannot come with it is a breakdown: the helper needs the
 * replay file, and there is none. So `pp_parts` stays NULL and `pp_source` says `osu-web`,
 * which keeps the rule that a breakdown always belongs to the pp printed beside it. A
 * recompute skips these rows for the same reason -- see `imported_at`.
 */

/**
 * The tolerance for matching a play by when it happened, when there is no id to match on.
 *
 * Two clocks are being compared: the instant osu!'s server recorded the submission, and the
 * instant this machine wrote the replay. They are the same event a second or two apart, but
 * a machine whose clock has drifted can be further out, so the window is generous. It is
 * never the only test -- see `findExistingScore`.
 */
const TIME_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Mods that leave a beatmap's star rating exactly as it is.
 *
 * Needed because osu! hands over the beatmap's *unmodded* rating and nothing else: there is
 * no as-played rating in the payload, and no replay here to ask the difficulty calculator
 * about. So a play wearing only these mods can take the beatmap's rating as its own, and any
 * other play stores no rating at all rather than one that is wrong -- a DT play is not its
 * nomod difficulty, and showing it as such would be worse than showing nothing.
 */
const RATING_NEUTRAL_MODS = new Set(['NF', 'SD', 'PF', 'SO', 'HD', 'CL', 'MR', 'TD']);

/**
 * How a play is recognised, whichever side it is seen from.
 *
 * The same play can arrive twice -- once from osu!'s record of it, once from its replay when
 * the user later imports their history off this machine -- and the two must land on the same
 * row. Neither side has a single field that always exists, so this is what they share.
 */
export interface PlayIdentity {
  /**
   * Every online id this play is known by. osu!stable and lazer number scores differently,
   * a replay carries whichever its client used, and an imported score carries both, so they
   * are matched as a set rather than field against field.
   */
  onlineIds: string[];
  beatmapMD5: string;
  playedAt: number;
  maxCombo: number;
  /**
   * The play's total on every scale it might have been stored on. A stable row holds osu!'s
   * old uncapped total, a lazer row the standardised one, and an import knows both -- so the
   * one that was actually written is in here whichever client set the play.
   */
  totals: number[];
}

/**
 * The row this play is already on in this profile, or null.
 *
 * Two tests, strongest first.
 *
 * **An online id.** Conclusive when there is one: osu! issues it per play, and both a replay
 * and an imported score carry it. It is checked against both id columns in both directions,
 * because `online_score_id` holds a stable id on a stable row and a lazer id on a lazer one,
 * while an import fills in `legacy_score_id` beside it.
 *
 * **The play itself.** For a replay too old to carry an id -- osu!stable only began recording
 * one in 2014 -- the same beatmap, the same total on some scale, the same max combo and the
 * same moment within `TIME_TOLERANCE_MS`. Four agreeing facts, and the total is exact, so
 * this does not match a different play; a retry that scored identically to the byte is not
 * something to worry about missing.
 *
 * Deliberately not a test on `dedupe_key`: the two sides derive that key from different
 * things -- a replay from its own hash, an import from osu!'s id -- and could never agree.
 */
export function findExistingScore(
  db: Db,
  profileId: number,
  identity: PlayIdentity,
): { id: number; imported: boolean } | null {
  const ids = [...new Set(identity.onlineIds.filter((v) => v !== '' && v !== '0'))];
  if (ids.length > 0) {
    const marks = ids.map(() => '?').join(',');
    const byId = db
      .prepare(
        `SELECT id, imported_at FROM scores
          WHERE profile_id = ?
            AND (online_score_id IN (${marks}) OR legacy_score_id IN (${marks}))
          LIMIT 1`,
      )
      .get(profileId, ...ids, ...ids) as { id: number; imported_at: number | null } | undefined;
    if (byId) return { id: byId.id, imported: byId.imported_at !== null };
  }

  const totals = [...new Set(identity.totals.filter((t) => Number.isFinite(t)))];
  if (totals.length === 0) return null;
  const marks = totals.map(() => '?').join(',');
  const byPlay = db
    .prepare(
      `SELECT id, imported_at FROM scores
        WHERE profile_id = ?
          AND beatmap_md5 = ?
          AND total_score IN (${marks})
          AND max_combo = ?
          AND ABS(played_at - ?) <= ?
        LIMIT 1`,
    )
    .get(
      profileId,
      identity.beatmapMD5,
      ...totals,
      identity.maxCombo,
      identity.playedAt,
      TIME_TOLERANCE_MS,
    ) as { id: number; imported_at: number | null } | undefined;
  return byPlay ? { id: byPlay.id, imported: byPlay.imported_at !== null } : null;
}

/** How an imported score names itself in `dedupe_key`, and so in `deleted_scores`. */
export const importedDedupeKey = (score: OsuWebScore): string => `osu:${score.id}`;

/** Whether this play was set on osu!stable, which is what decides the scale of its total. */
function fromStable(score: OsuWebScore): boolean {
  return score.legacyScoreId !== null || score.mods.some((m) => m.acronym === 'CL');
}

/**
 * The total this play would have been stored with had its replay been tracked here: osu!'s
 * old uncapped number for a stable play, the standardised one for a lazer play.
 *
 * Matching what a replay would have written is the whole point -- it is what lets
 * `findExistingScore` recognise the two as one play without an id.
 */
function nativeTotal(score: OsuWebScore): number {
  return fromStable(score) ? (score.legacyTotalScore ?? score.totalScore) : score.totalScore;
}

/** Every scale this play's total is known on, for matching against a row already stored. */
function totalsOf(score: OsuWebScore): number[] {
  return [score.totalScore, score.legacyTotalScore, score.classicTotalScore].filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t),
  );
}

/**
 * How a replay on this machine names the play it holds.
 *
 * The counterpart to `identityOf`, and the reason importing a whole replay history after
 * importing best performances does not double anything: both sides describe the play the
 * same way, so `findExistingScore` recognises them as one.
 */
export function replayIdentity(score: ReplayScore): PlayIdentity {
  return {
    // A replay carries whichever id its client used, and stable wrote 0 for a play it never
    // submitted -- which `findExistingScore` discards.
    onlineIds: score.onlineScoreId === null ? [] : [String(score.onlineScoreId)],
    beatmapMD5: score.beatmapMD5,
    playedAt: score.playedAt.getTime(),
    maxCombo: score.maxCombo,
    totals: [score.totalScore],
  };
}

export function identityOf(score: OsuWebScore): PlayIdentity {
  return {
    onlineIds: [score.id, ...(score.legacyScoreId === null ? [] : [score.legacyScoreId])],
    beatmapMD5: score.beatmapMD5,
    playedAt: score.playedAt,
    maxCombo: score.maxCombo,
    totals: totalsOf(score),
  };
}

/**
 * lazer's judgement names to osu!stable's six counters.
 *
 * Only the display columns need these -- accuracy and the grade both come from osu! itself --
 * but grade counts and hits-per-play read them, so a mode's judgements are mapped rather than
 * left at zero. Anything unrecognised is ignored: an invented count would be worse than a
 * missing one, exactly as in `lazerAccuracy`.
 */
function legacyCounts(
  statistics: Record<string, number>,
  mode: Ruleset,
): { c300: number; c100: number; c50: number; geki: number; katu: number; miss: number } {
  const n = (key: string) => statistics[key] ?? 0;
  const miss = n('miss');
  switch (mode) {
    case 0:
      return { c300: n('great'), c100: n('ok'), c50: n('meh'), geki: 0, katu: 0, miss };
    case 1:
      return { c300: n('great'), c100: n('ok'), c50: 0, geki: 0, katu: 0, miss };
    case 2:
      return {
        c300: n('great'),
        c100: n('large_tick_hit'),
        c50: n('small_tick_hit'),
        geki: 0,
        katu: n('small_tick_miss'),
        miss,
      };
    case 3:
      return {
        c300: n('great'),
        c100: n('ok'),
        c50: n('meh'),
        geki: n('perfect'),
        katu: n('good'),
        miss,
      };
  }
}

/** The star rating this play can honestly claim; see `RATING_NEUTRAL_MODS`. */
function ratingOf(score: OsuWebScore): number | null {
  return score.mods.every((m) => RATING_NEUTRAL_MODS.has(m.acronym)) ? score.beatmapStars : null;
}

/**
 * Keep what osu! said about the beatmap, so a map that is not installed here still has a name
 * on the page.
 *
 * Fills blanks only. A beatmap this machine holds has been read from its own `.osu` file and
 * from `online.db`, and those are about *this* copy of it; osu!'s answer is about the current
 * one online. Where the local answer exists it stays, so an import can never quietly restate
 * what is installed -- it only speaks for maps nothing here can describe.
 */
function cacheBeatmap(db: Db, resolver: BeatmapResolver, score: OsuWebScore): number | null {
  // Resolving first creates the row if there is none, so the update below always has one.
  const local = resolver.resolve(score.beatmapMD5);

  db.prepare(
    `UPDATE beatmaps
        SET beatmap_id    = COALESCE(beatmap_id, ?),
            beatmapset_id = COALESCE(beatmapset_id, ?),
            artist        = COALESCE(artist, ?),
            title         = COALESCE(title, ?),
            version       = COALESCE(version, ?),
            creator       = COALESCE(creator, ?),
            stars         = COALESCE(stars, ?),
            status        = CASE WHEN status IS NULL OR status = ? THEN ? ELSE status END
      WHERE md5 = ?`,
  ).run(
    score.beatmapId,
    score.beatmapsetId,
    score.artist,
    score.title,
    score.version,
    score.creator,
    score.beatmapStars,
    UNRESOLVED_STATUS,
    score.mapStatus,
    score.beatmapMD5,
  );

  return local.status ?? score.mapStatus;
}

/** What to call an imported play on screen. */
export function describeImported(score: OsuWebScore): string {
  const name = [score.artist, score.title].filter(Boolean).join(' - ') || score.beatmapMD5.slice(0, 12);
  return score.version ? `${name} [${score.version}]` : name;
}

export type ImportOutcome =
  | { status: 'added'; id: number }
  | { status: 'updated'; id: number }
  /** Already here from its replay, which is the better record: it has a pp breakdown. */
  | { status: 'tracked'; id: number }
  | { status: 'skipped'; reason: 'deleted' };

/**
 * Write one of osu!'s scores into the profile, or recognise the play as already here.
 *
 * A play already tracked from its replay is left exactly as it is. That row was priced by
 * osu!'s calculator on this machine and carries the breakdown to prove it, which is strictly
 * more than an import can offer, and overwriting it would trade information for none.
 *
 * A row a previous import wrote is updated rather than skipped, because osu! reworks pp and
 * re-ranks beatmaps: importing again is how a profile picks that up.
 */
export function importScore(
  db: Db,
  resolver: BeatmapResolver,
  profileId: number,
  score: OsuWebScore,
): ImportOutcome {
  const key = importedDedupeKey(score);
  // Deleted for good from Settings: it must stay out, exactly as a replay would.
  if (wasDeleted(db, profileId, key)) return { status: 'skipped', reason: 'deleted' };

  const existing = findExistingScore(db, profileId, identityOf(score));
  if (existing && !existing.imported) return { status: 'tracked', id: existing.id };

  const status = cacheBeatmap(db, resolver, score);
  const counts = legacyCounts(score.statistics, score.mode);
  const mapRanked = awardsPp(status);
  // osu!'s own verdict on the whole score, which is what `ranked` has always meant. Nothing
  // here asks the local calculator: osu! has already answered for this exact play.
  const eligible = score.ranked && mapRanked;
  const now = Date.now();

  const values = [
    score.mode,
    score.beatmapMD5,
    score.beatmapId,
    fromStable(score) ? 'stable' : 'lazer',
    JSON.stringify(score.mods),
    modsLabel(score.mods),
    counts.c300,
    counts.c100,
    counts.c50,
    counts.geki,
    counts.katu,
    counts.miss,
    JSON.stringify(score.statistics),
    JSON.stringify(score.maximumStatistics),
    score.accuracy,
    score.maxCombo,
    nativeTotal(score),
    score.totalScore,
    score.classicTotalScore,
    score.passed ? 1 : 0,
    score.grade,
    ratingOf(score),
    score.pp,
    score.pp === null ? null : 'osu-web',
    status ?? UNRESOLVED_STATUS,
    score.ranked ? 1 : 0,
    'osu.ppy.sh',
    modsCountable(score.mods) ? 1 : 0,
    eligible ? 1 : 0,
    score.playedAt,
    score.id,
    score.legacyScoreId,
    now,
  ];

  if (existing) {
    db.prepare(
      `UPDATE scores SET
         mode = ?, beatmap_md5 = ?, beatmap_id = ?, client = ?, mods_json = ?, mods_label = ?,
         count300 = ?, count100 = ?, count50 = ?, count_geki = ?, count_katu = ?, count_miss = ?,
         statistics_json = ?, max_statistics_json = ?, accuracy = ?, max_combo = ?,
         total_score = ?, score_standard = ?, score_classic = ?, passed = ?, grade = ?,
         stars = ?, pp = ?, pp_source = ?, map_status = ?, mods_ranked = ?, mods_ranked_by = ?,
         mods_countable = ?, ranked = ?, played_at = ?, online_score_id = ?,
         legacy_score_id = ?, imported_at = ?
       WHERE id = ?`,
    ).run(...values, existing.id);
    return { status: 'updated', id: existing.id };
  }

  db.prepare(
    `INSERT INTO scores
       (profile_id, dedupe_key,
        mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
        count300, count100, count50, count_geki, count_katu, count_miss,
        statistics_json, max_statistics_json, accuracy, max_combo,
        total_score, score_standard, score_classic, passed, grade,
        stars, pp, pp_source, map_status, mods_ranked, mods_ranked_by,
        mods_countable, ranked, played_at, online_score_id, legacy_score_id, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(profileId, key, ...values);

  const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return { status: 'added', id };
}

/** What one ruleset's import did, as the dialog reports it. */
export interface ModeImportResult {
  mode: Ruleset;
  /** Best performances osu! handed over, before anything was decided about them. */
  found: number;
  added: number;
  updated: number;
  /** Already in this profile from their own replays, and left alone. */
  tracked: number;
  /** Deleted for good from Settings, so kept out. */
  skipped: number;
  pinned: number;
  /** The bonus pp borrowed from osu!, when its standing could be read. */
  bonusPp: number | null;
  osuTotalPp: number | null;
  osuGlobalRank: number | null;
}

/**
 * The part of osu!'s own total that this profile cannot work out from the scores it was given.
 *
 * Mostly bonus pp, which osu! awards for how many distinct ranked beatmaps have ever been
 * played -- a fact about a whole play history, not about a top-200 list. Measured against the
 * account this was built on: 7,380.07 total against 6,965.99 weighted over all 200 leaves
 * 414.08, for an account with 106,387 plays behind it. `bonusPp` here tops out at 413.894 on
 * any number of beatmaps, so a profile holding 200 imported scores could not reach that
 * figure however it were counted.
 *
 * The rest of it is the tail. osu! weighs every best performance it keeps; this app weighs
 * `TOP_PLAY_LIMIT` of them, and on that same account scores 100 to 199 are worth 34.14pp that
 * it would otherwise simply lose. So the subtraction is made against the weighted sum *this
 * app* would compute, not against all 200 -- which is what makes the imported profile's total
 * land on osu!'s own rather than a little under it.
 *
 * Null when osu!'s standing could not be read, and never negative: a profile is not made
 * worse by a number that arrived garbled.
 */
export function borrowedBonusPp(
  best: readonly OsuWebScore[],
  standing: OsuWebStanding,
): number | null {
  if (standing.totalPp === null) return null;
  const weighted = best
    .slice(0, TOP_PLAY_LIMIT)
    .reduce((sum, score, i) => sum + (score.pp ?? 0) * WEIGHT ** i, 0);
  return Math.max(0, standing.totalPp - weighted);
}

/**
 * Import one ruleset's best performances and pinned scores.
 *
 * Both lists in one pass, because they overlap: a pinned play is very often also a best
 * performance, and importing them separately would either write it twice or need the two
 * runs to know about each other. The pins are applied last, in osu!'s own order, so the
 * profile's pinned list reads the way the osu! profile does.
 */
export function importMode(
  db: Db,
  resolver: BeatmapResolver,
  profileId: number,
  mode: Ruleset,
  best: readonly OsuWebScore[],
  pinned: readonly OsuWebScore[],
  standing: OsuWebStanding | null,
): ModeImportResult {
  const result: ModeImportResult = {
    mode,
    found: best.length,
    added: 0,
    updated: 0,
    tracked: 0,
    skipped: 0,
    pinned: 0,
    bonusPp: null,
    osuTotalPp: standing?.totalPp ?? null,
    osuGlobalRank: standing?.globalRank ?? null,
  };

  const tally = (outcome: ImportOutcome) => {
    if (outcome.status === 'added') result.added++;
    else if (outcome.status === 'updated') result.updated++;
    else if (outcome.status === 'tracked') result.tracked++;
    else result.skipped++;
    return outcome;
  };

  for (const score of best) tally(importScore(db, resolver, profileId, score));

  /*
   * Pinned scores are imported whether or not they are best performances: pinning is how
   * someone shows a play they are proud of that pp does not reward, so a pinned play may be
   * on a loved map, or worth nothing at all, and would be in neither list otherwise.
   */
  for (const score of pinned) {
    const outcome = tally(importScore(db, resolver, profileId, score));
    if (outcome.status === 'skipped') continue;
    const already = db
      .prepare('SELECT pinned_at FROM scores WHERE id = ?')
      .get(outcome.id) as { pinned_at: number | null } | undefined;
    // Pinning appends, so pinning in osu!'s order reproduces osu!'s order.
    if (already && already.pinned_at === null) {
      applyScoreAction(db, profileId, outcome.id, 'pin');
      result.pinned++;
    }
  }

  if (standing !== null) {
    const bonus = borrowedBonusPp(best, standing);
    if (bonus !== null) {
      result.bonusPp = bonus;
      saveStanding(db, profileId, mode, bonus, standing);
    }
  }

  return result;
}
