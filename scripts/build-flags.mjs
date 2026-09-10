/**
 * Generate `web/flags/<cc>.svg` from Twemoji.
 *
 * osu! does not draw its own flags: `ppy/osu-resources` generates them from Twemoji with
 * its own `osu_flags.sh`, and osu-web serves the same SVGs. Going to Twemoji directly
 * gets the *same artwork* under a licence that allows redistribution (CC-BY 4.0), where
 * copying osu-web's or osu-resources' asset trees would not -- osu-web is AGPL and
 * osu-resources is CC-BY-NC. See THIRD-PARTY-NOTICES.md.
 *
 * The whole set is vendored rather than fetched on demand because `country` is a setting
 * that can be typed offline, so any of the ~250 codes has to resolve with no network. The
 * page still only ever loads one file.
 *
 * Run: node scripts/build-flags.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/* Pinned: a flag set that changes under us would be a silent visual change. */
const PACKAGE = '@twemoji/svg';
const VERSION = '15.0.0';
const TARBALL = `https://registry.npmjs.org/${PACKAGE}/-/svg-${VERSION}.tgz`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web', 'flags');

/**
 * Minimal tar reader.
 *
 * A dependency would buy nothing here: tar is 512-byte headers followed by 512-padded
 * file bodies, and this project deliberately carries almost no node_modules.
 */
function* readTar(buf) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // Two zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) return;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    offset += 512;

    // '0' and '\0' are both "regular file"; everything else (dirs, longlinks) is skipped.
    if (type === '0' || type === '\0') {
      yield { name, body: buf.subarray(offset, offset + size) };
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

/**
 * `1f1fa-1f1f8` -> `us`.
 *
 * A regional indicator sits 127397 above its *uppercase* ASCII letter -- the same
 * arithmetic osu-web's `flag-country.tsx` runs in the other direction.
 */
function codeFromFilename(base) {
  const parts = base.split('-');
  if (parts.length !== 2) return null;
  const letters = parts.map((hex) => {
    const cp = parseInt(hex, 16);
    if (!Number.isFinite(cp)) return null;
    const letter = cp - 127397;
    return letter >= 0x41 && letter <= 0x5a ? String.fromCharCode(letter) : null;
  });
  return letters.every((l) => l !== null) ? letters.join('').toLowerCase() : null;
}

const response = await fetch(TARBALL);
if (!response.ok) {
  console.error(`could not download ${TARBALL}: HTTP ${response.status}`);
  process.exit(1);
}
const tar = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
let bytes = 0;
for (const entry of readTar(tar)) {
  const base = path.basename(entry.name, '.svg');
  if (!entry.name.endsWith('.svg')) continue;

  const code = codeFromFilename(base);
  if (code === null) continue;

  fs.writeFileSync(path.join(outDir, `${code}.svg`), entry.body);
  count += 1;
  bytes += entry.body.length;
}

/*
 * A platform- or upstream-shaped list that matches nothing must fail loudly rather than
 * quietly shipping an empty directory -- the same lesson as the pp helper's prune list.
 */
if (count < 200) {
  console.error(`only ${count} flags extracted from ${PACKAGE}@${VERSION}; expected ~250.`);
  console.error('The package layout probably changed. Not writing a partial set.');
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`${count} flags -> web/flags/ (${(bytes / 1024).toFixed(0)} KB) from ${PACKAGE}@${VERSION}`);
