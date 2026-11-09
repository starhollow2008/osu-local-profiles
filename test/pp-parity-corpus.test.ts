import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../scripts/pp-parity-corpus.mjs';
import { canBuildApp, devApp, writeList } from '../scripts/dev-app.mjs';

/*
 * The plays the pp parity check runs on (roadmap 5.60). What the check proves depends on them
 * reaching every ruleset and both replay formats, and on being the same wherever it runs, so
 * those are pinned here -- without a helper. The McOsu plays are built, and every replay read
 * back, by the app's own code (`--dev`), so this needs the .NET SDK. Whether osu! can read them
 * is `pp-parity.mjs --errors`' job: only its `error:` requests may fail.
 */

const skip = canBuildApp() ? false : 'needs the .NET SDK to build the app';

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-corpus-'));
  return { dir, corpus: generateCorpus(dir) };
}

/** The `Mode:` in a beatmap's [General] section, which ends at the next line beginning with `[`. */
function generalMode(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const general = /^\[General\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return Number(/^Mode:\s*(\d+)/m.exec(general)?.[1] ?? 0);
}

test('the corpus is the same on every run, byte for byte', { skip }, (t) => {
  const a = generate();
  const b = generate();
  t.after(() => {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  });
  const digest = (files: string[]) =>
    files.map((f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')).join();
  const all = (c: typeof a.corpus) => [...Object.values(c.maps).flat().map((m) => m.file), ...c.replays.map((r) => r.file)];
  assert.equal(digest(all(a.corpus)), digest(all(b.corpus)));
});

test('it has beatmaps of every ruleset, each filed under the ruleset it is', { skip }, (t) => {
  const { dir, corpus } = generate();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const ruleset of [0, 1, 2, 3] as const) {
    assert.ok(corpus.maps[ruleset].length > 0, `no ruleset ${ruleset} beatmaps`);
    for (const map of corpus.maps[ruleset]) assert.equal(generalMode(map.file), ruleset);
  }
});

interface Parsed {
  path: string;
  score?: { beatmapMD5: string; client: string; mode: number; extras?: { statistics?: unknown } | null };
  error?: string;
}

test('it has lazer replays in every ruleset, McOsu plays, and each on its own beatmap', { skip }, (t) => {
  const { dir, corpus } = generate();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md5s = new Map(Object.values(corpus.maps).flat().map((m) => [m.file, m.md5]));
  const beatmapOf = new Map(corpus.replays.map((r) => [r.file, r.beatmap]));
  const list = writeList(path.join(dir, 'replays.txt'), corpus.replays.map((r) => r.file));
  const parsed = devApp('parse-replays', list) as Parsed[];
  assert.equal(parsed.length, corpus.replays.length);
  const clients = new Set<string>();
  const lazerRulesets = new Set<number>();
  for (const { path: file, score, error } of parsed) {
    assert.ok(score, `${path.basename(file)} could not be read: ${error}`);
    assert.equal(score.beatmapMD5, md5s.get(beatmapOf.get(file)!), `${path.basename(file)} is on the wrong beatmap`);
    clients.add(score.client);
    if (score.client === 'lazer') {
      // The LZMA block lazer appends is read back, mods and statistics included.
      assert.ok(score.extras?.statistics, `${path.basename(file)} lost its lazer block`);
      lazerRulesets.add(score.mode);
    }
  }
  assert.deepEqual([...clients].sort(), ['lazer', 'mcosu']);
  assert.deepEqual([...lazerRulesets].sort(), [0, 1, 2, 3]);
});
