/**
 * The launcher's icons, from the page's own: web/favicon.svg.
 *
 *   npm run build:icons
 *
 * Writes tools/launcher/icon/, which is committed, so building the launcher needs no browser.
 * Run this again only when the favicon changes. Rendered by a Chromium-based browser already on
 * the machine (the one Share uses for images), at every size a platform asks for, so no size is
 * a scaled-down copy of another.
 *
 * - tray.ico       Windows' tray: 16-48px, as PNG entries (Vista and later read those).
 * - tray.png       Linux's tray, which scales one image itself.
 * - template.png   macOS's menu bar: black on transparent, which the bar tints for light or
 *                  dark. A menu bar item in colour is the exception there, not the rule.
 * - app.png        The Windows executable's icon, turned into a resource by go-winres.
 * - app.icns       The macOS bundle's icon, 16px to 1024px.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../src/http/screenshot.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tools', 'launcher', 'icon');
const favicon = fs.readFileSync(path.join(root, 'web', 'favicon.svg'), 'utf8');

/*
 * The template: the disc solid, the house cut out of it. Only alpha counts in a template image,
 * so the favicon's white house would vanish into its disc; a mask keeps the house as a hole.
 */
const housePath = /<path[^>]*\sd="([^"]+)"/.exec(favicon)?.[1];
if (!housePath) throw new Error('web/favicon.svg has no house path to cut out of the template');
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <mask id="m"><circle cx="32" cy="32" r="30" fill="#fff"/><path fill="#000" d="${housePath}"/></mask>
  <rect width="64" height="64" fill="#000" mask="url(#m)"/>
</svg>`;

const browser = findBrowser();
if (!browser) {
  console.error('\n  no Chrome, Edge or Chromium found to render the icons with.\n');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-icons-'));

/** One square PNG of `svg` at `size` pixels, transparent around the artwork. */
function render(svg, size) {
  const html = path.join(work, `icon-${size}.html`);
  const png = path.join(work, `icon-${size}.png`);
  const data = Buffer.from(svg).toString('base64');
  fs.writeFileSync(
    html,
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${data}" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  fs.rmSync(png, { force: true });
  const result = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--user-data-dir=${path.join(work, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${png}`,
      `file://${html.replace(/\\/g, '/')}`,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (!fs.existsSync(png)) throw new Error(`the browser rendered no ${size}px icon: ${result.stderr}`);
  const bytes = fs.readFileSync(png);
  // A PNG's IHDR holds its size; a browser that ignored the window size is caught here.
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== size || height !== size) throw new Error(`asked for ${size}px, got ${width}x${height}`);
  return bytes;
}

/** An .ico holding PNG images: a 6-byte header, a 16-byte entry each, then the images. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

/** An .icns of PNG entries: 'icns' and the total length, then a type and length per image. */
function icns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

try {
  fs.mkdirSync(out, { recursive: true });
  const cache = new Map();
  const colour = (size) => {
    if (!cache.has(size)) cache.set(size, render(favicon, size));
    return cache.get(size);
  };

  fs.writeFileSync(path.join(out, 'tray.ico'), ico([16, 20, 24, 32, 40, 48].map((size) => ({ size, png: colour(size) }))));
  fs.writeFileSync(path.join(out, 'tray.png'), colour(64));
  // 36px is the menu bar's 18pt at 2x; the bar draws it at its own height.
  fs.writeFileSync(path.join(out, 'template.png'), render(template, 36));
  fs.writeFileSync(path.join(out, 'app.png'), colour(256));
  fs.writeFileSync(
    path.join(out, 'app.icns'),
    icns([
      { type: 'icp4', png: colour(16) },
      { type: 'icp5', png: colour(32) },
      { type: 'ic11', png: colour(32) },
      { type: 'ic12', png: colour(64) },
      { type: 'ic07', png: colour(128) },
      { type: 'ic13', png: colour(256) },
      { type: 'ic08', png: colour(256) },
      { type: 'ic14', png: colour(512) },
      { type: 'ic09', png: colour(512) },
      { type: 'ic10', png: colour(1024) },
    ]),
  );

  for (const name of fs.readdirSync(out)) {
    console.log(`  ${name.padEnd(14)} ${fs.statSync(path.join(out, name)).size.toLocaleString()} bytes`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
