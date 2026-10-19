import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { installDir } from './config.ts';

/**
 * Start with the computer (roadmap 5.77): Other settings -> This install.
 *
 * Off by default. On, the computer starts this copy's **tray launcher** as the user signs in,
 * never the runtime: the app never outlives its launcher, and the icon is how it is stopped.
 * The launcher is given `--startup` and tells the app (`STARTUP_ENV`), which then opens no
 * page -- nobody sat down to look at it.
 *
 * The entry the computer keeps is the only record of the answer, so the switch can never
 * disagree with what will happen at the next sign-in:
 *
 * - **Windows**: a value under `HKCU\...\Run`, as Task Manager's Startup apps lists it. Turned
 *   off there, Windows marks it in `StartupApproved\Run`, and the switch reads off.
 * - **macOS**: a LaunchAgent in `~/Library/LaunchAgents`, opening the bundle with `open`.
 * - **Linux**: an XDG autostart entry in `~/.config/autostart`.
 *
 * It counts as on only when the entry starts *this* copy. A folder moved somewhere else reads
 * off, and turning it on there points the entry at the new place. Only a packaged build has a
 * launcher, so a source checkout is never offered it.
 */

export const STARTUP_ARG = '--startup';
/** What the launcher sets on the app's first start when the computer started it (startupEnv). */
export const STARTUP_ENV = 'OSU_LOCAL_PROFILES_STARTUP';

/** Whether the computer started this app as the user signed in, so no page is opened. */
export function startedWithComputer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STARTUP_ENV] === '1';
}

export interface StartupState {
  /** False in a copy with no tray launcher: a source checkout. */
  available: boolean;
  /** The computer starts this copy as the user signs in. */
  enabled: boolean;
}

/** The tray launcher a package opens (scripts/package-files.mjs, `trayLauncherFor`). */
export function launcherPath(dir: string, platform: string): string {
  if (platform === 'win32') return path.win32.join(dir, 'osu! local profiles.exe');
  if (platform === 'darwin') return path.posix.join(dir, 'osu! local profiles.app');
  return path.posix.join(dir, 'osu-local-profiles');
}

/* --------------------------------------------------------------- the entries */

const WINDOWS_NAME = 'osu! local profiles';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const MAC_LABEL = 'io.github.jonathant09.osu-local-profiles';
const LINUX_FILE = 'osu-local-profiles.desktop';

/** The command Windows runs: the launcher, quoted for its spaces, then `--startup`. */
export function windowsCommand(launcher: string): string {
  return `"${launcher}" ${STARTUP_ARG}`;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * A LaunchAgent that opens the bundle as the user signs in. `open` rather than the executable
 * inside it, as Finder would, so macOS treats it as the app it is.
 */
export function macAgent(bundle: string): string {
  const args = ['/usr/bin/open', '-a', bundle, '--args', STARTUP_ARG];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MAC_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** An Exec argument, quoted as the desktop entry spec asks. */
const desktopQuote = (s: string) => `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;

export function linuxEntry(launcher: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=osu! local profiles',
    `Exec=${desktopQuote(launcher)} ${STARTUP_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * The launcher an entry starts, read back out of what `windowsCommand`, `macAgent` or
 * `linuxEntry` wrote. Null for anything else: an entry this did not write is not this app's.
 */
export function entryTarget(entry: string, platform: string): string | null {
  if (platform === 'win32') {
    return /^"([^"]+)"/.exec(entry.trim())?.[1] ?? null;
  }
  if (platform === 'darwin') {
    const strings = [...entry.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]!));
    const at = strings.indexOf('-a');
    return at === -1 ? null : (strings[at + 1] ?? null);
  }
  const exec = /^Exec=("(?:[^"\\]|\\.)*")/m.exec(entry)?.[1];
  return exec ? exec.slice(1, -1).replace(/\\(.)/g, '$1') : null;
}

/** Whether an entry starts the launcher at `launcher`. */
export function startsLauncher(entry: string | null, launcher: string, platform: string): boolean {
  const target = entry === null ? null : entryTarget(entry, platform);
  if (target === null) return false;
  if (platform === 'win32') return path.win32.resolve(target).toLowerCase() === path.win32.resolve(launcher).toLowerCase();
  return path.posix.resolve(target) === path.posix.resolve(launcher);
}

/* --------------------------------------------------------------------- Windows */

/**
 * One value from a `reg export` file, unescaped. Exported rather than queried because `reg
 * query` prints in the console's code page, which mangles a path with a non-ASCII name in it;
 * an export is UTF-16. Null when the key does not hold it.
 */
export function regFileValue(text: string, name: string): string | null {
  const quoted = `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"=`;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(quoted)) continue;
    const raw = line.slice(quoted.length);
    if (raw.startsWith('"')) return raw.slice(1, raw.lastIndexOf('"')).replace(/\\(.)/g, '$1');
    return raw;
  }
  return null;
}

/**
 * Whether Task Manager has the entry turned off: `StartupApproved\Run` holds a binary value
 * whose first byte is odd (03, 07) when disabled and even (02, 06) when enabled.
 */
export function approvedOff(value: string | null): boolean {
  const first = value === null ? null : /^hex:([0-9a-f]{2})/i.exec(value)?.[1];
  return first != null && (parseInt(first, 16) & 1) === 1;
}

const execute = promisify(execFile);

/** reg.exe by its own path, never whichever one PATH finds first. */
const run = (args: string[]) =>
  execute(path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe'), args, { windowsHide: true });

async function exportKey(key: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-startup-'));
  const file = path.join(dir, 'key.reg');
  try {
    await run(['export', key, file, '/y']);
    return fs.readFileSync(file).toString('utf16le').replace(/^﻿/, '');
  } catch {
    // A key that does not exist yet: nobody has ever had an entry there.
    return '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------- per system */

function macAgentFile(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function linuxEntryFile(home: string, env: NodeJS.ProcessEnv): string {
  const config = env['XDG_CONFIG_HOME'] || path.join(home, '.config');
  return path.join(config, 'autostart', LINUX_FILE);
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export interface StartupOptions {
  dir?: string;
  platform?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function resolved(opts: StartupOptions) {
  const platform = opts.platform ?? process.platform;
  const dir = opts.dir ?? installDir();
  return {
    platform,
    launcher: launcherPath(dir, platform),
    home: opts.home ?? os.homedir(),
    env: opts.env ?? process.env,
  };
}

/** Whether the computer starts this copy as the user signs in. */
export async function startupState(opts: StartupOptions = {}): Promise<StartupState> {
  const { platform, launcher, home, env } = resolved(opts);
  if (!fs.existsSync(launcher)) return { available: false, enabled: false };

  if (platform === 'win32') {
    const entry = regFileValue(await exportKey(RUN_KEY), WINDOWS_NAME);
    if (!startsLauncher(entry, launcher, platform)) return { available: true, enabled: false };
    const approved = regFileValue(await exportKey(APPROVED_KEY), WINDOWS_NAME);
    return { available: true, enabled: !approvedOff(approved) };
  }
  const file = platform === 'darwin' ? macAgentFile(home) : linuxEntryFile(home, env);
  return { available: true, enabled: startsLauncher(readText(file), launcher, platform) };
}

/**
 * Turn starting with the computer on or off for this copy. On points the entry here, taking it
 * from any other copy; off removes it only when it is this copy's, so another copy's survives.
 */
export async function setStartup(enabled: boolean, opts: StartupOptions = {}): Promise<StartupState> {
  const { platform, launcher, home, env } = resolved(opts);
  if (!fs.existsSync(launcher)) {
    throw new Error('starting with the computer needs the downloaded app, which this copy is not');
  }

  if (platform === 'win32') {
    if (enabled) {
      await run(['add', RUN_KEY, '/v', WINDOWS_NAME, '/t', 'REG_SZ', '/d', windowsCommand(launcher), '/f']);
      // Turned off in Task Manager once, it would stay off; turning it on here means on.
      await run(['delete', APPROVED_KEY, '/v', WINDOWS_NAME, '/f']).catch(() => {});
    } else if (startsLauncher(regFileValue(await exportKey(RUN_KEY), WINDOWS_NAME), launcher, platform)) {
      await run(['delete', RUN_KEY, '/v', WINDOWS_NAME, '/f']);
      await run(['delete', APPROVED_KEY, '/v', WINDOWS_NAME, '/f']).catch(() => {});
    }
    return startupState(opts);
  }

  const file = platform === 'darwin' ? macAgentFile(home) : linuxEntryFile(home, env);
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, platform === 'darwin' ? macAgent(launcher) : linuxEntry(launcher));
  } else if (startsLauncher(readText(file), launcher, platform)) {
    fs.rmSync(file, { force: true });
  }
  return startupState(opts);
}
