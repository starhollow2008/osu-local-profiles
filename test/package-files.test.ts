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
  assert.equal(launcherFor('win', 'node.exe').name, 'Start osu! local profiles.bat');
  // .command, not .sh: Finder opens a .sh in a text editor rather than running it.
  assert.equal(launcherFor('osx', 'node').name, 'Start osu! local profiles.command');
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
  // The same on Windows, and it was not: a bare `node.exe` only finds the bundled one while
  // NoDefaultCurrentDirectoryInExePath is unset. Found when an update relaunched on the
  // system Node from a shell that had it set.
  assert.match(launcherFor('win', 'node.exe').content, /^\.\\node\.exe src\\main\.ts\r$/m);
});

/* ------------------------------------------------- the incomplete-folder guard */

/*
 * Nothing in this app needs installing, so a missing file is never a missing prerequisite:
 * it is an incomplete download, a half-finished extraction, or antivirus having taken the
 * runtime. Left to itself cmd says "'node.exe' is not recognized as an internal or external
 * command", which reads exactly like a missing prerequisite and sends people off installing
 * a Node this app would not use anyway.
 *
 * Verified by running all three launchers against folders in each state; what those runs
 * cannot check is the executable-bit branch, because NTFS reports every file as executable.
 * `sh -n` parses it, and only a real unix filesystem can exercise it -- the same standing
 * caveat as the rest of the macOS and Linux packaging.
 */
test('a launcher whose folder is incomplete says so instead of failing obscurely', () => {
  const win = launcherFor('win', 'node.exe').content;
  assert.match(win, /if not exist "\.\\node\.exe" set "missing=node\.exe"/);
  assert.match(win, /if not exist "src\\main\.ts" set "missing=src\\main\.ts"/);
  assert.match(win, /is missing from this folder/);

  for (const os of ['osx', 'linux'] as const) {
    const content = launcherFor(os, 'node').content;
    assert.match(content, /if \[ ! -f \.\/node \] \|\| \[ ! -f src\/main\.ts \]; then/);
    assert.match(content, /this folder is incomplete/);
  }
});

/*
 * The sentence that stops the guard from causing the very thing it exists to prevent. A
 * message naming a missing `node.exe` with no context is an invitation to go and install
 * Node, which would not help: the launcher runs the runtime beside it and never one on PATH.
 */
test('the guard says nothing needs installing, and where to get the archive', () => {
  for (const [os, binary] of [['win', 'node.exe'], ['osx', 'node'], ['linux', 'node']] as const) {
    const { content } = launcherFor(os, binary);
    assert.match(content, /Nothing needs installing/);
    assert.match(content, /github\.com\/jonathant09\/osu-local-profiles\/releases/);
  }
});

/*
 * The failure this shape invites: a `.bat` runs straight on into whatever follows, so
 * without the `exit /b` the success path falls through the label and every normal start
 * ends by announcing that the folder is incomplete.
 */
test('the Windows launcher leaves before reaching its own error message', () => {
  const lines = launcherFor('win', 'node.exe').content.split('\r\n');
  const run = lines.findIndex((l) => l.startsWith('.\\node.exe'));
  const exit = lines.indexOf('exit /b', run);
  const label = lines.indexOf(':incomplete');
  assert.ok(run > 0 && exit > run, 'the run path has to end in exit /b');
  assert.ok(label > exit, 'the error message has to come after that exit, not before it');
});

/* A zip extracted by a tool that drops permissions leaves the runtime present and unrunnable;
 * `sh` reports only "Permission denied", which says nothing about how to fix it. */
test('the unix launchers tell the user how to restore a lost executable bit', () => {
  for (const os of ['osx', 'linux'] as const) {
    const { content } = launcherFor(os, 'node');
    assert.match(content, /if \[ ! -x \.\/node \]; then/);
    assert.match(content, /chmod \+x \.\/node tools\/pp\/osu-pp/);
  }
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
  assert.match(readmeFor('win'), /Start osu! local profiles\.bat/);
  assert.match(readmeFor('osx'), /Start osu! local profiles\.command/);
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
