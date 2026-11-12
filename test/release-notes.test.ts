import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMPORTANT_MARK,
  MAX_HIGHLIGHTS,
  MAX_NOTE_LINE,
  assetsFor,
  changelogSection,
  headline,
  notesJson,
  releaseNotes,
} from '../scripts/release-notes.mjs';
import { canBuildApp, devApp } from '../scripts/dev-app.mjs';

const CHANGELOG = '# Changelog\r\n\r\n## 1.10.0\r\n\r\n- new\r\n\r\n## 1.9.0\r\n\r\n- old\r\n';

/*
 * What the release job writes, read back by the app's own code (`Update.Notes`, through
 * `--dev`): a release page, which an install reads before it updates, and a package's
 * release-notes.json, which it reads after. Those checks need the .NET SDK to build the app.
 */
const noApp = canBuildApp() ? false : 'needs the .NET SDK to build the app';

interface Notes {
  version: string;
  date: string | null;
  important: boolean;
  highlights: string[];
}

function appReads(command: 'release-notes' | 'release-page', text: string, ...args: string[]): Notes[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-notes-'));
  try {
    const file = path.join(dir, 'notes');
    fs.writeFileSync(file, text);
    return devApp(command, file, ...args)[0] as Notes[];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
  // by name. A mismatch would leave that platform's app unable to update. The app's own
  // `Updater.AssetNameFor` is pinned to the same names (UpdaterTests).
  const assets = assetsFor('1.10.0');
  assert.equal(assets.windows, 'osu-local-profiles-1.10.0-win-x64.zip');
  assert.equal(assets.macos, 'osu-local-profiles-1.10.0-osx-arm64.zip');
  assert.equal(assets.macosIntel, 'osu-local-profiles-1.10.0-osx-x64.zip');
  assert.equal(assets.linux, 'osu-local-profiles-1.10.0-linux-x64.zip');
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

test('a contribution ends its line by @name in #n, as GitHub writes one', () => {
  const pull = (n: number) => `[#${n}](https://github.com/jonathant09/osu-local-profiles/pull/${n})`;
  assert.equal(
    headline(`**osu!lazer accuracy matches osu!.** Mania read low. By [@cambarr](https://github.com/cambarr) in ${pull(17)}.`),
    'osu!lazer accuracy matches osu! by @cambarr in #17',
  );
  assert.equal(
    headline(`**The chart looks like osu!'s.** It has gridlines. by @a and [@b-c](https://github.com/b-c) in ${pull(3)}, ${pull(4)} and ${pull(5)}`),
    "The chart looks like osu!'s by @a and @b-c in #3, #4 and #5",
  );
  // With the issues it came from, and cut short or not, the credit is whole.
  assert.equal(
    headline(`**Your other names.** Plays under them are yours. Reported in [#4](https://github.com/jonathant09/osu-local-profiles/issues/4). By @someone in ${pull(6)}.`),
    'Your other names (#4) by @someone in #6',
  );
  assert.match(headline(`**${'a '.repeat(100)}** By @someone in ${pull(7)}.`), /\.\.\. by @someone in #7$/);
  // A "by" that names nobody is part of the change.
  assert.equal(headline('**Sorted by date in the list.** Newest first.'), 'Sorted by date in the list.');
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
  if (noApp) return;
  const body = releaseNotes(changelog, '2.0.0');
  assert.deepEqual(appReads('release-page', body, '2.0.0')[0]!.highlights, lines);
});

/* ------------------------------------------------- important versions */

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

test('the CHANGELOG itself makes notes the app can read', { skip: noApp }, () => {
  const changelog = fs.readFileSync(path.join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  const parsed = appReads('release-notes', JSON.stringify(notesJson(changelog)));
  assert.ok(parsed.length > 20);
  assert.ok(parsed.every((n) => n.highlights.length > 0), 'every version says what it changed');
});

test('an important version says so on its release page, and the app reads it back', { skip: noApp }, () => {
  const changelog = `# Changelog\n\n## 1.28.0\n\n${IMPORTANT_MARK}\n\n- **Fixes lost plays.**\n\n## 1.27.0\n\n- **Faster.**\n`;
  const important = releaseNotes(changelog, '1.28.0');
  assert.ok(important.startsWith(IMPORTANT_MARK), 'the mark heads the page, where GitHub shows nothing');
  const read = appReads('release-page', important, '1.28.0', '2026-10-01T12:00:00Z');
  assert.deepEqual(read, [{ version: '1.28.0', date: '2026-10-01', important: true, highlights: ['Fixes lost plays.'] }]);

  const ordinary = releaseNotes(changelog, '1.27.0');
  assert.ok(!ordinary.includes(IMPORTANT_MARK));
  assert.equal(appReads('release-page', ordinary, '1.27.0')[0]?.important, false);
});
