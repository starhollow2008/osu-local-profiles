import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_HIGHLIGHTS, MAX_NOTE_LINE, assetsFor, changelogSection, headline, notesJson, releaseNotes } from '../scripts/release-notes.mjs';
import { notesFromBody } from '../src/update/notes.ts';
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
  // past it to reach them. Only the list of changes is measured, since the link and download
  // lines come with every release and outweigh a section of one or two changes.
  const changes = notes.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(changes.length <= MAX_HIGHLIGHTS + 1);
  assert.ok(changes.join('\n').length <= changelogSection(changelog, pkg.version)!.length);
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

test('a credit at the end of a change stays on its line, as mentions a release page links', () => {
  assert.equal(
    headline('**The chart looks like osu!\'s.** It has gridlines. Thanks to [@someone](https://github.com/someone).'),
    "The chart looks like osu!'s. Thanks to @someone.",
  );
  assert.equal(
    headline('**Quit from the page**, at the top right. Thanks to @a, [@b-c](https://github.com/b-c) and @d'),
    'Quit from the page, at the top right. Thanks to @a, @b-c and @d.',
  );
  // Cut short or not, the credit is whole.
  assert.match(headline(`**${'a '.repeat(100)}** Thanks to @someone.`), /\.\.\. Thanks to @someone\.$/);
  // Thanks that name nobody is part of the change, not a credit.
  assert.equal(headline('Thanks to everyone who reported it.'), 'Thanks to everyone who reported it.');
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

test('the issues a change came from stay on its line, as #n a release page links', () => {
  const issue = (n: number) => `[#${n}](https://github.com/jonathant09/osu-local-profiles/issues/${n})`;
  assert.equal(
    headline(`**Your other names.** Plays under them are yours. Reported in ${issue(4)}. Thanks to [@NoelleTGS](https://github.com/NoelleTGS).`),
    'Your other names (#4). Thanks to @NoelleTGS.',
  );
  assert.equal(
    headline(`**A filter that keeps one client's plays**, picked by name. Reported in ${issue(4)} and ${issue(5)}.`),
    "A filter that keeps one client's plays (#4, #5)",
  );
  // Only as the closing words: an issue linked mid-entry is part of what it says.
  assert.equal(
    headline(`**Fixed the importer.** See ${issue(4)} for how. It works now.`),
    'Fixed the importer.',
  );
});

test('a version marked in full carries every entry whole, in lines no installed app cuts', () => {
  const long = 'Each sentence here is long enough that two of them will not fit on a single line of patch notes.';
  const changelog = [
    '# Changelog',
    '',
    '## 2.0.0',
    '',
    '<!-- in full -->',
    '',
    `- **A change worth reading in full.** ${long} ${long}`,
    `  ${long} See [the page](https://example.com/page) for *more*.`,
    '',
    '- **A short one.** It says one more thing.',
    '',
    '## 1.9.0',
    '',
    '- **Old.** Detail that stays in the CHANGELOG.',
    '',
  ].join('\n');
  const lines = notesJson(changelog).versions[0]!.highlights;
  assert.ok(lines.length > 2);
  assert.ok(lines.every((l) => l.length <= MAX_NOTE_LINE && !l.includes('*') && !l.includes('](')));
  assert.equal(lines.join(' '), `A change worth reading in full. ${long} ${long} ${long} See the page for more. A short one. It says one more thing.`);
  assert.equal(lines.at(-1), 'A short one. It says one more thing.');
  // The mark is no part of the text, and a version without it keeps its one line each.
  assert.ok(!changelogSection(changelog, '2.0.0')!.includes('<!-- in full -->'));
  assert.deepEqual(notesJson(changelog).versions[1]!.highlights, ['Old.']);
  // An install reading the release page before it updates gets the same lines, whole.
  const body = releaseNotes(changelog, '2.0.0');
  assert.deepEqual(notesFromBody(body, '2.0.0', null)[0]!.highlights, lines);
});
