/**
 * Publish the self-contained osu! pp helper, or the app that carries the same osu! code,
 * pruned to what a pp calculator actually needs.
 *
 *   node scripts/build-pp-helper.mjs <outDir> [--rid win-x64]
 *
 * Run directly, this builds the *full* helper into `outDir`: the reference the app is checked
 * against, and how the daily job shows a new osu! release changes no pp
 * (docs/automated-maintenance.md), by building the old and new helpers and comparing them with
 * scripts/pp-parity.mjs. `npm run package` calls `buildCheckedApp`, which builds the app that
 * ships the same way, so the two are always pruned alike.
 *
 * Most of the work is *removing* things. osu!'s NuGet packages carry the whole game: fonts,
 * textures, audio samples, ffmpeg, SDL, a shader compiler and native binaries for Android,
 * iOS, Linux and macOS. Dropping what a pp calculator cannot use takes the helper from
 * 273MB to about 114MB.
 *
 * **Trimmed, but only when proven identical** (roadmap 5.60, docs/csharp-port.md phase 7). The
 * app is published twice: untrimmed, and trimmed (.NET's own libraries only, never osu!'s: see
 * `SLIM_PUBLISH_ARGS`) with the natives in `SLIM_PRUNE_NATIVES` removed too. The trimmed one
 * ships only if it answers every pp and API parity request as the untrimmed one does, on that
 * platform; the untrimmed one otherwise, and the build says why.
 *
 * What can go is narrower than it looks. osu.Framework's `Logger` static constructor drags
 * in nearly the whole *managed* graph -- NUnit, OpenTabletDriver, Sentry, the lot -- so
 * removing any managed assembly kills the helper at startup. What is safe is the things
 * loaded lazily: the resources assembly, localisation satellites, and native libraries
 * reached through P/Invoke only when something actually plays audio or opens a window.
 *
 * Each entry below was verified against a build with no fallback available: an early attempt
 * at this list "passed" the pp tests while shipping a helper that could not start at all,
 * because the Node app fell back to the plain build output.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The full prune lists are also the app's own, for the helper it builds from a player's osu!
 * source (dotnet/App/Calc/SourceHelper.cs, roadmap 5.70): change both together.
 */

/** Managed assemblies safe to drop. Named exactly: a managed assembly is called the same thing everywhere. */
export const PRUNE_ASSEMBLIES = [
  // Fonts, textures and audio samples: 125MB, and the single biggest win.
  'osu.Game.Resources.dll',
];

/**
 * Native libraries the calculator never calls, by *base* name.
 *
 * Matched by pattern rather than by filename because the same library is called three
 * different things: `bass.dll`, `libbass.dylib`, `libbass.so`, and ffmpeg carries its
 * version in a different place on each (`avcodec-58.dll` against `libavcodec.so.58`).
 * Listing every spelling would mean guessing at names on platforms this was written on
 * none of -- and a guess that missed would silently ship a 273MB helper instead of a 114MB
 * one, and ship BASS with it.
 *
 * BASS is the reason this is not merely a size question. It is un4seen's commercial
 * library, free for non-commercial use but *not* freely redistributable, and this app never
 * plays a sound. The pattern has to catch it on every platform, not just the one that was
 * tested.
 *
 * The *managed* wrapper `ppy.ManagedBass.dll` must stay -- osu.Framework references it
 * directly and the helper will not start without it -- which is why these match a whole
 * filename and never a substring.
 */
export const PRUNE_NATIVES = [
  // Audio.
  'bass', 'bass_fx', 'bassmix', 'basswasapi',
  // Video decoding: nothing here ever plays a beatmap background.
  'avcodec', 'avformat', 'avutil', 'swscale', 'swresample',
  // Windowing, image loading and shader compilation: no window is ever opened.
  'SDL2', 'SDL3', 'veldrid-spirv', 'stbi',
  // Debug symbol reader.
  'Microsoft.DiaSymReader.Native.amd64', 'Microsoft.DiaSymReader.Native.x86',
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * `[lib]<name>[-1.2][.dll|.dylib|.so][.3]`, anchored at both ends.
 *
 * Anchoring is what keeps `ppy.ManagedBass.dll` and `osu.Framework.dll` safe: a substring
 * test would take both. The two version slots cover where each platform puts it --
 * `avcodec-58.dll`, `libavcodec.58.dylib`, `libavcodec.so.58`, `libSDL2-2.0.so.0`.
 */
const nativePattern = (name) =>
  new RegExp(`^(lib)?${escape(name)}([-.][0-9][0-9.]*)?\\.(dll|dylib|so)(\\.[0-9][0-9.]*)?$`, 'i');

/**
 * Natives removed from the *trimmed* app only, which ships only past the parity checks.
 *
 * Never loaded under anything `scripts/pp-parity.mjs` sends -- 2,268 real replays, every mod in
 * every ruleset -- and each for a reason that has nothing to do with pp (roadmap 5.60): Realm's
 * and SQLite's native engines (osu!'s code opens no database; the *managed* Realm, which osu!'s
 * model types need, stays, and the app keeps SQLite's engine for its own: `APP_KEEPS`), HTTP/3
 * (no network), the debugger's data access and interface libraries, and the two alternative
 * garbage collectors, loaded only when configuration asks. The untrimmed app keeps them, so the
 * check covers their removal on every platform too.
 */
const SLIM_PRUNE_NATIVES = ['realm-wrappers', 'e_sqlite3', 'msquic', 'mscordaccore', 'mscordbi', 'clrgc', 'clrgcexp'];

/**
 * Windows keeps a second copy of the debugger's data access library under a versioned name,
 * `mscordaccore_amd64_amd64_10.0.1226.42308.dll`, which the base-name patterns do not reach.
 */
const SLIM_VERSIONED_NATIVES = [/^mscordaccore_[a-z0-9]+_[a-z0-9]+_[0-9.]+\.dll$/i];

/**
 * How the trimmed app is trimmed: `partial`, so only .NET's own libraries -- which declare
 * themselves trimmable -- lose what is unused, and the app's own assembly, osu!'s, Newtonsoft,
 * Realm and the rest stay whole. Full trimming broke inside those (roadmap 5.44).
 * Reflection-based System.Text.Json stays on: the requests and answers use it, and trimming
 * turns it off by default. The warnings are about the libraries kept whole, which is the point
 * of partial mode; the parity checks are the guard, not the warnings.
 */
export const SLIM_PUBLISH_ARGS = [
  '-p:PublishTrimmed=true',
  '-p:TrimMode=partial',
  '-p:JsonSerializerIsReflectionEnabledByDefault=true',
  '-p:SuppressTrimAnalysisWarnings=true',
];

const NATIVE_PATTERNS = PRUNE_NATIVES.map(nativePattern);
const SLIM_PATTERNS = [...SLIM_PRUNE_NATIVES.map(nativePattern), ...SLIM_VERSIONED_NATIVES];

/**
 * Whether a published file is one a build has no use for: in the full helper and the
 * untrimmed app, or with `slim` (the default) in the trimmed app. Exported for the tests.
 */
export function shouldPrune(filename, slim = true) {
  if (PRUNE_ASSEMBLIES.includes(filename)) return true;
  if (NATIVE_PATTERNS.some((pattern) => pattern.test(filename))) return true;
  return slim && SLIM_PATTERNS.some((pattern) => pattern.test(filename));
}

/** The .NET runtime identifier for the machine this is running on. */
export function defaultRid() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `win-${arch}`;
  if (process.platform === 'darwin') return `osx-${arch}`;
  return `linux-${arch}`;
}

/*
 * Kept despite looking unnecessary, each verified by removing it and watching the helper
 * die: Realm's managed library (osu!'s model types are Realm objects), System.Private.Xml and
 * DataContractSerialization, ImageSharp, ppy.ManagedBass, NUnit, Sentry and
 * OpenTabletDriver. The last four are reached from osu.Framework's Logger initializer, so
 * they load before any of our code runs no matter how irrelevant they are to pp.
 */

function sizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)}MB`;

/**
 * The full helper, published into `outDir` and pruned, replacing whatever is there.
 *
 * Built beside `outDir` and swapped in only once it has succeeded, so a build that fails -- an
 * osu! release needing a newer .NET SDK than this machine has -- leaves the old one in place.
 */
export function buildPpHelper(outDir, target = defaultRid()) {
  const staging = `${outDir}.building`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    const result = publishAndPrune(staging, target, false);
    swapIn(staging, outDir);
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * How this machine can run a `target` helper or app, as `pp-parity.mjs` flags: none for its own
 * platform, `--wsl` for a Linux one on Windows with WSL, null when it cannot run it at all.
 */
export function runnerFor(target) {
  if (target === defaultRid()) return [];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32' && target === `linux-${arch}`) {
    const wsl = spawnSync('wsl.exe', ['-e', 'true'], { stdio: 'ignore', timeout: 120_000 });
    if (wsl.status === 0) return ['--wsl'];
  }
  return null;
}

/**
 * GitHub's macOS runners have frozen whole, three runs in four, while their Chrome rendered the
 * parity check's pictures, with no log kept. The pictures go through the same capture code on
 * Windows and Linux, so there the macOS build leaves them out.
 */
const noScreenshots = () => (process.platform === 'darwin' && process.env.GITHUB_ACTIONS ? ['--no-screenshots'] : []);

/**
 * The app for a package (docs/csharp-port.md, phase 7), in `outDir`: trimmed if, and only if,
 * it answers exactly as the untrimmed app does on this platform, and untrimmed otherwise, with
 * the reason.
 *
 * Both are pruned as the full helper is: osu!'s fonts and sounds, and the natives a pp calculator
 * never calls, BASS among them, which may not be redistributed. The untrimmed one must then answer
 * every pp parity request as the full helper does, through `--dev pp-helper`, or the build fails:
 * the app resolves osu!'s dependencies beside its own, and a library at another version would
 * otherwise price plays differently without saying so.
 *
 * The trimmed one is trimmed as `SLIM_PUBLISH_ARGS` says (partial, so the app's own assembly and
 * osu!'s stay whole, with reflection-based JSON on) and loses `SLIM_PRUNE_NATIVES` too, except
 * SQLite's, which the app opens. It ships only past two checks against the untrimmed one, here on
 * this platform: every pp parity request, and every answer `scripts/api-parity.mjs` compares, on
 * data the untrimmed app made by importing generated plays (`scripts/parity-data.mjs`), so no
 * osu! install is needed.
 */
export function buildCheckedApp(outDir, target = defaultRid()) {
  const full = `${outDir}.full`;
  const slim = `${outDir}.slim`;
  const helper = `${outDir}.helper`;
  const data = `${outDir}.data`;
  const clear = () => {
    for (const dir of [full, slim, helper, data]) fs.rmSync(dir, { recursive: true, force: true });
  };
  clear();
  try {
    const fullResult = publishAndPrune(full, target, false, APP_PROJECT);
    const runner = runnerFor(target);
    if (runner === null) throw new Error(`this machine cannot run a ${target} app to check its pp against the helper`);
    const helperResult = publishAndPrune(helper, target, false);
    console.log(`\n  checking the app's pp (${mb(fullResult.after)}) against the full helper (${mb(helperResult.after)})...`);
    const priced = spawnSync(process.execPath, [path.join(root, 'scripts', 'pp-parity.mjs'), helper, full, ...runner], { stdio: 'inherit' });
    if (priced.status !== 0) {
      throw new Error('the app did not answer every parity request as the full helper does: it would price plays differently');
    }

    let verdict;
    let slimResult = null;
    try {
      slimResult = publishAndPrune(slim, target, true, APP_PROJECT);
    } catch (e) {
      verdict = { slim: false, reason: `the trimmed app did not build (${e.message})` };
    }
    if (slimResult) {
      console.log(`\n  checking the trimmed app (${mb(slimResult.after)}) against the untrimmed one...`);
      const pp = spawnSync(process.execPath, [path.join(root, 'scripts', 'pp-parity.mjs'), full, slim], { stdio: 'inherit' });
      const made = pp.status === 0
        ? spawnSync(process.execPath, [path.join(root, 'scripts', 'parity-data.mjs'), data, full], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
        : null;
      // parity-data.mjs prints the data folder it made last.
      const dataDir = made?.status === 0 ? made.stdout.trim().split(/\r?\n/).at(-1) : null;
      const api = dataDir
        ? spawnSync(process.execPath, [path.join(root, 'scripts', 'api-parity.mjs'), dataDir, '--reference', full, '--app', slim, ...noScreenshots()], { stdio: 'inherit' })
        : null;
      verdict =
        pp.status !== 0
          ? { slim: false, reason: 'the trimmed app did not answer every pp parity request as the untrimmed one does' }
          : dataDir === null
            ? { slim: false, reason: 'the untrimmed app could not make the data to compare the two on' }
            : api.status !== 0
              ? { slim: false, reason: 'the trimmed app did not answer every API request as the untrimmed one does' }
              : { slim: true, reason: 'identical to the untrimmed app on every pp and API parity request' };
    }
    swapIn(verdict.slim ? slim : full, outDir);
    return { ...verdict, before: fullResult.before, full: fullResult.after, after: sizeOf(outDir) };
  } finally {
    clear();
  }
}

/**
 * Put `staging` where `outDir` is. The old copy is renamed aside first rather than deleted:
 * Windows refuses to rename a folder whose files are open, all at once, where deleting it would
 * get half way and leave a helper that cannot start.
 */
function swapIn(staging, outDir) {
  const old = `${outDir}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(outDir)) {
    try {
      renameSettled(outDir, old);
    } catch (e) {
      throw new Error(
        `could not replace ${outDir} (${e.code ?? e.message}). Close whatever has it open, and build again.`,
      );
    }
  }
  renameSettled(staging, outDir);
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * Rename, waiting out Windows' brief hold on files a process has only just let go of -- the
 * parity check's helpers, and above all a Linux helper that ran through WSL, keep a folder busy
 * for a moment after exiting. Ten seconds at most; anything longer is a real lock.
 */
function renameSettled(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/** The helper's project, and the app's, which carries the same osu! code. */
const HELPER_PROJECT = path.join(root, 'tools', 'PpCalculator', 'PpCalculator.csproj');
const APP_PROJECT = path.join(root, 'dotnet', 'App', 'App.csproj');

/** SQLite's engine, which the trimmed list drops and the app needs: it keeps its profiles in it. */
const APP_KEEPS = nativePattern('e_sqlite3');

/**
 * Publish a project self-contained into `outDir`, and prune it: the full helper's list, or with
 * `slim` trimmed and the trimmed app's list too. The app keeps SQLite's engine either way.
 */
function publishAndPrune(outDir, target, slim, project = HELPER_PROJECT) {
  const result = spawnSync(
    'dotnet',
    [
      'publish', project,
      '-c', 'Release', '-r', target, '--self-contained', 'true',
      '-o', outDir, '--nologo', '-v', 'q',
      ...(slim ? SLIM_PUBLISH_ARGS : []),
    ],
    { stdio: 'inherit', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dotnet publish exited ${result.status}`);

  const before = sizeOf(outDir);
  /*
   * Walk what was actually published rather than deleting a list of expected names. On a
   * platform this has never run on, a name that does not appear is silently nothing --
   * which is how a macOS build would have shipped BASS and 160MB of unused natives while
   * reporting success.
   */
  let removed = 0;
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    // Localisation satellite assemblies: one directory per language.
    if (entry.isDirectory()) {
      fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!shouldPrune(entry.name, slim)) continue;
    if (project === APP_PROJECT && APP_KEEPS.test(entry.name)) continue;
    fs.rmSync(path.join(outDir, entry.name), { force: true });
    removed++;
  }

  return { before, after: sizeOf(outDir), removed };
}

// Run directly (rather than imported by scripts/package.mjs) to build the full helper.
// pathToFileURL rather than string-building the URL: this project's own path contains a
// space, which has to be percent-encoded to match import.meta.url.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const rid = value('--rid') ?? defaultRid();
  // `--full` is what the daily job has always passed; the full helper is now the only kind built here.
  const positional = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--rid');
  if (!positional) {
    console.error('usage: node scripts/build-pp-helper.mjs <outDir> [--rid <rid>]');
    process.exit(2);
  }
  const outDir = path.resolve(positional);

  console.log(`\n  publishing the full pp helper (${rid}) into ${outDir}\n`);
  const result = buildPpHelper(outDir, rid);
  console.log(`\n  ${mb(result.before)} -> ${mb(result.after)}\n`);
  // On a platform whose native library names were never verified, pruning nothing is the
  // failure mode to catch: the helper still works, it is just three times the size and
  // carries BASS, which is not ours to redistribute.
  if (result.removed === 0) {
    console.log('  WARNING: no native libraries matched. The helper will be much larger than');
    console.log('  it should be, and may contain BASS. Check the names in PRUNE_NATIVES.\n');
  }
}
