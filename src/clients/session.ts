import fs from 'node:fs';
import path from 'node:path';
import type { OsuInstall } from './detect.ts';

/**
 * The username osu! is currently signed in as, read from the client's own config file.
 *
 * This is the offline half of identity: it needs no network and no account link, and it is
 * almost always the name the user actually wants. It is only ever used to *prefill* -- a
 * fresh profile is a different identity by definition, so adopting the real one silently
 * would be wrong.
 *
 * Read-only and best effort. A missing file, an unreadable one, or an osu! that has never
 * been signed in all mean the same thing: there is nothing to suggest.
 *
 * - osu!lazer writes `game.ini` beside its database, with `Username = ...`.
 * - osu!stable writes `osu!.<windows-username>.cfg` in its install directory, same key.
 */

/** Both clients use `Key = Value` per line; take the first match and stop. */
function readIniValue(file: string, key: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'i').exec(line);
    if (!match) continue;
    const value = match[1]!.trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export interface LocalSession {
  client: 'lazer' | 'stable';
  username: string;
}

export function detectLocalSessions(installs: readonly OsuInstall[]): LocalSession[] {
  const found: LocalSession[] = [];

  for (const install of installs) {
    if (install.kind === 'lazer') {
      const username = readIniValue(path.join(install.root, 'game.ini'), 'Username');
      if (username) found.push({ client: 'lazer', username });
      continue;
    }

    // stable names the file after the *Windows* user, which is not knowable from here, so
    // match the pattern instead of guessing.
    let entries: string[];
    try {
      entries = fs.readdirSync(install.root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^osu!\..+\.cfg$/i.test(entry)) continue;
      const username = readIniValue(path.join(install.root, entry), 'Username');
      if (username) {
        found.push({ client: 'stable', username });
        break;
      }
    }
  }

  return found;
}
