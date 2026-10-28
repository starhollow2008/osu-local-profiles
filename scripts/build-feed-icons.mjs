/**
 * Vendor the Recent feed's icons into `web/feed-icons/` from the media repo they are drawn in,
 * `starhollow2008/osu-local-profiles-ext-media`.
 *
 * Each icon has a folder of its own there, `<name>/<name>.png`, an 88x88 export that the page
 * shows at 22px so it stays sharp on a high-density screen. They are copied byte for byte from
 * one commit, which `web/feed-icons/README.md` records, and the app itself never fetches
 * anything from that repo: the pictures ship with the page and show offline. Only this script
 * goes to the network, and only when someone runs it.
 *
 * The artwork is CC BY 4.0, (c) 2026 FlareonGhh. THIRD-PARTY-NOTICES.md credits it.
 *
 * Run: node scripts/build-feed-icons.mjs
 *      node scripts/build-feed-icons.mjs --source ../osu-local-profiles-ext-media   (no network)
 *      node scripts/build-feed-icons.mjs --commit <sha>                             (one commit, not the default branch)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'starhollow2008/osu-local-profiles-ext-media';

/** The icons the page uses (`feedIcon()` in web/js/sections.js) and what each marks. */
const ICONS = [
  { name: 'level-up', usedFor: '"Reached level N" rows' },
  { name: 'new-best', usedFor: '"New best performance" rows' },
];

/** The export size every icon is made at. */
const SIZE = 88;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web', 'feed-icons');

/* `--source <dir>` reads a local checkout instead of GitHub, as `build-osu-web-art.mjs` does. */
const argument = process.argv.indexOf('--source');
const localSource = argument > 0 ? path.resolve(process.argv[argument + 1]) : null;

/*
 * Every file comes from one commit. Fetching the branch file by file could straddle a push and
 * mix two versions of the art; resolving the commit first cannot.
 */
async function resolveCommit() {
  const named = process.argv.indexOf('--commit');
  if (named > 0) return process.argv[named + 1];
  if (localSource) {
    return execFileSync('git', ['-C', localSource, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  // `HEAD` is the repository's default branch.
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`could not resolve ${REPO}: HTTP ${response.status}`);
  return (await response.json()).sha;
}

const commit = await resolveCommit();

async function read(file) {
  if (localSource) {
    // From the commit, not the working tree, so an unsaved edit never lands in a release.
    try {
      return execFileSync('git', ['-C', localSource, 'show', `${commit}:${file}`], { maxBuffer: 64 << 20 });
    } catch {
      throw new Error(`${file} at ${commit} is not in ${localSource}'s history`);
    }
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/*
 * A bad download must fail rather than replace a good icon: a Git LFS pointer text file, an HTML
 * error page or a wrong-size export all look like a picture until the page draws them.
 */
function checkPng(name, buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${name}.png is not a PNG (a Git LFS pointer, or an error page?)`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== SIZE || height !== SIZE) {
    throw new Error(`${name}.png is ${width}x${height}; the page expects ${SIZE}x${SIZE}`);
  }
}

const files = [];
for (const { name } of ICONS) {
  const buffer = await read(`${name}/${name}.png`);
  checkPng(name, buffer);
  files.push({ name, buffer });
}

fs.mkdirSync(outDir, { recursive: true });
for (const { name, buffer } of files) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), buffer);
}

fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# Feed icons

Copied unmodified from [${REPO}](https://github.com/${REPO}/tree/${commit}) at commit
\`${commit}\` by \`scripts/build-feed-icons.mjs\`. **Do not edit these files**; run the script
again instead. The app never fetches them: they ship with the page.

Copyright (c) 2026 FlareonGhh ([@starhollow2008](https://github.com/starhollow2008)). Licensed
under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
(CC BY 4.0). See \`THIRD-PARTY-NOTICES.md\` at the root of this repository.

| file | source in that repo | used for |
|---|---|---|
${ICONS.map(({ name, usedFor }) => `| \`${name}.png\` | \`${name}/${name}.png\` | ${usedFor} in the Recent feed |`).join('\n')}

Each is ${SIZE}x${SIZE} px and shown at 22 px.
`,
);

console.log(`feed icons: ${files.length} copied from ${REPO}@${commit.slice(0, 7)}`);
