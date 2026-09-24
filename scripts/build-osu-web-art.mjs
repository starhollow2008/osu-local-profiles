/**
 * Vendor osu-web's artwork into `web/osu-web/`, and write `web/css/osu-web-art.css`, the
 * stylesheet that points the page's classes at it.
 *
 * This project is AGPL-3.0-or-later, the licence osu-web is under, so osu!'s own files are
 * used rather than redrawn: the 70-odd mod glyphs and the badge blanks they sit in, the small
 * grade badges, stable's big grade letters and the guest avatar. They are copied byte for
 * byte and never edited, from one osu-web commit, which `web/osu-web/README.md` records.
 * THIRD-PARTY-NOTICES.md credits them.
 *
 * Which glyph belongs to which acronym is read out of osu-web's own `mod.less`, so a mod
 * osu-web adds a glyph for gets one here the next time this runs, with nothing to edit.
 *
 * Not taken, under any licence: the osu! and ppy logos (osu-web's README keeps its
 * trademarks out of the AGPL grant), Torus and Venera (licensed to ppy alone), and anything
 * from ppy/osu-resources (CC-BY-NC). None of them is on the lists below.
 *
 * Run: node scripts/build-osu-web-art.mjs
 *      node scripts/build-osu-web-art.mjs --source reference/osu-web   (no network)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'ppy/osu-web';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web', 'osu-web');
const cssFile = path.join(root, 'web', 'css', 'osu-web-art.css');

/*
 * `--source <dir>` reads from the sparse `reference/osu-web` checkout instead of GitHub, as
 * `build-mod-table.mjs` does. docs/osu-web-fidelity.md lists the folders it needs.
 */
const argument = process.argv.indexOf('--source');
const localSource = argument > 0 ? path.resolve(process.argv[argument + 1]) : null;

/*
 * Every file comes from one commit. Fetching `master` file by file could straddle a push and
 * mix two versions of the art; resolving the commit first cannot.
 */
async function resolveCommit() {
  if (localSource) {
    return execFileSync('git', ['-C', localSource, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/master`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`could not resolve ${REPO}@master: HTTP ${response.status}`);
  return (await response.json()).sha;
}

const commit = await resolveCommit();

async function read(file) {
  if (localSource) {
    const full = path.join(localSource, file);
    if (!fs.existsSync(full)) throw new Error(`${file} is not in ${localSource}; widen its sparse checkout`);
    return fs.readFileSync(full);
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/* ------------------------------------------------------------ what is taken */

/*
 * `.mod-icon-osu(HD, hidden);` -- osu-web's acronym-to-file table, in the stylesheet that uses
 * it. `NM` is in it too: osu-web's own glyph for "no mod", which the play tracking filter uses.
 * A mod with no line here keeps osu-web's fallback, its acronym (`content: attr(data-acronym)`).
 */
const modLess = (await read('resources/css/bem/mod.less')).toString('utf8');
const glyphs = [...modLess.matchAll(/\.mod-icon-osu\(\s*([0-9A-Z]+)\s*,\s*([a-z0-9-]+)\s*\);/g)]
  .map(([, acronym, name]) => ({ acronym, file: `mod-${name}.svg` }));

/*
 * A table that comes back short must fail rather than replace a good set with a partial one;
 * a missing glyph is a quiet regression to the acronym.
 */
if (glyphs.length < 60) {
  throw new Error(`only ${glyphs.length} mod glyphs found in mod.less; expected ~70. Its layout probably changed.`);
}

const MODS = 'public/images/badges/mods';
const BLANKS = ['mod-icon.svg', 'mod-icon-extender.svg'];

/* osu-web's `score-rank.less`: the grade each class shows. */
const GRADES = {
  XH: 'SS-Silver', X: 'SS', SH: 'S-Silver', S: 'S', A: 'A', B: 'B', C: 'C', D: 'D', F: 'F',
};

/*
 * osu-web's `legacy-rank.less`, a stable score's big letter: stable's default skin. Only the
 * @2x files are taken; the box is 200x160 and a 1x screen scales them down cleanly.
 */
const LEGACY = ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D'];

/* ------------------------------------------------------------------ writing */

const files = [];
for (const { file } of glyphs) files.push([`${MODS}/${file}`, `mods/${file}`]);
for (const blank of BLANKS) files.push([`${MODS}/blanks/${blank}`, `mods/blanks/${blank}`]);
for (const value of new Set(Object.values(GRADES))) {
  files.push([`public/images/badges/score-ranks-v2019/GradeSmall-${value}.svg`, `grades/GradeSmall-${value}.svg`]);
}
for (const rank of LEGACY) {
  files.push([`resources/images/scores/legacy-ranking-${rank}@2x.png`, `scores/legacy-ranking-${rank}@2x.png`]);
}
files.push(['public/images/layout/avatar-guest@2x.png', 'layout/avatar-guest@2x.png']);

// Read everything before touching the folder, so a failed download leaves the old set whole.
const contents = [];
for (const [from, to] of files) contents.push([to, await read(from), from]);

fs.rmSync(outDir, { recursive: true, force: true });
let bytes = 0;
for (const [to, buffer] of contents) {
  const target = path.join(outDir, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  bytes += buffer.length;
}

const source = `https://github.com/${REPO}/tree/${commit}`;

fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# osu-web artwork

Copied unmodified from [${REPO}](${source}) at commit \`${commit}\` by
\`scripts/build-osu-web-art.mjs\`. **Do not edit these files**; run the script again instead.

Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the GNU Affero General Public
License v3.0 or later, as osu-web is. See \`LICENSE\` and \`THIRD-PARTY-NOTICES.md\` at the root
of this repository.

"osu!" and "ppy" are trademarks of ppy Pty Ltd. This project is not affiliated with or endorsed
by ppy.

| folder | osu-web source | used for |
|---|---|---|
| \`mods/\` | \`${MODS}/\` | the glyph in each mod badge, and the badge blanks |
| \`grades/\` | \`public/images/badges/score-ranks-v2019/\` | the small grade badges |
| \`scores/\` | \`resources/images/scores/\` | a stable score's big grade letter |
| \`layout/\` | \`public/images/layout/\` | the avatar of a profile with no picture |
`,
);

/* -------------------------------------------------------------- stylesheet */

const url = (to) => `url("../osu-web/${to}")`;
const mask = (to) => `-webkit-mask-image: ${url(to)}; mask-image: ${url(to)};`;

const css = `/*
 * GENERATED by scripts/build-osu-web-art.mjs -- do not edit.
 *
 * Points the page's classes at osu-web's own artwork in web/osu-web/, the way osu-web's
 * mod.less, score-rank.less, legacy-rank.less and avatar.less do. Shapes, sizes and colours are
 * in profile.css; this file is only which picture goes where.
 *
 * Artwork (c) ppy Pty Ltd, AGPL-3.0-or-later, from ${REPO}@${commit.slice(0, 12)}.
 * Share inlines every url() here into a saved copy (web/js/share-copy.js).
 */

.mod__icon::before { ${mask('mods/blanks/mod-icon.svg')} }
.mod__extender { ${mask('mods/blanks/mod-icon-extender.svg')} }

${glyphs.map(({ acronym, file }) => `.mod__icon--${acronym}::after { content: ""; background-color: var(--type-fg-colour); ${mask(`mods/${file}`)} }`).join('\n')}

${Object.entries(GRADES).map(([grade, value]) => `.score-rank--${grade} { background-image: ${url(`grades/GradeSmall-${value}.svg`)}; }`).join('\n')}

${LEGACY.map((rank) => `.legacy-rank--${rank} { background-image: ${url(`scores/legacy-ranking-${rank}@2x.png`)}; }`).join('\n')}

.avatar-guest { background-image: ${url('layout/avatar-guest@2x.png')}; }
`;

fs.writeFileSync(cssFile, css);

console.log(
  `${glyphs.length} mod glyphs, ${Object.keys(GRADES).length} grades, ${LEGACY.length} stable letters ` +
    `-> web/osu-web/ (${(bytes / 1024).toFixed(0)} KB) from ${REPO}@${commit.slice(0, 12)}`,
);
