/**
 * The C# port's parts, each checked against the Node app's own code on this machine's real files
 * (docs/csharp-port.md, phase 4). Where scripts/api-parity.mjs compares the two apps' answers over
 * HTTP, this compares the pieces under them that HTTP cannot reach.
 *
 *   node scripts/port-checks.mjs [data folder] [--only <check>]
 *
 * - `replays`: every replay the database knows of, and every one in osu!stable's Data/r, parsed
 *   by src/osr.ts and by Osr.cs, every field compared.
 * - `discover`: the osu! installs startup would find, from config.json, as discoverInstalls finds
 *   them. The scores, which count days since a file changed, are compared to the minute.
 *
 * Nothing is written to the data folder. Exit 0 when every check agrees, 1 when any differs.
 */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseReplay } from '../src/osr.ts';
import { discoverInstalls } from '../src/clients/discover.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const data = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? path.join(repo, 'data'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-port-checks-'));

/** The C# app, built once, asked one dev command. */
function cs(...command) {
  const exe = path.join(work, 'bin', `osu-local-profiles-app${process.platform === 'win32' ? '.exe' : ''}`);
  if (!fs.existsSync(exe)) {
    const build = spawnSync('dotnet', ['build', path.join(repo, 'dotnet', 'App', 'App.csproj'), '-c', 'Release', '-o', path.dirname(exe), '--nologo', '-v', 'q'], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`the C# build failed: ${build.stdout}`);
  }
  const run = spawnSync(exe, ['--dev', ...command], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`--dev ${command[0]} failed: ${run.stderr}`);
  return run.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let failed = 0;
const result = (name, total, differences) => {
  console.log(`  ${differences.length === 0 ? 'same   ' : 'DIFFERS'}  ${name}: ${total - differences.length} of ${total} agree`);
  for (const d of differences.slice(0, 10)) console.log(`             ${d}`);
  if (differences.length > 0) failed++;
};

const checks = {
  async replays() {
    const db = new DatabaseSync(path.join(data, 'profiles.db'), { readOnly: true });
    const known = db
      .prepare(`SELECT replay_path AS p FROM scores WHERE replay_path IS NOT NULL
                UNION SELECT replay_path FROM declined_plays WHERE replay_path IS NOT NULL`)
      .all()
      .map((r) => r.p);
    db.close();
    const stableFolders = new Set(known.map((p) => path.dirname(p)).filter((d) => /[\\/]Data[\\/]r$/i.test(d)));
    const paths = [...new Set([...known, ...[...stableFolders].flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))])]
      .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    const list = path.join(work, 'replays.txt');
    fs.writeFileSync(list, paths.join('\n'));
    const theirs = new Map(cs('parse-replays', list).map((a) => [a.path, a.error !== undefined ? { error: 'failed' } : { score: a.score }]));
    const differences = [];
    for (const file of paths) {
      let ours;
      try {
        const s = await parseReplay(fs.readFileSync(file));
        ours = { score: JSON.parse(JSON.stringify({ ...s, playedAt: s.playedAt.getTime(), onlineScoreId: s.onlineScoreId?.toString() ?? null })) };
      } catch {
        ours = { error: 'failed' };
      }
      if (!isDeepStrictEqual(ours, theirs.get(file))) differences.push(`${file}: node ${JSON.stringify(ours).slice(0, 200)} | cs ${JSON.stringify(theirs.get(file)).slice(0, 200)}`);
    }
    result('replays', paths.length, differences);
  },

  /*
   * The beatmap index built from nothing by both, every row compared; then every beatmap the
   * profiles have played resolved by both against it, the answers and the rows they cache
   * compared. Slow: it reads every file in osu!'s folders once each, twice.
   */
  async index() {
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const { installs } = await discoverInstalls({ configured: config.installRoots ?? [], remembered: config.discoveredRoots ?? [], noSearch: true });
    const roots = installs
      .flatMap((i) => i.beatmapRoots.map((p) => ({ path: p, byExtension: i.kind !== 'lazer' })))
      .filter((r, n, all) => all.findIndex((o) => path.resolve(o.path).toLowerCase() === path.resolve(r.path).toLowerCase()) === n);
    const { openDb } = await import('../src/db/index.ts');
    const { indexBeatmapFiles, BeatmapResolver } = await import('../src/clients/beatmaps.ts');
    const nodeDb = openDb(path.join(work, 'node.db'));
    const csFile = path.join(work, 'cs.db');
    const rootsFile = path.join(work, 'roots.json');
    fs.writeFileSync(rootsFile, JSON.stringify(roots));
    await indexBeatmapFiles(nodeDb, roots);
    cs('index-beatmaps', csFile, rootsFile);

    const csDb = new DatabaseSync(csFile);
    const table = (db, sql) => new Map(db.prepare(sql).all().map((r) => [r.path, JSON.stringify(r)]));
    const differences = [];
    for (const [name, sql] of [
      ['osu_files', 'SELECT path, md5, beatmap_id, name, size FROM osu_files'],
      ['not_beatmaps', 'SELECT path, size FROM not_beatmaps'],
    ]) {
      const [a, b] = [table(nodeDb, sql), table(csDb, sql)];
      for (const key of new Set([...a.keys(), ...b.keys()])) {
        if (a.get(key) !== b.get(key)) differences.push(`${name} ${key}: node ${a.get(key) ?? 'missing'} | cs ${b.get(key) ?? 'missing'}`);
      }
      console.log(`           ${name}: ${a.size} rows (node), ${b.size} rows (cs)`);
    }
    result('index', 2, differences);
    csDb.close();
    nodeDb.close();
  },

  /*
   * Every beatmap the profiles have played, resolved by both against a copy of this machine's
   * index and lazer's online.db; the answers, and the rows each caches, compared.
   */
  async resolve() {
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const { installs } = await discoverInstalls({ configured: config.installRoots ?? [], remembered: config.discoveredRoots ?? [], noSearch: true });
    const { openDb } = await import('../src/db/index.ts');
    const { BeatmapResolver } = await import('../src/clients/beatmaps.ts');
    const real = path.join(data, 'profiles.db');
    const fresh = (file) => {
      const db = openDb(file);
      db.exec(`ATTACH DATABASE '${real.replaceAll("'", "''")}' AS real`);
      db.exec('INSERT INTO osu_files SELECT * FROM real.osu_files');
      db.exec('DETACH DATABASE real');
      return db;
    };
    const nodeDb = fresh(path.join(work, 'resolve-node.db'));
    const csFile = path.join(work, 'resolve-cs.db');
    fresh(csFile).close();

    const source = new DatabaseSync(real, { readOnly: true });
    const md5s = source.prepare('SELECT md5 FROM beatmaps ORDER BY md5').all().map((r) => r.md5);
    source.close();
    const md5File = path.join(work, 'md5s.txt');
    fs.writeFileSync(md5File, md5s.join('\n'));
    const installsFile = path.join(work, 'installs.json');
    fs.writeFileSync(installsFile, JSON.stringify(installs));

    const resolver = new BeatmapResolver(nodeDb, installs);
    const ours = md5s.map((m) => JSON.parse(JSON.stringify(resolver.resolve(m))));
    const theirs = cs('resolve', csFile, installsFile, md5File);
    const differences = [];
    md5s.forEach((m, i) => {
      if (!isDeepStrictEqual(ours[i], theirs[i])) differences.push(`${m}: node ${JSON.stringify(ours[i])} | cs ${JSON.stringify(theirs[i])}`);
    });
    const cached = (db) => new Map(db.prepare('SELECT * FROM beatmaps').all().map(({ cached_at: _, ...r }) => [r.md5, JSON.stringify(r)]));
    const csAfter = new DatabaseSync(csFile, { readOnly: true });
    const [a, b] = [cached(nodeDb), cached(csAfter)];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(key) !== b.get(key)) differences.push(`cached ${key}: node ${a.get(key) ?? 'missing'} | cs ${b.get(key) ?? 'missing'}`);
    }
    csAfter.close();
    nodeDb.close();
    result('resolve', md5s.length, differences);
  },

  discover: () => discover(false),
  // The Rescan button: every tier, the registry, shortcuts and a walk of every drive.
  'discover-forced': () => discover(true),
};

async function discover(force) {
  {
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const node = await discoverInstalls({
      configured: config.installRoots ?? [],
      // As the Rescan button asks: nothing remembered, and the walk allowed.
      remembered: force ? [] : (config.discoveredRoots ?? []),
      noSearch: !force && config.searchedForInstalls === true,
      force,
    });
    const [theirs] = cs('discover', data, ...(force ? ['force'] : []));
    // A score counts days since a file changed, and the two ran a moment apart.
    const minute = (c) => ({ ...c, development: c.development === true, score: Math.round(c.score * 1440) / 1440 });
    const ours = {
      installs: node.installs.map((i) => ({ ...i, development: i.development === true })),
      candidates: node.candidates.map(minute),
      searched: node.searched,
    };
    const other = { ...theirs, candidates: theirs.candidates.map(minute) };
    const differences = [];
    for (const key of ['installs', 'candidates', 'searched']) {
      if (!isDeepStrictEqual(ours[key], other[key])) differences.push(`${key}: node ${JSON.stringify(ours[key])} | cs ${JSON.stringify(other[key])}`);
    }
    result(force ? 'discover-forced' : 'discover', 3, differences);
  }
}

try {
  for (const [name, check] of Object.entries(checks)) {
    if (only === null || only === name) await check();
  }
  console.log(failed === 0 ? '\n  Every check agrees.' : `\n  ${failed} check(s) differ.`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(`\n  ${e.stack ?? e}`);
  process.exitCode = 2;
} finally {
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.error(`  could not remove ${work}: ${e.message}`);
  }
}
