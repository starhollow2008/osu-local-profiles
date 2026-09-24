/**
 * The body of a GitHub release: a few lines on what changed, a link to the full CHANGELOG entry,
 * and which download is which.
 *
 *   node scripts/release-notes.mjs 1.10.0 > notes.md
 *
 * Used by .github/workflows/release.yml when it creates a release. A release that already
 * exists keeps the notes it was given; the workflow only attaches the builds to it.
 *
 * Kept short on purpose: GitHub puts the downloads *under* the notes, so a whole CHANGELOG
 * section there meant scrolling past it to reach them. The detail is one link away.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHANGELOG_URL = 'https://github.com/jonathant09/osu-local-profiles/blob/main/CHANGELOG.md';

/** How many changes a release lists before pointing at the CHANGELOG for the rest. */
export const MAX_HIGHLIGHTS = 8;

/** Past this, a headline is cut at a word and ended with an ellipsis. */
const MAX_HEADLINE = 110;

/**
 * Subheadings that say what kind of change follows rather than what changed. Their entries are
 * listed instead, marked with it: "Sharing the live page on your network" alone reads as a
 * feature that arrived, not one that went.
 */
const GENERIC_HEADINGS = new Set(['fixed', 'removed']);
/** Subheadings of changes for people building the app, not using it. */
const CONTRIBUTOR_HEADINGS = new Set(['development', 'for contributors']);

/** The text under `## <version>` in CHANGELOG.md, up to the next version's heading. */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** The archives the packager names, one per platform the workflow builds on. */
export const assetsFor = (version) => ({
  windows: `osu-local-profiles-${version}-win-x64.zip`,
  macos: `osu-local-profiles-${version}-osx-arm64.zip`,
  macosIntel: `osu-local-profiles-${version}-osx-x64.zip`,
  linux: `osu-local-profiles-${version}-linux-x64.zip`,
});

/** Which system each archive is for, in the order the notes list them. */
const PLATFORMS = [
  ['win-x64', 'Windows'],
  ['osx-arm64', 'macOS Apple silicon'],
  ['osx-x64', 'macOS Intel'],
  ['linux-x64', 'Linux'],
];

/** Past this, a release's opening paragraph is left to the CHANGELOG. */
const MAX_INTRO = 200;

function cut(text) {
  if (text.length <= MAX_HEADLINE) return text;
  const at = text.lastIndexOf(' ', MAX_HEADLINE);
  return `${text.slice(0, at > 0 ? at : MAX_HEADLINE).replace(/[,:;(-]+$/, '')}...`;
}

/**
 * One line for a CHANGELOG entry: its bold lead where that says what changed, otherwise its
 * first sentence. A short bold lead is only a name (`**View Details**, from the menu...`), and
 * the sentence around it is what says anything.
 */
export function headline(entry) {
  const text = entry.replace(/\s+/g, ' ').trim();
  const lead = /^\*\*(.+?)\*\*/.exec(text);
  if (lead && (lead[1].length >= 25 || /[.!?]$/.test(lead[1]))) return cut(lead[1]);
  const plain = text.replace(/\*\*/g, '');
  const sentence = /^.+?[.!?](?=\s+[A-Z(*`]|$)/.exec(plain);
  return cut((sentence ? sentence[0] : plain).replace(/[.:]$/, (p) => (p === ':' ? '' : p)));
}

/** The top-level entries of some CHANGELOG text, each with its wrapped lines joined. */
function entries(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) out.push(line.slice(2));
    else if (out.length > 0 && /^ {2}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/**
 * What a release changed, a line each. A section written in `###` groups is summed up by its
 * group names, which is what those were written as; a group that only says "Fixed" gives its
 * entries instead, and changes for contributors are left to the CHANGELOG.
 */
export function highlights(section) {
  const groups = section.split(/^### /m);
  if (groups.length === 1) return entries(section).map(headline);
  const out = [];
  for (const group of groups.slice(1)) {
    const [heading, ...body] = group.split('\n');
    const name = heading.trim();
    if (CONTRIBUTOR_HEADINGS.has(name.toLowerCase())) continue;
    if (GENERIC_HEADINGS.has(name.toLowerCase())) {
      const lower = (h) => (/^[A-Z][a-z]/.test(h) ? h[0].toLowerCase() + h.slice(1) : h);
      out.push(...entries(body.join('\n')).map((e) => `${name}: ${lower(headline(e))}`));
    } else if (/and a few smaller things$/i.test(name)) {
      // A heading for a mixture names none of it.
      out.push(...entries(body.join('\n')).map(headline));
    } else {
      out.push(name);
    }
  }
  return out;
}

/**
 * How to update, which the app's own Update button already covers. A release page lists what
 * changed; an entry that is only instructions for getting it stays in the CHANGELOG.
 */
const isHowToUpdate = (line) => /^Updating from\b/i.test(line);

/** The paragraph a section opens with, before its first entry or group, when it is short. */
export function intro(section) {
  const first = section.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (first === '' || first.startsWith('- ') || first.startsWith('#')) return null;
  return first.length <= MAX_INTRO ? first : null;
}

/**
 * The whole release body. `assets` is what the release carries: every platform for a new one,
 * and for an old one whatever it was actually built for -- before 1.10.0, only Windows.
 */
export function releaseNotes(changelog, version, assets = Object.values(assetsFor(version))) {
  const section = changelogSection(changelog, version);
  if (section === null) throw new Error(`CHANGELOG.md has no "## ${version}" section`);

  const all = highlights(section).filter((h) => !isHowToUpdate(h));
  const shown = all.slice(0, MAX_HIGHLIGHTS).map((h) => `- ${h}`);
  if (all.length > MAX_HIGHLIGHTS) shown.push(`- ...and ${all.length - MAX_HIGHLIGHTS} more`);

  const opening = intro(section);
  const anchor = version.replace(/\./g, '');
  const downloads = PLATFORMS.filter(([rid]) => assets.some((a) => a.endsWith(`-${rid}.zip`)))
    .map(([rid, name]) => `${name} \`${rid}\``);

  return `${opening ? `${opening}\n\n` : ''}${shown.join('\n')}

Everything in this release: [CHANGELOG.md](${CHANGELOG_URL}#${anchor})

**Download** the zip for your system below: ${downloads.join(' · ')}. Unzip it anywhere and run the launcher inside.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <version>');
    process.exit(1);
  }
  process.stdout.write(releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version));
}
