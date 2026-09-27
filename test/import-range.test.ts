import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/http/server.ts';
import { listDeclines } from '../src/tracker/declined.ts';
import { attemptLog, harness, SINCE, stableReplay } from './import-fixture.ts';

/*
 * Import past plays over a range, and over everything.
 *
 * An import used to run from a cutoff to now. It can now end earlier -- an evening last week,
 * without the week since -- and start at the earliest play on this computer (`since` 0, the
 * dialog's All). Both ends are matched against the time inside the play, never a file's
 * mtime: a replay is written when its play ends, so an mtime can only ever rule a play *out*
 * of a start, never out of an end.
 */

const HOUR = 3_600_000;
const EVERYTHING = { replays: true, unfinished: true, attempts: true };

test('an import over a range brings in what was played inside it, and nothing after', async () => {
  const h = await harness();
  try {
    // Three evenings' plays, and a replay somebody else set in the last of them.
    for (const n of [1, 2, 3]) {
      h.write(`play-${n}.osr`, stableReplay({ player: 'Tangy', playedAt: SINCE + n * HOUR, total: 900_000 + n }));
    }
    h.write('watched.osr', stableReplay({ player: 'mrekk', playedAt: SINCE + 3 * HOUR, onlineId: 900_000_001n }));

    const since = SINCE + 1.5 * HOUR;
    const until = SINCE + 2.5 * HOUR;
    const preview = await h.tracker.previewBackfill(since, true, until);
    assert.equal(preview.importable, 1, 'only the play inside the range');
    assert.deepEqual(preview.otherPlayers, [], 'the watched replay is outside it');
    assert.equal(preview.earliest, SINCE + 2 * HOUR);

    const result = await h.tracker.backfill(since, undefined, true, 'import', until);
    assert.equal(result.imported, 1, 'the import matches its preview');
    assert.equal(result.until, until);
    const played = h.db.prepare('SELECT played_at FROM scores').all() as { played_at: number }[];
    assert.deepEqual(played.map((r) => r.played_at), [SINCE + 2 * HOUR]);
    // Turned away only inside the range: a replay outside it was never looked at.
    assert.equal(listDeclines(h.db, h.profileId).length, 0);

    // All: every play on this computer, the one already tracked left alone.
    const all = await h.tracker.previewBackfill(0);
    assert.equal(all.importable, 2);
    assert.equal(all.duplicates, 1);
    assert.equal((await h.tracker.backfill(0)).imported, 2);
    assert.equal(h.count('scores'), 3);
    assert.equal(listDeclines(h.db, h.profileId)[0]!.player, 'mrekk');
  } finally {
    h.cleanup();
  }
});

test('lazer’s log is read over the same range', async () => {
  // Three attempts osu! could not submit, ending 10:10, 11:10 and 12:10.
  const h = await harness(
    [attemptLog(1, '10:05:00', '10:10:00'), attemptLog(2, '11:05:00', '11:10:00'), attemptLog(3, '12:05:00', '12:10:00')].join('\n'),
  );
  try {
    const at = (time: string) => Date.parse(`2026-09-07T${time}Z`);
    const preview = await h.tracker.previewBackfill(at('10:30:00'), true, at('11:30:00'));
    assert.equal(preview.log.attempts, 1);
    assert.equal(preview.log.earliest, at('11:10:00'));

    const result = await h.tracker.backfill(at('10:30:00'), EVERYTHING, true, 'import', at('11:30:00'));
    assert.equal(result.attempts, 1);

    // Everything before a moment: from the earliest, up to an end.
    const before = await h.tracker.previewBackfill(0, true, at('11:30:00'));
    assert.equal(before.log.attempts, 1, 'the 10:10 attempt; 11:10 is in already');
    assert.equal(before.log.alreadyTracked, 1);

    assert.equal((await h.tracker.backfill(0, EVERYTHING)).attempts, 2);
    assert.equal(h.count('incomplete_plays'), 3);
  } finally {
    h.cleanup();
  }
});

test('the server takes a range, and All, and refuses one that ends before it starts', async () => {
  const h = await harness();
  const server = startServer({
    db: h.db,
    tracker: h.tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir: path.dirname(h.replays),
    port: 0,
    appConfig: { get: () => ({}) as never, set: () => undefined },
  });
  try {
    const { port } = server.address() as AddressInfo;
    h.write('play.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + HOUR }));
    const preview = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/backfill/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const all = await preview({ since: 0 });
    assert.equal(all.status, 200, 'since 0 is All');
    assert.equal(((await all.json()) as { importable: number }).importable, 1);

    const before = await preview({ since: SINCE, until: SINCE + HOUR / 2 });
    assert.equal(((await before.json()) as { importable: number }).importable, 0, 'the play is after the end');

    // An end still to come is the same range as one ending now.
    const future = (await (await preview({ since: SINCE, until: Date.now() + HOUR })).json()) as {
      until: number | null;
      importable: number;
    };
    assert.deepEqual({ until: future.until, importable: future.importable }, { until: null, importable: 1 });

    assert.equal((await preview({ since: SINCE, until: SINCE })).status, 400, 'an empty range');
    assert.equal((await preview({ since: SINCE, until: SINCE - HOUR })).status, 400, 'a backwards one');
    assert.equal((await preview({ since: SINCE, until: 'soon' })).status, 400);
    assert.equal((await preview({ since: -1 })).status, 400);
  } finally {
    server.close();
    h.cleanup();
  }
});
