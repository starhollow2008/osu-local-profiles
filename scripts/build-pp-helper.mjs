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

/** Assemblies and natives the calculator never touches. See the note above. */
const PRUNE_FILES = [
  // Fonts, textures and audio samples: 125MB, and the single biggest win.
  'osu.Game.Resources.dll',

  /*
   * Native audio. BASS is un4seen's commercial library -- free for non-commercial use but
   * not freely redistributable -- and this app never plays a sound, so shipping it would be
   * both pointless and awkward. Note the *managed* wrapper `ppy.ManagedBass` must stay:
   * osu.Framework references it directly, and the helper will not start without it.
   */
  'bass.dll', 'bass_fx.dll', 'bassmix.dll', 'basswasapi.dll',

  // Native video decoding: nothing here ever plays a beatmap background.
  'avcodec-58.dll', 'avformat-58.dll', 'avutil-56.dll', 'swscale-5.dll', 'swresample-3.dll',

  // Native windowing, image loading and shader compilation: no window is ever opened.
  'SDL2.dll', 'SDL3.dll', 'libveldrid-spirv.dll', 'stbi.dll',

  // Native debug symbol reader.
  'Microsoft.DiaSymReader.Native.amd64.dll', 'Microsoft.DiaSymReader.Native.x86.dll',
];

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
export function buildPpHelper(outDir, target = 'win-x64') {
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
  // Localisation satellite assemblies: one directory per language.
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(outDir, entry.name), { recursive: true, force: true });
  }
  for (const file of PRUNE_FILES) fs.rmSync(path.join(outDir, file), { force: true });

  return { before, after: sizeOf(outDir) };
}

// Run directly (rather than imported by scripts/package.mjs) to refresh tools/pp.
// pathToFileURL rather than string-building the URL: this project's own path contains a
// space, which has to be percent-encoded to match import.meta.url.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rid = process.argv.includes('--rid')
    ? process.argv[process.argv.indexOf('--rid') + 1]
    : 'win-x64';
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== rid);
  const outDir = positional ? path.resolve(positional) : path.join(root, 'tools', 'pp');

  console.log(`\n  publishing the pp helper (${rid}) into ${outDir}\n`);
  const { before, after } = buildPpHelper(outDir, rid);
  console.log(`\n  ${mb(before)} -> ${mb(after)} after pruning\n`);
}
