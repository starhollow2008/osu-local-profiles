/**
 * The plays the pp parity check asks about, generated rather than collected.
 *
 * Beatmaps and replays written from a fixed seed, so every machine -- a contributor's, a CI
 * runner, an agent's -- checks the same thing, with nothing private in the repository and
 * nothing to download (roadmap 5.60). What matters to the check is not realism but reach: every
 * path through osu!'s decoders and calculators that a trimmed or pruned helper could have lost.
 * So the maps are built to touch each of them: every slider curve, repeats and ticks, BPM and
 * slider-velocity changes, kiai, breaks, stacks and spinners in osu!; don, kat, finishers,
 * drumrolls and swells in taiko; fruit, juice and bananas in catch; chords, jacks and holds at
 * 4K and 7K in mania -- and osu! maps converted to all three. The replays are osu!stable ones,
 * lazer ones with the LZMA block lazer appends (the path full trimming broke in 5.44), and
 * McOsu plays built exactly as the app builds them.
 *
 * Deliberately short: a few hundred objects a map, so the whole check takes seconds.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildMcosuReplay } from '../src/clients/mcosu.ts';

const require = createRequire(import.meta.url);
const LZMA = require('lzma-js-simple-v2');

/** mulberry32: small, fast, and the same on every platform. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ beatmaps */

function osuFile({ mode, name, difficulty, timing, breaks = [], objects }) {
  const d = { sliderMultiplier: 1.4, tickRate: 1, ...difficulty };
  return [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'AudioLeadIn: 0',
    'PreviewTime: -1',
    'Countdown: 0',
    'SampleSet: Soft',
    'StackLeniency: 0.7',
    `Mode: ${mode}`,
    'LetterboxInBreaks: 0',
    'WidescreenStoryboard: 1',
    '',
    '[Editor]',
    'DistanceSpacing: 1.2',
    'BeatDivisor: 4',
    'GridSize: 8',
    'TimelineZoom: 1',
    '',
    '[Metadata]',
    `Title:Parity ${name}`,
    `TitleUnicode:パリティ ${name}`,
    'Artist:osu! local profiles',
    'ArtistUnicode:osu! local profiles',
    'Creator:pp-parity',
    `Version:${name}`,
    'Source:',
    'Tags:generated parity [test]',
    'BeatmapID:0',
    'BeatmapSetID:-1',
    '',
    '[Difficulty]',
    `HPDrainRate:${d.hp}`,
    `CircleSize:${d.cs}`,
    `OverallDifficulty:${d.od}`,
    `ApproachRate:${d.ar}`,
    `SliderMultiplier:${d.sliderMultiplier}`,
    `SliderTickRate:${d.tickRate}`,
    '',
    '[Events]',
    '//Background and Video events',
    '0,0,"bg.jpg",0,0',
    '//Break Periods',
    ...breaks.map(([start, end]) => `2,${start},${end}`),
    '//Storyboard Layer 0 (Background)',
    '//Storyboard Sound Samples',
    '',
    '[TimingPoints]',
    ...timing.map(
      (t) =>
        `${t.time},${t.beatLength},${t.meter ?? 4},${t.sampleSet ?? 2},${t.sampleIndex ?? 0},${t.volume ?? 60},${t.uninherited ? 1 : 0},${t.kiai ? 1 : 0}`,
    ),
    '',
    '',
    '[Colours]',
    'Combo1 : 255,128,64',
    'Combo2 : 64,160,255',
    'Combo3 : 128,255,128',
    '',
    '[HitObjects]',
    ...objects,
    '',
  ].join('\r\n');
}

const circle = (x, y, t, { nc = false, hs = 0 } = {}) => `${x},${y},${Math.round(t)},${1 | (nc ? 4 : 0)},${hs},0:0:0:0:`;
const spinner = (t, end, nc = true) => `256,192,${Math.round(t)},${8 | (nc ? 4 : 0)},0,${Math.round(end)},0:0:0:0:`;
function slider(x, y, t, curve, slides, length, { nc = false, hs = 0 } = {}) {
  const edges = Array.from({ length: slides + 1 }, (_, i) => [0, 2, 8, 4][i % 4]).join('|');
  const sets = Array.from({ length: slides + 1 }, (_, i) => (i % 2 ? '1:2' : '0:0')).join('|');
  return `${x},${y},${Math.round(t)},${2 | (nc ? 4 : 0)},${hs},${curve},${slides},${length},${edges},${sets},0:0:0:0:`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Jumps, bursts and stacks: the aim and speed skills, and osu!'s stacking. */
function aimMap(rand) {
  const beat = 60000 / 180;
  const objects = [];
  let t = 1000;
  let x = 256;
  let y = 192;
  for (let block = 0; block < 36; block++) {
    const kind = block % 3;
    if (kind === 0) {
      for (let i = 0; i < 6; i++) {
        x = clamp(rand() * 512, 0, 512);
        y = clamp(rand() * 384, 0, 384);
        objects.push(circle(x, y, t, { nc: i === 0, hs: i % 2 ? 2 : 0 }));
        t += beat / (rand() < 0.5 ? 1 : 2);
      }
    } else if (kind === 1) {
      const angle = rand() * Math.PI * 2;
      for (let i = 0; i < 7; i++) {
        x = clamp(x + Math.cos(angle) * 22, 0, 512);
        y = clamp(y + Math.sin(angle) * 22, 0, 384);
        objects.push(circle(x, y, t, { nc: i === 0 }));
        t += beat / 4;
      }
      t += beat / 2;
    } else {
      for (let i = 0; i < 3; i++) {
        objects.push(circle(x, y, t, { nc: i === 0 }));
        t += beat / 4;
      }
      t += beat / 2;
    }
  }
  return osuFile({
    mode: 0,
    name: 'Aim',
    difficulty: { hp: 5, cs: 4, od: 8, ar: 9 },
    timing: [
      { time: 1000, beatLength: beat, uninherited: true },
      { time: Math.round(1000 + beat * 40), beatLength: -80, kiai: true },
    ],
    objects,
  });
}

/** Every slider curve, repeats, ticks, and slider velocity changing under them. */
function sliderMap(rand) {
  const beat = 60000 / 160;
  const sv = 1.6;
  const objects = [];
  const timing = [{ time: 1000, beatLength: beat, uninherited: true }];
  let t = 1000;
  let multiplier = 1;
  for (let i = 0; i < 60; i++) {
    if (i % 10 === 5) {
      multiplier = [0.5, 1, 1.5, 2][Math.floor(i / 10) % 4];
      timing.push({ time: Math.round(t), beatLength: -100 / multiplier, kiai: i % 20 === 5 });
    }
    const x = clamp(64 + rand() * 384, 0, 512);
    const y = clamp(64 + rand() * 256, 0, 384);
    const length = Math.round(80 + rand() * 220);
    const slides = 1 + (i % 4 === 3 ? 2 : i % 3 === 2 ? 1 : 0);
    const dx = clamp(x + 100, 0, 512);
    const dy = clamp(y + 60, 0, 384);
    const curve = [
      `B|${clamp(x + 60, 0, 512)}:${clamp(y - 80, 0, 384)}|${dx}:${dy}|${dx}:${dy}|${clamp(dx + 80, 0, 512)}:${clamp(dy - 40, 0, 384)}`,
      `P|${clamp(x + 50, 0, 512)}:${clamp(y + 70, 0, 384)}|${dx}:${clamp(y + 10, 0, 384)}`,
      `L|${dx}:${dy}`,
      `C|${clamp(x + 40, 0, 512)}:${clamp(y + 90, 0, 384)}|${clamp(x + 120, 0, 512)}:${clamp(y - 30, 0, 384)}|${dx}:${dy}`,
    ][i % 4];
    objects.push(slider(x, y, t, curve, slides, length, { nc: i % 4 === 0, hs: i % 2 ? 8 : 0 }));
    t += (length / (100 * sv * multiplier)) * beat * slides + beat / 2;
    if (i % 5 === 4) {
      objects.push(circle(clamp(x - 80, 0, 512), y, t));
      t += beat;
    }
  }
  return osuFile({ mode: 0, name: 'Sliders', difficulty: { hp: 4, cs: 3.3, od: 6, ar: 8, sliderMultiplier: sv, tickRate: 2 }, timing, objects });
}

/** BPM changes, spinners and a break, at awkward settings. */
function technicalMap(rand) {
  const objects = [];
  const timing = [];
  const breaks = [];
  let t = 1000;
  for (const [section, bpm] of [150, 220, 170].entries()) {
    const beat = 60000 / bpm;
    timing.push({ time: Math.round(t), beatLength: beat, uninherited: true, meter: section === 1 ? 3 : 4 });
    timing.push({ time: Math.round(t + beat * 8), beatLength: [-120, -70, -100][section] });
    for (let i = 0; i < 40; i++) {
      const x = clamp(rand() * 512, 0, 512);
      const y = clamp(rand() * 384, 0, 384);
      if (i % 9 === 8) {
        objects.push(slider(x, y, t, `L|${clamp(x + 90, 0, 512)}:${y}`, 1, 90, { nc: true }));
        t += beat * 1.5;
      } else {
        objects.push(circle(x, y, t, { nc: i % 6 === 0, hs: [0, 2, 4, 8][i % 4] }));
        t += beat / (i % 3 === 0 ? 2 : 1);
      }
    }
    objects.push(spinner(t + beat, t + beat * 5));
    t += beat * 7;
    if (section === 0) {
      breaks.push([Math.round(t), Math.round(t + 6000)]);
      t += 7000;
    }
  }
  return osuFile({ mode: 0, name: 'Technical', difficulty: { hp: 6.5, cs: 5.2, od: 9.3, ar: 9.7 }, timing, breaks, objects });
}

/** Don, kat, finishers, drumrolls and swells. */
function taikoMap(rand) {
  const beat = 60000 / 190;
  const objects = [];
  let t = 1000;
  for (let i = 0; i < 220; i++) {
    if (i % 40 === 39) {
      objects.push(spinner(t, t + beat * 3, false));
      t += beat * 4;
    } else if (i % 25 === 24) {
      objects.push(slider(256, 192, t, 'L|356:192', 1, 140));
      t += beat * 2;
    } else {
      const hs = [0, 2, 8, 4, 6, 12][Math.floor(rand() * 6)];
      objects.push(circle(256, 192, t, { hs }));
      t += beat / (rand() < 0.4 ? 4 : 2);
    }
  }
  return osuFile({
    mode: 1,
    name: 'Taiko',
    difficulty: { hp: 6, cs: 5, od: 7, ar: 5 },
    timing: [{ time: 1000, beatLength: beat, uninherited: true }, { time: Math.round(1000 + beat * 60), beatLength: -75, kiai: true }],
    objects,
  });
}

/** Fruit, juice streams and bananas, with jumps wide enough to hyperdash. */
function catchMap(rand) {
  const beat = 60000 / 175;
  const objects = [];
  let t = 1000;
  for (let i = 0; i < 180; i++) {
    if (i % 45 === 44) {
      objects.push(spinner(t, t + beat * 4));
      t += beat * 5;
    } else if (i % 7 === 6) {
      const x = clamp(rand() * 400, 0, 512);
      objects.push(slider(x, 192, t, i % 2 ? `L|${x + 110}:192` : `B|${x + 50}:120|${x + 110}:192`, 1 + (i % 3 === 0 ? 1 : 0), 110, { nc: true }));
      t += beat * 1.5;
    } else {
      const x = i % 5 === 0 ? (i % 10 === 0 ? 20 : 490) : clamp(rand() * 512, 0, 512);
      objects.push(circle(x, 192, t, { nc: i % 8 === 0 }));
      t += beat / 2;
    }
  }
  return osuFile({ mode: 2, name: 'Catch', difficulty: { hp: 5, cs: 4, od: 8, ar: 9 }, timing: [{ time: 1000, beatLength: beat, uninherited: true }], objects });
}

/** Chords, jacks, trills and holds. */
function maniaMap(rand, keys) {
  const beat = 60000 / 200;
  const column = (c) => Math.floor(((c + 0.5) * 512) / keys);
  const objects = [];
  let t = 1000;
  for (let i = 0; i < 160; i++) {
    const pattern = i % 4;
    if (pattern === 0) {
      for (let c = 0; c < keys; c += 2) objects.push(`${column(c)},192,${Math.round(t)},1,0,0:0:0:0:`);
    } else if (pattern === 1) {
      const c = Math.floor(rand() * keys);
      objects.push(`${column(c)},192,${Math.round(t)},128,0,${Math.round(t + beat * 2)}:0:0:0:0:`);
    } else {
      objects.push(`${column(Math.floor(rand() * keys))},192,${Math.round(t)},1,0,0:0:0:0:`);
    }
    t += beat / (pattern === 3 ? 4 : 2);
  }
  return osuFile({
    mode: 3,
    name: `Mania ${keys}K`,
    difficulty: { hp: 7, cs: keys, od: 8, ar: 5 },
    timing: [{ time: 1000, beatLength: beat, uninherited: true }],
    objects,
  });
}

/* ------------------------------------------------------------------ replays */

function writer() {
  const parts = [];
  const w = {
    byte: (v) => parts.push(Buffer.from([v])),
    short: (v) => {
      const b = Buffer.alloc(2);
      b.writeInt16LE(v);
      parts.push(b);
    },
    int: (v) => {
      const b = Buffer.alloc(4);
      b.writeInt32LE(v);
      parts.push(b);
    },
    long: (v) => {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v));
      parts.push(b);
    },
    string: (s) => {
      if (s === null) return w.byte(0);
      const d = Buffer.from(s, 'utf8');
      parts.push(Buffer.from([0x0b, d.length]), d);
    },
    bytes: (b) => parts.push(Buffer.from(b)),
    done: () => Buffer.concat(parts),
  };
  return w;
}

/** The replay header osu!'s decoder reads, with no frames. */
function header(w, { version, mode, md5, mods, counts = [180, 24, 6, 40, 12, 4], total = 1234567, combo = 210 }) {
  w.byte(mode);
  w.int(version);
  w.string(md5);
  w.string('parity');
  w.string(null);
  for (const c of counts) w.short(c);
  w.int(total);
  w.short(combo);
  w.byte(0);
  w.int(mods);
  w.string(null);
  w.long(638000000000000000n);
  w.int(0);
}

/** An osu!stable replay: header only, as the app's McOsu replays and Data/r's unsubmitted ones are. */
export function stableReplay(mode, md5, mods) {
  const w = writer();
  header(w, { version: 20260711, mode, md5, mods });
  w.long(0);
  return w.done();
}

/** Judgements lazer records, per ruleset, as statistics and their maximum. */
const LAZER_STATISTICS = {
  0: [{ great: 180, ok: 24, meh: 6, miss: 4, large_tick_hit: 30, slider_tail_hit: 40 }, { great: 214, large_tick_hit: 32, slider_tail_hit: 44 }],
  1: [{ great: 190, ok: 20, miss: 6, small_bonus: 20, large_bonus: 4 }, { great: 216, small_bonus: 24, large_bonus: 6 }],
  2: [{ great: 150, large_tick_hit: 30, small_tick_hit: 40, small_tick_miss: 4, miss: 5, large_bonus: 10 }, { great: 155, large_tick_hit: 30, small_tick_hit: 44, large_bonus: 12 }],
  3: [{ perfect: 120, great: 60, good: 20, ok: 8, meh: 3, miss: 5 }, { perfect: 216 }],
};

/** A lazer replay, with the LZMA-compressed block of mods, settings and statistics lazer appends. */
export function lazerReplay(mode, md5, mods) {
  const [statistics, maximum_statistics] = LAZER_STATISTICS[mode];
  const block = JSON.stringify({
    online_id: -1,
    mods,
    statistics,
    maximum_statistics,
    client_version: '2026.916.0',
    rank: 'A',
    user_id: -1,
    total_score_without_mods: 800000,
  });
  const compressed = Buffer.from(LZMA.compress(block, 1));
  const w = writer();
  header(w, { version: 30000017, mode, md5, mods: 0 });
  w.long(-1);
  w.int(compressed.length);
  w.bytes(compressed);
  return w.done();
}

/** Mods lazer replays are generated with, per ruleset: defaults, settings, and the ones osu! does not rank. */
const LAZER_MODS = {
  0: [[], [{ acronym: 'HD' }, { acronym: 'DT', settings: { speed_change: 1.3 } }], [{ acronym: 'HR' }, { acronym: 'FL' }], [{ acronym: 'CL' }], [{ acronym: 'DA', settings: { approach_rate: 10.5, extended_limits: true } }], [{ acronym: 'RX' }, { acronym: 'DT' }], [{ acronym: 'AP' }], [{ acronym: 'TC' }, { acronym: 'MR' }]],
  1: [[], [{ acronym: 'HD' }, { acronym: 'NC' }], [{ acronym: 'HR' }], [{ acronym: 'CL' }], [{ acronym: 'RX' }], [{ acronym: 'SW' }]],
  2: [[], [{ acronym: 'HD' }, { acronym: 'HR' }], [{ acronym: 'DT', settings: { speed_change: 1.4 } }], [{ acronym: 'CL' }], [{ acronym: 'RX' }], [{ acronym: 'FF' }]],
  3: [[], [{ acronym: 'DT' }], [{ acronym: 'HT', settings: { speed_change: 0.8 } }], [{ acronym: 'CL' }], [{ acronym: '7K' }], [{ acronym: 'MR' }, { acronym: 'HO' }], [{ acronym: 'DS' }]],
};

/** McOsu plays, as the app reads them from scores.db: every way its mods map onto osu!'s. */
const MCOSU_PLAYS = [
  { legacyMods: 64, speed: 1.5 },
  { legacyMods: 0, speed: Math.fround(1.2) },
  { legacyMods: 64 | 512, speed: Math.fround(1.3) },
  { legacyMods: 0, speed: Math.fround(0.6) },
  { legacyMods: 64, speed: 1.5, ar: 7 },
  { legacyMods: 16, speed: 1, cs: 6 },
  { legacyMods: 1 | 2, speed: 1 },
  { legacyMods: 1 << 22, speed: 1, experimental: ['osu_mod_wobble', 'osu_mod_fullalternate'] },
  { legacyMods: 0, speed: 1, experimental: ['osu_mod_minimize'], cs: 6.5 },
  { legacyMods: 0, speed: 2.5 },
];

/* ------------------------------------------------------------------ the corpus */

/**
 * Write the corpus into `dir` and describe it the way pp-parity.mjs reads any source: every
 * replay with the beatmap it was set on, and the beatmaps of each ruleset to build more from.
 */
export function generateCorpus(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rand = random(5_60);
  const maps = { 0: [], 1: [], 2: [], 3: [] };
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const addMap = (mode, name, text) => {
    const file = write(`${name}.osu`, text);
    maps[mode].push({ file, md5: crypto.createHash('md5').update(text).digest('hex') });
  };
  addMap(0, 'aim', aimMap(rand));
  addMap(0, 'sliders', sliderMap(rand));
  addMap(0, 'technical', technicalMap(rand));
  addMap(1, 'taiko', taikoMap(rand));
  addMap(2, 'catch', catchMap(rand));
  addMap(3, 'mania-4k', maniaMap(rand, 4));
  addMap(3, 'mania-7k', maniaMap(rand, 7));

  const replays = [];
  // Lazer replays on every beatmap each ruleset can play: its own, and osu!'s converted.
  for (const ruleset of [0, 1, 2, 3]) {
    const playable = [...maps[ruleset], ...(ruleset === 0 ? [] : maps[0])];
    for (const map of playable) {
      LAZER_MODS[ruleset].forEach((mods, i) => {
        replays.push({ file: write(`lazer-${ruleset}-${map.md5}-${i}`, lazerReplay(ruleset, map.md5, mods)), beatmap: map.file });
      });
    }
  }
  // McOsu plays on each osu! beatmap.
  for (const map of maps[0]) {
    MCOSU_PLAYS.forEach((play, i) => {
      const base = { cs: 4, ar: 9, od: 8, hp: 5 };
      const score = {
        beatmapMD5: map.md5,
        importedLegacy: false,
        playedAt: 1_790_000_000_000 + i * 60_000,
        playerName: 'Guest',
        count300: 150,
        count100: 20,
        count50: 3,
        countGeki: 30,
        countKatu: 8,
        countMiss: 2,
        totalScore: 900_000,
        maxCombo: 140,
        legacyMods: play.legacyMods,
        maxPossibleCombo: 260,
        facts: {
          speed: play.speed,
          cs: play.cs ?? base.cs,
          ar: play.ar ?? base.ar,
          od: base.od,
          hp: base.hp,
          nightmare: (play.legacyMods & (1 << 22)) !== 0,
          experimental: play.experimental ?? [],
        },
      };
      replays.push({ file: write(`mcosu-${map.md5}-${i}.osr`, buildMcosuReplay(score)), beatmap: map.file });
    });
  }
  return { replays, maps };
}
