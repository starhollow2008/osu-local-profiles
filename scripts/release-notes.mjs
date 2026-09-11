/**
 * The body of a GitHub release: the version's CHANGELOG section, then how to get it.
 *
 *   node scripts/release-notes.mjs 1.10.0 > notes.md
 *
 * Used by .github/workflows/release.yml when it creates a release. A release that already
 * exists keeps the notes it was given; the workflow only attaches the builds to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  linux: `osu-local-profiles-${version}-linux-x64.zip`,
});

export function releaseNotes(changelog, version) {
  const section = changelogSection(changelog, version);
  if (section === null) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const assets = assetsFor(version);
  return `${section}

## Downloads

- **Windows:** \`${assets.windows}\`
- **macOS (Apple silicon):** \`${assets.macos}\`
- **Linux:** \`${assets.linux}\`

Unzip it anywhere and run the launcher inside; the README beside it says how on each system.

## Updating

**From 1.5.0 or later:** press **Update available** in the app. Your \`data/\` folder -- scores, settings, favourites, avatar and banner -- is never touched by an update.

**From 1.4.0 or earlier:** download the zip for your system, unzip it, and copy your existing \`data/\` folder into it before starting it.

Windows is the only platform verified against a real osu! install. The macOS and Linux builds are made and started by CI, but have not yet been run against a real osu!.
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
