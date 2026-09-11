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
