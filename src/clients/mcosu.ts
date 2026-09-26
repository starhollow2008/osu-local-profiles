import fs from 'node:fs';
import path from 'node:path';
import type { LazerMod } from '../osr.ts';
import { osuSection } from './beatmaps.ts';
import { decodeLegacyMods } from '../calc/pp.ts';

/**
 * McOsu (github.com/McKay42/McOsu), an osu!standard client built on its own engine.
 *
 * McOsu writes no replays. What it keeps of a play is one entry in its own `scores.db`, in
 * the game's folder, and only for a play that was finished, not failed, scored above zero
 * and not set by Autoplay or Autopilot+Relax (`OsuBeatmapStandard::onBeforeStop`). A quit,
 * a retry or an HP fail leaves nothing at all -- no log, no file -- so, as with osu!stable,
 * those cannot be counted.
 *
 * So the app builds a replay itself: an osu!stable `.osr` holding the entry's judgements,
 * combo, total and mods, with no cursor data, written under `data/mcosu/`. osu!'s own replay
 * decoder then gives it exactly the treatment a stable replay gets -- the Classic mod,
 * classic slider accuracy, maximum statistics from the beatmap -- and from there it is a
 * replay like any other: Import past plays walks it, a recalculation reprices it, and it is
 * kept when McOsu's own entry is deleted. It is not a real replay, so it is never offered
 * for download.
 *
 * What a stable replay cannot hold -- a speed its mod bits did not set, a CS/AR/OD/HP
 * override, McOsu's own mods -- is appended after the replay in a block of this app's own
 * (`MCOSU_BLOCK`), which osu!'s decoder never reads. See `mcosuMods` for what becomes of it.
 */

/** The newest `scores.db` format this reader knows (`osu_scores_custom_version`). */
export const MCOSU_SCORES_VERSION = 20210110;

/** Written as the built replay's version: a current osu!stable one, so the decoder treats it as such. */
export const BUILT_REPLAY_VERSION = 20260711;

/** Marks the app's block after a built replay, where a lazer replay would have its own. */
export const MCOSU_BLOCK = 'osu-local-profiles:mcosu';

/** One entry in McOsu's `scores.db`, as `OsuDatabase::loadScores` reads it. */
export interface McosuScore {
  beatmapMD5: string;
  /**
   * A copy McOsu took of an osu!stable score from stable's own scores.db. Not a McOsu play,
   * and never tracked as one: its replay, if stable kept it, is tracked from stable.
   */
  importedLegacy: boolean;
  /** When the play ended, to the second. */
  playedAt: number;
  playerName: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  /** McOsu's ScoreV1 total: osu!stable's own formula, with its mod multipliers. */
  totalScore: number;
  maxCombo: number;
  /** osu!stable's bitmask, except that McOsu's Nightmare mod sets Cinema's bit. */
  legacyMods: number;
  /** The beatmap's max combo, or -1 on a score older than McOsu recording it. */
  maxPossibleCombo: number;
  facts: McosuFacts;
}

/** What McOsu recorded about a play that an osu!stable replay has no place for. */
export interface McosuFacts {
  /** The speed it was played at. McOsu's speed slider sets this without DT or HT. */
  speed: number;
  /**
   * CS, AR, OD and HP as McOsu played them: the map's own through Easy or Hard Rock, then
   * any override. AR and OD are before speed, so an override locked to a speed is already
   * converted back.
   */
  cs: number;
  ar: number;
  od: number;
  hp: number;
  /** McOsu's Nightmare mod, which the bitmask cannot tell from Cinema. */
  nightmare: boolean;
  /** McOsu's experimental mods, by the console variable names McOsu records them under. */
  experimental: string[];
}

/** Cinema's bit, which McOsu sets for its Nightmare mod. */
const NIGHTMARE_BIT = 1 << 22;

/** The bit McOsu (from 20210104) sets in the per-score "gamemode" byte for an imported stable score. */
const IMPORTED_LEGACY_FLAG = 0xa9;

class Reader {
  private o = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  byte(): number {
    const v = this.b.readUInt8(this.o);
    this.o += 1;
    return v;
  }
  short(): number {
    const v = this.b.readInt16LE(this.o);
    this.o += 2;
    return v;
  }
  int(): number {
    const v = this.b.readInt32LE(this.o);
    this.o += 4;
    return v;
  }
  long(): bigint {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  float(): number {
    const v = this.b.readFloatLE(this.o);
    this.o += 4;
    return v;
  }
  /** McOsu's strings are osu!'s: 0x0b, a ULEB128 length, then UTF-8. Anything else is empty. */
  string(): string {
    if (this.byte() !== 0x0b) return '';
    let len = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.byte();
      len |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    if (this.o + len > this.b.length) throw new RangeError('string runs past the end of scores.db');
    const s = this.b.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }
}

/** A `scores.db` from a McOsu newer than this reader, which its format may have changed in. */
export class McosuVersionError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`McOsu's scores.db is version ${version}, newer than this app can read (${MCOSU_SCORES_VERSION})`);
    this.version = version;
  }
}

/**
 * Read McOsu's `scores.db`.
 *
 * A file cut short throws a RangeError rather than returning what it had: McOsu rewrites the
 * whole file after every play, so a short read is a write still in progress, and the caller
 * reads again once it settles. A version newer than `MCOSU_SCORES_VERSION` throws
 * `McosuVersionError`, as McOsu itself refuses one -- guessing at a changed layout would
 * produce plays that never happened.
 */
export function parseMcosuScores(buf: Buffer): McosuScore[] {
  const r = new Reader(buf);
  const dbVersion = r.int();
  if (dbVersion > MCOSU_SCORES_VERSION) throw new McosuVersionError(dbVersion);
  const numBeatmaps = r.int();

  const out: McosuScore[] = [];
  for (let b = 0; b < numBeatmaps; b++) {
    const md5 = r.string();
    const numScores = r.int();
    // McOsu's own rules: a short hash is one bad entry, a long one a corrupt file.
    if (md5.length > 32) throw new RangeError('corrupt beatmap hash in scores.db');
    const validMd5 = md5.length === 32;

    for (let s = 0; s < numScores; s++) {
      const gamemode = r.byte();
      const scoreVersion = r.int();
      let importedLegacy = false;
      if (dbVersion === 20210103 && scoreVersion > 20190103) importedLegacy = r.byte() !== 0;
      else if (dbVersion > 20210103 && scoreVersion > 20190103) importedLegacy = (gamemode & IMPORTED_LEGACY_FLAG) !== 0;
      const unixSeconds = r.long();
      const playerName = r.string();
      const count300 = r.short();
      const count100 = r.short();
      const count50 = r.short();
      const countGeki = r.short();
      const countKatu = r.short();
      const countMiss = r.short();
      const totalScore = Number(r.long());
      const maxCombo = r.short();
      const legacyMods = r.int();
      r.short(); // slider breaks
      r.float(); // McOsu's own pp
      r.float(); // unstable rate
      r.float(); // hit error min
      r.float(); // hit error max
      r.float(); // McOsu's own stars
      r.float(); // aim stars
      r.float(); // speed stars
      const speed = r.float();
      const cs = r.float();
      const ar = r.float();
      const od = r.float();
      const hp = r.float();
      let maxPossibleCombo = -1;
      if (scoreVersion > 20180722) {
        maxPossibleCombo = r.int();
        r.int(); // hit objects
        r.int(); // circles
      }
      const experimental = r.string();

      // McOsu's own gamemode filter: osu!standard only, with the byte reused as a flag later.
      const standard = gamemode === 0 || (dbVersion > 20210103 && scoreVersion > 20190103);
      if (!validMd5 || !standard) continue;

      out.push({
        beatmapMD5: md5,
        importedLegacy,
        playedAt: Number(unixSeconds) * 1000,
        playerName,
        count300,
        count100,
        count50,
        countGeki,
        countKatu,
        countMiss,
        totalScore,
        maxCombo,
        legacyMods,
        maxPossibleCombo,
        facts: {
          speed,
          cs,
          ar,
          od,
          hp,
          nightmare: (legacyMods & NIGHTMARE_BIT) !== 0,
          experimental: experimental.split(';').filter((name) => name !== ''),
        },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* The replay the app builds                                                */
/* ------------------------------------------------------------------------ */

/** .NET ticks at the unix epoch. */
const TICKS_AT_EPOCH = 621355968000000000n;

/** Where a McOsu play's built replay is kept, named by its beatmap and when it was played. */
export function builtReplayPath(dir: string, score: Pick<McosuScore, 'beatmapMD5' | 'playedAt'>): string {
  return path.join(dir, `${score.beatmapMD5}-${Math.floor(score.playedAt / 1000)}.osr`);
}

/**
 * The osu!stable replay for a McOsu play, with no cursor data and this app's block after it.
 *
 * The replay hash is left empty, so the play is known by its beatmap and time (`dedupeKey`),
 * as McOsu knows it. Cinema's bit is cleared: it is Nightmare here, and osu!'s decoder would
 * otherwise read the play as Cinema, which never counts.
 */
export function buildMcosuReplay(score: McosuScore): Buffer {
  const parts: Buffer[] = [];
  const byte = (v: number) => parts.push(Buffer.from([v]));
  const short = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    parts.push(b);
  };
  const int = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const long = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    parts.push(b);
  };
  const string = (s: string | null) => {
    if (s === null) return byte(0);
    const data = Buffer.from(s, 'utf8');
    const len: number[] = [];
    let n = data.length;
    do {
      let x = n & 0x7f;
      n >>>= 7;
      if (n) x |= 0x80;
      len.push(x);
    } while (n);
    parts.push(Buffer.from([0x0b, ...len]), data);
  };

  byte(0);
  int(BUILT_REPLAY_VERSION);
  string(score.beatmapMD5);
  string(score.playerName);
  string(null);
  short(score.count300);
  short(score.count100);
  short(score.count50);
  short(score.countGeki);
  short(score.countKatu);
  short(score.countMiss);
  // stable's field is 32 bits; a McOsu total beyond it would be a marathon well past any stable one.
  int(Math.min(score.totalScore, 0x7fffffff));
  short(score.maxCombo);
  byte(score.maxPossibleCombo > 0 && score.maxCombo >= score.maxPossibleCombo ? 1 : 0);
  int(score.legacyMods & ~NIGHTMARE_BIT);
  string(null); // life bar
  long(BigInt(Math.floor(score.playedAt / 1000)) * 10_000_000n + TICKS_AT_EPOCH);
  int(0); // no replay data
  long(0n); // never submitted, so no online id

  const block = Buffer.from(JSON.stringify(score.facts), 'utf8');
  parts.push(Buffer.from(MCOSU_BLOCK, 'latin1'));
  int(block.length);
  parts.push(block);
  return Buffer.concat(parts);
}

/** The app's block from after a replay, or null when it has none. `rest` starts just past the online id. */
export function readMcosuBlock(rest: Buffer): McosuFacts | null {
  const magic = Buffer.from(MCOSU_BLOCK, 'latin1');
  if (rest.length < magic.length + 4 || !rest.subarray(0, magic.length).equals(magic)) return null;
  const len = rest.readInt32LE(magic.length);
  const start = magic.length + 4;
  if (len <= 0 || start + len > rest.length) return null;
  try {
    const raw = JSON.parse(rest.toString('utf8', start, start + len)) as Partial<McosuFacts>;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    return {
      speed: num(raw.speed, 1),
      cs: num(raw.cs, NaN),
      ar: num(raw.ar, NaN),
      od: num(raw.od, NaN),
      hp: num(raw.hp, NaN),
      nightmare: raw.nightmare === true,
      experimental: Array.isArray(raw.experimental)
        ? raw.experimental.filter((m): m is string => typeof m === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* Mods, as osu! would write them                                           */
/* ------------------------------------------------------------------------ */

/** A beatmap's own CS, AR, OD and HP, before any mod. */
export interface BaseDifficulty {
  cs: number;
  ar: number;
  od: number;
  hp: number;
}

/**
 * The `[Difficulty]` of a `.osu`, or null when it cannot be read. A map old enough to have no
 * `ApproachRate` uses its OD for it, as every osu! client does.
 */
export function readBaseDifficulty(osuPath: string): BaseDifficulty | null {
  let text: string;
  try {
    text = fs.readFileSync(osuPath, 'utf8');
  } catch {
    return null;
  }
  const section = osuSection(text, '[Difficulty]');
  if (section === null) return null;
  const value = (key: string): number | null => {
    const m = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*([-0-9.]+)`, 'm').exec(section);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const cs = value('CircleSize');
  const od = value('OverallDifficulty');
  const hp = value('HPDrainRate');
  if (cs === null || od === null || hp === null) return null;
  return { cs, ar: value('ApproachRate') ?? od, od, hp };
}

/** What `mcosuMods` makes of a play. */
export interface McosuMods {
  /** The play's mods as osu! would list them, then Difficulty Adjust, then MC. What is stored. */
  mods: LazerMod[];
  /**
   * What osu!'s calculator is given: `mods` without MC, which osu! has no model of. Null when
   * osu!'s mods cannot say what was played -- a speed outside 0.5x-2.0x, or a value past
   * Difficulty Adjust's extended limits -- and the play is stored with no pp rather than a
   * clamped one: osu! would silently price 2.5x as 2.0x.
   */
  priced: LazerMod[] | null;
  /** Whether the total McOsu recorded is on the footing osu! assumes. See `legacyTotalComparable`. */
  ignoreLegacyTotalScore: boolean;
}

const DT = 1 << 6;
const HT = 1 << 8;
const NC = 1 << 9;
const HR = 1 << 4;
const EZ = 1 << 1;

/** The rates osu!'s rate mods accept, and their defaults. */
const FASTER = { min: 1.01, max: 2, default: 1.5 };
const SLOWER = { min: 0.5, max: 0.99, default: 0.75 };

/** Difficulty Adjust's limits with `extended_limits` on. */
const DA_MAX = 11;
const DA_MIN_AR = -10;

/**
 * Experimental mods that change a value while the map plays, so the one McOsu stored is
 * wherever it had got to at the end and says nothing about an override.
 */
const MOVES_CS = new Set(['osu_mod_minimize']);
const MOVES_AR = new Set(['osu_mod_artimewarp', 'osu_mod_arwobble']);

/** The acronym everything McOsu has and osu! does not is filed under. */
export const MCOSU_MOD = 'MC';

/** McOsu stores floats; two decimals is finer than any slider it offers. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A McOsu play's mods, as osu! would write them if it could have set the play.
 *
 * - **Speed** comes from what McOsu played at, not its bits: its speed slider sets no DT or
 *   HT. Faster is Double Time (Nightcore when its bit is set), slower is Half Time, carrying
 *   the rate when it is not the default -- osu!'s own way of writing 1.2x.
 * - **CS/AR/OD/HP overrides** become Difficulty Adjust, holding only the values that differ
 *   from the map's own through Easy or Hard Rock. Listed after those two, because osu!
 *   applies mods in order: Hard Rock and then the override is what McOsu did, and the
 *   reverse would multiply the override. Without the `.osu` nothing can be told apart, and
 *   none is added.
 * - **Nightmare and McOsu's experimental mods** become one mod, MC, whose settings name them.
 *   osu! has no equivalent of any of them, so its calculator is never shown MC, and osu!
 *   (which does not know the acronym) does not rank it.
 */
export function mcosuMods(legacyMods: number, facts: McosuFacts, base: BaseDifficulty | null): McosuMods {
  let priceable = true;

  const speed = round2(facts.speed);
  let rateBit = 0;
  let rate: number | null = null;
  if (speed > 1) {
    rateBit = legacyMods & NC ? NC | DT : DT;
    if (speed < FASTER.min || speed > FASTER.max) priceable = false;
    if (speed !== FASTER.default) rate = speed;
  } else if (speed < 1) {
    rateBit = HT;
    if (speed < SLOWER.min || speed > SLOWER.max) priceable = false;
    if (speed !== SLOWER.default) rate = speed;
  }
  const bits = (legacyMods & ~(DT | NC | HT | NIGHTMARE_BIT)) | rateBit;
  // McOsu is osu!standard only.
  const mods: LazerMod[] = decodeLegacyMods(bits, 0).map((m) =>
    rate !== null && (m.acronym === 'DT' || m.acronym === 'NC' || m.acronym === 'HT')
      ? { acronym: m.acronym, settings: { speed_change: rate } }
      : m,
  );

  if (base !== null) {
    const hr = (legacyMods & HR) !== 0;
    const ez = (legacyMods & EZ) !== 0;
    // McOsu's getDifficultyMultiplier and getCSDifficultyMultiplier: Easy wins over Hard Rock.
    const mult = ez ? 0.5 : hr ? 1.4 : 1;
    const csMult = ez ? 0.5 : hr ? 1.3 : 1;
    const expected = {
      cs: Math.min(base.cs * csMult, 10),
      ar: Math.min(base.ar * mult, 10),
      od: Math.min(base.od * mult, 10),
      hp: Math.min(base.hp * mult, 10),
    };
    const experimental = new Set(facts.experimental);
    const moving = {
      cs: [...MOVES_CS].some((m) => experimental.has(m)),
      ar: [...MOVES_AR].some((m) => experimental.has(m)),
      od: false,
      hp: false,
    };
    const keys = { cs: 'circle_size', ar: 'approach_rate', od: 'overall_difficulty', hp: 'drain_rate' } as const;

    const settings: Record<string, number | boolean> = {};
    for (const stat of ['cs', 'ar', 'od', 'hp'] as const) {
      const stored = facts[stat];
      if (!Number.isFinite(stored) || moving[stat]) continue;
      // McOsu stores float32: compare at that precision, or every 3.3 would be an override.
      if (Math.abs(stored - Math.fround(expected[stat])) < 0.001) continue;
      const value = round2(stored);
      settings[keys[stat]] = value;
      if (value > DA_MAX || value < (stat === 'ar' ? DA_MIN_AR : 0)) priceable = false;
    }
    if (Object.keys(settings).length > 0) {
      if (Object.values(settings).some((v) => typeof v === 'number' && (v > 10 || v < 0))) {
        settings['extended_limits'] = true;
      }
      mods.push({ acronym: 'DA', settings });
    }
  }

  const priced = priceable ? mods.map((m) => ({ ...m })) : null;

  const own = [...(facts.nightmare ? ['nightmare'] : []), ...facts.experimental];
  if (own.length > 0) {
    mods.push({ acronym: MCOSU_MOD, settings: Object.fromEntries(own.map((name) => [name, true])) });
  }

  return {
    mods,
    priced,
    ignoreLegacyTotalScore: priced !== null && !legacyTotalComparable(legacyMods, priced),
  };
}

/**
 * Whether osu! can read McOsu's recorded total as the stable total it assumes it is.
 *
 * osu! estimates a stable play's combo breaks from its total, using stable's mod multipliers
 * for the mods it is pricing (`OsuLegacyScoreMissCalculator`). McOsu's total used McOsu's
 * multipliers for its *bits* (`Osu::getScoreMultiplier`), which is the same thing for a play
 * whose bits say what was played -- and not for a slider speed with no DT or HT bit, which
 * McOsu gives no multiplier, or Easy with No Fail, which McOsu halves once and stable twice.
 * Difficulty Adjust changes nothing here: both sides take the map's own values.
 *
 * Relax and Autopilot are left out of both, so a McOsu RX play is priced as a stable one is.
 */
export function legacyTotalComparable(legacyMods: number, priced: readonly LazerMod[]): boolean {
  const has = (bit: number) => (legacyMods & bit) !== 0;
  const v2 = has(1 << 29);
  let mcosu = 1;
  if (has(EZ) || (has(1 << 0) && !v2)) mcosu *= 0.5;
  if (has(HT)) mcosu *= 0.3;
  if (has(HR)) mcosu *= v2 ? 1.1 : 1.06;
  if (has(DT) || has(NC)) mcosu *= v2 ? 1.2 : 1.12;
  if (has(1 << 3)) mcosu *= 1.06;
  if (has(1 << 12)) mcosu *= 0.9;

  const acronyms = new Set(priced.map((m) => m.acronym));
  let osu = 1;
  if (acronyms.has('NF') && !v2) osu *= 0.5;
  if (acronyms.has('EZ')) osu *= 0.5;
  if (acronyms.has('HT') || acronyms.has('DC')) osu *= 0.3;
  if (acronyms.has('HD')) osu *= 1.06;
  if (acronyms.has('HR')) osu *= v2 ? 1.1 : 1.06;
  if (acronyms.has('DT') || acronyms.has('NC')) osu *= v2 ? 1.2 : 1.12;
  if (acronyms.has('FL')) osu *= 1.12;
  if (acronyms.has('SO')) osu *= 0.9;

  return Math.abs(mcosu - osu) < 1e-9;
}

/* ------------------------------------------------------------------------ */
/* Finding McOsu                                                            */
/* ------------------------------------------------------------------------ */

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** McOsu's executable, under the name each of its builds has used. */
const EXECUTABLES = ['McEngine.exe', 'McOsu.exe', 'McEngine', 'McOsu'];

/** Whether `root` is a McOsu folder: its executable beside its own `cfg` folder or `scores.db`. */
export function isMcosuRoot(root: string): boolean {
  if (!EXECUTABLES.some((exe) => exists(path.join(root, exe)))) return false;
  return exists(path.join(root, 'cfg')) || exists(path.join(root, 'scores.db'));
}

/**
 * The scores databases McOsu keeps: `scores.db`, and `scoresvr.db` for plays in its VR mode.
 * Both are listed whether or not they exist yet, since the first play creates them.
 */
export function mcosuScoreFiles(root: string): string[] {
  return [path.join(root, 'scores.db'), path.join(root, 'scoresvr.db')];
}

/**
 * The Songs folder McOsu loads beatmaps from: `osu_folder` in its `cfg/osu.cfg`, which is
 * usually the osu!stable install. Null when it names none, or none that exists.
 */
export function mcosuSongs(root: string): string | null {
  let cfg: string;
  try {
    cfg = fs.readFileSync(path.join(root, 'cfg', 'osu.cfg'), 'utf8');
  } catch {
    return null;
  }
  // McOsu on Windows writes the folder with a trailing backslash (`C:\...\osu!\`), which on
  // macOS and Linux is an ordinary filename character rather than a separator -- a config
  // written on Windows, or McOsu under Wine, would otherwise find no Songs folder there.
  const folder = /^[ \t]*osu_folder[ \t]+(.+?)[ \t]*$/m
    .exec(cfg)?.[1]
    ?.replace(/^"|"$/g, '')
    .replace(/[\\/]+$/, '');
  if (!folder) return null;
  const songs = path.join(folder, 'Songs');
  return exists(songs) ? songs : null;
}

/** Steam's app id for McOsu. */
export const MCOSU_STEAM_APP = 607260;

/**
 * Every Steam library on this machine, from Steam's own `libraryfolders.vdf`. The first is
 * Steam's own folder, which is always a library. Nothing here when Steam is not installed.
 */
export function steamLibraries(steamRoots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const steam of steamRoots) {
    if (!exists(steam)) continue;
    add(steam);
    let vdf: string;
    try {
      vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    } catch {
      continue;
    }
    for (const m of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) {
      add(m[1]!.replace(/\\\\/g, '\\'));
    }
  }
  return out;
}

/** Where Steam puts McOsu in each library. */
export function steamMcosuCandidates(libraries: readonly string[]): string[] {
  return libraries.map((lib) => path.join(lib, 'steamapps', 'common', 'McOsu'));
}
