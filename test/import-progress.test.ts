import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImportState } from '../src/tracker/index.ts';
import { harness, SINCE, stableReplay } from './import-fixture.ts';

/*
 * An import's progress (issue #12): the dialog and the cover's corner show how far it has got,
 * and closing the dialog changes nothing, because the import runs on the server. What must hold:
 * it reads as running from the moment it is asked for until the last one queued has finished,
 * and it ends with every play it found counted.
 */

test('an import says how far it has got, and when it has finished', async () => {
  const h = await harness();
  try {
    h.write('one.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 60_000, onlineId: 900_000_011n }));
    h.write('two.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 120_000, onlineId: 900_000_012n, total: 900_000 }));

    const seen: ImportState[] = [];
    h.tracker.on('importing', (s) => seen.push(s));
    assert.equal(h.tracker.importState.active, false);

    const run = h.tracker.backfill(SINCE);
    assert.equal(h.tracker.importState.active, true, 'running as soon as it is asked for');
    const result = await run;

    assert.equal(result.imported, 2);
    assert.deepEqual(seen[0], { active: true, phase: 'scanning', scanned: 0, files: 0, done: 0, total: 0, origin: 'import' });
    assert.ok(seen.some((s) => s.active && s.phase === 'importing' && s.total === 2), 'the plays found are counted');
    const last = seen.at(-1)!;
    assert.equal(last.active, false);
    assert.equal(last.phase, 'importing');
    assert.equal(last.done, 2);
    assert.equal(last.total, 2);
    assert.ok(last.scanned >= 2);
    assert.equal(last.files, last.scanned, 'the files were counted before they were looked through');
    assert.equal(h.tracker.importState.active, false);
  } finally {
    h.cleanup();
  }
});

test('an import queued behind another keeps it reading as running', async () => {
  const h = await harness();
  try {
    h.write('one.osr', stableReplay({ player: 'Tangy', playedAt: SINCE + 60_000 }));
    const finished: ImportState[] = [];
    h.tracker.on('importing', (s) => {
      if (!s.active) finished.push(s);
    });

    const first = h.tracker.backfill(SINCE);
    const second = h.tracker.backfill(SINCE, undefined, true, 'catch-up');
    await first;
    assert.equal(h.tracker.importState.active, true, 'the second is still to run');
    await second;
    assert.equal(finished.length, 1, 'finished once, after both');
    assert.equal(finished[0]!.origin, 'catch-up');
  } finally {
    h.cleanup();
  }
});
