import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEHIND_DAYS,
  NUDGE_QUIET_DAYS,
  notesBetween,
  notesFromBody,
  nudgeFor,
  nudgeShown,
  parseNotes,
  type VersionNotes,
} from '../src/update/notes.ts';
import { dismissNudge, markSeen, nudgeDismissal, seedSeenVersion, whatsNew } from '../src/update/whats-new.ts';
import { openDb } from '../src/db/index.ts';
import { IMPORTANT_MARK, changelogSection, notesJson, releaseNotes } from '../scripts/release-notes.mjs';

/*
 * Patch notes before and after an update, and how loudly an update that has waited says so
 * (roadmap 5.66).
 */

const DAY = 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olp-notes-'));

const v = (version: string, extra: Partial<VersionNotes> = {}): VersionNotes => ({
  version,
  date: null,
  important: false,
  highlights: [`${version} did a thing`],
  ...extra,
});

const ALL = [v('1.27.0'), v('1.26.0'), v('1.25.0'), v('1.24.0')];

test('what is new is every version after this one, up to the newest', () => {
  assert.deepEqual(notesBetween(ALL, '1.24.0', '1.26.0').map((n) => n.version), ['1.26.0', '1.25.0']);
  assert.deepEqual(notesBetween(ALL, '1.26.0', '1.27.0').map((n) => n.version), ['1.27.0']);
  // Not knowing the version before: only the one arrived at.
  assert.deepEqual(notesBetween(ALL, null, '1.26.0').map((n) => n.version), ['1.26.0']);
  assert.deepEqual(notesBetween(ALL, '1.27.0', '1.27.0'), []);
});

test('notes from the network are checked and trimmed before they reach the page', () => {
  const parsed = parseNotes({
    versions: [
      { version: '1.27.0', date: '2026-09-27', important: true, highlights: ['ok', 42, '', 'x'.repeat(500)] },
      { version: 'not a version', highlights: ['dropped'] },
      { version: '1.26.0', date: 'yesterday', highlights: 'not a list' },
      null,
    ],
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]!.highlights.slice(0, 1), ['ok']);
  assert.equal(parsed[0]!.highlights.length, 2);
  assert.ok(parsed[0]!.highlights[1]!.length < 210);
  assert.equal(parsed[1]!.date, null);
  assert.deepEqual(parsed[1]!.highlights, []);
  assert.deepEqual(parseNotes('garbage'), []);
});

test('a release from before notes files still has its lines, from its release page', () => {
  const body = releaseNotes('# Changelog\n\n## 1.26.0\n\n- **A smaller beatmap index.**\n- **Faster pages.**\n', '1.26.0');
  const notes = notesFromBody(body, '1.26.0', '2026-09-26T10:00:00Z');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0]!.highlights, ['A smaller beatmap index.', 'Faster pages.']);
  assert.equal(notes[0]!.date, '2026-09-26');
});

test('an update is said above the page only when important, or waiting two weeks', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const daysAgo = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10);
  assert.equal(nudgeFor([v('1.27.0', { date: daysAgo(3) })], now), null);
  assert.equal(nudgeFor([v('1.28.0', { date: daysAgo(1) }), v('1.27.0', { date: daysAgo(BEHIND_DAYS + 1) })], now), 'behind');
  assert.equal(nudgeFor([v('1.27.0', { date: daysAgo(0), important: true })], now), 'important');
  // No dates to go on: only the button.
  assert.equal(nudgeFor([v('1.27.0')], now), null);
});

test('a dismissed notice stays away a week, unless something important comes out', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const missing = [v('1.28.0'), v('1.27.0')];
  assert.equal(nudgeShown('behind', missing, null, now), true);
  assert.equal(nudgeShown(null, missing, null, now), false);
  assert.equal(nudgeShown('behind', missing, { version: '1.28.0', at: now - DAY }, now), false);
  assert.equal(nudgeShown('behind', missing, { version: '1.28.0', at: now - NUDGE_QUIET_DAYS * DAY }, now), true);
  const important = [v('1.29.0', { important: true }), ...missing];
  assert.equal(nudgeShown('important', important, { version: '1.28.0', at: now - DAY }, now), true);
  // Dismissed with the important one already out: that is what was dismissed.
  assert.equal(nudgeShown('important', important, { version: '1.29.0', at: now - DAY }, now), false);
});

test('the release job marks an important version, and the notes carry it', () => {
  const changelog = `# Changelog\n\n## 1.28.0\n\n${IMPORTANT_MARK}\n\n- **Fixes lost plays.**\n\n## 1.27.0\n\n- **Faster.**\n`;
  const notes = notesJson(changelog, { '1.27.0': '2026-09-27' });
  assert.deepEqual(notes.versions, [
    { version: '1.28.0', date: null, important: true, highlights: ['Fixes lost plays.'] },
    { version: '1.27.0', date: '2026-09-27', important: false, highlights: ['Faster.'] },
  ]);
  // Invisible in the section the release page is written from.
  assert.equal(changelogSection(changelog, '1.28.0'), '- **Fixes lost plays.**');
});

test('the CHANGELOG itself makes notes the app can read', () => {
  const changelog = fs.readFileSync(path.join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  const parsed = parseNotes(notesJson(changelog));
  assert.ok(parsed.length > 20);
  assert.ok(parsed.every((n) => n.highlights.length > 0), 'every version says what it changed');
});

/* ------------------------------------------------ after an update: what changed */

function world(current: string) {
  const dir = tmp();
  const install = path.join(dir, 'install');
  const data = path.join(dir, 'data');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(install, 'release-notes.json'),
    JSON.stringify({ versions: [v('1.27.0'), v('1.26.0'), v('1.25.0')] }),
  );
  const db = openDb(path.join(data, 'profile.db'));
  return { dir, install, data, db, current };
}

test('a first launch has nothing to announce', () => {
  const w = world('1.27.0');
  seedSeenVersion(w.db, w.current, w.data);
  assert.equal(whatsNew(w.db, w.current, w.install, w.data), null);
  w.db.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('after an update, what changed since the last version run is shown until seen', () => {
  const w = world('1.25.0');
  seedSeenVersion(w.db, '1.25.0', w.data);
  // Two versions later:
  const shown = whatsNew(w.db, '1.27.0', w.install, w.data);
  assert.deepEqual(shown?.notes.map((n) => n.version), ['1.27.0', '1.26.0']);
  assert.equal(shown?.from, '1.25.0');
  markSeen(w.db, '1.27.0');
  assert.equal(whatsNew(w.db, '1.27.0', w.install, w.data), null);
  w.db.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('the update to the first version that keeps a record is known from update.log', () => {
  const w = world('1.27.0');
  fs.writeFileSync(path.join(w.data, 'update.log'), 'OK: updated to 1.27.0\n\nlog');
  seedSeenVersion(w.db, '1.27.0', w.data);
  assert.deepEqual(whatsNew(w.db, '1.27.0', w.install, w.data)?.notes.map((n) => n.version), ['1.27.0']);
  w.db.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('a dismissal is kept in the database', () => {
  const w = world('1.27.0');
  assert.equal(nudgeDismissal(w.db), null);
  dismissNudge(w.db, '1.28.0', 1000);
  assert.deepEqual(nudgeDismissal(w.db), { version: '1.28.0', at: 1000 });
  w.db.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});
