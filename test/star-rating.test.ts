import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import './english.ts';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { startServer, type AppConfig } from '../src/http/server.ts';
import {
  dismissStarRatingNotice,
  seedStarRatingNotice,
  starRatingNoticePending,
} from '../src/star-rating-notice.ts';
import { playRow } from '../web/js/sections.js';

function withDb(run: (db: ReturnType<typeof openDb>) => void) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-stars-kv-'));
  const db = openDb(path.join(tmp, 'test.db'));
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a new install is never told star ratings were hidden', () => {
  withDb((db) => {
    seedStarRatingNotice(db, true);
    assert.equal(starRatingNoticePending(db), false);
    // Later starts see a database that already exists, and change nothing.
    seedStarRatingNotice(db, false);
    assert.equal(starRatingNoticePending(db), false);
  });
});

test('an install from before is told once, and closing it ends it for good', () => {
  withDb((db) => {
    seedStarRatingNotice(db, false);
    assert.equal(starRatingNoticePending(db), true);
    seedStarRatingNotice(db, false);
    assert.equal(starRatingNoticePending(db), true, 'still waiting until it is closed');
    dismissStarRatingNotice(db);
    assert.equal(starRatingNoticePending(db), false);
    seedStarRatingNotice(db, false);
    assert.equal(starRatingNoticePending(db), false, 'the next start does not bring it back');
    dismissStarRatingNotice(db);
    assert.equal(starRatingNoticePending(db), false);
  });
});

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-stars-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Star Rating Test');
  const appConfig: AppConfig = { openBrowser: true, starRating: false };
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

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('the page learns of the note from state, and closing it over HTTP ends it', async () => {
  const h = harness();
  try {
    const pending = async () =>
      ((await (await fetch(`${h.base}/api/state`)).json()) as { starRatingNotice: boolean }).starRatingNotice;
    assert.equal(await pending(), false, 'never seeded');
    seedStarRatingNotice(h.db, false);
    assert.equal(await pending(), true);
    assert.equal((await post(`${h.base}/api/star-rating-notice`, {})).status, 200);
    assert.equal(await pending(), false);
  } finally {
    h.cleanup();
  }
});

test('star ratings are an install option, true or false only', async () => {
  const h = harness();
  try {
    const on = (await (await post(`${h.base}/api/app-config`, { starRating: true })).json()) as {
      config: AppConfig;
    };
    assert.equal(on.config.starRating, true);
    const refused = await post(`${h.base}/api/app-config`, { starRating: 'yes' });
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: string }).error, 'starRating must be true or false');
  } finally {
    h.cleanup();
  }
});

test('a score row shows its star rating only when asked', () => {
  const play = { id: 1, title: 'Heart no Shuchou', artist: 'CHiCO', version: "Kowari's Confession", stars: 6.18, mods: [] };
  const plain = playRow(play);
  assert.match(plain, /Kowari&#39;s Confession<\/span>|Kowari's Confession<\/span>/);
  assert.doesNotMatch(plain, /6\.18|&#9733;/);
  assert.match(playRow(play, { starRating: true }), /Kowari(&#39;|')s Confession &middot; 6\.18&#9733;<\/span>/);
});
