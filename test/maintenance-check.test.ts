import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpDate, staleness, versionDate } from '../tools/maintenance/check.mjs';

const DAY = 86_400_000;

test('a dump and an osu! version are dated by their names', () => {
  assert.equal(dumpDate('2026_11_05'), Date.UTC(2026, 10, 5));
  assert.equal(versionDate('2026.1026.0'), Date.UTC(2026, 9, 26));
  assert.equal(versionDate('2026.916.0'), Date.UTC(2026, 8, 16));
  assert.equal(versionDate('2025.101.1'), Date.UTC(2025, 0, 1));
});

test('a source goes stale only past the limit, and at once when nothing was recognised', () => {
  const newest = Date.UTC(2026, 7, 1);
  assert.deepEqual(staleness(newest, newest + 90 * DAY, 90), { ageDays: 90, stale: false });
  assert.deepEqual(staleness(newest, newest + 91 * DAY, 90), { ageDays: 91, stale: true });
  assert.deepEqual(staleness(newest, newest + 10 * DAY, 7), { ageDays: 10, stale: true });
  assert.deepEqual(staleness(null, newest, 90), { ageDays: null, stale: true });
});
