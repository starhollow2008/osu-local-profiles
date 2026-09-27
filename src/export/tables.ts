import type { Db } from '../db/index.ts';
import type { LazerMod, Ruleset } from '../osr.ts';
import { countsSql, ppColumn, scoreColumn, starsColumn, visibleSql, type Eligibility } from '../calc/eligibility.ts';
import { NAME_COLUMNS, names, type BeatmapNames } from '../calc/metadata.ts';
import { computeStats, modesWithPlays, mostPlayed, playSource, topPlays, type PlaySource } from '../calc/stats.ts';
import { modsLabel, withClassicMod } from '../calc/pp.ts';
import { computeMedals, earnedMedalCount } from '../calc/medals.ts';
import { estimateRank } from '../calc/rank.ts';
import { Status, UNRESOLVED_STATUS, type BeatmapResolver } from '../clients/beatmaps.ts';
import { scoreUrl } from '../clients/osu-web.ts';
import { listFavorites, type FavoriteScope } from '../favorites.ts';
import { translator, type Translate } from './words.ts';

/**
 * A profile as tables, for a spreadsheet: every score first, then what the profile page shows
 * about it. Written as `.csv` (the scores alone) and `.xlsx` (every table, one sheet each) by
 * src/export/csv.ts and src/export/xlsx.ts, from Share & back up.
 *
 * For keeping a record, not for reading back in -- Back up is for that. So every column is
 * spelled out for a person: a mode's name rather than its number, "Yes" rather than 1, a date
 * a spreadsheet understands, and as many columns as there is anything to say, since deleting a
 * column in a spreadsheet is easy and adding one back is not.
 *
 * In the page's language (src/export/words.ts): headers, sheet names and every word a cell
 * says, from the page's own translations. Names stay as osu! writes them -- modes, clients,
 * grades, and medals, whose names the page keeps in osu!'s own words too.
 *
 * Every query goes through the same definitions as the page -- `visibleSql`, `countsSql`,
 * `ppColumn`, `names` -- so what is exported is exactly what the profile shows: removed scores
 * are not in it, and the pp is the pp this profile's settings count.
 */

/** A spreadsheet cell: text, a number, a moment (unix ms), or nothing. */
export type Cell = string | number | { date: number } | null;

export interface Column {
  header: string;
  /** Roughly how many characters wide, for a sheet; a CSV has no widths. */
  width?: number;
}

export interface Table {
  /** The sheet's name: at most 31 characters, as a workbook allows. */
  name: string;
  columns: Column[];
  rows: Cell[][];
}

export const MODE_NAMES: Record<number, string> = { 0: 'osu!', 1: 'osu!taiko', 2: 'osu!catch', 3: 'osu!mania' };

/** A grade as osu! names it, the two silver ones said as such. */
const gradeName = (grade: string, t: Translate): string =>
  grade === 'XH'
    ? t('export.silver', { grade: 'SS' })
    : grade === 'SH'
      ? t('export.silver', { grade: 'S' })
      : grade === 'X'
        ? 'SS'
        : grade;

/** A beatmap status in the words the page uses for it, keyed by osu!'s number and by its name. */
function statusNames(t: Translate): Record<string, string> {
  return {
    [Status.RANKED]: t('status.ranked'),
    ranked: t('status.ranked'),
    [Status.APPROVED]: t('status.approved'),
    approved: t('status.approved'),
    [Status.QUALIFIED]: t('status.qualified'),
    qualified: t('status.qualified'),
    [Status.LOVED]: t('status.loved'),
    loved: t('status.loved'),
    [Status.PENDING]: t('status.pending'),
    pending: t('status.pending'),
    [Status.WIP]: t('status.wip'),
    wip: t('status.wip'),
    [Status.GRAVEYARD]: t('status.graveyard'),
    graveyard: t('status.graveyard'),
    [UNRESOLVED_STATUS]: t('export.notSubmitted'),
  };
}

const CLIENT_NAMES: Record<string, string> = { lazer: 'osu!lazer', stable: 'osu!stable', mcosu: 'McOsu' };

function sourceName(source: PlaySource, t: Translate): string {
  if (source === 'osu') return t('export.fromOsu');
  if (source === 'link') return t('export.fromLink');
  if (source === 'manual') return t('export.byHand');
  return t('export.replay');
}

const yes = (b: boolean, t: Translate): string => (b ? t('export.yes') : t('export.no'));
const round = (n: number | null, places: number): number | null =>
  n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** places) / 10 ** places;
const beatmapLink = (id: number | null): string | null => (id ? `https://osu.ppy.sh/b/${id}` : null);

/** Artist, title, and each in the song's own script where it reads differently (roadmap 5.55). */
const nameHeaders = (t: Translate): Column[] => [
  { header: t('export.artist'), width: 22 },
  { header: t('export.title'), width: 30 },
  { header: t('export.artistOriginal'), width: 16 },
  { header: t('export.titleOriginal'), width: 20 },
];
const nameCells = (n: BeatmapNames): Cell[] => [n.artist, n.title, n.artistUnicode, n.titleUnicode];

/** A mod's changed settings, as lazer records them: `DT speed_change 1.3; DA approach_rate 9`. */
function modSettings(mods: LazerMod[]): string | null {
  const parts: string[] = [];
  for (const mod of mods) {
    for (const [key, value] of Object.entries(mod.settings ?? {})) parts.push(`${mod.acronym} ${key} ${String(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

type Row = Record<string, string | number | null>;

/**
 * Every score this profile holds, in every mode or in `mode`, by pp from highest to lowest --
 * a play with no pp after all of those, newest first.
 */
export function scoresTable(
  db: Db,
  profileId: number,
  e: Eligibility,
  mode: Ruleset | null = null,
  t: Translate = translator(),
  name = t('export.sheetScores'),
): Table {
  const rows = db
    .prepare(
      `SELECT s.*, ${ppColumn(e)} AS shown_pp, ${starsColumn(e)} AS shown_stars, ${scoreColumn(e)} AS shown_score,
              ${countsSql(e)} AS counts, COALESCE(s.map_status, b.status) AS status,
              ${NAME_COLUMNS}, b.version, b.creator, b.beatmapset_id, b.length_ms,
              COALESCE(s.beatmap_id, b.beatmap_id) AS map_id
         FROM scores s
         LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
        WHERE s.profile_id = ? AND ${visibleSql()} ${mode === null ? '' : 'AND s.mode = ?'}
        ORDER BY shown_pp IS NULL, shown_pp DESC, s.played_at DESC`,
    )
    .all(...(mode === null ? [profileId] : [profileId, mode])) as Row[];

  // Where each counted score stands among the profile's best performances, as the page lists them.
  const best = new Map<number, { place: number; weighted: number | null }>();
  for (const m of mode === null ? ([0, 1, 2, 3] as Ruleset[]) : [mode]) {
    topPlays(db, profileId, m, undefined, e).forEach((p, i) => best.set(p.id, { place: i + 1, weighted: p.weightedPp }));
  }

  // The pp's own parts, under osu!'s names, as a column each: whichever any score has.
  const partNames: string[] = [];
  const partsOf = rows.map((r) => {
    const parts = new Map<string, number>();
    try {
      for (const part of JSON.parse(String(r['pp_parts'] ?? '[]')) as { name: string; pp: number }[]) {
        if (!partNames.includes(part.name)) partNames.push(part.name);
        parts.set(part.name, part.pp);
      }
    } catch {
      /* none, or unreadable: the columns stay empty */
    }
    return parts;
  });

  const columns: Column[] = [
    { header: t('export.dateSet'), width: 18 },
    { header: t('filter.mode'), width: 10 },
    ...nameHeaders(t),
    { header: t('filter.difficulty'), width: 22 },
    { header: t('export.mapper'), width: 14 },
    { header: t('export.stars'), width: 7 },
    { header: 'pp', width: 9 },
    { header: t('export.counts'), width: 9 },
    { header: t('export.bestPlace'), width: 9 },
    { header: t('export.weightedPp'), width: 9 },
    { header: `${t('score.accuracy')} %`, width: 9 },
    { header: t('export.grade'), width: 10 },
    { header: t('filter.mods'), width: 10 },
    { header: t('export.modSettings'), width: 18 },
    { header: t('export.score'), width: 12 },
    { header: t('export.scoreStandardised'), width: 12 },
    { header: t('export.scoreClassic'), width: 12 },
    { header: t('manualModal.maxCombo'), width: 8 },
    { header: t('export.beatmapMaxCombo'), width: 8 },
    { header: t('export.fullCombo'), width: 7 },
    { header: '300 / Great', width: 7 },
    { header: '100 / Ok', width: 7 },
    { header: '50 / Meh', width: 7 },
    { header: t('export.geki'), width: 7 },
    { header: t('export.katu'), width: 7 },
    { header: t('export.miss'), width: 6 },
    { header: t('export.passed'), width: 7 },
    { header: t('export.beatmapStatus'), width: 11 },
    { header: t('export.length'), width: 8 },
    ...partNames.map((p) => ({ header: `pp: ${p}`, width: 9 })),
    { header: t('export.ppNomod'), width: 9 },
    { header: t('export.ppVersion'), width: 14 },
    { header: t('export.client'), width: 10 },
    { header: t('export.source'), width: 16 },
    { header: t('export.player'), width: 12 },
    { header: t('export.beatmapId'), width: 10 },
    { header: t('export.beatmapsetId'), width: 10 },
    { header: t('export.beatmapLink'), width: 28 },
    { header: t('export.scoreLink'), width: 34 },
    { header: t('export.beatmapMd5'), width: 20 },
  ];

  const statuses = statusNames(t);
  const table = rows.map((r, i): Cell[] => {
    let mods: LazerMod[] = [];
    try {
      mods = (JSON.parse(String(r['mods_json'] ?? '[]')) as LazerMod[]).filter((m) => m?.acronym);
    } catch {
      /* shown as no mods */
    }
    // As osu! lists a stable play: with Classic, which osu! itself scored it with.
    mods = withClassicMod(mods, String(r['client']));
    const miss = Number(r['count_miss']);
    const mapCombo = (r['beatmap_max_combo'] as number | null) ?? null;
    const place = best.get(r['id'] as number);
    const status = r['status'] as number | null;
    const client = String(r['client']);
    return [
      { date: r['played_at'] as number },
      MODE_NAMES[r['mode'] as number] ?? null,
      ...nameCells(names(r)),
      (r['version'] as string | null) ?? null,
      (r['creator'] as string | null) ?? null,
      round(r['shown_stars'] as number | null, 2),
      round(r['shown_pp'] as number | null, 3),
      yes(r['counts'] === 1, t),
      place?.place ?? null,
      round(place?.weighted ?? null, 3),
      round((r['accuracy'] as number) * 100, 2),
      gradeName(String(r['grade']), t),
      mods.length === 0 ? t('export.noMods') : modsLabel(mods),
      modSettings(mods),
      (r['shown_score'] as number | null) ?? null,
      (r['score_standard'] as number | null) ?? null,
      (r['score_classic'] as number | null) ?? null,
      r['max_combo'] as number,
      mapCombo,
      miss > 0 ? t('export.no') : mapCombo === null || mapCombo <= 0 ? null : yes(Number(r['max_combo']) >= mapCombo, t),
      r['count300'] as number,
      r['count100'] as number,
      r['count50'] as number,
      r['count_geki'] as number,
      r['count_katu'] as number,
      miss,
      yes(r['passed'] === 1, t),
      status === null ? null : (statuses[status] ?? null),
      r['length_ms'] === null ? null : Math.round(Number(r['length_ms']) / 1000),
      ...partNames.map((p) => round(partsOf[i]!.get(p) ?? null, 3)),
      round(r['pp_nomod'] as number | null, 3),
      (r['pp_version'] as string | null) ?? null,
      CLIENT_NAMES[client] ?? client,
      sourceName(playSource(r['origin'], r['imported_at'] !== null), t),
      (r['player_name'] as string | null) || null,
      (r['map_id'] as number | null) ?? null,
      (r['beatmapset_id'] as number | null) ?? null,
      beatmapLink((r['map_id'] as number | null) ?? null),
      scoreUrl({
        mode: Number(r['mode']),
        client,
        onlineScoreId: (r['online_score_id'] as string | null) ?? null,
        legacyScoreId: (r['legacy_score_id'] as string | null) ?? null,
      }),
      r['beatmap_md5'] as string,
    ];
  });

  return { name, columns, rows: table };
}

/** The figures at the top of the profile page, one row per mode this profile has played. */
export function summaryTable(
  db: Db,
  profileId: number,
  profileName: string,
  e: Eligibility,
  t: Translate = translator(),
): Table {
  const medals = earnedMedalCount(db, profileId, e);
  const rows = modesWithPlays(db, profileId, e).map((mode): Cell[] => {
    const s = computeStats(db, profileId, mode, e);
    return [
      profileName,
      MODE_NAMES[mode] ?? null,
      round(s.totalPp, 3),
      round(s.bonusPp, 3),
      estimateRank(s.totalPp, mode)?.rank ?? null,
      round(s.accuracy * 100, 2),
      s.playcount,
      round(s.playTime / 3600, 1),
      s.rankedScore,
      s.totalScore,
      s.totalHits,
      s.hitsPerPlay,
      s.maxCombo,
      round(s.level.current + s.level.progress, 2),
      s.grades.XH,
      s.grades.X,
      s.grades.SH,
      s.grades.S,
      s.grades.A,
      medals,
    ];
  });
  return {
    name: t('export.sheetSummary'),
    columns: [
      { header: t('export.profile'), width: 16 },
      { header: t('filter.mode'), width: 10 },
      { header: 'pp', width: 10 },
      { header: t('export.bonusPp'), width: 9 },
      { header: t('export.globalRank'), width: 12 },
      { header: `${t('score.accuracy')} %`, width: 9 },
      { header: t('stats.playCount'), width: 9 },
      { header: t('export.playTime'), width: 9 },
      { header: t('stats.rankedScore'), width: 14 },
      { header: t('stats.totalScore'), width: 14 },
      { header: t('stats.totalHits'), width: 11 },
      { header: t('stats.hitsPerPlay'), width: 8 },
      { header: t('stats.maximumCombo'), width: 9 },
      { header: t('export.level'), width: 7 },
      { header: gradeName('XH', t), width: 7 },
      { header: 'SS', width: 6 },
      { header: gradeName('SH', t), width: 7 },
      { header: 'S', width: 6 },
      { header: 'A', width: 6 },
      { header: t('page.medals'), width: 7 },
    ],
    rows,
  };
}

/** Most Played Beatmaps, whole: every beatmap played in every mode, most plays first. */
export function mostPlayedTable(db: Db, profileId: number, e: Eligibility, t: Translate = translator()): Table {
  const rows: Cell[][] = [];
  for (const mode of modesWithPlays(db, profileId, e)) {
    for (const m of mostPlayed(db, profileId, mode, Number.MAX_SAFE_INTEGER, e)) {
      rows.push([
        MODE_NAMES[mode] ?? null,
        ...nameCells(names({ artist: m.artist, title: m.title, artist_unicode: m.artistUnicode, title_unicode: m.titleUnicode })),
        m.version,
        m.creator,
        m.count,
        m.beatmapId,
        m.beatmapsetId,
        beatmapLink(m.beatmapId),
      ]);
    }
  }
  return {
    name: t('heading.mostPlayed'),
    columns: [
      { header: t('filter.mode'), width: 10 },
      ...nameHeaders(t),
      { header: t('filter.difficulty'), width: 22 },
      { header: t('export.mapper'), width: 14 },
      { header: t('export.plays'), width: 7 },
      { header: t('export.beatmapId'), width: 10 },
      { header: t('export.beatmapsetId'), width: 10 },
      { header: t('export.beatmapLink'), width: 28 },
    ],
    rows,
  };
}

/** Favorite Beatmaps, most recently favourited first, as the section lists them. */
export function favoritesTable(
  db: Db,
  scope: FavoriteScope,
  resolver: BeatmapResolver | null,
  t: Translate = translator(),
): Table {
  const statuses = statusNames(t);
  const rows = listFavorites(db, scope, Number.MAX_SAFE_INTEGER, resolver).map((f): Cell[] => [
    ...nameCells(names({ artist: f.artist, title: f.title, artist_unicode: f.artistUnicode, title_unicode: f.titleUnicode })),
    f.creator,
    f.status === null ? null : (statuses[f.status] ?? f.status),
    f.difficulties.length,
    f.difficulties.map((d) => d.version).join('; ') || null,
    { date: f.favoritedAt },
    f.id,
    `https://osu.ppy.sh/beatmapsets/${f.id}`,
  ]);
  return {
    name: t('heading.favoriteBeatmaps'),
    columns: [
      ...nameHeaders(t),
      { header: t('export.mapper'), width: 14 },
      { header: t('export.status'), width: 10 },
      { header: t('export.difficulties'), width: 8 },
      { header: t('export.difficultyNames'), width: 30 },
      { header: t('export.favorited'), width: 18 },
      { header: t('export.beatmapsetId'), width: 10 },
      { header: t('export.link'), width: 34 },
    ],
    rows,
  };
}

/** Which mode a medal belongs to, from osu!'s own slug; the rest are every mode's. */
function medalMode(slug: string, t: Translate): string {
  const prefix = slug.split('-')[0];
  if (prefix === 'osu') return 'osu!';
  if (prefix === 'taiko') return 'osu!taiko';
  if (prefix === 'fruits') return 'osu!catch';
  if (prefix === 'mania') return 'osu!mania';
  return t('export.allModes');
}

/** Every medal this app awards, earned first and in the order they were earned. */
export function medalsTable(db: Db, profileId: number, e: Eligibility, t: Translate = translator()): Table {
  const seen = new Map<string, Cell[]>();
  const order: { slug: string; earned: boolean; at: number }[] = [];
  for (const mode of [0, 1, 2, 3] as Ruleset[]) {
    computeMedals(db, profileId, mode, e).medals.forEach((m, i) => {
      if (seen.has(m.slug)) return;
      const earned = m.achievedAt !== null;
      seen.set(m.slug, [
        m.name,
        m.grouping === 'Mod Introduction' ? t('medals.modIntroduction') : t('medals.skillDedication'),
        medalMode(m.slug, t),
        m.description,
        yes(earned, t),
        // A rank medal is decided from the estimated rank, and has no date of its own.
        earned && m.dated ? { date: m.achievedAt! } : null,
        earned ? yes(m.fromOsu, t) : null,
      ]);
      order.push({ slug: m.slug, earned, at: earned && m.dated ? m.achievedAt! : Number.MAX_SAFE_INTEGER - 1000 + i });
    });
  }
  order.sort((a, b) => Number(b.earned) - Number(a.earned) || a.at - b.at);
  return {
    name: t('page.medals'),
    columns: [
      { header: t('export.medal'), width: 24 },
      { header: t('export.group'), width: 16 },
      { header: t('filter.mode'), width: 10 },
      { header: t('export.description'), width: 50 },
      { header: t('export.earned'), width: 7 },
      { header: t('export.achieved'), width: 18 },
      { header: t('export.fromOsu'), width: 9 },
    ],
    rows: order.map((o) => seen.get(o.slug)!),
  };
}

/**
 * The whole workbook, scores first: every score, then each mode's alone when there is more than
 * one to tell apart, then the rest of what the profile shows.
 */
export function workbookTables(
  db: Db,
  profileId: number,
  profileName: string,
  e: Eligibility,
  favorites: FavoriteScope,
  resolver: BeatmapResolver | null,
  t: Translate = translator(),
): Table[] {
  const modes = modesWithPlays(db, profileId, e);
  const perMode =
    modes.length > 1
      ? modes.map((m) => scoresTable(db, profileId, e, m, t, t('export.sheetScoresMode', { mode: MODE_NAMES[m] ?? '' })))
      : [];
  return [
    scoresTable(db, profileId, e, null, t),
    ...perMode,
    summaryTable(db, profileId, profileName, e, t),
    mostPlayedTable(db, profileId, e, t),
    favoritesTable(db, favorites, resolver, t),
    medalsTable(db, profileId, e, t),
  ];
}
