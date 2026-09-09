import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  /** Name of the fresh profile being tracked (one per alternative playstyle). */
  profileName: string;
  port: number;
  /** Open the page in the default browser on start. */
  openBrowser: boolean;
  /**
   * Reserved for Phase 3, not yet honoured. Would import plays that already existed before
   * the app first ran. It stays off by default: the point of a fresh profile is that it
   * starts empty, and existing replays were set with the user's normal playstyle.
   */
  backfill: boolean;
  /** Explicit osu! install paths, when auto-detection needs help. */
  installRoots: string[];
}

const DEFAULTS: Config = {
  profileName: 'Fresh Profile',
  port: 7272,
  openBrowser: true,
  backfill: false,
  installRoots: [],
};

export function dataDir(): string {
  return path.join(process.cwd(), 'data');
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
