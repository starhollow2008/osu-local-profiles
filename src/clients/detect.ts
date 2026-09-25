import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../config.ts';
import { isMcosuRoot, mcosuSongs, steamLibraries, steamMcosuCandidates } from './mcosu.ts';

export interface OsuInstall {
  kind: 'lazer' | 'stable' | 'mcosu';
  root: string;
  /**
   * Directory to watch for new replays. McOsu writes none, so for McOsu this is the app's own
   * folder of the replays it builds from McOsu's scores.db -- see src/clients/mcosu.ts.
   */
  replayDir: string;
  /** Roots to scan for local .osu beatmap files. */
  beatmapRoots: string[];
  /** lazer's cached beatmap metadata database, if present. */
  onlineDb: string | null;
}

/**
 * Everything about the machine that decides where osu! might be.
 *
 * Passed in rather than read from `process` so the candidate lists can be tested for a
 * platform this machine is not. That matters more here than anywhere else in the project:
 * these paths are the one part that cannot be checked by running the app, because running
 * it proves only that Windows works.
 */
export interface DetectEnvironment {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentEnvironment(): DetectEnvironment {
  // os.homedir() rather than $HOME: it falls back to the OS's own idea of the home
  // directory, so detection still works for a process started without the variable set.
  return { platform: process.platform, home: os.homedir(), env: process.env };
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The drive letters this machine actually has, `C:\` upwards.
 *
 * One `stat` each, and it cannot be wrong about a drive that is mounted -- unlike asking
 * PowerShell, which is right too but costs a second of process startup to say so. A: and B:
 * are skipped: they are floppy letters, and probing one on a machine that still has the
 * controller spins it up.
 */
export function windowsDrives(): string[] {
  const out: string[] = [];
  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) out.push(root);
    } catch {
      /* no such drive */
    }
  }
  return out;
}

/** `$XDG_DATA_HOME`, or the `~/.local/share` the spec says to assume when it is unset. */
function xdgDataHome(e: DetectEnvironment): string {
  const configured = e.env['XDG_DATA_HOME'];
  // The spec says a relative value is invalid and must be ignored, not resolved.
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(e.home, '.local', 'share');
}

/**
 * Where osu!lazer keeps its data, per platform.
 *
 * All three are offered on every platform rather than branching. They cannot collide -- no
 * machine has two of them -- and a layout that does not fit its platform is exactly the
 * case worth catching: a home directory shared between a dual boot, or an app run somewhere
 * unusual. Each is a single `access()` away from being ruled out.
 */
export function lazerCandidates(e: DetectEnvironment): string[] {
  const out: string[] = [];
  if (e.env['APPDATA']) out.push(path.join(e.env['APPDATA'], 'osu'));
  out.push(path.join(e.home, 'Library', 'Application Support', 'osu'));
  out.push(path.join(xdgDataHome(e), 'osu'));
  return out;
}

/**
 * Folders people put games in, below a drive root.
 *
 * `''` is the drive root itself, which is where osu!'s own installer offers to go. The rest
 * are the conventions: a `Games` folder on the big disk is the single most common place a
 * player who moved osu! off C: put it, and it is nested -- `D:\Games\osu!\osu!` -- because
 * the installer makes its own folder inside whatever you pick.
 */
const WINDOWS_GAME_DIRS = [
  '',
  'Games',
  'Game',
  'games',
  'Program Files',
  'Program Files (x86)',
  'Apps',
  'Programs',
  'SteamLibrary',
];

/** The names an osu!stable folder is given, under one of those. */
const STABLE_FOLDERS = ['osu!', 'osu', 'osu!stable', 'osustable', 'osu!/osu!', 'osu!/osu'];

/**
 * Where a native Windows osu!stable install lives.
 *
 * Every drive that exists rather than C, D and E: a player with four disks puts games on the
 * one with room, and `F:` is not exotic. Each entry is still one `access()`, and the whole
 * list is a few hundred of them -- microseconds, once, at startup.
 *
 * `drives` is injected so the list stays a pure function of the environment and can be
 * pinned by a test on a machine that has no D: drive.
 */
export function windowsStableCandidates(
  e: DetectEnvironment,
  drives: readonly string[] = ['C:\\', 'D:\\', 'E:\\'],
): string[] {
  const out: string[] = [];
  if (e.env['LOCALAPPDATA']) out.push(path.join(e.env['LOCALAPPDATA'], 'osu!'));
  if (e.env['PROGRAMFILES']) out.push(path.join(e.env['PROGRAMFILES'], 'osu!'));
  out.push(path.join(e.home, 'osu!'));
  for (const drive of drives) {
    for (const parent of WINDOWS_GAME_DIRS) {
      for (const folder of STABLE_FOLDERS) {
        out.push(path.join(drive, parent, ...folder.split('/')));
      }
    }
  }
  return out;
}

/**
 * osu!stable under Wine, which is the only way it runs on macOS and Linux.
 *
 * There is no single answer here, because there is no official build -- people run one of
 * a handful of community wrappers, each with its own layout. These are the fixed paths;
 * the ones that have to be discovered by reading a file or a directory are in
 * `wineStableRoots`.
 *
 * A missing Wine prefix is the normal case, not an error: most machines have none.
 */
export function wineStableCandidates(e: DetectEnvironment): string[] {
  const out: string[] = [];

  // macOS: the Wineskin wrappers people actually use. The prefix sits *beside* Contents in
  // the bundle rather than inside it, which is a Wineskin convention and looks wrong.
  for (const apps of ['/Applications', path.join(e.home, 'Applications')]) {
    for (const app of ['osu!.app', 'osu.app']) {
      out.push(path.join(apps, app, 'drive_c', 'osu!'));
      out.push(path.join(apps, app, 'drive_c', 'Program Files', 'osu!'));
      out.push(path.join(apps, app, 'Contents', 'SharedSupport', 'prefix', 'drive_c', 'osu!'));
    }
  }

  // A plain `wine` prefix, wherever WINEPREFIX points, or the default one.
  const prefixes = [e.env['WINEPREFIX'], path.join(e.home, '.wine')].filter(
    (p): p is string => Boolean(p),
  );
  // osu-winello's own prefix. Its D: drive is the install, handled in wineStableRoots.
  prefixes.push(path.join(xdgDataHome(e), 'wineprefixes', 'osu-wineprefix'));

  for (const prefix of prefixes) {
    out.push(path.join(prefix, 'drive_c', 'osu!'));
    out.push(path.join(prefix, 'drive_c', 'Program Files', 'osu!'));
    out.push(path.join(prefix, 'drive_c', 'Program Files (x86)', 'osu!'));
  }

  return out;
}

/**
 * Wine locations that have to be looked up rather than guessed.
 *
 * Worth the extra work because each of these is *exact* where a guess would not be:
 *
 * - **osu-winello**, which is how most Linux players run stable, writes the install
 *   directory it was given into a one-line file, and symlinks it as the prefix's D: drive.
 *   The user chooses that directory, so there is nothing to guess -- but there is something
 *   to read.
 * - **Wine's per-user directory** is named after the account, and **CrossOver bottles** are
 *   named by the user, so both are found by listing rather than by assuming a name.
 *
 * Every step is best effort. Nothing here existing is the normal case.
 */
export function wineStableRoots(e: DetectEnvironment): string[] {
  const out: string[] = [];
  const data = xdgDataHome(e);

  // osu-winello records the path it installed to; this is the authoritative answer.
  try {
    const recorded = fs.readFileSync(path.join(data, 'osuconfig', 'osupath'), 'utf8').trim();
    if (recorded) out.push(recorded);
  } catch {
    /* not installed that way */
  }

  // ...and links it as D: in its prefix, which survives the file being lost.
  try {
    out.push(
      fs.realpathSync(path.join(data, 'wineprefixes', 'osu-wineprefix', 'dosdevices', 'd:')),
    );
  } catch {
    /* no prefix, or no D: drive yet */
  }

  // Wine puts a Windows-style profile under the account's own name.
  const prefixes = [e.env['WINEPREFIX'], path.join(e.home, '.wine')].filter(
    (p): p is string => Boolean(p),
  );
  for (const prefix of prefixes) {
    const users = path.join(prefix, 'drive_c', 'users');
    let names: string[];
    try {
      names = fs.readdirSync(users);
    } catch {
      continue;
    }
    for (const name of names) {
      out.push(path.join(users, name, 'AppData', 'Local', 'osu!'));
    }
  }

  // CrossOver keeps one prefix per bottle, named by whoever made it.
  const bottles = path.join(e.home, 'Library', 'Application Support', 'CrossOver', 'Bottles');
  let names: string[];
  try {
    names = fs.readdirSync(bottles);
  } catch {
    names = [];
  }
  for (const name of names) {
    out.push(path.join(bottles, name, 'drive_c', 'osu!'));
    out.push(path.join(bottles, name, 'drive_c', 'Program Files', 'osu!'));
  }

  return out;
}

/** A lazer install, if that is what is at `root`. */
export function lazerInstall(root: string): OsuInstall | null {
  // client.realm is the reliable marker: `files/` alone can exist for other reasons.
  if (!exists(path.join(root, 'client.realm'))) return null;
  const files = path.join(root, 'files');
  if (!exists(files)) return null;
  const onlineDb = path.join(root, 'online.db');
  return {
    kind: 'lazer',
    root,
    // lazer writes replays into its content-addressed store, same as every other file.
    replayDir: files,
    beatmapRoots: [files],
    onlineDb: exists(onlineDb) ? onlineDb : null,
  };
}

/**
 * Where a stable install keeps its beatmaps.
 *
 * stable lets the player move the Songs folder -- usually onto another drive -- and writes
 * the answer to `BeatmapDirectory` in its per-user config (`osu!.<windows user>.cfg`, the
 * same file the signed-in username comes from). It is read rather than guessed at: on a
 * moved install `<root>/Songs` holds nothing, so every stable play would resolve to no
 * beatmap, and therefore no title, no stars and no pp.
 *
 * The value is usually the bare name `Songs`; anything relative resolves against the
 * install. A setting that points nowhere falls back, because a stale config should not cost
 * the player their beatmaps.
 */
function stableSongs(root: string): string {
  const fallback = path.join(root, 'Songs');

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root).filter((name) => /^osu!\..+\.cfg$/i.test(name));
  } catch {
    return fallback;
  }

  for (const entry of entries) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(root, entry), 'utf8');
    } catch {
      continue;
    }
    const value = /^[ \t]*BeatmapDirectory[ \t]*=[ \t]*(.+?)[ \t]*$/im.exec(contents)?.[1];
    if (!value) continue;
    const resolved = path.isAbsolute(value) ? value : path.join(root, value);
    if (exists(resolved)) return resolved;
  }
  return fallback;
}

/**
 * A stable install, if that is what is at `root`.
 *
 * `osu!.exe` alone is not enough, because **lazer's executable is also called `osu!.exe`**.
 * That never mattered while detection only looked in places lazer's program files are not,
 * and it matters a great deal now that a search can walk into `%LOCALAPPDATA%\osulazer\app-*`
 * -- which would be classified as a stable install with no beatmaps, no replays and no
 * scores, and would then be the answer, because the first hit of each kind wins.
 *
 * Two shapes have to be turned away, and both are real on this machine:
 *
 * - `osulazer\current\` -- the actual lazer program files, where the .NET runtime files
 *   beside the executable are the tell. stable is one self-contained Windows binary and
 *   ships none of them.
 * - `osulazer\` itself -- lazer's updater keeps a *stub* `osu!.exe` next to `Update.exe`,
 *   which is nothing but a launcher for the real one. `Update.exe` names it exactly.
 *
 * Neither could be reached while detection only looked in a fixed list of places lazer's
 * program files are not. Both are reached the moment a search walks `%LOCALAPPDATA%`, and
 * either would have been accepted as a stable install with no beatmaps, no replays and no
 * scores -- and then *been* the answer, because the first hit of each kind wins.
 */
const NOT_STABLE = [
  'osu.Game.dll',
  'osu!.deps.json',
  'osu!.runtimeconfig.json',
  'Update.exe',
  'sq.version',
];

export function stableInstall(root: string): OsuInstall | null {
  if (!exists(path.join(root, 'osu!.exe'))) return null;
  for (const marker of NOT_STABLE) {
    if (exists(path.join(root, marker))) return null;
  }
  const songs = stableSongs(root);
  return {
    kind: 'stable',
    root,
    replayDir: path.join(root, 'Data', 'r'),
    beatmapRoots: exists(songs) ? [songs] : [],
    onlineDb: null,
  };
}

/**
 * Where Steam itself might be. Steam's own folder lists every other library it has in
 * `libraryfolders.vdf`, so finding Steam finds McOsu on whichever disk it was installed to.
 * A bare `SteamLibrary` at a drive root is the folder Steam suggests for a second library,
 * and is looked in directly in case Steam's own folder is somewhere this list does not reach.
 */
export function steamRoots(e: DetectEnvironment, drives: readonly string[] = ['C:\\', 'D:\\', 'E:\\']): string[] {
  const out: string[] = [];
  if (e.platform === 'win32') {
    const x86 = e.env['PROGRAMFILES(X86)'] ?? e.env['ProgramFiles(x86)'];
    if (x86) out.push(path.join(x86, 'Steam'));
    if (e.env['PROGRAMFILES']) out.push(path.join(e.env['PROGRAMFILES'], 'Steam'));
    for (const drive of drives) {
      out.push(path.join(drive, 'Steam'), path.join(drive, 'SteamLibrary'));
    }
  }
  out.push(path.join(e.home, '.steam', 'steam'), path.join(xdgDataHome(e), 'Steam'));
  return out;
}

/**
 * Where McOsu might be: its Steam folder in every Steam library. Cheap enough -- a few
 * `access()` calls and one small file -- to ask on every launch, which matters: a player who
 * has both osu! clients never has the rest of detection look further, and would otherwise
 * never have McOsu found at all. A copy from outside Steam is found by the drive search or
 * added from the page.
 */
export function mcosuCandidates(e: DetectEnvironment, drives?: readonly string[]): string[] {
  return steamMcosuCandidates(steamLibraries(steamRoots(e, drives)));
}

/**
 * A McOsu install, if that is what is at `root`.
 *
 * Its beatmaps are wherever its `osu_folder` points, which is normally the osu!stable
 * install, and its "replays" are the ones this app builds for its plays, under `data/`.
 */
export function mcosuInstall(root: string, builtReplays = path.join(dataDir(), 'mcosu')): OsuInstall | null {
  if (!isMcosuRoot(root)) return null;
  const songs = mcosuSongs(root);
  return {
    kind: 'mcosu',
    root,
    replayDir: builtReplays,
    beatmapRoots: songs ? [songs] : [],
    onlineDb: null,
  };
}

/**
 * Find the osu! installations on this machine.
 *
 * `configured` comes from `installRoots` in config.json and is tried first, which is what
 * makes that setting the escape hatch it is documented as: auto-detection covers the
 * layouts that could be anticipated, and on macOS and Linux there is no official osu!stable
 * build to anticipate. A configured root is classified by what is actually inside it, so
 * the user does not also have to say which client it is.
 */
export function detectInstalls(
  configured: readonly string[] = [],
  e: DetectEnvironment = currentEnvironment(),
): OsuInstall[] {
  return installsFrom(candidateRoots(configured, e), e);
}

/**
 * Every place worth one `access()`, in the order to try it.
 *
 * Exported so the search can be told what has already been looked at, and so a test can
 * assert the *order*, which is the part that carries meaning: a configured root beats a
 * guessed one, and on Windows the whole list is checked before any of it is walked.
 */
export function candidateRoots(
  configured: readonly string[] = [],
  e: DetectEnvironment = currentEnvironment(),
): string[] {
  const drives = e.platform === 'win32' ? windowsDrives() : [];
  return [
    ...configured,
    ...lazerCandidates(e),
    ...windowsStableCandidates(e, drives.length > 0 ? drives : undefined),
    ...wineStableCandidates(e),
    ...wineStableRoots(e),
    ...mcosuCandidates(e, drives.length > 0 ? drives : undefined),
  ];
}

/**
 * Classify a list of directories and keep the first of each kind.
 *
 * First rather than best, because the caller has already put them in order -- and because
 * ranking them would mean stat-ing every candidate on the list instead of stopping at the
 * one that matched. Where a *ranking* is wanted, as after a search of the whole disk, that
 * is `installScore` in `discover.ts`, applied to the handful the search actually found.
 */
export function installsFrom(
  roots: readonly string[],
  _e: DetectEnvironment = currentEnvironment(),
): OsuInstall[] {
  const found: OsuInstall[] = [];
  let lazer: OsuInstall | null = null;
  let stable: OsuInstall | null = null;
  let mcosu: OsuInstall | null = null;

  for (const root of roots) {
    if (!lazer) lazer = lazerInstall(root);
    if (!stable) stable = stableInstall(root);
    if (!mcosu) mcosu = mcosuInstall(root);
    if (lazer && stable && mcosu) break;
  }
  if (lazer) found.push(lazer);
  if (stable) found.push(stable);
  if (mcosu) found.push(mcosu);
  return found;
}
