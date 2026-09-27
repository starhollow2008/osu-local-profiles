import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Release } from '../src/update/github.ts';
import { notesAssetName, pruneUpdateLeftovers, stageFromParts } from '../src/update/index.ts';
import {
  manifestAssetName,
  parseManifest,
  partAssetName,
  partOf,
  planParts,
  type ManifestFile,
  type PartName,
  type PartsManifest,
} from '../src/update/parts.ts';
import { notesAssetName as scriptNotesAssetName } from '../scripts/release-notes.mjs';
import { appVersion } from '../src/config.ts';

/*
 * An update in parts (roadmap 5.66): a release is also published as its app, runtime, pp helper
 * and launcher, with a manifest of every file's SHA-256, and an install downloads only the parts
 * it does not already hold byte for byte. The staged tree must still be the whole release.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olp-parts-'));
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A zip of stored entries: enough for the updater's reader, with nothing to go wrong in it. */
function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(file.data.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + file.data.length;
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

function manifestOf(files: Record<string, string>, version = '1.27.0', rid = 'win-x64'): PartsManifest {
  const list: ManifestFile[] = Object.entries(files).map(([p, data]) => ({
    path: p,
    sha256: sha(data),
    size: Buffer.byteLength(data),
    part: partOf(p, 'win32'),
  }));
  const parts: PartsManifest['parts'] = {};
  for (const f of list) parts[f.part] = { asset: partAssetName(version, rid, f.part), size: 100 };
  return { version, rid, parts, files: list };
}

test('each file of a package belongs to the part the packager zips it into', () => {
  assert.equal(partOf('node.exe', 'win32'), 'runtime');
  assert.equal(partOf('node', 'linux'), 'runtime');
  assert.equal(partOf('tools/pp/osu-pp.dll', 'win32'), 'pp');
  assert.equal(partOf('osu! local profiles.exe', 'win32'), 'launcher');
  assert.equal(partOf('osu! local profiles.app/Contents/MacOS/osu-local-profiles', 'darwin'), 'launcher');
  assert.equal(partOf('osu-local-profiles', 'linux'), 'launcher');
  assert.equal(partOf('src/main.ts', 'win32'), 'app');
  assert.equal(partOf('package.json', 'darwin'), 'app');
  assert.equal(partAssetName('1.27.0', 'win-x64', 'app'), 'osu-local-profiles-1.27.0-win-x64-app.zip');
  assert.equal(manifestAssetName('1.27.0', 'win-x64'), 'osu-local-profiles-1.27.0-win-x64-manifest.json');
});

test('the notes asset is named the same by the release job and the app', () => {
  assert.equal(notesAssetName('1.27.0'), scriptNotesAssetName('1.27.0'));
});

test('a manifest is checked before anything in it is trusted', () => {
  const good = manifestOf({ 'package.json': '{}', 'node.exe': 'rt' });
  assert.doesNotThrow(() => parseManifest(good, '1.27.0', 'win-x64'));
  assert.throws(() => parseManifest(good, '1.28.0', 'win-x64'), /not 1\.28\.0/);
  assert.throws(() => parseManifest(good, '1.27.0', 'osx-arm64'), /not 1\.27\.0 osx-arm64/);
  // Nothing outside the install, and nothing in data/, which the swap steps around.
  for (const bad of ['../evil', 'src/../../evil', '/etc/passwd', 'C:/Windows/x', 'data/profile.db']) {
    const m = { ...good, files: [{ ...good.files[0]!, path: bad }] };
    assert.throws(() => parseManifest(m, '1.27.0', 'win-x64'), /not a file of the app/, bad);
  }
  const noHash = { ...good, files: [{ ...good.files[0]!, sha256: 'abc' }] };
  assert.throws(() => parseManifest(noHash, '1.27.0', 'win-x64'), /not a file of the app/);
});

test('only the parts with a changed or missing file are downloaded', () => {
  const release: Record<string, string> = {
    'package.json': '{"version":"1.27.0"}',
    'src/main.ts': 'new',
    'node.exe': 'rt',
    'tools/pp/pp.dll': 'pp',
  };
  const here: Record<string, string> = { ...release, 'package.json': '{"version":"1.26.0"}', 'src/main.ts': 'old' };
  const manifest = manifestOf(release);
  const plan = planParts(manifest, (p) => (p in here ? sha(here[p]!) : null));
  assert.deepEqual(plan.download, ['app']);
  assert.deepEqual(plan.reuse.map((f) => f.path).sort(), ['node.exe', 'tools/pp/pp.dll']);
  assert.equal(plan.bytes, 100);

  // A runtime bump downloads that part too; a file gone from this install counts as changed.
  const bumped = planParts(manifest, (p) => (p === 'node.exe' ? null : sha(release[p]!)));
  assert.deepEqual(bumped.download, ['runtime']);
});

/** A release served from a local server: its manifest and its parts. */
async function serveRelease(
  version: string,
  files: Record<string, string>,
  corrupt: PartName[] = [],
): Promise<{ release: Release; requested: string[]; close: () => Promise<void> }> {
  const rid = 'win-x64';
  const manifest = manifestOf(files, version, rid);
  const bodies = new Map<string, Buffer>();
  for (const part of Object.keys(manifest.parts) as PartName[]) {
    const zip = storedZip(
      manifest.files
        .filter((f) => f.part === part)
        .map((f) => ({
          name: `osu-local-profiles-${version}-${rid}/${f.path}`,
          data: Buffer.from(corrupt.includes(part) ? `${files[f.path]}!` : files[f.path]!),
        })),
    );
    bodies.set(partAssetName(version, rid, part), zip);
    manifest.parts[part] = { asset: partAssetName(version, rid, part), size: zip.length };
  }
  bodies.set(manifestAssetName(version, rid), Buffer.from(JSON.stringify(manifest)));

  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').slice(1));
    requested.push(name);
    const body = bodies.get(name);
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const release: Release = {
    version,
    releaseUrl: 'https://example.invalid',
    body: '',
    publishedAt: null,
    assets: [...bodies].map(([name, body]) => ({ name, url: `http://127.0.0.1:${port}/${name}`, size: body.length })),
  };
  return { release, requested, close: () => new Promise((r) => server.close(() => r())) };
}

function installWith(dir: string, files: Record<string, string>): void {
  for (const [p, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), data);
  }
}

test('an update in parts downloads what changed and copies the rest from the install', async () => {
  const dir = tmp();
  const install = path.join(dir, 'install');
  const oldFiles: Record<string, string> = {
    'package.json': '{"version":"1.26.0"}',
    'src/main.ts': 'old app',
    'node.exe': 'the runtime',
    'tools/pp/osu-pp.dll': 'the pp helper',
    'osu! local profiles.exe': 'the launcher',
  };
  installWith(install, oldFiles);
  const newFiles = { ...oldFiles, 'package.json': '{"version":"1.27.0"}', 'src/main.ts': 'new app', 'src/added.ts': 'x' };
  const served = await serveRelease('1.27.0', newFiles);
  try {
    const staged = path.join(dir, 'staged');
    const bytes = await stageFromParts(served.release, staged, dir, install, 'win32', 'x64');
    // The manifest and the app part; not the runtime, the pp helper or the launcher.
    assert.deepEqual(served.requested.sort(), [
      'osu-local-profiles-1.27.0-win-x64-app.zip',
      'osu-local-profiles-1.27.0-win-x64-manifest.json',
    ]);
    assert.ok(bytes > 0);
    for (const [p, data] of Object.entries(newFiles)) {
      assert.equal(fs.readFileSync(path.join(staged, p), 'utf8'), data, p);
    }
    // The part's zip does not linger beside the staged tree.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['install', 'staged']);
  } finally {
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a part that does not come out as the manifest says is refused, for the full zip instead', async () => {
  const dir = tmp();
  const install = path.join(dir, 'install');
  fs.mkdirSync(install, { recursive: true });
  const served = await serveRelease('1.27.0', { 'package.json': '{"version":"1.27.0"}', 'node.exe': 'rt' }, ['app']);
  try {
    await assert.rejects(
      stageFromParts(served.release, path.join(dir, 'staged'), dir, install, 'win32', 'x64'),
      /did not come out as the release has it/,
    );
  } finally {
    await served.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a release from before parts has no manifest, and says so', async () => {
  const release: Release = { version: '1.26.0', releaseUrl: '', body: '', publishedAt: null, assets: [] };
  await assert.rejects(stageFromParts(release, tmp(), tmp()), /not published in parts/);
});

test('a build downloaded ahead of time survives the startup sweep while it is still newer', () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  const ahead = '999.0.0';
  installWith(path.join(data, 'update'), {
    [`${ahead}/package.json`]: `{"version":"${ahead}"}`,
    'ready.json': JSON.stringify({ version: ahead, requested: 'auto', attempts: 0 }),
    '1.0.0/package.json': '{"version":"1.0.0"}',
    'osu-local-profiles-1.0.0-win-x64.zip': 'an old download',
  });

  const result = pruneUpdateLeftovers(dir, data);
  assert.ok(fs.existsSync(path.join(data, 'update', ahead, 'package.json')), 'the waiting build is kept');
  assert.ok(fs.existsSync(path.join(data, 'update', 'ready.json')));
  assert.equal(fs.existsSync(path.join(data, 'update', '1.0.0')), false);
  assert.equal(fs.existsSync(path.join(data, 'update', 'osu-local-profiles-1.0.0-win-x64.zip')), false);
  assert.equal(result.removed.length, 2);

  // Once what waits is this version (or older), it is a leftover like any other.
  fs.writeFileSync(
    path.join(data, 'update', 'ready.json'),
    JSON.stringify({ version: appVersion(), requested: 'auto', attempts: 0 }),
  );
  pruneUpdateLeftovers(dir, data);
  assert.equal(fs.existsSync(path.join(data, 'update')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
