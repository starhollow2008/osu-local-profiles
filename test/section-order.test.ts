import { test } from 'node:test';
import assert from 'node:assert/strict';
import './english.ts';
import { countingNoteText, reconcileSectionOrder } from '../web/js/sections.js';

const DEFAULT = ['me', 'recent', 'top_ranks', 'historical', 'beatmaps', 'medals'];

test('with nothing saved, the default order', () => {
  assert.deepEqual(reconcileSectionOrder(undefined, DEFAULT), DEFAULT);
});

/*
 * The case that changed this: a profile that had moved Medals to the bottom before Beatmaps
 * existed. Appending put Beatmaps below Medals; it belongs after Historical, as by default.
 */
test('a new section joins after the one it follows by default, not at the end', () => {
  assert.deepEqual(
    reconcileSectionOrder(['me', 'recent', 'top_ranks', 'historical', 'medals'], DEFAULT),
    ['me', 'recent', 'top_ranks', 'historical', 'beatmaps', 'medals'],
  );
});

test("a saved order is otherwise the user's, however unusual", () => {
  const saved = ['medals', 'historical', 'me', 'top_ranks', 'recent', 'beatmaps'];
  assert.deepEqual(reconcileSectionOrder(saved, DEFAULT), saved);
});

test('unknown ids go and duplicates count once', () => {
  assert.deepEqual(
    reconcileSectionOrder(['gone', 'me', 'me', 'recent', 'top_ranks', 'historical', 'beatmaps', 'medals'], DEFAULT),
    DEFAULT,
  );
});

test('a new section with nothing before it present goes first', () => {
  assert.deepEqual(reconcileSectionOrder(['medals'], ['me', 'medals']), ['me', 'medals']);
});

/*
 * 1.10.0: Recent Plays became a section of its own, placed under me!, and osu!'s Recent feed
 * was renamed Milestones and moved under Historical -- by default. The page's list, in order.
 */
const DEFAULT_110 = ['me', 'recent_plays', 'top_ranks', 'historical', 'recent', 'beatmaps', 'medals'];

test('Recent Plays sits under me! and Milestones under Historical, by default', () => {
  assert.deepEqual(reconcileSectionOrder([], DEFAULT_110), DEFAULT_110);
});

const RETIRED = [
  ['me', 'recent', 'top_ranks', 'medals', 'historical'],
  ['me', 'recent', 'top_ranks', 'historical', 'beatmaps', 'medals'],
];

test("a page saved exactly as an earlier default was never arranged, and gets today's", () => {
  for (const old of RETIRED) assert.deepEqual(reconcileSectionOrder(old, DEFAULT_110, RETIRED), DEFAULT_110);
});

test('a page that was rearranged keeps its arrangement, with Recent Plays after me!', () => {
  // Medals moved up by hand: a choice, so Milestones (id `recent`) and the rest stay put.
  assert.deepEqual(
    reconcileSectionOrder(['me', 'medals', 'recent', 'top_ranks', 'historical', 'beatmaps'], DEFAULT_110, RETIRED),
    ['me', 'recent_plays', 'medals', 'recent', 'top_ranks', 'historical', 'beatmaps'],
  );
});

test('a profile that cannot know what its beatmaps are says so, before anything else', () => {
  const text = countingNoteText({ countUnresolved: true });
  assert.match(text, /osu!stable does not record whether a beatmap is ranked/);
  assert.match(text, /Every beatmap therefore counts toward pp/);
  assert.match(text, /not comparable with a real osu! account/);

  // It outranks the ordinary wording, which is about choices the user made.
  const both = countingNoteText({ countUnresolved: true, includeUnrankedMods: true });
  assert.equal(both, text);
  // And with a status source it is the ordinary note again, or nothing at all.
  assert.equal(countingNoteText({ includeUnrankedMods: false, extraMapStatuses: [] }), '');
});

test('the note on a profile counting unranked plays says where to turn them off', () => {
  const text = countingNoteText({ includeUnrankedMods: true, preferStrippedPp: true, extraMapStatuses: [4] });
  assert.match(text, /^Unranked beatmaps and mods scores are included by default\. /);
  assert.match(text, /To disable them, go to Options → Other settings and uncheck those boxes\./);
  // Priced as if the mod were off, so the * on those scores is explained.
  assert.match(text, /marked with \*\.$/);
});

/*
 * 1.31.0: Recent (Milestones until now) moves under me! and Recent Plays under Historical, by
 * default -- for a profile made from then on. One that already existed keeps its page exactly:
 * `pinSectionOrder` writes down whole the order the page showed it (roadmap 5.80).
 */
const DEFAULT_131 = ['me', 'recent', 'top_ranks', 'historical', 'recent_plays', 'beatmaps', 'medals'];

test('Recent sits under me! and Recent Plays under Historical, by default', () => {
  assert.deepEqual(reconcileSectionOrder([], DEFAULT_131, RETIRED), DEFAULT_131);
});

/*
 * The app writes the order down once, when it first opens a database from before 1.31.0
 * (`PinSectionOrder` in dotnet/App/Db/Database.cs). Its test, DatabaseTests'
 * An_existing_profiles_section_order_is_written_down_as_the_page_showed_it, expects these
 * orders for these saved ones: the page must have shown exactly them, and must go on showing
 * them under today's default.
 */
test('a profile from before 1.31.0 keeps the order it showed, however it was saved', () => {
  const pinned: [string[], string[]][] = [
    // A pre-1.10 default reads as never arranged: the order until 1.31.
    [['me', 'recent', 'top_ranks', 'medals', 'historical'], DEFAULT_110],
    // Unknown ids go, and each missing section joins after the one it followed by default.
    [['medals', 'me', 'nonsense'], ['medals', 'me', 'recent_plays', 'top_ranks', 'historical', 'recent', 'beatmaps']],
  ];
  for (const [saved, written] of pinned) {
    assert.deepEqual(reconcileSectionOrder(saved, DEFAULT_110, RETIRED), written, `${saved}: written down as shown`);
    assert.deepEqual(reconcileSectionOrder(written, DEFAULT_131, RETIRED), written, `${saved}: shown the same today`);
  }
});
