import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import type { OsuInstall } from '../src/clients/detect.ts';
import { scoreFromJson, type OsuWebScore } from '../src/clients/osu-web.ts';
import { importScore } from '../src/tracker/online-import.ts';
import { Tracker } from '../src/tracker/index.ts';
import { encodeReplay, type ReplayHeader } from '../src/replay-writer.ts';

/*
 * Finding, after an import from osu!, the replays this computer already has of those plays.
 *
 * Everything is made here: an osu!stable replay written by the app's own writer, of the very
 * play osu!'s payload describes, in a folder standing in for `Data/r`. So these run on any
 * machine, with or without osu! on it.
 */

const MD5 = 'd4e23a5746b9a780f9faa10189521498';
const OTHER_MD5 = '0123456789abcdef0123456789abcdef';
const PLAYED_AT = Date.parse('2023-05-04T10:10:36Z');

/** One best performance, in the shape osu-web answers with: a stable play, so both ids. */
function imported(over: Record<string, unknown> = {}): OsuWebScore {
  const score = scoreFromJson({
    id: 1716608692,
    legacy_score_id: 4430944113,
    ruleset_id: 0,
    beatmap_id: 2403946,
    rank: 'S',
    pp: 378.504,
    accuracy: 0.993169,
    max_combo: 1298,
    total_score: 1051812,
    legacy_total_score: 40966260,
    classic_total_score: 32738070,
    mods: [{ acronym: 'HR' }, { acronym: 'CL' }],
    statistics: { ok: 10, great: 966 },
    maximum_statistics: { great: 976 },
    ended_at: '2023-05-04T10:10:36Z',
    passed: true,
    ranked: true,
    beatmap: { id: 2403946, beatmapset_id: 1140099, checksum: MD5, version: 'Insane', status: 'ranked' },
    beatmapset: { id: 1140099, artist: 'Artist', title: 'Title', creator: 'Mapper' },
    ...over,
  });
  assert.ok(score);
  return score;
}

/** osu!stable's replay of that same play. */
function replay(over: Partial<ReplayHeader> = {}): Buffer {
  return encodeReplay({
    mode: 0,
    version: 20230504,
    beatmapMD5: MD5,
    player: 'Tangy',
    replayMD5: 'a-replay-hash',
    counts: { c300: 966, c100: 10, c50: 0, geki: 0, katu: 0, miss: 0 },
    totalScore: 40966260,
    maxCombo: 1298,
    perfect: false,
    legacyMods: 16,
    playedAt: PLAYED_AT,
    onlineId: 4430944113n,
    ...over,
  });
}

function stable(root: string): OsuInstall {
  const replayDir = path.join(root, 'Data', 'r');
  fs.mkdirSync(replayDir, { recursive: true });
  return { kind: 'stable', root, replayDir, beatmapRoots: [], onlineDb: null };
}

function harness(roots = ['osu!']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-replay-search-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Imported');
  const installs = roots.map((r) => stable(path.join(tmp, r)));
  const resolver = new BeatmapResolver(db, []);
  const tracker = new Tracker({ db, resolver, installs, profileId, trackingSince: Date.now(), official: null });
  const row = (id: number) =>
    db.prepare('SELECT id, imported_at, origin, replay_path, pinned_at FROM scores WHERE id = ?').get(id) as {
      id: number;
      imported_at: number | null;
      origin: string | null;
      replay_path: string | null;
      pinned_at: number | null;
    };
  return {
    db,
    profileId,
    installs,
    tracker,
    row,
    import: (score: OsuWebScore) => {
      const outcome = importScore(db, resolver, profileId, score);
      assert.equal(outcome.status, 'added');
      return (outcome as { id: number }).id;
    },
    drop: (install: OsuInstall, name: string, bytes: Buffer) => {
      const file = path.join(install.replayDir, name);
      fs.writeFileSync(file, bytes);
      return file;
    },
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('an imported play takes the replay this computer has of it, in place', async () => {
  const h = harness();
  try {
    const id = h.import(imported());
    h.db.prepare('UPDATE scores SET pinned_at = 1 WHERE id = ?').run(id);
    const file = h.drop(h.installs[0]!, 'mine.osr', replay());

    assert.deepEqual(await h.tracker.attachLocalReplays(h.profileId), { attached: 1 });
    const after = h.row(id);
    assert.equal(after.imported_at, null, 'no longer osu!’s figures alone');
    assert.equal(after.replay_path, file);
    assert.notEqual(after.pinned_at, null, 'its pin kept');
    assert.equal(h.count(), 1, 'the same row, never a second one');

    // Nothing left to find, so a second look changes nothing.
    assert.deepEqual(await h.tracker.attachLocalReplays(h.profileId), { attached: 0 });
  } finally {
    h.cleanup();
  }
});

test('only the imported plays’ replays are brought in, never any other play in the folder', async () => {
  const h = harness();
  try {
    const id = h.import(imported());
    // Another play on another beatmap, and a different play of the same beatmap: both are
    // plays Import past plays would bring in, and neither is this one's to add.
    h.drop(h.installs[0]!, 'other-map.osr', replay({ beatmapMD5: OTHER_MD5, onlineId: 1n, replayMD5: 'b' }));
    h.drop(
      h.installs[0]!,
      'other-try.osr',
      replay({ onlineId: 0n, totalScore: 123, maxCombo: 40, playedAt: PLAYED_AT - 86_400_000, replayMD5: 'c' }),
    );

    assert.deepEqual(await h.tracker.attachLocalReplays(h.profileId), { attached: 0 });
    assert.equal(h.count(), 1);
    assert.notEqual(h.row(id).imported_at, null);
  } finally {
    h.cleanup();
  }
});

test('a replay too old to carry an id is still found by the play itself', async () => {
  const h = harness();
  try {
    const id = h.import(imported());
    h.drop(h.installs[0]!, 'no-id.osr', replay({ onlineId: 0n }));
    assert.deepEqual(await h.tracker.attachLocalReplays(h.profileId), { attached: 1 });
    assert.equal(h.row(id).imported_at, null);
  } finally {
    h.cleanup();
  }
});

test('a score link looks for its own play alone, and in every install', async () => {
  const h = harness(['osu!', 'osu! (maps)']);
  try {
    const first = h.import(imported());
    const second = h.import(
      imported({ id: 99, legacy_score_id: 98, total_score: 900000, legacy_total_score: 5000, max_combo: 70 }),
    );
    // As a score from its link is held: on a replay this app built from osu!'s figures.
    h.db.prepare("UPDATE scores SET imported_at = NULL, origin = 'link' WHERE id = ?").run(second);
    h.drop(h.installs[0]!, 'first.osr', replay());
    // In the second install: looked in as well as the first.
    const file = h.drop(h.installs[1]!, 'second.osr', replay({ onlineId: 98n, totalScore: 5000, maxCombo: 70, replayMD5: 'd' }));

    assert.deepEqual(await h.tracker.attachLocalReplays(h.profileId, [second]), { attached: 1 });
    assert.equal(h.row(second).origin, null, 'on the replay osu! wrote now');
    assert.equal(h.row(second).replay_path, file);
    assert.notEqual(h.row(first).imported_at, null, 'a play not asked about is left for later');
  } finally {
    h.cleanup();
  }
});

test('Import past plays looks only in the installs it is told to', async () => {
  const h = harness(['lazer-ish', 'stable']);
  try {
    h.drop(h.installs[0]!, 'a.osr', replay({ onlineId: 1n, replayMD5: 'a' }));
    h.drop(h.installs[1]!, 'b.osr', replay({ onlineId: 2n, replayMD5: 'b', playedAt: PLAYED_AT + 60_000_000 }));

    assert.equal((await h.tracker.previewBackfill(0, false)).importable, 2, 'every install by default');
    assert.equal((await h.tracker.previewBackfill(0, false, null, [h.installs[1]!.root])).importable, 1);
    // A root the tracker does not have is never looked in.
    assert.equal((await h.tracker.previewBackfill(0, false, null, ['/somewhere/else'])).importable, 0);

    const result = await h.tracker.backfill(0, undefined, false, 'import', null, [h.installs[0]!.root]);
    assert.equal(result.imported, 1);
    assert.equal(h.count(), 1);
  } finally {
    h.cleanup();
  }
});
