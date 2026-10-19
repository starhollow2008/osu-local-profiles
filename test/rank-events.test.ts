import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { updateSettings } from '../src/settings.ts';
import { rankEventsFromJson, type RankEvent } from '../src/clients/osu-web.ts';
import {
  ASK_AFTER_PLAY_MS,
  MATCH_WINDOW_MS,
  rankAccount,
  rankActivityEvents,
  RankEventWatcher,
  saveRankEvents,
} from '../src/rank-events.ts';
import { buildHistory } from '../src/calc/history.ts';
import { UNKNOWN_IDENTITY, type PlayerIdentity } from '../src/player-identity.ts';

/*
 * "achieved rank #488 on ..." in Recent (roadmap 5.79). osu!'s events are the account's; a
 * profile is one playstyle. So what matters is that an event is only ever shown against a play
 * this profile tracked, only the player's own account is asked, and asking stays rare.
 */

const PLAYED = Date.parse('2026-10-07T00:20:30Z');

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-rank-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Main');
  return { db, profileId, cleanup: () => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

let keys = 0;
function play(db: Db, profileId: number, over: Partial<{ beatmapId: number; mode: number; at: number; client: string; player: string; hidden: boolean }> = {}): string {
  const key = `key-${++keys}`;
  db.prepare(
    `INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
                         count300, count100, count50, count_geki, count_katu, count_miss, accuracy, max_combo,
                         total_score, passed, grade, played_at, player_name, hidden_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', 'NM', 100, 0, 0, 0, 0, 0, 1, 100, 1000000, 1, 'A', ?, ?, ?)`,
  ).run(
    profileId, key, over.mode ?? 0, `md5-${key}`, over.beatmapId ?? 2108789, over.client ?? 'lazer',
    over.at ?? PLAYED, over.player ?? 'Tangy', over.hidden ? PLAYED : null,
  );
  return key;
}

const event = (over: Partial<RankEvent> = {}): RankEvent => ({
  id: 1066553565, at: PLAYED + 48_000, rank: 488, grade: 'A', mode: 0, beatmapId: 2108789, ...over,
});

const LINKED: PlayerIdentity = { ...UNKNOWN_IDENTITY, names: new Set(['tangy']), userId: 3119700, source: 'linked', displayName: 'Tangy' };

test("osu!'s recent activity is read for its rank events and nothing else", () => {
  const events = rankEventsFromJson([
    {
      createdAt: '2026-10-07T00:21:18+00:00', id: 1066553565, type: 'rank', scoreRank: 'A', rank: 488, mode: 'osu',
      beatmap: { title: 'Yorushika - Tomin [Collab Extra]', url: '/beatmaps/2108789?ruleset=osu' },
      user: { username: 'Tangy', url: '/users/3119700' },
    },
    { createdAt: '2026-10-07T00:00:00+00:00', id: 2, type: 'achievement', achievement: {} },
    { createdAt: '2026-10-07T00:00:00+00:00', id: 3, type: 'rank', scoreRank: 'S', rank: 5, mode: 'fruits', beatmap: { url: '/beatmaps/77' } },
    { id: 4, type: 'rank', rank: 1, mode: 'osu', beatmap: { url: 'nowhere' } },
  ]);
  assert.deepEqual(events, [
    { id: 1066553565, at: Date.parse('2026-10-07T00:21:18Z'), rank: 488, grade: 'A', mode: 0, beatmapId: 2108789 },
    { id: 3, at: Date.parse('2026-10-07T00:00:00Z'), rank: 5, grade: 'S', mode: 2, beatmapId: 77 },
  ]);
  assert.deepEqual(rankEventsFromJson('nonsense'), []);
});

test("only the player's own linked account is asked about", () => {
  const h = harness();
  try {
    assert.equal(rankAccount(h.db, h.profileId, LINKED), null, 'nothing linked');
    updateSettings(h.db, h.profileId, { linkedUserId: 7562902, linkedUsername: 'mrekk' });
    play(h.db, h.profileId, { player: 'Tangy' });
    assert.equal(rankAccount(h.db, h.profileId, UNKNOWN_IDENTITY), null, "a link for someone else's banner");
    assert.equal(rankAccount(h.db, h.profileId, LINKED), 7562902, 'osu! is signed in here as the linked account');
    updateSettings(h.db, h.profileId, { linkedUserId: 3119700, linkedUsername: 'Tangy' });
    assert.equal(rankAccount(h.db, h.profileId, UNKNOWN_IDENTITY), 3119700, "the profile's plays were set under it");
  } finally {
    h.cleanup();
  }
});

test("an event is kept only against one of this profile's plays", () => {
  const h = harness();
  try {
    const mine = play(h.db, h.profileId);
    play(h.db, h.profileId, { beatmapId: 137120, hidden: true });
    play(h.db, h.profileId, { beatmapId: 555, client: 'mcosu' });
    const added = saveRankEvents(h.db, h.profileId, [
      event(),
      event({ id: 2, mode: 3 }), // another mode
      event({ id: 3, at: PLAYED + MATCH_WINDOW_MS + 60_000 }), // a play set long after
      event({ id: 4, beatmapId: 999 }), // a map this profile never played
      event({ id: 5, beatmapId: 137120 }), // a play removed from the profile
      event({ id: 6, beatmapId: 555 }), // a McOsu play, which never reached osu!
    ]);
    assert.equal(added, 1);
    assert.equal(saveRankEvents(h.db, h.profileId, [event()]), 0, 'the same event read twice is kept once');
    const row = h.db.prepare('SELECT dedupe_key FROM rank_events').get() as { dedupe_key: string };
    assert.equal(row.dedupe_key, mine);

    // Shown in Recent for its mode, with the play's beatmap, merged by time.
    assert.deepEqual(rankActivityEvents(h.db, h.profileId, 3), []);
    const [shown] = rankActivityEvents(h.db, h.profileId, 0);
    assert.equal(shown?.type, 'rank');
    assert.ok(shown?.type === 'rank' && shown.rank === 488 && shown.grade === 'A' && shown.beatmapId === 2108789);
    const feed = buildHistory(h.db, h.profileId, 0, 15, undefined, rankActivityEvents(h.db, h.profileId, 0));
    assert.equal(feed.events[0]?.type, 'rank', 'the newest entry');

    // Removing the play takes its rank with it.
    h.db.prepare('UPDATE scores SET hidden_at = 1 WHERE dedupe_key = ?').run(mine);
    assert.deepEqual(rankActivityEvents(h.db, h.profileId, 0), []);
  } finally {
    h.cleanup();
  }
});

test('a run of plays asks osu! once, after the last of them, and never for McOsu or a fail', async () => {
  const h = harness();
  try {
    updateSettings(h.db, h.profileId, { linkedUserId: 3119700, linkedUsername: 'Tangy' });
    play(h.db, h.profileId);
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    let asked = 0;
    const watcher = new RankEventWatcher({
      db: h.db,
      profileId: () => h.profileId,
      identity: () => UNKNOWN_IDENTITY,
      fetch: async () => {
        asked++;
        return [event()];
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    });

    watcher.played({ client: 'mcosu', grade: 'A' });
    watcher.played({ client: 'lazer', grade: 'F' });
    assert.equal(timers.length, 0);

    watcher.played({ client: 'lazer', grade: 'A' });
    watcher.played({ client: 'stable', grade: 'S' });
    assert.equal(timers.length, 2);
    assert.equal(timers[0]!.cleared, true, 'the second play pushed the request back');
    assert.equal(timers[1]!.ms, ASK_AFTER_PLAY_MS);
    timers[1]!.fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked, 1);
    assert.equal(rankActivityEvents(h.db, h.profileId, 0).length, 1);

    // Offline is quiet.
    const offline = new RankEventWatcher({
      db: h.db,
      profileId: () => h.profileId,
      identity: () => UNKNOWN_IDENTITY,
      fetch: async () => { throw new Error('could not reach osu.ppy.sh'); },
    });
    assert.equal(await offline.catchUp(), 0);
  } finally {
    h.cleanup();
  }
});
