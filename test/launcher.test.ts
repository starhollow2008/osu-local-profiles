import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildLauncher, launcherSource } from '../scripts/build-launcher.mjs';
import { defaultRid } from '../scripts/build-pp-helper.mjs';
import { trayLauncherFor } from '../scripts/package-files.mjs';

/*
 * The tray launcher (tools/launcher), built and run for real against a stand-in app: the real
 * runtime running a small src/main.ts that plays the part. OSU_LOCAL_PROFILES_NO_TRAY runs it
 * with no icon and no dialogs, which is all that differs from a double-click -- a CI runner has
 * no tray to put an icon in, and nobody to click a dialog away.
 *
 * Needs Go, as building the launcher does. CI sets it up on all three platforms.
 */

const hasGo = spawnSync('go', ['version']).status === 0;
const skip = hasGo ? false : 'Go is not installed';
const tray = trayLauncherFor(defaultRid().split('-')[0] as 'win' | 'osx' | 'linux');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the launcher's own tests pass", { skip, timeout: 900_000 }, () => {
  const result = spawnSync('go', ['test', './...'], { cwd: launcherSource, encoding: 'utf8', timeout: 900_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

let built: string | null = null;

/** The launcher, built once for this run into a folder of its own. */
function builtLauncher(): string {
  if (built === null) {
    built = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-launcher-build-'));
    buildLauncher(built, defaultRid(), 'test');
  }
  return built;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * A packaged folder in miniature: the launcher, the runtime, a stand-in src/main.ts, and a
 * config naming a port nothing answers on -- or the launcher would find a real app on 7272
 * and open its page instead of starting this one.
 */
async function appFolder(main: string): Promise<{ dir: string; exe: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-launcher-app-'));
  fs.cpSync(path.join(builtLauncher(), tray.name), path.join(dir, tray.name), { recursive: true });
  const runtime = path.join(dir, path.basename(process.execPath));
  try {
    fs.linkSync(process.execPath, runtime);
  } catch {
    fs.copyFileSync(process.execPath, runtime);
    fs.chmodSync(runtime, 0o755);
  }
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), main);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({ port: await freePort() }));
  return { dir, exe: path.join(dir, ...tray.executable.split('/')) };
}

function launcherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OSU_LOCAL_PROFILES_NO_TRAY: '1' };
  delete env['OSU_LOCAL_PROFILES_LAUNCHER'];
  return env;
}

const events = (dir: string): string[] => {
  try {
    return fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  for (const until = Date.now() + ms; Date.now() < until && !check(); ) await sleep(100);
}

/** Removed with retries: on Windows a launcher that is just exiting still holds its file. */
async function remove(dir: string): Promise<void> {
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

const LOG = `import fs from 'node:fs';
const log = (line) => fs.appendFileSync('events.log', line + '\\n');
`;

/*
 * An update, as the app and the swapper perform it: the app starts a busy "swapper", writes its
 * pid where the real one goes, and exits 75. The launcher has to wait for it and then start the
 * launcher now at its path -- here the same one -- which runs the app again.
 */
test('after an update the launcher waits for the swap, then starts the new launcher', { skip, timeout: 900_000 }, async () => {
  const { dir, exe } = await appFolder(
    `${LOG}import { spawn } from 'node:child_process';
log('app started (' + process.env.OSU_LOCAL_PROFILES_LAUNCHER + ')');
if (!fs.existsSync('updated')) {
  fs.writeFileSync('updated', '');
  fs.mkdirSync('data/update', { recursive: true });
  const swapper = spawn(process.execPath, ['swapper.cjs'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync('data/update/swapper.pid', String(swapper.pid));
  swapper.unref();
  process.exit(75);
}
`,
  );
  fs.writeFileSync(
    path.join(dir, 'swapper.cjs'),
    "setTimeout(() => require('fs').appendFileSync('events.log', 'swap finished\\n'), 1500);\n",
  );
  try {
    // Started from somewhere else entirely: the app's folder comes from the launcher's own path.
    const first = spawnSync(exe, [], { cwd: os.tmpdir(), env: launcherEnv(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(first.status, 0, first.stderr);
    await waitFor(() => events(dir).length >= 3, 60_000);
    assert.deepEqual(events(dir), ['app started (tray)', 'swap finished', 'app started (tray)']);
    // Each start keeps the one before's output.
    assert.ok(fs.existsSync(path.join(dir, 'data', 'logs', 'app.previous.log')));
  } finally {
    await remove(dir);
  }
});

/*
 * The app must never outlive the launcher: it would be running with no icon anywhere. It holds
 * the launcher's end of a pipe as stdin, which closes however the launcher goes.
 */
test('the app stops when its launcher goes', { skip, timeout: 900_000 }, async () => {
  const { dir, exe } = await appFolder(
    `${LOG}process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
process.stdin.resume();
log('waiting');
`,
  );
  try {
    const launcher = spawn(exe, [], { cwd: dir, env: launcherEnv(), stdio: 'ignore' });
    await waitFor(() => events(dir).includes('waiting'), 60_000);
    assert.deepEqual(events(dir), ['waiting']);
    launcher.kill();
    await waitFor(() => events(dir).includes('stdin closed'), 30_000);
    assert.deepEqual(events(dir), ['waiting', 'stdin closed']);
  } finally {
    await remove(dir);
  }
});

test('an app that stops with an error ends the launcher with its status, and says why', { skip, timeout: 900_000 }, async () => {
  const { dir, exe } = await appFolder("console.log('  No osu! installation found.');\nprocess.exit(3);\n");
  try {
    const result = spawnSync(exe, [], { cwd: dir, env: launcherEnv(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /No osu! installation found/);
    assert.match(fs.readFileSync(path.join(dir, 'data', 'logs', 'app.log'), 'utf8'), /No osu! installation found/);
  } finally {
    await remove(dir);
  }
});

test('a folder missing its runtime says what is missing, and that nothing needs installing', { skip, timeout: 900_000 }, async () => {
  const { dir, exe } = await appFolder('');
  try {
    fs.rmSync(path.join(dir, path.basename(process.execPath)));
    const result = spawnSync(exe, [], { cwd: dir, env: launcherEnv(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node(\.exe)? is missing from this folder/);
    assert.match(result.stderr, /Nothing needs installing/);
  } finally {
    await remove(dir);
  }
});

test('the launcher reports the version it was built as', { skip, timeout: 900_000 }, () => {
  const exe = path.join(builtLauncher(), ...tray.executable.split('/'));
  assert.equal(spawnSync(exe, ['--version'], { encoding: 'utf8' }).stdout.trim(), 'test');
});

process.on('exit', () => {
  if (built !== null) fs.rmSync(built, { recursive: true, force: true });
});
