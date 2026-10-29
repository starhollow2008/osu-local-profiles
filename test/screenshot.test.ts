import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { capture, CAPTURE_TIMED_OUT } from '../src/http/screenshot.ts';

/**
 * A debugging endpoint that lists a page and accepts its connection, then never answers a
 * command: a browser that has stopped responding.
 */
async function silentBrowser(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
  });
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test('a browser that stops answering fails the capture at its time limit', async () => {
  const browser = await silentBrowser();
  try {
    const started = Date.now();
    // The browser started is Node itself, which refuses Chrome's flags and exits at once.
    await assert.rejects(
      capture({ url: 'http://127.0.0.1:1/', port: browser.port, browser: process.execPath, limitMs: 1500 }),
      { message: CAPTURE_TIMED_OUT },
    );
    const took = Date.now() - started;
    assert.ok(took >= 1400 && took < 5000, `gave up after ${took}ms`);
  } finally {
    await browser.close();
  }
});
