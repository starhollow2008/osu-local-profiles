import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A full-page PNG of the profile, rendered by a browser that is already installed.
 *
 * **Nothing is bundled.** A packaged build is 83MB; a headless browser is several hundred
 * on its own, which would be a poor trade for one button. So this drives Chrome or Edge
 * over the DevTools protocol -- the same mechanism `scripts/ui-check.mjs` uses -- and when
 * neither is installed it says so and points at the HTML export, which needs nothing.
 *
 * The page is loaded with `?export=1`, which is how it knows to hide the things that only
 * make sense while you are using it: the Options menu, the pause button, the reorder
 * controls, the editable affordances.
 */

/** Where a Chromium-based browser usually lives, most preferred first. */
function browserCandidates(): string[] {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ].filter((r): r is string => Boolean(r));
    for (const root of roots) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
  }

  return candidates.filter((c) => fs.existsSync(c));
}

export function findBrowser(): string | null {
  return browserCandidates()[0] ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal CDP client: one connection, one page, a handful of commands. */
class Devtools {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly waiting = new Map<number, (value: Record<string, unknown>) => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number };
      if (message.id === undefined) return;
      this.waiting.get(message.id)?.(message as Record<string, unknown>);
      this.waiting.delete(message.id);
    };
  }

  static async connect(url: string): Promise<Devtools> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('could not talk to the browser'));
    });
    return new Devtools(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

export interface ScreenshotOptions {
  /** The page to capture. */
  url: string;
  /** Debugging port for the throwaway browser instance. */
  port?: number;
  width?: number;
}

/**
 * Render `url` and return the PNG bytes.
 *
 * The browser is started with its own empty profile directory and killed afterwards, so it
 * never touches the user's real browser session, and never leaves one running.
 */
export async function capture(options: ScreenshotOptions): Promise<Buffer> {
  const binary = findBrowser();
  if (!binary) {
    throw new Error(
      'no Chrome, Edge or Chromium found to render the image. ' +
        'Save the page as HTML instead -- that needs nothing installed.',
    );
  }

  const port = options.port ?? 9455;
  const width = options.width ?? 1280;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofp-shot-'));

  let browser: ChildProcess | null = null;
  let devtools: Devtools | null = null;

  try {
    browser = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--window-size=${width},1000`,
        options.url,
      ],
      { stdio: 'ignore' },
    );

    // Wait for the debugging endpoint, then for the page to have drawn itself.
    let target: { webSocketDebuggerUrl?: string } | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
          type: string;
          webSocketDebuggerUrl?: string;
        }[];
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('the browser did not start in time');

    devtools = await Devtools.connect(target.webSocketDebuggerUrl);

    /*
     * The page renders from three fetches and then draws its charts, so there is no single
     * event that means "done". Poll for the marker the page sets once it has painted, and
     * fall back to a fixed wait rather than failing outright.
     */
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = (await devtools.send('Runtime.evaluate', {
        expression: "document.body.dataset.rendered === 'true'",
        returnByValue: true,
      })) as { result?: { result?: { value?: boolean } } };
      if (result.result?.result?.value === true) break;
      await sleep(200);
    }
    // Cover art and medal icons are remote and load after the markup does.
    await sleep(1200);

    const metrics = (await devtools.send('Page.getLayoutMetrics')) as {
      result?: { cssContentSize?: { width: number; height: number } };
    };
    const size = metrics.result?.cssContentSize ?? { width, height: 2000 };

    const shot = (await devtools.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        // Chrome refuses very tall captures; 20,000px is far beyond any real profile.
        height: Math.min(20_000, Math.ceil(size.height)),
        scale: 1,
      },
    })) as { result?: { data?: string } };

    const data = shot.result?.data;
    if (!data) throw new Error('the browser rendered nothing');
    return Buffer.from(data, 'base64');
  } finally {
    devtools?.close();
    browser?.kill();
    // Deliberately not awaited and never allowed to throw: on Windows the browser still
    // holds its profile directory open for a moment after being killed, and a failed
    // cleanup was turning a perfectly good screenshot into an error.
    void removeWhenUnlocked(userDataDir);
  }
}

/** Best-effort deletion of a directory the browser may not have let go of yet. */
async function removeWhenUnlocked(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(400);
    }
  }
  // Still locked: leave it. It is in the OS temp directory and will be cleared eventually.
}
