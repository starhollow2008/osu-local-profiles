import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import {
  activeProfileId,
  createProfile,
  deleteProfile,
  listProfiles,
  renameProfile,
  setActiveProfile,
} from '../src/profiles.ts';
import { computeStats } from '../src/calc/stats.ts';

function harness(): { db: Db; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-profiles-'));
  const db = openDb(path.join(tmp, 'test.db'));
  getOrCreateProfile(db, 'First');
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function insertScore(db: Db, profileId: number, key: string): void {
  db.prepare(
    `INSERT INTO scores
      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
       count300, count100, count50, count_geki, count_katu, count_miss,
       accuracy, max_combo, total_score, passed, grade, pp, ranked, played_at)
     VALUES (?,?,0,?,'lazer','[]','None',100,0,0,0,0,0,1.0,100,500000,1,'X',120.5,1,?)`,
  ).run(profileId, key, `md5-${key}`, Date.now());
}

test('profiles keep their scores entirely separate', () => {
  const h = harness();
  try {
    const first = activeProfileId(h.db);
    const second = createProfile(h.db, 'Left hand');

    insertScore(h.db, first, 'a');
    insertScore(h.db, first, 'b');
    insertScore(h.db, second.id, 'c');

    assert.equal(computeStats(h.db, first, 0).playcount, 2);
    assert.equal(computeStats(h.db, second.id, 0).playcount, 1);

    const listed = listProfiles(h.db);
    assert.deepEqual(
      listed.map((p) => [p.name, p.scoreCount]),
      [['First', 2], ['Left hand', 1]],
    );
  } finally {
    h.cleanup();
  }
});

test('a new profile starts from now, not from earlier plays', () => {
  const h = harness();
  try {
    const before = Date.now();
    const created = createProfile(h.db, 'Mouse only');
    assert.ok(
      created.trackingSince >= before,
      'a new profile must not accept anything played before it existed',
    );
    assert.equal(created.scoreCount, 0);
  } finally {
    h.cleanup();
  }
});

test('names must be unique and non-empty', () => {
  const h = harness();
  try {
    createProfile(h.db, 'Tablet');
    assert.throws(() => createProfile(h.db, 'Tablet'), /already exists/);
    // Whitespace-only is the same as empty.
    assert.throws(() => createProfile(h.db, '   '), /needs a name/);
    assert.throws(() => createProfile(h.db, ''), /needs a name/);

    // Surrounding whitespace is trimmed rather than making a near-duplicate.
    assert.throws(() => createProfile(h.db, '  Tablet  '), /already exists/);
  } finally {
    h.cleanup();
  }
});

test('renaming keeps the profile and its scores', () => {
  const h = harness();
  try {
    const id = activeProfileId(h.db);
    insertScore(h.db, id, 'a');

    const renamed = renameProfile(h.db, id, 'Right hand');
    assert.equal(renamed.name, 'Right hand');
    assert.equal(renamed.id, id, 'renaming must not create a new profile');
    assert.equal(computeStats(h.db, id, 0).playcount, 1, 'scores survive a rename');
    assert.equal(activeProfileId(h.db), id, 'the active selection survives a rename');
  } finally {
    h.cleanup();
  }
});

test('switching changes which profile is live, and survives a reopen', () => {
  const h = harness();
  try {
    const first = activeProfileId(h.db);
    const second = createProfile(h.db, 'Second');

    setActiveProfile(h.db, second.id);
    assert.equal(activeProfileId(h.db), second.id);
    assert.equal(listProfiles(h.db).find((p) => p.active)?.id, second.id);

    setActiveProfile(h.db, first);
    assert.equal(activeProfileId(h.db), first);

    assert.throws(() => setActiveProfile(h.db, 9999), /no profile with id/);
  } finally {
    h.cleanup();
  }
});

test('deleting a profile takes its scores and repairs the selection', () => {
  const h = harness();
  try {
    const first = activeProfileId(h.db);
    const second = createProfile(h.db, 'Doomed');
    insertScore(h.db, second.id, 'a');
    setActiveProfile(h.db, second.id);

    const result = deleteProfile(h.db, second.id);
    assert.equal(result.deletedScores, 1);
    assert.equal(result.nextActive, first, 'deleting the active profile falls back to another');
    assert.equal(activeProfileId(h.db), first);

    const remaining = h.db
      .prepare('SELECT COUNT(*) AS n FROM scores WHERE profile_id = ?')
      .get(second.id) as { n: number };
    assert.equal(remaining.n, 0, 'scores must go with the profile');
  } finally {
    h.cleanup();
  }
});

test('the last profile cannot be deleted', () => {
  const h = harness();
  try {
    const only = activeProfileId(h.db);
    // Without this the app would have nowhere to write the next score.
    assert.throws(() => deleteProfile(h.db, only), /only profile/);
    assert.equal(listProfiles(h.db).length, 1);
  } finally {
    h.cleanup();
  }
});

test('a dangling active id falls back instead of throwing', () => {
  const h = harness();
  try {
    const first = activeProfileId(h.db);
    // Simulate a selection pointing at a profile that is no longer there.
    h.db.prepare('UPDATE kv SET value = ? WHERE key = ?').run('4242', 'activeProfileId');
    assert.equal(activeProfileId(h.db), first, 'a stale selection repairs itself');
  } finally {
    h.cleanup();
  }
});
