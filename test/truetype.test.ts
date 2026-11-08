import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTrueType, contoursOf } from '../scripts/truetype.mjs';

/** The table directory, and each table's bytes. */
function tables(font: Buffer) {
  const count = font.readUInt16BE(4);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = font.toString('latin1', at, at + 4);
    const offset = font.readUInt32BE(at + 8);
    const length = font.readUInt32BE(at + 12);
    out.set(tag, font.subarray(offset, offset + length));
  }
  return out;
}

function sum(buffer: Buffer) {
  let total = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    const word = Buffer.alloc(4);
    buffer.copy(word, 0, i, Math.min(i + 4, buffer.length));
    total = (total + word.readUInt32BE(0)) >>> 0;
  }
  return total;
}

/** A format 4 cmap lookup, as a browser does it. */
function glyphFor(cmap: Buffer, codePoint: number) {
  const sub = cmap.subarray(cmap.readUInt32BE(8));
  const segs = sub.readUInt16BE(6) / 2;
  for (let i = 0; i < segs; i++) {
    const end = sub.readUInt16BE(14 + i * 2);
    const start = sub.readUInt16BE(16 + segs * 2 + i * 2);
    const delta = sub.readUInt16BE(16 + segs * 4 + i * 2);
    if (codePoint >= start && codePoint <= end) return (codePoint + delta) % 0x10000;
  }
  return 0;
}

test('a path of lines and quadratic curves becomes TrueType contours', () => {
  // A square with one curved side, relative, closed back onto its start.
  const [contour, ...rest] = contoursOf('M0 0l100 0q50 50 0 100t0 100h-100z');
  assert.equal(rest.length, 0);
  assert.deepEqual(contour, [
    { x: 0, y: 0, on: true },
    { x: 100, y: 0, on: true },
    { x: 150, y: 50, on: false },
    { x: 100, y: 100, on: true },
    // T mirrors the last control point through the current point.
    { x: 50, y: 150, on: false },
    { x: 100, y: 200, on: true },
    { x: 0, y: 200, on: true },
  ]);
  assert.throws(() => contoursOf('M0 0c1 1 2 2 3 3z'), /not supported/);
});

test('the font holds each glyph at its code point, with sound checksums', () => {
  const font = buildTrueType({
    family: 'test icons',
    copyright: 'test',
    unitsPerEm: 1000,
    ascent: 850,
    descent: -150,
    glyphs: [
      { codePoint: 0xe801, advance: 1000, d: 'M0 0h500v500h-500z' },
      { codePoint: 0xe800, advance: 800, d: 'M0 0h100v100z m200 0h100v100z' },
    ],
  });
  assert.equal(font.length % 4, 0);
  const t = tables(font);
  for (const tag of ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
    assert.ok(t.has(tag), `${tag} is there`);
  }
  // Every table but head sums to what the directory says; the whole font to the magic number.
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    const tag = font.toString('latin1', at, at + 4);
    if (tag !== 'head') assert.equal(sum(t.get(tag)!), font.readUInt32BE(at + 4), `${tag} checksum`);
  }
  assert.equal(sum(font), 0xb1b0afba);

  assert.equal(t.get('maxp')!.readUInt16BE(4), 3, '.notdef and two glyphs');
  assert.equal(glyphFor(t.get('cmap')!, 0xe800), 1);
  assert.equal(glyphFor(t.get('cmap')!, 0xe801), 2);
  assert.equal(glyphFor(t.get('cmap')!, 0x41), 0);
  // Glyph 1 is the two triangles: two contours, advance 800.
  const loca = t.get('loca')!;
  const glyf = t.get('glyf')!;
  assert.equal(glyf.readInt16BE(loca.readUInt32BE(4)), 2);
  assert.equal(t.get('hmtx')!.readUInt16BE(4), 800);
});

test("the built mode icon font holds osu-web's four ruleset glyphs", () => {
  const file = path.join(import.meta.dirname, '..', 'web', 'osu-web', 'modes', 'modes.ttf');
  const t = tables(fs.readFileSync(file));
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'css', 'osu-web-art.css'), 'utf8');
  for (const ruleset of ['osu', 'taiko', 'fruits', 'mania']) {
    const codePoint = Number.parseInt(new RegExp(`\\.mode-icon--${ruleset}::before \\{ content: "\\\\([0-9a-f]+)"`).exec(css)?.[1] ?? '', 16);
    assert.ok(Number.isFinite(codePoint), `${ruleset} has a glyph in the stylesheet`);
    assert.notEqual(glyphFor(t.get('cmap')!, codePoint), 0, `${ruleset}'s code point is in the font`);
  }
});
