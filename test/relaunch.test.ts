import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherName, relaunchPlan } from '../scripts/apply-update.mjs';
import { launcherFor, trayLauncherFor } from '../scripts/package-files.mjs';
import {
  LAUNCHER_ENV,
  RESTART_EXIT_CODE,
  SWAPPER_PID_FILE,
  launcherRestarts,
} from '../src/update/index.ts';

/*
 * How the app comes back after an update.
 *
 * Up to 1.13.2 the swapper started it again itself, through the launcher. On macOS and Linux
 * a process the swapper starts has no terminal, so the app came back running, tracking and
 * holding the port with nothing to stop it -- found on a real update in WSL. 1.14 had the unix
 * launchers restart the app in their own terminal. The tray launcher (roadmap 5.48) does the
 * same on every platform: it waits for the swap and starts the new launcher, whose icon and the
 * page's Quit are how it is stopped. The swapper starts a launcher only for releases that do not
 * restart the app, and never the runtime. test/launcher.test.ts runs the real tray launcher.
 */

const exists = (...present: string[]) => (file: string) => present.includes(file);

/* ------------------------------------------------------------ the swapper */

test('a launcher that restarts the app is left to do it', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = relaunchPlan({
      platform,
      installDir: '/opt/olp',
      launcherRestarts: true,
      exists: () => true,
      env: { DISPLAY: ':0' },
    });
    assert.ok('skip' in plan, `${platform}: a second copy would race the launcher's for the port`);
  }
});

test('Windows starts the tray launcher itself, which has no console to lose', () => {
  const exe = 'C:\\Program Files (x86)\\olp\\osu! local profiles.exe';
  const plan = relaunchPlan({
    platform: 'win32',
    installDir: 'C:\\Program Files (x86)\\olp',
    launcherRestarts: false,
    exists: exists(exe),
    env: {},
  });
  assert.ok(!('skip' in plan));
  assert.deepEqual([plan.command, plan.args], [exe, []]);
  assert.equal(plan.options.detached, true);
});

test('macOS opens a new copy of the bundle, as a double-click does', () => {
  const bundle = '/Applications/olp/osu! local profiles.app';
  const plan = relaunchPlan({
    platform: 'darwin',
    installDir: '/Applications/olp',
    launcherRestarts: false,
    exists: exists(bundle),
    env: {},
  });
  assert.ok(!('skip' in plan));
  // -n: the launcher that ran the app may not be gone yet, and open would only bring it forward.
  assert.deepEqual([plan.command, plan.args], ['open', ['-n', bundle]]);
});

test('Linux starts the tray launcher when there is a desktop for its icon', () => {
  const plan = relaunchPlan({
    platform: 'linux',
    installDir: '/home/me/olp',
    launcherRestarts: false,
    exists: exists('/home/me/olp/osu-local-profiles'),
    env: { WAYLAND_DISPLAY: 'wayland-0' },
  });
  assert.ok(!('skip' in plan));
  assert.deepEqual([plan.command, plan.args], ['/home/me/olp/osu-local-profiles', []]);
});

/* The old behaviour was exactly the fallback: run the launcher anyway, with nowhere to show it. */
test('Linux does not start an invisible copy when it has no desktop', () => {
  const plan = relaunchPlan({
    platform: 'linux',
    installDir: '/home/me/olp',
    launcherRestarts: false,
    exists: exists('/home/me/olp/osu-local-profiles'),
    env: {},
  });
  assert.ok('skip' in plan);
  assert.match(plan.skip, /\.\/start\.sh/);
});

test('with no launcher the runtime is never started directly', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = relaunchPlan({
      platform,
      installDir: '/opt/olp',
      launcherRestarts: false,
      exists: () => false,
      env: { DISPLAY: ':0' },
    });
    assert.ok('skip' in plan, `${platform}: a runtime started detached has nothing to stop it`);
  }
});

test('the swapper looks for the launcher each package actually ships', () => {
  assert.equal(launcherName('win32'), trayLauncherFor('win').name);
  assert.equal(launcherName('darwin'), trayLauncherFor('osx').name);
  assert.equal(launcherName('linux'), trayLauncherFor('linux').name);
});

/* ----------------------------------------------- start.sh, with no desktop */

test('start.sh and the app agree on the variable, the exit code and the pid file', () => {
  const { content } = launcherFor('linux', 'node')!;
  assert.match(content, new RegExp(`^${LAUNCHER_ENV}=restarts \\./node src/main\\.ts$`, 'm'));
  assert.match(content, new RegExp(`-eq ${RESTART_EXIT_CODE} \\]`));
  assert.ok(content.includes(`data/update/${SWAPPER_PID_FILE}`));
  assert.doesNotMatch(content, /exec \.\/node/, 'an exec leaves no shell to start the app again');
  assert.equal(launcherRestarts({ [LAUNCHER_ENV]: 'restarts' }), true);
  assert.equal(launcherRestarts({ [LAUNCHER_ENV]: 'tray' }), true);
  assert.equal(launcherRestarts({}), false);
});

/*
 * The script itself, run by `sh` against a stand-in runtime and a stand-in tray launcher. Git
 * Bash provides `sh` on Windows, and CI runs macOS and Linux.
 */
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function launcherFolder(runtime: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-launcher-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(dir, 'node'), runtime, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'osu-local-profiles'), '#!/bin/sh\necho "tray launcher started" >> events.log\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'start.sh'), launcherFor('linux', 'node')!.content, { mode: 0o755 });
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
