import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { startServer } from '../src/http/server.ts';
import { computeStats } from '../src/calc/stats.ts';
import { listDeclines, recordDecline } from '../src/tracker/declined.ts';

/** A minimal stored score, so reset has something real to erase. */
function insertScore(db: Db, profileId: number, key: string, playedAt: number): void {
  db.prepare(
    `INSERT INTO scores
      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
       count300, count100, count50, count_geki, count_katu, count_miss,
       accuracy, max_combo, total_score, passed, grade, pp, ranked, played_at)
     VALUES (?,?,0,?,'lazer','[]','None',100,0,0,0,0,0,1.0,100,500000,1,'X',120.5,1,?)`,
  ).run(profileId, key, `md5-${key}`, playedAt);
}

interface Harness {
  db: Db;
  profileId: number;
  tracker: Tracker;
  base: string;
  appConfig: { openBrowser: boolean };
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-reset-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Reset Test');
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
    port: 0, // ephemeral
    // In memory: a test must never write the real data/config.json.
    appConfig: {
      get: () => ({ ...appConfig }),
      set: (patch) => Object.assign(appConfig, patch),
    },
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    profileId,
    tracker,
    appConfig,
    base: `http://127.0.0.1:${port}`,
    cleanup: () => {
      server.close();
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/profile/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/*
 * "Open in browser on start", from the Options menu. It writes the file the app boots from,
 * so the endpoint takes exactly one key of exactly one type and nothing else.
 */
test('the open-in-browser option round-trips, and rejects anything but a boolean', async () => {
  const h = harness();
  try {
    const state = (await (await fetch(`${h.base}/api/state`)).json()) as {
      app: { config: { openBrowser: boolean } };
    };
    assert.equal(state.app.config.openBrowser, true);

    const send = (body: unknown) =>
      fetch(`${h.base}/api/app-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const off = await send({ openBrowser: false });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { config: { openBrowser: boolean } }).config.openBrowser, false);
    assert.equal(h.appConfig.openBrowser, false);

    assert.equal((await send({ openBrowser: 'no' })).status, 400);
    assert.equal((await send({ port: 80 })).status, 400);
    assert.equal(h.appConfig.openBrowser, false, 'a rejected request changes nothing');
  } finally {
    h.cleanup();
  }
});

test('the font setting takes Nunito or the system font, and nothing else', async () => {
  const h = harness();
  try {
    const send = (body: unknown) =>
      fetch(`${h.base}/api/app-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const system = await send({ font: 'system' });
    assert.equal(system.status, 200);
    assert.equal(((await system.json()) as { config: { font: string } }).config.font, 'system');

    assert.equal((await send({ font: 'comic sans' })).status, 400);
    assert.equal((await send({ font: true })).status, 400);
    assert.equal((h.appConfig as { font?: string }).font, 'system', 'a rejected request changes nothing');
  } finally {
    h.cleanup();
  }
});

test('reset refuses without an explicit confirmation', async () => {
  const h = harness();
  try {
    insertScore(h.db, h.profileId, 'a', Date.now());

    for (const body of [{}, { confirm: false }, { confirm: 'yes' }]) {
      const res = await post(h.base, body);
      assert.equal(res.status, 400, `expected refusal for ${JSON.stringify(body)}`);
      assert.equal(
        computeStats(h.db, h.profileId, 0).playcount,
        1,
        'an unconfirmed reset must not delete anything',
      );
    }
  } finally {
    h.cleanup();
  }
});

test('confirmed reset erases the profile and restarts tracking', async () => {
  const h = harness();
  try {
    const before = Date.now() - 60_000;
    insertScore(h.db, h.profileId, 'a', before);
    insertScore(h.db, h.profileId, 'b', before + 1000);
    assert.equal(computeStats(h.db, h.profileId, 0).playcount, 2);

    const res = await post(h.base, { confirm: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; deleted: number; trackingSince: number };
    assert.equal(body.ok, true);
    assert.equal(body.deleted, 2);

    const stats = computeStats(h.db, h.profileId, 0);
    assert.equal(stats.playcount, 0, 'all scores should be gone');
    assert.equal(stats.totalPp, 0);
    assert.equal(stats.level.current, 1, 'level returns to 1');

    // tracking_since must move forward, otherwise replays already on disk from before
    // the reset would be re-accepted and quietly refill the profile.
    const profile = h.db
      .prepare('SELECT tracking_since FROM profiles WHERE id = ?')
      .get(h.profileId) as { tracking_since: number };
    assert.ok(
      profile.tracking_since >= before + 1000,
      'tracking_since should be after the erased scores',
    );
    assert.equal(profile.tracking_since, body.trackingSince);
  } finally {
    h.cleanup();
  }
});

/*
 * Plays not tracked, through the page's own routes -- and a reset forgets them, or Track anyway
 * on a play from before it would bring back exactly what the reset cleared.
 */
test('the list of plays not tracked is served, deleted for good, and forgotten by a reset', async () => {
  const h = harness();
  try {
    const decline = (key: string) =>
      recordDecline(h.db, h.profileId, {
        kind: 'score',
        dedupeKey: key,
        reason: 'another-player',
        criterion: null,
        player: 'mrekk',
        source: 'live',
        title: 'Reji - Shoujo wa Yoru to Azayaka ni [Vivid Collab]',
        titleOriginal: null,
        mode: 0,
        playedAt: Date.now(),
        replayPath: path.join('C:', 'osu!', 'Data', 'r', `${key}.osr`),
        recording: null,
      });
    decline('a');
    decline('b');

    const state = (await (await fetch(`${h.base}/api/state`)).json()) as { declinedPlays: number };
    assert.equal(state.declinedPlays, 2);
    const listed = (await (await fetch(`${h.base}/api/declined`)).json()) as {
      plays: { id: number; player: string; fileName: string | null }[];
    };
    assert.equal(listed.plays.length, 2);
    assert.equal(listed.plays[0]!.player, 'mrekk');
    assert.equal(listed.plays[0]!.fileName, null, 'a named play needs no file name, and never a path');

    const send = (body: unknown) =>
      fetch(`${h.base}/api/declined`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await send({ action: 'nonsense' })).status, 400);
    // The replay is not on this machine, so there is nothing to track it from -- and it stays.
    const missing = (await (await send({ action: 'track', id: listed.plays[0]!.id })).json()) as {
      result: { status: string };
      declinedPlays: number;
    };
    assert.deepEqual(missing.result, { status: 'missing' });
    assert.equal(missing.declinedPlays, 2);

    assert.equal((await post(h.base, { confirm: true })).status, 200);
    assert.equal(listDeclines(h.db, h.profileId).length, 0, 'a reset forgets what was turned away');

    // The red minus and Delete all permanently: gone for good, as a removed score is deleted.
    decline('c');
    decline('d');
    decline('e');
    const [newest] = listDeclines(h.db, h.profileId);
    const one = (await (await send({ action: 'delete', id: newest!.id })).json()) as {
      deleted: number;
      declinedPlays: number;
    };
    assert.equal(one.deleted, 1);
    assert.equal(one.declinedPlays, 2);
    assert.equal((await send({ action: 'delete', id: newest!.id })).status, 400, 'not in the list any more');
    const all = (await (await send({ action: 'delete-all' })).json()) as { deleted: number; declinedPlays: number };
    assert.equal(all.deleted, 2);
    assert.equal(all.declinedPlays, 0);

    // Remembered, so the same plays turned away again are never listed again.
    const kept = h.db.prepare('SELECT dedupe_key FROM deleted_scores ORDER BY dedupe_key').all() as { dedupe_key: string }[];
    assert.deepEqual(kept.map((r) => r.dedupe_key), ['c', 'd', 'e']);
    decline('c');
    decline('e');
    assert.equal(listDeclines(h.db, h.profileId).length, 0);
  } finally {
    h.cleanup();
  }
});

test('reset leaves the cached beatmap index alone', async () => {
  const h = harness();
  try {
    h.db.prepare(
      'INSERT INTO osu_files (path, md5, size, indexed_at) VALUES (?, ?, ?, ?)',
    ).run('C:/fake/map.osu', 'abc123', 1000, Date.now());
    insertScore(h.db, h.profileId, 'a', Date.now());

    assert.equal((await post(h.base, { confirm: true })).status, 200);

    // Rebuilding the index takes ~40s, and it is not profile data.
    const files = h.db.prepare('SELECT COUNT(*) AS n FROM osu_files').get() as { n: number };
    assert.equal(files.n, 1, 'the beatmap index must survive a profile reset');
  } finally {
    h.cleanup();
  }
});

test('reset on an empty profile is harmless', async () => {
  const h = harness();
  try {
    const res = await post(h.base, { confirm: true });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { deleted: number }).deleted, 0);
    assert.equal(computeStats(h.db, h.profileId, 0).playcount, 0);
  } finally {
    h.cleanup();
  }
});
