import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OsuInstall {
  kind: 'lazer' | 'stable';
  root: string;
  /** Directory to watch for new replays. */
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

/** Where a native Windows osu!stable install lives. */
function windowsStableCandidates(e: DetectEnvironment): string[] {
  const out: string[] = [];
  if (e.env['LOCALAPPDATA']) out.push(path.join(e.env['LOCALAPPDATA'], 'osu!'));
  for (const drive of ['C:/', 'D:/', 'E:/']) {
    out.push(path.join(drive, 'osu!'));
    out.push(path.join(drive, 'Program Files', 'osu!'));
    out.push(path.join(drive, 'Program Files (x86)', 'osu!'));
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

/** A stable install, if that is what is at `root`. */
export function stableInstall(root: string): OsuInstall | null {
  if (!exists(path.join(root, 'osu!.exe'))) return null;
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
  const found: OsuInstall[] = [];

  const lazerRoots = [...configured, ...lazerCandidates(e)];
  for (const root of lazerRoots) {
    const install = lazerInstall(root);
    if (install) {
      found.push(install);
      break;
    }
  }

  const stableRoots = [
    ...configured,
    ...windowsStableCandidates(e),
    ...wineStableCandidates(e),
    ...wineStableRoots(e),
  ];
  for (const root of stableRoots) {
    const install = stableInstall(root);
    if (install) {
      found.push(install);
      break;
    }
  }

  return found;
}
