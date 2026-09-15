import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { Tracker } from '../src/tracker/index.ts';
import { startServer } from '../src/http/server.ts';
import { APP_ID, isOwnPage, runningInstance, stopWhenLauncherCloses } from '../src/instance.ts';
import { launchedFromTray, launcherRestarts, LAUNCHER_ENV } from '../src/update/index.ts';

/*
 * Finding the app again, and stopping it from the page (roadmap 5.48). A second start opens
 * the running copy's page; Quit on that page stops it; the tray launcher stops it by closing
 * its stdin.
 */

async function withServer(
  onQuit: (() => void) | undefined,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-instance-'));
  const db = openDb(path.join(tmp, 'test.db'));
  const profileId = getOrCreateProfile(db, 'First');
  const tracker = new Tracker({
    db,
    resolver: new BeatmapResolver(db, []),
    installs: [],
    profileId,
    trackingSince: 0,
    official: null,
  });
  const server = startServer({
    db,
    tracker,
    installs: [],
    country: '',
    tagline: '',
    dataDir: tmp,
    port: 0,
    appConfig: { get: () => ({ openBrowser: false }), set: () => {} },
    onQuit,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A POST with headers `fetch` would not send as given (a browser's `Origin`). */
function post(port: number, pathname: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

/* ------------------------------------------------------------ already running */

test('a second start finds the copy already answering on the port', async () => {
  await withServer(undefined, async (port) => {
    const found = await runningInstance(port);
    assert.ok(found);
    assert.equal(typeof found.version === 'string' || found.version === null, true);
  });
});

test('nothing on the port, or something else on it, is not the app', async () => {
  const stranger = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'something-else' }));
  });
  await new Promise<void>((resolve) => stranger.listen(0, resolve));
  const port = (stranger.address() as AddressInfo).port;
  try {
    assert.equal(await runningInstance(port), null);
  } finally {
    await new Promise((resolve) => stranger.close(resolve));
  }
  // The same port, now closed: refused, and answered as "not running" rather than thrown.
  assert.equal(await runningInstance(port), null);
});

test('/api/app names the app, so a stranger on the port is never taken for it', async () => {
  await withServer(undefined, async (port) => {
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/app`)).json()) as { app: string; pid: number };
    assert.equal(body.app, APP_ID);
    assert.equal(body.pid, process.pid);
  });
});

/* ------------------------------------------------------------------ quit */

test('Quit stops the app from its own page, after answering', async () => {
  let quit = 0;
  let quitCalled!: () => void;
  const called = new Promise<void>((resolve) => (quitCalled = resolve));
  await withServer(
    () => {
      quit++;
      quitCalled();
    },
    async (port) => {
      assert.equal(await post(port, '/api/quit', { origin: `http://localhost:${port}` }), 200);
      await called;
    },
  );
  assert.equal(quit, 1);
});

test("another website's page cannot stop the app", async () => {
  let quit = 0;
  await withServer(
    () => quit++,
    async (port) => {
      assert.equal(await post(port, '/api/quit', { origin: 'https://example.com' }), 403);
      // DNS rebinding reaches this port under another name, and still names that origin.
      assert.equal(await post(port, '/api/quit', { origin: `http://evil.example:${port}` }), 403);
      assert.equal(await post(port, '/api/quit', { origin: 'null' }), 403);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(quit, 0);
    },
  );
});

test('a copy given no way to stop says so rather than pretending', async () => {
  await withServer(undefined, async (port) => {
    assert.equal(await post(port, '/api/quit'), 400);
  });
});

test('the page is recognised under each name for this machine, on this port only', () => {
  assert.equal(isOwnPage(undefined, 7272), true, 'no Origin: not a web page');
  assert.equal(isOwnPage('http://localhost:7272', 7272), true);
  assert.equal(isOwnPage('http://127.0.0.1:7272', 7272), true);
  assert.equal(isOwnPage('http://[::1]:7272', 7272), true);
  assert.equal(isOwnPage('http://localhost:8080', 7272), false);
  assert.equal(isOwnPage('https://localhost:7272', 7272), false);
  assert.equal(isOwnPage('garbage', 7272), false);
});

/* ------------------------------------------------------------- the launcher */

test('the app stops once, when the tray launcher closes its end', () => {
  const stdin = new PassThrough();
  let stops = 0;
  stopWhenLauncherCloses(stdin, () => stops++);
  stdin.end();
  stdin.destroy();
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.equal(stops, 1);
      resolve();
    }),
  );
});

test('the tray launcher restarts the app after an update, as the terminal loop does', () => {
  assert.equal(launcherRestarts({ [LAUNCHER_ENV]: 'tray' }), true);
  assert.equal(launchedFromTray({ [LAUNCHER_ENV]: 'tray' }), true);
  assert.equal(launchedFromTray({ [LAUNCHER_ENV]: 'restarts' }), false);
  assert.equal(launchedFromTray({}), false);
});
