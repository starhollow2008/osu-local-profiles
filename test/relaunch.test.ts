import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherName, relaunchPlan } from '../scripts/apply-update.mjs';
import { launcherFor } from '../scripts/package-files.mjs';
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
 * holding the port with no window to stop it in -- while the terminal it had been started
 * from went back to its prompt. Found on a real update in WSL: the relaunched `node` had no
 * TTY, its output went to /dev/null, and it outlived the terminal being closed. On Windows
 * `start` ran the new launcher with `cmd /K`, which left its window open after the app stopped.
 */

const exists = (...present: string[]) => (file: string) => present.includes(file);
const noTerminals = () => null;

/* ------------------------------------------------------------ the swapper */

test('a launcher that restarts the app is left to do it', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = relaunchPlan({
      platform,
      installDir: '/opt/olp',
      launcherRestarts: true,
      exists: () => true,
      findOnPath: () => '/usr/bin/xterm',
      env: { DISPLAY: ':0' },
    });
    assert.ok('skip' in plan, `${platform}: a second copy would race the launcher's for the port`);
  }
});

test('Windows starts the launcher the way a double-click does, so its window closes with the app', () => {
  const bat = 'C:\\Program Files (x86)\\olp\\Start osu! local profiles.bat';
  const plan = relaunchPlan({
    platform: 'win32',
    installDir: 'C:\\Program Files (x86)\\olp',
    launcherRestarts: false,
    exists: exists(bat),
    findOnPath: noTerminals,
    env: {},
  });
  assert.ok(!('skip' in plan));
  assert.equal(plan.command, 'cmd.exe');
  // `/s /c` strips the outer quotes, leaving `start "" cmd /d /c ""<bat>""`; the inner `/c`
  // strips one pair again, so the path reaches cmd quoted, parentheses and all.
  assert.equal(plan.args.join(' '), `/d /s /c "start "" cmd /d /c ""${bat}"""`);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.doesNotMatch(plan.args.join(' '), /\/k/i);
});

test('macOS opens the .command, which is a new Terminal window', () => {
  const launcher = '/Applications/olp/Start osu! local profiles.command';
  const plan = relaunchPlan({
    platform: 'darwin',
    installDir: '/Applications/olp',
    launcherRestarts: false,
    exists: exists(launcher),
    findOnPath: noTerminals,
    env: {},
  });
  assert.ok(!('skip' in plan));
  assert.deepEqual([plan.command, plan.args], ['open', [launcher]]);
});

test('Linux runs the launcher in a terminal program when there is a desktop to show one', () => {
  const plan = relaunchPlan({
    platform: 'linux',
    installDir: '/home/me/olp',
    launcherRestarts: false,
    exists: exists('/home/me/olp/start.sh'),
    findOnPath: (program) => (program === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null),
    env: { WAYLAND_DISPLAY: 'wayland-0' },
  });
  assert.ok(!('skip' in plan));
  assert.deepEqual([plan.command, plan.args], ['/usr/bin/gnome-terminal', ['--', '/home/me/olp/start.sh']]);
});

/* The old behaviour was exactly the fallback: run the launcher anyway, with nowhere to show it. */
test('Linux does not start an invisible copy when it has nowhere to show one', () => {
  const base = {
    platform: 'linux',
    installDir: '/home/me/olp',
    launcherRestarts: false,
    exists: exists('/home/me/olp/start.sh'),
  };
  const noDesktop = relaunchPlan({ ...base, findOnPath: () => '/usr/bin/xterm', env: {} });
  assert.ok('skip' in noDesktop);
  assert.match(noDesktop.skip, /\.\/start\.sh/);

  const noTerminal = relaunchPlan({ ...base, findOnPath: noTerminals, env: { DISPLAY: ':0' } });
  assert.ok('skip' in noTerminal);
});

test('with no launcher the runtime is never started directly', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = relaunchPlan({
      platform,
      installDir: '/opt/olp',
      launcherRestarts: false,
      exists: () => false,
      findOnPath: () => '/usr/bin/xterm',
      env: { DISPLAY: ':0' },
    });
    assert.ok('skip' in plan, `${platform}: a runtime started detached has no console`);
  }
});

test('the swapper looks for the launcher each package actually ships', () => {
  assert.equal(launcherName('win32'), launcherFor('win', 'node.exe').name);
  assert.equal(launcherName('darwin'), launcherFor('osx', 'node').name);
  assert.equal(launcherName('linux'), launcherFor('linux', 'node').name);
});

/* ------------------------------------------------------------ the launcher */

test('the app and the unix launchers agree on the variable, the exit code and the pid file', () => {
  for (const os of ['osx', 'linux'] as const) {
    const { content } = launcherFor(os, 'node');
    assert.match(content, new RegExp(`^${LAUNCHER_ENV}=restarts \\./node src/main\\.ts$`, 'm'));
    assert.match(content, new RegExp(`-eq ${RESTART_EXIT_CODE} \\]`));
    assert.ok(content.includes(`data/update/${SWAPPER_PID_FILE}`));
    assert.doesNotMatch(content, /exec \.\/node/, 'an exec leaves no shell to start the app again');
  }
  assert.equal(launcherRestarts({ [LAUNCHER_ENV]: 'restarts' }), true);
  assert.equal(launcherRestarts({}), false);
});

/* The Windows launcher cannot do this: cmd re-reads a running .bat from disk by offset, and
 * the swap replaces it. So Windows keeps the swapper's relaunch, and never sees the code. */
test('the Windows launcher does not restart the app', () => {
  assert.doesNotMatch(launcherFor('win', 'node.exe').content, new RegExp(LAUNCHER_ENV));
});

/*
 * The launcher itself, run by `sh` against a stand-in runtime: exit for an update with a swap
 * still busy, then come back. Git Bash provides `sh` on Windows, and CI runs macOS and Linux.
 */
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function launcherFolder(runtime: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-launcher-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(dir, 'node'), runtime, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'start.sh'), launcherFor('linux', 'node').content, { mode: 0o755 });
  return dir;
}

test('after an update the launcher waits for the swap, then starts the app again itself', { skip: !hasSh }, () => {
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
    const result = spawnSync('sh', ['start.sh'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing the update/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n'), [
      'app started (restarts)',
      'swap finished',
      'app started (restarts)',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('any other exit ends the launcher with the app\'s own status', { skip: !hasSh }, () => {
  const dir = launcherFolder('#!/bin/sh\necho started >> events.log\nexit 3\n');
  try {
    const result = spawnSync('sh', ['start.sh'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 3);
    assert.equal(fs.readFileSync(path.join(dir, 'events.log'), 'utf8'), 'started\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
