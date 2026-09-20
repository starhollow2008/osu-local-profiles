import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { updateSettings } from '../src/settings.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { ingestScore } from '../src/tracker/ingest.ts';
import {
  certainlySomeoneElse,
  dominantTrackedName,
  ownsPlay,
  replayPlayer,
  resolveIdentity,
  stableConfigUsername,
  sweepForeignScores,
  UNKNOWN_IDENTITY,
  type PlayerIdentity,
  type ReplayPlayer,
} from '../src/player-identity.ts';
import type { OsuInstall } from '../src/clients/detect.ts';
import type { ReplayScore } from '../src/osr.ts';

/*
 * Whose play a replay is.
 *
 * osu! caches the replays you *watch* in the same folders as the ones you set -- stable in
 * `Data/r`, lazer in its content-addressed store -- so a scan finds both and only the name
 * inside tells them apart. Measured on a real machine while this was written: 2,411 replays
 * under the owner's name and 88 under 62 other players', which is how a profile came to hold
 * mrekk's 1,857pp Crystalia play and read 16,109pp.
 *
 * Every test below is really about the same thing: refusing someone else's play must never
 * cost you one of your own. A wrongly tracked play is visible and removable; a wrongly
 * refused one is simply gone.
 */

const OWNER: PlayerIdentity = {
  userId: 3119700,
  names: new Set(['tangy', 'blizzardshiver', 'a wild tangy']),
  displayName: 'Tangy',
  // osu!'s own list, actually fetched -- which is what makes removal safe.
  namesComplete: true,
  source: 'linked',
};

const player = (name: string, userId: number | null = null): ReplayPlayer => ({ name, userId });

test('a play under the current name is yours', () => {
  assert.equal(ownsPlay(OWNER, player('Tangy')), true);
  // Names are compared without case, as osu! treats them.
  assert.equal(ownsPlay(OWNER, player('tAnGy')), true);
});

test('a play set before a rename is still yours', () => {
  // The hazard this guards: osu!stable replays carry no user id at all, only the name that
  // was current when the play was set. Without osu!'s own previous_usernames list, every
  // play from before a rename would look like a stranger's and be thrown away.
  assert.equal(ownsPlay(OWNER, player('blizzardshiver')), true);
  assert.equal(ownsPlay(OWNER, player('A wild Tangy')), true);
  assert.equal(certainlySomeoneElse(OWNER, player('blizzardshiver')), false);
});

test('a play with no name at all is yours', () => {
  // osu!stable writes an empty name for a play made signed out. Nobody downloads an
  // anonymous replay, and an offline play is the case this whole app exists to catch.
  assert.equal(ownsPlay(OWNER, player('')), true);
  assert.equal(ownsPlay(OWNER, player('   ')), true);
  assert.equal(certainlySomeoneElse(OWNER, player('')), false);
});

test("lazer's Guest is yours, not a stranger", () => {
  // What lazer calls the local user when it is not signed in.
  assert.equal(ownsPlay(OWNER, player('Guest')), true);
  assert.equal(ownsPlay(OWNER, player('guest')), true);
  assert.equal(certainlySomeoneElse(OWNER, player('Guest')), false);
});

test('a play somebody else set is not yours', () => {
  assert.equal(ownsPlay(OWNER, player('mrekk')), false);
  assert.equal(certainlySomeoneElse(OWNER, player('mrekk')), true);
});

test('a numeric user id settles it, and outranks the name', () => {
  // lazer records one; osu!stable never does. An id survives a rename where a name cannot,
  // so where both sides have one it is the answer.
  assert.equal(ownsPlay(OWNER, player('whatever-osu-calls-them-now', 3119700)), true);
  assert.equal(ownsPlay(OWNER, player('Tangy', 3654106)), false);
});

test('an identity nothing could establish never refuses a play', () => {
  // Not knowing must never cost anybody a play: an unlinked profile with no stable config
  // tracks everything, exactly as it always has.
  assert.equal(ownsPlay(UNKNOWN_IDENTITY, player('mrekk')), null);
  assert.equal(ownsPlay(UNKNOWN_IDENTITY, player('anyone')), null);
  assert.equal(certainlySomeoneElse(UNKNOWN_IDENTITY, player('mrekk')), false);
});

test('only a linked identity is ever confident enough to remove a stored play', () => {
  // A name read from osu!stable's config, or inferred from the plays already tracked, has no
  // list of previous usernames behind it -- so it may refuse new plays but must never take
  // out ones already here.
  for (const source of ['stable-config', 'tracked-plays', 'unknown'] as const) {
    const guessed: PlayerIdentity = {
      userId: null,
      names: new Set(['tangy']),
      displayName: 'Tangy',
      namesComplete: false,
      source,
    };
    assert.equal(
      certainlySomeoneElse(guessed, player('mrekk')),
      false,
      `${source} must not be confident enough to remove`,
    );
  }
});

test("osu!stable's own config names the signed-in account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-cfg-'));
  try {
    const install: OsuInstall = {
      kind: 'stable',
      root: dir,
      replayDir: path.join(dir, 'Data', 'r'),
      beatmapRoots: [],
      onlineDb: null,
    };
    assert.equal(stableConfigUsername(install), null, 'no config yet');

    fs.writeFileSync(
      path.join(dir, 'osu!.someone.cfg'),
      'BeatmapDirectory = Songs\r\nUsername = Tangy\r\nVolumeUniversal = 40\r\n',
      'latin1',
    );
    assert.equal(stableConfigUsername(install), 'Tangy');

    // lazer has no such file, and must not be asked for one.
    assert.equal(stableConfigUsername({ ...install, kind: 'lazer' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  db: Db;
  resolver: BeatmapResolver;
  profileId: number;
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-owner-'));
  const db = openDb(path.join(tmp, 'test.db'));
  return {
    db,
    resolver: new BeatmapResolver(db, []),
    profileId: getOrCreateProfile(db, 'Test Profile'),
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function replay(over: Partial<ReplayScore> = {}): ReplayScore {
  return {
    client: 'stable',
    mode: 0,
    version: 20230504,
    beatmapMD5: 'a'.repeat(32),
    username: 'Tangy',
    replayMD5: `hash-${Math.random()}`,
    count300: 100,
    count100: 0,
    count50: 0,
    countGeki: 0,
    countKatu: 0,
    countMiss: 0,
    totalScore: 1_000_000,
    maxCombo: 100,
    perfectCombo: true,
    legacyMods: 0,
    playedAt: new Date('2025-01-01T00:00:00Z'),
    onlineScoreId: null,
    extras: null,
    ...over,
  };
}

test('a linked profile knows its own names, previous ones included', () => {
  const h = harness();
  try {
    updateSettings(h.db, h.profileId, {
      linkedUserId: 3119700,
      linkedUsername: 'Tangy',
      linkedPreviousNames: ['blizzardshiver', 'A wild Tangy'],
      linkedNamesKnown: true,
    });
    const identity = resolveIdentity(h.db, h.profileId, []);
    assert.equal(identity.source, 'linked');
    assert.equal(identity.userId, 3119700);
    assert.equal(identity.displayName, 'Tangy');
    assert.equal(identity.namesComplete, true);
    assert.deepEqual([...identity.names].sort(), ['a wild tangy', 'blizzardshiver', 'tangy']);
  } finally {
    h.cleanup();
  }
});

test("an unlinked profile falls back to the plays it has already tracked", () => {
  const h = harness();
  try {
    // Nothing linked, no osu!stable config: the only evidence is the profile's own rows.
    assert.equal(resolveIdentity(h.db, h.profileId, []).source, 'unknown');

    const insert = h.db.prepare(
      `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
        mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
        max_combo, total_score, passed, grade, ranked, played_at, player_name, player_id)
       VALUES (?,?,0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,?,?)`,
    );
    for (let i = 0; i < 20; i++) insert.run(h.profileId, `own-${i}`, 'Tangy', 3119700);
    // A couple of watched replays that slipped in before the check existed.
    insert.run(h.profileId, 'other-1', 'mrekk', null);

    const identity = resolveIdentity(h.db, h.profileId, []);
    assert.equal(identity.source, 'tracked-plays');
    assert.deepEqual([...identity.names], ['tangy']);

    // But a profile genuinely split between two players has no clear owner, and says so
    // rather than picking one by majority.
    for (let i = 0; i < 20; i++) insert.run(h.profileId, `other-${i + 2}`, 'mrekk', null);
    assert.equal(dominantTrackedName(h.db, h.profileId), null);
  } finally {
    h.cleanup();
  }
});

test("a replay somebody else set is never tracked, and says whose it was", async () => {
  const h = harness();
  try {
    const ctx = {
      db: h.db,
      resolver: h.resolver,
      profileId: h.profileId,
      trackingSince: 0,
      official: null,
      identity: OWNER,
    };

    const theirs = await ingestScore(replay({ username: 'mrekk' }), '/replays/mrekk.osr', ctx);
    assert.deepEqual(theirs, { status: 'skipped', reason: 'another-player', player: 'mrekk' });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 0);

    /*
     * And the owner's own plays are tracked -- including one set under a name they no longer
     * use, and one made signed out with no name at all.
     *
     * Each is a distinct play: same map, same total and same moment would be the *same* play
     * as far as `findExistingScore` is concerned, and it would rightly refuse the second as
     * a duplicate for reasons that have nothing to do with who set it.
     */
    const own: [string, string][] = [
      ['Tangy', '/replays/mine.osr'],
      ['blizzardshiver', '/replays/old.osr'],
      ['', '/replays/offline.osr'],
    ];
    for (const [i, [username, file]] of own.entries()) {
      const outcome = await ingestScore(
        replay({
          username,
          totalScore: 1_000_000 + i,
          playedAt: new Date(Date.UTC(2025, 0, 1 + i)),
        }),
        file,
        ctx,
      );
      assert.equal(outcome.status, 'added', `${JSON.stringify(username)} should be tracked`);
    }
  } finally {
    h.cleanup();
  }
});

test('an ingested play records who set it', async () => {
  const h = harness();
  try {
    await ingestScore(
      replay({ client: 'lazer', extras: { user_id: 3119700, mods: [] } }),
      '/replays/mine.osr',
      { db: h.db, resolver: h.resolver, profileId: h.profileId, trackingSince: 0, official: null },
    );
    const row = h.db.prepare('SELECT player_name, player_id FROM scores').get() as {
      player_name: string;
      player_id: number | null;
    };
    // Recorded on the row so nothing later has to reopen a replay file that may be gone.
    assert.equal(row.player_name, 'Tangy');
    assert.equal(row.player_id, 3119700);
  } finally {
    h.cleanup();
  }
});

test('the one-off sweep hides other players’ plays and spares every doubtful one', async () => {
  const h = harness();
  try {
    const insert = h.db.prepare(
      `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
        mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
        max_combo, total_score, passed, grade, ranked, played_at, player_name, player_id,
        replay_path, imported_at)
       VALUES (?,?,0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,?,?,?,?)`,
    );
    insert.run(h.profileId, 'mine', 'Tangy', null, null, null);
    insert.run(h.profileId, 'old-name', 'blizzardshiver', null, null, null);
    insert.run(h.profileId, 'offline', '', null, null, null);
    insert.run(h.profileId, 'guest', 'Guest', null, null, null);
    insert.run(h.profileId, 'theirs', 'mrekk', null, null, null);
    insert.run(h.profileId, 'theirs-2', 'gnahus', null, null, null);
    // No recorded name and no replay left on disk: nothing can attribute it, so it stays.
    insert.run(h.profileId, 'mystery', null, null, null, null);
    // An imported osu! score is not a replay at all and is never swept.
    insert.run(h.profileId, 'imported', null, null, null, Date.now());

    const sweep = await sweepForeignScores(h.db, h.profileId, OWNER, async () => null);
    assert.equal(sweep.hidden, 2);
    assert.deepEqual(sweep.byPlayer, [
      { name: 'gnahus', count: 1 },
      { name: 'mrekk', count: 1 },
    ]);
    assert.equal(sweep.unattributable, 1, 'the row nothing can attribute is left alone');

    const hidden = h.db
      .prepare('SELECT dedupe_key FROM scores WHERE hidden_at IS NOT NULL ORDER BY dedupe_key')
      .all() as { dedupe_key: string }[];
    assert.deepEqual(hidden.map((r) => r.dedupe_key), ['theirs', 'theirs-2']);

    // A hide, never a delete: every row is still there and can be put back from Removed
    // scores, which is what makes doing this without being asked defensible.
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 8);
  } finally {
    h.cleanup();
  }
});

test('the sweep does nothing at all without a linked account', async () => {
  const h = harness();
  try {
    h.db
      .prepare(
        `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
          mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
          max_combo, total_score, passed, grade, ranked, played_at, player_name)
         VALUES (?,'theirs',0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,'mrekk')`,
      )
      .run(h.profileId);

    const guessed: PlayerIdentity = {
      userId: null,
      names: new Set(['tangy']),
      displayName: 'Tangy',
      namesComplete: false,
      source: 'stable-config',
    };
    const sweep = await sweepForeignScores(h.db, h.profileId, guessed, async () => null);
    assert.equal(sweep.hidden, 0);
    assert.equal(sweep.checked, 0);
    assert.equal(
      (h.db.prepare('SELECT COUNT(*) AS n FROM scores WHERE hidden_at IS NOT NULL').get() as {
        n: number;
      }).n,
      0,
    );
  } finally {
    h.cleanup();
  }
});

test('replayPlayer reads the name and, for lazer, the user id', () => {
  assert.deepEqual(replayPlayer(replay()), { name: 'Tangy', userId: null });
  assert.deepEqual(
    replayPlayer(replay({ client: 'lazer', extras: { user_id: 3119700, mods: [] } })),
    { name: 'Tangy', userId: 3119700 },
  );
  // osu!stable records no id, and a zero is not one.
  assert.deepEqual(
    replayPlayer(replay({ client: 'lazer', extras: { user_id: 0, mods: [] } })),
    { name: 'Tangy', userId: null },
  );
});

test('a link made before previous names were fetched removes nothing', () => {
  /*
   * The upgrade hazard, and the reason `linkedNamesKnown` exists.
   *
   * An account linked by an older version has an empty previous-name list, and an empty list
   * is indistinguishable from a list nobody asked for. Taking a play out on the strength of
   * that would delete exactly the plays set before a rename -- the ones a rename makes
   * hardest to recognise. So it refuses to.
   */
  const stale: PlayerIdentity = {
    userId: 3119700,
    names: new Set(['tangy']),
    displayName: 'Tangy',
    namesComplete: false,
    source: 'linked',
  };
  assert.equal(certainlySomeoneElse(stale, player('blizzardshiver')), false);
  assert.equal(certainlySomeoneElse(stale, player('mrekk')), false);

  // It may still refuse a *new* play: one arriving now carries the name you have now.
  assert.equal(ownsPlay(stale, player('mrekk')), false);

  // And a lazer user id is conclusive whatever the names say, so it still settles those.
  assert.equal(certainlySomeoneElse({ ...stale, namesComplete: true }, player('x', 3654106)), true);
});
