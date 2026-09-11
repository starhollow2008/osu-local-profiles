import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Opening the page in the user's default browser.
 *
 * A pure function of the platform, like `clients/detect.ts`, so the Windows command line can
 * be checked from any machine -- which matters here, because the Windows one was broken for
 * as long as it existed and nothing noticed.
 *
 * **Windows goes through `cmd`'s `start`, and the arguments must reach it verbatim.** Node
 * quotes each argument by the C runtime's rules, so the empty window title `""` that `start`
 * needs arrived as `"\"\""`. `cmd` does not treat a backslash as an escape, so `start` read a
 * title of `\` and then tried to run a program called `\""` -- and the page never opened.
 * `windowsVerbatimArguments` hands `cmd` the line as written: `start "" <url>`.
 */
export interface BrowserCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function browserCommand(platform: string, url: string): BrowserCommand {
  const options: SpawnOptions = { detached: true, stdio: 'ignore' };

  if (platform === 'win32') {
    // `&` and `^` are the only characters in a URL that `cmd` would act on; escape them so a
    // query string can never be read as a second command.
    const safe = url.replace(/[&^]/g, '^$&');
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', safe],
      options: { ...options, windowsVerbatimArguments: true, windowsHide: true },
    };
  }
  if (platform === 'darwin') return { command: 'open', args: [url], options };
  return { command: 'xdg-open', args: [url], options };
}

/** Best effort: the URL is always printed in the console as well. */
export function openBrowser(url: string, platform: string = process.platform): void {
  const { command, args, options } = browserCommand(platform, url);
  try {
    const child = spawn(command, args, options);
    child.on('error', () => {
      /* no browser opener on this system; the printed URL still works */
    });
    child.unref();
  } catch {
    /* as above */
  }
}
