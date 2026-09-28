/**
 * Vendor osu-web's artwork into `web/osu-web/`, and write `web/css/osu-web-art.css`, the
 * stylesheet that points the page's classes at it.
 *
 * This project is AGPL-3.0-or-later, the licence osu-web is under, so osu!'s own files are
 * used rather than redrawn: the 70-odd mod glyphs and the badge blanks they sit in, the small
 * grade badges, stable's big grade letters, the guest avatar, the default profile banner and the
 * four ruleset icons. They are copied byte for byte and never edited, from one osu-web commit,
 * which `web/osu-web/README.md` records -- all but the ruleset icons, which osu-web keeps only as
 * glyphs of an icon font, and are each written out as an SVG of its own (see `MODE_GLYPHS`),
 * and the banner, which osu-web no longer has (see `COVERS_COMMIT`).
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
 *      node scripts/build-osu-web-art.mjs --commit <sha>                (one commit, not master)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'ppy/osu-web';

/*
 * osu-web's own default profile banners, `public/images/headers/profile-covers/c1`-`c8`, left
 * the repository in 6b22ecb (March 2024), when cover presets moved into a database table and
 * their images onto assets.ppy.sh -- where they come with no licence, and some carry the osu!
 * logo. So the banner a profile with none of its own shows, c3, comes from the last commit that
 * still had them rather than from `commit`.
 */
const COVERS_COMMIT = '770e5d41a20f6b3fd62be5b599a2f1c8cce6c87c';
const DEFAULT_COVER = 'public/images/headers/profile-covers/c3.jpg';

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
  // A named commit: to add something new without also moving everything else to master.
  const named = process.argv.indexOf('--commit');
  if (named > 0) return process.argv[named + 1];
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

async function read(file, at = commit) {
  if (localSource && at !== commit) {
    try {
      return execFileSync('git', ['-C', localSource, 'show', `${at}:${file}`], { maxBuffer: 64 << 20 });
    } catch {
      throw new Error(`${file} at ${at} is not in ${localSource}'s history; fetch that commit or run without --source`);
    }
  }
  if (localSource) {
    const full = path.join(localSource, file);
    if (!fs.existsSync(full)) throw new Error(`${file} is not in ${localSource}; widen its sparse checkout`);
    return fs.readFileSync(full);
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${at}/${file}`;
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
contents.push(['covers/c3.jpg', await read(DEFAULT_COVER, COVERS_COMMIT), DEFAULT_COVER]);

/*
 * The ruleset icons osu-web's mode switcher shows (`playmode-tabs.tsx`): not image files there
 * but four glyphs of its own icon font, `resources/fonts/extra`, which `icons.less` names
 * `fa-extra-mode-*`. Each is taken out of the font's SVG form and written as an SVG of its own:
 * the outline exactly as drawn, turned from the font's upward y axis to an image's downward
 * one, so the page can show it the way it shows a mod glyph, as a mask in the text's colour.
 *
 * The font itself is never taken: it also carries the osu! logo (`osu`, U+E805), which osu-web's
 * README keeps out of its AGPL grant as a trademark. Only the four glyphs named here are read.
 */
const EXTRA_FONT = 'resources/fonts/extra/extra.svg';
const MODE_GLYPHS = { osu: 'mode-osu', taiko: 'mode-taiko', fruits: 'mode-ctb', mania: 'mode-mania' };

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const extraFont = (await read(EXTRA_FONT)).toString('utf8');
const face = attributes(/<font-face\b[^>]*>/.exec(extraFont)?.[0] ?? '');
const fontAdvance = attributes(/<font\b[^>]*>/.exec(extraFont)?.[0] ?? '')['horiz-adv-x'];
const em = Number(face['units-per-em']);
const ascent = Number(face.ascent);
if (!Number.isFinite(em) || !Number.isFinite(ascent)) throw new Error(`${EXTRA_FONT} has no usable <font-face>; its layout probably changed`);
const glyphTags = [...extraFont.matchAll(/<glyph\b[^>]*>/g)].map((m) => attributes(m[0]));
for (const [ruleset, name] of Object.entries(MODE_GLYPHS)) {
  const glyph = glyphTags.find((g) => g['glyph-name'] === name);
  if (!glyph?.d) throw new Error(`${EXTRA_FONT} has no glyph ${name}; the mode switcher's icons moved`);
  const advance = Number(glyph['horiz-adv-x'] ?? fontAdvance ?? em);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${advance} ${em}">` +
    `<path transform="matrix(1 0 0 -1 0 ${ascent})" d="${glyph.d}"/></svg>\n`;
  contents.push([`modes/mode-${ruleset}.svg`, Buffer.from(svg, 'utf8'), `${EXTRA_FONT}#${name}`]);
}

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
| \`covers/\` | \`${DEFAULT_COVER}\` at commit \`${COVERS_COMMIT}\` | the banner of a profile with none of its own |
| \`modes/\` | \`${EXTRA_FONT}\`, glyphs ${Object.values(MODE_GLYPHS).join(', ')} | the mode switcher's ruleset icons |

\`modes/\` is the one folder that is not a copied file: osu-web keeps the ruleset icons only as
glyphs of its icon font, so each glyph's outline is written out as an SVG of its own, unchanged
but for the flip from the font's upward y axis to an image's downward one. The font itself is
not taken: it also holds the osu! logo.

\`covers/\` is the one folder from another commit: osu-web's built-in profile banners were
removed from the repository in 6b22ecb, when cover presets moved to a database table, so the
banner comes from the last commit that still had them.
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

/* osu-web's default profile banner, for a profile with none of its own. */
.cover-default { background-image: ${url('covers/c3.jpg')}; }

${Object.keys(MODE_GLYPHS).map((ruleset) => `.mode-icon--${ruleset} { ${mask(`modes/mode-${ruleset}.svg`)} }`).join('\n')}
`;

fs.writeFileSync(cssFile, css);

console.log(
  `${glyphs.length} mod glyphs, ${Object.keys(GRADES).length} grades, ${LEGACY.length} stable letters, a banner, ` +
    `${Object.keys(MODE_GLYPHS).length} ruleset icons ` +
    `-> web/osu-web/ (${(bytes / 1024).toFixed(0)} KB) from ${REPO}@${commit.slice(0, 12)}`,
);
