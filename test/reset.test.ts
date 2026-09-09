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
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-reset-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Reset Test');
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
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    profileId,
    tracker,
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
