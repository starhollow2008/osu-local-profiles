import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSectionOrder } from '../web/js/sections.js';

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
