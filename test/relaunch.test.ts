import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherFor, trayLauncherFor } from '../scripts/package-files.mjs';

/*
 * How the app comes back after an update.
 *
 * Up to 1.13.2 the swapper started it again itself, through the launcher. On macOS and Linux
 * a process the swapper starts has no terminal, so the app came back running, tracking and
 * holding the port with nothing to stop it -- found on a real update in WSL. 1.14 had the unix
 * launchers restart the app in their own terminal. The tray launcher (roadmap 5.48) does the
 * same on every platform: it waits for the swap and starts the new launcher, whose icon and the
 * page's Quit are how it is stopped. The swapper starts a launcher only for releases that do not
 * restart the app, and never the runtime: that decision is the tray launcher's `relaunchPlan`,
 * tested in tools/launcher/swap_test.go, and test/launcher.test.ts runs the real launcher.
 *
 * What is left here is what a package carries and the app must agree with: the launcher's
 * names, and start.sh, which still runs the app in its terminal when there is no desktop.
 */

const root = process.cwd();
const csharp = (...file: string[]) => fs.readFileSync(path.join(root, 'dotnet', 'App', ...file), 'utf8');

/** A `const` the app declares, read from its source: `public const int RestartExitCode = 75;`. */
function constant(source: string, name: string): string {
  const value = new RegExp(`const \\w+ ${name} = "?([^";]+)"?;`).exec(source)?.[1];
  assert.ok(value, `the app declares no ${name}`);
  return value;
}

test('the app looks for the launcher each package actually ships', () => {
  const updater = csharp('Update', 'Updater.cs');
  for (const [platform, os] of [['"win32"', 'win'], ['"darwin"', 'osx'], ['_', 'linux']] as const) {
    assert.match(updater, new RegExp(`${platform} => "${trayLauncherFor(os).name.replace(/[.!]/g, '\\$&')}"`), os);
  }
  // On macOS the executable is inside the bundle.
  const mac = trayLauncherFor('osx').executable.split('/').map((part) => `"${part}"`).join(', ');
  assert.ok(updater.includes(`Path.Combine(${mac})`), `LauncherExecutableFor names ${trayLauncherFor('osx').executable}`);
});

const LAUNCHER_ENV = constant(csharp('Instance.cs'), 'LauncherEnv');
const RESTART_EXIT_CODE = constant(csharp('Update', 'Updater.cs'), 'RestartExitCode');
const SWAPPER_PID_FILE = constant(csharp('Update', 'Updater.cs'), 'SwapperPidFile');

test('start.sh and the app agree on the variable, the exit code and the pid file', () => {
  const { content } = launcherFor('linux')!;
  assert.match(content, new RegExp(`^${LAUNCHER_ENV}=restarts \\./app/osu-local-profiles-app$`, 'm'));
  assert.match(content, new RegExp(`-eq ${RESTART_EXIT_CODE} \\]`));
  assert.ok(content.includes(`data/update/${SWAPPER_PID_FILE}`));
  assert.doesNotMatch(content, /exec \.\/app/, 'an exec leaves no shell to start the app again');
  // "restarts" is one of the two values that tell the app its launcher will start it again.
  assert.match(csharp('Instance.cs'), /getenv\(LauncherEnv\) is "restarts" or "tray"/);
});

/*
 * The script itself, run by `sh` against a stand-in app and a stand-in tray launcher. Git
 * Bash provides `sh` on Windows, and CI runs macOS and Linux.
 */
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function launcherFolder(app: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-launcher-'));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'osu-local-profiles-app'), app, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'osu-local-profiles'), '#!/bin/sh\necho "tray launcher started" >> events.log\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'start.sh'), launcherFor('linux')!.content, { mode: 0o755 });
  return dir;
}

const events = (dir: string) =>
  fs.existsSync(path.join(dir, 'events.log'))
    ? fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n')
    : [];

function withoutDesktop(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['DISPLAY'];
  delete env['WAYLAND_DISPLAY'];
  return env;
}

test('with no desktop, after an update start.sh waits for the swap, then starts the app again', { skip: !hasSh }, () => {
  // The first run hands off to a "swapper" that is still busy for a second, and exits 75.
  const dir = launcherFolder(
    [
      '#!/bin/sh',
      'echo "app started ($OSU_LOCAL_PROFILES_LAUNCHER)" >> events.log',
      'if [ ! -f updated ]; then',
      '  touch updated',
      '  mkdir -p data/update',
      '  (sleep 1; echo "swap finished" >> events.log) &',
      '  echo $! > data/update/swapper.pid',
      '  exit 75',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  try {
    const result = spawnSync('sh', ['start.sh'], { cwd: dir, env: withoutDesktop(), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing the update/);
    assert.deepEqual(events(dir), ['app started (restarts)', 'swap finished', 'app started (restarts)']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no desktop, any other exit ends start.sh with the app's own status", { skip: !hasSh }, () => {
  const dir = launcherFolder('#!/bin/sh\necho started >> events.log\nexit 3\n');
  try {
    const result = spawnSync('sh', ['start.sh'], { cwd: dir, env: withoutDesktop(), encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 3);
    assert.deepEqual(events(dir), ['started']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with a desktop, start.sh hands the app to the tray launcher and returns', { skip: !hasSh }, async () => {
  const dir = launcherFolder('#!/bin/sh\necho "runtime ran" >> events.log\n');
  try {
    const result = spawnSync('sh', ['start.sh'], {
      cwd: dir,
      env: { ...process.env, DISPLAY: ':0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /icon in your system tray/);
    for (let i = 0; i < 50 && events(dir).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(events(dir), ['tray launcher started']);
  } finally {
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
