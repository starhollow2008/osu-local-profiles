import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { startServer } from '../src/http/server.ts';

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-body-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Body Test');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [],
    profileId,
    trackingSince: 0,
    official: null,
  });
  const server = startServer({
    db,
    tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir: tmp,
    port: 0,
    appConfig: { get: () => ({ openBrowser: true }), set: () => {} },
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    cleanup: () => {
      server.close();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('a body that is not a JSON object is refused, and never stops the app', async () => {
  const { base, cleanup } = harness();
  try {
    // Each of these once reached a handler that read a field of it before its first await, and
    // the TypeError that threw ended the process.
    for (const raw of ['null', '5', '"text"', 'true', '[1,2]', '{', 'not json']) {
      for (const pathname of ['/api/settings', '/api/app-config', '/api/scores', '/api/profiles']) {
        const r = await fetch(`${base}${pathname}`, { method: 'POST', body: raw });
        assert.equal(r.status, 400, `${pathname} ${raw}`);
        assert.deepEqual(await r.json(), { error: 'expected a JSON body' });
      }
    }
    // An empty body is an empty object, as it always was.
    const empty = await fetch(`${base}/api/app-config`, { method: 'POST' });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: 'openBrowser must be true or false' });
    // And the app is still answering.
    assert.equal((await fetch(`${base}/api/app`)).status, 200);
  } finally {
    cleanup();
  }
});
