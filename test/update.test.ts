import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  assetFor,
  assetNameFor,
  compareVersions,
  parseRepo,
  type Release,
} from '../src/update/github.ts';
import { extractZip, readZipEntries } from '../src/update/zip.ts';
import { blockedReason, pruneUpdateLeftovers } from '../src/update/index.ts';

/*
 * The update path replaces the app's own files, so the parts of it that can be checked
 * without one have to be. Everything here is a pure function or a temp directory: what is
 * left untested is the swap itself, which needs two real installs and a process exit.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olp-update-'));

/* ------------------------------------------------------------------ github */

test('a GitHub remote is recognised in either form', () => {
  assert.equal(parseRepo('https://github.com/a/b.git'), 'a/b');
  assert.equal(parseRepo('https://github.com/a/b'), 'a/b');
  assert.equal(parseRepo('git@github.com:a/b.git'), 'a/b');
});

test('a remote that is not GitHub has no release to check', () => {
  assert.equal(parseRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseRepo(undefined), null);
  assert.equal(parseRepo(42), null);
});

test('versions compare by number, not by string', () => {
  // The one that a lexical compare gets wrong, and the reason this is not `a < b`.
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('a pre-release is older than the release it leads to', () => {
  // Otherwise a build on a beta tag would refuse the real release that followed it.
  assert.equal(compareVersions('1.3.0-beta.1', '1.3.0'), -1);
  assert.equal(compareVersions('1.3.0', '1.3.0-beta.1'), 1);
  assert.equal(compareVersions('1.3.0-beta.1', '1.3.0-beta.2'), -1);
});

test('each platform looks for the archive the packager would have named', () => {
  assert.equal(assetNameFor('1.5.0', 'win32', 'x64'), 'osu-local-profiles-1.5.0-win-x64.zip');
  assert.equal(assetNameFor('1.5.0', 'darwin', 'arm64'), 'osu-local-profiles-1.5.0-osx-arm64.zip');
  assert.equal(assetNameFor('1.5.0', 'linux', 'x64'), 'osu-local-profiles-1.5.0-linux-x64.zip');
});

test('a release with no build for this platform offers nothing', () => {
  const release: Release = {
    version: '1.5.0',
    releaseUrl: 'https://example.invalid',
    assets: [{ name: 'osu-local-profiles-1.5.0-win-x64.zip', url: 'https://example.invalid', size: 1 }],
  };
  assert.equal(assetFor(release, 'win32', 'x64')?.name, 'osu-local-profiles-1.5.0-win-x64.zip');
  // A macOS user must not be handed a Windows build because it was the only asset there.
  assert.equal(assetFor(release, 'darwin', 'arm64'), null);
});

/* --------------------------------------------------------------------- zip */

/** Build a zip in memory, so the reader is tested against bytes rather than a fixture. */
function makeZip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const body = file.store === true ? file.data : zlib.deflateRawSync(file.data);
    const method = file.store === true ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);

  return Buffer.concat([localBytes, centralBytes, eocd]);
}

test('a zip round-trips through the reader', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(
    file,
    makeZip([
      { name: 'root/package.json', data: Buffer.from('{"version":"1.3.0"}') },
      { name: 'root/src/main.ts', data: Buffer.from('console.log(1)') },
      { name: 'root/stored.txt', data: Buffer.from('not compressed'), store: true },
    ]),
  );

  const written = extractZip(file, path.join(dir, 'out'), 1);
  assert.equal(written, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'package.json'), 'utf8'), '{"version":"1.3.0"}');
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'src', 'main.ts'), 'utf8'), 'console.log(1)');
  // Stored entries are copied rather than inflated, and must survive that path too.
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'stored.txt'), 'utf8'), 'not compressed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backslash separators are read as separators', () => {
  // Not hypothetical: this project's own packager writes them, so a release archive says
  // `osu-local-profiles-1.5.0-win-x64\node.exe`. Read literally that is one long filename.
  const dir = tmp();
  const file = path.join(dir, 'a.zip');
  fs.writeFileSync(file, makeZip([{ name: 'root\\web\\index.html', data: Buffer.from('hi') }]));

  extractZip(file, path.join(dir, 'out'), 1);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'web', 'index.html'), 'utf8'), 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an entry that points outside the target is refused', () => {
  // This runs on a file downloaded over the network, so it is a security check: an archive
  // naming `..\..\Windows\...` would otherwise be written exactly where it asked.
  const dir = tmp();
  const file = path.join(dir, 'evil.zip');
  fs.writeFileSync(file, makeZip([{ name: '../escaped.txt', data: Buffer.from('no') }]));

  assert.throws(() => readZipEntries(fs.readFileSync(file)), /unsafe path/);
  assert.equal(fs.existsSync(path.join(dir, 'escaped.txt')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that is not a zip is rejected rather than half-read', () => {
  const dir = tmp();
  const file = path.join(dir, 'nope.zip');
  fs.writeFileSync(file, Buffer.from('this is not an archive'));
  assert.throws(() => extractZip(file, path.join(dir, 'out')), /not a zip file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- eligibility */

test('a source checkout refuses to update itself', () => {
  // start.bat runs `node src/main.ts` from the repository. An "update" there would
  // overwrite a working tree with a release zip.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  assert.match(blockedReason(dir, 'win32') ?? '', /source checkout/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a directory with no bundled runtime is not a packaged build', () => {
  const dir = tmp();
  assert.match(blockedReason(dir, 'win32') ?? '', /not a packaged build/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a packaged build can be updated', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  assert.equal(blockedReason(dir, 'win32'), null);
  // The same layout on Linux looks for `node`, not `node.exe`.
  assert.match(blockedReason(dir, 'linux') ?? '', /not a packaged build/);
  fs.writeFileSync(path.join(dir, 'node'), '');
  assert.equal(blockedReason(dir, 'linux'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------- leftovers */

test('startup clears both things an update leaves behind', () => {
  /*
   * Each is a whole copy of the app, around 200MB. The rollback is visible beside the app;
   * the staged tree hides inside data/, where it reads as user data. One real update left
   * 406MB of them behind before this existed.
   */
  const dir = tmp();
  const data = path.join(dir, 'data');
  fs.mkdirSync(path.join(dir, '.rollback-2026-01-01T00-00-00'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rollback-2026-01-01T00-00-00', 'node.exe'), 'old runtime');
  fs.mkdirSync(path.join(data, 'update', '1.4.0'), { recursive: true });
  fs.writeFileSync(path.join(data, 'update', '1.4.0', 'node.exe'), 'staged runtime');
  fs.writeFileSync(path.join(data, 'profiles.db'), 'PRECIOUS');
  fs.writeFileSync(path.join(data, 'update.log'), 'OK: updated to 1.4.0');

  const result = pruneUpdateLeftovers(dir, data);

  assert.equal(fs.existsSync(path.join(dir, '.rollback-2026-01-01T00-00-00')), false);
  assert.equal(fs.existsSync(path.join(data, 'update')), false);
  assert.equal(result.removed.length, 2);
  assert.ok(result.bytes > 0);

  // The database is the whole point of stepping around data/, and update.log is the record
  // of what the update did -- neither is a leftover.
  assert.equal(fs.readFileSync(path.join(data, 'profiles.db'), 'utf8'), 'PRECIOUS');
  assert.equal(fs.readFileSync(path.join(data, 'update.log'), 'utf8'), 'OK: updated to 1.4.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a clean install has nothing to clear and says so', () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const result = pruneUpdateLeftovers(dir, data);
  assert.deepEqual(result.removed, []);
  assert.equal(result.bytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing install directory is not a startup failure', () => {
  // This runs before anything else at startup; it must never be the reason the app dies.
  const result = pruneUpdateLeftovers(path.join(tmp(), 'gone'), path.join(tmp(), 'gone'));
  assert.deepEqual(result.removed, []);
});
