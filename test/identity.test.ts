import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearImage, findImage, imageState, saveImage, sniffImage } from '../src/identity.ts';
import { parseUserQuery } from '../src/clients/osu-web.ts';
import { detectLocalSessions } from '../src/clients/session.ts';
import type { OsuInstall } from '../src/clients/detect.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'olp-identity-'));
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);

/* --------------------------------------------------------- what the user pasted */

test('a username, an id or any profile link all resolve to the same thing', () => {
  assert.equal(parseUserQuery('Tangy'), 'Tangy');
  assert.equal(parseUserQuery('  Tangy  '), 'Tangy');
  assert.equal(parseUserQuery('3119700'), '3119700');
  assert.equal(parseUserQuery('https://osu.ppy.sh/users/3119700'), '3119700');
  assert.equal(parseUserQuery('https://osu.ppy.sh/users/Tangy/mania'), 'Tangy');
  assert.equal(parseUserQuery('osu.ppy.sh/u/Tangy'), 'Tangy');
  // osu! usernames allow spaces and brackets.
  assert.equal(parseUserQuery('[ Cookiezi ]'), '[ Cookiezi ]');
});

test('nonsense is rejected rather than fetched', () => {
  for (const bad of ['', '   ', null, undefined, 'me@example.com', 'https://example.com/x']) {
    assert.equal(parseUserQuery(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // Long enough to be a sentence rather than a username.
  assert.equal(parseUserQuery('x'.repeat(40)), null);
});

/* --------------------------------------------------------------- stored images */

test('an image round-trips and is found again', () => {
  const dir = tempDir();
  try {
    assert.equal(findImage(dir, 1, 'avatar'), null);
    saveImage(dir, 1, 'avatar', PNG, '.png');
    assert.ok(findImage(dir, 1, 'avatar')?.endsWith('profile-1-avatar.png'));
    assert.deepEqual(imageState(dir, 1), { hasAvatar: true, hasCover: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Two profiles are two identities. Sharing one picture between them would defeat the point
 * of tracking more than one playstyle.
 */
test('images belong to a profile, not to the install', () => {
  const dir = tempDir();
  try {
    saveImage(dir, 1, 'avatar', PNG, '.png');
    assert.equal(findImage(dir, 2, 'avatar'), null);

    saveImage(dir, 2, 'avatar', JPEG, '.jpg');
    assert.ok(findImage(dir, 1, 'avatar')?.endsWith('profile-1-avatar.png'));
    assert.ok(findImage(dir, 2, 'avatar')?.endsWith('profile-2-avatar.jpg'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* Two files for one profile would leave the lookup order deciding which one wins. */
test('replacing an image with a different format leaves only one file', () => {
  const dir = tempDir();
  try {
    saveImage(dir, 1, 'avatar', PNG, '.png');
    saveImage(dir, 1, 'avatar', JPEG, '.jpg');

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('profile-1-avatar'));
    assert.deepEqual(files, ['profile-1-avatar.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing an image returns the profile to its generated one', () => {
  const dir = tempDir();
  try {
    saveImage(dir, 1, 'cover', PNG, '.png');
    clearImage(dir, 1, 'cover');
    assert.equal(findImage(dir, 1, 'cover'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * `data/avatar.png` predates per-profile identity. Anyone who set one up by hand should
 * keep it, and clearing one profile's own picture must not delete a file shared by all.
 */
test('a hand-placed data/avatar.png still works, and is never deleted', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'avatar.png'), PNG);
    assert.ok(findImage(dir, 1, 'avatar')?.endsWith('avatar.png'));
    assert.ok(findImage(dir, 7, 'avatar')?.endsWith('avatar.png'));

    // A profile's own picture wins over it...
    saveImage(dir, 1, 'avatar', JPEG, '.jpg');
    assert.ok(findImage(dir, 1, 'avatar')?.endsWith('profile-1-avatar.jpg'));

    // ...and removing that falls back rather than leaving nothing.
    clearImage(dir, 1, 'avatar');
    assert.ok(findImage(dir, 1, 'avatar')?.endsWith('avatar.png'));
    assert.equal(fs.existsSync(path.join(dir, 'avatar.png')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* The browser's content-type is whatever the page chose to send. It is not evidence. */
test('uploads are sniffed, not trusted', () => {
  assert.equal(sniffImage(PNG), '.png');
  assert.equal(sniffImage(JPEG), '.jpg');
  assert.equal(
    sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    '.webp',
  );
  assert.equal(sniffImage(Buffer.from('GIF89a______')), '.gif');

  assert.equal(sniffImage(Buffer.from('<html>not an image at all</html>')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('an unsupported extension is refused rather than written', () => {
  const dir = tempDir();
  try {
    assert.throws(() => saveImage(dir, 1, 'avatar', PNG, '.exe'), /unsupported/);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- the local osu! session */

function install(kind: 'lazer' | 'stable', root: string): OsuInstall {
  return { kind, root, replayDir: root, beatmapRoots: [], onlineDb: null };
}

test('lazer reports the name it is signed in as', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'game.ini'),
      '# osu!\nVolume = 80\nUsername = Tangy\nSaveUsername = True\n',
    );
    assert.deepEqual(detectLocalSessions([install('lazer', dir)]), [
      { client: 'lazer', username: 'Tangy' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* stable names the file after the Windows user, which is not knowable from here. */
test('stable is found by the shape of its config filename', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'osu!.awild.cfg'), 'Username = Tangy\r\nOffset = 0\r\n');
    assert.deepEqual(detectLocalSessions([install('stable', dir)]), [
      { client: 'stable', username: 'Tangy' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an osu! that has never been signed in suggests nothing', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'game.ini'), 'Volume = 80\nUsername = \n');
    assert.deepEqual(detectLocalSessions([install('lazer', dir)]), []);
    // And a missing config is not an error either.
    assert.deepEqual(detectLocalSessions([install('lazer', path.join(dir, 'nope'))]), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
