import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aboutImageFile, saveAboutImage } from '../src/about-images.ts';

const png = (fill: number) =>
  Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16, fill)]);

test('a pasted image is kept under its content, and found again by its address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-about-'));
  try {
    const url = saveAboutImage(dir, 3, png(1));
    assert.match(url ?? '', /^\/api\/about-image\/3\/[0-9a-f]{16}\.png$/);
    // The same picture twice is one file with one address.
    assert.equal(saveAboutImage(dir, 3, png(1)), url);
    assert.notEqual(saveAboutImage(dir, 3, png(2)), url);

    const found = aboutImageFile(dir, url!);
    assert.equal(found?.mime, 'image/png');
    assert.deepEqual(fs.readFileSync(found!.file), png(1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not an image is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-about-'));
  try {
    assert.equal(saveAboutImage(dir, 1, Buffer.from('<svg onload="x"></svg>........')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only an address in the shape this app gives out finds a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-about-'));
  try {
    fs.writeFileSync(path.join(dir, 'secret.png'), png(3));
    assert.equal(aboutImageFile(dir, '/api/about-image/1/../../secret.png'), null);
    assert.equal(aboutImageFile(dir, '/api/about-image/1/0123456789abcdef.svg'), null);
    assert.equal(aboutImageFile(dir, '/api/about-image/1/0123456789abcdef.png'), null, 'no such file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
