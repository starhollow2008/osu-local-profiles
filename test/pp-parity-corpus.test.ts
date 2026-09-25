import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCorpus } from '../scripts/pp-parity-corpus.mjs';
import { beatmapMode } from '../src/clients/beatmaps.ts';
import { parseReplay } from '../src/osr.ts';

/*
 * The plays the pp parity check runs on (roadmap 5.60). What the check proves depends on them
 * reaching every ruleset and both replay formats, and on being the same wherever it runs, so
 * those are pinned here -- without a helper, so this costs milliseconds. Whether osu! can read
 * them is `pp-parity.mjs --errors`' job: only its `error:` requests may fail.
 */

function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-corpus-'));
  return { dir, corpus: generateCorpus(dir) };
}

test('the corpus is the same on every run, byte for byte', (t) => {
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

test('it has beatmaps of every ruleset, each filed under the ruleset it is', (t) => {
  const { dir, corpus } = generate();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const ruleset of [0, 1, 2, 3] as const) {
    assert.ok(corpus.maps[ruleset].length > 0, `no ruleset ${ruleset} beatmaps`);
    for (const map of corpus.maps[ruleset]) assert.equal(beatmapMode(map.file), ruleset);
  }
});

test('it has lazer replays in every ruleset, McOsu plays, and each on its own beatmap', async (t) => {
  const { dir, corpus } = generate();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md5s = new Map(Object.values(corpus.maps).flat().map((m) => [m.file, m.md5]));
  const clients = new Set<string>();
  const lazerRulesets = new Set<number>();
  for (const { file, beatmap } of corpus.replays) {
    const replay = await parseReplay(fs.readFileSync(file));
    assert.equal(replay.beatmapMD5, md5s.get(beatmap), `${path.basename(file)} is on the wrong beatmap`);
    clients.add(replay.client);
    if (replay.client === 'lazer') {
      // The LZMA block lazer appends is read back, mods and statistics included.
      assert.ok(replay.extras?.statistics, `${path.basename(file)} lost its lazer block`);
      lazerRulesets.add(replay.mode);
    }
  }
  assert.deepEqual([...clients].sort(), ['lazer', 'mcosu']);
  assert.deepEqual([...lazerRulesets].sort(), [0, 1, 2, 3]);
});
