import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dialFill,
  flooredAccuracy,
  rankCutoffs,
  scoreCard,
} from '../web/js/score-card.js';
import { playRow, rowLooks } from '../web/js/sections.js';
import { statisticsFor } from '../web/js/statistics.js';

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
  assert.ok(none.includes(`data-pp-calc="${detail.id}"`), 'the pp calculator is a click away either way');

  // A stable score gets its letter instead, except F, which osu! has no letter for.
  assert.ok(scoreCard({ ...detail, client: 'stable' }, owner).includes('legacy-rank'));
  assert.ok(scoreCard({ ...detail, client: 'stable', grade: 'F' }, owner).includes('score-dial'));
});

test("a modded score's card shows the difficulty's star rating and its own, naming the mods (issue #32)", () => {
  /** The ratings the card's header shows, in order, and the mods named beside them. */
  const ratings = (score: Record<string, unknown>) => {
    const card = scoreCard({ ...detail, ...score }, owner);
    const header = card.slice(card.indexOf('score-beatmap__detail'), card.indexOf('beatmap-list-item__col--main'));
    return {
      shown: [...header.matchAll(/difficulty-badge__rating">([^<]*)</g)].map((m) => m[1]),
      mods: header.match(/score-beatmap__stars-mods">([^<]*)</)?.[1] ?? null,
      arrow: header.includes('score-beatmap__stars-arrow'),
    };
  };

  // No mods, or only mods that leave the rating alone: one rating.
  assert.deepEqual(ratings({ stars: 3.1, difficultyStars: 3.1 }), { shown: ['3.10'], mods: null, arrow: false });
  assert.deepEqual(ratings({ mods: [{ acronym: 'HD' }], ratingMods: [], stars: 3.1, difficultyStars: 3.1 }), { shown: ['3.10'], mods: null, arrow: false });
  // Neither known: none, rather than a guess.
  assert.deepEqual(ratings({ stars: null, difficultyStars: null }), { shown: [], mods: null, arrow: false });

  // DT, HR: without mods, an arrow, then the score's own with the mods that changed it.
  assert.deepEqual(ratings({ mods: [{ acronym: 'HD' }, { acronym: 'DT' }], ratingMods: ['DT'], stars: 4.52, difficultyStars: 3.1 }),
    { shown: ['3.10', '4.52'], mods: '+DT', arrow: true });
  assert.deepEqual(ratings({ ratingMods: ['HR', 'DT'], stars: 4.9, difficultyStars: 3.1 }), { shown: ['3.10', '4.90'], mods: '+HRDT', arrow: true });
  // The difficulty's not known: the score's own, still marked as modded.
  assert.deepEqual(ratings({ ratingMods: ['DT'], stars: 4.52, difficultyStars: null }), { shown: ['4.52'], mods: '+DT', arrow: false });
  // A mod that changed nothing a reader could see: one rating.
  assert.deepEqual(ratings({ ratingMods: ['DA'], stars: 3.1, difficultyStars: 3.1 }), { shown: ['3.10'], mods: null, arrow: false });
  // With no mods at all, the score's own rating is the difficulty's.
  assert.deepEqual(ratings({ ratingMods: [], stars: 3.1, difficultyStars: null }), { shown: ['3.10'], mods: null, arrow: false });
});

test('a score row shows its star rating only when asked', () => {
  const play = { id: 1, title: 'Heart no Shuchou', artist: 'CHiCO', version: "Kowari's Confession", stars: 6.18, mods: [] };
  const plain = playRow(play);
  assert.match(plain, /Kowari&#39;s Confession<\/span>|Kowari's Confession<\/span>/);
  assert.doesNotMatch(plain, /6\.18|&#9733;/);
  assert.match(playRow(play, { starRating: true }), /Kowari(&#39;|')s Confession &middot; 6\.18&#9733;<\/span>/);
});

test("a score row can show the star rating as osu!'s badge, its judgements and its beatmap's background", () => {
  const play = {
    id: 1, title: 'Heart no Shuchou', artist: 'CHiCO', version: "Kowari's Confession", stars: 6.18, mods: [{ acronym: 'HD' }],
    mode: 0, beatmapsetId: 1830679, statistics: { great: 1045, ok: 21, meh: 0, miss: 2, large_tick_hit: 40 },
  };
  const plain = playRow(play);
  assert.doesNotMatch(plain, /difficulty-badge|play-detail__judgements|play-detail--cover|--cover/);

  // The badge before the difficulty's name, and no text star rating after it.
  const badged = playRow(play, { starRating: true, starBadge: true });
  assert.match(badged, /class="difficulty-badge"[\s\S]*6\.18[\s\S]*Kowari(&#39;|')s Confession<\/span>/);
  assert.doesNotMatch(badged, /&#9733;/);
  // A badge with the star rating hidden is no star rating at all.
  assert.doesNotMatch(playRow(play, { starBadge: true }), /difficulty-badge/);

  // osu!'s four judgements for the ruleset, in its order, after the mods and before the pp.
  const judged = playRow(play, { judgements: true });
  const counts = [...judged.matchAll(/play-detail__judgement--(\w+)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(counts, [['great', '1,045'], ['ok', '21'], ['meh', '0'], ['miss', '2']]);
  assert.ok(judged.indexOf('play-detail__mods') < judged.indexOf('play-detail__judgements'));
  assert.ok(judged.indexOf('play-detail__judgements') < judged.indexOf('play-detail__pp'));
  // A taiko score has three.
  assert.equal(playRow({ ...play, mode: 1 }, { judgements: true }).match(/play-detail__judgement--/g)?.length, 3);

  // Its combo under them, out of the beatmap's (issue #44), green only for a full combo.
  const combo = (row: string) => /class="play-detail__combo"[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1]?.replace(/<[^>]+>/g, '');
  assert.equal(combo(playRow({ ...play, maxCombo: 1101, beatmapMaxCombo: 1245 }, { judgements: true })), '1,101/1,245x');
  assert.doesNotMatch(playRow({ ...play, maxCombo: 1101, beatmapMaxCombo: 1245 }, { judgements: true }), /combo-value--full/);
  assert.match(playRow({ ...play, maxCombo: 1245, beatmapMaxCombo: 1245 }, { judgements: true }), /combo-value--full/);
  const both = playRow({ ...play, maxCombo: 5 }, { judgements: true });
  assert.ok(both.indexOf('play-detail__judgements') < both.indexOf('play-detail__combo'));
  assert.ok(both.indexOf('play-detail__combo') < both.indexOf('play-detail__pp'));
  // Before osu!'s calculator has priced it, the beatmap's is not known: the score's own alone.
  assert.equal(combo(playRow({ ...play, maxCombo: 1101 }, { judgements: true })), '1,101x');
  assert.doesNotMatch(playRow({ ...play, maxCombo: 1101, beatmapMaxCombo: 1245 }), /play-detail__combo/);

  const covered = playRow(play, { background: true });
  assert.match(covered, /class="play-detail play-detail--cover"/);
  assert.match(covered, /--cover: url\('https:\/\/assets\.ppy\.sh\/beatmaps\/1830679\/covers\/cover\.jpg'\)/);
  // A beatmap osu! has no set for has no cover to show.
  assert.doesNotMatch(playRow({ ...play, beatmapsetId: null }, { background: true }), /play-detail--cover/);

  // Each from its own setting, and all off until asked for.
  assert.deepEqual(rowLooks(undefined), { starRating: false, starBadge: false, judgements: false, background: false });
  assert.deepEqual(
    rowLooks({ starRating: true, starRatingBadge: true, judgements: true, scoreBackgrounds: true }),
    { starRating: true, starBadge: true, judgements: true, background: true },
  );
});
