import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import { BeatmapResolver, beatmapMode } from '../src/clients/beatmaps.ts';
import { ingestIncompletePlay } from '../src/tracker/incomplete.ts';
import type { ResolvedLoggedPlay } from '../src/clients/lazer-log.ts';
import { computeStats, mostPlayed, recentPlays, modesWithPlays } from '../src/calc/stats.ts';
import { buildHistory } from '../src/calc/history.ts';
import { VANILLA } from '../src/calc/eligibility.ts';

/*
 * Plays osu! counted that produced no score. See src/clients/lazer-log.ts for why they
 * exist at all: lazer imports a score only for a map played to the end, so a quit, a retry
 * or an HP fail is submitted to osu! and then thrown away locally.
 */

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 10, 1, 0, 0);

interface Harness {
  db: Db;
  profileId: number;
  resolver: BeatmapResolver;
  /** A tracked score, so the aggregates have something real to be mixed with. */
  addScore: (md5: string, at: number, opts?: { totalScore?: number; hits?: number }) => void;
  addBeatmap: (md5: string, beatmapId: number, title: string) => void;
  quit: (play: Partial<ResolvedLoggedPlay>) => ReturnType<typeof ingestIncompletePlay>;
  cleanup: () => void;
}

function harness(trackingSince = 0): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-incomplete-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const resolver = new BeatmapResolver(db, []);
  let n = 0;
  let tokens = 0;

  return {
    db,
    profileId,
    resolver,
    addBeatmap: (md5, beatmapId, title) => {
      db.prepare(
        `INSERT OR REPLACE INTO beatmaps
          (md5, beatmap_id, beatmapset_id, artist, title, version, creator, status, cached_at)
         VALUES (?,?,?,?,?,?,?,1,0)`,
      ).run(md5, beatmapId, 900, 'Artist', title, 'Insane', 'Creator');
    },
    addScore: (md5, at, opts = {}) => {
      const hits = opts.hits ?? 100;
      db.prepare(
        `INSERT INTO scores
          (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
           count300, count100, count50, count_geki, count_katu, count_miss,
           accuracy, max_combo, total_score, passed, grade, stars, pp,
           map_status, mods_ranked, mods_countable, ranked, played_at)
         VALUES (?,?,0,?,'lazer','[]','None',?,0,0,0,0,0,0.99,100,?,1,'S',5.0,100,1,1,1,1,?)`,
      ).run(profileId, `score-${++n}`, md5, hits, opts.totalScore ?? 500_000, at);
    },
    quit: (play) =>
      ingestIncompletePlay(
        {
          token: `token-${++tokens}`,
          startedAt: T0,
          countedAt: T0,
          onlineScoreId: '1',
          beatmapName: null,
          passed: false,
          beatmapId: null,
          ...play,
        },
        { db, resolver, profileId, trackingSince },
      ),
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ ingest */

/*
 * The single most important rule here. A passed play is imported by lazer and arrives as a
 * replay; counting the log's account of it as well would double every finished play in the
 * profile.
 */
test('a play that was finished is left to its replay', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    assert.deepEqual(h.quit({ passed: true, beatmapId: 111 }), {
      status: 'skipped',
      reason: 'passed',
    });
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 0);
  } finally {
    h.cleanup();
  }
});

test('an abandoned play is stored against the beatmap it was submitted for', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'Kokoro');
    const result = h.quit({ beatmapId: 111 });
    assert.equal(result.status, 'added');
    assert.equal(result.status === 'added' && result.play.title, 'Artist - Kokoro [Insane]');
    assert.equal(result.status === 'added' && result.play.mode, 0);
  } finally {
    h.cleanup();
  }
});

/* lazer's token is server-issued and unique to the play, so a re-read cannot duplicate it. */
test('the same play read twice is stored once', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    assert.equal(h.quit({ token: 'same', beatmapId: 111 }).status, 'added');
    assert.deepEqual(h.quit({ token: 'same', beatmapId: 111 }), {
      status: 'skipped',
      reason: 'duplicate',
    });
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 1);
  } finally {
    h.cleanup();
  }
});

test('a play from before tracking started is ignored, as a replay would be', () => {
  const h = harness(T0);
  try {
    h.addBeatmap('map-a', 111, 'A');
    assert.deepEqual(h.quit({ beatmapId: 111, countedAt: T0 - 1 }), {
      status: 'skipped',
      reason: 'too-old',
    });
    assert.equal(h.quit({ beatmapId: 111, countedAt: T0 }).status, 'added');
  } finally {
    h.cleanup();
  }
});

/*
 * The fallback for a beatmap lazer's cached online.db has never heard of. The log writes
 * `BeatmapInfo.ToString()`, which is built from the same romanised metadata the cache
 * stores, so this is an equality test rather than a fuzzy one.
 */
test('a beatmap with no known id is found by the name the log wrote', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'Kokoro');
    const result = h.quit({ beatmapId: null, beatmapName: 'Artist - Kokoro (Creator) [Insane]' });
    assert.equal(result.status, 'added');
    const row = h.db.prepare('SELECT beatmap_md5 FROM incomplete_plays').get() as { beatmap_md5: string };
    assert.equal(row.beatmap_md5, 'map-a');
  } finally {
    h.cleanup();
  }
});

/*
 * Without a beatmap there is no mode, and filing the play under osu!standard anyway would
 * inflate one mode's play count with plays that were not set in it.
 */
test('a play whose beatmap cannot be identified is dropped, not guessed at', () => {
  const h = harness();
  try {
    assert.deepEqual(h.quit({ beatmapId: 999, beatmapName: 'Nobody - Nothing (X) [Y]' }), {
      status: 'skipped',
      reason: 'unresolved',
    });
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------- aggregates */

test('the play count includes abandoned plays, because osu! counts them', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    h.addScore('map-a', T0);
    h.quit({ beatmapId: 111, countedAt: T0 + 1000 });
    h.quit({ beatmapId: 111, countedAt: T0 + 2000 });

    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 3);
  } finally {
    h.cleanup();
  }
});

/*
 * Everything a score carries and an abandoned play does not has to stay untouched. osu!'s
 * own hits-per-play divides by a play count that includes failed plays *and* the hits they
 * made; ours has the play count but not the hits, so the ratio is taken over the scored
 * subset rather than being biased low by every quit.
 */
test('abandoned plays move the play count and nothing else', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    h.addScore('map-a', T0, { totalScore: 400_000, hits: 250 });
    const before = computeStats(h.db, h.profileId, 0, VANILLA);

    h.quit({ beatmapId: 111, countedAt: T0 + 1000 });
    const after = computeStats(h.db, h.profileId, 0, VANILLA);

    assert.equal(after.playcount, before.playcount + 1);
    assert.equal(after.hitsPerPlay, before.hitsPerPlay);
    assert.equal(after.totalHits, before.totalHits);
    assert.equal(after.totalScore, before.totalScore);
    assert.equal(after.accuracy, before.accuracy);
    assert.equal(after.totalPp, before.totalPp);
    assert.deepEqual(after.level, before.level);
    assert.deepEqual(after.grades, before.grades);
  } finally {
    h.cleanup();
  }
});

/*
 * The whole point of Most Played: the map someone retried twenty times before finishing it
 * should not appear as the one run they managed to complete.
 */
test('Most Played counts every attempt, finished or not', () => {
  const h = harness();
  try {
    h.addBeatmap('grind', 111, 'Grind');
    h.addBeatmap('easy', 222, 'Easy');
    h.addScore('easy', T0);
    h.addScore('easy', T0 + 1000);
    h.addScore('grind', T0 + 2000);
    for (let i = 0; i < 4; i++) h.quit({ beatmapId: 111, countedAt: T0 + 3000 + i });

    const played = mostPlayed(h.db, h.profileId, 0, 15);
    assert.equal(played[0]!.beatmapMd5, 'grind');
    assert.equal(played[0]!.count, 5);
    assert.equal(played[0]!.title, 'Grind');
    assert.equal(played[1]!.count, 2);
  } finally {
    h.cleanup();
  }
});

test('monthly play counts include abandoned plays, the pp chart does not', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    h.addScore('map-a', T0);
    const before = buildHistory(h.db, h.profileId, 0, 15, VANILLA);

    h.quit({ beatmapId: 111, countedAt: T0 + HOUR });
    h.quit({ beatmapId: 111, countedAt: T0 + 2 * HOUR });
    const after = buildHistory(h.db, h.profileId, 0, 15, VANILLA);

    const total = (h: typeof after) => h.monthlyPlaycounts.reduce((n, m) => n + m.count, 0);
    assert.equal(total(before), 1);
    assert.equal(total(after), 3);
    assert.deepEqual(after.pp, before.pp);
  } finally {
    h.cleanup();
  }
});

/* A profile whose only activity in a mode was abandoned still has to be able to show it. */
test('a mode with only abandoned plays is still a mode with plays', () => {
  const h = harness();
  try {
    h.addBeatmap('map-a', 111, 'A');
    h.quit({ beatmapId: 111 });
    assert.deepEqual(modesWithPlays(h.db, h.profileId), [0]);

    const history = buildHistory(h.db, h.profileId, 0, 15, VANILLA);
    assert.equal(history.monthlyPlaycounts.length, 1);
    assert.equal(history.monthlyPlaycounts[0]!.count, 1);
  } finally {
    h.cleanup();
  }
});

/* --------------------------------------------------------- recent plays */

function recentHarness() {
  const h = harness();
  h.addBeatmap('grind', 111, 'Grind');
  h.addBeatmap('other', 222, 'Other');
  // Newest last: three attempts at one map, a finished run elsewhere, two more attempts.
  h.quit({ beatmapId: 111, countedAt: T0 + 1000 });
  h.quit({ beatmapId: 111, countedAt: T0 + 2000 });
  h.quit({ beatmapId: 111, countedAt: T0 + 3000 });
  h.addScore('other', T0 + 4000);
  h.quit({ beatmapId: 111, countedAt: T0 + 5000 });
  h.quit({ beatmapId: 111, countedAt: T0 + 6000 });
  return h;
}

test('Recent Plays can list every attempt', () => {
  const h = recentHarness();
  try {
    const recent = recentPlays(h.db, h.profileId, 0, 25, VANILLA, 'yes');
    assert.equal(recent.length, 6);
    assert.deepEqual(
      recent.map((p) => p.kind),
      ['incomplete', 'incomplete', 'score', 'incomplete', 'incomplete', 'incomplete'],
    );
  } finally {
    h.cleanup();
  }
});

test('Recent Plays can leave them out entirely', () => {
  const h = recentHarness();
  try {
    const recent = recentPlays(h.db, h.profileId, 0, 25, VANILLA, 'no');
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.kind, 'score');
  } finally {
    h.cleanup();
  }
});

/*
 * The default. Only *consecutive* attempts fold together, so the finished run in the middle
 * still breaks the feed up the way the session actually went.
 */
test('collapsing folds a run of attempts on one map, but not across a finished play', () => {
  const h = recentHarness();
  try {
    const recent = recentPlays(h.db, h.profileId, 0, 25, VANILLA, 'collapse');
    assert.equal(recent.length, 3);

    assert.equal(recent[0]!.kind, 'incomplete');
    assert.equal(recent[0]!.kind === 'incomplete' && recent[0]!.attempts, 2);
    // The row sits where the most recent of its attempts sits.
    assert.equal(recent[0]!.playedAt, T0 + 6000);

    assert.equal(recent[1]!.kind, 'score');

    assert.equal(recent[2]!.kind === 'incomplete' && recent[2]!.attempts, 3);
    assert.equal(recent[2]!.playedAt, T0 + 3000);
  } finally {
    h.cleanup();
  }
});

test('a collapsed run counts as one row against the limit, not as its attempts', () => {
  const h = recentHarness();
  try {
    assert.equal(recentPlays(h.db, h.profileId, 0, 2, VANILLA, 'collapse').length, 2);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------------ mode */

test('the mode of an abandoned play comes from the beatmap, since the log never says', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-mode-'));
  try {
    const file = path.join(tmp, 'map.osu');
    fs.writeFileSync(
      file,
      'osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.mp3\r\nMode: 3\r\n\r\n[Metadata]\r\nMode: 1\r\n',
    );
    // The `Mode` in [Metadata] is not a real key, but a file that carried one must not be
    // able to override the ruleset [General] declares.
    assert.equal(beatmapMode(file), 3);

    const noMode = path.join(tmp, 'plain.osu');
    fs.writeFileSync(noMode, 'osu file format v14\r\n\r\n[General]\r\nAudioFilename: a.mp3\r\n');
    assert.equal(beatmapMode(noMode), 0);
    assert.equal(beatmapMode(path.join(tmp, 'missing.osu')), 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
