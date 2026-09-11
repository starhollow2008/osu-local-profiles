import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectInstalls,
  lazerCandidates,
  lazerInstall,
  stableInstall,
  wineStableCandidates,
  wineStableRoots,
  type DetectEnvironment,
} from '../src/clients/detect.ts';
import { explainWatchError } from '../src/tracker/watcher.ts';

/*
 * Where osu! is, on machines this one is not.
 *
 * These are the only tests in the project that can check macOS and Linux behaviour, because
 * they are the only part of it that is a pure function of the platform. Everything else on
 * those systems needs one to run on. Running the app on Windows proves Windows works and
 * nothing more, so the paths are pinned here instead.
 */

const WINDOWS: DetectEnvironment = {
  platform: 'win32',
  home: 'C:\\Users\\player',
  env: { APPDATA: 'C:\\Users\\player\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\player\\AppData\\Local' },
};

const MACOS: DetectEnvironment = {
  platform: 'darwin',
  home: '/Users/player',
  env: {},
};

const LINUX: DetectEnvironment = {
  platform: 'linux',
  home: '/home/player',
  env: {},
};

/* ------------------------------------------------------------------ lazer */

test('lazer is looked for where each platform actually keeps it', () => {
  assert.ok(
    lazerCandidates(WINDOWS).includes(path.join('C:\\Users\\player\\AppData\\Roaming', 'osu')),
  );
  assert.ok(
    lazerCandidates(MACOS).includes(
      path.join('/Users/player', 'Library', 'Application Support', 'osu'),
    ),
  );
  assert.ok(
    lazerCandidates(LINUX).includes(path.join('/home/player', '.local', 'share', 'osu')),
  );
});

/*
 * The bug this pins: the Linux and macOS paths were built from `process.env.HOME`, so a
 * process started without it looked for lazer in a directory called "undefined". They come
 * from os.homedir() now, which has an answer either way.
 */
test('lazer is still found with no HOME in the environment', () => {
  const bare: DetectEnvironment = { platform: 'linux', home: '/home/player', env: {} };
  const found = lazerCandidates(bare);
  assert.ok(found.every((p) => !p.includes('undefined')));
  assert.ok(found.length >= 2);
});

test('XDG_DATA_HOME moves the Linux location', () => {
  const e: DetectEnvironment = { ...LINUX, env: { XDG_DATA_HOME: '/data/xdg' } };
  assert.ok(lazerCandidates(e).includes(path.join('/data/xdg', 'osu')));
});

/* The spec says a relative XDG_DATA_HOME is invalid and must be ignored, not resolved. */
test('a relative XDG_DATA_HOME is ignored rather than resolved', () => {
  const e: DetectEnvironment = { ...LINUX, env: { XDG_DATA_HOME: 'relative/path' } };
  assert.ok(lazerCandidates(e).includes(path.join('/home/player', '.local', 'share', 'osu')));
  assert.ok(!lazerCandidates(e).some((p) => p.includes('relative')));
});

/* ----------------------------------------------------------------- stable */

test('the macOS Wineskin wrappers are looked inside', () => {
  const found = wineStableCandidates(MACOS);
  // Wineskin puts the prefix beside Contents, not within it, which looks wrong and is right.
  assert.ok(found.includes(path.join('/Applications', 'osu!.app', 'drive_c', 'osu!')));
  assert.ok(
    found.includes(path.join('/Applications', 'osu!.app', 'drive_c', 'Program Files', 'osu!')),
  );
  assert.ok(
    found.includes(path.join('/Users/player', 'Applications', 'osu!.app', 'drive_c', 'osu!')),
  );
});

test('a plain wine prefix is looked inside, default or configured', () => {
  assert.ok(
    wineStableCandidates(LINUX).includes(
      path.join('/home/player', '.wine', 'drive_c', 'Program Files', 'osu!'),
    ),
  );
  const e: DetectEnvironment = { ...LINUX, env: { WINEPREFIX: '/prefixes/osu' } };
  assert.ok(
    wineStableCandidates(e).includes(path.join('/prefixes/osu', 'drive_c', 'Program Files', 'osu!')),
  );
});

test('osu-winello\u2019s prefix is looked inside', () => {
  assert.ok(
    wineStableCandidates(LINUX).some((p) =>
      p.includes(path.join('wineprefixes', 'osu-wineprefix')),
    ),
  );
});

/*
 * osu-winello lets the user choose where osu! goes and writes the answer down, so there is
 * nothing to guess -- only something to read. Most Linux players run stable this way.
 */
test('osu-winello\u2019s recorded install path is read, not guessed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const data = path.join(tmp, 'data');
    fs.mkdirSync(path.join(data, 'osuconfig'), { recursive: true });
    fs.writeFileSync(path.join(data, 'osuconfig', 'osupath'), '/games/osu!\n');

    const e: DetectEnvironment = { ...LINUX, home: tmp, env: { XDG_DATA_HOME: data } };
    assert.ok(wineStableRoots(e).includes('/games/osu!'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a missing wine prefix is the normal case, not an error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const e: DetectEnvironment = { ...LINUX, home: tmp, env: { XDG_DATA_HOME: path.join(tmp, 'x') } };
    assert.deepEqual(wineStableRoots(e), []);
    // And the fixed candidates are still offered, they just will not exist.
    assert.ok(wineStableCandidates(e).length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('wine\u2019s per-user profile is listed rather than assumed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const users = path.join(tmp, 'prefix', 'drive_c', 'users');
    fs.mkdirSync(path.join(users, 'someone'), { recursive: true });

    const e: DetectEnvironment = { ...LINUX, home: tmp, env: { WINEPREFIX: path.join(tmp, 'prefix') } };
    assert.ok(
      wineStableRoots(e).includes(path.join(users, 'someone', 'AppData', 'Local', 'osu!')),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- classifying a root */

test('an install is recognised by its marker, not by its path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const lazer = path.join(tmp, 'anywhere-at-all');
    fs.mkdirSync(path.join(lazer, 'files'), { recursive: true });
    fs.writeFileSync(path.join(lazer, 'client.realm'), '');

    const found = lazerInstall(lazer);
    assert.ok(found);
    assert.equal(found.kind, 'lazer');
    assert.equal(found.replayDir, path.join(lazer, 'files'));
    assert.equal(found.onlineDb, null);
    assert.equal(stableInstall(lazer), null);

    const stable = path.join(tmp, 'osu!');
    fs.mkdirSync(path.join(stable, 'Songs'), { recursive: true });
    fs.writeFileSync(path.join(stable, 'osu!.exe'), '');

    const s = stableInstall(stable);
    assert.ok(s);
    assert.equal(s.kind, 'stable');
    assert.equal(s.replayDir, path.join(stable, 'Data', 'r'));
    assert.deepEqual(s.beatmapRoots, [path.join(stable, 'Songs')]);
    assert.equal(lazerInstall(stable), null);

    // `files/` alone is not lazer: plenty of directories have one.
    const decoy = path.join(tmp, 'decoy');
    fs.mkdirSync(path.join(decoy, 'files'), { recursive: true });
    assert.equal(lazerInstall(decoy), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/*
 * `installRoots` in config.json is what the app tells the user to set when nothing is
 * found, and on macOS and Linux there is no official stable build to detect -- only
 * community Wine wrappers with layouts that cannot all be anticipated. It was documented
 * and printed in that error message while nothing actually read it.
 */
test('a configured install root is used, and classified by what is in it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const stable = path.join(tmp, 'somewhere', 'weird', 'osu!');
    fs.mkdirSync(stable, { recursive: true });
    fs.writeFileSync(path.join(stable, 'osu!.exe'), '');

    // A home with nothing in it, so only the configured root can match.
    const e: DetectEnvironment = { ...LINUX, home: tmp, env: {} };
    const found = detectInstalls([stable], e);

    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind, 'stable');
    assert.equal(found[0]!.root, stable);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a configured root that holds nothing is ignored, not fatal', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-detect-'));
  try {
    const e: DetectEnvironment = { ...LINUX, home: tmp, env: {} };
    assert.deepEqual(detectInstalls([path.join(tmp, 'nope')], e), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------- watch failures */

/*
 * The Linux failure mode worth naming. Recursive `fs.watch` is one handle on Windows, but
 * the Linux kernel watches a single directory at a time, so Node adds an inotify watch per
 * directory -- and lazer's store is thousands of them. Over the limit it fails with
 * `ENOSPC`, which reads as "the disk is full" and is not.
 */
test('the inotify watch limit is explained rather than reported as ENOSPC', () => {
  const err = Object.assign(new Error('watch /home/player/.local/share/osu ENOSPC'), {
    code: 'ENOSPC',
  });
  const explained = explainWatchError(err);

  if (process.platform === 'linux') {
    assert.match(explained, /inotify watch limit, not disk space/);
    assert.match(explained, /max_user_watches/);
  } else {
    // Nothing to explain elsewhere: ENOSPC there really would be about space.
    assert.equal(explained, err.message);
  }
});

test('an ordinary watch error is passed through unchanged', () => {
  const err = Object.assign(new Error('watch /nope EPERM'), { code: 'EPERM' });
  assert.equal(explainWatchError(err), 'watch /nope EPERM');
});
