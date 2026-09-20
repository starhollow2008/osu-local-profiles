import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LIMITS,
  discoverInstalls,
  installScore,
  lnkTargets,
  looksLikeInstall,
  registryPaths,
  registryQueries,
  scanForInstalls,
  shortcutDirs,
  skipDir,
  storageIniPath,
} from '../src/clients/discover.ts';
import {
  stableInstall,
  windowsStableCandidates,
  type DetectEnvironment,
} from '../src/clients/detect.ts';

/*
 * Finding osu! where nobody would have guessed.
 *
 * The bug these exist for: somebody's osu!stable was at `D:\Games\osu!\osu!` and the app
 * told them it was not installed. Every tier of the fix is pinned here, because the whole
 * problem is that the paths cannot be checked by running the app -- running it on this
 * machine proves this machine's layout works, and this machine's layout was never the one
 * that broke.
 */

const WINDOWS: DetectEnvironment = {
  platform: 'win32',
  home: 'C:\\Users\\player',
  env: {
    APPDATA: 'C:\\Users\\player\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\player\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
  },
};

function tmpdir(): string {
  // realpath: a GitHub runner's TEMP is an 8.3 short name, and a path that is not canonical
  // is the one thing `fs.watch` aborts the process over. Same rule here, for the same reason.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'olp-discover-')));
}

/** A stable install with the files a played one has. */
function stableAt(root: string): string {
  fs.mkdirSync(path.join(root, 'Songs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Data', 'r'), { recursive: true });
  fs.writeFileSync(path.join(root, 'osu!.exe'), '');
  fs.writeFileSync(path.join(root, 'osu!.db'), '');
  fs.writeFileSync(path.join(root, 'osu!.player.cfg'), 'BeatmapDirectory = Songs\n');
  return root;
}

/* ------------------------------------------------- the folder that started it */

/**
 * The reported case, exactly: stable two folders deep on a second drive, beside a shelf of
 * practice copies and a backup, with lazer sitting in its default place on C:.
 */
test('stable on another drive, under a Games folder, beside its own backups', async () => {
  const tmp = tmpdir();
  try {
    const games = path.join(tmp, 'Games', 'osu!');
    const real = stableAt(path.join(games, 'osu!'));
    // Every one of these is a genuine osu! folder. Only the first is the one being played.
    const backup = stableAt(path.join(games, 'stablebackup'));
    stableAt(path.join(games, 'osu versions'));
    const prac = path.join(games, 'osu-prac-aim');
    fs.mkdirSync(prac, { recursive: true });
    fs.writeFileSync(path.join(prac, 'osu!.exe'), '');

    const found = await scanForInstalls([tmp]);
    assert.ok(found.includes(real), `expected to find ${real}, got ${found.join(', ')}`);
    assert.ok(found.includes(prac));

    // ...and the one with a database, a config and a recent mtime is the one preferred.
    const ranked = [...found].sort((a, b) => installScore(b) - installScore(a));
    assert.equal(ranked[0], real);
    // A folder that says "backup" in its name is pushed below one that does not.
    assert.ok(installScore(real) > installScore(backup));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/*
 * The cheap tier has to cover this shape too, so that the usual machine never reaches the
 * search at all. `D:\Games\osu!\osu!` is the nesting osu!'s installer produces when you
 * point it at a Games folder, and it was not on the old list.
 */
test('a Games folder on any drive is a place osu!stable is looked for', () => {
  const candidates = windowsStableCandidates(WINDOWS, ['C:\\', 'D:\\', 'F:\\']);
  assert.ok(candidates.includes(path.join('D:\\', 'Games', 'osu!', 'osu!')));
  assert.ok(candidates.includes(path.join('F:\\', 'Games', 'osu!')));
  assert.ok(candidates.includes(path.join('F:\\', 'osu!')));
  // The drive list is injected, so a machine with no D: still pins the same answers.
  assert.ok(!windowsStableCandidates(WINDOWS, ['C:\\']).some((p) => p.startsWith('D:')));
});

/* ------------------------------------------------ not every osu!.exe is stable */

/**
 * lazer's executable is also called `osu!.exe`, and there are two of them: the real one in
 * `osulazer\current\`, and a stub beside `Update.exe` in `osulazer\` itself.
 *
 * This never came up while detection only looked in a fixed list of places lazer's program
 * files are not. A search reaches both, and either would have been taken for a stable
 * install holding no scores -- and then *been* the answer, because the first hit wins.
 */
test('lazer\u2019s own osu!.exe is not mistaken for osu!stable', () => {
  const tmp = tmpdir();
  try {
    const container = path.join(tmp, 'osulazer');
    fs.mkdirSync(path.join(container, 'current'), { recursive: true });
    fs.writeFileSync(path.join(container, 'osu!.exe'), '');
    fs.writeFileSync(path.join(container, 'Update.exe'), '');
    fs.writeFileSync(path.join(container, 'current', 'osu!.exe'), '');
    fs.writeFileSync(path.join(container, 'current', 'osu.Game.dll'), '');

    assert.equal(stableInstall(container), null, 'the updater stub is not an install');
    assert.equal(stableInstall(path.join(container, 'current')), null, 'nor are the program files');

    // And a real stable, which has none of those files, still is one.
    assert.ok(stableInstall(stableAt(path.join(tmp, 'osu!'))));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- reading, not guessing */

test('lazer\u2019s storage.ini names the folder it was moved to', () => {
  // osu-framework writes bare `key = value` lines; a section header is tolerated anyway.
  assert.equal(storageIniPath('FullPath = D:\\osu!lazer\n'), 'D:\\osu!lazer');
  assert.equal(storageIniPath('[General]\r\nFullPath = D:\\lazer data\r\n'), 'D:\\lazer data');
  assert.equal(storageIniPath('Version = 1\n'), null);
  assert.equal(storageIniPath(''), null);
});

test('a path is pulled out of whatever shape the registry stored it in', () => {
  const output = [
    'HKEY_CLASSES_ROOT\\osu!\\shell\\open\\command',
    '    (Default)    REG_SZ    "D:\\Games\\osu!\\osu!\\osu!.exe" "%1"',
    '',
    'HKEY_CLASSES_ROOT\\osu!\\DefaultIcon',
    '    (Default)    REG_SZ    D:\\Games\\osu!\\osu!\\osu!.exe,1',
    '',
    'HKEY_CURRENT_USER\\...\\Uninstall\\osu!',
    '    InstallLocation    REG_SZ    D:\\Games\\osu!\\osu!',
    '    DisplayName    REG_SZ    osu!',
  ].join('\r\n');

  const paths = registryPaths(output);
  assert.ok(paths.includes('D:\\Games\\osu!\\osu!\\osu!.exe'));
  assert.ok(paths.includes('D:\\Games\\osu!\\osu!'));
  // A value that is not a path is not one.
  assert.ok(!paths.includes('osu!'));
});

test('the registry is asked about both hives, and about lazer as well as stable', () => {
  const keys = registryQueries();
  assert.ok(keys.some((k) => k.startsWith('HKCU\\Software\\Classes\\osu!')));
  assert.ok(keys.some((k) => k.startsWith('HKCR\\osu!')));
  assert.ok(keys.some((k) => k.includes('Uninstall\\osu!')));
  assert.ok(keys.some((k) => k.includes('Uninstall\\osulazer')));
});

/**
 * A shortcut stores its target twice, ANSI and UTF-16, and the path is a plain string in
 * both. Reading it that way rather than implementing the shell link format is the whole
 * trick, so both encodings are pinned.
 */
test('a shortcut\u2019s target is read out of the bytes, either encoding', () => {
  const target = 'D:\\Games\\osu!\\osu!\\osu!.exe';
  const lnk = Buffer.concat([
    Buffer.from('L\0\0\0\x01\x14\x02\0', 'latin1'),
    Buffer.from(target, 'latin1'),
    Buffer.from([0]),
    Buffer.from('\0\0padding\0\0', 'latin1'),
  ]);
  assert.deepEqual(lnkTargets(lnk), [target]);

  const wide = Buffer.concat([Buffer.from([0x4c, 0]), Buffer.from(target, 'utf16le')]);
  assert.deepEqual(lnkTargets(wide), [target]);

  // A shortcut to something else yields nothing rather than a wrong answer.
  assert.deepEqual(lnkTargets(Buffer.from('C:\\Windows\\notepad.exe', 'latin1')), []);
});

test('shortcuts are looked for where Windows keeps them, and nowhere on other platforms', () => {
  const dirs = shortcutDirs(WINDOWS);
  assert.ok(dirs.some((d) => d.endsWith(path.join('Start Menu', 'Programs'))));
  assert.ok(dirs.includes(path.join('C:\\Users\\player', 'Desktop')));
  assert.deepEqual(shortcutDirs({ platform: 'linux', home: '/home/player', env: {} }), []);
});

/* ------------------------------------------------------------- the search itself */

test('the search stops at an install rather than walking into it', async () => {
  const tmp = tmpdir();
  try {
    const root = stableAt(path.join(tmp, 'osu!'));
    // A nested folder that would also match, inside the install. Reaching it would mean the
    // walk had descended into a Songs/Data tree it has no business in.
    fs.mkdirSync(path.join(root, 'Data', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Data', 'inner', 'osu!.exe'), '');

    assert.deepEqual(await scanForInstalls([tmp]), [root]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the search respects its depth, count and time limits', async () => {
  const tmp = tmpdir();
  try {
    const deep = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    stableAt(deep);

    assert.deepEqual(
      await scanForInstalls([tmp], { ...DEFAULT_LIMITS, maxDepth: 3 }),
      [],
      'nothing below the depth limit is reached',
    );
    assert.deepEqual(await scanForInstalls([tmp], { ...DEFAULT_LIMITS, maxDepth: 8 }), [deep]);
    // A budget of nothing returns nothing rather than running anyway.
    assert.deepEqual(await scanForInstalls([tmp], { ...DEFAULT_LIMITS, timeBudgetMs: -1 }), []);
    assert.deepEqual(await scanForInstalls([tmp], { ...DEFAULT_LIMITS, maxDirs: 0 }), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unreadable directory is skipped, not fatal', async () => {
  const tmp = tmpdir();
  try {
    const root = stableAt(path.join(tmp, 'osu!'));
    assert.deepEqual(await scanForInstalls([tmp, path.join(tmp, 'does-not-exist')]), [root]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the directories that make a whole-disk walk impossible are skipped', () => {
  // Enormous by nature, and an install is never under one.
  for (const name of ['Songs', 'files', 'Windows', 'node_modules', '$Recycle.Bin', '.git']) {
    assert.ok(skipDir(name), `${name} should be skipped`);
  }
  assert.ok(skipDir('SONGS'), 'matching ignores case');
  // Merely common: the whole point of the search is the folder nobody predicted, so these
  // stay on the path.
  for (const name of ['Games', 'Data', 'Apps', 'osu!', 'Program Files']) {
    assert.ok(!skipDir(name), `${name} should not be skipped`);
  }
});

test('an install is recognised from the names the walk already has', () => {
  assert.ok(looksLikeInstall(['osu!.exe', 'Songs']));
  assert.ok(looksLikeInstall(['client.realm', 'files']));
  assert.ok(looksLikeInstall(['OSU!.EXE']));
  assert.ok(!looksLikeInstall(['Songs', 'Skins']));
});

/* ---------------------------------------------------------------- the whole thing */

test('a configured root wins, and searching never happens when it does', async () => {
  const tmp = tmpdir();
  try {
    const chosen = stableAt(path.join(tmp, 'chosen'));
    const lazer = path.join(tmp, 'lazer');
    fs.mkdirSync(path.join(lazer, 'files'), { recursive: true });
    fs.writeFileSync(path.join(lazer, 'client.realm'), '');

    const result = await discoverInstalls({
      configured: [chosen, lazer],
      env: { platform: 'linux', home: tmp, env: {} },
    });

    assert.equal(result.searched, false, 'both clients accounted for: nothing to search for');
    assert.deepEqual(
      result.installs.map((i) => i.root).sort(),
      [chosen, lazer].sort(),
    );
    assert.ok(result.candidates.every((c) => c.source === 'configured'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * The rule the reported bug turns on.
 *
 * lazer was found in its default place, so the old code considered the job done and reported
 * that osu!stable did not exist. The search has to run when *either* client is missing, not
 * only when both are.
 */
test('one client found is not a reason to stop looking for the other', async () => {
  const tmp = tmpdir();
  try {
    const lazer = path.join(tmp, 'lazer');
    fs.mkdirSync(path.join(lazer, 'files'), { recursive: true });
    fs.writeFileSync(path.join(lazer, 'client.realm'), '');
    const stable = stableAt(path.join(tmp, 'drive', 'Games', 'osu!', 'osu!'));

    const result = await discoverInstalls({
      configured: [lazer],
      env: { platform: 'linux', home: path.join(tmp, 'drive'), env: {} },
    });

    assert.equal(result.searched, true);
    assert.deepEqual(
      result.installs.map((i) => i.kind).sort(),
      ['lazer', 'stable'],
    );
    assert.ok(result.installs.some((i) => i.root === stable));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a search already done is not repeated, and what it found is remembered', async () => {
  const tmp = tmpdir();
  try {
    const stable = stableAt(path.join(tmp, 'deep', 'down', 'osu!'));
    const env: DetectEnvironment = { platform: 'linux', home: tmp, env: {} };

    // Told not to search, a missing client stays missing: that is the whole point of the
    // flag, and what keeps a lazer-only machine from walking its disks every launch.
    const skipped = await discoverInstalls({ noSearch: true, env });
    assert.equal(skipped.searched, false);
    assert.equal(skipped.installs.length, 0);

    // Remembered from a previous run, it needs no search to be found again.
    const again = await discoverInstalls({ remembered: [stable], noSearch: true, env });
    assert.equal(again.installs.length, 1);
    assert.equal(again.candidates[0]?.source, 'remembered');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a remembered folder that has been deleted is simply not a candidate', async () => {
  const tmp = tmpdir();
  try {
    const gone = path.join(tmp, 'uninstalled');
    const result = await discoverInstalls({
      remembered: [gone],
      noSearch: true,
      env: { platform: 'linux', home: tmp, env: {} },
    });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.installs, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
