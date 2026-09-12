import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LogSession,
  parseSession,
  parseSubmissionBeatmaps,
} from '../src/clients/lazer-log.ts';

/*
 * Every fixture below is the real shape, taken from logs written by lazer 2026.804.2 on the
 * machine this was developed against, with the surrounding noise kept in place -- shaders,
 * the carousel, beatmap update polls -- because the parser's whole job is to pick three
 * lines out of thousands of unrelated ones.
 */

const PASS = `2026-09-10 04:21:35 [verbose]: Game-wide working beatmap updated to Erika - I Don't Know (Nightcore & Cut Ver.) (Mita) [Insane]
2026-09-10 04:21:35 [verbose]: Score submission token retrieved (1776174516)
2026-09-10 04:21:36 [verbose]: 📺 OsuScreenStack#658(depth:5) suspended SoloSongSelect+PlayerLoader#139 (waiting on SoloPlayer#100)
2026-09-10 04:21:36 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#100
2026-09-10 04:21:36 [verbose]: GameplayClockContainer started via call to StartGameplayClock
2026-09-10 04:22:07 [verbose]: Received beatmap updates 2 updates with last id 10749873
2026-09-10 04:22:33 [verbose]: Beginning score submission (token:1776174516)...
2026-09-10 04:22:34 [verbose]: Score submission completed! (token:1776174516 id:7446790760)
2026-09-10 04:22:34 [verbose]: Ending high performance session
2026-09-10 04:22:34 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#555)
2026-09-10 04:23:23 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#100`;

const QUIT = `2026-09-10 01:11:55 [verbose]: Game-wide working beatmap updated to Rin Kagamine - Kokoro (Al-Azif) [Al-Azif MiX]
2026-09-10 01:11:56 [verbose]: Score submission token retrieved (1775729216)
2026-09-10 01:11:56 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
2026-09-10 01:12:58 [verbose]: Beginning score submission (token:1775729216)...
2026-09-10 01:12:59 [verbose]: Score submission completed! (token:1775729216 id:7446699999)
2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) resume to SoloSongSelect+PlayerLoader#139`;

/** Submission completion can follow gameplay exit in a real lazer log. */
const SUBMISSION_AFTER_EXIT = `2026-09-10 01:11:55 [verbose]: Game-wide working beatmap updated to Rin Kagamine - Kokoro (Al-Azif) [Al-Azif MiX]
2026-09-10 01:11:56 [verbose]: Score submission token retrieved (1775729216)
2026-09-10 01:12:58 [verbose]: Beginning score submission (token:1775729216)...
2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
2026-09-10 01:13:00 [verbose]: Score submission completed! (token:1775729216 id:7446699999)`;

/** A pass whose results screen was closed before its submission completed. */
const PASS_SUBMITTED_AFTER_RESULTS = `2026-09-10 04:21:35 [verbose]: Game-wide working beatmap updated to Erika - I Don't Know (Nightcore & Cut Ver.) (Mita) [Insane]
2026-09-10 04:21:35 [verbose]: Score submission token retrieved (1776174516)
2026-09-10 04:21:36 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#100
2026-09-10 04:22:33 [verbose]: Beginning score submission (token:1776174516)...
2026-09-10 04:22:34 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#555)
2026-09-10 04:22:35 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#100
2026-09-10 04:22:36 [verbose]: Score submission completed! (token:1776174516 id:7446790760)`;

/** A retry hit within a second or two of starting: osu! discards this one itself. */
const NO_HITS = `2026-09-10 04:21:11 [verbose]: Game-wide working beatmap updated to Marina and the Diamonds - How to Be a Heartbreaker (Nightcore & Cut Ver.) (Mita) [Amats' Hard]
2026-09-10 04:21:12 [verbose]: Score submission token retrieved (1776173677)
2026-09-10 04:21:13 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
2026-09-10 04:21:17 [verbose]: GameplayClockContainer stopped via call to StopGameplayClock
2026-09-10 04:21:35 [verbose]: No hits registered, skipping score submission
2026-09-10 04:21:35 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414`;

test('a play that reached the results screen is reported as passed', () => {
  const plays = parseSession(PASS);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, true);
  assert.equal(plays[0]!.token, '1776174516');
  assert.equal(plays[0]!.onlineScoreId, '7446790760');
  assert.equal(plays[0]!.beatmapName, "Erika - I Don't Know (Nightcore & Cut Ver.) (Mita) [Insane]");
});

test('a play that was submitted but never reached results is not passed', () => {
  const plays = parseSession(QUIT);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, false);
  assert.equal(plays[0]!.beatmapName, 'Rin Kagamine - Kokoro (Al-Azif) [Al-Azif MiX]');
});

test('submission completion after gameplay exit still reports an unfinished play', () => {
  const plays = parseSession(SUBMISSION_AFTER_EXIT);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, false);
  assert.equal(plays[0]!.token, '1775729216');
  assert.equal(plays[0]!.onlineScoreId, '7446699999');
});

/*
 * Leaving the results screen exits the Player as well. Read as a quit, a pass whose
 * submission landed after that would be counted twice: once from its replay, and again as
 * an unfinished play.
 */
test('a pass stays passed when its submission completes after the results screen closes', () => {
  const plays = parseSession(PASS_SUBMITTED_AFTER_RESULTS);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, true);
  assert.equal(plays[0]!.onlineScoreId, '7446790760');
});

/*
 * The one rule osu! applies itself, and the reason this parser never needs to know it: a
 * play with no hits is never submitted, so there is no submission line to find. Whatever
 * osu! decides not to count, this cannot count either.
 */
test('a play osu! did not submit is not reported at all', () => {
  assert.deepEqual(parseSession(NO_HITS), []);
});

test('timestamps are read as UTC, which is what the log writes', () => {
  const plays = parseSession(QUIT);
  assert.equal(plays[0]!.countedAt, Date.UTC(2026, 8, 10, 1, 12, 59));
  assert.equal(plays[0]!.startedAt, Date.UTC(2026, 8, 10, 1, 11, 56));
});

/*
 * The loader suspends on the gameplay screen the same way the gameplay screen suspends on
 * results. Reading that as "the map was finished" would mark every quit as a pass and drop
 * it, which is exactly the bug this whole feature exists to avoid.
 */
test('the player loader suspending is not a results screen', () => {
  const plays = parseSession(QUIT);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, false);
});

/** Following a live log means being handed the file in whatever chunks it was flushed in. */
test('the same plays are found however the lines are chunked', () => {
  const lines = `${PASS}\n${NO_HITS}\n${QUIT}`.split('\n');

  const whole = new LogSession().feed(lines);
  assert.equal(whole.length, 2);

  for (const size of [1, 2, 3, 5, 7]) {
    const session = new LogSession();
    const out = [];
    for (let i = 0; i < lines.length; i += size) out.push(...session.feed(lines.slice(i, i + size)));
    assert.deepEqual(out, whole, `chunks of ${size}`);
  }
});

/*
 * Starting the app while a map is already being played. The token line is behind us, but
 * the submission is the line that matters and it is still ahead.
 */
test('a play already in progress is still counted when it ends', () => {
  const joined = QUIT.split('\n').slice(3).join('\n');
  const plays = parseSession(joined);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.passed, false);
  assert.equal(plays[0]!.startedAt, null);
  assert.equal(plays[0]!.token, '1775729216');
});

test('a play is reported once, not once per matching line', () => {
  const twice = `${PASS}
2026-09-10 04:23:24 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#556)
2026-09-10 04:23:25 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#100`;
  assert.equal(parseSession(twice).length, 1);
});

test('lines that are not log lines at all are ignored', () => {
  assert.deepEqual(parseSession('not a log line\n\n   \nScore submission completed! (token:1 id:2)'), []);
});

/* ------------------------------------------------------------ the network log */

test('the submission request is what ties a token to a beatmap', () => {
  const network = `2026-09-10 00:56:47 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores successfully completed!
2026-09-10 00:57:13 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores/1775690726 successfully completed!
2026-09-10 01:04:34 [verbose]: Request to https://a.ppy.sh/31829435?1788604870.jpeg successfully completed!`;

  const ids = parseSubmissionBeatmaps(network);
  // Only the submission, which carries a token. The token *request* names the same beatmap
  // but has no token in it yet, so it would map nothing.
  assert.equal(ids.size, 1);
  assert.equal(ids.get('1775690726'), 5438074);
});

/*
 * Multiplayer submits through /rooms/... instead, so it resolves to no beatmap here. That
 * costs nothing: a multiplayer play is always played to the end -- failing there only marks
 * the score `F` rather than stopping the map -- so it arrives as a replay and is dropped.
 */
test('a multiplayer submission is not mistaken for a solo one', () => {
  const network =
    '2026-09-10 01:01:52 [verbose]: Request to https://osu.ppy.sh/api/v2/rooms/4240610/playlist/47763890/scores/1775703124 successfully completed!';
  assert.equal(parseSubmissionBeatmaps(network).size, 0);
});
