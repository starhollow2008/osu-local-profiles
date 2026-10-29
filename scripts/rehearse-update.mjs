/**
 * The switch-over rehearsal (docs/csharp-port.md, phase 8): installs of old versions update to a
 * C# release published in a test repository, through each way an update installs, and the
 * result is checked.
 *
 *   node scripts/rehearse-update.mjs --builds <dir> --repo <owner/name> --target <version> [--from-cs <version>]
 *
 * The old versions come from the real releases, from the oldest each platform can update from:
 * 1.7.0 on Windows (older ones look for downloads under the app's previous name) and 1.10.0 on
 * macOS and Linux (older ones drop the execute bits as they unpack, so never installed any
 * update there). A version with no zip for this platform is skipped. `--builds` holds this
 * platform's zip of `--from-cs`, a C# release older than the target, to check C# to C#. Every
 * install is pointed at `--repo`, whose latest release must be `--target` with this platform's
 * zip. Each gets its own port and a stand-in osu!stable install (scripts/parity-data.mjs), since
 * old versions stop at start without one.
 *
 * On Linux, run it under `xvfb-run`: the launcher then sees a desktop with no tray, as on a
 * desktop without one, and an update can start the app again.
 *
 * Every scenario is checked the same way: `OK: updated to <target>` in data/update.log, no Node
 * files left, the database's profiles and scores as before, a tagline kept, and Quit stopping
 * everything run from the install. Prints a line each, and exits 1 if any failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeStableInstall } from './parity-data.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const builds = valueOf('--builds') ?? '.';
const repo = valueOf('--repo');
const target = valueOf('--target');
const fromCs = valueOf('--from-cs');
if (!repo || !target) {
  console.error('usage: node scripts/rehearse-update.mjs --builds <dir> --repo <owner/name> --target <version> [--from-cs <version>]');
  process.exit(2);
}
const work = path.resolve(valueOf('--work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'olp-rehearsal-')));
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const rid = win ? 'win-x64' : mac ? (process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64') : 'linux-x64';
const SCENARIO_LIMIT_MS = 10 * 60_000;

// "auto" starts it as a player would: the tray launcher where the version has one (1.17 on),
// the start script before that.
const SCENARIOS = [
  ...(win ? [{ from: '1.7.0' }, { from: '1.9.0' }] : [{ from: '1.10.0' }]),
  { from: '1.13.2' },
  { from: '1.16.0' },
  { from: '1.17.0' },
  { from: '1.32.0' },
  { from: '1.32.0', route: 'quit' },
  ...(fromCs
    ? [
        { from: fromCs, cs: true },
        { from: fromCs, cs: true, route: 'quit', ...(win ? {} : { start: 'script' }) },
      ]
    : []),
].map((s) => ({ route: 'now', start: 'auto', ...s }));

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

/** The version answering on the port, or null: from /api/app, or /api/update before it had one. */
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

class Skip extends Error {}

async function zipFor(version, cs) {
  const name = `osu-local-profiles-${version}-${rid}.zip`;
  const local = path.join(builds, name);
  if (fs.existsSync(local)) return local;
  if (cs) throw new Error(`${name} is not in ${builds}`);
  const file = path.join(work, name);
  if (fs.existsSync(file)) return file;
  const r = await fetch(`https://github.com/jonathant09/osu-local-profiles/releases/download/v${version}/${name}`);
  if (r.status === 404) throw new Skip(`${version} has no ${rid} build`);
  if (!r.ok) throw new Error(`downloading ${name} failed (${r.status})`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** Unpack as a player would, modes kept, and point it at the test repository. */
async function install(s, dir, port, osuRoot) {
  const zip = await zipFor(s.from, s.cs);
  fs.mkdirSync(dir, { recursive: true });
  // Windows' own tar: Git's, first on a runner's PATH in bash, reads `C:` as a host to connect to.
  if (win) execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]);
  else execFileSync('unzip', ['-q', zip, '-d', dir]);
  const root = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('osu-local-profiles-')));
  const pkgFile = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.repository = { type: 'git', url: `https://github.com/${repo}.git` };
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'config.json'),
    // No check of its own at start: GitHub answers 60 unsigned requests an hour to an address,
    // which a CI runner shares, so only the scenario's own checks ask.
    `${JSON.stringify({ port, openBrowser: false, checkForUpdates: false, installRoots: [osuRoot], searchedForInstalls: true }, null, 2)}\n`,
  );
  return root;
}

const trayLauncher = (root) =>
  win ? path.join(root, 'osu! local profiles.exe') : mac ? path.join(root, 'osu! local profiles.app') : path.join(root, 'osu-local-profiles');
const startScript = (root) =>
  fs.readdirSync(root).find((n) => (win ? n.endsWith('.bat') : mac ? n.endsWith('.command') : n === 'start.sh'));

/** Start it the way a player does: the tray launcher, or the start script. Returns which. */
function start(root, how, log) {
  const tray = how === 'tray' || (how === 'auto' && fs.existsSync(trayLauncher(root)));
  const script = startScript(root);
  if (!tray && !script) throw new Error('nothing to start it with');
  const out = fs.openSync(log, 'a');
  const [command, argv, extra] = tray
    ? mac
      ? ['open', ['-n', trayLauncher(root)], {}]
      : [trayLauncher(root), [], {}]
    : win
      ? // `call` and the whole path: cmd reads a quoted "Start ..." as its own start command.
        [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', path.join(root, script)], {}]
      : ['sh', [script], {}];
  const child = spawn(command, argv, { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true, ...extra });
  child.unref();
  fs.closeSync(out);
  return tray ? 'tray launcher' : 'start script';
}

const leftovers = (root) => ['node', 'node.exe', 'src', 'scripts', 'node_modules'].filter((n) => fs.existsSync(path.join(root, n)));

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

/** Every process run from under `root`, as [pid, what]. */
function runningFrom(root) {
  if (win) {
    const json = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const all = [].concat(JSON.parse(json || '[]'));
    const under = (p) => typeof p === 'string' && p.toLowerCase().includes(root.toLowerCase());
    return all
      .filter((p) => p.ProcessId !== process.pid && (under(p.ExecutablePath) || under(p.CommandLine)) && !String(p.CommandLine).includes('rehearse-update'))
      .map((p) => [p.ProcessId, p.CommandLine ?? p.ExecutablePath]);
  }
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps
    .split('\n')
    .filter((line) => line.trim() && !line.includes('rehearse-update'))
    .map((line) => [Number(line.trim().split(/\s+/)[0]), line.trim()])
    .filter(([pid, line]) => pid !== process.pid && (line.includes(root) || (/osu-local-profiles|osu! local profiles|src\/main\.ts/.test(line) && cwdOf(pid).startsWith(root))));
}

/** The profiles and how many scores each holds, read from the database itself. */
function snapshot(root) {
  const db = new DatabaseSync(path.join(root, 'data', 'profiles.db'), { readOnly: true });
  try {
    return JSON.stringify(db.prepare('SELECT p.id, p.name, (SELECT COUNT(*) FROM scores s WHERE s.profile_id = p.id) AS scores FROM profiles p ORDER BY p.id').all());
  } finally {
    db.close();
  }
}

/** Until two looks five seconds apart agree and nothing is indexing or importing. */
async function settled(port, root) {
  let last = null;
  await until('the app settling', 5 * 60_000, async () => {
    const state = await ask(port, '/api/state').catch(() => null);
    if (!state) return false;
    const busy = state.indexing?.active || state.importing?.active || state.ppCalculator?.recalculating;
    let now = null;
    try {
      now = snapshot(root);
    } catch {
      /* not made yet */
    }
    const same = !busy && now !== null && now === last;
    last = now;
    if (!same) await sleep(4000);
    return same;
  });
}

const taglineOf = (settings) => settings.tagline ?? settings.settings?.tagline;

async function scenario(s, dir, port, osuRoot) {
  const log = path.join(dir, 'start.log');
  const root = await install(s, dir, port, osuRoot);
  const how = start(root, s.start, log);
  await until(`${s.from} answering`, 120_000, async () => (await versionAt(port)) === s.from);
  await settled(port, root);

  const tagline = `rehearsal from ${s.from}`;
  await ask(port, '/api/settings', { tagline });
  if (taglineOf(await ask(port, '/api/settings')) !== tagline) throw new Error(`${s.from} did not keep the tagline`);
  const created = await ask(port, '/api/profiles', { action: 'create', name: `Second from ${s.from}` });
  if (!created.ok && !created.profile) throw new Error(`creating a profile: ${JSON.stringify(created)}`);
  await settled(port, root);
  const before = snapshot(root);

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
      const at = path.join(root, 'data', 'update.log');
      return fs.existsSync(at) && fs.readFileSync(at, 'utf8').startsWith(`OK: updated to ${target}`);
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
  await settled(port, root);
  const after = snapshot(root);
  if (after !== before) throw new Error(`the profiles changed: ${before} -> ${after}`);
  await ask(port, '/api/profiles', { action: 'switch', id: 1 });
  if (taglineOf(await ask(port, '/api/settings')) !== tagline) throw new Error('the tagline was lost');

  await ask(port, '/api/quit', {});
  await until('everything stopping at Quit', 30_000, async () => runningFrom(root).length === 0).catch(() => {
    throw new Error(`still running after Quit:\n${runningFrom(root).map(([, what]) => what).join('\n')}`);
  });
  return how;
}

function showLogs(dir) {
  const root = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith('osu-local-profiles-')) : null;
  for (const at of [path.join(dir, 'start.log'), ...(root ? ['data/update.log', 'data/logs/app.log'].map((rel) => path.join(dir, root, rel)) : [])]) {
    if (fs.existsSync(at)) console.log(`    --- ${path.relative(dir, at)}\n${fs.readFileSync(at, 'utf8').split('\n').slice(-30).join('\n')}`);
  }
}

const osuRoot = writeStableInstall(path.join(work, 'osu!')).root;
console.log(`  rehearsing on ${rid}, to ${target} from ${repo}, in ${work}`);
let failed = 0;
let ran = 0;
for (const [index, s] of SCENARIOS.entries()) {
  const dir = path.join(work, `${index + 1}-${s.from}-${s.route}`);
  const port = 7600 + index;
  const route = s.route === 'now' ? 'Install now' : 'When I quit';
  const started = Date.now();
  try {
    const how = await Promise.race([
      scenario(s, dir, port, osuRoot),
      sleep(SCENARIO_LIMIT_MS).then(() => {
        throw new Error(`not done within ${SCENARIO_LIMIT_MS / 60_000} minutes`);
      }),
    ]);
    ran++;
    console.log(`  ok    ${s.from}${s.cs ? ' (C#)' : ''}, ${how}, ${route} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    if (e instanceof Skip) {
      console.log(`  skip  ${s.from}, ${route}: ${e.message}`);
    } else {
      ran++;
      failed++;
      console.log(`  FAIL  ${s.from}${s.cs ? ' (C#)' : ''}, ${route}: ${e.message}`);
      showLogs(dir);
    }
  }
  // Whatever is left of a scenario, so the next one starts clean.
  for (const [pid] of runningFrom(work)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
console.log(failed ? `\n  ${failed} of ${ran} failed` : `\n  all ${ran} updated to ${target}`);
process.exit(failed ? 1 : 0);
