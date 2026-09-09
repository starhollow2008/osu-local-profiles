/**
 * Build the portable distribution: a folder the user extracts anywhere and runs.
 *
 *   npm run package
 *
 * The result needs nothing installed -- not Node, not the .NET runtime, not osu!'s SDK.
 * `data/` is created beside the app, so the whole folder can be copied or carried on a
 * stick and it keeps its profiles.
 *
 * Most of the work here is *removing* things. osu!'s NuGet packages carry the whole game:
 * fonts, textures, audio samples, ffmpeg, SDL, a shader compiler and native binaries for
 * Android, iOS, Linux and macOS. Dropping what a pp calculator cannot use takes the helper
 * from 273MB to about 114MB.
 *
 * What can go is narrower than it looks. osu.Framework's `Logger` static constructor drags
 * in nearly the whole *managed* graph -- NUnit, OpenTabletDriver, Sentry, the lot -- so
 * removing any managed assembly kills the helper at startup. What is safe is the things
 * loaded lazily: the resources assembly, localisation satellites, and native libraries
 * reached through P/Invoke only when something actually plays audio or opens a window.
 *
 * Each entry below was verified against a build with no fallback available. That detail
 * matters: `src/calc/official.ts` prefers `tools/pp` but falls back to the plain build
 * output, so an early attempt at this list "passed" the pp tests while shipping a helper
 * that could not start at all.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const target = process.argv.includes('--rid')
  ? process.argv[process.argv.indexOf('--rid') + 1]
  : 'win-x64';
const name = `osu-fresh-profile-${pkg.version}-${target}`;
const distRoot = path.join(root, 'dist');
const out = path.join(distRoot, name);

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (filter && !filter(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else fs.copyFileSync(src, dst);
  }
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)}MB`;

console.log(`\n  packaging ${name}\n`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* ------------------------------------------------- 1. the pp helper (.NET) */

console.log('  building the pp calculator (self-contained)...');
const ppOut = path.join(out, 'tools', 'pp');
run('dotnet', [
  'publish', path.join(root, 'tools', 'PpCalculator', 'PpCalculator.csproj'),
  '-c', 'Release', '-r', target, '--self-contained', 'true',
  '-o', ppOut, '--nologo', '-v', 'q',
]);

const before = sizeOf(ppOut);
// Localisation satellite assemblies: one directory per language.
for (const entry of fs.readdirSync(ppOut, { withFileTypes: true })) {
  if (entry.isDirectory()) fs.rmSync(path.join(ppOut, entry.name), { recursive: true, force: true });
}
for (const file of PRUNE_FILES) fs.rmSync(path.join(ppOut, file), { force: true });
console.log(`    ${mb(before)} -> ${mb(sizeOf(ppOut))} after pruning\n`);

/* ------------------------------------------------------- 2. the Node runtime */

console.log('  copying the Node runtime...');
fs.copyFileSync(process.execPath, path.join(out, path.basename(process.execPath)));

/* ------------------------------------------------------------ 3. the app */

console.log('  copying the app...');
copyDir(path.join(root, 'src'), path.join(out, 'src'));
copyDir(path.join(root, 'web'), path.join(out, 'web'));

// The one runtime dependency. Everything else in node_modules is types and tooling.
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  copyDir(path.join(root, 'node_modules', dep), path.join(out, 'node_modules', dep));
}

// A trimmed manifest: the packaged app never builds, tests or typechecks itself.
fs.writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      description: pkg.description,
      type: pkg.type,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  )}\n`,
);

/* --------------------------------------------------------- 4. the launcher */

// `cd /d "%~dp0"` is the important line: double-clicking from Explorer starts the process
// in whatever directory Explorer feels like, and without it the app would look for its
// data somewhere else entirely.
fs.writeFileSync(
  path.join(out, 'Start osu! fresh profile.bat'),
  [
    '@echo off',
    'cd /d "%~dp0"',
    'title osu! fresh profile',
    'node.exe src\\main.ts',
    'if errorlevel 1 (',
    '  echo.',
    '  echo The app stopped with an error. The message above says why.',
    '  pause',
    ')',
    '',
  ].join('\r\n'),
);

fs.writeFileSync(
  path.join(out, 'README.txt'),
  [
    'osu! fresh profile',
    '==================',
    '',
    'Double-click "Start osu! fresh profile.bat".',
    'Your browser opens at http://localhost:7272 and tracking begins.',
    '',
    'Play osu! -- lazer or stable, online or offline -- and scores appear as you set them.',
    'Closing the console window stops tracking.',
    '',
    'Nothing needs installing. Node and osu!\'s pp calculator are both included.',
    '',
    'Everything this app records lives in the "data" folder next to this file, so you can',
    'move or copy the whole folder and your profiles come with it. Deleting "data" resets',
    'the app to a clean slate.',
    '',
    'The first run takes about a minute while it indexes your local beatmaps.',
    'Later runs start immediately.',
    '',
    'Settings are in data/config.json (profile name, port, country, tagline).',
    '',
  ].join('\r\n'),
);

/* -------------------------------------------------------- 5. verify it works */

/*
 * Start the packaged app from an unrelated working directory and confirm it both serves
 * and found its pp calculator.
 *
 * This exists because the first build of this package looked perfectly fine and silently
 * recorded no pp: the helper's path was resolved from `process.cwd()`, which is wherever
 * Explorer happens to start a double-clicked process. A packaged build that tracks scores
 * without pp is worse than one that fails outright, so it is checked here rather than
 * left for a user to discover.
 */
console.log('\n  verifying the packaged build...');
const probe = spawnSync(
  path.join(out, 'node.exe'),
  [path.join(out, 'src', 'main.ts'), '--check-only'],
  { cwd: path.parse(out).root, encoding: 'utf8', timeout: 240_000 },
);

const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
if (probe.error) throw probe.error;
if (!output.includes("pp: osu!'s official calculator")) {
  console.error(output.split('\n').slice(-15).join('\n'));
  throw new Error(
    'the packaged build could not find its pp calculator -- it would track scores with no pp',
  );
}
console.log('    starts from any directory, and finds its pp calculator');

// The check created a config and an empty database. Ship a clean folder: the first real
// run should build `data/` itself, so the user starts genuinely fresh.
fs.rmSync(path.join(out, 'data'), { recursive: true, force: true });

/* ---------------------------------------------------------------- 6. done */

const total = sizeOf(out);
console.log(`\n  ${path.relative(root, out)}  (${mb(total)})`);
for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
  const p = path.join(out, entry.name);
  const size = entry.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  console.log(`    ${mb(size).padStart(6)}  ${entry.name}${entry.isDirectory() ? '/' : ''}`);
}
/* ------------------------------------------------------------ 7. the zip */

const zip = `${out}.zip`;
fs.rmSync(zip, { force: true });

// No zip library: Node has no built-in archiver, and this is the one place a platform
// tool is simpler than a dependency. The folder is the deliverable either way.
const zipped =
  process.platform === 'win32'
    ? spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${out}' -DestinationPath '${zip}' -Force`,
      ])
    : spawnSync('zip', ['-qr', zip, path.basename(out)], { cwd: distRoot });

if (zipped.status === 0 && fs.existsSync(zip)) {
  console.log(`\n  ${path.relative(root, zip)}  (${mb(fs.statSync(zip).size)} to download)`);
} else {
  console.log('\n  could not create the zip -- ship the folder itself, it is complete');
}
