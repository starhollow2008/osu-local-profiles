import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** Name of the fresh profile being tracked (one per alternative playstyle). */
  profileName: string;
  port: number;
  /** Open the page in the default browser on start. */
  openBrowser: boolean;
  /** Explicit osu! install paths, when auto-detection needs help. */
  installRoots: string[];
  /**
   * Shown beside the profile name, the way osu! shows a country. Two-letter ISO code;
   * empty means the profile has no country, which is how a fresh profile starts.
   */
  country: string;
  /** What to call the playstyle under the profile name, e.g. "left hand, mouse only". */
  tagline: string;
  /**
   * Listen on every network interface instead of only this machine.
   *
   * Off by default, and that default matters: the page can reset a profile, delete one and
   * remove scores, and none of those endpoints asks who is calling. Bound to localhost they
   * are reachable only from this machine. Turned on, anyone on the same network can open
   * the profile -- which is the point -- but also do anything else the page can do. So it
   * is opt-in, and the app says so on startup.
   */
  shareOnNetwork: boolean;
}

const DEFAULTS: Config = {
  profileName: 'Fresh Profile',
  port: 7272,
  openBrowser: true,
  installRoots: [],
  country: '',
  tagline: '',
  shareOnNetwork: false,
};

/**
 * Where the profile database, config and any user-supplied images live.
 *
 * Resolved from this module's own location rather than the working directory, so the app
 * finds its data however it was started -- double-clicked from Explorer, launched by a
 * shortcut, or run from a shell somewhere else entirely. In a portable build that means
 * `data/` sits beside the app, and the whole folder can be moved or carried on a stick.
 */
export function dataDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

export function loadConfig(): Config {
  const file = path.join(dataDir(), 'config.json');
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config>;
  } catch {
    /* first run, or unreadable: fall back to defaults */
  }
  return { ...DEFAULTS, ...stored };
}

export function saveConfig(config: Config): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}
