import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import {
  addFavorite,
  favoriteCount,
  favoriteIds,
  listFavorites,
  missingDetails,
  removeFavorite,
  saveDetails,
} from '../src/favorites.ts';
import { extractBeatmapset, type BeatmapsetDetails } from '../src/clients/osu-web.ts';
import { deleteProfile } from '../src/profiles.ts';
import {
  beatmapsetCard,
  getDiffColour,
  getDiffTextColour,
  groupDifficulties,
} from '../web/js/beatmapsets.js';

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-favorites-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  return {
    db,
    profileId,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const details = (id: number, over: Partial<BeatmapsetDetails> = {}): BeatmapsetDetails => ({
  id,
  title: `Title ${id}`,
  artist: 'Artist',
  creator: 'Mapper',
  userId: 42,
  status: 'ranked',
  nsfw: false,
  spotlight: false,
  featuredArtist: false,
  favouriteCount: 10,
  playCount: 1000,
  date: '2020-01-01T00:00:00Z',
  difficulties: [
    { id: id * 10 + 2, mode: 'osu', stars: 5.2, version: 'Insane' },
    { id: id * 10 + 1, mode: 'osu', stars: 2.1, version: 'Normal' },
  ],
  ...over,
});

/* ----------------------------------------------------------------- the list */

test('favouriting is per profile, idempotent, and undone by unfavouriting', () => {
  const h = harness();
  try {
    const other = getOrCreateProfile(h.db, 'Second');
    assert.equal(addFavorite(h.db, h.profileId, 100), true);
    assert.equal(addFavorite(h.db, h.profileId, 100), false, 'a second add changes nothing');
    addFavorite(h.db, other, 200);

    assert.deepEqual(favoriteIds(h.db, h.profileId), [100]);
    assert.deepEqual(favoriteIds(h.db, other), [200]);

    assert.equal(removeFavorite(h.db, h.profileId, 100), true);
    assert.equal(favoriteCount(h.db, h.profileId), 0);
  } finally {
    h.cleanup();
  }
});

test('cards come newest favourite first, and a limit pages them', () => {
  const h = harness();
  try {
    for (let i = 1; i <= 8; i++) {
      addFavorite(h.db, h.profileId, i, 1000 + i);
      saveDetails(h.db, details(i));
    }
    const first = listFavorites(h.db, h.profileId, 6, null);
    assert.deepEqual(first.map((c) => c.id), [8, 7, 6, 5, 4, 3]);
    assert.equal(listFavorites(h.db, h.profileId, 50, null).length, 8);
    assert.equal(favoriteCount(h.db, h.profileId), 8);
  } finally {
    h.cleanup();
  }
});

test("osu!'s details make the card, and are shared by every profile", () => {
  const h = harness();
  try {
    const other = getOrCreateProfile(h.db, 'Second');
    saveDetails(h.db, details(5, { nsfw: true, featuredArtist: true, status: 'loved' }));
    addFavorite(h.db, h.profileId, 5);
    addFavorite(h.db, other, 5);
    for (const profile of [h.profileId, other]) {
      const [card] = listFavorites(h.db, profile, 6, null);
      assert.equal(card!.source, 'osu');
      assert.equal(card!.status, 'loved');
      assert.equal(card!.nsfw, true);
      assert.equal(card!.featuredArtist, true);
      assert.equal(card!.difficulties.length, 2);
    }
  } finally {
    h.cleanup();
  }
});

test('a favourite osu! could not describe is built from local data, and listed as missing', () => {
  const h = harness();
  try {
    h.db
      .prepare(
        `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator, status, cached_at)
         VALUES ('m1', 11, 7, 'Local Artist', 'Local Title', 'Hard', 'Someone', 1, 0)`,
      )
      .run();
    // One nomod score gives the difficulty its star rating; a DT score must not.
    const insert = h.db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         accuracy, max_combo, total_score, passed, grade, stars, played_at)
       VALUES (?, ?, 0, 'm1', 'lazer', ?, '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', ?, 1)`,
    );
    insert.run(h.profileId, 'dt', '[{"acronym":"DT"}]', 6.9);
    insert.run(h.profileId, 'hd', '[{"acronym":"HD"}]', 4.4);

    addFavorite(h.db, h.profileId, 7);
    assert.deepEqual(missingDetails(h.db, h.profileId, 5), [7]);

    const [card] = listFavorites(h.db, h.profileId, 6, null);
    assert.equal(card!.source, 'local');
    assert.equal(card!.title, 'Local Title');
    assert.equal(card!.status, 'ranked');
    assert.deepEqual(card!.difficulties, [{ id: 11, mode: 'osu', stars: 4.4, version: 'Hard' }]);

    saveDetails(h.db, details(7));
    assert.deepEqual(missingDetails(h.db, h.profileId, 5), []);
  } finally {
    h.cleanup();
  }
});

test("deleting a profile takes its favourites with it", () => {
  const h = harness();
  try {
    const other = getOrCreateProfile(h.db, 'Second');
    addFavorite(h.db, other, 9);
    deleteProfile(h.db, other);
    const { n } = h.db.prepare('SELECT COUNT(*) AS n FROM favorite_beatmapsets').get() as { n: number };
    assert.equal(n, 0);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------- osu.ppy.sh's page */

const page = (json: unknown) =>
  `<html><body><script id="json-beatmapset" type="application/json">\n${JSON.stringify(json)}\n</script></body></html>`;

test("the beatmapset page's JSON is reduced to what the card draws", () => {
  const set = extractBeatmapset(
    page({
      id: 8495,
      title: 'So We Can Smile Tomorrow',
      artist: 'Yumi Matsuzawa',
      creator: 'ztrot',
      user_id: 6347,
      status: 'ranked',
      nsfw: false,
      spotlight: true,
      track_id: 123,
      favourite_count: 19,
      play_count: 22968,
      ranked_date: '2009-08-11T06:51:17Z',
      last_updated: '2009-08-11T06:13:25Z',
      beatmaps: [
        { id: 34843, mode: 'osu', difficulty_rating: 3.92933, version: 'GATE OPEN!!!!' },
        { id: 1, mode: 'not-a-mode', difficulty_rating: 1, version: 'dropped' },
      ],
    }),
  );
  assert.ok(set);
  assert.equal(set.featuredArtist, true, 'a track id means Featured Artist');
  assert.equal(set.spotlight, true);
  assert.equal(set.date, '2009-08-11T06:51:17Z', 'a ranked set shows its ranked date');
  assert.deepEqual(set.difficulties, [{ id: 34843, mode: 'osu', stars: 3.92933, version: 'GATE OPEN!!!!' }]);
});

test('a graveyarded set shows when it was last updated', () => {
  const set = extractBeatmapset(
    page({ id: 1, title: 't', artist: 'a', status: 'graveyard', last_updated: '2015-01-01T00:00:00Z', beatmaps: [] }),
  );
  assert.equal(set?.date, '2015-01-01T00:00:00Z');
});

test('a page in any other shape is refused rather than half-read', () => {
  assert.equal(extractBeatmapset('<html>nothing here</html>'), null);
  assert.equal(extractBeatmapset(page({ title: 'no id' })), null);
});

/* ------------------------------------------------------------------ the card */

test("difficulty colours follow osu-web's ramp", () => {
  // Exactly on a stop, the stop's own colour.
  assert.equal(getDiffColour(2), '#4fffd5');
  assert.equal(getDiffColour(0.05), '#AAAAAA');
  assert.equal(getDiffColour(9.5), '#000000');
  assert.equal(getDiffColour(null), null);
  // Between stops, somewhere between them -- and never outside either.
  const mid = getDiffColour(2.25)!;
  assert.match(mid, /^#[0-9a-f]{6}$/);
  assert.notEqual(mid, getDiffColour(2));
  assert.equal(getDiffTextColour(3), '#000000');
  assert.equal(getDiffTextColour(7), '#F6F05C');
});

test('difficulties group by ruleset, easiest first', () => {
  const groups = groupDifficulties([
    { id: 1, mode: 'taiko', stars: 3, version: 'b' },
    { id: 2, mode: 'osu', stars: 5, version: 'c' },
    { id: 3, mode: 'osu', stars: 1, version: 'a' },
  ]);
  assert.deepEqual([...groups.keys()], ['osu', 'taiko']);
  assert.deepEqual(groups.get('osu')!.map((d) => d.version), ['a', 'c']);
});

test('the card escapes what osu! sent and shows only the badges that apply', () => {
  const html = beatmapsetCard({
    id: 3,
    title: '<script>x</script>',
    artist: 'A & B',
    creator: 'm',
    userId: 1,
    status: 'loved',
    nsfw: true,
    spotlight: false,
    featuredArtist: false,
    favouriteCount: 1,
    playCount: 2,
    date: null,
    difficulties: [{ id: 30, mode: 'osu', stars: 2, version: 'N' }],
    source: 'osu',
    favoritedAt: 0,
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('beatmapset-badge--nsfw'));
  assert.ok(!html.includes('beatmapset-badge--spotlight'));
  assert.ok(html.includes('beatmapset-status--loved'));
  assert.ok(html.includes('https://osu.ppy.sh/beatmapsets/3/download'));
});
