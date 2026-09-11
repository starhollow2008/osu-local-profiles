import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { createProfile, setActiveProfile } from '../src/profiles.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { startServer } from '../src/http/server.ts';
import { saveDetails } from '../src/favorites.ts';
import {
  applyScoreAction,
  attachmentHeader,
  legacyStatistics,
  replayDownload,
  replayFileName,
  scoreDetail,
} from '../src/scores.ts';
import {
  dialFill,
  flooredAccuracy,
  rankCutoffs,
  scoreCard,
  statisticsFor,
} from '../web/js/score-card.js';

/*
 * View Details and Download Replay (roadmap 5.21): osu!'s score page as a card, and the
 * score's replay file handed to the browser.
 */

interface Row {
  md5?: string;
  mode?: number;
  client?: 'lazer' | 'stable';
  mods?: string;
  stars?: number | null;
  grade?: string;
  maxCombo?: number;
  mapMax?: number | null;
  statistics?: Record<string, number> | null;
  maximum?: Record<string, number> | null;
  replay?: string | null;
  counts?: [number, number, number, number, number, number];
}

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-details-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Tangy');
  let n = 0;

  const add = (r: Row = {}, profile = profileId): number => {
    n++;
    const [c300, c100, c50, geki, katu, miss] = r.counts ?? [100, 2, 1, 0, 0, 1];
    db.prepare(
      `INSERT INTO scores
        (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
         count300, count100, count50, count_geki, count_katu, count_miss,
         statistics_json, max_statistics_json,
         accuracy, max_combo, total_score, passed, grade, stars, pp, beatmap_max_combo,
         map_status, mods_ranked, mods_countable, ranked, played_at, replay_path)
       VALUES (?,?,?,?,?,?,?,'',?,?,?,?,?,?,?,?,0.9799,?,1075799,1,?,?,44.2,?,1,1,1,1,?,?)`,
    ).run(
      profile, `key-${n}`, r.mode ?? 0, r.md5 ?? 'md5-map', 3770193, r.client ?? 'lazer', r.mods ?? '[]',
      c300, c100, c50, geki, katu, miss,
      r.statistics === undefined ? JSON.stringify({ great: 134, ok: 2, meh: 0, miss: 2 }) : r.statistics && JSON.stringify(r.statistics),
      r.maximum === undefined ? null : r.maximum && JSON.stringify(r.maximum),
      r.maxCombo ?? 179, r.grade ?? 'A', r.stars === undefined ? 3.1 : r.stars,
      r.mapMax === undefined ? 200 : r.mapMax,
      Date.now() + n * 1000,
      r.replay === undefined ? null : r.replay,
    );
    return (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  };

  db.prepare(
    `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator, cached_at)
     VALUES ('md5-map', 3770193, 1830679, 'Taylor Swift', 'Cruel Summer', 'Seolv''s Hard', 'funny', 0)`,
  ).run();

  const replay = (name: string, bytes: string | Buffer = 'replay bytes') => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  return {
    db,
    tmp,
    profileId,
    add,
    replay,
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------- the stats */

test("a stable score's counters read as lazer's judgements for its ruleset", () => {
  const counts = { count300: 300, count100: 100, count50: 50, countGeki: 30, countKatu: 10, countMiss: 5 };
  assert.deepEqual(legacyStatistics(0, counts), { great: 300, ok: 100, meh: 50, miss: 5 });
  assert.deepEqual(legacyStatistics(1, counts), { great: 300, ok: 100, miss: 5 });
  // catch: the 100 is a droplet and the katu a missed one.
  assert.deepEqual(legacyStatistics(2, counts), {
    great: 300, large_tick_hit: 100, small_tick_hit: 50, small_tick_miss: 10, miss: 5,
  });
  // mania: the geki is a perfect and the katu a good.
  assert.deepEqual(legacyStatistics(3, counts), {
    perfect: 30, great: 300, good: 10, ok: 100, meh: 50, miss: 5,
  });
});

test("the card lists osu!'s judgements, and a bonus row only when the map could give one", () => {
  // Real statistics from a lazer replay on this machine's corpus.
  const { basic, extra } = statisticsFor({
    mode: 0,
    statistics: { miss: 16, meh: 1, ok: 3, great: 475, large_tick_hit: 24, ignore_hit: 259, slider_tail_hit: 258 },
    maximumStatistics: { great: 495, large_tick_hit: 24, ignore_hit: 260, slider_tail_hit: 260 },
  });
  assert.deepEqual(basic.map((s) => [s.label, s.value]), [['great', 475], ['ok', 3], ['meh', 1], ['Miss', 16]]);
  // slider end sums small ticks and tails, as osu-web does; no spinner rows on a map without one.
  assert.deepEqual(
    extra.map((s) => [s.label, s.value, s.maximumValue]),
    [['slider tick', 24, 24], ['slider end', 258, 260]],
  );

  // A stable score has no maxima, so it shows the judgements and nothing else -- as on osu!.
  assert.equal(statisticsFor({ mode: 0, statistics: { great: 1 }, maximumStatistics: {} }).extra.length, 0);
  assert.deepEqual(
    statisticsFor({ mode: 3, statistics: {}, maximumStatistics: {} }).basic.map((s) => s.attribute),
    ['perfect', 'great', 'good', 'ok', 'meh', 'miss'],
  );
});

test('the dial fills only as far as the grade the score was given', () => {
  const cutoffs = rankCutoffs(0, false);
  assert.deepEqual(cutoffs, [0, 0.7, 0.8, 0.9, 0.95, 0.99, 1]);
  // 97.99% with misses is an A, and an A ends at 95%.
  assert.equal(dialFill(0.9799, 'A', cutoffs), 0.95);
  assert.equal(dialFill(0.9312, 'A', cutoffs), 0.9312);
  assert.equal(dialFill(1, 'X', cutoffs), 1);
  // osu-web gives a failed score an empty ring.
  assert.equal(dialFill(0.9, 'F', cutoffs), 0);
  // Floored, not rounded, as osu! displays accuracy.
  assert.equal(flooredAccuracy(0.99999), 0.9999);
  // stable's thresholds are its own.
  assert.equal(rankCutoffs(0, true)[4], 0.933);
});

const owner = {
  name: 'Tangy',
  avatar: '<img src="/api/image/avatar" alt="">',
  country: 'US',
  countryName: 'United States',
  cover: null,
  tracking: true,
};

test('the card escapes what came from files, and offers a download only when there is one', () => {
  const h = harness();
  try {
    const id = h.add({ replay: h.replay('a.osr') });
    const detail = scoreDetail(h.db, h.profileId, id)!;
    const card = scoreCard(
      { ...detail, title: '<script>alert(1)</script>', version: '"><b>x' },
      { ...owner, name: '<img onerror=1>' },
    );
    assert.ok(!card.includes('<script>alert'), 'a beatmap title is text, not markup');
    assert.ok(!card.includes('<img onerror'), 'so is the profile name');
    assert.ok(card.includes('data-replay-download'), 'the replay is on disk');
    assert.ok(card.includes('score-dial'), 'a lazer score gets the dial');

    const none = scoreCard({ ...detail, replayAvailable: false }, owner);
    assert.ok(!none.includes('data-replay-download'), 'no button for a replay that is not there');

    // A stable score gets its letter instead, except F, which osu! has no letter for.
    assert.ok(scoreCard({ ...detail, client: 'stable' }, owner).includes('legacy-rank'));
    assert.ok(scoreCard({ ...detail, client: 'stable', grade: 'F' }, owner).includes('score-dial'));
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------ the detail */

test("a score's detail carries what the score page needs", () => {
  const h = harness();
  try {
    const id = h.add({
      client: 'stable',
      statistics: null,
      counts: [495, 0, 0, 0, 0, 0],
      maxCombo: 200,
      replay: h.replay('stable.osr'),
    });
    const d = scoreDetail(h.db, h.profileId, id)!;
    assert.equal(d.client, 'stable');
    assert.deepEqual(d.statistics, { great: 495, ok: 0, meh: 0, miss: 0 });
    assert.deepEqual(d.maximumStatistics, {});
    assert.equal(d.perfectCombo, true);
    assert.equal(d.replayAvailable, true);
    assert.equal(d.title, 'Cruel Summer');

    // Without the beatmap's maximum there is no telling a full combo, so it is not claimed.
    assert.equal(scoreDetail(h.db, h.profileId, h.add({ mapMax: null }))!.perfectCombo, null);

    // Removed and other profiles' scores are not there to look at.
    applyScoreAction(h.db, h.profileId, id, 'hide');
    assert.equal(scoreDetail(h.db, h.profileId, id), null);
    const other = createProfile(h.db, 'Other').id;
    assert.equal(scoreDetail(h.db, other, h.add({}, h.profileId)), null);
  } finally {
    h.cleanup();
  }
});

test("the difficulty badge is the map's rating, never a modded score's", () => {
  const h = harness();
  try {
    const dt = h.add({ mods: '[{"acronym":"DT"}]', stars: 4.6 });
    // Only a DT score: its 4.6 stars are not the difficulty's, so nothing is shown.
    assert.equal(scoreDetail(h.db, h.profileId, dt)!.difficultyStars, null);

    // An HD score leaves the rating alone, so it can speak for the difficulty -- DT's card too.
    h.add({ mods: '[{"acronym":"HD"}]', stars: 3.42 });
    assert.equal(scoreDetail(h.db, h.profileId, dt)!.difficultyStars, 3.42);

    // osu!'s own figure wins when the set has been favourited.
    saveDetails(h.db, {
      id: 1830679, title: 'Cruel Summer', artist: 'Taylor Swift', creator: 'funny', userId: 99,
      status: 'ranked', nsfw: false, spotlight: false, featuredArtist: false, video: false,
      storyboard: false, favouriteCount: 0, playCount: 0, date: null,
      difficulties: [{ id: 3770193, mode: 'osu', stars: 3.5, version: "Seolv's Hard" }],
    });
    const d = scoreDetail(h.db, h.profileId, dt)!;
    assert.equal(d.difficultyStars, 3.5);
    assert.equal(d.creatorId, 99);
  } finally {
    h.cleanup();
  }
});

/* --------------------------------------------------------------- replays */

test("a downloaded replay is named the way lazer names an exported one", () => {
  const playedAt = new Date(2026, 8, 10, 20, 36).getTime(); // local time, as lazer stamps it
  assert.equal(
    replayFileName({
      player: 'Tangy', artist: 'Taylor Swift', title: 'Cruel Summer', creator: 'funny',
      version: "Seolv's Hard", playedAt,
    }),
    "Tangy playing Taylor Swift - Cruel Summer (funny) [Seolv's Hard] (2026-09-10_20-36).osr",
  );
  // Characters a file name cannot have are dropped, as lazer's GetValidFilename does.
  assert.equal(
    replayFileName({ player: 'a/b', artist: null, title: 'Why?: "no"', creator: null, version: null, playedAt }),
    'ab playing unknown artist - Why no (2026-09-10_20-36).osr',
  );
  const long = replayFileName({ player: 'x', artist: 'y'.repeat(400), title: 't', creator: null, version: null, playedAt });
  assert.ok(long.length <= 204 && long.endsWith('.osr'));
});

test('a non-ASCII name survives the download header', () => {
  const header = attachmentHeader('Tangy playing 竹達彩奈 - 時の歌 (2026-09-10_20-36).osr');
  assert.match(header, /^attachment; filename="Tangy playing [_]+ - [_]+ \(2026-09-10_20-36\)\.osr"; /);
  const encoded = /filename\*=UTF-8''(.+)$/.exec(header)?.[1] ?? '';
  assert.equal(decodeURIComponent(encoded), 'Tangy playing 竹達彩奈 - 時の歌 (2026-09-10_20-36).osr');
  assert.ok(!/['()]/.test(encoded), 'RFC 5987 leaves no bare quote or bracket');
});

test('a replay is served only for a score of this profile whose file is on disk', () => {
  const h = harness();
  try {
    const ok = h.add({ replay: h.replay('ok.osr') });
    const found = replayDownload(h.db, h.profileId, ok, 'Tangy');
    assert.ok('path' in found);
    assert.equal(fs.readFileSync(found.path, 'utf8'), 'replay bytes');

    assert.match((replayDownload(h.db, h.profileId, h.add(), 'Tangy') as { error: string }).error, /no replay/);
    const gone = h.add({ replay: path.join(h.tmp, 'deleted-by-osu.osr') });
    assert.match((replayDownload(h.db, h.profileId, gone, 'Tangy') as { error: string }).error, /no longer/);

    const other = createProfile(h.db, 'Other').id;
    assert.ok('error' in replayDownload(h.db, other, ok, 'Tangy'));
    applyScoreAction(h.db, h.profileId, ok, 'hide');
    assert.ok('error' in replayDownload(h.db, h.profileId, ok, 'Tangy'));
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------ over HTTP */

async function withServer(fn: (base: string, h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness();
  const tracker = new Tracker({
    db: h.db,
    resolver: new BeatmapResolver(h.db, []),
    installs: [],
    profileId: h.profileId,
    trackingSince: 0,
    official: null,
  });
  const server = startServer({
    db: h.db,
    tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir: h.tmp,
    port: 0,
    appConfig: { get: () => ({ openBrowser: false }), set: () => {} },
  });
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, h);
  } finally {
    server.close();
    h.cleanup();
  }
}

test('the page can read a score and download its replay', async () => {
  await withServer(async (base, h) => {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
    const id = h.add({ replay: h.replay('real.osr', bytes) });

    const detail = await fetch(`${base}/api/scores/${id}`);
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as { score: { id: number; hasReplay: boolean; replayAvailable: boolean } };
    assert.equal(body.score.id, id);
    assert.equal(body.score.hasReplay, true);
    assert.equal(body.score.replayAvailable, true);

    // HEAD is how the page asks before starting a download: the headers, no body.
    const head = await fetch(`${base}/api/scores/${id}/replay`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));

    const r = await fetch(`${base}/api/scores/${id}/replay`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/x-osu-replay');
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="Tangy playing Taylor Swift - Cruel Summer/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes, 'the file exactly as osu! wrote it');

    const none = h.add();
    const missing = await fetch(`${base}/api/scores/${none}/replay`);
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /no replay/);
    assert.equal((await fetch(`${base}/api/scores/999999`)).status, 404);
    // The route takes an id and nothing else; a path in the URL is simply not a route.
    assert.equal((await fetch(`${base}/api/scores/..%2F..%2Fdata/replay`)).status, 404);
  });
});

/*
 * A score's own page, `/scores/<id>` -- this app's `osu.ppy.sh/scores/<id>`. Its link is
 * copied to be pasted later, so it has to keep working after the page switches profile.
 */
test("a score's link is its own page, and outlives a profile switch", async () => {
  await withServer(async (base, h) => {
    const id = h.add({ replay: h.replay('mine.osr') });

    const page = await fetch(`${base}/scores/${id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /score-page\.js/);
    assert.equal((await fetch(`${base}/scores/abc`)).status, 404);

    type Answer = { score: { id: number }; owner: { id: number; name: string; active: boolean; avatar: string | null } };
    const before = (await (await fetch(`${base}/api/scores/${id}`)).json()) as Answer;
    assert.deepEqual([before.owner.name, before.owner.active], ['Tangy', true]);

    // Switch to another profile: the score still answers, as Tangy's, and says it is not active.
    const other = createProfile(h.db, 'Other').id;
    setActiveProfile(h.db, other);
    const after = (await (await fetch(`${base}/api/scores/${id}`)).json()) as Answer;
    assert.equal(after.score.id, id);
    assert.deepEqual([after.owner.id, after.owner.name, after.owner.active], [h.profileId, 'Tangy', false]);
    assert.equal((await fetch(`${base}/api/scores/${id}/replay`, { method: 'HEAD' })).status, 200);

    // A removed score has no page to show.
    applyScoreAction(h.db, h.profileId, id, 'hide');
    assert.equal((await fetch(`${base}/api/scores/${id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/scores/${id}/screenshot`)).status, 404);
  });
});
