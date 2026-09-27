import fs from 'node:fs';
import type { Db } from './db/index.ts';
import { beatmapMode, osuSection, type BeatmapResolver } from './clients/beatmaps.ts';
import { fetchBeatmapFile, fetchLinkedScore, type LinkedScore } from './clients/osu-web.ts';
import { beatmapName, beatmapNameOriginal, resolvedNames } from './calc/metadata.ts';
import { decodeLegacyMods, encodeLegacyMods, LEGACY_MOD_BITS, modsLabel, withClassicMod } from './calc/pp.ts';
import { buildLinkedReplay, buildManualReplay } from './built-replays.ts';
import { cacheBeatmap, findExistingScore, identityOf, replaces } from './tracker/online-import.ts';
import { getSettings } from './settings.ts';
import { ownsPlay, type PlayerIdentity } from './player-identity.ts';
import { ensureBeatmapFile, storeBeatmapFile } from './stored-beatmaps.ts';
import { releaseUploadedReplay, storeUploadedReplay } from './uploaded-replays.ts';
import { wasDeleted } from './scores.ts';
import type { IngestOutcome } from './tracker/ingest.ts';
import type { Tracker } from './tracker/index.ts';
import type { PpResult } from './calc/pp.ts';
import type { Ruleset } from './osr.ts';

/**
 * Adding one score by name: from its link on osu.ppy.sh, or typed in by hand.
 *
 * Both are the last resort for a play with no replay -- one set on another computer, or before
 * replays were kept -- and both end the same way: a replay built from the score's numbers
 * (src/built-replays.ts), priced by osu!'s calculator here like any other, marked on the page
 * for what it is. The network is used once, when a link is imported or a beatmap is not
 * installed, and never again for that score.
 *
 * The server calls these; they are here so the rules are one place and can be tested without it.
 */

export interface EntryDeps {
  db: Db;
  resolver: BeatmapResolver;
  dataDir: string;
  profileId: number;
  identity: PlayerIdentity;
  /** Into this profile, or into `profileId` -- a conversion may be for a profile not on screen. */
  importBuiltReplay: (file: string, profileId?: number) => Promise<IngestOutcome>;
  priceReplay: (file: string) => Promise<PpResult | null>;
  /** Whether osu!'s calculator is running: a score entered by hand is nothing without its pp. */
  canPrice: boolean;
}

/** The deps for a profile, from the running tracker -- one place for the server and startup. */
export function trackerEntryDeps(
  tracker: Pick<Tracker, 'beatmaps' | 'playerIdentity' | 'importBuiltReplay' | 'priceReplay' | 'calculatorVersion'>,
  db: Db,
  dataDir: string,
  profileId: number,
): EntryDeps {
  return {
    db,
    resolver: tracker.beatmaps,
    dataDir,
    profileId,
    identity: tracker.playerIdentity,
    importBuiltReplay: (file, target) => tracker.importBuiltReplay(file, target ?? profileId),
    priceReplay: (file) => tracker.priceReplay(file),
    canPrice: tracker.calculatorVersion !== null,
  };
}

/* ------------------------------------------------------------------ by link */

/** A score as the link check shows it, before anything is written. */
export interface LinkPreview {
  title: string;
  titleOriginal: string | null;
  mode: Ruleset;
  mods: string;
  grade: string;
  accuracy: number;
  maxCombo: number;
  /** osu!'s own pp, shown for comparison; the score is priced here when it is imported. */
  osuPp: number | null;
  playedAt: number;
  player: string;
  /** Whether it is this profile's player's: false warns before importing, null when unknown. */
  yours: boolean | null;
  /** Already in this profile, or deleted from it for good. */
  already: boolean;
}

const named = (score: LinkedScore['score']) => {
  const n = resolvedNames({ artist: score.artist, title: score.title, artistUnicode: null, titleUnicode: null });
  const withVersion = (name: string) => (score.version ? `${name} [${score.version}]` : name);
  const original = beatmapNameOriginal(n);
  return {
    title: withVersion(beatmapName(n) || score.beatmapMD5.slice(0, 12)),
    titleOriginal: original === null ? null : withVersion(original),
  };
};

/**
 * Here already -- from its replay, or this link before -- or deleted for good. One held only as
 * osu!'s figures from an import of best performances is not: the link's built replay is a better
 * record, and takes its place (see `replaces`). A built replay has no hash, so it is keyed as
 * ingest keys it: by beatmap and time.
 */
function isAlready(deps: EntryDeps, linked: LinkedScore): boolean {
  const { score } = linked;
  const found = findExistingScore(deps.db, deps.profileId, identityOf(score));
  return (
    (found !== null && !replaces(found, 'built')) ||
    wasDeleted(deps.db, deps.profileId, `${score.beatmapMD5}:${score.playedAt}`)
  );
}

export async function checkScoreLink(deps: EntryDeps, link: string): Promise<LinkPreview> {
  const linked = await fetchLinkedScore(link);
  const { score, player } = linked;
  const owns = ownsPlay(deps.identity, { name: player.name, userId: player.id, onlineId: Number(score.id) });
  return {
    ...named(score),
    mode: score.mode,
    mods: modsLabel(withClassicMod(score.mods, score.legacyScoreId !== null ? 'stable' : 'lazer')),
    grade: score.grade,
    accuracy: score.accuracy,
    maxCombo: score.maxCombo,
    osuPp: score.pp,
    playedAt: score.playedAt,
    player: player.name,
    yours: owns,
    already: isAlready(deps, linked),
  };
}

export type EntryResult =
  | { status: 'added'; outcome: IngestOutcome }
  | { status: 'already' };

/** Import a score from its link: its beatmap if need be, then its built replay. */
export async function importScoreLink(deps: EntryDeps, link: string): Promise<EntryResult> {
  const linked = await fetchLinkedScore(link);
  if (isAlready(deps, linked)) return { status: 'already' };
  const { score, player } = linked;

  const bytes = buildLinkedReplay(score, player);
  if (bytes === null) throw new Error('that score has mods an osu!stable replay cannot hold');
  // Names and ranked status as osu! gives them, for a beatmap nothing here can describe.
  cacheBeatmap(deps.db, deps.resolver, score);
  await ensureBeatmapFile(deps.db, deps.resolver, deps.dataDir, { id: score.beatmapId, md5: score.beatmapMD5 });
  return await importBuilt(deps, bytes);
}

async function importBuilt(deps: EntryDeps, bytes: Buffer): Promise<EntryResult> {
  const file = storeUploadedReplay(deps.dataDir, bytes);
  if (file === null) throw new Error('the score could not be built into a replay');
  const outcome = await deps.importBuiltReplay(file);
  releaseUploadedReplay(deps.db, file);
  return outcome.status === 'added' ? { status: 'added', outcome } : { status: 'already' };
}

/* --------------------------------------------------- imported best performances */

/** What an imported row holds that a replay can be built from: everything osu! handed over. */
interface ImportedRow {
  id: number;
  mode: number;
  beatmap_md5: string;
  beatmap_id: number | null;
  client: string;
  mods_json: string;
  statistics_json: string | null;
  max_statistics_json: string | null;
  max_combo: number;
  total_score: number;
  grade: string;
  played_at: number;
  online_score_id: string | null;
  legacy_score_id: string | null;
}

const parsed = <T>(json: string | null, fallback: T): T => {
  try {
    return json === null ? fallback : (JSON.parse(json) as T);
  } catch {
    return fallback;
  }
};

/**
 * An imported row as the score osu! handed over, rebuilt from what it stored -- the statistics,
 * mods and ids of the play, and its total on the scale a replay would carry -- so it can be
 * built into a replay exactly as a score from its link is. Nothing is asked of osu! again.
 */
function scoreFromImportedRow(r: ImportedRow): LinkedScore['score'] | null {
  if (r.online_score_id === null) return null;
  const stable = r.client === 'stable';
  return {
    id: r.online_score_id,
    legacyScoreId: r.legacy_score_id,
    mode: r.mode as Ruleset,
    beatmapMD5: r.beatmap_md5,
    beatmapId: r.beatmap_id ?? 0,
    beatmapsetId: null,
    artist: null,
    title: null,
    version: null,
    creator: null,
    mapStatus: 0,
    beatmapStars: null,
    mods: parsed(r.mods_json, []),
    statistics: parsed(r.statistics_json, {}),
    maximumStatistics: parsed(r.max_statistics_json, {}),
    accuracy: 0,
    maxCombo: r.max_combo,
    totalScore: r.total_score,
    classicTotalScore: null,
    // An imported stable play stored osu!stable's own total, which is what its replay carries.
    legacyTotalScore: stable ? r.total_score : null,
    grade: r.grade,
    passed: true,
    legacyPerfect: false,
    ranked: true,
    pp: null,
    playedAt: r.played_at,
    weightPercentage: null,
  };
}

/** What converting a profile's imported best performances came to. */
export interface Conversion {
  converted: number;
  /** Left on osu!'s figures for now: no calculator, or a beatmap that could not be had. */
  left: number;
}

/**
 * Put a profile's imported best performances on built replays, priced here.
 *
 * An import of best performances stores osu!'s figures and osu!'s pp, and nothing here could
 * reprice them -- so after a pp rework they would stay on the old numbers while everything else
 * moved. Each is built into a replay from its own stored numbers, as a score from its link is,
 * and takes that row's place (its id, pin and removal kept). A play whose replay turns up later
 * is replaced again by that, the best record of all.
 *
 * A beatmap that is not installed is downloaded only when `download` is set -- after an import
 * from osu!, or on Recalculate every score, both of which the user pressed. Otherwise that play
 * is left on osu!'s figures, and converted the next time it can be.
 */
export async function convertImportedScores(
  deps: EntryDeps,
  profileId: number,
  { download }: { download: boolean },
): Promise<Conversion> {
  const rows = deps.db
    .prepare(
      `SELECT id, mode, beatmap_md5, beatmap_id, client, mods_json, statistics_json, max_statistics_json,
              max_combo, total_score, grade, played_at, online_score_id, legacy_score_id
         FROM scores WHERE profile_id = ? AND imported_at IS NOT NULL`,
    )
    .all(profileId) as unknown as ImportedRow[];
  const result: Conversion = { converted: 0, left: 0 };
  if (rows.length === 0) return result;
  if (!deps.canPrice) return { converted: 0, left: rows.length };

  // Written under the account the scores came from, which is whose they are.
  const player = { id: null, name: getSettings(deps.db, profileId).linkedUsername || '' };
  for (const row of rows) {
    const score = scoreFromImportedRow(row);
    const bytes = score === null ? null : buildLinkedReplay(score, player);
    const local = deps.resolver.resolve(row.beatmap_md5).osuPath;
    try {
      if (bytes === null || score === null) throw new Error('not buildable');
      if (local === null || !fs.existsSync(local)) {
        if (!download || row.beatmap_id === null) throw new Error('no beatmap');
        await ensureBeatmapFile(deps.db, deps.resolver, deps.dataDir, { id: row.beatmap_id, md5: row.beatmap_md5 });
      }
      const file = storeUploadedReplay(deps.dataDir, bytes);
      if (file === null) throw new Error('not buildable');
      const outcome = await deps.importBuiltReplay(file, profileId);
      releaseUploadedReplay(deps.db, file);
      if (outcome.status === 'added') result.converted++;
      else result.left++;
    } catch {
      result.left++;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ beatmaps */

/** A beatmap a score can be entered on: one whose file is here, installed or downloaded. */
export interface EntryBeatmap {
  md5: string;
  beatmapId: number | null;
  title: string;
  titleOriginal: string | null;
  /** The ruleset it was made for. An osu! one can be played in any; the others only in their own. */
  mode: Ruleset;
  /** Its hit objects, which an osu! or mania play's judgements must add up to. */
  objects: number;
}

function describeBeatmap(deps: EntryDeps, md5: string): EntryBeatmap | null {
  const beatmap = deps.resolver.resolve(md5);
  if (beatmap.osuPath === null || !fs.existsSync(beatmap.osuPath)) return null;
  const text = fs.readFileSync(beatmap.osuPath, 'utf8');
  const objects = (osuSection(text, '[HitObjects]') ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').length;
  const n = resolvedNames(beatmap);
  const withVersion = (name: string) => (beatmap.version ? `${name} [${beatmap.version}]` : name);
  const original = beatmapNameOriginal(n);
  return {
    md5,
    beatmapId: beatmap.beatmapId,
    title: withVersion(beatmapName(n) || md5.slice(0, 12)),
    titleOriginal: original === null ? null : withVersion(original),
    mode: beatmapMode(beatmap.osuPath),
    objects,
  };
}

/** Installed beatmaps whose name has every word typed, for picking one to enter a score on. */
export function searchBeatmaps(deps: EntryDeps, query: string, limit = 20): EntryBeatmap[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) return [];
  const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = deps.db
    .prepare(
      `SELECT DISTINCT md5 FROM osu_files
        WHERE ${words.map(() => "LOWER(name) LIKE ? ESCAPE '\\'").join(' AND ')}
        ORDER BY name LIMIT ?`,
    )
    .all(...words.map(like), limit) as { md5: string }[];
  return rows.flatMap((r) => describeBeatmap(deps, r.md5) ?? []);
}

/**
 * A beatmap by its link or id -- `osu.ppy.sh/beatmapsets/1#osu/2`, `osu.ppy.sh/b/2`, `2` -- or
 * by the MD5 a search returned. An installed one is used as it is; otherwise osu!'s current
 * file is downloaded and kept, which is the only time this needs the internet.
 */
export async function findBeatmap(deps: EntryDeps, query: { md5?: string; link?: string }): Promise<EntryBeatmap> {
  if (query.md5 !== undefined) {
    const found = /^[0-9a-f]{32}$/.test(query.md5) ? describeBeatmap(deps, query.md5) : null;
    if (!found) throw new Error('that beatmap is not on this computer');
    return found;
  }
  const id = beatmapIdOf(query.link ?? '');
  if (id === null) throw new Error('that is not a beatmap link or id -- link to one difficulty');
  const local = deps.resolver.md5ForBeatmapId(id);
  const installed = local === null ? null : describeBeatmap(deps, local);
  if (installed) return installed;
  const stored = storeBeatmapFile(deps.db, deps.dataDir, await fetchBeatmapFile(id));
  const found = describeBeatmap(deps, stored.md5);
  if (!found) throw new Error('osu! sent a file that is not a beatmap');
  return found;
}

export function beatmapIdOf(input: string): number | null {
  const text = input.trim();
  const match =
    /^(\d{1,10})$/.exec(text) ??
    /osu\.ppy\.sh\/beatmapsets\/\d+\/?#(?:osu|taiko|fruits|mania)\/(\d{1,10})/i.exec(text) ??
    /osu\.ppy\.sh\/(?:b|beatmaps)\/(\d{1,10})/i.exec(text);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/* ------------------------------------------------------------------ by hand */

/** What the form sends: the judgements osu!stable's results screen shows, per ruleset. */
export interface ManualInput {
  md5: string;
  mode: number;
  counts: Partial<Record<'c300' | 'c100' | 'c50' | 'geki' | 'katu' | 'miss', unknown>>;
  maxCombo: unknown;
  mods: unknown;
  totalScore?: unknown;
  playedAt: unknown;
}

/** The judgements each ruleset has, by the header counter that holds them. */
export const JUDGEMENTS: Record<Ruleset, readonly ('c300' | 'c100' | 'c50' | 'geki' | 'katu' | 'miss')[]> = {
  0: ['c300', 'c100', 'c50', 'miss'],
  1: ['c300', 'c100', 'miss'],
  2: ['c300', 'c100', 'c50', 'katu', 'miss'],
  3: ['geki', 'c300', 'katu', 'c100', 'c50', 'miss'],
};

/** Pairs osu!stable never allowed together, so a typed-in play cannot have had them. */
const EXCLUSIVE: [string, string][] = [
  ['EZ', 'HR'],
  ['DT', 'HT'],
  ['NC', 'HT'],
  ['NF', 'SD'],
  ['NF', 'PF'],
  ['RX', 'AP'],
  ['NF', 'RX'],
  ['NF', 'AP'],
];

/**
 * Mods as typed -- `HDDT`, `+HD DT`, `hd,dt` -- to osu!stable's bitmask for the ruleset, or a
 * message saying what is wrong. Autoplay and Cinema are refused: nobody enters a play the
 * computer set.
 */
export function parseMods(text: unknown, mode: Ruleset): { bits: number; acronyms: string[] } | { error: string } {
  const clean = String(text ?? '').toUpperCase().replace(/[\s+,|/]/g, '');
  const known = [...LEGACY_MOD_BITS, 'CL'].sort((a, b) => b.length - a.length);
  const acronyms: string[] = [];
  for (let i = 0; i < clean.length; ) {
    const hit = known.find((a) => clean.startsWith(a, i));
    if (!hit) return { error: `"${clean.slice(i, i + 2)}" is not an osu!stable mod` };
    if (hit !== 'CL' && !acronyms.includes(hit)) acronyms.push(hit);
    i += hit.length;
  }
  if (acronyms.some((a) => a === 'AT' || a === 'CN')) return { error: 'a play set by Autoplay cannot be entered' };
  for (const [a, b] of EXCLUSIVE) {
    if (acronyms.includes(a) && acronyms.includes(b)) return { error: `${a} and ${b} cannot be on together` };
  }
  const bits = encodeLegacyMods(acronyms.map((acronym) => ({ acronym })));
  if (bits === null) return { error: 'those mods are not osu!stable mods' };
  const kept = new Set(decodeLegacyMods(bits, mode).map((m) => m.acronym));
  const foreign = acronyms.find((a) => !kept.has(a));
  if (foreign) return { error: `${foreign} is not a mod in this ruleset` };
  return { bits, acronyms };
}

const whole = (v: unknown, max: number): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

/** 1 October 2007: osu!'s first public release. No play is older. */
const OSU_EPOCH = Date.UTC(2007, 9, 1);

/**
 * Enter a score by hand. Everything typed is checked against the beatmap first -- the right
 * ruleset, judgements that add up to its objects, a combo it can hold -- and the pp always comes
 * from osu!'s calculator, never from the form.
 */
export async function enterScore(deps: EntryDeps, input: ManualInput, player: string): Promise<EntryResult> {
  if (!deps.canPrice) throw new Error('the pp calculator is not available, so a score cannot be entered by hand');
  const beatmap = typeof input.md5 === 'string' && /^[0-9a-f]{32}$/.test(input.md5) ? describeBeatmap(deps, input.md5) : null;
  if (!beatmap) throw new Error('choose a beatmap first');

  const mode = Number(input.mode);
  if (mode !== 0 && mode !== 1 && mode !== 2 && mode !== 3) throw new Error('choose a ruleset');
  if (beatmap.mode !== 0 && mode !== beatmap.mode) throw new Error('this beatmap can only be played in its own ruleset');

  const counts = { c300: 0, c100: 0, c50: 0, geki: 0, katu: 0, miss: 0 };
  for (const key of JUDGEMENTS[mode]) {
    const n = whole(input.counts[key] ?? 0, 65535);
    if (n === null) throw new Error('each judgement is a whole number from 0');
    counts[key] = n;
  }
  const judged = JUDGEMENTS[mode].reduce((sum, key) => sum + counts[key], 0);
  if (judged === 0) throw new Error('enter the play’s judgements');
  // An osu! or mania play on its own ruleset's beatmap is judged once per object, exactly.
  if (mode === beatmap.mode && (mode === 0 || mode === 3) && judged !== beatmap.objects) {
    throw new Error(`the judgements add up to ${judged}, and this beatmap has ${beatmap.objects} objects`);
  }

  const maxCombo = whole(input.maxCombo, 65535);
  if (maxCombo === null) throw new Error('enter the play’s max combo');
  const mods = parseMods(input.mods, mode);
  if ('error' in mods) throw new Error(mods.error);
  const totalScore = input.totalScore === undefined || input.totalScore === null || input.totalScore === ''
    ? null
    : whole(input.totalScore, 0x7fffffff);
  if (totalScore === null && input.totalScore !== undefined && input.totalScore !== null && input.totalScore !== '') {
    throw new Error('the score is a whole number');
  }
  const playedAt = Number(input.playedAt);
  if (!Number.isFinite(playedAt) || playedAt < OSU_EPOCH || playedAt > Date.now() + 60_000) {
    throw new Error('enter when the play was set');
  }

  const bytes = buildManualReplay({
    mode,
    beatmapMD5: beatmap.md5,
    player,
    counts,
    maxCombo,
    legacyMods: mods.bits,
    totalScore,
    playedAt,
  });

  // The combo is the one thing the beatmap alone cannot check: its maximum is osu!'s to say.
  const file = storeUploadedReplay(deps.dataDir, bytes);
  if (file === null) throw new Error('the score could not be built into a replay');
  const priced = await deps.priceReplay(file);
  if (priced === null || priced.maxCombo <= 0) {
    releaseUploadedReplay(deps.db, file);
    throw new Error('osu!’s calculator could not price this play');
  }
  if (maxCombo > priced.maxCombo) {
    releaseUploadedReplay(deps.db, file);
    throw new Error(`a combo of ${maxCombo} is more than this beatmap's maximum of ${priced.maxCombo}`);
  }
  return await importBuilt(deps, bytes);
}
