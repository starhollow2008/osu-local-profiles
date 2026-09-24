import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_HIGHLIGHTS, assetsFor, changelogSection, headline, releaseNotes } from '../scripts/release-notes.mjs';
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
  assert.equal(assets.macosIntel, assetNameFor('1.10.0', 'darwin', 'x64'));
  assert.equal(assets.linux, assetNameFor('1.10.0', 'linux', 'x64'));
});

test('the current version has release notes, short, with the CHANGELOG a link away', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const notes = releaseNotes(changelog, pkg.version);
  // GitHub lists the downloads under the notes: a whole CHANGELOG section there meant scrolling
  // past it to reach them.
  assert.ok(notes.length < changelogSection(changelog, pkg.version)!.length);
  assert.ok(notes.includes(`CHANGELOG.md#${pkg.version.replace(/\./g, '')})`));
  assert.doesNotMatch(notes, /## Updating/);
});

test('each change is one line: its bold lead, or its first sentence when that lead is only a name', () => {
  assert.equal(headline('**Quit from the page.** **Quit** at the top right stops the app.'), 'Quit from the page.');
  assert.equal(
    headline("**Beatmap names in their original language**, the way osu!'s own setting does it"),
    'Beatmap names in their original language',
  );
  assert.equal(
    headline('**View Details**, from the menu on any score. It opens the score.'),
    'View Details, from the menu on any score.',
  );
  assert.equal(headline('Every em dash is now a plain hyphen.'), 'Every em dash is now a plain hyphen.');
  assert.ok(headline(`**${'a '.repeat(100)}**`).endsWith('...'));
});

test('a long release lists its first changes and counts the rest', () => {
  const many = Array.from({ length: MAX_HIGHLIGHTS + 3 }, (_, i) => `- **Change number ${i} is here.**`);
  const notes = releaseNotes(`## 2.0.0\n\n${many.join('\n')}\n`, '2.0.0');
  assert.equal(notes.match(/^- Change number/gm)?.length, MAX_HIGHLIGHTS);
  assert.match(notes, /^- \.\.\.and 3 more$/m);
});

test('a section in groups is summed up by them, and a removal says it is one', () => {
  const section = [
    '## 1.5.0', '', '### A new name', '', '- x', '',
    '### Removed', '', '- **Sharing on your network.** Gone.', '',
    '### Development', '', '- y', '',
  ].join('\n');
  const notes = releaseNotes(section, '1.5.0');
  assert.match(notes, /^- A new name$/m);
  assert.match(notes, /^- Removed: sharing on your network\.$/m);
  assert.doesNotMatch(notes, /Development/);
});

test('a mixed group lists its changes, and how to update is left to the CHANGELOG', () => {
  const section = [
    '## 1.3.0', '', '### Updating, and a few smaller things', '',
    '- **One-click updates.** A button.', '- **A footer**, with the version.', '',
    '### More', '', '- **Updating from 1.2.0 or earlier.** Update from the app as usual.', '',
  ].join('\n');
  const notes = releaseNotes(section, '1.3.0');
  assert.match(notes, /^- One-click updates\.$/m);
  assert.doesNotMatch(notes, /^- Updating/m);
  assert.doesNotMatch(releaseNotes('## 1.17.0\n\n- **Updating from 1.16.0 or earlier.** As usual.\n- **Quit.**\n', '1.17.0'), /Updating/);
});

test('an old release names only the downloads it actually has', () => {
  const notes = releaseNotes(CHANGELOG, '1.9.0', [assetsFor('1.9.0').windows]);
  assert.match(notes, /Windows `win-x64`\./);
  assert.doesNotMatch(notes, /macOS|Linux/);
  assert.match(releaseNotes(CHANGELOG, '1.10.0'), /macOS Intel `osx-x64` · Linux `linux-x64`/);
});
