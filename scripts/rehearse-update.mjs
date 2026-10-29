/**
 * The switch-over rehearsal on macOS and Linux (docs/csharp-port.md, phase 8): installs of old
 * versions update to a C# release published in a test repository, through each way an update
 * installs, and the result is checked.
 *
 *   node scripts/rehearse-update.mjs --builds <dir> --repo <owner/name> --target <version>
 *
 * `--builds` holds this platform's zips of the bridge (1.33.0) and a C# release older than the
 * target (1.34.2), as `.github/workflows/rehearsal.yml` builds them; 1.16.0 and 1.32.0 come from
 * the real releases. Every install is pointed at `--repo`, whose latest release must be
 * `--target` with this platform's zip. Each install gets its own port and a stand-in osu!stable
 * install (scripts/parity-data.mjs), since 1.16 stops at start without one.
 *
 * On Linux, run it under `xvfb-run`: the launcher then sees a desktop with no tray, as on a
 * desktop without one, and an update can start the app again.
 *
 * Every scenario is checked the same way: `OK: updated to <target>` in data/update.log, no Node
 * files left, the profiles, their scores and a tagline as before, and Quit stopping everything
 * that ran from the install. Prints a line each, and exits 1 if any failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStableInstall } from './parity-data.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const builds = valueOf('--builds');
const repo = valueOf('--repo');
const target = valueOf('--target');
if (!builds || !repo || !target) {
  console.error('usage: node scripts/rehearse-update.mjs --builds <dir> --repo <owner/name> --target <version>');
  process.exit(2);
}
const work = path.resolve(valueOf('--work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'olp-rehearsal-')));
const mac = process.platform === 'darwin';
const rid = mac ? 'osx-arm64' : 'linux-x64';
const SCENARIO_LIMIT_MS = 10 * 60_000;

const SCENARIOS = [
  { from: '1.16.0', start: 'script', route: 'now' },
  { from: '1.32.0', start: 'tray', route: 'now' },
  { from: '1.33.0', start: 'tray', route: 'quit' },
  { from: '1.34.2', start: 'tray', route: 'now' },
  { from: '1.34.2', start: 'script', route: 'quit' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, limitMs, check) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const found = await check();
    if (found) return found;
    await sleep(1000);
  }
  throw new Error(`${what}: not within ${limitMs / 1000}s`);
}

async function ask(port, pathname, body) {
  const init = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const r = await fetch(`http://localhost:${port}${pathname}`, {
    ...init,
    headers: { ...init.headers, origin: `http://localhost:${port}` },
    signal: AbortSignal.timeout(15 * 60_000),
  });
  return r.json();
}

/** The version answering on the port, or null: from /api/app, or /api/update before 1.17 had one. */
async function versionAt(port) {
  for (const [pathname, key] of [['/api/app', 'version'], ['/api/update', 'currentVersion']]) {
    try {
      const r = await fetch(`http://localhost:${port}${pathname}`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return (await r.json())[key] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function zipFor(version) {
  const name = `osu-local-profiles-${version}-${rid}.zip`;
  const local = path.join(builds, name);
  if (fs.existsSync(local)) return local;
  const file = path.join(work, name);
  if (fs.existsSync(file)) return file;
  const r = await fetch(`https://github.com/jonathant09/osu-local-profiles/releases/download/v${version}/${name}`);
  if (!r.ok) throw new Error(`downloading ${name} failed (${r.status})`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** Unpack as a player would, modes kept, and point it at the test repository. */
async function install(version, dir, port, osuRoot) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-q', await zipFor(version), '-d', dir]);
  const root = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('osu-local-profiles-')));
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.repository = { type: 'git', url: `https://github.com/${repo}.git` };
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'config.json'),
    `${JSON.stringify({ port, openBrowser: false, installRoots: [osuRoot], searchedForInstalls: true }, null, 2)}\n`,
  );
  return root;
}

/** Start it the way a player does: the start script, or the tray launcher (the `.app` on macOS). */
function start(root, how, log) {
  const out = fs.openSync(log, 'a');
  const [command, argv] =
    how === 'script'
      ? ['sh', [mac ? 'Start osu! local profiles.command' : 'start.sh']]
      : mac
        ? ['open', ['-n', path.join(root, 'osu! local profiles.app')]]
        : [path.join(root, 'osu-local-profiles'), []];
  const child = spawn(command, argv, { cwd: root, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
}

const leftovers = (root) => ['node', 'src', 'scripts', 'node_modules'].filter((n) => fs.existsSync(path.join(root, n)));

/** Where a process is running from: start.sh starts the launcher as `./osu-local-profiles`. */
function cwdOf(pid) {
  try {
    if (!mac) return fs.readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
  } catch {
    return '';
  }
}

/** Every process run from this install: named in its command line, or working in it. */
function runningFrom(root) {
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').filter((line) => {
    if (!line.trim() || line.includes('rehearse-update')) return false;
    if (line.includes(root)) return true;
    const pid = Number(line.trim().split(/\s+/)[0]);
    return pid !== process.pid && /osu-local-profiles|osu! local profiles|src\/main\.ts/.test(line) && cwdOf(pid).startsWith(root);
  });
}

const profilesOf = (state) => JSON.stringify(state.profiles.map(({ id, name, createdAt, trackingSince, scoreCount }) => ({ id, name, createdAt, trackingSince, scoreCount })));

/** Until two looks five seconds apart agree and nothing is indexing or importing. */
async function settled(port) {
  let last = null;
  await until('the app settling', 5 * 60_000, async () => {
    const state = await ask(port, '/api/state').catch(() => null);
    if (!state) return false;
    const busy = state.indexing?.active || state.importing?.active || state.ppCalculator?.recalculating;
    const now = profilesOf(state);
    const same = !busy && now === last;
    last = now;
    if (!same) await sleep(4000);
    return same;
  });
}

async function scenario(s, index, osuRoot) {
  const port = 7600 + index;
  const dir = path.join(work, `${index + 1}-${s.from}-${s.start}-${s.route}`);
  const log = path.join(dir, 'start.log');
  const root = await install(s.from, dir, port, osuRoot);
  start(root, s.start, log);
  await until(`${s.from} answering`, 120_000, async () => (await versionAt(port)) === s.from);
  await settled(port);

  await ask(port, '/api/settings', { tagline: `rehearsal from ${s.from}` });
  const created = await ask(port, '/api/profiles', { action: 'create', name: `Second from ${s.from}` });
  if (!created.ok) throw new Error(`creating a profile: ${JSON.stringify(created)}`);
  const before = profilesOf(await ask(port, '/api/state'));

  const check = await ask(port, '/api/update', {});
  if (check.latestVersion !== target || !check.available) throw new Error(`the check found ${check.latestVersion} (${check.error ?? 'no error'})`);

  if (s.route === 'now') {
    const applied = await ask(port, '/api/update/apply', {});
    if (!applied.ok) throw new Error(`Install now: ${applied.error}`);
    await until(`${target} answering after Install now`, 5 * 60_000, async () => (await versionAt(port)) === target);
  } else {
    await ask(port, '/api/update/later', {});
    await until(`${target} downloaded`, 5 * 60_000, async () => {
      const u = await ask(port, '/api/update');
      if (u.prepareError) throw new Error(`When I quit: ${u.prepareError}`);
      return u.ready === target && u.installOnQuit;
    });
    await ask(port, '/api/quit', {});
    await until('the install at quit', 3 * 60_000, async () => {
      const text = fs.existsSync(path.join(root, 'data', 'update.log')) ? fs.readFileSync(path.join(root, 'data', 'update.log'), 'utf8') : '';
      return text.startsWith(`OK: updated to ${target}`);
    });
    await sleep(3000);
    if (await versionAt(port)) throw new Error('the app came back by itself after a quit');
    start(root, s.start, log);
    await until(`${target} answering after a start`, 120_000, async () => (await versionAt(port)) === target);
  }

  const updateLog = fs.readFileSync(path.join(root, 'data', 'update.log'), 'utf8');
  if (!updateLog.startsWith(`OK: updated to ${target}`)) throw new Error(`update.log: ${updateLog.split('\n')[0]}`);
  const left = leftovers(root);
  if (left.length) throw new Error(`Node files left: ${left.join(', ')}`);
  if (profilesOf(await ask(port, '/api/state')) !== before) throw new Error('the profiles changed');
  await ask(port, '/api/profiles', { action: 'switch', id: 1 });
  const tagline = (await ask(port, '/api/state')).settings.tagline;
  if (tagline !== `rehearsal from ${s.from}`) throw new Error(`the tagline is ${JSON.stringify(tagline)}`);

  await ask(port, '/api/quit', {});
  await until('everything stopping at Quit', 30_000, async () => runningFrom(root).length === 0).catch(() => {
    throw new Error(`still running after Quit:\n${runningFrom(root).join('\n')}`);
  });
}

function showLogs(dir) {
  for (const file of ['start.log']) {
    const at = path.join(dir, file);
    if (fs.existsSync(at)) console.log(`    --- ${file}\n${fs.readFileSync(at, 'utf8').split('\n').slice(-30).join('\n')}`);
  }
  const root = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith('osu-local-profiles-')) : null;
  for (const rel of ['data/update.log', 'data/logs/app.log']) {
    const at = root ? path.join(dir, root, rel) : null;
    if (at && fs.existsSync(at)) console.log(`    --- ${rel}\n${fs.readFileSync(at, 'utf8').split('\n').slice(-30).join('\n')}`);
  }
}

const osuRoot = writeStableInstall(path.join(work, 'osu!')).root;
console.log(`  rehearsing on ${rid}, to ${target} from ${repo}, in ${work}`);
let failed = 0;
for (const [index, s] of SCENARIOS.entries()) {
  const label = `${s.from}, ${s.start === 'tray' ? 'tray launcher' : 'start script'}, ${s.route === 'now' ? 'Install now' : 'When I quit'}`;
  const started = Date.now();
  try {
    await Promise.race([
      scenario(s, index, osuRoot),
      sleep(SCENARIO_LIMIT_MS).then(() => {
        throw new Error(`not done within ${SCENARIO_LIMIT_MS / 60_000} minutes`);
      }),
    ]);
    console.log(`  ok    ${label} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}: ${e.message}`);
    showLogs(path.join(work, `${index + 1}-${s.from}-${s.start}-${s.route}`));
  }
  // Whatever is left of a scenario, so the next one starts clean.
  for (const line of runningFrom(work)) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
console.log(failed ? `\n  ${failed} of ${SCENARIOS.length} failed` : `\n  all ${SCENARIOS.length} updated to ${target}`);
process.exit(failed ? 1 : 0);
