import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appVersion, installDir } from '../config.ts';
import { assetFor, compareVersions, fetchLatestRelease, parseRepo, type Release } from './github.ts';
import { extractZip } from './zip.ts';

/**
 * The one-click update.
 *
 * Three things make this safe enough to exist at all, and none of them should be removed:
 *
 * 1. **`data/` is never touched.** It lives *inside* the install (see `config.dataDir`), so
 *    the swap works on the install's other top-level entries and steps around that one.
 *    Everything the user has -- the database, their avatar, their config -- is in there.
 * 2. **Nothing is deleted while it could still be needed.** The files being replaced are
 *    *moved* into `.rollback-<stamp>/`, so a swap that dies half way leaves both halves on
 *    disk instead of a hole. The swap removes that copy once the new build is verified in
 *    place, and `pruneUpdateLeftovers` sweeps anything a failed swap left, at startup.
 * 3. **Nothing is swapped until the new build is verified on disk**: downloaded, unpacked,
 *    and checked to be the version it claimed with the files an install needs.
 *
 * It also refuses to run against a source checkout. `start.bat` runs `node src/main.ts` from
 * the repository, and an "update" there would overwrite someone's working tree with a
 * release zip.
 */

export interface UpdateState {
  currentVersion: string | null;
  latestVersion: string | null;
  available: boolean;
  releaseUrl: string | null;
  /** Why this install cannot apply an update, or null if it can. */
  blocked: string | null;
  /** Last check failure, kept so the page can explain a missing button. */
  error: string | null;
  checkedAt: string | null;
  /** Set while a download or swap is in flight, so a second click cannot start another. */
  applying: boolean;
}

const state: UpdateState = {
  currentVersion: appVersion(),
  latestVersion: null,
  available: false,
  releaseUrl: null,
  blocked: null,
  error: null,
  checkedAt: null,
  applying: false,
};

/** The repository to check, taken from `package.json` rather than written down again. */
export function repoFromPackage(dir = installDir()): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      repository?: { url?: unknown } | string;
    };
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    return parseRepo(url);
  } catch {
    return null;
  }
}

/**
 * Whether this install is one an update can be applied to.
 *
 * A packaged build carries its own Node runtime beside `package.json`; a checkout does not,
 * and has a `.git` instead. Both are checked, because either one alone would be fooled --
 * a checkout with no `.git` (a downloaded source zip) is still not something to overwrite,
 * and a packaged build sitting inside a repository would still be safe to update.
 */
export function blockedReason(
  dir = installDir(),
  platform: string = process.platform,
): string | null {
  if (fs.existsSync(path.join(dir, '.git'))) {
    return 'this copy is running from a source checkout; update it with git instead';
  }

  const runtime = platform === 'win32' ? 'node.exe' : 'node';
  if (!fs.existsSync(path.join(dir, runtime))) {
    return 'this copy is not a packaged build, so there is nothing to replace';
  }

  return null;
}

export function updateState(): UpdateState {
  return { ...state };
}

/**
 * Ask GitHub what the newest release is.
 *
 * Failure is recorded and returned, never thrown at the caller: no network, a private
 * repository and a rate limit are all ordinary here, and none of them is a reason for the
 * page to show an error where a button would go.
 */
export async function checkForUpdate(): Promise<UpdateState> {
  state.currentVersion = appVersion();
  state.blocked = blockedReason();
  state.error = null;

  const repo = repoFromPackage();
  if (repo === null) {
    state.error = 'no GitHub repository is recorded in package.json';
    state.checkedAt = new Date().toISOString();
    return updateState();
  }

  try {
    const release: Release = await fetchLatestRelease(repo);
    state.latestVersion = release.version;
    state.releaseUrl = release.releaseUrl;

    const current = state.currentVersion;
    const newer = current !== null && compareVersions(current, release.version) < 0;
    const asset = assetFor(release, process.platform, process.arch);

    // A newer release with no build for this platform is not an update *here*, and saying
    // so beats a button that downloads nothing.
    if (newer && asset === null) {
      state.available = false;
      state.error = `${release.version} has no build for ${process.platform}-${process.arch}`;
    } else {
      state.available = newer;
    }
  } catch (e) {
    state.error = (e as Error).message;
    state.available = false;
  }

  state.checkedAt = new Date().toISOString();
  return updateState();
}

/** Everything an install needs; a staged tree missing any of it is not one. */
const REQUIRED_ENTRIES = ['package.json', 'src', 'web'];

function verifyStaged(dir: string, expectedVersion: string, platform: string): void {
  for (const entry of REQUIRED_ENTRIES) {
    if (!fs.existsSync(path.join(dir, entry))) {
      throw new Error(`the downloaded build has no ${entry}`);
    }
  }

  const runtime = platform === 'win32' ? 'node.exe' : 'node';
  if (!fs.existsSync(path.join(dir, runtime))) {
    throw new Error(`the downloaded build has no ${runtime}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (pkg.version !== expectedVersion) {
    throw new Error(`the downloaded build says it is ${String(pkg.version)}, not ${expectedVersion}`);
  }
}

export interface ApplyResult {
  version: string;
  stagedDir: string;
}

/**
 * Download the newest release, unpack it, check it, and hand the swap to a detached process.
 *
 * The swap cannot happen in this process: on Windows the running `node.exe` is locked by
 * the very process that would replace it. So the *staged* build's own runtime runs the
 * *staged* build's updater script, waits for this process to exit, and does the work. That
 * also means a release always installs itself with its own updater rather than with
 * whatever the older version happened to ship.
 */
export async function applyUpdate(dataDir: string): Promise<ApplyResult> {
  if (state.applying) throw new Error('an update is already in progress');

  const blocked = blockedReason();
  if (blocked !== null) throw new Error(blocked);

  const repo = repoFromPackage();
  if (repo === null) throw new Error('no GitHub repository is recorded in package.json');

  state.applying = true;
  try {
    const release = await fetchLatestRelease(repo);
    const current = state.currentVersion ?? appVersion();
    if (current === null || compareVersions(current, release.version) >= 0) {
      throw new Error(`already on ${current ?? 'an unknown version'}`);
    }

    const asset = assetFor(release, process.platform, process.arch);
    if (asset === null) {
      throw new Error(`${release.version} has no build for ${process.platform}-${process.arch}`);
    }

    const work = path.join(dataDir, 'update');
    const stagedDir = path.join(work, release.version);
    const archive = path.join(work, asset.name);
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });

    const download = await fetch(asset.url, {
      headers: { 'user-agent': 'osu-local-profiles' },
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!download.ok) throw new Error(`downloading the release failed (${download.status})`);
    const bytes = Buffer.from(await download.arrayBuffer());

    // A truncated download unpacks into a plausible-looking partial tree, so the size is
    // checked before anything is unpacked rather than after.
    if (asset.size > 0 && bytes.length !== asset.size) {
      throw new Error(`the download was ${bytes.length} bytes, expected ${asset.size}`);
    }
    fs.writeFileSync(archive, bytes);

    const written = extractZip(archive, stagedDir, 1);
    if (written < 10) throw new Error(`the archive held only ${written} files`);
    verifyStaged(stagedDir, release.version, process.platform);

    const runtime = path.join(stagedDir, process.platform === 'win32' ? 'node.exe' : 'node');
    const script = path.join(stagedDir, 'scripts', 'apply-update.mjs');
    if (!fs.existsSync(script)) {
      throw new Error(`${release.version} does not know how to install itself (no updater script)`);
    }

    const child = spawn(
      runtime,
      [
        script,
        '--install', installDir(),
        '--staged', stagedDir,
        '--pid', String(process.pid),
        '--archive', archive,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();

    return { version: release.version, stagedDir };
  } finally {
    state.applying = false;
  }
}

/**
 * Delete what an update leaves behind, at startup.
 *
 * Two things accumulate, and both are a whole copy of the app -- around 200MB each:
 *
 * - **`.rollback-*` beside the app.** The swap deletes its own rollback as soon as the new
 *   build is in place, so one only survives to be found here if the swap died before
 *   finishing, or if the *previous* version's updater did not clean up. Either way, this
 *   process starting means the install works, and the copy has nothing left to protect.
 * - **`data/update/`**, where the release was unpacked before being swapped in. The swap
 *   cannot delete this itself: it is *running from it*, and on Windows its own `node.exe`
 *   is locked for as long as it lives. So the app that comes back afterwards does it.
 *
 * Failure is ignored on purpose. A locked file is not worth refusing to start over, and
 * the next launch tries again.
 */
export function pruneUpdateLeftovers(
  dir = installDir(),
  data = path.join(installDir(), 'data'),
): { removed: string[]; bytes: number } {
  const removed: string[] = [];
  let bytes = 0;

  const sizeOf = (target: string): number => {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const full = path.join(target, entry.name);
        total += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
      }
    } catch {
      /* unreadable is fine; this number is only for the log line */
    }
    return total;
  };

  const drop = (target: string, label: string): void => {
    try {
      if (!fs.existsSync(target)) return;
      bytes += sizeOf(target);
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(label);
    } catch {
      /* see above */
    }
  };

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.rollback-')) {
        drop(path.join(dir, entry.name), entry.name);
      }
    }
  } catch {
    /* no install directory to read is not a startup failure */
  }

  // `data/update.log` is a *file* and is deliberately kept: it is the record of what the
  // last update did. Only the `update/` directory beside it goes.
  drop(path.join(data, 'update'), 'data/update');

  return { removed, bytes };
}
