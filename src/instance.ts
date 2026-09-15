/**
 * One copy of the app at a time, and a way for whatever started it to stop it.
 *
 * Starting the app while it already runs used to fail on the port, in a second console,
 * with nothing to say that the first copy was fine and where it was. Now a second start
 * finds the first -- by asking the port, which is the thing the two would fight over --
 * and opens its page instead. That is also the answer to "where did it go": whatever
 * started the app once starts it again, and lands on the page with Quit on it.
 */

/** What `/api/app` calls this app, so a stranger on the same port is never mistaken for it. */
export const APP_ID = 'osu-local-profiles';

export interface RunningInstance {
  version: string | null;
}

/**
 * The copy of this app answering on `port`, or null when nothing does -- or something else
 * does. Never throws: a refused connection is the ordinary answer.
 */
export async function runningInstance(
  port: number,
  request: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<RunningInstance | null> {
  try {
    const r = await request(`http://localhost:${port}/api/app`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = (await r.json()) as { app?: unknown; version?: unknown };
    if (body.app !== APP_ID) return null;
    return { version: typeof body.version === 'string' ? body.version : null };
  } catch {
    return null;
  }
}

/**
 * Stop when the tray launcher goes away.
 *
 * The launcher holds the write end of this process's stdin and never writes to it. Closing it
 * is how Quit in the tray asks the app to stop, and the operating system closes it too when
 * the launcher dies for any other reason -- killed, crashed, logged out -- so the app can
 * never outlive the only icon that says it is running.
 */
export function stopWhenLauncherCloses(stdin: NodeJS.ReadableStream, stop: () => void): void {
  let stopped = false;
  const once = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  stdin.on('end', once);
  stdin.on('close', once);
  stdin.on('error', once);
  stdin.resume();
}

/**
 * Whether a request's `Origin` is this app's own page.
 *
 * The server already refuses other machines, but a page on any website, open in the user's
 * own browser, can still send a request here. Most of the API is only as exposed as it has
 * always been; stopping the app is new, and one line of script on a web page must not be able
 * to do it. Browsers always name the origin of such a request. A request with no `Origin` is
 * not a web page -- the tray launcher, or curl -- and is let through.
 */
export function isOwnPage(origin: string | undefined, port: number | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
    return url.protocol === 'http:' && host && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}
