import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMcosuReplay,
  builtReplayPath,
  isMcosuRoot,
  legacyTotalComparable,
  McosuVersionError,
  mcosuMods,
  mcosuSongs,
  parseMcosuScores,
  readBaseDifficulty,
  steamLibraries,
  steamMcosuCandidates,
  type McosuFacts,
  type McosuScore,
} from '../src/clients/mcosu.ts';
import { mcosuInstall } from '../src/clients/detect.ts';
import { looksLikeInstall } from '../src/clients/discover.ts';
import { parseReplay, scoredAsStable } from '../src/osr.ts';
import { dedupeKey } from '../src/tracker/ingest.ts';
import { scoreMods, scorePricing, calculateScorePp, withClassicMod } from '../src/calc/pp.ts';
import { OfficialCalculator } from '../src/calc/official.ts';
import { McosuWatcher, buildMcosuReplays } from '../src/tracker/mcosu-watcher.ts';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver, indexOneFile } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';

/*
 * McOsu support: its scores.db, the osu!stable replay built for each play, the mods osu!
 * would give it, and finding and watching it. See src/clients/mcosu.ts.
 */

/**
 * The scores.db McOsu 33.14 (Steam) wrote after one play: a DT play on "The Best of Both
 * Worlds" [Normal] by "Guest" -- 87x300 1x100, combo 144/144, 286,804 score, 41.10pp by
 * McOsu's own count. The file as McOsu wrote it, so the reader is held to the real format.
 */
const REAL_SCORES_DB = Buffer.from(
  'vmE0AQEAAAALIGMxN2EwNzNjODNlYTBmMzdlNTNlNTBlYTczYTRiNDE0AQAAAABOAjUBVqm2agAAAAALBUd1ZXN0VwABAAAADgABAAAAVGAEAAAAAACQAEAAAAAAAMhqJEIefBJDHh7YwUYXLUHo4lBAcfrQP6ckxj8AAMA/AABAQAAAwEAAAIBAAABAQJAAAABYAAAAIAAAAAA=',
  'base64',
);

const MD5 = 'c17a073c83ea0f37e53e50ea73a4b414';
const MAP_MD5 = '239e781977656b8c37b15fe70b9990e1';

/** A McOsu score entry, as `OsuDatabase::saveScores` writes it for db version 20210110. */
interface Entry {
  md5?: string;
  imported?: boolean;
  playedAt?: number;
  name?: string;
  counts?: [number, number, number, number, number, number];
  score?: number;
  combo?: number;
  mods?: number;
  speed?: number;
  cs?: number;
  ar?: number;
  od?: number;
  hp?: number;
  maxCombo?: number;
  experimental?: string;
}

function osuString(s: string): Buffer {
  const data = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x0b, data.length]), data]);
}

/** A scores.db holding these entries, grouped by beatmap as McOsu groups them. */
function scoresDb(entries: Entry[], version = 20210110): Buffer {
  const byMap = new Map<string, Entry[]>();
  for (const e of entries) {
    const md5 = e.md5 ?? MAP_MD5;
    byMap.set(md5, [...(byMap.get(md5) ?? []), e]);
  }
  const parts: Buffer[] = [];
  const int = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const short = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    parts.push(b);
  };
  const long = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    parts.push(b);
  };
  const float = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    parts.push(b);
  };
  int(version);
  int(byMap.size);
  for (const [md5, list] of byMap) {
    parts.push(osuString(md5));
    int(list.length);
    for (const e of list) {
      parts.push(Buffer.from([e.imported ? 0xa9 : 0]));
      int(20251214);
      long(Math.floor((e.playedAt ?? 1790358248000) / 1000));
      parts.push(osuString(e.name ?? 'Guest'));
      for (const c of e.counts ?? [100, 10, 1, 20, 5, 0]) short(c);
      long(e.score ?? 400000);
      short(e.combo ?? 170);
      int(e.mods ?? 0);
      short(0); // slider breaks
      for (let i = 0; i < 7; i++) float(1); // pp, UR, hit errors, stars
      float(e.speed ?? 1);
      float(e.cs ?? 3.3);
      float(e.ar ?? 8);
      float(e.od ?? 6);
      float(e.hp ?? 4);
      int(e.maxCombo ?? 175);
      int(111);
      int(51);
      parts.push(e.experimental ? osuString(e.experimental) : Buffer.from([0]));
    }
  }
  return Buffer.concat(parts);
}

const facts = (over: Partial<McosuFacts> = {}): McosuFacts => ({
  speed: 1,
  cs: 3.3,
  ar: 8,
  od: 6,
  hp: 4,
  nightmare: false,
  experimental: [],
  ...over,
});

/** The Hard difficulty the real test plays were set on: CS 3.3, AR 8, OD 6, HP 4. */
const HARD = { cs: 3.3, ar: 8, od: 6, hp: 4 };

const f32 = Math.fround;

/* ------------------------------------------------------------ scores.db */

test("reads the scores.db McOsu itself wrote", () => {
  const [score, ...rest] = parseMcosuScores(REAL_SCORES_DB);
  assert.equal(rest.length, 0);
  assert.equal(score!.beatmapMD5, MD5);
  assert.equal(score!.importedLegacy, false);
  assert.equal(score!.playerName, 'Guest');
  assert.deepEqual(
    [score!.count300, score!.count100, score!.count50, score!.countGeki, score!.countKatu, score!.countMiss],
    [87, 1, 0, 14, 1, 0],
  );
  assert.equal(score!.totalScore, 286804);
  assert.equal(score!.maxCombo, 144);
  assert.equal(score!.maxPossibleCombo, 144);
  assert.equal(score!.legacyMods, 64);
  assert.equal(score!.facts.speed, 1.5);
  assert.deepEqual([score!.facts.cs, score!.facts.ar, score!.facts.od, score!.facts.hp], [3, 6, 4, 3]);
  assert.deepEqual(score!.facts.experimental, []);
  assert.equal(new Date(score!.playedAt).toISOString(), '2026-09-25T17:03:18.000Z');
});

test("the osu!stable scores McOsu copied in are marked, not taken for McOsu's own", () => {
  const scores = parseMcosuScores(scoresDb([{ playedAt: 1_000_000 }, { imported: true, playedAt: 2_000_000 }]));
  assert.deepEqual(
    scores.map((s) => s.importedLegacy),
    [false, true],
  );
});

test('Nightmare is read from the Cinema bit, and experimental mods by name', () => {
  const [score] = parseMcosuScores(
    scoresDb([{ mods: 1 << 22, experimental: 'osu_mod_wobble;osu_mod_fullalternate;' }]),
  );
  assert.equal(score!.facts.nightmare, true);
  assert.deepEqual(score!.facts.experimental, ['osu_mod_wobble', 'osu_mod_fullalternate']);
});

test('a scores.db cut short is a write in progress, not an empty database', () => {
  const whole = scoresDb([{}, {}]);
  assert.throws(() => parseMcosuScores(whole.subarray(0, whole.length - 20)), RangeError);
});

test('a newer scores.db than this app knows is refused, as McOsu refuses one', () => {
  assert.throws(() => parseMcosuScores(scoresDb([{}], 20300101)), McosuVersionError);
});

/* ------------------------------------------------------------ the built replay */

test("a McOsu play's built replay reads back as that play, as McOsu", async () => {
  const [real] = parseMcosuScores(REAL_SCORES_DB);
  const replay = await parseReplay(buildMcosuReplay(real!));
  assert.equal(replay.client, 'mcosu');
  assert.equal(replay.mode, 0);
  assert.equal(replay.version < 30000001, true, 'a stable replay, so osu! scores it as one');
  assert.equal(replay.beatmapMD5, MD5);
  assert.equal(replay.username, 'Guest');
  assert.equal(replay.replayMD5, null);
  assert.equal(replay.count300, 87);
  assert.equal(replay.totalScore, 286804);
  assert.equal(replay.maxCombo, 144);
  assert.equal(replay.perfectCombo, true);
  assert.equal(replay.legacyMods, 64);
  assert.equal(replay.playedAt.getTime(), real!.playedAt);
  assert.equal(replay.onlineScoreId, 0n);
  assert.deepEqual(replay.mcosu, real!.facts);
  assert.equal(replay.extras, null);
  assert.equal(dedupeKey(replay), `mcosu:${MD5}:${real!.playedAt}`);
});

test("Nightmare's Cinema bit never reaches the built replay", async () => {
  const [score] = parseMcosuScores(scoresDb([{ mods: (1 << 22) | 8 }]));
  const replay = await parseReplay(buildMcosuReplay(score!));
  assert.equal(replay.legacyMods, 8);
  assert.equal(replay.mcosu?.nightmare, true);
});

test('McOsu plays are scored as osu!stable ones: legacy grades and the Classic mod', () => {
  assert.equal(scoredAsStable('mcosu'), true);
  assert.equal(scoredAsStable('lazer'), false);
  assert.deepEqual(withClassicMod([{ acronym: 'DT' }], 'mcosu'), [{ acronym: 'DT' }, { acronym: 'CL' }]);
});

/* ------------------------------------------------------------ mods */

test("McOsu's DT at its own speed is plain Double Time, and its total is osu!'s kind", () => {
  const m = mcosuMods(64, facts({ speed: 1.5 }), HARD);
  assert.deepEqual(m.mods, [{ acronym: 'DT' }]);
  assert.deepEqual(m.priced, [{ acronym: 'DT' }]);
  assert.equal(m.ignoreLegacyTotalScore, false);
});

test("the speed slider's 1.2x, with no DT bit, is Double Time at 1.2x -- and its total is not osu!'s kind", () => {
  // The real play: McOsu stores speed 1.2 as a float and sets no rate bit.
  const m = mcosuMods(0, facts({ speed: f32(1.2) }), HARD);
  assert.deepEqual(m.mods, [{ acronym: 'DT', settings: { speed_change: 1.2 } }]);
  assert.equal(m.ignoreLegacyTotalScore, true, 'McOsu gave it no DT multiplier; osu! would assume one');
});

test('Nightcore keeps its name at a custom rate, and slower is Half Time', () => {
  assert.deepEqual(mcosuMods(64 | 512, facts({ speed: f32(1.3) }), HARD).mods, [
    { acronym: 'NC', settings: { speed_change: 1.3 } },
  ]);
  assert.deepEqual(mcosuMods(256, facts({ speed: 0.75 }), HARD).mods, [{ acronym: 'HT' }]);
  assert.deepEqual(mcosuMods(0, facts({ speed: f32(0.6) }), HARD).mods, [
    { acronym: 'HT', settings: { speed_change: 0.6 } },
  ]);
});

test("a DT bit at the slider's 1.0x plays at 1.0x, so there is no rate mod", () => {
  assert.deepEqual(mcosuMods(64 | 8, facts({ speed: 1 }), HARD).mods, [{ acronym: 'HD' }]);
});

test("a speed osu!'s mods cannot hold gets no pp rather than a clamped one", () => {
  // osu! prices DT 2.5x exactly as 2.0x -- measured -- so it must never be asked.
  const fast = mcosuMods(0, facts({ speed: 2.5 }), HARD);
  assert.deepEqual(fast.mods, [{ acronym: 'DT', settings: { speed_change: 2.5 } }]);
  assert.equal(fast.priced, null);
  assert.equal(mcosuMods(0, facts({ speed: 0.4 }), HARD).priced, null);
});

test('an AR override under DT is Difficulty Adjust, after DT, with only the value changed', () => {
  // The real play: AR 8 map, DT, AR stored as 7 -- McOsu stores AR before speed.
  const m = mcosuMods(64, facts({ speed: 1.5, ar: 7 }), HARD);
  assert.deepEqual(m.mods, [{ acronym: 'DT' }, { acronym: 'DA', settings: { approach_rate: 7 } }]);
  assert.equal(m.ignoreLegacyTotalScore, false, 'both sides take the score multiplier from the map itself');
});

test("Hard Rock's own values are not an override, and an override comes after Hard Rock", () => {
  const hr = { cs: f32(3.3 * 1.3), ar: 10, od: f32(8.4), hp: f32(5.6) };
  assert.deepEqual(mcosuMods(16, facts(hr), HARD).mods, [{ acronym: 'HR' }]);
  assert.deepEqual(mcosuMods(16, facts({ ...hr, ar: 9 }), HARD).mods, [
    { acronym: 'HR' },
    { acronym: 'DA', settings: { approach_rate: 9 } },
  ]);
  // Easy wins over Hard Rock in McOsu, as in stable.
  assert.deepEqual(mcosuMods(2, facts({ cs: f32(1.65), ar: 4, od: 3, hp: 2 }), HARD).mods, [{ acronym: 'EZ' }]);
});

test("values past 10 turn Difficulty Adjust's extended limits on; past 11, no pp", () => {
  const m = mcosuMods(0, facts({ ar: 10.5 }), HARD);
  assert.deepEqual(m.mods, [{ acronym: 'DA', settings: { approach_rate: 10.5, extended_limits: true } }]);
  assert.notEqual(m.priced, null);
  assert.equal(mcosuMods(0, facts({ cs: 12 }), HARD).priced, null);
});

test('without the map nothing can be told apart from an override, so none is guessed', () => {
  assert.deepEqual(mcosuMods(64, facts({ speed: 1.5, ar: 7 }), null).mods, [{ acronym: 'DT' }]);
});

test("Nightmare and McOsu's experimental mods are one MC, which osu! is never asked to price", () => {
  const m = mcosuMods(
    1 << 22,
    facts({ nightmare: true, experimental: ['osu_mod_wobble', 'osu_mod_fullalternate'] }),
    HARD,
  );
  assert.deepEqual(m.mods, [
    { acronym: 'MC', settings: { nightmare: true, osu_mod_wobble: true, osu_mod_fullalternate: true } },
  ]);
  assert.deepEqual(m.priced, []);
});

test('a value an experimental mod moves during the map is not an override', () => {
  // Minimize shrinks the circles as the map plays; McOsu stores wherever CS had got to.
  const m = mcosuMods(0, facts({ cs: 5.9, experimental: ['osu_mod_minimize'] }), HARD);
  assert.deepEqual(m.mods, [{ acronym: 'MC', settings: { osu_mod_minimize: true } }]);
});

test("McOsu's total is osu!'s kind only where their mod multipliers agree", () => {
  assert.equal(legacyTotalComparable(8 | 16 | 64, [{ acronym: 'HD' }, { acronym: 'HR' }, { acronym: 'DT' }]), true);
  // McOsu halves Easy+No Fail once; stable, and so osu!, twice.
  assert.equal(legacyTotalComparable(1 | 2, [{ acronym: 'NF' }, { acronym: 'EZ' }]), false);
  // Relax is left out on both sides, so it is priced as a stable Relax play is.
  assert.equal(legacyTotalComparable(128, [{ acronym: 'RX' }]), true);
});

/* ------------------------------------------------------------ finding McOsu */

interface FakeInstall {
  root: string;
  osu: string;
  map: string;
  built: string;
  cleanup: () => void;
}

/** A 30-circle osu!standard map at the real test map's difficulty. */
function mapFile(): string {
  const objects = Array.from({ length: 30 }, (_, i) => `${64 + (i % 6) * 64},${96 + (i % 4) * 64},${1000 + i * 400},1,0,0:0:0:0:`);
  return [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'Mode: 0',
    '',
    '[Metadata]',
    'Title:McOsu Test',
    'Artist:osu! local profiles',
    'Creator:test',
    'Version:Hard',
    '',
    '[Difficulty]',
    'HPDrainRate:4',
    'CircleSize:3.3',
    'OverallDifficulty:6',
    'ApproachRate:8',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[TimingPoints]',
    '1000,400,4,2,0,60,1,0',
    '',
    '[HitObjects]',
    ...objects,
    '',
  ].join('\r\n');
}

function fakeInstall(): FakeInstall {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-mcosu-'));
  const root = path.join(tmp, 'McOsu');
  const osu = path.join(tmp, 'osu!');
  fs.mkdirSync(path.join(root, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'McEngine.exe'), '');
  fs.mkdirSync(path.join(osu, 'Songs', '1 Test'), { recursive: true });
  const map = path.join(osu, 'Songs', '1 Test', 'test.osu');
  fs.writeFileSync(map, mapFile());
  fs.writeFileSync(path.join(root, 'cfg', 'osu.cfg'), `name Guest\nosu_folder ${osu}\\\n`);
  return {
    root,
    osu,
    map,
    built: path.join(tmp, 'data', 'mcosu'),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('a McOsu folder is recognised, with its beatmaps where its osu_folder points', (t) => {
  const f = fakeInstall();
  t.after(f.cleanup);
  assert.equal(isMcosuRoot(f.root), true);
  assert.equal(isMcosuRoot(f.osu), false);
  assert.equal(mcosuSongs(f.root), path.join(f.osu, 'Songs'));
  const install = mcosuInstall(f.root, f.built);
  assert.deepEqual(install, {
    kind: 'mcosu',
    root: f.root,
    replayDir: f.built,
    beatmapRoots: [path.join(f.osu, 'Songs')],
    onlineDb: null,
  });
  assert.equal(looksLikeInstall(['cfg', 'McEngine.exe', 'scores.db']), true);
});

test("the map's own difficulty is read from its [Difficulty] section", (t) => {
  const f = fakeInstall();
  t.after(f.cleanup);
  assert.deepEqual(readBaseDifficulty(f.map), HARD);
  const old = path.join(f.osu, 'old.osu');
  fs.writeFileSync(old, '[Difficulty]\r\nHPDrainRate:5\r\nCircleSize:4\r\nOverallDifficulty:7\r\n');
  assert.deepEqual(readBaseDifficulty(old), { cs: 4, ar: 7, od: 7, hp: 5 }, 'no AR: OD stands in, as in every osu!');
});

test("every Steam library in Steam's list is searched for McOsu", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-steam-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const steam = path.join(tmp, 'Steam');
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  const second = path.join(tmp, 'Games', 'SteamLibrary');
  fs.writeFileSync(
    path.join(steam, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${second.replace(/\\/g, '\\\\')}"\n\t}\n}\n`,
  );
  const libraries = steamLibraries([steam, path.join(tmp, 'nowhere')]);
  assert.deepEqual(libraries, [steam, second]);
  assert.deepEqual(steamMcosuCandidates(libraries), [
    path.join(steam, 'steamapps', 'common', 'McOsu'),
    path.join(second, 'steamapps', 'common', 'McOsu'),
  ]);
});

/* ------------------------------------------------------------ watching and importing */

/** Long enough for the watcher's own debounce plus the filesystem event. */
const SETTLED_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a new entry in scores.db becomes a built replay; what was there before does not', async (t) => {
  const f = fakeInstall();
  t.after(f.cleanup);
  const before = { playedAt: 1_700_000_000_000 };
  fs.writeFileSync(path.join(f.root, 'scores.db'), scoresDb([before]));

  const seen: string[] = [];
  const watcher = new McosuWatcher({ root: f.root, dir: f.built, onReplay: (file) => seen.push(file) });
  t.after(() => watcher.stop());
  await watcher.start();
  await sleep(SETTLED_MS);

  const played = { playedAt: 1_800_000_000_000, mods: 64, speed: 1.5 };
  const copied = { playedAt: 1_800_000_100_000, imported: true };
  fs.writeFileSync(path.join(f.root, 'scores.db'), scoresDb([before, played, copied]));
  await sleep(SETTLED_MS);

  assert.deepEqual(seen, [builtReplayPath(f.built, { beatmapMD5: MAP_MD5, playedAt: played.playedAt })]);
  const replay = await parseReplay(fs.readFileSync(seen[0]!));
  assert.equal(replay.client, 'mcosu');
  assert.equal(replay.playedAt.getTime(), played.playedAt);
});

test('Import past plays builds the replays for its range, and never for a copied stable score', async (t) => {
  const f = fakeInstall();
  t.after(f.cleanup);
  fs.writeFileSync(
    path.join(f.root, 'scores.db'),
    scoresDb([{ playedAt: 1_000_000_000_000 }, { playedAt: 1_800_000_000_000 }, { playedAt: 1_800_000_000_000 + 5000, imported: true }]),
  );
  const built = await buildMcosuReplays(f.root, f.built, 1_500_000_000_000);
  assert.deepEqual(built, [builtReplayPath(f.built, { beatmapMD5: MAP_MD5, playedAt: 1_800_000_000_000 })]);
});

/** A tracker on a fake McOsu install, with its test map indexed. */
function harness(f: FakeInstall, official: OfficialCalculator | null) {
  const db = openDb(path.join(f.root, '..', 'test.db'));
  indexOneFile(db, f.map);
  const installs = [mcosuInstall(f.root, f.built)!];
  const profileId = getOrCreateProfile(db, 'McOsu Test');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, installs),
    installs,
    profileId,
    trackingSince: 0,
    official,
  });
  return { db, profileId, tracker };
}

test('an imported McOsu play is stored as McOsu, with its custom rate and McOsu mods, once', async (t) => {
  const f = fakeInstall();
  const md5 = crypto.createHash('md5').update(fs.readFileSync(f.map)).digest('hex');
  fs.writeFileSync(
    path.join(f.root, 'scores.db'),
    scoresDb([
      { md5, playedAt: 1_800_000_000_000, counts: [28, 2, 0, 5, 2, 0], score: 81234, combo: 30, maxCombo: 30, speed: f32(1.2) },
      {
        md5,
        playedAt: 1_800_000_060_000,
        counts: [30, 0, 0, 8, 0, 0],
        score: 85678,
        combo: 30,
        maxCombo: 30,
        mods: 1 << 22,
        experimental: 'osu_mod_wobble;',
      },
    ]),
  );
  const { db, profileId, tracker } = harness(f, null);
  // Closed before the folder goes: Windows will not delete an open database.
  t.after(() => {
    db.close();
    f.cleanup();
  });

  const first = await tracker.backfill(0);
  assert.equal(first.imported, 2);
  const again = await tracker.backfill(0);
  assert.equal(again.imported, 0, 'the same plays again are duplicates');

  const rows = db
    .prepare('SELECT client, dedupe_key, mods_json, mods_label, grade, player_name FROM scores WHERE profile_id = ? ORDER BY played_at')
    .all(profileId) as Record<string, string>[];
  assert.deepEqual(
    rows.map((r) => [r['client'], r['dedupe_key'], JSON.parse(r['mods_json']!), r['mods_label'], r['player_name']]),
    [
      ['mcosu', `mcosu:${md5}:1800000000000`, [{ acronym: 'DT', settings: { speed_change: 1.2 } }], 'DT', 'Guest'],
      ['mcosu', `mcosu:${md5}:1800000060000`, [{ acronym: 'MC', settings: { nightmare: true, osu_mod_wobble: true } }], 'MC', 'Guest'],
    ],
  );
  assert.equal(rows[1]!['grade'], 'X', 'Nightmare is not Cinema: a 30x300 play is an SS');
});

/* ------------------------------------------------------------ osu!'s calculator */

test("osu!'s calculator prices a built replay with McOsu's rate and overrides", { timeout: 180_000 }, async (t) => {
  const official = await OfficialCalculator.create();
  if (!official) return t.skip('osu-pp helper not built (run: npm run build:pp)');
  t.after(() => official.dispose());
  const f = fakeInstall();
  t.after(f.cleanup);

  const replayFor = async (entry: Entry) => {
    const [score] = parseMcosuScores(scoresDb([{ counts: [29, 1, 0, 5, 1, 0], combo: 30, maxCombo: 30, ...entry }]));
    const file = path.join(f.built, `${entry.playedAt ?? 0}.osr`);
    fs.mkdirSync(f.built, { recursive: true });
    fs.writeFileSync(file, buildMcosuReplay(score!));
    return { file, replay: await parseReplay(fs.readFileSync(file)) };
  };
  const price = async (entry: Entry) => {
    const { file, replay } = await replayFor(entry);
    return calculateScorePp(file, f.map, official, undefined, scorePricing(replay, f.map));
  };

  // DT from McOsu's bits and DT from the new path are the same number.
  const bits = await price({ playedAt: 1, mods: 64, speed: 1.5 });
  assert.ok(bits && bits.pp > 0);
  assert.deepEqual(bits.isLegacy, true);

  // The speed slider's 1.2x is priced at 1.2x: harder than nomod, easier than 1.5x.
  const nomod = await price({ playedAt: 2 });
  const slider = await price({ playedAt: 3, speed: f32(1.2) });
  assert.ok(nomod && slider);
  assert.ok(slider.stars > nomod.stars && slider.stars < bits.stars, `${nomod.stars} < ${slider.stars} < ${bits.stars}`);

  // An AR override changes the rating; the map's own AR does not.
  const own = await price({ playedAt: 4, mods: 64, speed: 1.5, ar: 8 });
  assert.equal(own!.stars, bits.stars);
  const lower = await price({ playedAt: 5, mods: 64, speed: 1.5, ar: 5 });
  assert.notEqual(lower!.stars, bits.stars);

  // A speed osu! cannot hold gets no pp at all.
  assert.equal(await price({ playedAt: 6, speed: 2.5 }), null);

  // What is stored is what was priced.
  const { replay } = await replayFor({ playedAt: 7, mods: 64, speed: 1.5, ar: 5 });
  assert.deepEqual(scoreMods(replay, f.map), [{ acronym: 'DT' }, { acronym: 'DA', settings: { approach_rate: 5 } }]);
});
