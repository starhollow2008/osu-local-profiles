import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HelperCandidate } from './official.ts';
import { helperRid, prunedFromFullHelper } from './helper-prune.ts';

/**
 * The pp helper, built against the player's own osu! source rather than osu!'s released
 * packages (roadmap 5.70).
 *
 * Someone running osu! from source may have changed how pp is calculated, or written a mod of
 * their own. The bundled helper knows neither: it prices with the last osu! release, and a mod
 * it has never heard of is osu!'s UnknownMod. So this builds the same helper -- this app's own
 * `tools/PpCalculator/Program.cs`, unchanged -- with its osu! packages swapped for the projects
 * in the player's clone, which is what ppy's osu-tools does with its UseLocalOsu script. The pp
 * it gives is exactly what that source would give.
 *
 * It replaces the bundled helper for the whole app, never beside it and never as a fallback
 * for it: a profile priced by two formulas has a total and a rank that compare nothing with
 * nothing. See src/pp-source.ts for switching, and CLAUDE.md, "pp: official .NET helper only".
 *
 * Built into `data/pp-source/`, which an update never touches. Each build is named by the
 * source's version, so a rebuild never has to overwrite a helper the app is running.
 *
 * Pruned as the shipped helper is (src/calc/helper-prune.ts), and for this machine's platform
 * alone: unpruned, a build carries every platform's natives and the game's own fonts and sounds,
 * 649MB where about 60 will do, and the intermediate copy `dotnet` leaves beside it doubled that.
 */

/** The osu! projects the helper is built against, by where a clone of ppy/osu keeps them. */
export const SOURCE_PROJECTS = [
  'osu.Game/osu.Game.csproj',
  'osu.Game.Rulesets.Osu/osu.Game.Rulesets.Osu.csproj',
  'osu.Game.Rulesets.Taiko/osu.Game.Rulesets.Taiko.csproj',
  'osu.Game.Rulesets.Catch/osu.Game.Rulesets.Catch.csproj',
  'osu.Game.Rulesets.Mania/osu.Game.Rulesets.Mania.csproj',
] as const;

/** Long enough for a first build of osu.Game on a slow machine, which restores packages too. */
const BUILD_TIMEOUT_MS = 30 * 60_000;

/**
 * Why a folder is not an osu! source this can build from, or null when it is. The data folder
 * a development build writes to (`%APPDATA%\osu-development`) is the likeliest mistake, and is
 * named as such: it holds settings and replays, not code.
 */
export function checkOsuSource(dir: string): string | null {
  if (dir.trim() === '' || !fs.existsSync(dir)) return 'that folder does not exist';
  const missing = SOURCE_PROJECTS.filter((p) => !fs.existsSync(path.join(dir, p)));
  if (missing.length === 0) return null;
  if (fs.existsSync(path.join(dir, 'files')) || fs.existsSync(path.join(dir, 'game.dev.ini'))) {
    return "that is where osu! keeps its data, not its source: choose the folder you cloned ppy/osu into, the one with osu.Game in it";
  }
  return `that is not a clone of ppy/osu: it has no ${missing[0]}`;
}

/** The same folder, however it was written. Windows paths are case-insensitive. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function git(dir: string, args: string[]): Buffer {
  const run = spawnSync('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw new Error('git is needed to tell one version of your osu! source from another, and it was not found');
  if (run.status !== 0) {
    throw new Error(`git could not read that folder: ${run.stderr.toString().trim().split('\n')[0] ?? 'unknown error'}`);
  }
  return run.stdout;
}

/**
 * What the source is, as every pp it prices will be labelled: `source <commit>`, and
 * `+<hash of the local changes>` when the working tree differs from that commit.
 *
 * The hash is what makes an edit count. A player changing the pp formula without committing
 * still has the same commit, and the label has to change with the formula, or scores priced by
 * the old one would look current. So it covers every change git can see -- staged, unstaged,
 * and new files it is not told to ignore -- and two builds of the same edit get the same label.
 */
export function sourceVersion(dir: string): string {
  const commit = git(dir, ['rev-parse', '--short=7', 'HEAD']).toString().trim();
  const status = git(dir, ['status', '--porcelain', '--untracked-files=all']).toString().trim();
  if (status === '') return `source ${commit}`;

  const hash = crypto.createHash('sha256');
  hash.update(git(dir, ['diff', 'HEAD', '--binary']));
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean).sort();
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(fs.readFileSync(path.join(dir, file)));
    } catch {
      /* gone since git listed it */
    }
  }
  return `source ${commit}+${hash.digest('hex').slice(0, 7)}`;
}

/** The project file: the bundled helper's, with osu!'s packages swapped for the clone's projects. */
export function projectXml(source: string): string {
  const refs = SOURCE_PROJECTS.map(
    (p) => `    <ProjectReference Include="${escapeXml(path.resolve(source, p))}" />`,
  ).join('\n');
  return `<Project Sdk="Microsoft.NET.Sdk">
  <!-- Generated by osu! local profiles (src/calc/source-helper.ts). Rebuilt on every build. -->
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>osu-pp</AssemblyName>
    <RootNamespace>OsuLocalProfiles.PpCalculator</RootNamespace>
    <InvariantGlobalization>true</InvariantGlobalization>
    <NuGetAudit>false</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
${refs}
  </ItemGroup>
</Project>
`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A helper built from source, as `data/pp-source/helper.json` records it. */
export interface SourceHelper {
  /** What its pp is labelled: see `sourceVersion`. */
  version: string;
  /** The osu! source folder it was built from. */
  source: string;
  /** Where it was published to. */
  dir: string;
  builtAt: number;
}

const rootOf = (dataDir: string) => path.join(dataDir, 'pp-source');

/** The helper last built, or null when there is none, or its files have gone. */
export function readSourceHelper(dataDir: string): SourceHelper | null {
  try {
    const helper = JSON.parse(fs.readFileSync(path.join(rootOf(dataDir), 'helper.json'), 'utf8')) as SourceHelper;
    if (typeof helper.version !== 'string' || typeof helper.dir !== 'string') return null;
    return fs.existsSync(path.join(helper.dir, 'osu-pp.dll')) ? helper : null;
  } catch {
    return null;
  }
}

/** How to start it. Framework-dependent: whoever builds osu! from source has .NET installed. */
export function sourceCandidate(helper: SourceHelper): HelperCandidate {
  return { command: 'dotnet', args: [path.join(helper.dir, 'osu-pp.dll')] };
}

export interface BuildOptions {
  source: string;
  dataDir: string;
  /** This app's `tools/PpCalculator/Program.cs`: the helper is the same code either way. */
  program: string;
  /** Each line `dotnet` prints, for the page to show how far it has got. */
  onOutput?: (line: string) => void;
}

/**
 * Build the helper from `source` and record it as the one to use. Throws with a message worth
 * showing -- the end of the compiler's own output when the build itself failed, since that is
 * where a player who broke their own source will want to look.
 */
export async function buildSourceHelper({ source, dataDir, program, onOutput }: BuildOptions): Promise<SourceHelper> {
  const problem = checkOsuSource(source);
  if (problem) throw new Error(problem);
  const version = sourceVersion(source);

  const root = rootOf(dataDir);
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'PpCalculator.csproj'), projectXml(source));
  fs.copyFileSync(program, path.join(project, 'Program.cs'));

  const name = version.replace(/^source /, '').replace(/[^\w.-]/g, '-');
  const staging = path.join(root, `building-${Date.now()}`);
  const tail: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      'dotnet',
      [
        'publish', path.join(project, 'PpCalculator.csproj'), '-c', 'Release',
        // This machine's natives only, and no runtime: whoever builds osu! has .NET.
        '-r', helperRid(), '--self-contained', 'false',
        '-o', staging, '--nologo', '-v', 'minimal',
      ],
      // From the clone, so the SDK its global.json asks for is the one that builds it.
      { cwd: source, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the build took more than 30 minutes, and was stopped'));
    }, BUILD_TIMEOUT_MS);
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim() === '') continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onOutput?.(line);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('building needs the .NET 10 SDK, and `dotnet` was not found'));
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });

  // The intermediate copy `dotnet` builds before publishing: the whole helper again, unpruned.
  // `obj` stays, small, so the next build restores and builds only what changed.
  fs.rmSync(path.join(project, 'bin'), { recursive: true, force: true });

  if (code !== 0 || !fs.existsSync(path.join(staging, 'osu-pp.dll'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    const errors = tail.filter((l) => /error/i.test(l));
    throw new Error(`the build failed:\n${(errors.length > 0 ? errors : tail).slice(-8).join('\n')}`);
  }

  prune(staging);

  // Named by version. A helper of the same name is only rebuilt when it is not the one running
  // (see src/pp-source.ts), so it can be replaced; one that cannot be is left, and this is kept
  // under its staging name instead.
  let dir = path.join(root, name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch {
    dir = staging;
  }
  const helper: SourceHelper = { version, source: path.resolve(source), dir, builtAt: Date.now() };
  fs.writeFileSync(path.join(root, 'helper.json'), `${JSON.stringify(helper, null, 2)}\n`);
  sweep(root, [dir]);
  return helper;
}

/**
 * Remove what the helper never uses: what the shipped helper does without, debug symbols, and
 * the localisation folders (one per language) that come with osu!'s resources. Walked rather
 * than listed, so a name this has never seen on a platform is simply kept.
 */
export function prune(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) fs.rmSync(file, { recursive: true, force: true });
    else if (prunedFromFullHelper(entry.name) || entry.name.endsWith('.pdb')) fs.rmSync(file, { force: true });
  }
}

/**
 * Remove the builds nothing points at any more. Best effort: one still running (the helper
 * this build is about to replace) is locked on Windows and simply stays until next time.
 */
export function sweep(root: string, keep: readonly string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'project') continue;
    const dir = path.join(root, e.name);
    if (keep.some((k) => sameFolder(k, dir))) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use */
    }
  }
}
