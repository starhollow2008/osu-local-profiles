import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  currentEnvironment,
  candidateRoots,
  lazerCandidates,
  lazerInstall,
  stableInstall,
  windowsDrives,
  type DetectEnvironment,
  type OsuInstall,
} from './detect.ts';

const run = promisify(execFile);

/**
 * Finding osu! when it is not where anyone would have guessed.
 *
 * `detect.ts` holds the places osu! *usually* is: one list per platform, a pure function of
 * the environment, checked with a single `access()` each. That covers a default install and
 * nothing else, which is how the app came to report "no osu!stable" to somebody who was
 * looking at `D:\Games\osu!\osu!` in Explorer while reading it.
 *
 * This module is the rest of the answer, in three tiers, cheapest first:
 *
 * 1. **What the machine already knows.** osu!stable registers its file associations, and
 *    lazer writes the data directory it was moved to into `storage.ini`. Both are exact, and
 *    both cost one file read or one `reg query`. A path found this way needs no searching.
 * 2. **Shortcuts.** Almost every install has a Start Menu entry, and a `.lnk` stores the
 *    target path.
 * 3. **A bounded walk of every drive.** The last resort, and the only one that can find a
 *    folder nothing on the system points at. Depth-, count- and time-capped, skipping the
 *    directories that are enormous by nature (`Songs`, lazer's `files`, `Windows`), so it
 *    ends in seconds rather than crawling a 4TB disk.
 *
 * Tier 3 runs only when the first two came up short, and its answer is remembered in
 * `config.json`, so the usual launch does no searching at all.
 */

/* ------------------------------------------------------- lazer's storage.ini */

/**
 * lazer's data directory, when the player has moved it.
 *
 * osu!lazer can be pointed at another disk, and when it is, the *default* directory keeps a
 * one-line `storage.ini` naming where everything actually went. Read rather than guessed:
 * the target is wherever the player clicked, and nothing else records it.
 *
 * Written by osu-framework's config manager, which uses `key = value` lines. A section
 * header is tolerated because an INI file may grow one and ignoring it costs nothing.
 */
export function storageIniPath(contents: string): string | null {
  const value = /^[ \t]*FullPath[ \t]*=[ \t]*(.+?)[ \t]*$/im.exec(contents)?.[1];
  return value && value.length > 0 ? value : null;
}

/** Every directory a lazer candidate's `storage.ini` redirects to. */
export function lazerRedirects(e: DetectEnvironment = currentEnvironment()): string[] {
  const out: string[] = [];
  for (const root of lazerCandidates(e)) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(root, 'storage.ini'), 'utf8');
    } catch {
      continue;
    }
    const target = storageIniPath(contents);
    if (target) out.push(target);
  }
  return out;
}

/* ------------------------------------------------------------- the registry */

/**
 * The registry keys that name an osu! executable or install directory.
 *
 * osu!stable is not an MSI install and has no canonical `InstallLocation` -- but it does
 * claim `.osz`, `.osr` and `.osk`, and a file association stores the full command line. That
 * is the same path, written by osu! itself, on the machine where it is true.
 *
 * Both hives are asked because stable installs per-user while an administrator install
 * writes the machine-wide one. Kept as data so the parsing can be tested without a registry.
 */
export function registryQueries(): string[] {
  const out: string[] = [];
  for (const progId of ['osu!', 'osu', 'osustable.File.osz', 'osustable.File.osr', 'osu!osz']) {
    out.push(`HKCU\\Software\\Classes\\${progId}`);
    out.push(`HKCR\\${progId}`);
  }
  for (const hive of ['HKCU', 'HKLM']) {
    out.push(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osu!`);
    out.push(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osulazer`);
  }
  return out;
}

/**
 * Pull Windows paths out of `reg query` output.
 *
 * The values are command lines, icon references and install locations, so a path may be
 * quoted, may be followed by `"%1"` or `,0`, and may have neither. Matching the path itself
 * rather than parsing each shape keeps one rule for all of them.
 */
export function registryPaths(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    // `    (Default)    REG_SZ    "D:\Games\osu!\osu!\osu!.exe" "%1"`
    const value = /\s(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)$/.exec(line)?.[1];
    if (!value) continue;
    let matched = false;
    for (const match of value.matchAll(/[A-Za-z]:\\[^"*?<>|\r\n]*?\.exe/g)) {
      out.push(match[0]);
      matched = true;
    }
    if (matched) continue;
    // InstallLocation, and anything else that is a bare directory.
    const bare = value.trim().replace(/^"(.*)"$/, '$1');
    if (/^[A-Za-z]:\\/.test(bare)) out.push(bare);
  }
  return out;
}

/** Ask the registry where osu! is. Windows only; anything unexpected means "no answer". */
export async function registryRoots(
  e: DetectEnvironment = currentEnvironment(),
): Promise<string[]> {
  if (e.platform !== 'win32') return [];
  const outputs = await Promise.all(
    registryQueries().map(async (key) => {
      try {
        // The whole subtree, because one query then covers (Default), DefaultIcon,
        // InstallLocation and DisplayIcon rather than four.
        const { stdout } = await run('reg', ['query', key, '/s'], { timeout: 5000 });
        return stdout;
      } catch {
        // A key that does not exist exits non-zero. That is the normal case here.
        return '';
      }
    }),
  );
  const out: string[] = [];
  for (const stdout of outputs) out.push(...registryPaths(stdout));
  return out;
}

/* ---------------------------------------------------------------- shortcuts */

/**
 * The osu! executables a `.lnk` points at.
 *
 * A shortcut's target lives in its `LinkInfo` block as a plain string -- twice over on a
 * modern one, ANSI and UTF-16 -- and again inside the item ID list. Rather than implement
 * the shell link format to reach a path that is sitting there in plain sight, both decodings
 * of the file are searched for something shaped like a path to `osu!.exe`.
 *
 * Blunt, and exactly right for the job: a false positive is a directory that then fails
 * `stableInstall`, and there is nothing to gain from being precise about a format whose only
 * interesting field is a string.
 */
export function lnkTargets(buf: Buffer): string[] {
  const out = new Set<string>();
  const pattern = /[A-Za-z]:\\[^\u0000-\u001f"*?<>|]{0,240}?osu!\.exe/gi;
  for (const encoding of ['latin1', 'utf16le'] as const) {
    for (const match of buf.toString(encoding).matchAll(pattern)) out.add(match[0]);
  }
  return [...out];
}

/** Where Windows keeps shortcuts a player might have to osu!. */
export function shortcutDirs(e: DetectEnvironment): string[] {
  if (e.platform !== 'win32') return [];
  const out: string[] = [];
  const appData = e.env['APPDATA'];
  const programData = e.env['ProgramData'];
  if (appData) {
    const ie = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch');
    out.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    out.push(ie);
    out.push(path.join(ie, 'User Pinned', 'TaskBar'));
  }
  if (programData) {
    out.push(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  out.push(path.join(e.home, 'Desktop'));
  out.push(path.join(e.home, 'OneDrive', 'Desktop'));
  return out;
}

/**
 * Install directories named by a shortcut on this machine. Best effort throughout.
 *
 * One level of subdirectory is included, because that is where the Start Menu keeps almost
 * everything: an installer makes `Programs\osu!\` and puts the shortcut inside it. Only
 * directories and files whose name mentions osu! are opened, so a Start Menu of three
 * hundred entries costs three hundred string comparisons and two file reads.
 */
export function shortcutRoots(e: DetectEnvironment = currentEnvironment()): string[] {
  const out: string[] = [];
  const read = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  for (const dir of shortcutDirs(e)) {
    const dirs = [dir];
    for (const entry of read(dir)) {
      if (entry.isDirectory() && /osu|game/i.test(entry.name)) dirs.push(path.join(dir, entry.name));
    }
    for (const sub of dirs) {
      for (const entry of read(sub)) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue;
        if (!/osu/i.test(entry.name)) continue;
        let buf: Buffer;
        try {
          buf = fs.readFileSync(path.join(sub, entry.name));
        } catch {
          continue;
        }
        for (const target of lnkTargets(buf)) out.push(path.dirname(target));
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- the search */

/**
 * Directories never worth descending into.
 *
 * Two kinds:
 *
 * - **Nothing is installed there**: `Windows`, `$Recycle.Bin`, package caches, `node_modules`.
 * - **Directories that are enormous by nature.** A `Songs` folder is thousands of
 *   directories of beatmaps, and lazer's `files` store is ~4,000 two-letter directories.
 *   Both can be *moved out* of the install they belong to, which is the only reason they
 *   need naming here -- inside one, the walk has already stopped at the install itself.
 *
 * The list is deliberately short. Every name on it is a directory an osu! install is never
 * *under*, and a name that is merely common -- `Data`, `Games`, `Apps` -- stays off it,
 * because the whole point of this search is the folder nobody predicted. Matched
 * case-insensitively on the directory's own name, not its path: these names mean the same
 * thing wherever they appear.
 */
const SKIP_DIRS = new Set(
  [
    'Songs',
    'files',
    'Windows',
    'WindowsApps',
    'WinSxS',
    '$Recycle.Bin',
    '$RECYCLE.BIN',
    'System Volume Information',
    'Recovery',
    'PerfLogs',
    'Package Cache',
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    'site-packages',
    'Temp',
    'Cache',
    'Caches',
    'CrashDumps',
    'OneDrive',
    'Microsoft',
    'NVIDIA Corporation',
    'proc',
    'sys',
    'dev',
    'snap',
    '.cache',
  ].map((name) => name.toLowerCase()),
);

/** Whether the search walks into a directory of this name. */
export function skipDir(name: string): boolean {
  if (SKIP_DIRS.has(name.toLowerCase())) return true;
  // Windows reparse junctions ("Application Data", "My Documents") and Unix dotfiles: the
  // former loop, the latter hold no game installs.
  return name.startsWith('$') || (name.startsWith('.') && name !== '.minecraft');
}

/**
 * Whether this directory's entries say an osu! install is *here*.
 *
 * Decided from names the walk already has, so recognising an install costs no extra syscall.
 * Classification is still left to `detect.ts` -- this only says "stop and look properly".
 */
export function looksLikeInstall(names: readonly string[]): boolean {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  return lower.has('osu!.exe') || lower.has('client.realm');
}

export interface ScanLimits {
  /** How far below each starting point to walk. `D:\Games\osu!\osu!` is three. */
  maxDepth: number;
  /** Directories listed before giving up, across the whole search. */
  maxDirs: number;
  /** Wall-clock ceiling in milliseconds. */
  timeBudgetMs: number;
}

export const DEFAULT_LIMITS: ScanLimits = { maxDepth: 5, maxDirs: 30_000, timeBudgetMs: 25_000 };

export interface ScanProgress {
  /** Directories listed so far. */
  dirs: number;
  /** Where the walk is now, for a page that wants to say something while it waits. */
  current: string;
  /** Install roots found so far. */
  found: string[];
}

/**
 * Everywhere the fallback search starts, per platform.
 *
 * Every drive on Windows, because the whole point is a folder nobody predicted. A network
 * drive is slow to answer rather than impossible, and the walk's time budget -- not a drive
 * type check -- is what keeps that from mattering.
 */
export function scanRoots(e: DetectEnvironment = currentEnvironment()): string[] {
  if (e.platform === 'win32') return windowsDrives();
  const out = [e.home];
  for (const mount of ['/Volumes', '/mnt', '/media', '/run/media', '/opt', '/games', '/srv']) {
    try {
      if (fs.statSync(mount).isDirectory()) out.push(mount);
    } catch {
      /* not on this system */
    }
  }
  return out;
}

/**
 * Walk for osu! installs, breadth-first, within the limits.
 *
 * Breadth-first on purpose: an install is far more often three levels down than eight, so
 * the shallow answer arrives long before the budget runs out, and a search that is cut short
 * has still looked everywhere *near* the top of every drive rather than exhausting one
 * branch of one of them.
 *
 * Every error is swallowed. Half this walk is directories the user cannot read, and a
 * permission error on `C:\Config.Msi` is not something to report -- it is Tuesday.
 */
export async function scanForInstalls(
  roots: readonly string[],
  limits: ScanLimits = DEFAULT_LIMITS,
  onProgress?: (progress: ScanProgress) => void,
): Promise<string[]> {
  const deadline = Date.now() + limits.timeBudgetMs;
  const found: string[] = [];
  const seen = new Set<string>();
  let dirs = 0;

  let queue: { dir: string; depth: number }[] = [];
  for (const root of roots) queue.push({ dir: root, depth: 0 });

  while (queue.length > 0) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of queue) {
      if (dirs >= limits.maxDirs || Date.now() > deadline) return found;

      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirs++;
      if (onProgress && dirs % 200 === 0) onProgress({ dirs, current: dir, found: [...found] });

      if (looksLikeInstall(entries.map((entry) => entry.name))) {
        found.push(dir);
        // An install never contains another one, and its subdirectories are the expensive
        // ones. Stopping here is both correct and most of the speed.
        continue;
      }

      if (depth >= limits.maxDepth) continue;
      for (const entry of entries) {
        // Symlinks are not followed: a link back up the tree turns this into a loop, and
        // `isDirectory()` is false for one, so this is the whole guard.
        if (!entry.isDirectory() || skipDir(entry.name)) continue;
        next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  if (onProgress) onProgress({ dirs, current: '', found: [...found] });
  return found;
}

/* ------------------------------------------------------------- putting it together */

/**
 * How promising a candidate root is, highest first.
 *
 * Needed because a search of a whole disk finds *every* copy: the screenshot that prompted
 * this had an `osu!` folder holding `osu!`, `osu versions`, `stablebackup`, `osuprac` and a
 * dozen practice installs beside each other. They are all real osu! folders. Only one of
 * them is the one being played, and the one being played is the one with a database, a
 * config and recent activity.
 *
 * A guess, deliberately -- which is why every candidate is still offered on the page.
 */
export function installScore(root: string): number {
  let score = 0;
  const stat = (name: string): fs.Stats | null => {
    try {
      return fs.statSync(path.join(root, name));
    } catch {
      return null;
    }
  };
  // A database means beatmaps have been loaded; a per-user config means somebody signed in.
  if (stat('osu!.db')) score += 40;
  if (stat('scores.db')) score += 20;
  if (stat('client.realm')) score += 40;
  if (stat('Songs')) score += 10;
  if (stat('Data')) score += 10;
  try {
    if (fs.readdirSync(root).some((name) => /^osu!\..+\.cfg$/i.test(name))) score += 20;
  } catch {
    /* unreadable: it scores what it scores */
  }
  // Recency breaks the tie between two installs that both look real. Capped so it can never
  // outweigh having a database at all.
  const marker = stat('osu!.db') ?? stat('client.realm') ?? stat('osu!.exe');
  if (marker) {
    const days = (Date.now() - marker.mtimeMs) / 86_400_000;
    score += Math.max(0, 30 - days);
  }
  // A backup or an old build says so in its name.
  if (/backup|old|copy|versions?$/i.test(path.basename(root))) score -= 25;
  return score;
}

/**
 * Every root worth trying, in the order to try it, without touching the filesystem to find
 * more. This is what runs on a normal launch.
 *
 * `configured` first, then roots remembered from an earlier search, then the exact answers
 * the machine already holds, then the guesses. Ordering is the whole design: the first hit
 * of each kind wins, so anything the user or the system stated outranks a guess.
 */
export async function targetedRoots(
  configured: readonly string[],
  remembered: readonly string[],
  e: DetectEnvironment = currentEnvironment(),
): Promise<string[]> {
  return [
    ...configured,
    ...remembered,
    ...lazerRedirects(e),
    ...(await registryRoots(e)),
    ...shortcutRoots(e),
    ...candidateRoots([], e),
  ];
}

/** A directory that holds an osu! install, with enough about it to choose between several. */
export interface InstallCandidate {
  root: string;
  kind: 'lazer' | 'stable';
  /** How likely this is the install being played. See `installScore`. */
  score: number;
  /** How it was found, so the page can say "you chose this" rather than "we guessed". */
  source: 'configured' | 'remembered' | 'detected' | 'searched';
}

export interface DiscoveryResult {
  /** The installs to actually use: the best lazer and the best stable, where each exists. */
  installs: OsuInstall[];
  /** Everything found, best first. More than two means the user has a choice to make. */
  candidates: InstallCandidate[];
  /** Whether tier 3 ran, and so whether "not found" means "searched for and not found". */
  searched: boolean;
}

/** Classify a directory, without the caller having to say which client it expected. */
export function classify(root: string): OsuInstall | null {
  return lazerInstall(root) ?? stableInstall(root);
}

function rank(roots: readonly string[], source: InstallCandidate['source']): InstallCandidate[] {
  const out: InstallCandidate[] = [];
  for (const root of roots) {
    const install = classify(root);
    if (install) out.push({ root: install.root, kind: install.kind, score: installScore(root), source });
  }
  return out;
}

export interface DiscoverOptions {
  /** `installRoots` from config.json: what the user said, and it is never overruled. */
  configured?: readonly string[];
  /** Roots a previous search found, so the next launch does not repeat it. */
  remembered?: readonly string[];
  /** Search even when both clients were already found. */
  force?: boolean;
  /** Never search, whatever is missing. Used where a long startup is worse than a miss. */
  noSearch?: boolean;
  limits?: ScanLimits;
  onProgress?: (progress: ScanProgress) => void;
  env?: DetectEnvironment;
}

/**
 * Find osu!, properly.
 *
 * The rule for whether to search is the one thing here worth arguing about. Searching only
 * when *nothing at all* was found would not have helped the person this was written for:
 * they had lazer in its default place and stable on another disk, so the app found one
 * client, considered the job done, and told them their stable install did not exist. So the
 * search runs when **either** client is missing.
 *
 * What stops that from costing every launch a disk walk is that the result is remembered,
 * including a search that found nothing: a machine with genuinely no osu!stable searches
 * once, writes down that it did, and never does it again unless asked. `force` is that
 * asking -- the Rescan button on the page.
 */
export async function discoverInstalls(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const e = opts.env ?? currentEnvironment();
  const force = opts.force === true;

  const candidates: InstallCandidate[] = [];
  const known = new Set<string>();
  const add = (roots: readonly string[], source: InstallCandidate['source']): void => {
    for (const root of roots) {
      const key = root.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      candidates.push(...rank([root], source));
    }
  };
  const missing = (): boolean =>
    !candidates.some((c) => c.kind === 'lazer') || !candidates.some((c) => c.kind === 'stable');

  /*
   * Each tier runs only if the one before it left a client unaccounted for, so the launch
   * that finds both clients where they are supposed to be does no process spawning and no
   * walking -- it is a few dozen `access()` calls and it is done. `force` is the Rescan
   * button, which asks every tier regardless so the page can show everything on the machine.
   */
  add(opts.configured ?? [], 'configured');
  add(opts.remembered ?? [], 'remembered');
  if (force || missing()) add(candidateRoots([], e), 'detected');
  if (force || missing()) {
    add(lazerRedirects(e), 'detected');
    add(await registryRoots(e), 'detected');
    add(shortcutRoots(e), 'detected');
  }

  const searched = !opts.noSearch && (force || missing());
  if (searched) {
    add(await scanForInstalls(scanRoots(e), opts.limits, opts.onProgress), 'searched');
  }

  /*
   * Ordering: what the user chose, then what scored best.
   *
   * A configured root outranks a higher-scoring one it beat on nothing else, because the
   * user typed it in and that settles it. Below that it is `installScore`, which is what
   * separates the install someone plays from the four backups sitting beside it.
   */
  const bySource = { configured: 0, remembered: 1, detected: 2, searched: 2 };
  candidates.sort((a, b) => bySource[a.source] - bySource[b.source] || b.score - a.score);

  const installs: OsuInstall[] = [];
  for (const kind of ['lazer', 'stable'] as const) {
    const best = candidates.find((c) => c.kind === kind);
    if (!best) continue;
    const install = classify(best.root);
    if (install) installs.push(install);
  }

  return { installs, candidates, searched };
}
