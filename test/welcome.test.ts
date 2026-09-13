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
import { dismissWelcome, offerWelcome, welcomePending } from '../src/welcome.ts';

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-welcome-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Welcome Test');
  const appConfig = { openBrowser: true };
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
    appConfig: {
      get: () => ({ ...appConfig }),
      set: (patch) => Object.assign(appConfig, patch),
    },
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    cleanup: () => {
      server.close();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const welcomeInState = async (base: string) =>
  ((await (await fetch(`${base}/api/state`)).json()) as { welcome: boolean }).welcome;

test('the welcome is offered once, and any dismissal ends it for good', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-welcome-kv-'));
  const db = openDb(path.join(tmp, 'test.db'));
  try {
    // A database is not a new user by itself: only main.ts, seeing it created, offers it.
    assert.equal(welcomePending(db), false);
    offerWelcome(db);
    offerWelcome(db);
    assert.equal(welcomePending(db), true);
    dismissWelcome(db);
    assert.equal(welcomePending(db), false);
    dismissWelcome(db);
    assert.equal(welcomePending(db), false);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the page learns of the welcome from state, and dismissing it over HTTP ends it', async () => {
  const h = harness();
  try {
    assert.equal(await welcomeInState(h.base), false, 'an install that was never offered it');

    offerWelcome(h.db);
    assert.equal(await welcomeInState(h.base), true);

    const r = await fetch(`${h.base}/api/welcome`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(await welcomeInState(h.base), false);

    // Closing it in a second tab afterwards is harmless.
    assert.equal((await fetch(`${h.base}/api/welcome`, { method: 'POST' })).status, 200);
    assert.equal(await welcomeInState(h.base), false);
  } finally {
    h.cleanup();
  }
});
