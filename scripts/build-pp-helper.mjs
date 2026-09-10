/**
 * Publish the self-contained osu! pp helper into a directory, pruned to what a pp
 * calculator actually needs.
 *
 *   node scripts/build-pp-helper.mjs [outDir] [--rid win-x64]
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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * `[lib]<name>[-1.2][.dll|.dylib|.so][.3]`, anchored at both ends.
 *
 * Anchoring is what keeps `ppy.ManagedBass.dll` and `osu.Framework.dll` safe: a substring
 * test would take both. The two version slots cover where each platform puts it --
 * `avcodec-58.dll`, `libavcodec.58.dylib`, `libavcodec.so.58`, `libSDL2-2.0.so.0`.
 */
const NATIVE_PATTERNS = PRUNE_NATIVES.map(
  (name) =>
    new RegExp(
      `^(lib)?${escape(name)}([-.][0-9][0-9.]*)?\\.(dll|dylib|so)(\\.[0-9][0-9.]*)?$`,
      'i',
    ),
);

/** Whether a published file is one this helper has no use for. Exported for the tests. */
export function shouldPrune(filename) {
  if (PRUNE_ASSEMBLIES.includes(filename)) return true;
  return NATIVE_PATTERNS.some((pattern) => pattern.test(filename));
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
 * die: Realm (osu!'s model types are Realm objects), System.Private.Xml and
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

/** Publish into `outDir`, replacing whatever is there, and prune it. */
export function buildPpHelper(outDir, target = defaultRid()) {
  fs.rmSync(outDir, { recursive: true, force: true });

  const result = spawnSync(
    'dotnet',
    [
      'publish', path.join(root, 'tools', 'PpCalculator', 'PpCalculator.csproj'),
      '-c', 'Release', '-r', target, '--self-contained', 'true',
      '-o', outDir, '--nologo', '-v', 'q',
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
    if (!shouldPrune(entry.name)) continue;
    fs.rmSync(path.join(outDir, entry.name), { force: true });
    removed++;
  }

  return { before, after: sizeOf(outDir), removed };
}

// Run directly (rather than imported by scripts/package.mjs) to refresh tools/pp.
// pathToFileURL rather than string-building the URL: this project's own path contains a
// space, which has to be percent-encoded to match import.meta.url.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rid = process.argv.includes('--rid')
    ? process.argv[process.argv.indexOf('--rid') + 1]
    : defaultRid();
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== rid);
  const outDir = positional ? path.resolve(positional) : path.join(root, 'tools', 'pp');

  console.log(`\n  publishing the pp helper (${rid}) into ${outDir}\n`);
  const { before, after, removed } = buildPpHelper(outDir, rid);
  console.log(`\n  ${mb(before)} -> ${mb(after)}, ${removed} native file(s) pruned\n`);
  // On a platform whose native library names were never verified, pruning nothing is the
  // failure mode to catch: the helper still works, it is just three times the size and
  // carries BASS, which is not ours to redistribute.
  if (removed === 0) {
    console.log('  WARNING: no native libraries matched. The helper will be much larger than');
    console.log('  it should be, and may contain BASS. Check the names in PRUNE_NATIVES.\n');
  }
}
