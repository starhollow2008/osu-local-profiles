/**
 * A minimal TrueType font from glyph outlines: enough for a browser to draw a few icons as text.
 *
 * Used by scripts/build-osu-web-art.mjs for osu-web's four ruleset icons, which osu-web draws as
 * glyphs of its icon font. Drawn as text, Windows gives them ClearType and the same weight as
 * on osu!, where the same outlines as a CSS mask come out thinner and rougher at a 125% scale.
 *
 * Takes each glyph's outline as an SVG font gives it (`<glyph d>`: font units, y up), with only
 * lines and quadratic curves, which TrueType stores as they are. No hinting, no kerning: one
 * `cmap` subtable for the code points given, and the tables a browser's font sanitiser asks for.
 */

/** An SVG path of lines and quadratic curves, as TrueType contours of on- and off-curve points. */
export function contoursOf(d) {
  // Every letter is a command, so one this cannot draw is refused rather than skipped.
  const tokens = d.match(/[A-DF-Za-df-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const contours = [];
  let contour = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The last control point, for T, and whether the previous command left one.
  let cx = 0;
  let cy = 0;
  let smooth = false;
  let command = null;
  let i = 0;
  const number = () => {
    const value = Number(tokens[i++]);
    if (!Number.isFinite(value)) throw new Error(`bad number in path near token ${i}`);
    return value;
  };
  const close = () => {
    if (contour && contour.length > 0) {
      // A closing point on top of the first is the same point twice to TrueType.
      const first = contour[0];
      const last = contour[contour.length - 1];
      if (contour.length > 1 && last.on && Math.round(last.x) === Math.round(first.x) && Math.round(last.y) === Math.round(first.y)) {
        contour.pop();
      }
      if (contour.length > 0) contours.push(contour);
    }
    contour = null;
  };
  const point = (px, py, on) => {
    if (!contour) contour = [];
    contour.push({ x: px, y: py, on });
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];
    else if (command === null) throw new Error('path does not start with a command');
    const relative = command === command.toLowerCase();
    switch (command.toUpperCase()) {
      case 'M': {
        close();
        x = (relative ? x : 0) + number();
        y = (relative ? y : 0) + number();
        startX = x;
        startY = y;
        point(x, y, true);
        smooth = false;
        // Further pairs after a move are lines.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L':
        x = (relative ? x : 0) + number();
        y = (relative ? y : 0) + number();
        point(x, y, true);
        smooth = false;
        break;
      case 'H':
        x = (relative ? x : 0) + number();
        point(x, y, true);
        smooth = false;
        break;
      case 'V':
        y = (relative ? y : 0) + number();
        point(x, y, true);
        smooth = false;
        break;
      case 'Q': {
        cx = (relative ? x : 0) + number();
        cy = (relative ? y : 0) + number();
        x = (relative ? x : 0) + number();
        y = (relative ? y : 0) + number();
        point(cx, cy, false);
        point(x, y, true);
        smooth = true;
        break;
      }
      case 'T': {
        // The control point mirrors the last one through the current point.
        cx = smooth ? 2 * x - cx : x;
        cy = smooth ? 2 * y - cy : y;
        x = (relative ? x : 0) + number();
        y = (relative ? y : 0) + number();
        point(cx, cy, false);
        point(x, y, true);
        smooth = true;
        break;
      }
      case 'Z':
        close();
        x = startX;
        y = startY;
        smooth = false;
        break;
      default:
        throw new Error(`path command ${command} is not supported (lines and quadratic curves only)`);
    }
  }
  close();
  return contours.map((c) => c.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on })));
}

/* --------------------------------------------------------------- writing */

class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(v) { this.bytes.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff); }
  tag(s) { for (const ch of s.padEnd(4, ' ')) this.u8(ch.charCodeAt(0)); return this; }
  pad4() { while (this.bytes.length % 4) this.u8(0); return this; }
  buffer() { return Buffer.from(this.bytes); }
}

function checksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    const word = ((buffer[i] ?? 0) << 24 | (buffer[i + 1] ?? 0) << 16 | (buffer[i + 2] ?? 0) << 8 | (buffer[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function utf16be(text) {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

/**
 * @param {object} font
 * @param {string} font.family   the name the font reports; the page names its own in @font-face
 * @param {string} font.copyright
 * @param {number} font.unitsPerEm
 * @param {number} font.ascent    above the baseline, font units
 * @param {number} font.descent   below it, as a negative number
 * @param {{ codePoint: number, advance: number, d: string }[]} font.glyphs
 * @returns {Buffer}
 */
export function buildTrueType({ family, copyright, unitsPerEm, ascent, descent, glyphs }) {
  const sorted = [...glyphs].sort((a, b) => a.codePoint - b.codePoint);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].codePoint === sorted[i - 1].codePoint) throw new Error(`code point ${sorted[i].codePoint.toString(16)} given twice`);
  }

  // Glyph 0 is .notdef, empty. The rest in code point order.
  const outlines = [{ advance: unitsPerEm, contours: [] }, ...sorted.map((g) => ({ advance: Math.round(g.advance), contours: contoursOf(g.d) }))];
  const boxes = outlines.map(({ contours }) => {
    const points = contours.flat();
    if (points.length === 0) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    return {
      xMin: Math.min(...points.map((p) => p.x)),
      yMin: Math.min(...points.map((p) => p.y)),
      xMax: Math.max(...points.map((p) => p.x)),
      yMax: Math.max(...points.map((p) => p.y)),
    };
  });
  const drawn = boxes.filter((_, i) => outlines[i].contours.length > 0);
  const all = {
    xMin: Math.min(...drawn.map((b) => b.xMin)),
    yMin: Math.min(...drawn.map((b) => b.yMin)),
    xMax: Math.max(...drawn.map((b) => b.xMax)),
    yMax: Math.max(...drawn.map((b) => b.yMax)),
  };
  const numGlyphs = outlines.length;

  // glyf and loca (long offsets).
  const glyf = new Writer();
  const offsets = [];
  outlines.forEach(({ contours }, index) => {
    offsets.push(glyf.bytes.length);
    if (contours.length === 0) return;
    const box = boxes[index];
    glyf.i16(contours.length).i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax);
    let end = -1;
    for (const c of contours) glyf.u16((end += c.length));
    glyf.u16(0); // no instructions
    const points = contours.flat();
    for (const p of points) glyf.u8(p.on ? 1 : 0);
    let last = 0;
    for (const p of points) { glyf.i16(p.x - last); last = p.x; }
    last = 0;
    for (const p of points) { glyf.i16(p.y - last); last = p.y; }
    glyf.pad4();
  });
  offsets.push(glyf.bytes.length);
  const loca = new Writer();
  for (const o of offsets) loca.u32(o);

  const maxPoints = Math.max(...outlines.map((o) => o.contours.flat().length));
  const maxContours = Math.max(...outlines.map((o) => o.contours.length));
  const advanceMax = Math.max(...outlines.map((o) => o.advance));

  const head = new Writer()
    .u32(0x00010000).u32(0x00010000)
    .u32(0) // checkSumAdjustment, filled in last
    .u32(0x5f0f3cf5)
    .u16(0x000b) // baseline and left sidebearing at 0, integer scaling
    .u16(unitsPerEm)
    .u32(0).u32(0).u32(0).u32(0) // created, modified
    .i16(all.xMin).i16(all.yMin).i16(all.xMax).i16(all.yMax)
    .u16(0) // macStyle
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(1) // indexToLocFormat: long
    .i16(0);

  const hhea = new Writer()
    .u32(0x00010000)
    .i16(ascent).i16(descent).i16(0)
    .u16(advanceMax)
    .i16(Math.min(...drawn.map((b) => b.xMin)))
    .i16(Math.min(...outlines.filter((o) => o.contours.length).map((o, i) => o.advance - drawn[i].xMax)))
    .i16(all.xMax)
    .i16(1).i16(0).i16(0) // caret
    .i16(0).i16(0).i16(0).i16(0)
    .i16(0) // metricDataFormat
    .u16(numGlyphs);

  const hmtx = new Writer();
  outlines.forEach((o, i) => hmtx.u16(o.advance).i16(boxes[i].xMin));

  const maxp = new Writer()
    .u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours)
    .u16(0).u16(0) // composites
    .u16(2) // maxZones
    .u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  // cmap: one format 4 subtable (Windows, Unicode BMP). Runs of consecutive code points share a
  // segment; the final 0xFFFF segment is required.
  const segments = [];
  sorted.forEach((g, i) => {
    const glyphId = i + 1;
    const run = segments[segments.length - 1];
    if (run && g.codePoint === run.end + 1 && glyphId - g.codePoint === run.delta) run.end = g.codePoint;
    else segments.push({ start: g.codePoint, end: g.codePoint, delta: glyphId - g.codePoint });
  });
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const segCount = segments.length;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const subtable = new Writer()
    .u16(4).u16(16 + 8 * segCount).u16(0)
    .u16(segCount * 2).u16(searchRange).u16(Math.log2(searchRange / 2)).u16(segCount * 2 - searchRange);
  for (const s of segments) subtable.u16(s.end);
  subtable.u16(0);
  for (const s of segments) subtable.u16(s.start);
  for (const s of segments) subtable.u16((s.delta + 0x10000) % 0x10000);
  for (const _ of segments) subtable.u16(0);
  const cmap = new Writer().u16(0).u16(1).u16(3).u16(1).u32(12);
  cmap.bytes.push(...subtable.bytes);

  const first = sorted[0].codePoint;
  const last = sorted[sorted.length - 1].codePoint;
  const os2 = new Writer()
    .u16(4)
    .i16(Math.round(outlines.slice(1).reduce((sum, o) => sum + o.advance, 0) / sorted.length))
    .u16(400).u16(5)
    .u16(0) // fsType: installable
    .i16(650).i16(600).i16(0).i16(75) // subscript
    .i16(650).i16(600).i16(0).i16(350) // superscript
    .i16(50).i16(250) // strikeout
    .i16(0);
  for (let i = 0; i < 10; i++) os2.u8(0); // panose
  // ulUnicodeRange: bit 60, the Private Use Area, when the icons live there.
  const privateUse = first >= 0xe000 && last <= 0xf8ff;
  os2.u32(0).u32(privateUse ? 1 << 28 : 0).u32(0).u32(0)
    .tag('NONE')
    .u16(0x00c0) // REGULAR, USE_TYPO_METRICS
    .u16(Math.min(first, 0xffff)).u16(Math.min(last, 0xffff))
    .i16(ascent).i16(descent).i16(0)
    .u16(ascent).u16(-descent)
    .u32(1).u32(0) // ulCodePageRange: Latin 1
    .i16(0).i16(0)
    .u16(0).u16(0x20).u16(0);

  // name: Windows, Unicode, US English. Sorted by name id.
  const names = [
    [0, copyright],
    [1, family],
    [2, 'Regular'],
    [3, `${family} Regular`],
    [4, family],
    [5, 'Version 1.0'],
    [6, family.replace(/[^A-Za-z0-9-]/g, '')],
  ];
  const strings = names.map(([, text]) => utf16be(text));
  const name = new Writer().u16(0).u16(names.length).u16(6 + 12 * names.length);
  let at = 0;
  names.forEach(([id], i) => {
    name.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i].length).u16(at);
    at += strings[i].length;
  });
  for (const s of strings) name.bytes.push(...s);

  const post = new Writer().u32(0x00030000).u32(0).i16(-75).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

  const tables = [
    ['OS/2', os2], ['cmap', cmap], ['glyf', glyf], ['head', head], ['hhea', hhea],
    ['hmtx', hmtx], ['loca', loca], ['maxp', maxp], ['name', name], ['post', post],
  ].map(([tag, writer]) => [tag, writer.buffer()]);

  const numTables = tables.length;
  const tableSearch = 16 * 2 ** Math.floor(Math.log2(numTables));
  const directory = new Writer()
    .u32(0x00010000).u16(numTables).u16(tableSearch).u16(Math.log2(tableSearch / 16)).u16(numTables * 16 - tableSearch);
  let offset = 12 + 16 * numTables;
  const body = [];
  let headOffset = 0;
  for (const [tag, data] of tables) {
    if (tag === 'head') headOffset = offset;
    directory.tag(tag).u32(checksum(data)).u32(offset).u32(data.length);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
    data.copy(padded);
    body.push(padded);
    offset += padded.length;
  }

  const font = Buffer.concat([directory.buffer(), ...body]);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}
