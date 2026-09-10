import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launcherFor, readmeFor } from '../scripts/package-files.mjs';

/*
 * What a packaged build tells the user, on each platform.
 *
 * Only the Windows package has ever been built here, so the macOS and Linux launchers are
 * otherwise unread text that would first be seen by whoever downloads them. These pin the
 * parts that would be silently broken: the extension each file manager will actually run,
 * the executable bit, and the shell line that moves to the app's own folder -- without
 * which the app looks for `data/` wherever the file manager started it and appears to have
 * lost every score.
 */

test('each platform gets the launcher its file manager will run', () => {
  assert.equal(launcherFor('win', 'node.exe').name, 'Start osu! fresh profile.bat');
  // .command, not .sh: Finder opens a .sh in a text editor rather than running it.
  assert.equal(launcherFor('osx', 'node').name, 'Start osu! fresh profile.command');
  assert.equal(launcherFor('linux', 'node').name, 'start.sh');
});

test('the unix launchers are executable and the Windows one does not need to be', () => {
  assert.equal(launcherFor('osx', 'node').mode, 0o755);
  assert.equal(launcherFor('linux', 'node').mode, 0o755);
  assert.equal(launcherFor('win', 'node.exe').mode, null);
});

/*
 * The line every launcher exists for. A double-clicked launcher starts in whatever
 * directory the file manager felt like, and `data/` is resolved beside the app -- so
 * without this the app silently starts from scratch every time.
 */
test('every launcher moves to its own folder before starting the app', () => {
  assert.match(launcherFor('win', 'node.exe').content, /cd \/d "%~dp0"/);
  for (const os of ['osx', 'linux'] as const) {
    assert.match(launcherFor(os, 'node').content, /cd "\$\(dirname "\$0"\)"/);
  }
});

test('the launchers run the Node beside them, not one from PATH', () => {
  // `./` matters: a machine with its own node on PATH must still use the bundled runtime,
  // which is the version this app is actually tested against.
  assert.match(launcherFor('linux', 'node').content, /exec \.\/node src\/main\.ts/);
  assert.match(launcherFor('win', 'node.exe').content, /node\.exe src\\main\.ts/);
});

test('the unix launchers start with a shebang and use forward slashes', () => {
  for (const os of ['osx', 'linux'] as const) {
    const { content } = launcherFor(os, 'node');
    assert.ok(content.startsWith('#!/bin/sh\n'), 'needs a shebang to be runnable');
    assert.ok(!content.includes('\\'), 'a backslash path would not resolve on unix');
    assert.ok(!content.includes('\r'), 'CR would break the shebang line on some shells');
  }
});

/* cmd does not reliably parse a .bat with bare newlines. */
test('the Windows launcher is CRLF', () => {
  const { content } = launcherFor('win', 'node.exe');
  assert.ok(content.includes('\r\n'));
});

/* ------------------------------------------------------------------ README */

/*
 * macOS refuses to open the build the first time: it is not signed by a paid Apple
 * developer account, and downloaded unsigned programs are quarantined. Someone meeting that
 * with no explanation concludes the build is broken, so the README has to say it plainly
 * and give the way round it.
 */
test('the macOS README explains Gatekeeper, because it will happen', () => {
  const readme = readmeFor('osx');
  assert.match(readme, /macOS will refuse to open it/);
  assert.match(readme, /xattr -dr com\.apple\.quarantine \./);
  assert.match(readme, /right-click the file and choose Open/);
});

test('the Linux README says how to restore a lost executable bit', () => {
  assert.match(readmeFor('linux'), /chmod \+x start\.sh node/);
});

test('each README names the launcher that platform actually has', () => {
  assert.match(readmeFor('win'), /Start osu! fresh profile\.bat/);
  assert.match(readmeFor('osx'), /Start osu! fresh profile\.command/);
  assert.match(readmeFor('linux'), /\.\/start\.sh/);

  // ...and not one of the others, which would send the user looking for a missing file.
  assert.ok(!readmeFor('win').includes('start.sh'));
  assert.ok(!readmeFor('linux').includes('.bat'));
});

/* The escape hatch, and the one most likely to be needed away from Windows. */
test('every README says how to point it at osu! by hand', () => {
  for (const os of ['win', 'osx', 'linux'] as const) {
    assert.match(readmeFor(os), /installRoots/);
  }
});

test('the Windows README is CRLF so Notepad can read it', () => {
  assert.ok(readmeFor('win').includes('\r\n'));
  assert.ok(!readmeFor('linux').includes('\r'));
  assert.ok(!readmeFor('osx').includes('\r'));
});
