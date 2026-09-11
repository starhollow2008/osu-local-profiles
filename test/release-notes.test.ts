import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assetsFor, changelogSection, releaseNotes } from '../scripts/release-notes.mjs';
import { assetNameFor } from '../src/update/github.ts';

const CHANGELOG = '# Changelog\r\n\r\n## 1.10.0\r\n\r\n- new\r\n\r\n## 1.9.0\r\n\r\n- old\r\n';

test("a version's notes are its own CHANGELOG section and nothing after it", () => {
  assert.equal(changelogSection(CHANGELOG, '1.10.0'), '- new');
  assert.equal(changelogSection(CHANGELOG, '1.9.0'), '- old');
  // 1.1.0 must not match inside 1.10.0's heading.
  assert.equal(changelogSection(CHANGELOG, '1.1.0'), null);
});

test('a version with no CHANGELOG section is not released with empty notes', () => {
  assert.throws(() => releaseNotes(CHANGELOG, '2.0.0'), /no "## 2.0.0" section/);
});

test('the release builds are named as each platform\'s updater looks for them', () => {
  // The workflow attaches what the packager builds; the notes name it; the updater finds it
  // by name. A mismatch would leave that platform's app unable to update.
  const assets = assetsFor('1.10.0');
  assert.equal(assets.windows, assetNameFor('1.10.0', 'win32', 'x64'));
  assert.equal(assets.macos, assetNameFor('1.10.0', 'darwin', 'arm64'));
  assert.equal(assets.linux, assetNameFor('1.10.0', 'linux', 'x64'));
});

test('the current version has release notes', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const notes = releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), pkg.version);
  assert.match(notes, /## Updating/);
});
