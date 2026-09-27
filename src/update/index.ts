import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { appVersion, dataDir as defaultDataDir, installDir } from '../config.ts';
import { assetFor, compareVersions, fetchLatestRelease, fetchRecentReleases, parseRepo, type Release } from './github.ts';
import { extractZip } from './zip.ts';
import { CHANGELOG_URL, notesBetween, notesFromBody, nudgeFor, type VersionNotes } from './notes.ts';

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
 *
 * Since 5.66 a build can also be downloaded ahead of time -- by Auto-update, or by "When I
 * quit" -- and wait, checked, in `data/update/<version>`, to be installed when the app is quit
 * or next starts. (5.66 also published each release in parts, to download only what changed;
 * 5.69 took that out at the user's request, since it crowded every release page.)
 */

/**
 * How the macOS and Linux launchers start the app again after an update.
 *
 * They run the app as a child instead of `exec`-ing it, with `LAUNCHER_ENV` set. The app then
 * exits with `RESTART_EXIT_CODE` once the swap is handed off, and the launcher waits for the
 * swapper -- its pid is in `data/update/<SWAPPER_PID_FILE>` -- and runs itself again, in the
 * same terminal, where Ctrl+C and closing the window still stop the app.
 *
 * Before this the swapper started the app itself, and on those platforms a process it starts
 * has no terminal: the app came back running, invisible, and with nothing to stop it. The
 * other half is written in `scripts/package-files.mjs`; `test/relaunch.test.ts` pins that
 * the two agree.
 */
export const LAUNCHER_ENV = 'OSU_LOCAL_PROFILES_LAUNCHER';
export const RESTART_EXIT_CODE = 75;
export const SWAPPER_PID_FILE = 'swapper.pid';

/**
 * Whether this process was started by a launcher that will start it again after an update:
 * the tray launcher (`tray`), or the terminal loop `start.sh` falls back to (`restarts`).
 */
export function launcherRestarts(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LAUNCHER_ENV] === 'restarts' || env[LAUNCHER_ENV] === 'tray';
}

/**
 * Whether the tray launcher started this process (tools/launcher). It then has no console:
 * its output goes to `data/logs/app.log`, and it stops when the launcher closes its stdin.
 */
export function launchedFromTray(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LAUNCHER_ENV] === 'tray';
}

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
  /** What is new: each version after this one up to the newest, newest first. */
  notes: VersionNotes[];
  changelogUrl: string;
  /** How loudly to say an update is waiting (`nudgeFor`); the page decides whether to show it. */
  nudge: 'important' | 'behind' | null;
  /** A newer build downloaded and checked, waiting in `data/update/` to be installed. */
  ready: string | null;
  /** That build installs when the app is quit, or next starts: asked for, or Auto-update. */
  installOnQuit: boolean;
  /** Downloading one ahead of time, in the background. */
  preparing: boolean;
  /** Why the last download ahead of time failed. */
  prepareError: string | null;
  /** What the last download cost, in bytes, once there has been one. */
  downloadedBytes: number | null;
  /** The tray launcher's word on the connection: metered, or not; null when nobody has said. */
  metered: boolean | null;
  /** Options -> Auto-update. */
  autoUpdate: boolean;
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
  notes: [],
  changelogUrl: CHANGELOG_URL,
  nudge: null,
  ready: null,
  installOnQuit: false,
  preparing: false,
  prepareError: null,
  downloadedBytes: null,
  metered: null,
  autoUpdate: false,
};

/** What the update needs from config.json, read on every use so a change applies at once. */
interface UpdateSettings {
  autoUpdate: () => boolean;
  checking: () => boolean;
}

let settings: UpdateSettings = { autoUpdate: () => false, checking: () => true };
let dataRoot = defaultDataDir();

export function configureUpdates(next: Partial<UpdateSettings> & { dataDir?: string }): void {
  settings = { ...settings, ...next };
  if (next.dataDir !== undefined) dataRoot = next.dataDir;
  refreshReady();
}

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
  return { ...state, autoUpdate: settings.autoUpdate(), notes: [...state.notes] };
}

/**
 * The version to offer, or null: newer, built for this platform, and an install that can take
 * it. What the tray launcher reads from `/api/app`, so the page and the icon agree.
 */
export function offeredVersion(s: UpdateState = state): string | null {
  return s.available && s.blocked === null ? s.latestVersion : null;
}

/*
 * Who hears when anything here changes: the page's live feed, and the console. `found` is set
 * once per version, so a daily check that finds the same release again announces nothing.
 */
type UpdateListener = (s: UpdateState, found: boolean) => void;
const listeners = new Set<UpdateListener>();
let announced: string | null = null;

export function onUpdateChange(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  const version = offeredVersion();
  const found = version !== null && version !== announced;
  if (found) announced = version;
  const s = updateState();
  for (const listener of listeners) listener(s, found);
}

/* ------------------------------------------------------------ patch notes */

/** Each newest version's notes, fetched once rather than on every daily check. */
let notesCache: { version: string; notes: VersionNotes[] } | null = null;

/**
 * What every version since this one changed, from each release page's own lines (5.69: the
 * `-notes.json` asset of 5.66 is gone, with the rest of the update files). One request for the
 * recent releases, made only when a new version is found. Should it fail, the newest
 * release's own page, which the daily check already has, still says what that one changed.
 */
async function releaseNotesFor(repo: string, release: Release): Promise<VersionNotes[]> {
  if (notesCache?.version === release.version) return notesCache.notes;
  let releases: Release[] = [release];
  try {
    releases = await fetchRecentReleases(repo);
  } catch {
    /* the newest alone, below */
  }
  const notes = releases.flatMap((r) => notesFromBody(r.body, r.version, r.publishedAt));
  notesCache = { version: release.version, notes };
  return notes;
}

const changelogUrlFor = (repo: string): string => `https://github.com/${repo}/blob/main/CHANGELOG.md`;

/* ------------------------------------------------------------------ check */

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
    changed();
    return updateState();
  }
  state.changelogUrl = changelogUrlFor(repo);

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

    state.notes = state.available ? notesBetween(await releaseNotesFor(repo, release), current, release.version) : [];
    state.nudge = nudgeFor(state.notes, Date.now());
  } catch (e) {
    state.error = (e as Error).message;
    state.available = false;
  }

  state.checkedAt = new Date().toISOString();
  refreshReady();
  changed();
  maybePrepare();
  return updateState();
}

/**
 * How often a running app asks GitHub again: once a day, and an hour after a check that
 * failed, since an app started at login often starts before the network is up.
 *
 * Checked against the wall clock rather than by one long timer, because a timer does not
 * count time the computer spent asleep: a PC that sleeps every night might never reach 24
 * hours of awake time, and those left open for weeks are exactly who this is for.
 */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const RETRY_FAILED_MS = 60 * 60_000;
const LOOK_EVERY_MS = 10 * 60_000;

export function checkDue(s: Pick<UpdateState, 'checkedAt' | 'error'>, now: number): boolean {
  if (s.checkedAt === null) return true;
  const last = Date.parse(s.checkedAt);
  // A clock set backwards would otherwise hold the next check off for however far it moved.
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= (s.error === null ? CHECK_EVERY_MS : RETRY_FAILED_MS);
}

/**
 * Check now, and again whenever one is due, for as long as the app runs. Returns a stop.
 *
 * One request a day to GitHub's releases API; its unauthenticated limit is 60 an hour. The
 * reason there is no polling loop (docs/reference-links.md) is osu!'s API guidance, which
 * covers osu!, not this. Nothing is asked while `checkForUpdates` is off.
 */
export function keepCheckingForUpdates(check: () => Promise<unknown> = checkForUpdate): () => void {
  let inFlight = false;
  const look = () => {
    if (inFlight || state.applying || !settings.checking() || !checkDue(state, Date.now())) return;
    inFlight = true;
    void check().finally(() => {
      inFlight = false;
    });
  };
  look();
  const timer = setInterval(look, LOOK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/* -------------------------------------------------------------- downloads */

/**
 * One file from a release, whole, in memory. `size` (0: unknown) is checked before anything
 * is unpacked: a truncated download unpacks into a plausible-looking partial tree.
 */
async function download(url: string, size: number, timeoutMs: number, maxBytes = Infinity): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'osu-local-profiles' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`downloading ${path.basename(new URL(url).pathname)} failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (size > 0 && bytes.length !== size) throw new Error(`the download was ${bytes.length} bytes, expected ${size}`);
  if (bytes.length > maxBytes) throw new Error('the download was far larger than it should be');
  return bytes;
}

/** What each platform's package opens (scripts/package-files.mjs, `trayLauncherFor`). */
function launcherNameFor(platform: string): string {
  if (platform === 'win32') return 'osu! local profiles.exe';
  if (platform === 'darwin') return 'osu! local profiles.app';
  return 'osu-local-profiles';
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

  // What starts the app again once the swap is done (scripts/apply-update.mjs, launcherName).
  const launcher = launcherNameFor(platform);
  if (!fs.existsSync(path.join(dir, launcher))) {
    throw new Error(`the downloaded build has no ${launcher}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (pkg.version !== expectedVersion) {
    throw new Error(`the downloaded build says it is ${String(pkg.version)}, not ${expectedVersion}`);
  }
}

/** The release from its one full zip. */
async function stageFromZip(release: Release, stagedDir: string, work: string): Promise<number> {
  const asset = assetFor(release, process.platform, process.arch);
  if (asset === null) {
    throw new Error(`${release.version} has no build for ${process.platform}-${process.arch}`);
  }
  const bytes = await download(asset.url, asset.size, 30 * 60_000);
  const archive = path.join(work, asset.name);
  fs.writeFileSync(archive, bytes);
  try {
    const written = extractZip(archive, stagedDir, 1);
    if (written < 10) throw new Error(`the archive held only ${written} files`);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  return bytes.length;
}

/** Download, unpack and check a release into `data/update/<version>`. */
async function stage(release: Release, data: string): Promise<string> {
  const work = path.join(data, 'update');
  const stagedDir = path.join(work, release.version);
  fs.mkdirSync(work, { recursive: true });

  fs.rmSync(stagedDir, { recursive: true, force: true });
  const bytes = await stageFromZip(release, stagedDir, work);
  verifyStaged(stagedDir, release.version, process.platform);
  state.downloadedBytes = bytes;
  console.log(`  update: ${release.version} downloaded (${(bytes / 1024 / 1024).toFixed(1)}MB) and checked`);
  return stagedDir;
}

/* ------------------------------------------------ a build waiting to install */

const READY_FILE = 'ready.json';

interface ReadyRecord {
  version: string;
  /** Downloaded by Auto-update, or because someone pressed "When I quit". */
  requested: 'auto' | 'user';
  /** Installs started from it. One that did not take is not tried again. */
  attempts: number;
}

function readReady(data = dataRoot): ReadyRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(data, 'update', READY_FILE), 'utf8')) as Partial<ReadyRecord>;
    if (typeof r.version !== 'string') return null;
    return {
      version: r.version,
      requested: r.requested === 'user' ? 'user' : 'auto',
      attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    };
  } catch {
    return null;
  }
}

function writeReady(record: ReadyRecord, data = dataRoot): void {
  fs.writeFileSync(path.join(data, 'update', READY_FILE), `${JSON.stringify(record)}\n`);
}

function dropReady(data = dataRoot): void {
  const ready = readReady(data);
  fs.rmSync(path.join(data, 'update', READY_FILE), { force: true });
  if (ready !== null) fs.rmSync(path.join(data, 'update', ready.version), { recursive: true, force: true });
}

/** The waiting build, if it is newer than this one and still on disk. */
function usableReady(data = dataRoot): ReadyRecord | null {
  const ready = readReady(data);
  const current = appVersion();
  if (ready === null || current === null || compareVersions(current, ready.version) >= 0) return null;
  if (!fs.existsSync(path.join(data, 'update', ready.version, 'package.json'))) return null;
  return ready;
}

function refreshReady(): void {
  const ready = usableReady();
  state.ready = ready?.version ?? null;
  state.installOnQuit = ready !== null && (ready.requested === 'user' || settings.autoUpdate());
}

let preparing: Promise<void> | null = null;
let failedPrepare: { version: string | null; at: number } | null = null;

/**
 * Download the newest release ahead of time, to be installed when the app is quit or next
 * starts. `user` is "When I quit" in the update dialog; `auto` is Auto-update. Errors are
 * kept in `prepareError` for the page, and thrown for a caller that waits.
 */
export function prepareUpdate(requested: 'auto' | 'user'): Promise<void> {
  if (preparing !== null) {
    // Already downloading: someone asking for it outranks Auto-update having started it.
    return preparing.then(() => {
      const ready = readReady();
      if (requested === 'user' && ready !== null && ready.requested !== 'user') {
        writeReady({ ...ready, requested: 'user' });
        refreshReady();
        changed();
      }
    });
  }

  preparing = (async () => {
    state.preparing = true;
    state.prepareError = null;
    changed();
    try {
      const blocked = blockedReason();
      if (blocked !== null) throw new Error(blocked);
      const repo = repoFromPackage();
      if (repo === null) throw new Error('no GitHub repository is recorded in package.json');

      const release = await fetchLatestRelease(repo);
      const current = appVersion();
      if (current === null || compareVersions(current, release.version) >= 0) {
        throw new Error(`already on ${current ?? 'an unknown version'}`);
      }

      const ready = usableReady();
      if (ready?.version !== release.version) {
        dropReady();
        await stage(release, dataRoot);
      }
      writeReady({
        version: release.version,
        requested: requested === 'user' || ready?.requested === 'user' ? 'user' : 'auto',
        attempts: 0,
      });
      failedPrepare = null;
    } catch (e) {
      state.prepareError = (e as Error).message;
      failedPrepare = { version: state.latestVersion, at: Date.now() };
      throw e;
    } finally {
      state.preparing = false;
      preparing = null;
      refreshReady();
      changed();
    }
  })();
  return preparing;
}

/**
 * Auto-update's half: download a newer release ahead of time, unless the connection is
 * metered, or one already waits, or the last attempt at this version failed within the hour.
 */
function maybePrepare(): void {
  if (!settings.autoUpdate() || !state.available || state.blocked !== null) return;
  if (state.metered === true || state.applying || preparing !== null) return;
  if (state.ready === state.latestVersion) return;
  if (failedPrepare?.version === state.latestVersion && Date.now() - failedPrepare.at < RETRY_FAILED_MS) return;
  void prepareUpdate('auto').catch(() => {});
}

/** Options -> Auto-update changed. Turned off, a build it downloaded is not installed. */
export function autoUpdateChanged(): void {
  if (!settings.autoUpdate() && readReady()?.requested === 'auto') dropReady();
  refreshReady();
  changed();
  maybePrepare();
}

/** What the tray launcher says about the connection, as it changes. */
export function setMetered(metered: boolean | null): void {
  if (state.metered === metered) return;
  state.metered = metered;
  changed();
  maybePrepare();
}

/* -------------------------------------------------------------- the swap */

export interface ApplyResult {
  version: string;
  stagedDir: string;
  /** What this process should exit with so the swap can begin: see `RESTART_EXIT_CODE`. */
  exitCode: number;
}

/**
 * Hand a staged build to a detached swapper. The swap cannot happen in this process: on
 * Windows the running `node.exe` is locked by the very process that would replace it. So the
 * *staged* build's own runtime runs the *staged* build's updater script, waits for this
 * process to exit, and does the work. That also means a release always installs itself with
 * its own updater rather than with whatever the older version happened to ship.
 *
 * `relaunch: false` is an install at quit: the swapper starts nothing afterwards, because
 * nobody asked for the app to come back (`--no-relaunch`, known to every swapper since 5.66,
 * which is every one this can hand to).
 */
function handOff(stagedDir: string, version: string, relaunch: boolean): ApplyResult {
  verifyStaged(stagedDir, version, process.platform);
  const runtime = path.join(stagedDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const script = path.join(stagedDir, 'scripts', 'apply-update.mjs');
  if (!fs.existsSync(script)) {
    throw new Error(`${version} does not know how to install itself (no updater script)`);
  }

  const restarts = relaunch && launcherRestarts();
  const child = spawn(
    runtime,
    [
      script,
      '--install', installDir(),
      '--staged', stagedDir,
      '--pid', String(process.pid),
      // The swapper then leaves the relaunch to the launcher instead of starting a copy
      // of its own. Only a swapper newer than this one ever reads it.
      ...(restarts ? ['--launcher-restarts'] : []),
      ...(relaunch ? [] : ['--no-relaunch']),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  // What the launcher waits on. data/ is the one place the swap does not move.
  if (child.pid !== undefined) {
    fs.writeFileSync(path.join(path.dirname(stagedDir), SWAPPER_PID_FILE), `${child.pid}\n`);
  }

  return { version, stagedDir, exitCode: restarts ? RESTART_EXIT_CODE : 0 };
}

/**
 * Update now: install the newest release and restart. A build already waiting for it is used
 * as it is; otherwise it is downloaded, unpacked and checked first.
 */
export async function applyUpdate(dataDir: string = dataRoot): Promise<ApplyResult> {
  if (state.applying) throw new Error('an update is already in progress');

  const blocked = blockedReason();
  if (blocked !== null) throw new Error(blocked);

  const repo = repoFromPackage();
  if (repo === null) throw new Error('no GitHub repository is recorded in package.json');

  state.applying = true;
  changed();
  try {
    await preparing?.catch(() => {});
    const waiting = usableReady(dataDir);
    if (waiting !== null && (state.latestVersion === null || waiting.version === state.latestVersion)) {
      writeReady({ ...waiting, attempts: waiting.attempts + 1 }, dataDir);
      return handOff(path.join(dataDir, 'update', waiting.version), waiting.version, true);
    }

    const release = await fetchLatestRelease(repo);
    const current = state.currentVersion ?? appVersion();
    if (current === null || compareVersions(current, release.version) >= 0) {
      throw new Error(`already on ${current ?? 'an unknown version'}`);
    }
    dropReady(dataDir);
    const stagedDir = await stage(release, dataDir);
    return handOff(stagedDir, release.version, true);
  } finally {
    state.applying = false;
    refreshReady();
    changed();
  }
}

/**
 * The waiting build to install now, at startup or at quit, or null.
 *
 * Installed only when someone asked for it: "When I quit", or Auto-update still on. And only
 * once: a build whose install did not take -- the app is starting on the old version again
 * -- is dropped rather than tried at every start, which would never let the app start at all.
 */
function installable(when: 'start' | 'quit'): ReadyRecord | null {
  if (blockedReason() !== null) return null;
  const ready = usableReady();
  if (ready === null || !(ready.requested === 'user' || settings.autoUpdate())) return null;
  if (ready.attempts > 0) {
    if (when === 'start') {
      state.prepareError = `the update to ${ready.version} did not install; data/update.log says why`;
      dropReady();
      refreshReady();
    }
    return null;
  }
  return ready;
}

/** At startup: install a waiting build and restart into it, or null to start as usual. */
export function installAtStart(): ApplyResult | null {
  const ready = installable('start');
  if (ready === null) return null;
  try {
    writeReady({ ...ready, attempts: ready.attempts + 1 });
    return handOff(path.join(dataRoot, 'update', ready.version), ready.version, true);
  } catch (e) {
    console.log(`  update: could not install ${ready.version} (${(e as Error).message})`);
    return null;
  }
}

/** At a deliberate quit: install a waiting build, and start nothing afterwards. */
export function installAtQuit(): string | null {
  const ready = installable('quit');
  if (ready === null) return null;
  try {
    writeReady({ ...ready, attempts: ready.attempts + 1 });
    handOff(path.join(dataRoot, 'update', ready.version), ready.version, false);
    return ready.version;
  } catch (e) {
    console.log(`  update: could not install ${ready.version} (${(e as Error).message})`);
    return null;
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
 * A build downloaded ahead of time and still newer than this one is kept, with its
 * `ready.json`: it is waiting to be installed, not left over.
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
  const keep = usableReady(data)?.version ?? null;
  if (keep === null) {
    drop(path.join(data, 'update'), 'data/update');
  } else {
    try {
      for (const name of fs.readdirSync(path.join(data, 'update'))) {
        if (name !== keep && name !== READY_FILE) drop(path.join(data, 'update', name), `data/update/${name}`);
      }
    } catch {
      /* see above */
    }
  }

  return { removed, bytes };
}
