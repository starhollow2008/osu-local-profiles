import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launcherFor } from '../scripts/package-files.mjs';

/*
 * macOS: one approval, for the launcher, and the launcher lifts the quarantine from the rest of
 * its folder. Without that, Gatekeeper refuses the pp helper and then each of its native
 * libraries separately, and people end up allowing apps from anywhere.
 *
 * The launcher runs under `sh` against a stand-in runtime and a stand-in `xattr` put first on
 * PATH, which records what it was asked and reports a file as quarantined while a marker for it
 * exists. Git Bash provides `sh` on Windows; CI runs macOS and Linux. What this cannot show is
 * Gatekeeper itself -- that needs a real download on a real Mac.
 */

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const LAUNCHER = 'Start osu! local profiles.command';

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

function macFolder(quarantined: string[]): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-mac-launcher-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');
  fs.mkdirSync(path.join(dir, 'tools', 'pp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'pp', 'osu-pp'), '', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho "app started" >> events.log\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, LAUNCHER), launcherFor('osx', 'node').content, { mode: 0o755 });
  for (const name of quarantined) fs.writeFileSync(path.join(dir, `quarantined-${name}`), '');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xattr'), FAKE_XATTR, { mode: 0o755 });
  return { dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
}

function run(quarantined: string[]) {
  const { dir, env } = macFolder(quarantined);
  try {
    const result = spawnSync('sh', [LAUNCHER], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n');
    return { result, events };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a quarantined download is released from its own folder before the app starts', { skip: !hasSh }, () => {
  const { result, events } = run(['node', 'osu-pp']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, [
    'xattr -p com.apple.quarantine ./node',
    'xattr -dr com.apple.quarantine .',
    'app started',
  ]);
  assert.match(result.stdout, /Allowed the rest of this folder to run/);
});

test('a runtime already released still frees a quarantined pp helper', { skip: !hasSh }, () => {
  // Someone who approved `node` by hand, or ran xattr on it alone.
  const { result, events } = run(['osu-pp']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, [
    'xattr -p com.apple.quarantine ./node',
    'xattr -p com.apple.quarantine tools/pp/osu-pp',
    'xattr -dr com.apple.quarantine .',
    'app started',
  ]);
});

test('with nothing quarantined the launcher only looks, and says nothing', { skip: !hasSh }, () => {
  const { result, events } = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(events, [
    'xattr -p com.apple.quarantine ./node',
    'xattr -p com.apple.quarantine tools/pp/osu-pp',
    'app started',
  ]);
  assert.doesNotMatch(result.stdout, /Allowed/);
});

test('only the macOS launcher touches quarantine, and before the runtime runs', () => {
  const mac = launcherFor('osx', 'node').content;
  assert.ok(mac.indexOf('xattr -dr com.apple.quarantine .') < mac.indexOf('./node src/main.ts'));
  assert.doesNotMatch(launcherFor('linux', 'node').content, /xattr/);
});
