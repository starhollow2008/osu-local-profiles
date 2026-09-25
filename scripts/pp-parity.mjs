/**
 * Two pp helpers, the same requests, and every answer compared exactly.
 *
 *   node scripts/pp-parity.mjs <reference dir> <candidate dir> [--live] [--wsl] [--modules]
 *
 * The guard a slimmer helper has to pass before it ships (roadmap 5.60). A helper that has
 * lost something osu!'s code needed does not always crash: a converter that fails to build
 * gives different mods, and different mods give a different number, silently, in the one part
 * of the app that is never allowed to be approximately right. So this does not test that the
 * candidate *works*; it tests that it answers every request byte for byte as the reference
 * does -- values, errors and all. scripts/build-pp-helper.mjs runs it on every build, and
 * ships the slim helper only when it passes.
 *
 * The plays are generated (scripts/pp-parity-corpus.mjs): beatmaps of all four rulesets built
 * to reach every path a slimmed helper could have lost, with osu!stable, lazer and McOsu
 * replays on them. The same on every machine, nothing private, and seconds to run -- so any
 * contributor, CI runner or agent can check a helper, on any platform. For each: the requests
 * the app itself makes, built by the app's own code; the beatmaps priced as stable replays
 * under a spread of mod bitmasks and under every mod osu! offers the ruleset, alone and with
 * the settings the app sends; osu!'s ranked-mods answer for all of them; and requests that
 * must fail.
 *
 * `--live` adds every replay on this machine as well -- lazer's store, osu!stable's Data/r and
 * McOsu's scores.db, through the app's own index in `data/profiles.db` -- for a maintainer who
 * wants real-world plays on top. It is never required.
 *
 * `--wsl` runs two Linux helpers under WSL from Windows, with every path translated. Compare a
 * platform's helpers with each other, never with another platform's: the question is what
 * slimming changed, and x64 and arm64 may legitimately differ in the last digits.
 *
 * `--modules` (Windows) lists the files in each helper's folder its process ever loaded, which
 * is what says whether a native library can be pruned at all. `--errors` lists the requests
 * both helpers failed, which should be only the ones labelled `error:` -- any other is a
 * generated play osu! could not read, and so a path the check is not reaching.
 *
 * Exits 0 when every answer is identical, 1 when any differs or a helper dies, 2 on misuse.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { looksLikeReplay, parseReplay } from '../src/osr.ts';
import { scoreMods, scorePricing, strippableMods } from '../src/calc/pp.ts';
import { beatmapMode } from '../src/clients/beatmaps.ts';
import { discoverInstalls } from '../src/clients/discover.ts';
import { buildMcosuReplay, mcosuScoreFiles, parseMcosuScores } from '../src/clients/mcosu.ts';
import { MOD_DEFINITIONS } from '../web/js/mod-definitions.js';
import { generateCorpus, stableReplay } from './pp-parity-corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const positional = args.filter((a) => !a.startsWith('--'));
const WSL = flag('--wsl');

/* ------------------------------------------------------------------ this machine's plays (--live) */

function headOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(8);
    const n = fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    return b.subarray(0, n);
  } catch {
    return null;
  }
}

/** Every replay this machine has, with the beatmap it was set on, through the app's own index. */
async function liveReplays(scratch) {
  const dbFile = path.join(root, 'data', 'profiles.db');
  if (!fs.existsSync(dbFile)) {
    console.log(`  --live: no beatmap index at ${dbFile} (run the app once); generated plays only`);
    return [];
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const beatmapPath = db.prepare('SELECT path FROM osu_files WHERE md5 = ? LIMIT 1');
  const osuFor = (md5) => beatmapPath.get(md5)?.path ?? null;
  const installs = (await discoverInstalls({ noSearch: true })).installs;

  const replays = [];
  const candidates = [
    ...db.prepare('SELECT path FROM not_beatmaps').all().map((r) => r.path),
    ...installs
      .filter((i) => i.kind === 'stable')
      .flatMap((i) => (fs.existsSync(i.replayDir) ? fs.readdirSync(i.replayDir).map((f) => path.join(i.replayDir, f)) : [])),
  ];
  for (const file of candidates) {
    const h = headOf(file);
    if (!h || !looksLikeReplay(h)) continue;
    let score;
    try {
      score = await parseReplay(fs.readFileSync(file));
    } catch {
      continue;
    }
    const beatmap = osuFor(score.beatmapMD5);
    if (beatmap && fs.existsSync(beatmap)) replays.push({ file, beatmap });
  }
  for (const install of installs.filter((i) => i.kind === 'mcosu')) {
    for (const file of mcosuScoreFiles(install.root)) {
      let scores = [];
      try {
        scores = parseMcosuScores(fs.readFileSync(file));
      } catch {
        continue;
      }
      for (const score of scores.filter((s) => !s.importedLegacy)) {
        const beatmap = osuFor(score.beatmapMD5);
        if (!beatmap) continue;
        const built = path.join(scratch, `live-mcosu-${score.beatmapMD5}-${score.playedAt}.osr`);
        fs.writeFileSync(built, buildMcosuReplay(score));
        replays.push({ file: built, beatmap });
      }
    }
  }
  db.close();
  return replays;
}

/* ------------------------------------------------------------------ the requests */

const bit = (n) => 2 ** n;
const LEGACY = { NF: bit(0), EZ: bit(1), TD: bit(2), HD: bit(3), HR: bit(4), SD: bit(5), DT: bit(6), RX: bit(7), HT: bit(8), NC: bit(9) | bit(6), FL: bit(10), SO: bit(12), AP: bit(13), PF: bit(14) | bit(5), K4: bit(15), K7: bit(18), FI: bit(20), RD: bit(21), MR: bit(30), V2: bit(29) };
const BITMASKS = {
  0: [0, LEGACY.HD, LEGACY.HR, LEGACY.DT, LEGACY.NC, LEGACY.HT, LEGACY.EZ, LEGACY.NF, LEGACY.FL, LEGACY.SO, LEGACY.HD | LEGACY.HR, LEGACY.HD | LEGACY.DT | LEGACY.FL, LEGACY.EZ | LEGACY.HT, LEGACY.RX, LEGACY.AP, LEGACY.TD, LEGACY.PF, LEGACY.V2, LEGACY.NF | LEGACY.EZ],
  1: [0, LEGACY.HD, LEGACY.HR, LEGACY.DT, LEGACY.HT, LEGACY.EZ, LEGACY.FL, LEGACY.RX, LEGACY.HD | LEGACY.DT, LEGACY.NF | LEGACY.EZ],
  2: [0, LEGACY.HD, LEGACY.HR, LEGACY.DT, LEGACY.HT, LEGACY.EZ, LEGACY.FL, LEGACY.RX, LEGACY.HD | LEGACY.HR, LEGACY.NF | LEGACY.EZ],
  3: [0, LEGACY.DT, LEGACY.HT, LEGACY.EZ, LEGACY.NF, LEGACY.K4, LEGACY.K7, LEGACY.FI, LEGACY.RD, LEGACY.MR, LEGACY.HD, LEGACY.FL, LEGACY.DT | LEGACY.K4],
};

/** Settings worth sending as well as a mod's defaults: the rates and overrides the app sends. */
const WITH_SETTINGS = {
  DT: [{ speed_change: 1.2 }, { speed_change: 2 }],
  NC: [{ speed_change: 1.3 }],
  HT: [{ speed_change: 0.6 }],
  DC: [{ speed_change: 0.8 }],
  DA: [
    { approach_rate: 7 },
    { circle_size: 5.5, overall_difficulty: 9, drain_rate: 3 },
    { approach_rate: 10.5, extended_limits: true },
    { approach_rate: -5, extended_limits: true },
  ],
  AC: [{ minimum_accuracy: 0.95 }],
  HD: [{ only_fade_approach_circles: true }],
  FL: [{ size_multiplier: 1.5 }],
  CL: [{ no_slider_head_accuracy: true }],
  RD: [{ seed: 1234 }],
  TP: [{ seed: 1234 }],
};

/*
 * Mods that pick a random seed when given none, so osu! itself prices them differently on every
 * run (measured: the shipped helper disagreed with itself on exactly these). A lazer replay
 * records the seed it used, so they are only ever sent with one.
 */
const UNSEEDED = new Set(['RD', 'TP']);

const modsFor = (ruleset) =>
  Object.entries(MOD_DEFINITIONS)
    .filter(([, d]) => d.modes.includes(ruleset))
    .map(([acronym]) => acronym)
    .sort();

async function buildRequests({ replays, maps }, scratch) {
  const requests = [];
  const add = (label, request) => requests.push({ label, request });
  const counts = { replays: 0, synthetic: 0, pairs: 0 };

  // Exactly the requests the app makes for a replay: ingest, the stripped price, the ranked question.
  for (const { file, beatmap } of replays) {
    let score;
    try {
      score = await parseReplay(fs.readFileSync(file));
    } catch {
      continue;
    }
    counts.replays++;
    const label = `replay ${path.basename(file)}`;
    const pricing = scorePricing(score, beatmap);
    const base = {
      replayPath: file,
      beatmapPath: beatmap,
      ...(pricing.mods ? { mods: pricing.mods } : {}),
      ...(pricing.ignoreLegacyTotalScore ? { ignoreLegacyTotalScore: true } : {}),
    };
    if (!pricing.unpriceable) add(`${label} priced`, base);
    const strip = strippableMods(scoreMods(score, beatmap));
    if (strip.length > 0 && !pricing.unpriceable) add(`${label} stripped`, { ...base, stripMods: strip });
    const mods = score.mcosu ? scoreMods(score, beatmap) : score.extras?.mods;
    add(
      `${label} ranked`,
      mods ? { type: 'ranked', ruleset: score.mode, mods } : { type: 'ranked', ruleset: score.mode, legacyMods: score.legacyMods },
    );
  }

  // Every beatmap each ruleset can play -- its own, and osu!'s converted -- under every mod.
  const pairs = [];
  for (const ruleset of [0, 1, 2, 3]) {
    for (const map of maps[ruleset] ?? []) pairs.push({ ruleset, map, convert: false });
    if (ruleset !== 0) for (const map of maps[0] ?? []) pairs.push({ ruleset, map, convert: true });
  }
  counts.pairs = pairs.length;
  for (const { ruleset, map, convert } of pairs) {
    const tag = `r${ruleset}${convert ? ' convert' : ''} ${path.basename(map.file)}`;
    for (const mods of BITMASKS[ruleset]) {
      const file = path.join(scratch, `stable-${ruleset}-${map.md5}-${mods}.osr`);
      fs.writeFileSync(file, stableReplay(ruleset, map.md5, mods));
      add(`${tag} stable bits ${mods}`, { replayPath: file, beatmapPath: map.file });
      add(`${tag} stable bits ${mods} no total`, { replayPath: file, beatmapPath: map.file, ignoreLegacyTotalScore: true });
      counts.synthetic += 2;
    }
    const nomod = path.join(scratch, `stable-${ruleset}-${map.md5}-0.osr`);
    for (const acronym of modsFor(ruleset)) {
      for (const settings of [...(UNSEEDED.has(acronym) ? [] : [undefined]), ...(WITH_SETTINGS[acronym] ?? [])]) {
        const mod = settings ? { acronym, settings } : { acronym };
        add(`${tag} mods ${JSON.stringify(mod)}`, { replayPath: nomod, beatmapPath: map.file, mods: [mod] });
        counts.synthetic++;
      }
    }
    add(`${tag} mods RX stripped`, { replayPath: nomod, beatmapPath: map.file, mods: [{ acronym: 'RX' }, { acronym: 'DT' }], stripMods: ['RX'] });
    add(`${tag} mods HR then DA`, { replayPath: nomod, beatmapPath: map.file, mods: [{ acronym: 'HR' }, { acronym: 'DA', settings: { approach_rate: 9 } }] });
    counts.synthetic += 2;
  }

  // osu!'s ranked answer: every mod alone, with its settings, and every legacy bit.
  for (const ruleset of [0, 1, 2, 3]) {
    for (const acronym of modsFor(ruleset)) {
      for (const settings of [undefined, ...(WITH_SETTINGS[acronym] ?? [])]) {
        add(`ranked r${ruleset} ${acronym} ${JSON.stringify(settings ?? {})}`, {
          type: 'ranked',
          ruleset,
          mods: [settings ? { acronym, settings } : { acronym }],
        });
      }
    }
    for (let b = 0; b <= 30; b++) add(`ranked r${ruleset} bit ${b}`, { type: 'ranked', ruleset, legacyMods: 2 ** b });
    add(`ranked r${ruleset} unknown MC`, { type: 'ranked', ruleset, mods: [{ acronym: 'MC', settings: { nightmare: true } }] });
  }

  // Requests that must fail, and fail with the same message: a trimmed framework can lose the
  // text of an exception without losing the exception.
  const junk = path.join(scratch, 'junk.osr');
  fs.writeFileSync(junk, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
  const notMap = path.join(scratch, 'not-a-map.osu');
  fs.writeFileSync(notMap, 'this is not a beatmap');
  const first = maps[0][0];
  const someReplay = path.join(scratch, `stable-0-${first.md5}-0.osr`);
  add('error: no such replay', { replayPath: path.join(scratch, 'missing.osr'), beatmapPath: first.file });
  add('error: no such beatmap', { replayPath: someReplay, beatmapPath: path.join(scratch, 'missing.osu') });
  add('error: corrupt replay', { replayPath: junk, beatmapPath: first.file });
  add('error: not a beatmap', { replayPath: someReplay, beatmapPath: notMap });
  add('error: osu! replay on a mania map', { replayPath: someReplay, beatmapPath: maps[3][0].file });
  add('error: unknown request type', { type: 'nonsense' });
  add('error: unknown ruleset', { type: 'ranked', ruleset: 7, mods: [] });
  add('error: unsupported setting value', { type: 'ranked', ruleset: 0, mods: [{ acronym: 'DT', settings: { speed_change: [1] } }] });
  add('error: empty request', {});
  add('error: malformed line', '{not json');

  return { requests, counts };
}

/* ------------------------------------------------------------------ the helpers */

/** `C:\a\b` as WSL sees it: `/mnt/c/a/b`. */
const toWsl = (p) => {
  const abs = path.resolve(p);
  return `/mnt/${abs[0].toLowerCase()}${abs.slice(2).replace(/\\/g, '/')}`;
};
const PATH_FIELDS = ['replayPath', 'beatmapPath'];

function helper(dir) {
  const abs = path.resolve(dir);
  const exe = path.join(abs, process.platform === 'win32' && !WSL ? 'osu-pp.exe' : 'osu-pp');
  if (!fs.existsSync(exe)) throw new Error(`no helper at ${exe}`);
  const child = WSL
    ? spawn('wsl.exe', ['-e', `${toWsl(abs)}/osu-pp`], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await lines.next();
    if (done) throw new Error(`${exe} exited${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
    return value;
  };
  const translate = (request) => {
    if (!WSL || typeof request === 'string') return request;
    const out = { ...request };
    for (const field of PATH_FIELDS) if (typeof out[field] === 'string') out[field] = toWsl(out[field]);
    return out;
  };
  return {
    dir: abs,
    pid: child.pid,
    ready: next(),
    async ask(request) {
      const sent = translate(request);
      // A string goes as it is, so a malformed line can be sent too.
      child.stdin.write(`${typeof sent === 'string' ? sent : JSON.stringify(sent)}\n`);
      return next();
    },
    /**
     * Resolves once the helper has exited, so its folder can be moved: on Windows, and above
     * all through WSL, a helper still shutting down keeps its files open.
     */
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 15_000).unref();
        child.stdin.end();
      });
    },
  };
}

/** The files in `dir` a running process has mapped: its DLLs, managed and native. Windows only. */
function loadedFrom(pid, dir) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Modules | ForEach-Object { $_.FileName }`],
    { encoding: 'utf8' },
  );
  const prefix = dir.toLowerCase() + path.sep;
  return new Set(
    out
      .split(/\r?\n/)
      .filter((f) => f.toLowerCase().startsWith(prefix))
      .map((f) => path.basename(f)),
  );
}

async function compare(referenceDir, candidateDir, requests) {
  const reference = helper(referenceDir);
  const candidate = helper(candidateDir);
  const [refReady, candReady] = await Promise.all([reference.ready, candidate.ready]);
  let failures = 0;
  if (refReady !== candReady) {
    failures++;
    console.log(`  READY DIFFERS\n    reference: ${refReady}\n    candidate: ${candReady}`);
  }

  let errors = 0;
  for (const { label, request } of requests) {
    const [a, b] = await Promise.all([reference.ask(request), candidate.ask(request)]);
    const answer = JSON.parse(a);
    if (answer.ok === false) {
      errors++;
      // Which requests failed on both sides: only the `error:` ones are meant to.
      if (flag('--errors')) console.log(`  error in both: ${label}: ${answer.error}`);
    }
    if (a !== b) {
      failures++;
      if (failures <= 25) {
        console.log(`  DIFFERS: ${label}\n    request:   ${JSON.stringify(request)}\n    reference: ${a}\n    candidate: ${b}`);
      }
    }
  }

  if (flag('--modules') && process.platform === 'win32' && !WSL) {
    const ref = loadedFrom(reference.pid, reference.dir);
    const cand = loadedFrom(candidate.pid, candidate.dir);
    for (const [name, h, loaded] of [['reference', reference, ref], ['candidate', candidate, cand]]) {
      const unused = fs.readdirSync(h.dir).filter((f) => /\.(dll|exe)$/i.test(f) && !loaded.has(f)).sort();
      const size = unused.reduce((n, f) => n + fs.statSync(path.join(h.dir, f)).size, 0);
      console.log(`\n  ${name} loaded ${loaded.size} of its files; ${unused.length} never loaded (${(size / 1048576).toFixed(1)} MB):`);
      for (const f of unused) console.log(`    ${(fs.statSync(path.join(h.dir, f)).size / 1048576).toFixed(2).padStart(6)} MB  ${f}`);
    }
  }

  await Promise.all([reference.close(), candidate.close()]);
  return { failures, errors };
}

/* ------------------------------------------------------------------ main */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-parity-'));
try {
  const [referenceDir, candidateDir] = positional;
  if (!referenceDir || !candidateDir) {
    console.error('usage: node scripts/pp-parity.mjs <reference dir> <candidate dir> [--live] [--wsl] [--modules]');
    process.exitCode = 2;
  } else {
    const started = Date.now();
    const corpus = generateCorpus(path.join(scratch, 'corpus'));
    if (flag('--live')) corpus.replays.push(...(await liveReplays(scratch)));
    const { requests, counts } = await buildRequests(corpus, scratch);
    console.log(
      `\n  ${requests.length} requests: ${counts.replays} replays, ${counts.synthetic} synthetic` +
        ` (${counts.pairs} beatmap/ruleset pairs), the rest ranked-mods questions and errors`,
    );
    const { failures, errors } = await compare(referenceDir, candidateDir, requests);
    console.log(
      `  ${requests.length - failures}/${requests.length} identical` +
        ` (${errors} of them errors in both, compared as errors)${failures ? `, ${failures} DIFFER` : ''}` +
        ` in ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  }
} catch (e) {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// Helpers left running by a failure would otherwise hold the process open.
process.exit(process.exitCode ?? 0);
