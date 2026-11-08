import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * osu-web's artwork, as scripts/build-osu-web-art.mjs vendors it. Every mistake here is
 * silent in the page -- a missing file is a bare badge, a missing rule is an acronym -- so
 * the set is checked against itself and against the tables that name what it must cover.
 */

const root = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(root, 'web', 'css', 'osu-web-art.css'), 'utf8');
const artDir = path.join(root, 'web', 'osu-web');

test('every picture the art stylesheet names is vendored', () => {
  const refs = [...css.matchAll(/url\("\.\.\/osu-web\/([^"]+)"\)/g)].map((m) => m[1] ?? '');
  assert.ok(refs.length > 90, `only ${refs.length} url()s; the stylesheet is truncated`);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(artDir, ref)), `web/osu-web/${ref} is missing`);
  }
});

test('every mod in the game has a glyph', () => {
  // Read as text: mod-definitions.js is a browser module with no typings.
  const table = fs.readFileSync(path.join(root, 'web', 'js', 'mod-definitions.js'), 'utf8');
  const acronyms = [...table.matchAll(/^ {2}"([0-9A-Z]+)": \{/gm)].map((m) => m[1]);
  assert.ok(acronyms.length > 50);
  const glyphs = new Set([...css.matchAll(/\.mod__icon--([0-9A-Z]+)::after/g)].map((m) => m[1]));
  // A mod osu-web draws no glyph for still renders, as its acronym; this says which, so a
  // regeneration that lost glyphs cannot pass unnoticed.
  assert.deepEqual(acronyms.filter((a) => !glyphs.has(a)), []);
  assert.ok(glyphs.has('NM'), "the play tracking filter's no-mod chip uses osu-web's NM glyph");
});

test('every grade the page draws has a picture', () => {
  for (const grade of ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D', 'F']) {
    assert.match(css, new RegExp(`\\.score-rank--${grade} \\{ background-image`), `score-rank--${grade}`);
  }
  // A stable score's big letter: every grade but F, which keeps the dial.
  for (const grade of ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D']) {
    assert.match(css, new RegExp(`\\.legacy-rank--${grade} \\{ background-image`), `legacy-rank--${grade}`);
  }
  assert.match(css, /\.avatar-guest \{ background-image/);
});

test('the vendored set records where it came from and under what licence', () => {
  const readme = fs.readFileSync(path.join(artDir, 'README.md'), 'utf8');
  assert.match(readme, /commit `[0-9a-f]{40}`/);
  assert.match(readme, /GNU Affero General Public\s+License v3\.0 or later/);
  assert.match(css, /ppy Pty Ltd, AGPL-3\.0-or-later/);
});

test('nothing is vendored that the licence does not cover', () => {
  // osu!'s logos are trademarks outside osu-web's AGPL grant; osu-resources is CC-BY-NC.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(artDir, full).split(path.sep).join('/'));
    }
  };
  walk(artDir);
  // The one font is the app's own, of the four ruleset glyphs alone (checked below).
  assert.deepEqual(files.filter((f) => f !== 'modes/modes.ttf' && /logo|pippi|font|\.(?:otf|ttf|woff2?)$/i.test(f)), []);
  const folders = new Set(files.map((f) => f.split('/')[0]));
  assert.deepEqual([...folders].sort(), ['README.md', 'covers', 'grades', 'layout', 'modes', 'mods', 'scores']);
  // The default banner is osu-web's own c3, from its repository. osu!'s newer cover presets live
  // on assets.ppy.sh with no licence, and some carry the osu! logo.
  assert.deepEqual(fs.readdirSync(path.join(artDir, 'covers')), ['c3.jpg']);
});

/*
 * The ruleset icons (roadmap 5.72) are the one set not copied as files: osu-web keeps them only
 * as glyphs of its icon font, and that font also holds the osu! logo (U+E805). So the four are
 * written into a font of the app's own, and this holds the line -- exactly those four glyphs,
 * nothing at the logo's code point, and nothing else of osu-web's font.
 */
test('the ruleset icons are the four mode glyphs alone, never the font or its logo', () => {
  const modes = path.join(artDir, 'modes');
  assert.deepEqual(fs.readdirSync(modes), ['modes.ttf']);
  const font = fs.readFileSync(path.join(modes, 'modes.ttf'));
  const table = (tag: string) => {
    for (let i = 0; i < font.readUInt16BE(4); i++) {
      const at = 12 + i * 16;
      if (font.toString('latin1', at, at + 4) === tag) return font.subarray(font.readUInt32BE(at + 8));
    }
    throw new Error(`no ${tag} table`);
  };
  assert.equal(table('maxp').readUInt16BE(4), 5, '.notdef and the four mode glyphs');
  // Every code point the font maps, from its one format 4 subtable.
  const cmap = table('cmap');
  const sub = cmap.subarray(cmap.readUInt32BE(8));
  const segs = sub.readUInt16BE(6) / 2;
  const mapped: number[] = [];
  for (let i = 0; i < segs; i++) {
    const end = sub.readUInt16BE(14 + i * 2);
    const start = sub.readUInt16BE(16 + segs * 2 + i * 2);
    if (start !== 0xffff) for (let c = start; c <= end; c++) mapped.push(c);
  }
  assert.equal(mapped.length, 4);
  assert.ok(!mapped.includes(0xe805), "nothing at the osu! logo's code point");
  for (const ruleset of ['osu', 'taiko', 'fruits', 'mania']) {
    const code = new RegExp(`\\.mode-icon--${ruleset}::before \\{ content: "\\\\([0-9a-f]+)"; \\}`).exec(css)?.[1];
    assert.ok(code && mapped.includes(Number.parseInt(code, 16)), `.mode-icon--${ruleset} draws one of the four glyphs`);
  }
  assert.match(css, /font-family: "osu-web modes";\s+src: url\("\.\.\/osu-web\/modes\/modes\.ttf"\)/);
});
