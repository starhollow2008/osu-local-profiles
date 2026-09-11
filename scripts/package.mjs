/**
 * Build the portable distribution: a folder the user extracts anywhere and runs.
 *
 *   npm run package
 *
 * The result needs nothing installed -- not Node, not the .NET runtime, not osu!'s SDK.
 * `data/` is created beside the app, so the whole folder can be copied or carried on a
 * stick and it keeps its profiles.
 *
 * The pp helper is published and pruned by scripts/build-pp-helper.mjs, which is shared
 * with `npm run build:pp:local` so the shipped helper and the development one in `tools/pp`
 * are always built the same way.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPpHelper, defaultRid } from './build-pp-helper.mjs';
import { launcherFor, readmeFor } from './package-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const target = process.argv.includes('--rid')
  ? process.argv[process.argv.indexOf('--rid') + 1]
  : defaultRid();

/*
 * A package can only be built on the system it is for.
 *
 * `dotnet publish` will happily cross-compile the pp helper for another runtime, but step 2
 * copies *this* process's Node binary, and there is no cross-platform equivalent of that
 * short of downloading one. Failing here beats shipping a macOS archive containing a
 * Windows node.exe, which would look complete and start on nothing.
 */
const hostOs = defaultRid().split('-')[0];
if (target.split('-')[0] !== hostOs) {
  console.error(`\n  cannot build a ${target} package on ${hostOs}.`);
  console.error('  The .NET helper would cross-compile, but the bundled Node runtime is this');
  console.error(`  machine's own binary. Run this on a ${target.split('-')[0]} machine.\n`);
  process.exit(1);
}

const name = `osu-local-profiles-${pkg.version}-${target}`;
const distRoot = path.join(root, 'dist');
const out = path.join(distRoot, name);

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
const pruned = buildPpHelper(ppOut, target);
console.log(`    ${mb(pruned.before)} -> ${mb(pruned.after)} after pruning
`);

/* ------------------------------------------------------- 2. the Node runtime */

console.log('  copying the Node runtime...');
fs.copyFileSync(process.execPath, path.join(out, path.basename(process.execPath)));

/* ------------------------------------------------------------ 3. the app */

console.log('  copying the app...');
copyDir(path.join(root, 'src'), path.join(out, 'src'));
// The .d.ts files beside the page's modules exist only so the tests can typecheck them.
copyDir(path.join(root, 'web'), path.join(out, 'web'), (src) => !src.endsWith('.d.ts'));

/*
 * The one script a release needs at runtime. A build installs the *next* one by running
 * this file out of the newly downloaded tree, so it has to be in every package or the
 * update after it has nothing to install itself with.
 */
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'scripts', 'apply-update.mjs'),
  path.join(out, 'scripts', 'apply-update.mjs'),
);

/*
 * The one runtime dependency. Everything else in node_modules is types and tooling.
 *
 * Copied without its own node_modules: the LZMA codec declares `@types/node` as a runtime
 * dependency, which put 2.4MB of TypeScript declarations -- 85% of what this copied -- into
 * every release. Its code requires nothing, which the packaged build's own start-up check
 * below proves: osr.ts loads it at startup.
 */
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const from = path.join(root, 'node_modules', dep);
  copyDir(from, path.join(out, 'node_modules', dep), (src) => !src.startsWith(path.join(from, 'node_modules')));
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
      // Kept because the update check reads the repository from here rather than having
      // the address written down a second time in the source.
      repository: pkg.repository,
    },
    null,
    2,
  )}\n`,
);

/* --------------------------------------------------------- 4. the launcher */

/*
 * The launcher and the README are built in scripts/package-files.mjs, as pure functions of
 * the platform. They live there so the macOS and Linux versions can be tested from here --
 * otherwise the only way to see them would be to build on macOS and on Linux, which is
 * exactly the position this project is trying not to be in.
 */
const nodeBinary = path.basename(process.execPath);
const launcher = launcherFor(hostOs, nodeBinary);

fs.writeFileSync(path.join(out, launcher.name), launcher.content);
if (launcher.mode !== null) {
  fs.chmodSync(path.join(out, launcher.name), launcher.mode);
  // copyFileSync keeps the mode of the Node binary it copied, but say so explicitly rather
  // than depend on it: an archive whose runtime is not executable starts on nothing.
  fs.chmodSync(path.join(out, nodeBinary), 0o755);
}

fs.writeFileSync(path.join(out, 'README.txt'), readmeFor(hostOs));

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
  path.join(out, nodeBinary),
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
