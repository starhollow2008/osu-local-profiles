import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogWatcher } from '../src/tracker/log-watcher.ts';
import { watchablePath } from '../src/tracker/watcher.ts';
import type { ResolvedLoggedPlay } from '../src/clients/lazer-log.ts';

/*
 * Following lazer's live log. The parser is tested on its own in lazer-log.test.ts; what is
 * exercised here is everything around it -- byte offsets, a read landing mid-line, the game
 * being restarted underneath a running app, and the rule that following starts at the end
 * of what is already there.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real tokens are the numeric ids osu! issues; the parser will not accept anything else. */
const TOKEN = '1775729216';

/** Long enough for the watcher's own debounce plus the filesystem event. */
const SETTLED_MS = 1200;

function quitLines(token: string, beatmap: string): string {
  return `2026-09-10 01:11:55 [verbose]: Game-wide working beatmap updated to ${beatmap}
2026-09-10 01:11:56 [verbose]: Score submission token retrieved (${token})
2026-09-10 01:11:56 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
2026-09-10 01:12:59 [verbose]: Score submission completed! (token:${token} id:7446699999)
2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
`;
}

interface Fixture {
  dir: string;
  seen: ResolvedLoggedPlay[];
  watcher: LogWatcher;
  waitFor: (n: number) => Promise<void>;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-logs-'));
  const seen: ResolvedLoggedPlay[] = [];
  const watcher = new LogWatcher({
    dirs: [dir],
    onPlays: (plays) => seen.push(...plays),
    onError: () => {
      /* the tracker reports these; here they must not fail the run */
    },
  });

  return {
    dir,
    seen,
    watcher,
    waitFor: async (n) => {
      for (let i = 0; i < 40 && seen.length < n; i++) await sleep(100);
    },
    cleanup: () => {
      watcher.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a play appended to the live log is picked up', async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.dir, '1000.runtime.log');
    fs.writeFileSync(runtime, '');
    fs.writeFileSync(
      path.join(f.dir, '1000.network.log'),
      `2026-09-10 01:12:59 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores/${TOKEN} successfully completed!\n`,
    );

    f.watcher.start();
    /*
     * Let the watch come up before writing, as every other test here does. This is the first
     * `fs.watch` in the process, and on macOS that is when libuv starts its FSEvents thread:
     * a write landing while that is still starting can go unreported. CI's macOS runner lost
     * exactly that race. The app is not exposed to it -- reads go by byte offset, so the next
     * append collects anything a missed event covered, and lazer's log is written constantly.
     * Only a test that appends once, instantly, can see the difference.
     */
    await sleep(SETTLED_MS);
    fs.appendFileSync(runtime, quitLines(TOKEN, 'Artist - Title (Creator) [Insane]'));
    await f.waitFor(1);

    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.passed, false);
    // The beatmap comes from the network log, joined on the token.
    assert.equal(f.seen[0]!.beatmapId, 5438074);
  } finally {
    f.cleanup();
  }
});

/*
 * The same rule the replay watcher follows: a profile records what was played while it was
 * tracking. Reading back through a log written before the app opened would import an
 * evening of plays nobody asked for.
 */
test('what was already in the log when tracking began is not imported', async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.dir, '1000.runtime.log');
    fs.writeFileSync(runtime, quitLines('1775700001', 'Artist - Old (Creator) [Insane]'));

    f.watcher.start();
    await sleep(SETTLED_MS);
    assert.equal(f.seen.length, 0);

    // ...but a play made from now on is.
    fs.appendFileSync(runtime, quitLines('1775700002', 'Artist - New (Creator) [Insane]'));
    await f.waitFor(1);
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.token, '1775700002');
  } finally {
    f.cleanup();
  }
});

/*
 * lazer flushes its log when it feels like it, so a read routinely lands part-way through a
 * line. Splitting a submission across two writes must not lose the play.
 */
test('a line split across two writes is still read whole', async () => {
  const f = fixture();
  try {
    const runtime = path.join(f.dir, '1000.runtime.log');
    fs.writeFileSync(runtime, '');
    f.watcher.start();

    const text = quitLines(TOKEN, 'Artist - Title (Creator) [Insane]');
    const cut = Math.floor(text.length / 2);
    fs.appendFileSync(runtime, text.slice(0, cut));
    await sleep(SETTLED_MS);
    fs.appendFileSync(runtime, text.slice(cut));
    await f.waitFor(1);

    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.token, TOKEN);
  } finally {
    f.cleanup();
  }
});

/* The game being restarted while the app keeps running. That session is tracked in full. */
test('a session started after tracking began is followed from its first line', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, '1000.runtime.log'), '');
    f.watcher.start();
    await sleep(SETTLED_MS);

    fs.writeFileSync(
      path.join(f.dir, '2000.runtime.log'),
      quitLines('1775700003', 'Artist - Later (Creator) [Insane]'),
    );
    await f.waitFor(1);

    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.token, '1775700003');
  } finally {
    f.cleanup();
  }
});

test('a directory that does not exist is not an error', () => {
  const watcher = new LogWatcher({
    dirs: [path.join(os.tmpdir(), 'olp-logs-definitely-not-here')],
    onPlays: () => assert.fail('nothing should be reported'),
  });
  watcher.start();
  watcher.stop();
});

/*
 * The guard against replaying a finished session. Sessions are ordered by the name lazer
 * gave them -- when the session started -- not by modification time, which can move on an
 * older file for reasons that have nothing to do with a play: a backup, a virus scanner,
 * an editor. Following the wrong one would re-read it from the top and count every play in
 * it a second time.
 */
test('an older session touched later does not take over', async () => {
  const f = fixture();
  try {
    const older = path.join(f.dir, '1000.runtime.log');
    const current = path.join(f.dir, '2000.runtime.log');
    fs.writeFileSync(older, quitLines('1775700004', 'Artist - Old (Creator) [Insane]'));
    fs.writeFileSync(current, '');

    f.watcher.start();
    // Give the old file the newest mtime, then poke the directory so a read happens.
    const now = new Date();
    fs.utimesSync(older, now, now);
    fs.appendFileSync(current, '2026-09-10 01:00:00 [verbose]: nothing of interest\n');
    await sleep(SETTLED_MS);

    assert.equal(f.seen.length, 0);
  } finally {
    f.cleanup();
  }
});

/*
 * The crash CI found, which no local run reproduces.
 *
 * On Windows libuv compares the filename `ReadDirectoryChangesW` reports against the path
 * `fs.watch` was given, and *aborts the process* when they differ:
 *
 *     Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
 *
 * They differ when the watched path is not the canonical one -- an 8.3 short name such as
 * `C:\Users\RUNNER~1\...`, which is exactly what a GitHub runner's TEMP is. It is an abort
 * inside the runtime rather than an error, so there is nothing to catch: the process dies,
 * which is how this took two unrelated test files down with it and why nothing here caught
 * it first.
 *
 * That exact condition cannot be manufactured on a machine whose temp directory is already
 * canonical, so what is pinned here is the fix rather than the crash: `watchablePath` must
 * hand `fs.watch` the resolved path. A junction is the same class of mismatch and is
 * something a real user can have -- an osu! folder moved to another drive and linked back
 * into place.
 */
test('a watched path is resolved to its canonical form before being watched', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-real-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'olp-link-')), 'logs');

  try {
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // no permission to link here; nothing to prove
    }

    assert.equal(watchablePath(link), fs.realpathSync.native(real));
    assert.notEqual(watchablePath(link), link);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

/** A path that cannot be resolved is handed through, for fs.watch itself to reject. */
test('an unresolvable path is passed through rather than thrown on', () => {
  const missing = path.join(os.tmpdir(), 'olp-definitely-not-here');
  assert.equal(watchablePath(missing), missing);
});

/* And the whole watcher still works when reached that way. */
test('a directory reached through a junction is still watched', async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-logs-real-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'olp-logs-link-')), 'logs');

  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.rmSync(real, { recursive: true, force: true });
    return;
  }

  const seen: ResolvedLoggedPlay[] = [];
  const watcher = new LogWatcher({
    dirs: [link],
    onPlays: (plays) => seen.push(...plays),
    onError: () => {},
  });

  try {
    const runtime = path.join(link, '1000.runtime.log');
    fs.writeFileSync(runtime, '');
    watcher.start();

    fs.appendFileSync(runtime, quitLines(TOKEN, 'Artist - Title (Creator) [Insane]'));
    for (let i = 0; i < 40 && seen.length < 1; i++) await sleep(100);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.token, TOKEN);
  } finally {
    watcher.stop();
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});
