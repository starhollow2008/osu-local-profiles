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

/**
 * A play osu! accepted, by default -- which is what a downloaded replay always is, and so
 * the only kind whose name can count against it.
 */
const player = (name: string, userId: number | null = null): ReplayPlayer => ({
  name,
  userId,
  onlineId: 900_000_001,
});

/** The same play, never submitted: offline, signed out, or on a map osu! does not rank. */
const offlinePlay = (name: string, userId: number | null = null): ReplayPlayer => ({
  name,
  userId,
  onlineId: null,
});

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
  // A name read from a client's config, or inferred from the plays already tracked, has no
  // list of previous usernames behind it -- so it may refuse new plays but must never take
  // out ones already here.
  for (const source of ['signed-in', 'tracked-plays', 'unknown'] as const) {
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

/** An install whose own config says who is signed in, as each client writes it. */
function signedIn(kind: 'lazer' | 'stable', username: string | null): { install: OsuInstall; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-cfg-'));
  if (username !== null) {
    if (kind === 'lazer') fs.writeFileSync(path.join(dir, 'game.ini'), `Username = ${username}\r\nSavePassword = True\r\n`);
    else fs.writeFileSync(path.join(dir, 'osu!.someone.cfg'), `BeatmapDirectory = Songs\r\nUsername = ${username}\r\n`);
  }
  return {
    install: { kind, root: dir, replayDir: path.join(dir, 'files'), beatmapRoots: [], onlineDb: null },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('whoever either client says is signed in owns the profile', () => {
  const h = harness();
  const stable = signedIn('stable', 'Tangy');
  const lazer = signedIn('lazer', 'Tangy');
  const nobody = signedIn('lazer', null);
  try {
    for (const install of [stable.install, lazer.install]) {
      const identity = resolveIdentity(h.db, h.profileId, [install]);
      assert.equal(identity.source, 'signed-in', install.kind);
      assert.deepEqual([...identity.names], ['tangy']);
    }
    // A client that remembers no name says nothing: nothing to go on, so nothing is refused.
    assert.equal(resolveIdentity(h.db, h.profileId, [nobody.install]).source, 'unknown');
  } finally {
    for (const x of [stable, lazer, nobody]) x.cleanup();
    h.cleanup();
  }
});

/*
 * The bug this replaced. A profile linked to another osu! account -- for its avatar and banner,
 * or an alt's name -- took that account as the owner, so every play of your own that osu! had
 * submitted was refused as a stranger's, on every map, while your fails (from lazer's log, which
 * names nobody) were kept. "Finished maps never show up; failed ones do."
 */
test('an account linked for its pictures does not decide whose plays are yours', () => {
  const h = harness();
  const lazer = signedIn('lazer', 'Remyria');
  try {
    updateSettings(h.db, h.profileId, {
      linkedUserId: 7562902,
      linkedUsername: 'mrekk',
      linkedPreviousNames: [],
      linkedNamesKnown: true,
    });
    const identity = resolveIdentity(h.db, h.profileId, [lazer.install]);
    assert.equal(identity.source, 'signed-in');
    assert.equal(identity.userId, null);
    assert.equal(ownsPlay(identity, player('Remyria', 12_345_678)), true, 'your own submitted play');
    assert.equal(ownsPlay(identity, player('mrekk', 7562902)), false, "a replay you watched of the linked account's");
    assert.equal(certainlySomeoneElse(identity, player('mrekk', 7562902)), false, 'and nothing is removed on it');
  } finally {
    lazer.cleanup();
    h.cleanup();
  }
});

/*
 * Two accounts signed in on the two clients are both yours. The linked one's id must not
 * settle plays then: an id outranks a name, and would refuse the other account's lazer plays.
 */
test('a second account signed in on the other client stays yours', () => {
  const h = harness();
  const lazer = signedIn('lazer', 'Tangy');
  const stable = signedIn('stable', 'TangyAlt');
  try {
    updateSettings(h.db, h.profileId, {
      linkedUserId: 3119700,
      linkedUsername: 'Tangy',
      linkedPreviousNames: [],
      linkedNamesKnown: true,
    });
    const identity = resolveIdentity(h.db, h.profileId, [lazer.install, stable.install]);
    assert.equal(identity.source, 'linked');
    assert.equal(identity.userId, null);
    assert.equal(ownsPlay(identity, player('TangyAlt', 999)), true);
    assert.equal(ownsPlay(identity, player('Tangy', 3119700)), true);
    assert.equal(ownsPlay(identity, player('mrekk', 7562902)), false);
  } finally {
    lazer.cleanup();
    stable.cleanup();
    h.cleanup();
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
    mcosu: null,
    ...over,
  };
}

test('a link to the signed-in account adds its id and previous names', () => {
  const h = harness();
  const lazer = signedIn('lazer', 'Tangy');
  try {
    updateSettings(h.db, h.profileId, {
      linkedUserId: 3119700,
      linkedUsername: 'Tangy',
      linkedPreviousNames: ['blizzardshiver', 'A wild Tangy'],
      linkedNamesKnown: true,
    });
    // Without anyone signed in, the link alone is not ownership.
    assert.notEqual(resolveIdentity(h.db, h.profileId, []).source, 'linked');

    const identity = resolveIdentity(h.db, h.profileId, [lazer.install]);
    assert.equal(identity.source, 'linked');
    assert.equal(identity.userId, 3119700);
    assert.equal(identity.displayName, 'Tangy');
    assert.equal(identity.namesComplete, true);
    assert.deepEqual([...identity.names].sort(), ['a wild tangy', 'blizzardshiver', 'tangy']);
  } finally {
    lazer.cleanup();
    h.cleanup();
  }
});

test("with nobody signed in, a profile falls back to the plays it has already tracked", () => {
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

    // A replay you watched is a score osu! accepted, so it carries an id -- which is what
    // makes its name count against it. See the offline-name test below.
    const theirs = await ingestScore(
      replay({ username: 'mrekk', onlineScoreId: 900_000_001n }),
      '/replays/mrekk.osr',
      ctx,
    );
    // Named, map and all, because the page announces it: a refusal is the only skip that can be
    // wrong, and a wrong one would otherwise be a play of your own that silently never arrived.
    assert.equal(theirs.status, 'skipped');
    assert.ok(theirs.status === 'skipped' && theirs.reason === 'another-player');
    assert.equal(theirs.player, 'mrekk');
    assert.ok(theirs.title.length > 0, 'the refusal says which map it was');
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
        replay_path, imported_at, online_score_id)
       VALUES (?,?,0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,?,?,?,?,?)`,
    );
    insert.run(h.profileId, 'mine', 'Tangy', null, null, null, '900000010');
    insert.run(h.profileId, 'old-name', 'blizzardshiver', null, null, null, '900000011');
    insert.run(h.profileId, 'offline', '', null, null, null, null);
    insert.run(h.profileId, 'guest', 'Guest', null, null, null, null);
    // Downloaded replays: osu! accepted these scores, which is why they carry an id.
    insert.run(h.profileId, 'theirs', 'mrekk', null, null, null, '900000001');
    insert.run(h.profileId, 'theirs-2', 'gnahus', null, null, null, '900000002');
    // No recorded name and no replay left on disk: nothing can attribute it, so it stays.
    insert.run(h.profileId, 'mystery', null, null, null, null, null);
    // An imported osu! score is not a replay at all and is never swept.
    insert.run(h.profileId, 'imported', null, null, null, Date.now(), null);

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
      source: 'signed-in',
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
  assert.deepEqual(replayPlayer(replay()), { name: 'Tangy', userId: null, onlineId: null });
  assert.deepEqual(
    replayPlayer(replay({ client: 'lazer', extras: { user_id: 3119700, mods: [] } })),
    { name: 'Tangy', userId: 3119700, onlineId: null },
  );
  // osu!stable records no id, and a zero is not one.
  assert.deepEqual(
    replayPlayer(replay({ client: 'lazer', extras: { user_id: 0, mods: [] } })),
    { name: 'Tangy', userId: null, onlineId: null },
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

test('a play osu! never accepted is yours, whatever name it carries', () => {
  /*
   * osu!stable's username is a line in a config file. Anyone can set `Username = Cat` and
   * play offline, and the replay then says `Cat` -- a name that may well belong to a real
   * player. Refusing it would throw away exactly the offline plays this app exists to catch.
   *
   * What separates the two is not the name but the score id. A replay you downloaded is by
   * definition one osu! accepted and put on a leaderboard, so it carries one; a play osu!
   * never accepted was never on a leaderboard, so it cannot have been downloaded, so it was
   * set on this machine.
   */
  assert.equal(ownsPlay(OWNER, offlinePlay('Cat')), true);
  assert.equal(ownsPlay(OWNER, offlinePlay('mrekk')), true, 'even a real player\u2019s name');
  assert.equal(certainlySomeoneElse(OWNER, offlinePlay('mrekk')), false);

  // A lazer user id that is not yours does not override it either: an unsubmitted play
  // cannot have come from anywhere but here.
  assert.equal(certainlySomeoneElse(OWNER, offlinePlay('mrekk', 3654106)), false);

  // The downloaded replay of the real player is still refused, which is the whole point.
  assert.equal(ownsPlay(OWNER, player('mrekk')), false);
  assert.equal(certainlySomeoneElse(OWNER, player('mrekk')), true);
});

test('the score id is read from wherever the replay keeps it', () => {
  // osu!stable puts it in the legacy header.
  assert.equal(replayPlayer(replay({ onlineScoreId: 4430944113n })).onlineId, 4430944113);
  // lazer writes 0 there and the real one in its own block, so reading only the header would
  // call every lazer play unsubmitted -- and leave an imported score nothing to match on.
  assert.equal(
    replayPlayer(replay({ client: 'lazer', onlineScoreId: 0n, extras: { online_id: 1716608692 } }))
      .onlineId,
    1716608692,
  );
  // Never submitted: no id in either place.
  assert.equal(replayPlayer(replay({ onlineScoreId: 0n })).onlineId, null);
  assert.equal(replayPlayer(replay({ onlineScoreId: null })).onlineId, null);
});

test('an offline play under someone else\u2019s name survives the sweep', async () => {
  const h = harness();
  try {
    const insert = h.db.prepare(
      `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
        mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
        max_combo, total_score, passed, grade, ranked, played_at, player_name, player_id,
        online_score_id)
       VALUES (?,?,0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,?,NULL,?)`,
    );
    // Played offline as "Cat" for fun: no score id, because osu! never saw it.
    insert.run(h.profileId, 'offline-cat', 'Cat', null);
    // And offline under a name that really does belong to somebody else.
    insert.run(h.profileId, 'offline-mrekk', 'mrekk', null);
    // The genuine article: mrekk's own submitted score, downloaded and watched.
    insert.run(h.profileId, 'watched', 'mrekk', '900000001');

    const sweep = await sweepForeignScores(h.db, h.profileId, OWNER, async () => null);
    assert.equal(sweep.hidden, 1, 'only the downloaded one');

    const gone = h.db
      .prepare('SELECT dedupe_key FROM scores WHERE hidden_at IS NOT NULL')
      .all() as { dedupe_key: string }[];
    assert.deepEqual(gone.map((r) => r.dedupe_key), ['watched']);
  } finally {
    h.cleanup();
  }
});
