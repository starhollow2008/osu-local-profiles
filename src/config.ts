import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** Name of the first profile to track (one per alternative playstyle). */
  profileName: string;
  port: number;
  /** Open the page in the default browser on start. */
  openBrowser: boolean;
  /** Explicit osu! install paths, when auto-detection needs help. Set from the page. */
  installRoots: string[];
  /**
   * osu! folders a previous search found, so the next launch does not have to search again.
   *
   * A cache, and treated as one: every entry is re-checked on load and a root that has gone
   * is simply not a candidate. Kept beside `installRoots` rather than merged into it because
   * the two mean different things -- one is what the user said, and is never overruled; this
   * is what the app worked out, and can be thrown away and rebuilt at any time.
   */
  discoveredRoots: string[];
  /**
   * Whether the bounded search of every drive has ever run.
   *
   * It runs when a client is missing, and a machine that genuinely has no osu!stable is
   * missing one forever -- so without this, every launch on a lazer-only machine would walk
   * the disks to reach the same answer. Recorded once; Rescan on the page is how to ask
   * again.
   */
  searchedForInstalls: boolean;
  /**
   * What language the page is in, as one of osu!'s own locale codes (`de`, `pt-br`, `zh-tw`).
   *
   * Empty means **not chosen yet**, which is deliberately not the same as `en`: the first
   * launch offers a language, and it can only do that if "never answered" is a state this
   * can hold. Once answered -- even if the answer is English -- it is never asked again.
   */
  language: string;
  /**
   * Shown beside the profile name, the way osu! shows a country. Two-letter ISO code;
   * empty means the profile has no country, which is how a new profile starts.
   */
  country: string;
  /** What to call the playstyle under the profile name, e.g. "left hand, mouse only". */
  tagline: string;
  /**
   * Ask GitHub once at startup whether a newer release exists.
   *
   * One request, when the app starts, and never again while it runs -- the same rule the
   * osu! API guidance imposes and this project follows everywhere else. Set false and the
   * app makes no network request of its own at all; the check can still be run by hand from
   * the page.
   */
  checkForUpdates: boolean;
  /**
   * One Favorite Beatmaps list for every profile, rather than one each. On by default, at
   * the user's request. Install-level because it is about how profiles relate, not any one
   * of them; see syncFavoriteSharing in favorites.ts for what switching it does.
   */
  sharedFavorites: boolean;
}

const DEFAULTS: Config = {
  profileName: 'Local Profile',
  port: 7272,
  openBrowser: true,
  installRoots: [],
  discoveredRoots: [],
  searchedForInstalls: false,
  language: '',
  country: '',
  tagline: '',
  checkForUpdates: true,
  sharedFavorites: true,
};

/**
 * Keys older versions wrote that mean nothing now. Dropped on load so the next save does not
 * carry them forward: `shareOnNetwork` opened the page to the local network, and was removed
 * because the page can reset and delete profiles without asking who is calling.
 */
const RETIRED_KEYS = ['shareOnNetwork'];

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

/** The directory the app itself lives in -- `data/`'s parent, and what an update replaces. */
export function installDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The running version, read from `package.json` rather than written down twice.
 *
 * Resolved the same way as `dataDir`, so a packaged build reports the version it shipped
 * as. Unknown rather than guessed if the file cannot be read: a wrong version would make
 * the update check offer a downgrade, or hide a real update.
 */
export function appVersion(): string | null {
  try {
    const file = path.join(installDir(), 'package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function loadConfig(): Config {
  const file = path.join(dataDir(), 'config.json');
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config>;
  } catch {
    /* first run, or unreadable: fall back to defaults */
  }
  const merged: Record<string, unknown> = { ...DEFAULTS, ...stored };
  for (const key of RETIRED_KEYS) delete merged[key];
  return merged as unknown as Config;
}

export function saveConfig(config: Config): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}
