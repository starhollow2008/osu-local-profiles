import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getOrCreateProfile, openDb, type Db } from '../src/db/index.ts';
import {
  applyPendingRestore,
  backupFileName,
  createBackup,
  discardRestore,
  hasStagedRestore,
  isProfileFile,
  markRestoreReady,
  stageRestore,
} from '../src/backup.ts';
import { entryData, readZipEntries, writeZip } from '../src/update/zip.ts';
import { folderCommand } from '../src/browser.ts';

/** Every folder these tests made, removed once they have all run. */
const made: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-backup-'));
  made.push(dir);
  return dir;
}

// Without this every run left a folder per test behind -- hundreds, over a project's life.
// A database a test left open keeps its folder on Windows; that one is left rather than failing.
after(() => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* still open */
    }
  }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A data folder as an install has it: a database, pictures, me! images, and install files. */
function install(profiles: Record<string, number>): { dir: string; db: Db } {
  const dir = tempDir();
  const db = openDb(path.join(dir, 'profiles.db'));
  db.prepare(
    `INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator, status, cached_at)
     VALUES ('m1', 11, 7, 'Artist', 'Title', 'Hard', 'Someone', 1, 0)`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO scores
      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
       count300, count100, count50, count_geki, count_katu, count_miss,
       accuracy, max_combo, total_score, passed, grade, stars, played_at)
     VALUES (?, ?, 0, 'm1', 'lazer', '[]', '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1, 1)`,
  );
  for (const [name, scores] of Object.entries(profiles)) {
    const id = getOrCreateProfile(db, name);
    for (let i = 0; i < scores; i += 1) insert.run(id, `${name}-${i}`);
  }
  fs.writeFileSync(path.join(dir, 'profile-1-avatar.png'), PNG);
  fs.mkdirSync(path.join(dir, 'about-images', '1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'about-images', '1', '0123456789abcdef.png'), PNG);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"port":7272}');
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), 'hello');
  return { dir, db };
}

/* ------------------------------------------------------------------ the zip */

test('a written zip reads back byte for byte, compressed or stored', () => {
  const text = Buffer.from('the same line again\n'.repeat(200));
  const zip = writeZip([
    { name: 'profiles.db', data: text },
    { name: 'about-images/1/a.png', data: PNG },
    { name: '夜に駆ける.txt', data: Buffer.from('名前') },
  ]);
  const entries = readZipEntries(zip);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['profiles.db', 'about-images/1/a.png', '夜に駆ける.txt'],
  );
  // Text shrinks, so it is deflated; a short picture would grow, so it is stored as it is.
  assert.equal(entries[0]!.method, 8);
  assert.equal(entries[1]!.method, 0);
  assert.deepEqual(entryData(zip, entries[0]!), text);
  assert.deepEqual(entryData(zip, entries[1]!), PNG);
  assert.equal(entryData(zip, entries[2]!).toString(), '名前');
});

/* ------------------------------------------------------------ what it holds */

test('profile data is the database, the pictures and the me! images, and nothing else', () => {
  for (const name of [
    'profiles.db',
    'profile-1-avatar.png',
    'profile-12-cover.jpeg',
    'avatar.png',
    'cover.jpg',
    'about-images/3/0123456789abcdef.webp',
  ]) {
    assert.equal(isProfileFile(name), true, name);
  }
  for (const name of [
    'config.json',
    'logs/app.log',
    'profiles.db-wal',
    'update/swapper.pid',
    'profile-1-avatar.exe',
    'about-images/../../config.json',
    'about-images/x/a.png',
    '../profiles.db',
  ]) {
    assert.equal(isProfileFile(name), false, name);
  }
});

test('a backup holds every profile and its images, laid out as data/ is, without the install files', () => {
  const { dir, db } = install({ Left: 2, Mouse: 1 });
  try {
    const zip = createBackup(db, dir);
    assert.deepEqual(
      readZipEntries(zip).map((e) => e.name).sort(),
      ['about-images/1/0123456789abcdef.png', 'profile-1-avatar.png', 'profiles.db'],
    );
    // The snapshot is written beside the database and must not be left there.
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('backup-')), []);
  } finally {
    db.close();
  }
});

test('a backup is named for what it is and the day it was made', () => {
  assert.equal(backupFileName(new Date(2026, 8, 3, 23, 59)), 'osu-local-profiles-backup-2026-09-03.zip');
});

/* ---------------------------------------------------------------- restoring */

test('an uploaded backup is checked and described before anything is replaced', () => {
  const from = install({ Left: 2, Mouse: 1 });
  const to = install({ Other: 5 });
  try {
    const summary = stageRestore(to.dir, createBackup(from.db, from.dir));
    assert.deepEqual(summary, {
      profiles: [
        { name: 'Left', plays: 2 },
        { name: 'Mouse', plays: 1 },
      ],
      images: 2,
    });
    assert.equal(hasStagedRestore(to.dir), true);
    // Staged, not applied: the running install's database is untouched.
    assert.equal((to.db.prepare('SELECT name FROM profiles').get() as { name: string }).name, 'Other');
    discardRestore(to.dir);
    assert.equal(hasStagedRestore(to.dir), false);
  } finally {
    from.db.close();
    to.db.close();
  }
});

test('a bare .db from before backups were zips can still be restored', () => {
  const from = install({ Left: 3 });
  const to = tempDir();
  try {
    const snapshot = path.join(from.dir, 'old-backup.db');
    from.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    const summary = stageRestore(to, fs.readFileSync(snapshot));
    assert.deepEqual(summary, { profiles: [{ name: 'Left', plays: 3 }], images: 0 });
  } finally {
    from.db.close();
  }
});

test('anything that is not one of this app\'s backups is refused, and nothing is left staged', () => {
  const to = tempDir();
  const other = path.join(tempDir(), 'other.db');
  const foreign = new DatabaseSync(other);
  foreign.exec('CREATE TABLE notes (text TEXT)');
  foreign.close();

  const cases: [string, Buffer, RegExp][] = [
    ['random bytes', Buffer.from('hello, this is not a backup'), /not a backup/],
    ['another program\'s database', fs.readFileSync(other), /not an osu! local profiles backup/],
    ['a zip with no database', writeZip([{ name: 'profile-1-avatar.png', data: PNG }]), /no profiles\.db/],
    ['a damaged zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), /could not be read/],
  ];
  for (const [what, upload, error] of cases) {
    assert.throws(() => stageRestore(to, upload), error, what);
    assert.equal(hasStagedRestore(to), false, what);
  }
});

test('only profile data comes out of a backup, whatever else the zip holds', () => {
  const from = install({ Left: 1 });
  const to = tempDir();
  try {
    const zip = createBackup(from.db, from.dir);
    const entries = readZipEntries(zip).map((e) => ({ name: e.name, data: entryData(zip, e) }));
    const tampered = writeZip([...entries, { name: 'config.json', data: Buffer.from('{"port":1}') }]);
    stageRestore(to, tampered);
    markRestoreReady(to);
    assert.equal(applyPendingRestore(to).applied, true);
    assert.equal(fs.existsSync(path.join(to, 'config.json')), false);
  } finally {
    from.db.close();
  }
});

test('a backup nobody confirmed is dropped at the next start, not applied', () => {
  const from = install({ Left: 1 });
  const to = install({ Other: 1 });
  try {
    stageRestore(to.dir, createBackup(from.db, from.dir));
    to.db.close();
    assert.deepEqual(applyPendingRestore(to.dir), { applied: false });
    assert.equal(hasStagedRestore(to.dir), false);
    const db = openDb(path.join(to.dir, 'profiles.db'));
    assert.equal((db.prepare('SELECT name FROM profiles').get() as { name: string }).name, 'Other');
    db.close();
  } finally {
    from.db.close();
  }
});

test('a confirmed restore swaps the profiles in and moves what was there aside, deleting nothing', () => {
  const from = install({ Left: 2 });
  fs.rmSync(path.join(from.dir, 'profile-1-avatar.png'));
  const to = install({ Other: 4 });
  fs.writeFileSync(path.join(to.dir, 'profile-1-cover.png'), PNG);
  try {
    stageRestore(to.dir, createBackup(from.db, from.dir));
    markRestoreReady(to.dir);
    to.db.close();

    const result = applyPendingRestore(to.dir, new Date(2026, 8, 23, 20, 5, 9));
    assert.equal(result.applied, true);
    assert.ok(result.applied);
    assert.equal(path.basename(result.aside), 'before-restore-2026-09-23-200509');

    const db = openDb(path.join(to.dir, 'profiles.db'));
    assert.deepEqual(db.prepare('SELECT name FROM profiles').all().map((r) => (r as { name: string }).name), ['Left']);
    db.close();

    // The backup's images are in place, and pictures it did not have are not left behind.
    assert.equal(fs.existsSync(path.join(to.dir, 'about-images', '1', '0123456789abcdef.png')), true);
    assert.equal(fs.existsSync(path.join(to.dir, 'profile-1-avatar.png')), false);
    assert.equal(fs.existsSync(path.join(to.dir, 'profile-1-cover.png')), false);
    // Everything that was there is aside, and the install's own files never moved.
    const aside = fs.readdirSync(result.aside).sort();
    assert.deepEqual(aside, ['about-images', 'profile-1-avatar.png', 'profile-1-cover.png', 'profiles.db']);
    const old = openDb(path.join(result.aside, 'profiles.db'));
    assert.equal((old.prepare('SELECT COUNT(*) AS n FROM scores').get() as { n: number }).n, 4);
    old.close();
    assert.equal(fs.readFileSync(path.join(to.dir, 'config.json'), 'utf8'), '{"port":7272}');
    assert.equal(fs.existsSync(path.join(to.dir, 'logs', 'app.log')), true);
    assert.equal(hasStagedRestore(to.dir), false);
  } finally {
    from.db.close();
  }
});

/* ------------------------------------------------------------ the data folder */

test('the data folder opens in each system\'s own file manager, with the path as one argument', () => {
  const dir = 'C:\\Users\\me\\osu! local profiles\\data';
  assert.deepEqual(
    [folderCommand('win32', dir).command, folderCommand('win32', dir).args],
    ['explorer.exe', [dir]],
  );
  assert.equal(folderCommand('win32', dir).options.windowsVerbatimArguments, undefined);
  assert.deepEqual(folderCommand('darwin', '/a b').args, ['/a b']);
  assert.equal(folderCommand('darwin', '/a b').command, 'open');
  assert.equal(folderCommand('linux', '/a b').command, 'xdg-open');
});
