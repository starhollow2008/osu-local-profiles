/**
 * Do the Node app and its C# port answer the same? (docs/csharp-port.md, rule 3)
 *
 *   node scripts/api-parity.mjs [data folder] [--keep]
 *
 * Starts both apps on copies of one `data/` folder (default: this checkout's), asks each the
 * same questions, and compares the answers: JSON as parsed values, files byte for byte, plus
 * status and headers. Exit 0 when every answer matches, 1 when any differs.
 *
 * Nothing is written to the data folder given: the database is copied with VACUUM INTO, which
 * reads a consistent snapshot even while the app is running on it. The Node app still needs an
 * osu! installation to start, so this runs on a player's machine, not in CI.
 *
 * Each endpoint the port answers goes in ENDPOINTS. A field left out of the comparison is
 * listed with the reason, so a difference is never ignored without saying why.
 */
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { extractZip } from '../src/update/zip.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fields not compared, by endpoint, each with why. Paths are dotted (`settings.country`). */
const ENDPOINTS = [
  {
    path: '/api/app',
    ignore: {
      pid: 'each app is its own process',
      tracking: 'the port has no tracker until phase 4',
      update: 'the port has no update check until phase 5',
    },
  },
  { path: '/api/settings' },
  { path: '/api/app-config' },
  { path: '/api/declined' },
  { path: '/api/data-folder', ignore: { path: 'each app runs on its own copy of data/' } },
  // Every mode, with the page's own first pages, and with every section asked for in full.
  ...[0, 1, 2, 3].flatMap((mode) => [
    { path: `/api/profile?mode=${mode}` },
    { path: `/api/profile?mode=${mode}&top=100&recent=10000&mostPlayed=10000&favorites=10000&events=10000` },
  ]),
  // What the page never sends, read as the Node app reads it.
  { path: '/api/profile?mode=abc&top=0&recent=-3&events=2.9' },
];

/** Endpoints whose answer depends on the active profile, asked again for every other profile. */
const PER_PROFILE = ['/api/settings', '/api/declined', '/api/profile'];

/** Files and pages, compared byte for byte. */
const STATIC = ['/', '/scores/1', '/scores/1/', '/js/main.js', '/css/base.css', '/favicon.svg', '/i18n/en.json', '/no-such-file.js'];

/** Headers that must match on every answer. */
const HEADERS = ['content-type', 'cache-control', 'content-disposition'];

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const source = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(repo, 'data'));
const exe = process.platform === 'win32' ? '.exe' : '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Every link made, removed on its own before the work folder is, so a delete never follows one. */
const links = [];

/** A folder reached through a link, so the copy shares it without copying it. */
function link(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(at);
}

/** Remove the links, then the work folder, but only if no link is left in it. */
function cleanUp(work) {
  for (const at of links) {
    try {
      fs.unlinkSync(at);
    } catch {
      /* checked below */
    }
  }
  const left = links.filter((at) => {
    try {
      fs.lstatSync(at);
      return true;
    } catch {
      return false;
    }
  });
  if (left.length > 0) {
    console.log(`  left ${work} in place: could not remove the link(s) ${left.join(', ')}`);
    return;
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

/** `data/` for one app: the database snapshot, and the top-level files beside it. */
function copyData(to, port) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('profiles.db') || entry.name === 'update.log') continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(to, entry.name));
  }
  const snapshot = new DatabaseSync(path.join(source, 'profiles.db'), { readOnly: true });
  snapshot.exec(`VACUUM INTO '${path.join(to, 'profiles.db').replaceAll("'", "''")}'`);
  snapshot.close();

  const file = path.join(to, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // Its own port, no browser, and no request of its own to GitHub.
  Object.assign(config, { port, openBrowser: false, checkForUpdates: false, autoUpdate: false });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function waitFor(port, child, name, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode}) before answering; see its log`);
    try {
      const r = await fetch(`http://localhost:${port}/api/app`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not answer within ${timeoutMs / 1000}s`);
}

/** Every difference between two parsed values, as `path: node | cs` lines. Key order is not one. */
function differences(a, b, at = '', ignore = {}) {
  if (Object.hasOwn(ignore, at.slice(1))) return [];
  if (isDeepStrictEqual(a, b)) return [];
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) return [`${at.slice(1) || '(whole answer)'}: node ${JSON.stringify(a)} | cs ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) => differences(a[key], b[key], `${at}.${key}`, ignore));
}

async function ask(port, pathname) {
  const r = await fetch(`http://localhost:${port}${pathname}`);
  return { status: r.status, headers: Object.fromEntries(HEADERS.map((h) => [h, r.headers.get(h)])), body: Buffer.from(await r.arrayBuffer()) };
}

async function main() {
  if (!fs.existsSync(path.join(source, 'profiles.db'))) throw new Error(`no profiles.db in ${source}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-parity-'));
  const children = [];
  try {
    const [nodePort, csPort] = [await freePort(), await freePort()];

    console.log('  building the C# app');
    const bin = path.join(work, 'cs-bin');
    const build = spawnSync('dotnet', ['build', path.join(repo, 'dotnet', 'App', 'App.csproj'), '-c', 'Release', '-o', bin, '--nologo', '-v', 'q'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('the C# build failed');

    // The Node app finds data/ beside its own src/, so it gets a folder of its own.
    const nodeRoot = path.join(work, 'node');
    fs.mkdirSync(nodeRoot);
    fs.cpSync(path.join(repo, 'src'), path.join(nodeRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(nodeRoot, 'package.json'));
    for (const shared of ['web', 'node_modules', 'tools']) link(path.join(repo, shared), path.join(nodeRoot, shared));
    copyData(path.join(nodeRoot, 'data'), nodePort);

    const csRoot = path.join(work, 'cs');
    fs.mkdirSync(csRoot);
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(csRoot, 'package.json'));
    link(path.join(repo, 'web'), path.join(csRoot, 'web'));
    copyData(path.join(csRoot, 'data'), csPort);

    const log = (name) => fs.openSync(path.join(work, `${name}.log`), 'w');
    const nodeApp = spawn(process.execPath, ['src/main.ts'], { cwd: nodeRoot, stdio: ['pipe', log('node'), log('node-err')] });
    // Read-only, as the port runs by default: these answers must not need a write.
    const csApp = spawn(path.join(bin, `osu-local-profiles-app${exe}`), ['--root', csRoot], { stdio: ['pipe', log('cs'), log('cs-err')] });
    children.push(nodeApp, csApp);

    console.log(`  starting both apps (logs in ${work})`);
    await Promise.all([waitFor(nodePort, nodeApp, 'the Node app'), waitFor(csPort, csApp, 'the C# app')]);

    let failed = 0;
    const report = (pathname, problems, answer) => {
      if (problems.length === 0) {
        // Status and size, so two apps failing alike cannot pass for agreement.
        console.log(`  same     ${pathname}  (${answer.status}, ${(answer.body.length / 1024).toFixed(1)} KB)`);
        return;
      }
      failed++;
      console.log(`  DIFFERS  ${pathname}`);
      for (const p of problems) console.log(`             ${p}`);
    };
    const compareMeta = (a, b) => [
      ...(a.status === b.status ? [] : [`status: node ${a.status} | cs ${b.status}`]),
      ...HEADERS.filter((h) => a.headers[h] !== b.headers[h]).map((h) => `${h}: node ${a.headers[h]} | cs ${b.headers[h]}`),
    ];

    const compareJson = async (endpoints, label = '') => {
      for (const { path: pathname, ignore = {} } of endpoints) {
        const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
        const problems = compareMeta(a, b);
        try {
          problems.push(...differences(JSON.parse(a.body.toString('utf8')), JSON.parse(b.body.toString('utf8')), '', ignore));
        } catch (e) {
          problems.push(`not JSON: ${e.message}`);
        }
        report(`${label}${pathname}`, problems, a);
      }
    };
    await compareJson(ENDPOINTS);

    // Every score's page, removed ones and one that never existed included, and a sample of
    // replay downloads byte for byte: with a file, and each kind of refusal.
    const scores = (() => {
      const db = new DatabaseSync(path.join(csRoot, 'data', 'profiles.db'), { readOnly: true });
      try {
        return db.prepare('SELECT id, replay_path IS NOT NULL AND origin IS NULL AND client <> \'mcosu\' AS replay FROM scores ORDER BY id').all();
      } finally {
        db.close();
      }
    })();
    const missingId = (scores.at(-1)?.id ?? 0) + 1000;
    await compareJson(
      [...scores.map((s) => s.id), missingId].map((id) => ({
        path: `/api/scores/${id}`,
        ignore: {
          calculator: 'the pp helper is in-process from phase 3',
          'owner.tracking': 'the port has no tracker until phase 4',
        },
      })),
    );
    const replays = [
      ...scores.filter((s) => s.replay === 1).slice(0, 8),
      ...scores.filter((s) => s.replay !== 1).slice(0, 3),
      { id: missingId },
    ];
    for (const pathname of [
      ...replays.flatMap((s) => [`/api/scores/${s.id}/replay`]),
      '/api/image/avatar', '/api/image/cover', '/api/image/avatar?profile=1', '/api/image/cover?profile=3',
      '/api/image/avatar?profile=99', '/api/image/avatar?profile=abc',
    ]) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }

    // The exports. The JSON's own timestamp is the moment each app answered; a workbook is a zip
    // whose compressed bytes differ between Node's zlib and .NET's, so the files inside it are compared.
    await compareJson([{ path: '/api/export', ignore: { exportedAt: 'the moment each app answered' } }]);
    for (const pathname of ['/api/export/scores.csv', '/api/export/scores.csv?lang=de', '/api/export/scores.csv?lang=xx']) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }
    for (const pathname of ['/api/export/profile.xlsx', '/api/export/profile.xlsx?lang=ja']) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      const unpacked = [a, b].map((answer, i) => {
        const file = path.join(work, `workbook-${i}.xlsx`);
        const dir = path.join(work, `workbook-${i}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(file, answer.body);
        try {
          extractZip(file, dir);
        } catch (e) {
          problems.push(`${i === 0 ? 'node' : 'cs'}: not a zip (${e.message})`);
          return new Map();
        }
        const files = new Map();
        const walk = (at, prefix) => {
          for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(at, entry.name), `${prefix}${entry.name}/`);
            else files.set(`${prefix}${entry.name}`, fs.readFileSync(path.join(at, entry.name)));
          }
        };
        walk(dir, '');
        return files;
      });
      for (const name of new Set([...unpacked[0].keys(), ...unpacked[1].keys()])) {
        const [x, y] = [unpacked[0].get(name), unpacked[1].get(name)];
        if (!x || !y || !x.equals(y)) problems.push(`${name}: node ${x?.length ?? 'missing'} bytes | cs ${y?.length ?? 'missing'} bytes, different`);
      }
      report(pathname, problems, a);
    }

    /*
     * The other profiles: the answers above are the active one's. Each app reads the active
     * profile from its database on every request, so switching it in both copies is enough.
     */
    const copies = [path.join(nodeRoot, 'data', 'profiles.db'), path.join(csRoot, 'data', 'profiles.db')];
    const profileIds = (() => {
      const db = new DatabaseSync(copies[0], { readOnly: true });
      try {
        const active = db.prepare("SELECT value FROM kv WHERE key = 'activeProfileId'").get()?.value;
        return db.prepare('SELECT id FROM profiles ORDER BY id').all().map((r) => r.id).filter((id) => String(id) !== active);
      } finally {
        db.close();
      }
    })();
    for (const id of profileIds) {
      for (const file of copies) {
        const db = new DatabaseSync(file);
        db.prepare("INSERT INTO kv (key, value) VALUES ('activeProfileId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(id));
        db.close();
      }
      await compareJson(ENDPOINTS.filter((e) => PER_PROFILE.some((prefix) => e.path.startsWith(prefix))), `[profile ${id}] `);
    }
    for (const pathname of STATIC) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }

    console.log(failed === 0 ? '\n  Every answer matches.' : `\n  ${failed} answer(s) differ.`);
    process.exitCode = failed === 0 ? 0 : 1;

    // A quit each app treats as deliberate; no Origin, as the tray launcher sends it.
    for (const port of [nodePort, csPort]) await fetch(`http://localhost:${port}/api/quit`, { method: 'POST' }).catch(() => {});
  } finally {
    for (const child of children) {
      if (child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child.exitCode === null) child.kill();
    }
    if (keep) console.log(`  kept ${work}`);
    else cleanUp(work);
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}`);
  process.exitCode = 2;
});
