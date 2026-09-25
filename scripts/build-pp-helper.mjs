/**
 * Publish the self-contained osu! pp helper into a directory, pruned to what a pp
 * calculator actually needs.
 *
 *   node scripts/build-pp-helper.mjs [outDir] [--rid win-x64] [--full] [--live] [--require-slim]
 *
 * With no arguments this refreshes `tools/pp/`, which is what `src/calc/official.ts`
 * prefers over the plain `dotnet build` output. Keeping that directory current matters more
 * than it looks: an out-of-date helper there does not fail loudly, it answers the *old*
 * protocol and quietly returns values calculated the old way. `npm run package` calls the
 * same function, so the shipped helper and the development one can never diverge.
 *
 * Most of the work is *removing* things. osu!'s NuGet packages carry the whole game: fonts,
 * textures, audio samples, ffmpeg, SDL, a shader compiler and native binaries for Android,
 * iOS, Linux and macOS. Dropping what a pp calculator cannot use takes the helper from
 * 273MB to about 114MB.
 *
 * **Slim, but only when proven identical** (roadmap 5.60). Every build makes the helper twice:
 * the *full* one, as it has always shipped, and a *slim* one -- .NET's own libraries trimmed
 * (never osu!'s: see `SLIM_PUBLISH_ARGS`) and the natives in `SLIM_PRUNE_NATIVES` removed, 58MB
 * against 121MB on Windows. `scripts/pp-parity.mjs` then asks both some 1,800 questions about
 * generated plays -- seconds, on any machine, with nothing to download -- and the slim one ships
 * only if every answer is identical. Otherwise -- a difference, a helper that will not start, a
 * platform this machine cannot run -- the full one ships and the build says why. Nobody has to
 * remember to check: a build cannot ship a slim helper that was not checked, on that platform,
 * against that osu! release.
 *
 * `--full` skips all of that for a quick build while working on Program.cs. `--live` adds every
 * replay on this machine to the check. `--require-slim` fails the build instead of falling back,
 * which is what CI wants: a pull request that breaks the slim helper should say so.
 *
 * What can go is narrower than it looks. osu.Framework's `Logger` static constructor drags
 * in nearly the whole *managed* graph -- NUnit, OpenTabletDriver, Sentry, the lot -- so
 * removing any managed assembly kills the helper at startup. What is safe is the things
 * loaded lazily: the resources assembly, localisation satellites, and native libraries
 * reached through P/Invoke only when something actually plays audio or opens a window.
 *
 * Each entry below was verified against a build with no fallback available. That detail
 * matters: `official.ts` falls back to the plain build output, so an early attempt at this
 * list "passed" the pp tests while shipping a helper that could not start at all.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Managed assemblies safe to drop. Named exactly, because a managed assembly is called the
 * same thing on every platform.
 */
const PRUNE_ASSEMBLIES = [
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
const PRUNE_NATIVES = [
  // Audio.
  'bass', 'bass_fx', 'bassmix', 'basswasapi',
  // Video decoding: nothing here ever plays a beatmap background.
  'avcodec', 'avformat', 'avutil', 'swscale', 'swresample',
  // Windowing, image loading and shader compilation: no window is ever opened.
  'SDL2', 'SDL3', 'veldrid-spirv', 'stbi',
  // Debug symbol reader.
  'Microsoft.DiaSymReader.Native.amd64', 'Microsoft.DiaSymReader.Native.x86',
];

/**
 * Natives removed from the *slim* helper only, which ships only past the parity check.
 *
 * Never loaded under anything `scripts/pp-parity.mjs` sends -- 2,268 real replays, every mod in
 * every ruleset -- and each for a reason that has nothing to do with pp (roadmap 5.60): Realm's
 * and SQLite's native engines (the helper opens no database; the *managed* Realm, which osu!'s
 * model types need, stays), HTTP/3 (no network), the debugger's data access and interface
 * libraries, and the two alternative garbage collectors, loaded only when configuration asks.
 * The full helper, the parity check's reference, keeps them, so the check covers their removal
 * on every platform too.
 */
const SLIM_PRUNE_NATIVES = ['realm-wrappers', 'e_sqlite3', 'msquic', 'mscordaccore', 'mscordbi', 'clrgc', 'clrgcexp'];

/**
 * Windows keeps a second copy of the debugger's data access library under a versioned name,
 * `mscordaccore_amd64_amd64_10.0.1226.42308.dll`, which the base-name patterns do not reach.
 */
const SLIM_VERSIONED_NATIVES = [/^mscordaccore_[a-z0-9]+_[a-z0-9]+_[0-9.]+\.dll$/i];

/**
 * How the slim helper is trimmed: `partial`, so only .NET's own libraries -- which declare
 * themselves trimmable -- lose what is unused, and osu!'s, Newtonsoft, Realm and the rest stay
 * whole. Full trimming broke inside those (roadmap 5.44). Reflection-based System.Text.Json
 * stays on: the helper's own requests and responses use it, and trimming turns it off by
 * default. The warnings are about the libraries kept whole, which is the point of partial
 * mode; the parity check is the guard, not the warnings.
 */
export const SLIM_PUBLISH_ARGS = [
  '-p:PublishTrimmed=true',
  '-p:TrimMode=partial',
  '-p:JsonSerializerIsReflectionEnabledByDefault=true',
  '-p:SuppressTrimAnalysisWarnings=true',
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
const NATIVE_PATTERNS = PRUNE_NATIVES.map(nativePattern);
const SLIM_PATTERNS = [...SLIM_PRUNE_NATIVES.map(nativePattern), ...SLIM_VERSIONED_NATIVES];

/**
 * Whether a published file is one this helper has no use for: in the full helper, or with
 * `slim` (the default) in the slim one. Exported for the tests.
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
 * Publish into `outDir`, replacing whatever is there, and prune it: the full helper, or with
 * `slim` the slim one, unchecked. What ships is `buildCheckedPpHelper`.
 *
 * Built beside `outDir` and swapped in only once it has succeeded. Deleting `outDir` first
 * meant a build that failed -- an osu! release needing a newer .NET SDK than this machine has
 * -- left no helper at all, and the app then records no pp until someone rebuilds it.
 */
export function buildPpHelper(outDir, target = defaultRid(), { slim = false } = {}) {
  const staging = `${outDir}.building`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    const result = publishAndPrune(staging, target, slim);
    swapIn(staging, outDir);
    return { ...result, slim };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * How this machine can run a `target` helper, as `pp-parity.mjs` flags: none for its own
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
 * The helper that ships: slim if, and only if, it answers every parity request exactly as the
 * full one does on this platform; the full one otherwise, with the reason.
 *
 * Fails safe in every direction. A slim helper that differs, crashes or will not start, or a
 * platform this machine cannot run, ships the full helper, which is what shipped before 5.60,
 * and never stops a build. Only a full helper that will not *build* throws, as it always has.
 * `live` adds this machine's own replays to the check.
 */
export function buildCheckedPpHelper(outDir, target = defaultRid(), { live = false } = {}) {
  const full = `${outDir}.full`;
  const slim = `${outDir}.slim`;
  const clear = () => {
    fs.rmSync(full, { recursive: true, force: true });
    fs.rmSync(slim, { recursive: true, force: true });
  };
  clear();
  try {
    const fullResult = publishAndPrune(full, target, false);
    const runner = runnerFor(target);
    let verdict;
    if (runner === null) {
      verdict = { slim: false, reason: `this machine cannot run a ${target} helper to check a slim one against` };
    } else {
      let slimResult;
      try {
        slimResult = publishAndPrune(slim, target, true);
      } catch (e) {
        slimResult = null;
        verdict = { slim: false, reason: `the slim helper did not build (${e.message})` };
      }
      if (slimResult) {
        console.log(`\n  checking the slim helper (${mb(slimResult.after)}) against the full one (${mb(fullResult.after)})...`);
        const check = spawnSync(
          process.execPath,
          [path.join(root, 'scripts', 'pp-parity.mjs'), full, slim, ...runner, ...(live ? ['--live'] : [])],
          { stdio: 'inherit' },
        );
        verdict =
          check.status === 0
            ? { slim: true, reason: 'identical to the full helper on every parity request' }
            : { slim: false, reason: 'it did not answer every parity request as the full helper does' };
      }
    }
    swapIn(verdict.slim ? slim : full, outDir);
    return {
      ...verdict,
      before: fullResult.before,
      full: fullResult.after,
      after: sizeOf(outDir),
      // The full helper's own pruning, which is what says BASS is gone on this platform.
      removed: fullResult.removed,
    };
  } finally {
    clear();
  }
}

/**
 * Put `staging` where `outDir` is. The old helper is renamed aside first rather than deleted:
 * with the app running, Windows refuses to rename a folder whose files are open, all at once,
 * where deleting it would get half way and leave a helper that cannot start.
 */
function swapIn(staging, outDir) {
  const old = `${outDir}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(outDir)) {
    try {
      renameSettled(outDir, old);
    } catch (e) {
      throw new Error(
        `could not replace ${outDir} (${e.code ?? e.message}). Close the app, which has it open, and build again.`,
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

function publishAndPrune(outDir, target, slim) {
  const result = spawnSync(
    'dotnet',
    [
      'publish', path.join(root, 'tools', 'PpCalculator', 'PpCalculator.csproj'),
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
    fs.rmSync(path.join(outDir, entry.name), { force: true });
    removed++;
  }

  return { before, after: sizeOf(outDir), removed };
}

// Run directly (rather than imported by scripts/package.mjs) to refresh tools/pp.
// pathToFileURL rather than string-building the URL: this project's own path contains a
// space, which has to be percent-encoded to match import.meta.url.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const rid = value('--rid') ?? defaultRid();
  const positional = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--rid');
  const outDir = positional ? path.resolve(positional) : path.join(root, 'tools', 'pp');

  console.log(`\n  publishing the pp helper (${rid}) into ${outDir}\n`);
  let removed;
  if (argv.includes('--full')) {
    const result = buildPpHelper(outDir, rid);
    removed = result.removed;
    console.log(`\n  ${mb(result.before)} -> ${mb(result.after)}, full helper (--full: no slim build, no check)\n`);
  } else {
    const result = buildCheckedPpHelper(outDir, rid, { live: argv.includes('--live') });
    removed = result.removed;
    console.log(
      `\n  ${mb(result.before)} -> ${mb(result.after)}: ${result.slim ? 'slim' : 'full'} helper -- ${result.reason}\n`,
    );
    // CI: a change that breaks the slim helper fails here, rather than quietly shipping full.
    if (argv.includes('--require-slim') && !result.slim) process.exitCode = 1;
  }
  // On a platform whose native library names were never verified, pruning nothing is the
  // failure mode to catch: the helper still works, it is just three times the size and
  // carries BASS, which is not ours to redistribute.
  if (removed === 0) {
    console.log('  WARNING: no native libraries matched. The helper will be much larger than');
    console.log('  it should be, and may contain BASS. Check the names in PRUNE_NATIVES.\n');
  }
}
