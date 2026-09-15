import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherFor } from '../scripts/package-files.mjs';

/*
 * macOS: one approval, and the quarantine is lifted from the rest of the folder. Without that,
 * Gatekeeper refuses the pp helper and then each of its native libraries separately, and people
 * end up allowing apps from anywhere. The tray launcher does it too (platform_darwin.go); the
 * .command does it before opening the bundle, which also spares the bundle App Translocation.
 *
 * The script runs under `sh` with a stand-in `xattr` and `open` put first on PATH, which record
 * what they were asked; `xattr` reports a file as quarantined while a marker for it exists. Git
 * Bash provides `sh` on Windows; CI runs macOS and Linux. What this cannot show is Gatekeeper
 * itself -- that needs a real download on a real Mac.
 */

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const LAUNCHER = 'Start osu! local profiles.command';
const BUNDLE_EXECUTABLE = path.join('osu! local profiles.app', 'Contents', 'MacOS', 'osu-local-profiles');

const FAKE_XATTR = [
  '#!/bin/sh',
  'echo "xattr $*" >> events.log',
  'if [ "$1" = "-p" ]; then',
  '  [ -f "quarantined-$(basename "$3")" ]',
  '  exit $?',
  'fi',
  'if [ "$1" = "-dr" ]; then rm -f quarantined-*; fi',
  'exit 0',
  '',
].join('\n');

const FAKE_OPEN = '#!/bin/sh\necho "open $*" >> events.log\nexit 0\n';

function macFolder(quarantined: string[]): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-mac-launcher-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');
  fs.mkdirSync(path.join(dir, 'tools', 'pp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'pp', 'osu-pp'), '', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho "runtime ran" >> events.log\n', { mode: 0o755 });
  fs.mkdirSync(path.dirname(path.join(dir, BUNDLE_EXECUTABLE)), { recursive: true });
  // A shebang, not an empty file: Git Bash's `-x` counts only scripts and .exe files as runnable.
  fs.writeFileSync(path.join(dir, BUNDLE_EXECUTABLE), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, LAUNCHER), launcherFor('osx', 'node')!.content, { mode: 0o755 });
  for (const name of quarantined) fs.writeFileSync(path.join(dir, `quarantined-${name}`), '');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xattr'), FAKE_XATTR, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), FAKE_OPEN, { mode: 0o755 });
  return { dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
}

function run(quarantined: string[]) {
  const { dir, env } = macFolder(quarantined);
  try {
    const result = spawnSync('sh', [LAUNCHER], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    const log = path.join(dir, 'events.log');
    // No log at all means the script stopped at a guard; what it printed says which.
    assert.ok(fs.existsSync(log), `the script ran nothing:\n${result.stdout}${result.stderr}`);
    const events = fs.readFileSync(log, 'utf8').trim().split('\n');
    return { result, events };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OPEN = 'open ./osu! local profiles.app';

test('a quarantined download is released from its own folder before the app opens', { skip: !hasSh }, () => {
  const { result, events } = run(['node']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, ['xattr -p com.apple.quarantine ./node', 'xattr -dr com.apple.quarantine .', OPEN]);
  assert.match(result.stdout, /Allowed the rest of this folder to run/);
});

test('a runtime already released still frees a quarantined pp helper', { skip: !hasSh }, () => {
  const { result, events } = run(['osu-pp']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, [
    'xattr -p com.apple.quarantine ./node',
    'xattr -p com.apple.quarantine tools/pp/osu-pp',
    'xattr -dr com.apple.quarantine .',
    OPEN,
  ]);
});

test('with nothing quarantined the script only looks, says nothing, and opens the app', { skip: !hasSh }, () => {
  const { result, events } = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, [
    'xattr -p com.apple.quarantine ./node',
    'xattr -p com.apple.quarantine tools/pp/osu-pp',
    OPEN,
  ]);
  assert.doesNotMatch(result.stdout, /Allowed/);
});

test('the script opens the bundle and never runs the runtime itself', { skip: !hasSh }, () => {
  const { events } = run([]);
  assert.ok(!events.includes('runtime ran'), 'the app is the tray launcher\'s to run');
});

test('only the macOS script touches quarantine, and before the app opens', () => {
  const mac = launcherFor('osx', 'node')!.content;
  assert.ok(mac.indexOf('xattr -dr') < mac.indexOf('open "./'));
  assert.doesNotMatch(launcherFor('linux', 'node')!.content, /xattr/);
});
