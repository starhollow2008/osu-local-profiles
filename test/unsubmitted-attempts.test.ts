import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getOrCreateProfile, type Db } from '../src/db/index.ts';
import {
  BeatmapResolver,
  beatmapMode,
  indexBeatmapFiles,
  type IndexProgress,
} from '../src/clients/beatmaps.ts';
import {
  LogSession,
  parseSessionEvents,
  type SessionAttempt,
  type UnsubmittedAttempt,
} from '../src/clients/lazer-log.ts';
import { LogWatcher } from '../src/tracker/log-watcher.ts';
import {
  attemptKey,
  ingestIncompletePlay,
  ingestUnsubmittedAttempt,
  type IncompleteContext,
} from '../src/tracker/incomplete.ts';
import {
  computeStats,
  modesWithPlays,
  mostPlayed,
  mostPlayedTotal,
  recentPlayTotal,
  recentPlays,
  unsubmittedAttemptCount,
  type IncompletePlay,
} from '../src/calc/stats.ts';
import { buildHistory } from '../src/calc/history.ts';
import { playTimeSeconds } from '../src/calc/play-time.ts';
import { eligibilityOf, VANILLA, type Eligibility } from '../src/calc/eligibility.ts';
import { getSettings, updateSettings } from '../src/settings.ts';
import { defaultTrackingFilter } from '../src/tracking-filter.ts';

/*
 * Attempts osu! could not submit: quits, fails and retries while osu! was offline or signed out.
 *
 * osu! counts nothing it cannot submit, so these are the one kind of play this app records that
 * osu! never did. Two things follow and are what most of this file checks. They are found only
 * from what lazer states outright -- a `No token` line against a solo gameplay screen -- never
 * inferred from a token that is merely absent. And they count only when the profile asks, with
 * every figure that reads unfinished plays moving together when it does.
 */

const REJI = 'Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]';
const YUARU = 'Yuaru - Asu no Yozora Shoukaihan (Speed Up Ver.) (ShogunMoon) [Together]';
const MANIA = 'Camellia - Mania Song (Mapper) [4K Hard]';

const at = (hms: string) => Date.parse(`2026-09-07T${hms}Z`);

/*
 * Taken from a real offline session on this machine (log 1788778412), with the song-select
 * noise between plays trimmed. Three attempts on one map in a row, then a fourth on a map
 * chosen after scrolling past another: each must name the beatmap the game was on as gameplay
 * *began*, not the last one merely highlighted.
 */
const OFFLINE_RETRIES = `2026-09-07 10:54:08 [verbose]: Game-wide working beatmap updated to Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]
2026-09-07 10:54:10 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#109
2026-09-07 10:54:47 [verbose]: No token, skipping score submission
2026-09-07 10:54:47 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#109
2026-09-07 10:54:51 [verbose]: Game-wide working beatmap updated to Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]
2026-09-07 10:56:25 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#136
2026-09-07 10:57:21 [verbose]: No token, skipping score submission
2026-09-07 10:57:21 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#136
2026-09-07 10:57:25 [verbose]: Game-wide working beatmap updated to Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]
2026-09-07 10:57:27 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#273
2026-09-07 10:57:34 [verbose]: No token, skipping score submission
2026-09-07 10:57:34 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#273
2026-09-07 10:59:40 [verbose]: Game-wide working beatmap updated to Maoki Yamamoto - PIRATES BANQUET (thzz) [ame's CAPTAIN]
2026-09-07 10:59:56 [verbose]: Game-wide working beatmap updated to Yuaru - Asu no Yozora Shoukaihan (Speed Up Ver.) (ShogunMoon) [Together]
2026-09-07 10:59:58 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#225
2026-09-07 11:00:06 [verbose]: No token, skipping score submission
2026-09-07 11:00:06 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#225`;

/* Building blocks for the synthetic sequences below, in the same real line shapes. */
const line = (hms: string, body: string) => `2026-09-07 ${hms} [verbose]: ${body}`;
const log = (...lines: string[]) => lines.join('\n');
const working = (hms: string, name: string) =>
  line(hms, `Game-wide working beatmap updated to ${name}`);
const enter = (hms: string, n: number) =>
  line(hms, `📺 OsuScreenStack#658(depth:6) entered SoloPlayer#${n}`);
const exit = (hms: string, n: number) =>
  line(hms, `📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#${n}`);
const noToken = (hms: string) => line(hms, 'No token, skipping score submission');

const attemptsIn = (text: string) => parseSessionEvents(text).attempts;

/* ------------------------------------------------------------------ the parser */

test('an offline session yields one attempt per gameplay screen osu! had no token for', () => {
  const { plays, attempts } = parseSessionEvents(OFFLINE_RETRIES);
  assert.deepEqual(plays, [], 'nothing was submitted, so osu! counted nothing');
  assert.deepEqual(attempts, [
    { player: '109', startedAt: at('10:54:10'), endedAt: at('10:54:47'), beatmapName: REJI },
    { player: '136', startedAt: at('10:56:25'), endedAt: at('10:57:21'), beatmapName: REJI },
    { player: '273', startedAt: at('10:57:27'), endedAt: at('10:57:34'), beatmapName: REJI },
    { player: '225', startedAt: at('10:59:58'), endedAt: at('11:00:06'), beatmapName: YUARU },
  ] satisfies UnsubmittedAttempt[]);
});

test('the same attempts are found however the lines are chunked', () => {
  const session = new LogSession();
  const found: UnsubmittedAttempt[] = [];
  for (const one of OFFLINE_RETRIES.split('\n')) found.push(...session.feedEvents([one]).attempts);
  assert.deepEqual(found, attemptsIn(OFFLINE_RETRIES));
});

/* A pass is imported by lazer and arrives as a replay; counting it here would double it. */
test('an offline pass is left to its replay', () => {
  const pass = log(
    working('12:00:00', REJI),
    enter('12:00:02', 500),
    noToken('12:01:30'),
    line('12:01:30', '📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#500 (waiting on SoloResultsScreen#501)'),
    exit('12:02:10', 500),
  );
  assert.deepEqual(attemptsIn(pass), []);
});

/* The one ordering in 94 where `No token` came after the screen had already closed. */
test('a No token line that lands just after the exit still belongs to that screen', () => {
  const late = log(working('13:00:00', REJI), enter('13:00:02', 300), exit('13:00:15', 300), noToken('13:00:16'));
  assert.deepEqual(attemptsIn(late), [
    { player: '300', startedAt: at('13:00:02'), endedAt: at('13:00:15'), beatmapName: REJI },
  ]);
});

/*
 * A quick retry enters the next screen in the same second the last one closed, so a late line
 * finds a *new* screen open. That screen has only just begun and cannot be the play that ended.
 */
test('a late No token is not handed to the retry that has just started', () => {
  const retry = log(
    working('14:00:00', REJI),
    enter('14:00:02', 100),
    exit('14:00:20', 100),
    enter('14:00:20', 200),
    noToken('14:00:21'),
    noToken('14:00:40'),
    exit('14:00:40', 200),
  );
  assert.deepEqual(attemptsIn(retry), [
    { player: '100', startedAt: at('14:00:02'), endedAt: at('14:00:20'), beatmapName: REJI },
    { player: '200', startedAt: at('14:00:20'), endedAt: at('14:00:40'), beatmapName: REJI },
  ]);
});

/* osu! counted this one itself. A stray line afterwards must not make it an attempt too. */
test('a screen that had a token is never an attempt, whatever follows it', () => {
  const submitted = log(
    working('15:00:00', REJI),
    line('15:00:00', 'Score submission token retrieved (1776174516)'),
    enter('15:00:01', 400),
    line('15:00:30', 'Score submission completed! (token:1776174516 id:7446790760)'),
    exit('15:00:30', 400),
    noToken('15:00:31'),
  );
  const { plays, attempts } = parseSessionEvents(submitted);
  assert.equal(plays.length, 1);
  assert.deepEqual(attempts, []);
});

/*
 * osu!'s own discard -- a token, and nothing hit. That is osu! deciding a play does not count,
 * not osu! being unable to ask, and it stays uncounted exactly as osu! leaves it.
 */
test('a play osu! discarded for registering no hits is not an attempt', () => {
  const noHits = log(
    working('16:00:00', REJI),
    line('16:00:00', 'Score submission token retrieved (1776173677)'),
    enter('16:00:01', 414),
    line('16:00:03', 'No hits registered, skipping score submission'),
    exit('16:00:03', 414),
  );
  assert.deepEqual(parseSessionEvents(noHits), { plays: [], attempts: [] });
});

test('watching a replay or using the skin editor is not an attempt', () => {
  const notPlays = log(
    working('17:00:00', REJI),
    line('17:00:01', '📺 OsuScreenStack#658(depth:6) entered ReplayPlayer#600'),
    noToken('17:00:30'),
    line('17:00:30', '📺 OsuScreenStack#658(depth:5) exit from ReplayPlayer#600'),
    line('17:01:00', '📺 OsuScreenStack#658(depth:3) entered SkinEditorOverlay+EndlessPlayer#700'),
    line('17:01:10', '📺 OsuScreenStack#658(depth:3) exit from SkinEditorOverlay+EndlessPlayer#700'),
  );
  assert.deepEqual(attemptsIn(notPlays), []);
});

test('an attempt still in gameplay when the log ends is not reported', () => {
  assert.deepEqual(attemptsIn(log(working('18:00:00', REJI), enter('18:00:01', 800), noToken('18:00:40'))), []);
});

/* ------------------------------------------------------------------ the index */

interface MapMeta {
  artist: string;
  title: string;
  creator?: string;
  version: string;
  id: number;
  mode?: number;
  /** Moves the last object, so two files can share a name under different checksums. */
  shift?: number;
  /** Written into [General] ahead of Mode, where a bracket in it once hid the mode. */
  audio?: string;
}

const REJI_MAP: MapMeta = {
  artist: 'Reji',
  title: 'Shoujo wa Yoru to Azayaka ni',
  creator: 'ADoorNob',
  version: 'Vivid Collab',
  id: 4000001,
};
const YUARU_MAP: MapMeta = {
  artist: 'Yuaru',
  title: 'Asu no Yozora Shoukaihan (Speed Up Ver.)',
  creator: 'ShogunMoon',
  version: 'Together',
  id: 4000002,
};
const MANIA_MAP: MapMeta = {
  artist: 'Camellia',
  title: 'Mania Song',
  creator: 'Mapper',
  version: '4K Hard',
  id: 4000003,
  mode: 3,
};

/** A .osu thirty seconds long, first object to last. */
const osuFile = (m: MapMeta) =>
  [
    'osu file format v14',
    '',
    '[General]',
    ...(m.audio === undefined ? [] : [`AudioFilename: ${m.audio}`]),
    `Mode: ${m.mode ?? 0}`,
    '',
    '[Metadata]',
    `Title:${m.title}`,
    `Artist:${m.artist}`,
    ...(m.creator === undefined ? [] : [`Creator:${m.creator}`]),
    `Version:${m.version}`,
    `BeatmapID:${m.id}`,
    'BeatmapSetID:2000001',
    '',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:',
    `256,192,${31000 + (m.shift ?? 0)},1,0,0:0:0:0:`,
    '',
  ].join('\r\n');

interface Harness {
  db: Db;
  profileId: number;
  ctx: (overrides?: Partial<IncompleteContext>) => IncompleteContext;
  beatmap: (rel: string, meta: MapMeta) => string;
  index: () => Promise<{ scanned: number; indexed: number }>;
  cleanup: () => void;
}

function harness(): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-unsubmitted-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const files = path.join(tmp, 'files');
  fs.mkdirSync(files, { recursive: true });
  return {
    db,
    profileId,
    // No install at all, and so no online.db: names from the local files are all there is.
    ctx: (overrides = {}) => ({
      db,
      resolver: new BeatmapResolver(db, []),
      profileId,
      trackingSince: 0,
      ...overrides,
    }),
    beatmap: (rel, meta) => {
      const file = path.join(files, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, osuFile(meta));
      return file;
    },
    index: () => indexBeatmapFiles(db, [{ path: files, byExtension: false }]),
    cleanup: () => {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('the index names each beatmap the way lazer names it in its log', async () => {
  const h = harness();
  try {
    const file = h.beatmap('a/map', REJI_MAP);
    await h.index();
    const row = h.db.prepare('SELECT md5, name FROM osu_files WHERE path = ?').get(file) as {
      md5: string;
      name: string;
    };
    assert.equal(row.name, REJI);
    assert.equal(new BeatmapResolver(h.db, []).md5ForBeatmapName(REJI), row.md5);
  } finally {
    h.cleanup();
  }
});

/* An edited copy keeps its name under another checksum. Guessing between them would be a guess. */
test('a name shared by two different files resolves to neither', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    h.beatmap('b/map', { ...REJI_MAP, shift: 500 });
    await h.index();
    assert.equal(new BeatmapResolver(h.db, []).md5ForBeatmapName(REJI), null);
  } finally {
    h.cleanup();
  }
});

test('a file missing part of its name is read once, not on every launch', async () => {
  const h = harness();
  try {
    const file = h.beatmap('a/map', { ...REJI_MAP, creator: undefined });
    await h.index();
    const row = h.db.prepare('SELECT name FROM osu_files WHERE path = ?').get(file) as { name: string };
    assert.equal(row.name, '');
    assert.equal((await h.index()).indexed, 0);
    assert.equal(new BeatmapResolver(h.db, []).md5ForBeatmapName(''), null);
  } finally {
    h.cleanup();
  }
});

/*
 * An index built by an earlier version has ids but no names. It is read once more to fill them
 * in -- the same arrangement as the id backfill before it -- and that re-read is not a first run.
 */
test('an existing index backfills beatmap names once', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-name-migration-'));
  const files = path.join(tmp, 'files');
  const file = path.join(files, 'map');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(file, osuFile(REJI_MAP));

  const dbFile = path.join(tmp, 'test.db');
  const old = new DatabaseSync(dbFile);
  old.exec(
    'CREATE TABLE osu_files (path TEXT PRIMARY KEY, md5 TEXT NOT NULL, beatmap_id INTEGER, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL)',
  );
  old
    .prepare('INSERT INTO osu_files (path, md5, beatmap_id, size, indexed_at) VALUES (?, ?, ?, ?, ?)')
    .run(file, 'stale', 4000001, 0, 0);
  old.close();

  const db = openDb(dbFile);
  try {
    const progress: IndexProgress[] = [];
    const roots = [{ path: files, byExtension: false }];
    const first = await indexBeatmapFiles(db, roots, (p) => progress.push({ ...p }));
    assert.equal(first.indexed, 1, 'the row is read again to fill its name in');
    assert.equal((db.prepare('SELECT name FROM osu_files').get() as { name: string }).name, REJI);
    assert.equal(progress.at(-1)!.firstRun, false);
    assert.equal((await indexBeatmapFiles(db, roots)).indexed, 0, 'and only once');
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ ingest */

const T0 = Date.UTC(2026, 8, 10, 1, 0, 0);

const attempt = (overrides: Partial<SessionAttempt> = {}): SessionAttempt => ({
  session: '1788778412',
  player: '109',
  startedAt: T0,
  endedAt: T0 + 37_000,
  beatmapName: REJI,
  ...overrides,
});

test('an attempt is recorded against its beatmap, found by name with no online.db', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    await h.index();
    const result = ingestUnsubmittedAttempt(attempt(), h.ctx());
    assert.equal(result.status, 'added');
    assert.equal(result.status === 'added' && result.play.unsubmitted, true);

    const row = h.db
      .prepare(
        `SELECT dedupe_key, mode, beatmap_name, started_at, played_at, online_score_id, unsubmitted
           FROM incomplete_plays`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      {
        dedupe_key: attemptKey(attempt()),
        mode: 0,
        beatmap_name: REJI,
        started_at: T0,
        played_at: T0 + 37_000,
        online_score_id: null,
        unsubmitted: 1,
      },
    );
  } finally {
    h.cleanup();
  }
});

test('the same attempt read twice is recorded once', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    await h.index();
    assert.equal(ingestUnsubmittedAttempt(attempt(), h.ctx()).status, 'added');
    assert.deepEqual(ingestUnsubmittedAttempt(attempt(), h.ctx()), {
      status: 'skipped',
      reason: 'duplicate',
    });
    // lazer reuses screen numbers, so the second entered is part of what tells two apart.
    assert.notEqual(attemptKey(attempt({ startedAt: T0 })), attemptKey(attempt({ startedAt: T0 + 1000 })));
  } finally {
    h.cleanup();
  }
});

/* No beatmap, no mode to file it under -- the same rule a play osu! counted follows. */
test('an attempt on a beatmap that is not installed is dropped, and says why', () => {
  const h = harness();
  try {
    assert.deepEqual(ingestUnsubmittedAttempt(attempt(), h.ctx()), {
      status: 'skipped',
      reason: 'unresolved',
    });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM incomplete_plays').get() as { n: number }).n, 0);
  } finally {
    h.cleanup();
  }
});

test('attempts from before tracking started are ignored', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    await h.index();
    assert.deepEqual(ingestUnsubmittedAttempt(attempt(), h.ctx({ trackingSince: T0 + 60_000 })), {
      status: 'skipped',
      reason: 'too-old',
    });
  } finally {
    h.cleanup();
  }
});

/* It knows its beatmap, so the filter judges that; it knows no mods, so those cannot turn it away. */
test('the play tracking filter judges an attempt on what it can know', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    await h.index();
    const byName = ingestUnsubmittedAttempt(
      attempt({ player: '1' }),
      h.ctx({ filter: { ...defaultTrackingFilter(), enabled: true, keywords: 'something else' } }),
    );
    assert.equal(byName.status === 'filtered' && byName.criterion, 'keywords');

    const byMods = ingestUnsubmittedAttempt(
      attempt({ player: '2' }),
      h.ctx({ filter: { ...defaultTrackingFilter(), enabled: true, mods: { DT: 'required' } } }),
    );
    assert.equal(byMods.status, 'added');
  } finally {
    h.cleanup();
  }
});

/* -------------------------------------------------------- whether they count */

test('counting attempts osu! could not submit is a setting, and on by default', () => {
  const h = harness();
  try {
    assert.equal(getSettings(h.db, h.profileId).countUnsubmittedAttempts, true);
    assert.equal(eligibilityOf(getSettings(h.db, h.profileId)).countUnsubmitted, true);
    // osu!'s own rules still leave them out: osu! never received them.
    assert.equal(VANILLA.countUnsubmitted, false);
    const off = updateSettings(h.db, h.profileId, { countUnsubmittedAttempts: false });
    assert.equal(eligibilityOf(off).countUnsubmitted, false);
  } finally {
    h.cleanup();
  }
});

/*
 * The rule `incompleteSql` exists for. Off, the profile agrees with osu!. On, every figure that
 * reads unfinished plays moves at once -- a play count that included them while Most Played or
 * Total Play Time did not would be two answers to one question.
 */
test('attempts count only when the profile asks, and then everywhere at once', async () => {
  const h = harness();
  try {
    h.beatmap('a/map', REJI_MAP);
    h.beatmap('b/map', YUARU_MAP);
    h.beatmap('m/map', MANIA_MAP);
    await h.index();
    const ctx = h.ctx();

    // One play osu! counted: twenty seconds on REJI...
    const counted = ingestIncompletePlay(
      {
        token: '1776174516',
        startedAt: T0,
        countedAt: T0 + 20_000,
        onlineScoreId: '7446790760',
        beatmapName: REJI,
        passed: false,
        beatmapId: null,
      },
      ctx,
    );
    assert.equal(counted.status, 'added');

    // ...then four osu! could not submit, ten seconds each: two more on REJI, one on YUARU, and
    // one in another mode entirely.
    for (const a of [
      attempt({ player: '1', startedAt: T0 + 60_000, endedAt: T0 + 70_000, beatmapName: REJI }),
      attempt({ player: '2', startedAt: T0 + 80_000, endedAt: T0 + 90_000, beatmapName: REJI }),
      attempt({ player: '3', startedAt: T0 + 100_000, endedAt: T0 + 110_000, beatmapName: YUARU }),
      attempt({ player: '4', startedAt: T0 + 120_000, endedAt: T0 + 130_000, beatmapName: MANIA }),
    ]) {
      assert.equal(ingestUnsubmittedAttempt(a, ctx).status, 'added');
    }

    const counting: Eligibility = { ...VANILLA, countUnsubmitted: true };
    const listed = (e: Eligibility, display: 'yes' | 'collapse') =>
      recentPlays(h.db, h.profileId, 0, 25, e, display).filter(
        (p): p is IncompletePlay => p.kind === 'incomplete',
      );
    const titlesAndCounts = (e: Eligibility) =>
      mostPlayed(h.db, h.profileId, 0, 15, e).map((m) => [m.title, m.count]);

    // Off: one play, as osu! has it.
    assert.equal(computeStats(h.db, h.profileId, 0, VANILLA).playcount, 1);
    assert.equal(recentPlayTotal(h.db, h.profileId, 0, VANILLA), 1);
    assert.equal(listed(VANILLA, 'yes').length, 1);
    assert.equal(mostPlayedTotal(h.db, h.profileId, 0, VANILLA), 1);
    assert.deepEqual(titlesAndCounts(VANILLA), [['Shoujo wa Yoru to Azayaka ni', 1]]);
    assert.equal(buildHistory(h.db, h.profileId, 0, 15, VANILLA).monthlyPlaycounts.at(-1)!.count, 1);
    assert.equal(playTimeSeconds(h.db, h.profileId, 0, VANILLA), 20);
    assert.deepEqual(modesWithPlays(h.db, h.profileId, VANILLA), [0]);

    // On: all of it, together.
    assert.equal(computeStats(h.db, h.profileId, 0, counting).playcount, 4);
    assert.equal(recentPlayTotal(h.db, h.profileId, 0, counting), 4);
    assert.equal(listed(counting, 'yes').length, 4);
    assert.equal(mostPlayedTotal(h.db, h.profileId, 0, counting), 2);
    assert.deepEqual(titlesAndCounts(counting), [
      ['Shoujo wa Yoru to Azayaka ni', 3],
      ['Asu no Yozora Shoukaihan (Speed Up Ver.)', 1],
    ]);
    assert.equal(buildHistory(h.db, h.profileId, 0, 15, counting).monthlyPlaycounts.at(-1)!.count, 4);
    assert.equal(playTimeSeconds(h.db, h.profileId, 0, counting), 50);
    assert.equal(computeStats(h.db, h.profileId, 0, counting).playTime, 50);
    assert.deepEqual(modesWithPlays(h.db, h.profileId, counting), [0, 3]);

    // Recent Plays folds a run of one kind only, so each row's label is true of all it holds.
    assert.deepEqual(
      listed(counting, 'collapse').map((r) => [r.title, r.unsubmitted, r.attempts]),
      [
        ['Asu no Yozora Shoukaihan (Speed Up Ver.)', true, 1],
        ['Shoujo wa Yoru to Azayaka ni', true, 2],
        ['Shoujo wa Yoru to Azayaka ni', false, 1],
      ],
    );

    // Recorded either way, across every mode, for Settings to say how many there are.
    assert.equal(unsubmittedAttemptCount(h.db, h.profileId), 4);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------------ the live log */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough for the watcher's own debounce plus the filesystem event. */
const SETTLED_MS = 1200;

test('the live log watcher hands an attempt on with the session it came from', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-attempt-logs-'));
  const seen: SessionAttempt[] = [];
  const watcher = new LogWatcher({
    dirs: [dir],
    onPlays: () => undefined,
    onAttempts: (attempts) => seen.push(...attempts),
    onError: () => undefined,
  });
  try {
    const runtime = path.join(dir, '1788778412.runtime.log');
    fs.writeFileSync(runtime, '');
    watcher.start();
    // Let the watch come up before the first write; see the fs.watch rule in CLAUDE.md.
    await sleep(SETTLED_MS);
    fs.appendFileSync(runtime, `${OFFLINE_RETRIES.split('\n').slice(0, 4).join('\n')}\n`);
    for (let i = 0; i < 40 && seen.length < 1; i++) await sleep(100);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.session, '1788778412');
    assert.equal(seen[0]!.player, '109');
    assert.equal(seen[0]!.beatmapName, REJI);
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * `[` is ordinary inside a .osu value, and a section used to end at the first one: this mapper's
 * name lost the beatmap its name and its id, and this audio file's name hid its mode. Both shapes
 * are real ones from this machine's library, where the old rule lost or corrupted 327 names and
 * filed 23 beatmaps under the wrong mode.
 */
test('a bracket inside a value does not end the section it is in', async () => {
  const h = harness();
  try {
    const file = h.beatmap('a/map', {
      artist: 'Reol',
      title: 'Saisaki',
      creator: 'cRyo[iceeicee]',
      version: 'Extra',
      id: 4000010,
      mode: 3,
      audio: '[HD] Reol - Saisaki.mp3',
    });
    await h.index();

    const name = 'Reol - Saisaki (cRyo[iceeicee]) [Extra]';
    const row = h.db.prepare('SELECT md5, name, beatmap_id FROM osu_files WHERE path = ?').get(file) as {
      md5: string;
      name: string;
      beatmap_id: number;
    };
    assert.equal(row.name, name);
    assert.equal(row.beatmap_id, 4000010, 'BeatmapID comes after the bracket, and must survive it');
    assert.equal(new BeatmapResolver(h.db, []).md5ForBeatmapName(name), row.md5);
    assert.equal(beatmapMode(file), 3);
  } finally {
    h.cleanup();
  }
});
