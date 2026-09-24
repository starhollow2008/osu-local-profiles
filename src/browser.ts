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

/**
 * Opening a folder in the system's file manager: Explorer, Finder, or whatever `xdg-open`
 * hands a directory to.
 *
 * Not through `cmd` on Windows, unlike the browser: `explorer.exe` is a program and takes the
 * path as its one argument, so the C runtime's quoting is exactly what it reads. Explorer
 * exits with 1 even when it opened the window, so the exit code means nothing either way.
 */
export function folderCommand(platform: string, dir: string): BrowserCommand {
  const options: SpawnOptions = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') return { command: 'explorer.exe', args: [dir], options };
  if (platform === 'darwin') return { command: 'open', args: [dir], options };
  return { command: 'xdg-open', args: [dir], options };
}

/** Best effort, like `openBrowser`: the page shows the path as well. */
export function openFolder(dir: string, platform: string = process.platform): void {
  const { command, args, options } = folderCommand(platform, dir);
  try {
    const child = spawn(command, args, options);
    child.on('error', () => {
      /* no file manager to hand it to; the path is on the page */
    });
    child.unref();
  } catch {
    /* as above */
  }
}
