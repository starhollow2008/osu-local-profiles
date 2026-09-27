import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/http/server.ts';
import { createBackup, isProfileFile } from '../src/backup.ts';
import { readZipEntries } from '../src/update/zip.ts';
import { deleteDeclines, listDeclines } from '../src/tracker/declined.ts';
import { pruneUploadedReplays, releaseUploadedReplay } from '../src/uploaded-replays.ts';
import { updateSettings } from '../src/settings.ts';
import { harness, SINCE, stableReplay, type Harness } from './import-fixture.ts';

/*
 * Replay files uploaded to Import past plays (src/uploaded-replays.ts).
 *
 * Usually ones downloaded from osu!'s website that osu! itself no longer has. What must hold: a
 * copy is kept in data/replays only while something points at it, the upload goes through every
 * check an import makes, and Back up everything carries the copy -- it may be the only one.
 */

const HOUR = 3_600_000;

async function withServer(run: (h: Harness, upload: (bytes: Buffer, query?: string) => Promise<Response>, dataDir: string) => Promise<void>) {
  const h = await harness();
  const dataDir = path.join(path.dirname(h.replays), 'data');
  fs.mkdirSync(dataDir);
  const server = startServer({
    db: h.db,
    tracker: h.tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir,
    port: 0,
    appConfig: { get: () => ({}) as never, set: () => undefined },
  });
  const { port } = server.address() as AddressInfo;
  const upload = (bytes: Buffer, query = '') =>
    fetch(`http://127.0.0.1:${port}/api/replays${query}`, { method: 'POST', body: new Uint8Array(bytes) });
  try {
    await run(h, upload, dataDir);
  } finally {
    server.close();
    h.cleanup();
  }
}

const stored = (dataDir: string) => {
  const dir = path.join(dataDir, 'replays');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('an uploaded replay is imported, and its copy kept for as long as the score needs it', async () => {
  await withServer(async (h, upload, dataDir) => {
    const bytes = stableReplay({ player: 'Tangy', playedAt: SINCE + HOUR });
    const md5 = crypto.createHash('md5').update(bytes).digest('hex');

    const first = (await (await upload(bytes)).json()) as { status: string };
    assert.equal(first.status, 'added');
    assert.deepEqual(stored(dataDir), [`${md5}.osr`], 'named by its contents');
    const row = h.db.prepare('SELECT replay_path FROM scores').get() as { replay_path: string };
    assert.equal(row.replay_path, path.join(dataDir, 'replays', `${md5}.osr`), 'the score points at the copy');

    // The same file again is the same score, and the copy stays: the score still needs it.
    const again = (await (await upload(bytes)).json()) as { status: string; reason: string };
    assert.deepEqual({ status: again.status, reason: again.reason }, { status: 'skipped', reason: 'duplicate' });
    assert.equal(h.count('scores'), 1);
    assert.deepEqual(stored(dataDir), [`${md5}.osr`]);

    // Back up everything carries it: this copy may be the only one there is.
    assert.equal(isProfileFile(`replays/${md5}.osr`), true);
    const names = readZipEntries(createBackup(h.db, dataDir)).map((e) => e.name);
    assert.ok(names.includes(`replays/${md5}.osr`), names.join(', '));
  });
});

test('an upload of a play already here from osu!’s own folder keeps no copy', async () => {
  await withServer(async (h, upload, dataDir) => {
    const bytes = stableReplay({ player: 'Tangy', playedAt: SINCE + HOUR });
    h.write('in-osu.osr', bytes);
    assert.equal((await h.tracker.backfill(SINCE)).imported, 1);

    const result = (await (await upload(bytes)).json()) as { reason: string };
    assert.equal(result.reason, 'duplicate');
    assert.deepEqual(stored(dataDir), [], 'nothing points at it, so it is not kept');
  });
});

test('an upload goes through every check an import makes, and the filter box', async () => {
  await withServer(async (h, upload, dataDir) => {
    // Somebody else's replay: turned away, listed, and kept so Track anyway can read it.
    const theirs = (await (await upload(stableReplay({ player: 'mrekk', playedAt: SINCE, onlineId: 900_000_001n }))).json()) as {
      reason: string;
    };
    assert.equal(theirs.reason, 'another-player');
    const [listed] = listDeclines(h.db, h.profileId);
    assert.equal(listed!.player, 'mrekk');
    assert.equal(stored(dataDir).length, 1);
    assert.equal((await h.tracker.trackAnyway(listed!.id)).status, 'tracked', 'from the kept copy');

    // The filter applies, unless the dialog's box was unticked for this import.
    updateSettings(h.db, h.profileId, { trackingFilter: { enabled: true, modes: [1] } });
    const filtered = (await (await upload(stableReplay({ player: 'Tangy', playedAt: SINCE + HOUR }))).json()) as {
      status: string;
    };
    assert.equal(filtered.status, 'filtered');
    const unfiltered = (await (await upload(stableReplay({ player: 'Tangy', playedAt: SINCE + 2 * HOUR }), '?applyFilter=0')).json()) as {
      status: string;
    };
    assert.equal(unfiltered.status, 'added');
  });
});

test('a file that is not a replay is refused, and nothing is kept', async () => {
  await withServer(async (h, upload, dataDir) => {
    const res = await upload(Buffer.from('this is a text file, not a replay'));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not an osu! replay/);
    assert.deepEqual(stored(dataDir), []);
    assert.equal(h.count('scores'), 0);
  });
});

/*
 * A copy is kept only while something points at it -- including a play not tracked, for Track
 * anyway -- and let go of when that goes. And whatever is handed to be let go of, nothing but one
 * of these copies is ever deleted: osu!'s own replays are never the app's to remove.
 */
test('a listed upload’s copy goes with its listing, and osu!’s own files are never touched', async () => {
  await withServer(async (h, upload, dataDir) => {
    await upload(stableReplay({ player: 'mrekk', playedAt: SINCE, onlineId: 900_000_001n }));
    assert.equal(stored(dataDir).length, 1, 'kept for Track anyway');
    const [listed] = listDeclines(h.db, h.profileId);
    deleteDeclines(h.db, h.profileId, [listed!.id]);
    assert.deepEqual(stored(dataDir), [], 'deleted for good, so nothing needs it');

    // An osu!stable replay's own name, however it is handed over, is not one of these copies.
    const osus = path.join(dataDir, 'replays', `${'a'.repeat(32)}-638000000000000000.osr`);
    fs.writeFileSync(osus, 'x');
    releaseUploadedReplay(h.db, osus);
    assert.ok(fs.existsSync(osus));
    fs.rmSync(osus);

    // What goes in bulk -- a reset, a deleted profile -- the sweep at launch finds.
    await upload(stableReplay({ player: 'Tangy', playedAt: SINCE + HOUR }));
    assert.equal(stored(dataDir).length, 1);
    h.db.exec('DELETE FROM scores');
    assert.equal(pruneUploadedReplays(h.db, dataDir), 1);
    assert.deepEqual(stored(dataDir), []);
  });
});
