/**
 * Swap a staged build into the install directory, then relaunch.
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
 * - **Nothing is deleted.** The outgoing files are *moved* into `.rollback-<stamp>/`. If
 *   this process dies half way, both halves are still on disk and recoverable by hand.
 *
 * Invoked by src/update/index.ts; not meant to be run directly.
 *
 *   node scripts/apply-update.mjs --install <dir> --staged <dir> --pid <n> [--archive <zip>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const installDir = arg('install');
const stagedDir = arg('staged');
const parentPid = Number(arg('pid'));
const archive = arg('archive');

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
function writeLog(outcome) {
  try {
    fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(installDir, 'data', 'update.log'),
      `${outcome}\n\n${log.join('\n')}\n`,
    );
  } catch {
    /* nothing further to try */
  }
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

/**
 * Start the app again, in a window the user can see.
 *
 * On Windows this goes through `cmd`'s `start`, and the quoting is the whole difficulty:
 * the launcher is called `Start osu! fresh profile.bat`, so the path has spaces in it, and
 * handing that to a shell unquoted runs a program called `Start`. `start` also treats its
 * first quoted argument as a window title, which is what the empty `""` is for.
 *
 * Spawning the runtime directly would be simpler and is wrong here: `detached` maps to
 * DETACHED_PROCESS on Windows, so the app would come back with no console at all -- running,
 * tracking, and invisible.
 */
function relaunch() {
  const launcher = ['Start osu! fresh profile.bat', 'Start osu! fresh profile.command', 'start.sh']
    .map((name) => path.join(installDir, name))
    .find((file) => fs.existsSync(file));

  if (launcher === undefined) {
    const runtime = path.join(installDir, process.platform === 'win32' ? 'node.exe' : 'node');
    say('no launcher found; starting the runtime directly');
    spawn(runtime, [path.join(installDir, 'src', 'main.ts')], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  say(`relaunching via ${path.basename(launcher)}`);
  const command =
    process.platform === 'win32' ? `start "" "${launcher}"` : `"${launcher}"`;
  spawn(command, {
    shell: true,
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function main() {
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

  if (archive) fs.rmSync(archive, { force: true });

  relaunch();

  writeLog(`OK: updated to ${installed.version}`);
}

main().catch((e) => {
  say(`FAILED: ${e.message}`);
  say('The previous version is in the .rollback- folder beside the app; move its contents');
  say('back into place to undo this. data/ was not touched.');
  writeLog(`FAILED: ${e.message}`);
  process.exit(1);
});
