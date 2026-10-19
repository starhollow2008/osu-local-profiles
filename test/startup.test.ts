import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approvedOff,
  entryTarget,
  launcherPath,
  linuxEntry,
  macAgent,
  regFileValue,
  setStartup,
  startedWithComputer,
  startsLauncher,
  startupState,
  STARTUP_ENV,
  windowsCommand,
} from '../src/startup.ts';

/*
 * Start when your computer starts (roadmap 5.77). The computer's own entry is the only record,
 * so what matters is that each entry this writes reads back as this copy's, and nothing else
 * does. Windows' registry is only exercised through its export format here: a test run must not
 * change what starts with the machine it runs on.
 */

test('a start by the computer is told apart, and opens nothing', () => {
  assert.equal(startedWithComputer({ [STARTUP_ENV]: '1' }), true);
  assert.equal(startedWithComputer({}), false);
  assert.equal(startedWithComputer({ [STARTUP_ENV]: '0' }), false);
});

test('each entry starts the launcher with --startup, and reads back as it', () => {
  const win = 'C:\\Users\\Jöns\\osu! local profiles\\osu! local profiles.exe';
  assert.equal(windowsCommand(win), `"${win}" --startup`);
  assert.equal(entryTarget(windowsCommand(win), 'win32'), win);
  assert.equal(startsLauncher(windowsCommand(win), win.toUpperCase(), 'win32'), true, 'Windows paths ignore case');

  const bundle = '/Users/a&b/Apps/osu! local profiles.app';
  const agent = macAgent(bundle);
  assert.match(agent, /<string>\/usr\/bin\/open<\/string>/);
  assert.match(agent, /<string>--startup<\/string>/);
  assert.match(agent, /a&amp;b/);
  assert.equal(entryTarget(agent, 'darwin'), bundle);

  const linux = '/home/me/my "games"/$HOME/osu-local-profiles';
  const entry = linuxEntry(linux);
  assert.match(entry, /^Exec=".*" --startup$/m);
  assert.equal(entryTarget(entry, 'linux'), linux);

  // Another copy's entry, or one this did not write, is not this copy's.
  assert.equal(startsLauncher(windowsCommand('D:\\old\\osu! local profiles.exe'), win, 'win32'), false);
  assert.equal(startsLauncher('something else', win, 'win32'), false);
  assert.equal(startsLauncher(null, win, 'win32'), false);
});

test("Windows' entries are read from a registry export, non-ASCII names included", () => {
  const exported = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]',
    '"OneDrive"="\\"C:\\\\Program Files\\\\OneDrive.exe\\" /background"',
    '"osu! local profiles"="\\"C:\\\\Users\\\\Jöns\\\\osu! local profiles.exe\\" --startup"',
    '',
  ].join('\r\n');
  assert.equal(
    regFileValue(exported, 'osu! local profiles'),
    '"C:\\Users\\Jöns\\osu! local profiles.exe" --startup',
  );
  assert.equal(regFileValue(exported, 'missing'), null);

  // Task Manager's switch: an odd first byte is off.
  assert.equal(approvedOff('hex:03,00,00,00,a0,b1,c2,d3,e4,f5,06,07'), true);
  assert.equal(approvedOff('hex:07,00,00,00'), true);
  assert.equal(approvedOff('hex:02,00,00,00,00,00,00,00,00,00,00,00'), false);
  assert.equal(approvedOff(null), false);
});

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform}: on and off, and only this copy's entry is ever removed`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-startup-'));
    try {
      const dir = path.join(tmp, 'app');
      const home = path.join(tmp, 'home');
      const opts = { dir, platform, home, env: {} };

      // A source checkout has no launcher, so nothing is offered or written.
      assert.deepEqual(await startupState(opts), { available: false, enabled: false });
      await assert.rejects(setStartup(true, opts));

      fs.mkdirSync(launcherPath(dir, platform), { recursive: true });
      assert.deepEqual(await startupState(opts), { available: true, enabled: false }, 'off by default');
      assert.deepEqual(await setStartup(true, opts), { available: true, enabled: true });
      assert.deepEqual(await setStartup(false, opts), { available: true, enabled: false });

      // A second copy takes the entry over; switching off in the first leaves the second's be.
      const other = { ...opts, dir: path.join(tmp, 'other') };
      fs.mkdirSync(launcherPath(other.dir, platform), { recursive: true });
      await setStartup(true, opts);
      await setStartup(true, other);
      assert.equal((await startupState(opts)).enabled, false);
      await setStartup(false, opts);
      assert.equal((await startupState(other)).enabled, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
