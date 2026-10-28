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

/** Every replay the database knows of, and every file in osu!stable's Data/r, in a stable order. */
function knownReplays() {
  const db = new DatabaseSync(path.join(data, 'profiles.db'), { readOnly: true });
  const known = db
    .prepare(`SELECT replay_path AS p FROM scores WHERE replay_path IS NOT NULL
              UNION SELECT replay_path FROM declined_plays WHERE replay_path IS NOT NULL`)
    .all()
    .map((r) => r.p);
  db.close();
  const stableFolders = new Set(known.map((p) => path.dirname(p)).filter((d) => /[\\/]Data[\\/]r$/i.test(d)));
  return [...new Set([...known, ...[...stableFolders].flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))])]
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
}

let failed = 0;
const result = (name, total, differences) => {
  console.log(`  ${differences.length === 0 ? 'same   ' : 'DIFFERS'}  ${name}: ${total - differences.length} of ${total} agree`);
  for (const d of differences.slice(0, 10)) console.log(`             ${d}`);
  if (differences.length > 0) failed++;
};

const checks = {
  async replays() {
    const paths = knownReplays();
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

  /*
   * Every replay the profiles know of, ingested by both into a fresh profile beside a copy of this
   * machine's beatmap index: as a re-ingest (`plain`), and as an import (`judged`) with the owner
   * worked out and a filter that turns some plays away. The outcomes, and every row each writes,
   * compared. Slow: each play is priced by osu!'s calculator, twice.
   */
  ingest: () => ingestBoth(knownReplays(), ['plain', 'judged'], 'ingest'),

  /*
   * McOsu's scores.db, read by both and every play's replay built by both: the real file from
   * test/mcosu.test.ts, and ones generated here to reach every branch of the format. The plays
   * are compared field by field and the replays byte for byte. Needs no McOsu installed.
   */
  async mcosu() {
    const { parseMcosuScores, buildMcosuReplay, builtReplayPath, McosuVersionError } = await import('../src/clients/mcosu.ts');
    const real = Buffer.from(
      'vmE0AQEAAAALIGMxN2EwNzNjODNlYTBmMzdlNTNlNTBlYTczYTRiNDE0AQAAAABOAjUBVqm2agAAAAALBUd1ZXN0VwABAAAADgABAAAAVGAEAAAAAACQAEAAAAAAAMhqJEIefBJDHh7YwUYXLUHo4lBAcfrQP6ckxj8AAMA/AABAQAAAwEAAAIBAAABAQJAAAABYAAAAIAAAAAA=',
      'base64',
    );
    const str = (s) => {
      const d = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([0x0b, d.length]), d]);
    };
    const db = (version, maps) => {
      const parts = [];
      const int = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
      const short = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); parts.push(b); };
      const long = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
      const float = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); };
      int(version);
      int(maps.length);
      for (const [md5, entries] of maps) {
        parts.push(str(md5));
        int(entries.length);
        for (const e of entries) {
          parts.push(Buffer.from([e.gamemode ?? 0]));
          int(e.scoreVersion ?? 20251214);
          if (version === 20210103 && (e.scoreVersion ?? 20251214) > 20190103) parts.push(Buffer.from([e.imported ? 1 : 0]));
          long(e.seconds ?? 1790358248);
          parts.push(str(e.name ?? 'Guest'));
          for (const c of e.counts ?? [100, 10, 1, 20, 5, 0]) short(c);
          long(e.score ?? 400000 + ((e.seconds ?? 1790358248) % 1000));
          short(e.combo ?? 170);
          int(e.mods ?? 0);
          short(0);
          for (let i = 0; i < 7; i++) float(1);
          for (const v of e.stats ?? [1, 3.3, 8, 6, 4]) float(v);
          if ((e.scoreVersion ?? 20251214) > 20180722) { int(e.maxCombo ?? 175); int(111); int(51); }
          parts.push(e.experimental === undefined ? Buffer.from([0]) : str(e.experimental));
        }
      }
      return Buffer.concat(parts);
    };
    // Two osu!standard beatmaps this machine has, so the built replays are priced as McOsu's are.
    const source = new DatabaseSync(path.join(data, 'profiles.db'), { readOnly: true });
    const [map, map2] = source
      .prepare('SELECT DISTINCT s.beatmap_md5 AS md5 FROM scores s JOIN osu_files f ON f.md5 = s.beatmap_md5 WHERE s.mode = 0 ORDER BY s.beatmap_md5 LIMIT 2')
      .all()
      .map((r) => r.md5);
    source.close();
    const files = {
      'real.db': real,
      'many.db': db(20210110, [
        [map, [
          {},
          { mods: 64 | 8, stats: [1.5, 3.3, 7, 6, 4], name: 'Tangy ☆', combo: 175 },
          { mods: 1 << 22, experimental: 'osu_mod_wobble;osu_mod_fullalternate;', seconds: 1790358249 },
          { gamemode: 0xa9, seconds: 1790358250, score: 2 ** 40 },
          { scoreVersion: 20180101, seconds: 1790358251, stats: [1.2, 3.3, 8, 6, 4] },
          { mods: 16, stats: [1, 4.29, 10, 8.4, 5.6], counts: [32767, -1, 0, 0, 0, 3], seconds: 1790358252 },
        ]],
        ['short', [{ seconds: 1790358253 }]],
        [map2, [{ mods: 2 | 1, stats: [0.6, 1.65, 4, 3, 2], seconds: 1790358254, experimental: '' }]],
      ]),
      'v20210103.db': db(20210103, [[map, [{ imported: true }, { gamemode: 1, seconds: 1790358300 }]]]),
      'old.db': db(20190101, [[map, [{ gamemode: 2 }, { gamemode: 0, scoreVersion: 20170101, seconds: 1790358400 }]]]),
      'newer.db': db(20300101, [[map, [{}]]]),
      'cut.db': db(20210110, [[map, [{}]]]).subarray(0, 60),
      'empty.db': Buffer.alloc(0),
    };
    const dir = path.join(work, 'mcosu-in');
    fs.mkdirSync(dir, { recursive: true });
    const list = Object.keys(files).map((name) => {
      fs.writeFileSync(path.join(dir, name), files[name]);
      return path.join(dir, name);
    });
    const listFile = path.join(work, 'mcosu.txt');
    fs.writeFileSync(listFile, list.join('\n'));
    const [nodeOut, csOut] = [path.join(work, 'mcosu-node'), path.join(work, 'mcosu-cs')];
    fs.mkdirSync(nodeOut, { recursive: true });
    const theirs = cs('mcosu', listFile, csOut);
    const differences = [];
    list.forEach((file, i) => {
      let ours;
      try {
        const scores = parseMcosuScores(fs.readFileSync(file));
        for (const s of scores) fs.writeFileSync(builtReplayPath(nodeOut, s), buildMcosuReplay(s));
        ours = { file, scores: JSON.parse(JSON.stringify(scores)) };
      } catch (e) {
        ours = { file, error: e instanceof McosuVersionError ? 'version' : 'short' };
      }
      if (!isDeepStrictEqual(ours, theirs[i])) differences.push(`${path.basename(file)}: node ${JSON.stringify(ours).slice(0, 400)} | cs ${JSON.stringify(theirs[i]).slice(0, 400)}`);
    });
    const built = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
    const [a, b] = [built(nodeOut), built(csOut)];
    if (!isDeepStrictEqual(a, b)) differences.push(`built files: node ${a.join(',')} | cs ${b.join(',')}`);
    for (const name of a.filter((n) => b.includes(n))) {
      if (!fs.readFileSync(path.join(nodeOut, name)).equals(fs.readFileSync(path.join(csOut, name)))) differences.push(`${name}: the built replays differ`);
    }
    console.log(`           ${a.length} replays built (node), ${b.length} (cs)`);
    result('mcosu', list.length + a.length, differences);
    // And ingested by both, McOsu's mods and pricing included.
    await ingestBoth(a.map((n) => path.join(nodeOut, n)), ['plain'], 'mcosu-ingest');
  },

  /*
   * Import past plays from the beginning, everything it takes, by both into a fresh profile
   * beside a copy of this machine's beatmap index, with the owner worked out and a filter on:
   * what Check previews, what the import reports, and every row each writes, compared. The
   * whole walk of osu!'s folders, McOsu's replays and lazer's logs. Slow, as `ingest` is.
   */
  async backfill() {
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const { installs } = await discoverInstalls({ configured: config.installRoots ?? [], remembered: config.discoveredRoots ?? [], noSearch: true });
    const { openDb } = await import('../src/db/index.ts');
    const { seedFirstProfile } = await import('../src/profiles.ts');
    const { updateSettings } = await import('../src/settings.ts');
    const { BeatmapResolver } = await import('../src/clients/beatmaps.ts');
    const { Tracker } = await import('../src/tracker/index.ts');
    const { OfficialCalculator } = await import('../src/calc/official.ts');
    const official = await OfficialCalculator.create();
    if (!official) throw new Error("osu!'s calculator is not built: npm run build:pp");

    // Each app builds McOsu's replays into a folder of its own; the rows are compared without it.
    const mcosu = { node: path.join(work, 'backfill-node-mcosu'), cs: path.join(work, 'backfill-cs-mcosu') };
    const installsFor = (app) => installs.map((i) => (i.kind === 'mcosu' ? { ...i, replayDir: mcosu[app] } : i));
    // In JSON text, as the rows and answers are compared, a path's backslashes are escaped.
    const escaped = (p) => JSON.stringify(p).slice(1, -1);
    const unprefix = (text) => [mcosu.node, mcosu.cs].reduce((t, p) => t.split(escaped(p)).join('<mcosu>').split(p).join('<mcosu>'), text);
    const installsFile = path.join(work, 'backfill-installs.json');
    fs.writeFileSync(installsFile, JSON.stringify(installsFor('cs')));

    const real = path.join(data, 'profiles.db');
    const nodeFile = path.join(work, 'backfill-node.db');
    const csFile = path.join(work, 'backfill-cs.db');
    const setup = openDb(nodeFile);
    setup.exec(`ATTACH DATABASE '${real.replaceAll("'", "''")}' AS real`);
    setup.exec('INSERT INTO osu_files SELECT * FROM real.osu_files');
    setup.exec('DETACH DATABASE real');
    seedFirstProfile(setup, 'check');
    setup.exec('UPDATE profiles SET tracking_since = 0');
    const profileId = setup.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get().id;
    updateSettings(setup, profileId, {
      trackingFilter: { enabled: true, stars: { min: 0, max: 7 }, mods: { HR: 'excluded' }, length: { min: 20, max: null } },
    });
    setup.close();
    fs.copyFileSync(nodeFile, csFile);

    const db = openDb(nodeFile);
    const own = installsFor('node');
    const tracker = new Tracker({ db, resolver: new BeatmapResolver(db, own), installs: own, profileId, trackingSince: 0, official });
    const preview = await tracker.previewBackfill(0, true);
    const imported = await tracker.backfill(0, { replays: true, unfinished: true, attempts: true }, true, 'import');
    const ours = [preview, imported].map((v) => JSON.parse(unprefix(JSON.stringify(v, (_, x) => (x === null ? undefined : x)))));
    // The preview is one object in the Node app, the replays' scan with the logs' beside it.
    const [csPreview, csImport] = cs('backfill', csFile, installsFile);
    const theirs = [{ ...csPreview.replays, log: csPreview.log }, csImport].map((v) =>
      JSON.parse(unprefix(JSON.stringify(v, (_, x) => (x === null ? undefined : x)))),
    );
    const differences = [];
    ['preview', 'import'].forEach((name, i) => {
      for (const key of new Set([...Object.keys(ours[i]), ...Object.keys(theirs[i])])) {
        const [a, b] = [ours[i][key], theirs[i][key]];
        if (isDeepStrictEqual(a, b)) continue;
        if (Array.isArray(a) && Array.isArray(b)) {
          const at = a.findIndex((x, n) => !isDeepStrictEqual(x, b[n]));
          differences.push(`${name}.${key} (${a.length} | ${b.length}), first at ${at}: node ${JSON.stringify(a[at])} | cs ${JSON.stringify(b[at])}`);
        } else {
          differences.push(`${name}.${key}: node ${JSON.stringify(a)} | cs ${JSON.stringify(b)}`);
        }
      }
    });

    const csDb = new DatabaseSync(csFile, { readOnly: true });
    for (const [table, key, skip] of [
      ['scores', 'id', []],
      ['incomplete_plays', 'id', []],
      ['declined_plays', 'id', ['declined_at']],
      ['beatmaps', 'md5', ['cached_at']],
    ]) {
      const rows = (d) => new Map(d.prepare(`SELECT * FROM ${table}`).all().map((r) => {
        for (const s of skip) delete r[s];
        return [r[key], unprefix(JSON.stringify(r))];
      }));
      const [a, b] = [rows(db), rows(csDb)];
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        if (a.get(k) !== b.get(k)) differences.push(`${table} ${k}: node ${a.get(k) ?? 'missing'} | cs ${b.get(k) ?? 'missing'}`);
      }
      console.log(`           ${table}: ${a.size} rows (node), ${b.size} rows (cs)`);
    }
    console.log(`           import: ${JSON.stringify(imported)}`);
    csDb.close();
    db.close();
    official.dispose();
    result('backfill', 6, differences);
  },

  discover: () => discover(false),
  // The Rescan button: every tier, the registry, shortcuts and a walk of every drive.
  'discover-forced': () => discover(true),
};

async function ingestBoth(files, modes, label) {
  {
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    const { installs } = await discoverInstalls({ configured: config.installRoots ?? [], remembered: config.discoveredRoots ?? [], noSearch: true });
    const { openDb } = await import('../src/db/index.ts');
    const { seedFirstProfile } = await import('../src/profiles.ts');
    const { updateSettings, getSettings } = await import('../src/settings.ts');
    const { BeatmapResolver } = await import('../src/clients/beatmaps.ts');
    const { ingestReplayFile } = await import('../src/tracker/ingest.ts');
    const { resolveIdentity } = await import('../src/player-identity.ts');
    const { OfficialCalculator } = await import('../src/calc/official.ts');
    const official = await OfficialCalculator.create();
    if (!official) throw new Error("osu!'s calculator is not built: npm run build:pp");

    const real = path.join(data, 'profiles.db');
    const list = path.join(work, `${label}.txt`);
    fs.writeFileSync(list, files.join('\n'));
    const installsFile = path.join(work, 'installs.json');
    fs.writeFileSync(installsFile, JSON.stringify(installs));
    // Something to turn away on every criterion the filter has, while letting most plays through.
    const filter = {
      enabled: true,
      stars: { min: 0, max: 7 },
      length: { min: 20, max: 600 },
      mods: { HR: 'excluded' },
      categories: ['ranked', 'qualified', 'loved', 'pending', 'wip', 'unsubmitted'],
      submitted: { from: Date.UTC(2010, 0, 1), to: null, includeUnknown: true },
      rules: [{ conditions: [{ field: 'any', test: 'notContains', values: ['remix'] }] }, { conditions: [{ field: 'mapper', test: 'is', values: ['sotarks'] }] }],
    };
    // Nulls left out, so an outcome Node writes without a key reads as one C# writes with null.
    const bare = (v) => JSON.parse(JSON.stringify(v, (_, x) => (x === null ? undefined : x)));

    for (const mode of modes) {
      const nodeFile = path.join(work, `${label}-node-${mode}.db`);
      const csFile = path.join(work, `${label}-cs-${mode}.db`);
      const setup = openDb(nodeFile);
      setup.exec(`ATTACH DATABASE '${real.replaceAll("'", "''")}' AS real`);
      setup.exec('INSERT INTO osu_files SELECT * FROM real.osu_files');
      setup.exec('DETACH DATABASE real');
      seedFirstProfile(setup, 'check');
      setup.exec('UPDATE profiles SET tracking_since = 0');
      const profileId = setup.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get().id;
      if (mode === 'judged') updateSettings(setup, profileId, { trackingFilter: filter });
      setup.close();
      fs.copyFileSync(nodeFile, csFile);

      const db = openDb(nodeFile);
      const ctx = { db, resolver: new BeatmapResolver(db, installs), profileId, trackingSince: 0, official };
      if (mode === 'judged') Object.assign(ctx, { filter: getSettings(db, profileId).trackingFilter, identity: resolveIdentity(db, profileId, installs), declines: 'import' });
      const ours = [];
      for (const file of files) ours.push(bare(await ingestReplayFile(file, ctx)));
      const theirs = cs('ingest', csFile, installsFile, list, mode).map(bare);

      const differences = [];
      files.forEach((f, i) => {
        if (!isDeepStrictEqual(ours[i], theirs[i])) differences.push(`${path.basename(f)}: node ${JSON.stringify(ours[i])} | cs ${JSON.stringify(theirs[i])}`);
      });
      const csDb = new DatabaseSync(csFile, { readOnly: true });
      for (const [table, key, skip] of [
        ['scores', 'id', []],
        ['declined_plays', 'id', ['declined_at']],
        ['beatmaps', 'md5', ['cached_at']],
      ]) {
        const rows = (d) => new Map(d.prepare(`SELECT * FROM ${table}`).all().map((r) => {
          for (const s of skip) delete r[s];
          return [r[key], JSON.stringify(r)];
        }));
        const [a, b] = [rows(db), rows(csDb)];
        for (const k of new Set([...a.keys(), ...b.keys()])) {
          if (a.get(k) !== b.get(k)) differences.push(`${table} ${k}: node ${a.get(k) ?? 'missing'} | cs ${b.get(k) ?? 'missing'}`);
        }
        console.log(`           ${mode} ${table}: ${a.size} rows (node), ${b.size} rows (cs)`);
      }
      const tally = ours.reduce((t, o) => ({ ...t, [o.reason ?? o.status]: (t[o.reason ?? o.status] ?? 0) + 1 }), {});
      console.log(`           ${mode} outcomes: ${JSON.stringify(tally)}`);
      csDb.close();
      db.close();
      result(`${label} (${mode})`, files.length, differences);
    }
    official.dispose();
  }
}

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
