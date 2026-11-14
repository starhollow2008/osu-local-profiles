import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW,
  activeFilters,
  normaliseView,
  playsText,
  resetView,
  rowsHtml,
  scoreListUrl,
  sortedBy,
  tableHtml,
  viewChanged,
  withoutFilter,
} from '../web/js/score-list.js';
import type { ScoreListView } from '../web/js/score-list.js';

/*
 * The Scores view (roadmap 5.86): what counts as off its default, the chips that undo one filter
 * each, Reset, sorting from a column's head, and the table and rows it draws. What it lists is
 * the server's (ScoreListTests).
 */

const play = {
  kind: 'score', id: 7, beatmapMd5: 'abc', beatmapId: 1, beatmapsetId: 2, artist: 'Artist <b>', title: 'Title',
  version: 'Insane', creator: 'Blue Dragon', mods: [{ acronym: 'HD' }, { acronym: 'DT' }], accuracy: 0.9876,
  maxCombo: 1234, grade: 'SH', stars: 6.12, pp: 345.6, counted: true, playedAt: Date.now() - 3600_000,
  playcount: 4, hasReplay: true,
};

test('the default view is Best Performance without its cap, and how it is looked at never counts as a change', () => {
  assert.equal(viewChanged(null), false);
  assert.equal(viewChanged({ layout: 'table' }), false);
  // osu!'s rows unless the table was picked.
  assert.equal(DEFAULT_VIEW.layout, 'rows');
  assert.equal(viewChanged({ pageSize: 1000 }), false);
  // 100 at a time unless picked otherwise.
  assert.equal(DEFAULT_VIEW.pageSize, 100);
  const changes: Partial<ScoreListView>[] = [{ show: 'every' }, { uncounted: true }, { sort: 'date' }, { order: 'asc' }, { search: 'x' },
    { mods: ['HD'] }, { grades: ['S'] }, { clients: ['lazer'] }, { starsMin: 5 }, { to: 1 }];
  for (const change of changes) {
    assert.equal(viewChanged(change), true, JSON.stringify(change));
  }
});

test('Reset puts back everything but the layout and how many at a time', () => {
  const reset = resetView({ show: 'every', sort: 'accuracy', mods: ['HD'], search: 'x', layout: 'table', pageSize: 250 });
  assert.deepEqual(reset, { ...DEFAULT_VIEW, layout: 'table', pageSize: 250 });
  assert.equal(viewChanged(reset), false);
});

test('each filter in force is a chip, and its x takes away that one only', () => {
  const view = normaliseView({ show: 'every', search: 'blue', mods: ['HD', 'NM'], grades: ['XH'], clients: ['stable'], starsMin: 5, from: 0, to: 86_400_000 });
  const chips = activeFilters(view);
  assert.deepEqual(chips.map((c) => c.key), ['show', 'search', 'mods', 'mods', 'grades', 'clients', 'stars', 'played']);
  assert.ok(chips.find((c) => c.key === 'grades')?.label.includes('silver'));
  assert.equal(chips.find((c) => c.key === 'clients')?.label, 'osu!stable');
  assert.equal(chips.find((c) => c.key === 'stars')?.label, 'Stars: ≥ 5.00');

  const fewer = withoutFilter(view, 'mods', 'HD');
  assert.deepEqual(fewer.mods, ['NM']);
  assert.equal(fewer.search, 'blue');
  assert.equal(withoutFilter(view, 'played').from, null);
  assert.equal(withoutFilter(view, 'show').show, 'best');
  // Sort is in the toolbar, not a chip.
  assert.deepEqual(activeFilters({ sort: 'date' }), []);
});

test('a column sorts by itself, then the other way round', () => {
  const byAccuracy = sortedBy(DEFAULT_VIEW, 'accuracy');
  assert.deepEqual([byAccuracy.sort, byAccuracy.order], ['accuracy', 'desc']);
  assert.equal(sortedBy(byAccuracy, 'accuracy').order, 'asc');
  // Fewest misses and A to Z read first.
  assert.equal(sortedBy(DEFAULT_VIEW, 'misses').order, 'asc');
  assert.equal(sortedBy(DEFAULT_VIEW, 'beatmap').order, 'asc');
});

test('the list is asked for with the view, how it is looked at left out', () => {
  const url = scoreListUrl('/api/score-list', { sort: 'date', layout: 'rows', pageSize: 500 }, 3, { offset: 25, limit: 25 });
  const params = new URLSearchParams(url.split('?')[1]);
  assert.equal(params.get('mode'), '3');
  assert.equal(params.get('offset'), '25');
  const view = JSON.parse(params.get('view') ?? '{}');
  assert.equal(view.sort, 'date');
  assert.equal('layout' in view, false);
  assert.equal('pageSize' in view, false);
});

test('the table numbers its rows, sorts from its heads, and escapes what came from files', () => {
  const html = tableHtml([play, { ...play, id: 8, counted: false, pp: null }], { sort: 'pp' }, 25);
  assert.match(html, /<td class="score-table__place">26<\/td>/);
  assert.match(html, /<td class="score-table__place">27<\/td>/);
  assert.match(html, /aria-sort="descending"><button[^>]*data-sort="pp"/);
  assert.match(html, /data-sort="playcount"/);
  assert.ok(html.includes('Artist &lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
  assert.match(html, /data-score-id="7"/);
  assert.match(html, /score-table__row--uncounted" data-score-id="8"/);
  assert.match(html, /data-play-menu/);
  assert.match(html, />4<\/td>/);
});

test('the rows are osu!s, with the playcount beside the date', () => {
  const html = rowsHtml([play]);
  assert.match(html, /class="play-detail"/);
  assert.match(html, /play-detail__playcount">4 plays</);
  assert.equal(playsText(1), '1 play');
});
