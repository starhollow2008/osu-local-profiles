import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dialFill,
  flooredAccuracy,
  rankCutoffs,
  scoreCard,
  statisticsFor,
} from '../web/js/score-card.js';
import { playRow } from '../web/js/sections.js';

/*
 * View Details (roadmap 5.21): osu!'s score page as a card, drawn from what `/api/scores/:id`
 * answers (`Scores.Detail` in dotnet/App/Scores.cs, tested in ScoresTests), and a score's row.
 */

/** A lazer score's detail, as the app answers it. */
const detail = {
  kind: 'score',
  id: 1,
  beatmapMd5: 'md5-map',
  beatmapId: 3770193,
  beatmapsetId: 1830679,
  artist: 'Taylor Swift',
  title: 'Cruel Summer',
  artistUnicode: null,
  titleUnicode: null,
  version: "Seolv's Hard",
  creator: 'funny',
  mods: [],
  accuracy: 0.9799,
  maxCombo: 179,
  totalScore: 1075799,
  grade: 'A',
  stars: 3.1,
  pp: 44.2,
  ranked: true,
  passed: true,
  playedAt: 1788000000000,
  weight: null,
  weightedPp: null,
  counted: true,
  pinned: false,
  hasReplay: true,
  source: 'replay',
  osuUrl: null,
  ppBasis: 'as-played',
  mode: 0,
  client: 'lazer',
  statistics: { great: 134, ok: 2, meh: 0, miss: 2 },
  maximumStatistics: {},
  perfectCombo: false,
  difficultyStars: 3.1,
  creatorId: null,
  replayAvailable: true,
  ppBreakdown: null,
  ppVersion: null,
};

const owner = {
  name: 'Tangy',
  avatar: '<img src="/api/image/avatar" alt="">',
  country: 'US',
  countryName: 'United States',
  cover: null,
  tracking: true,
};

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

test('the card escapes what came from files, and offers a download only when there is one', () => {
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
});

test('a score row shows its star rating only when asked', () => {
  const play = { id: 1, title: 'Heart no Shuchou', artist: 'CHiCO', version: "Kowari's Confession", stars: 6.18, mods: [] };
  const plain = playRow(play);
  assert.match(plain, /Kowari&#39;s Confession<\/span>|Kowari's Confession<\/span>/);
  assert.doesNotMatch(plain, /6\.18|&#9733;/);
  assert.match(playRow(play, { starRating: true }), /Kowari(&#39;|')s Confession &middot; 6\.18&#9733;<\/span>/);
});
