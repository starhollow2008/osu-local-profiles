import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launcherFor, readmeFor, trayLauncherFor } from '../scripts/package-files.mjs';

/*
 * What a packaged build tells the user, on each platform.
 *
 * Only the Windows package has ever been built here, so the macOS and Linux scripts are
 * otherwise unread text that would first be seen by whoever downloads them. These pin the
 * parts that would be silently broken: the names each file manager opens and each earlier
 * release runs again, the executable bit, and the line that moves to the app's own folder --
 * without which the app looks for `data/` wherever the file manager started it and appears
 * to have lost every score.
 */

const unix = ['osx', 'linux'] as const;
const script = (os: 'osx' | 'linux') => {
  const launcher = launcherFor(os, 'node');
  assert.ok(launcher, `${os} has a script`);
  return launcher;
};

test('each platform gets the tray launcher its file manager opens', () => {
  assert.equal(trayLauncherFor('win').name, 'osu! local profiles.exe');
  // A bundle: Finder shows one app with its icon, and its Info.plist keeps it out of the Dock.
  assert.equal(trayLauncherFor('osx').name, 'osu! local profiles.app');
  assert.equal(trayLauncherFor('osx').executable, 'osu! local profiles.app/Contents/MacOS/osu-local-profiles');
  assert.equal(trayLauncherFor('linux').name, 'osu-local-profiles');
});

/*
 * 1.14 to 1.16 restart the app after an update by running `./<their own name>` again, from the
 * old launcher, once the new files are in. That file has to exist in the new build, or the
 * first update to it ends with nothing started.
 */
test("the unix scripts keep the names earlier releases' launchers run again after an update", () => {
  assert.equal(launcherFor('win', 'node.exe'), null);
  assert.equal(script('osx').name, 'Start osu! local profiles.command');
  assert.equal(script('linux').name, 'start.sh');
  for (const os of unix) assert.equal(script(os).mode, 0o755);
});

test('every script moves to its own folder before starting anything', () => {
  for (const os of unix) assert.match(script(os).content, /cd "\$\(dirname "\$0"\)"/);
});

test('the scripts start the tray launcher beside them, never one from PATH', () => {
  assert.match(script('osx').content, /^open "\.\/osu! local profiles\.app"$/m);
  assert.match(script('linux').content, /setsid \.\/osu-local-profiles </);
  assert.match(script('linux').content, /nohup \.\/osu-local-profiles </);
});

test('with no desktop, start.sh runs the app in its terminal and restarts it after an update', () => {
  const { content } = script('linux');
  assert.match(content, /if \[ -n "\$DISPLAY" \] \|\| \[ -n "\$WAYLAND_DISPLAY" \]; then/);
  assert.match(content, /^OSU_LOCAL_PROFILES_LAUNCHER=restarts \.\/node src\/main\.ts$/m);
  // macOS always has a menu bar, so its script never runs the app itself.
  assert.doesNotMatch(script('osx').content, /\.\/node src\/main\.ts/);
});

/* ------------------------------------------------- the incomplete-folder guard */

/*
 * Nothing in this app needs installing, so a missing file is never a missing prerequisite:
 * it is an incomplete download, a half-finished extraction, or antivirus having taken the
 * runtime. The tray launcher says the same in a dialog (tools/launcher, main.go).
 */
test('a script whose folder is incomplete says so instead of failing obscurely', () => {
  assert.match(
    script('linux').content,
    /if \[ ! -f \.\/node \] \|\| \[ ! -f src\/main\.ts \] \|\| \[ ! -e "\.\/osu-local-profiles" \]; then/,
  );
  assert.match(script('osx').content, /\[ ! -e "\.\/osu! local profiles\.app" \]/);
  for (const os of unix) assert.match(script(os).content, /this folder is incomplete/);
});

test('the guard says nothing needs installing, and where to get the archive', () => {
  for (const os of unix) {
    assert.match(script(os).content, /Nothing needs installing/);
    assert.match(script(os).content, /github\.com\/jonathant09\/osu-local-profiles\/releases/);
  }
});

/* A zip extracted by a tool that drops permissions leaves the programs present and unrunnable;
 * `sh` reports only "Permission denied", which says nothing about how to fix it. */
test('the scripts tell the user how to restore a lost executable bit', () => {
  for (const os of unix) {
    const { content } = script(os);
    assert.match(content, /if \[ ! -x \.\/node \] \|\| \[ ! -x "\.\//);
    assert.match(content, /chmod \+x \.\/node tools\/pp\/osu-pp '/);
  }
});

test('the scripts start with a shebang and use forward slashes', () => {
  for (const os of unix) {
    const { content } = script(os);
    assert.ok(content.startsWith('#!/bin/sh\n'), 'needs a shebang to be runnable');
    assert.ok(!content.includes('\\'), 'a backslash path would not resolve on unix');
    assert.ok(!content.includes('\r'), 'CR would break the shebang line on some shells');
  }
});

/* ------------------------------------------------------------------ README */

/*
 * macOS refuses to open the build the first time, and Windows questions it: neither is signed
 * by a paid account. Someone meeting that with no explanation concludes the build is broken,
 * so the README has to say it plainly and give the way round it.
 */
test('the macOS README explains Gatekeeper, because it will happen', () => {
  const readme = readmeFor('osx');
  assert.match(readme, /Privacy & Security/);
  assert.match(readme, /Open Anyway/);
  assert.match(readme, /xattr -dr com\.apple\.quarantine \./);
});

test('the Windows README explains the unrecognised-app warning', () => {
  assert.match(readmeFor('win'), /More info, then Run\s+anyway/);
});

test('each README says where the app is while it runs, and how to stop it', () => {
  assert.match(readmeFor('win'), /system tray/);
  assert.match(readmeFor('osx'), /menu bar/);
  assert.match(readmeFor('osx'), /no Dock icon/);
  assert.match(readmeFor('linux'), /system tray/);
  for (const os of ['win', 'osx', 'linux'] as const) {
    assert.match(readmeFor(os), /Quit/);
    assert.match(readmeFor(os), /Starting it again while\s+it runs opens the page/);
    assert.doesNotMatch(readmeFor(os), /console window/);
  }
});

test('the Linux README says how to restore a lost executable bit', () => {
  assert.match(readmeFor('linux'), /chmod \+x start\.sh node osu-local-profiles tools\/pp\/osu-pp/);
});

test('each README names the launcher that platform actually has', () => {
  assert.match(readmeFor('win'), /osu! local profiles\.exe/);
  assert.match(readmeFor('osx'), /Double-click "osu! local profiles"/);
  assert.match(readmeFor('linux'), /\.\/osu-local-profiles/);
  assert.ok(!readmeFor('win').includes('start.sh'));
  assert.ok(!readmeFor('win').includes('.bat'));
});

test('every README says how to point it at osu! by hand', () => {
  for (const os of ['win', 'osx', 'linux'] as const) assert.match(readmeFor(os), /installRoots/);
});

test('the Windows README is CRLF so Notepad can read it', () => {
  assert.ok(readmeFor('win').includes('\r\n'));
  assert.ok(!readmeFor('linux').includes('\r\n'));
});
