import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { OfficialCalculator } from '../src/calc/official.ts';
import {
  checkOsuSource,
  projectXml,
  prune,
  readSourceHelper,
  SOURCE_PROJECTS,
  sourceVersion,
} from '../src/calc/source-helper.ts';
import { ppSourceService, startupCalculator } from '../src/pp-source.ts';
import { Tracker } from '../src/tracker/index.ts';
import { recalculatedFor } from '../src/tracker/recompute.ts';

/*
 * Pricing with the player's own osu! source (roadmap 5.70). What can be checked without
 * building osu!: which folders are a source, how a source's version is named, the project the
 * helper is built from, and that nothing ever falls back to the release in its place. The build
 * itself is checked by hand against a real clone -- see docs/roadmap.md 5.70.
 */

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A folder laid out like a clone of ppy/osu, as far as the projects go. */
function fakeSource(): string {
  const dir = tmp('olp-osu-source-');
  for (const p of SOURCE_PROJECTS) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), '<Project />\n');
  }
  return dir;
}

const hasGit = spawnSync('git', ['--version']).status === 0;
const git = (dir: string, ...args: string[]) => {
  const run = spawnSync('git', ['-C', dir, ...args]);
  assert.equal(run.status, 0, run.stderr.toString());
};

test('a clone of ppy/osu is a source; its data folder, or anything else, is not', () => {
  const source = fakeSource();
  const data = tmp('olp-osu-data-');
  try {
    assert.equal(checkOsuSource(source), null);
    assert.match(checkOsuSource(path.join(source, 'nowhere')) ?? '', /does not exist/);

    // What %APPDATA%\osu-development holds: settings and replays, not code.
    fs.mkdirSync(path.join(data, 'files'));
    fs.writeFileSync(path.join(data, 'game.dev.ini'), '');
    assert.match(checkOsuSource(data) ?? '', /where osu! keeps its data/);

    fs.rmSync(path.join(source, SOURCE_PROJECTS[2]));
    assert.match(checkOsuSource(source) ?? '', /no osu\.Game\.Rulesets\.Taiko/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a source is named by its commit, and by its changes whenever it has any', (t) => {
  if (!hasGit) return t.skip('git is not installed');
  const dir = tmp('olp-osu-git-');
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'Performance.cs'), 'return pp;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'bin/\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');

    const clean = sourceVersion(dir);
    assert.match(clean, /^source [0-9a-f]{7}$/);

    // A build's output is ignored, so building does not change what the source is.
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'osu.Game.dll'), 'binary');
    assert.equal(sourceVersion(dir), clean);

    // An uncommitted change to the formula is a different formula, and says so.
    fs.writeFileSync(path.join(dir, 'Performance.cs'), 'return pp * 2;\n');
    const edited = sourceVersion(dir);
    assert.match(edited, new RegExp(`^${clean}\\+[0-9a-f]{7}$`));
    assert.equal(sourceVersion(dir), edited, 'the same edit is the same label');

    fs.writeFileSync(path.join(dir, 'Performance.cs'), 'return pp * 3;\n');
    assert.notEqual(sourceVersion(dir), edited);

    // A new file -- a mod of the player's own -- counts too.
    fs.writeFileSync(path.join(dir, 'Performance.cs'), 'return pp;\n');
    assert.equal(sourceVersion(dir), clean);
    fs.writeFileSync(path.join(dir, 'MyMod.cs'), 'class MyMod {}\n');
    assert.notEqual(sourceVersion(dir), clean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the helper is this app's own, with osu!'s packages swapped for the source's projects", () => {
  const source = path.resolve('/somewhere/osu');
  const xml = projectXml(source);
  for (const p of SOURCE_PROJECTS) {
    assert.ok(xml.includes(`<ProjectReference Include="${path.resolve(source, p)}" />`), p);
  }
  assert.ok(!xml.includes('PackageReference'), 'no released osu! package in it');
  assert.ok(xml.includes('<AssemblyName>osu-pp</AssemblyName>'));
  assert.ok(xml.includes('<TargetFramework>net10.0</TargetFramework>'));
});

test('a build from source is pruned as the shipped helper is: nothing it needs, nothing it does not', () => {
  const dir = tmp('olp-pp-prune-');
  try {
    const kept = ['osu-pp.dll', 'osu.Game.dll', 'osu.Framework.dll', 'ppy.ManagedBass.dll', 'SDL2-CS.dll', 'realm-wrappers.dll'];
    const dropped = ['osu.Game.Resources.dll', 'bass.dll', 'libbass.so', 'avcodec-61.dll', 'SDL3.dll', 'osu.Game.pdb'];
    for (const f of [...kept, ...dropped]) fs.writeFileSync(path.join(dir, f), '');
    // One folder per language, beside osu!'s resources.
    fs.mkdirSync(path.join(dir, 'de'));
    fs.writeFileSync(path.join(dir, 'de', 'osu.Game.Resources.resources.dll'), '');

    prune(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...kept].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with a source chosen and nothing built from it, a launch prices nothing -- never the release', async () => {
  const data = tmp('olp-pp-data-');
  try {
    assert.equal(readSourceHelper(data), null);
    const { calculator, problem } = await startupCalculator('C:/somewhere/osu', data);
    assert.equal(calculator, null);
    assert.match(problem ?? '', /no calculator has been built/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a named helper takes the name it is given, and one that fails is not replaced by another', async () => {
  // Answers as a build from source does: ready, and osu!'s placeholder version.
  const fake = {
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({ ready: true, version: "0.0.0" })); process.stdin.resume();'],
  };
  const named = await OfficialCalculator.create(fake, 'source abc1234');
  assert.ok(named);
  assert.equal(named.version, 'source abc1234');
  named.dispose();

  const broken = { command: process.execPath, args: ['-e', 'process.exit(1)'] };
  assert.equal(await OfficialCalculator.create(broken, 'source abc1234'), null);
});

function trackerHarness() {
  const dir = tmp('olp-pp-switch-');
  const db = openDb(path.join(dir, 'test.db'));
  const profileId = getOrCreateProfile(db, 'Test');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [],
    profileId,
    trackingSince: Date.now(),
    official: null,
  });
  return { db, tracker, dir, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Enough of a calculator to be swapped in: a version, and whether it was stopped. */
function stubCalculator(version: string) {
  const stub = { version, disposed: false, dispose() { stub.disposed = true; } };
  return stub as typeof stub & OfficialCalculator;
}

test('switching calculators swaps between plays, stops the old one, and is recorded as done', async () => {
  const h = trackerHarness();
  try {
    const release = stubCalculator('2026.916.0');
    await h.tracker.switchCalculator(release);
    const source = stubCalculator('source abc1234');
    await h.tracker.switchCalculator(source);

    assert.equal(h.tracker.calculatorVersion, 'source abc1234');
    assert.equal(release.disposed, true);
    assert.equal(source.disposed, false);
    // So the next launch does not recalculate everything again.
    assert.equal(recalculatedFor(h.db), 'source abc1234');
  } finally {
    h.cleanup();
  }
});

test('a switch that cannot happen changes nothing: not the calculator, not config.json', async () => {
  const h = trackerHarness();
  const data = tmp('olp-pp-data-');
  const notASource = tmp('olp-not-osu-');
  try {
    let saved: string | null = null;
    let switched = 0;
    const service = ppSourceService({
      tracker: {
        calculatorVersion: '2026.916.0',
        recalculating: false,
        switchCalculator: async () => {
          switched++;
          return { considered: 0, updated: 0, skipped: 0, gainedPp: 0 };
        },
      },
      dataDir: data,
      program: 'Program.cs',
      getSource: () => '',
      setSource: (s) => {
        saved = s;
      },
    });

    const state = await service.use(notASource);
    assert.match(state.error ?? '', /not a clone of ppy\/osu/);
    assert.equal(state.source, '');
    assert.equal(saved, null);
    assert.equal(switched, 0);
    assert.equal(service.state().building, null);
  } finally {
    h.cleanup();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(notASource, { recursive: true, force: true });
  }
});

test('nothing switches while scores are being recalculated', async () => {
  const data = tmp('olp-pp-data-');
  try {
    const service = ppSourceService({
      tracker: {
        calculatorVersion: 'source abc1234',
        recalculating: true,
        switchCalculator: async () => assert.fail('must not switch'),
      },
      dataDir: data,
      program: 'Program.cs',
      getSource: () => 'C:/somewhere/osu',
      setSource: () => assert.fail('must not save'),
    });
    assert.match((await service.useRelease()).error ?? '', /being recalculated/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
