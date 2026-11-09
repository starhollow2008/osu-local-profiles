import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioTime } from '../web/js/format.js';
import {
  beatmapsetCard,
  getDiffColour,
  getDiffTextColour,
  groupDifficulties,
  previewUrl,
} from '../web/js/beatmapsets.js';

/*
 * A favourite's card, as osu-web draws a beatmapset panel, and the floating player's clock.
 * What the app stores for a favourite is dotnet/App/Favorites.cs's, tested in FavoriteWritesTests.
 */

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

const cardWith = (over: Record<string, unknown>) =>
  beatmapsetCard({
    id: 9,
    title: 't',
    artist: 'a',
    creator: null,
    userId: null,
    status: 'ranked',
    nsfw: false,
    spotlight: false,
    featuredArtist: false,
    video: false,
    storyboard: false,
    favouriteCount: null,
    playCount: null,
    date: null,
    difficulties: [],
    source: 'osu',
    favoritedAt: 0,
    ...over,
  });

// osu! hides it from a viewer who has not allowed explicit content; this page has only its owner.
test("the play button plays osu!'s preview, an Explicit set's too", () => {
  assert.ok(cardWith({}).includes('data-audio-play="9"'));
  assert.equal(previewUrl(9), 'https://b.ppy.sh/preview/9.mp3');
  assert.ok(cardWith({ nsfw: true }).includes('data-audio-play="9"'));
});

test('video and storyboard icons appear only for the sets that have them', () => {
  assert.ok(!cardWith({}).includes('beatmapset-panel__play-icon'));
  assert.ok(cardWith({ video: true }).includes('This beatmap contains video'));
  assert.ok(cardWith({ storyboard: true }).includes('This beatmap contains storyboard'));
  // Unknown is not the same as yes.
  assert.ok(!cardWith({ video: null, storyboard: null }).includes('beatmapset-panel__play-icon'));
});

/*
 * The floating player's timestamps, as osu-web writes them: the format follows the clip's
 * length, so a ten-second preview reads 0:07 / 0:10 and the two columns never disagree.
 */
test("audio timestamps take osu-web's format from the clip's length", () => {
  assert.equal(audioTime(0, 10.4), '0:00');
  assert.equal(audioTime(7.9, 10.4), '0:07');
  assert.equal(audioTime(10.4, 10.4), '0:10');
  assert.equal(audioTime(75, 599), '1:15');
  assert.equal(audioTime(75, 600), '01:15');
  assert.equal(audioTime(3725, 3725), '1:02:05');
  assert.equal(audioTime(3725, 36000), '01:02:05');
  // Before the clip has loaded its duration is NaN; nothing is invented.
  assert.equal(audioTime(Number.NaN, 10), '0:00');
});
