/**
 * Swap a staged build into the install directory, then see the app started again.
 *
 * Runs *detached*, from the staged build, using the staged build's own Node runtime. It has
 * to: on Windows the running app's `node.exe` is locked by the process doing the replacing,
 * so nothing inside the app can replace it. By the time this runs, its parent is on its way
 * out and this process is the only one left holding the pieces.
 *
 * Two rules it must keep:
 *
 * - **`data/` is not touched.** It sits inside the install directory and holds the database,
 *   the profile images and config.json. Losing it would be losing everything the app is for.
 * - **Nothing is deleted until the replacement is in place.** The outgoing files are *moved*
 *   into `.rollback-<stamp>/`, so a crash part way through leaves both halves on disk and
 *   recoverable by hand. Once the new build is on disk and its manifest reads back, that
 *   window has closed and the copy is removed -- it is ~200MB, and it was insurance against
 *   a risk that has passed.
 *
 * Invoked by src/update/index.ts; not meant to be run directly. Importing it runs nothing,
 * so `test/relaunch.test.ts` can check how it relaunches.
 *
 *   node scripts/apply-update.mjs --install <dir> --staged <dir> --pid <n>
 *     [--archive <zip>] [--launcher-restarts]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The tray launcher each platform's package carries, as `scripts/package-files.mjs` names it
 * (`trayLauncherFor`). On macOS it is the bundle, which is what `open` is handed.
 */
export function launcherName(platform) {
  if (platform === 'win32') return 'osu! local profiles.exe';
  if (platform === 'darwin') return 'osu! local profiles.app';
  return 'osu-local-profiles';
}

/**
 * How to start the app again once the swap is done -- or why this process should not.
 *
 * The rule: **the app comes back somewhere it can be stopped from, or not at all.** A copy
 * started with nothing to stop it keeps tracking, keeps the port, and can only be found in a
 * process list -- what every release up to 1.13.2 did on macOS and Linux. The tray launcher is
 * such a place: its icon quits the app, and so does the page, which starting the launcher again
 * opens. So it is the launcher that is started here, and never the runtime directly.
 *
 * - **A launcher that restarts the app itself** -- the tray launcher, on every platform, and
 *   the terminal loop in `start.sh` and the 1.14-1.16 unix launchers -- waits for this process
 *   and starts the app again. Starting a second copy here would race it for the port.
 * - **Windows**: the launcher executable. It has no console to lose.
 * - **macOS**: `open -n` on the bundle, as a double-click does. `-n` because the launcher that
 *   ran the app may not have finished exiting, and `open` would otherwise just bring it forward.
 * - **Linux**: the launcher, when there is a desktop for its icon. With none, nothing: the
 *   update has finished, and "start it again yourself" is an honest outcome where an invisible
 *   copy is not.
 *
 * Reached only from a launcher that does not restart: releases up to 1.13.2 on macOS and
 * Linux, up to 1.16 on Windows, and the runtime started by hand from a packaged folder.
 */
export function relaunchPlan({ platform, installDir, launcherRestarts, exists, env }) {
  if (launcherRestarts) {
    return { skip: 'the launcher that started the app is waiting to start it again' };
  }

  const name = launcherName(platform);
  const launcher = (platform === 'win32' ? path.win32 : path.posix).join(installDir, name);
  if (!exists(launcher)) {
    return { skip: `there is no ${name} to start it with; start the app yourself` };
  }

  const options = { cwd: installDir, detached: true, stdio: 'ignore' };

  if (platform === 'win32') return { command: launcher, args: [], options };

  if (platform === 'darwin') return { command: 'open', args: ['-n', launcher], options };

  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { skip: 'there is no desktop to show its icon on; run ./start.sh again' };
  }
  return { command: launcher, args: [], options };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once the process is gone. `kill(pid, 0)` tests for existence without signalling. */
function hasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * Everything at the top of the install that an update replaces.
 *
 * `data` is the user's. `.rollback-*` are previous updates' safety copies, and moving one
 * into another would bury it.
 */
function replaceable(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => e.name)
    .filter((name) => name !== 'data' && !name.startsWith('.rollback-'));
}

/**
 * Move, falling back to copy.
 *
 * `rename` is atomic and instant within a volume, but fails across one -- and it can fail on
 * Windows if a file is still held briefly after the parent exits. The copy path costs a few
 * seconds on the 90MB runtime and always works.
 */
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

async function run() {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? null : process.argv[i + 1];
  };

  const installDir = arg('install');
  const stagedDir = arg('staged');
  const parentPid = Number(arg('pid'));
  const archive = arg('archive');
  const launcherRestarts = process.argv.includes('--launcher-restarts');

  if (!installDir || !stagedDir || !Number.isFinite(parentPid)) {
    console.error('usage: apply-update.mjs --install <dir> --staged <dir> --pid <n>');
    process.exit(2);
  }

  const log = [];
  const say = (line) => {
    log.push(`${new Date().toISOString()}  ${line}`);
    console.log(line);
  };

  /* The log is the only account of what happened: this process has no console anyone sees. */
  const writeLog = (outcome) => {
    try {
      fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(installDir, 'data', 'update.log'),
        `${outcome}\n\n${log.join('\n')}\n`,
      );
    } catch {
      /* nothing further to try */
    }
  };

  /** Resolves once the relaunch has started or failed to, so the log can say which. */
  const relaunch = () => {
    const plan = relaunchPlan({
      platform: process.platform,
      installDir,
      launcherRestarts,
      exists: fs.existsSync,
      env: process.env,
    });
    if ('skip' in plan) {
      say(`not relaunching: ${plan.skip}`);
      return Promise.resolve();
    }

    say(`relaunching: ${plan.command} ${plan.args.join(' ')}`);
    return new Promise((resolve) => {
      const child = spawn(plan.command, plan.args, plan.options);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', (e) => {
        say(`the relaunch failed (${e.message}); start the app yourself`);
        resolve();
      });
    });
  };

  try {
    say(`waiting for the app (pid ${parentPid}) to exit`);
    for (let i = 0; i < 120 && !hasExited(parentPid); i += 1) await sleep(500);
    if (!hasExited(parentPid)) {
      say('it is still running after 60s; not touching anything');
      writeLog('ABORTED: the app did not exit');
      process.exit(1);
    }

    // Windows can hold a handle open for a moment after the process is reported gone.
    await sleep(1500);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rollback = path.join(installDir, `.rollback-${stamp}`);
    fs.mkdirSync(rollback, { recursive: true });
    say(`rollback copy: ${rollback}`);

    const outgoing = replaceable(installDir);
    say(`moving ${outgoing.length} entries aside`);
    for (const name of outgoing) move(path.join(installDir, name), path.join(rollback, name));

    const incoming = fs.readdirSync(stagedDir);
    say(`copying ${incoming.length} entries in`);
    for (const name of incoming) {
      // Copied, not moved: the staged tree lives under data/update, and this process is
      // *running from it*. Moving the runtime out from under itself would be a bad idea.
      fs.cpSync(path.join(stagedDir, name), path.join(installDir, name), { recursive: true });
    }

    const installed = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
    say(`installed ${installed.version}`);

    /*
     * The rollback has done its job, so it goes.
     *
     * It exists for the window between "the old files have been moved aside" and "the new
     * ones are all in place" -- a crash in there would otherwise leave a hole where the app
     * used to be. That window closed on the line above: the new build is on disk and its
     * manifest reads back. Keeping the copy past this point costs ~200MB of the user's disk
     * to insure against a risk that has already passed, and the way back from a *bad* release
     * is to download the previous one again, not to keep a spare copy of it forever.
     *
     * Deleted here rather than at the next startup so it never exists at rest at all. A
     * failure to delete is not a failure of the update: `pruneUpdateLeftovers` sweeps
     * whatever is left the next time the app starts.
     */
    try {
      fs.rmSync(rollback, { recursive: true, force: true });
      say('removed the rollback copy; the update is complete');
    } catch (e) {
      say(`could not remove the rollback copy (${e.message}); it will go on next start`);
    }

    if (archive) fs.rmSync(archive, { force: true });

    await relaunch();

    writeLog(`OK: updated to ${installed.version}`);
  } catch (e) {
    say(`FAILED: ${e.message}`);
    say('The previous version is in the .rollback- folder beside the app; move its contents');
    say('back into place to undo this. data/ was not touched.');
    writeLog(`FAILED: ${e.message}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) await run();
