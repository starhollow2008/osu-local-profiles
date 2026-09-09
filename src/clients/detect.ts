import fs from 'node:fs';
import path from 'node:path';

export interface OsuInstall {
  kind: 'lazer' | 'stable';
  root: string;
  /** Directory to watch for new replays. */
  replayDir: string;
  /** Roots to scan for local .osu beatmap files. */
  beatmapRoots: string[];
  /** lazer's cached beatmap metadata database, if present. */
  onlineDb: string | null;
}

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function lazerCandidates(): string[] {
  const out: string[] = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'osu'));
  if (process.env.HOME) {
    out.push(path.join(process.env.HOME, '.local', 'share', 'osu'));
    out.push(path.join(process.env.HOME, 'Library', 'Application Support', 'osu'));
  }
  return out;
}

function stableCandidates(): string[] {
  const out: string[] = [];
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'osu!'));
  for (const drive of ['C:/', 'D:/', 'E:/']) {
    out.push(path.join(drive, 'osu!'));
    out.push(path.join(drive, 'Program Files', 'osu!'));
    out.push(path.join(drive, 'Program Files (x86)', 'osu!'));
  }
  return out;
}

export function detectInstalls(): OsuInstall[] {
  const found: OsuInstall[] = [];

  for (const root of lazerCandidates()) {
    // client.realm is the reliable marker: `files/` alone can exist for other reasons.
    if (!exists(path.join(root, 'client.realm'))) continue;
    const files = path.join(root, 'files');
    if (!exists(files)) continue;
    const onlineDb = path.join(root, 'online.db');
    found.push({
      kind: 'lazer',
      root,
      // lazer writes replays into its content-addressed store, same as every other file.
      replayDir: files,
      beatmapRoots: [files],
      onlineDb: exists(onlineDb) ? onlineDb : null,
    });
    break;
  }

  for (const root of stableCandidates()) {
    if (!exists(path.join(root, 'osu!.exe'))) continue;
    const replayDir = path.join(root, 'Data', 'r');
    const songs = path.join(root, 'Songs');
    found.push({
      kind: 'stable',
      root,
      replayDir,
      beatmapRoots: exists(songs) ? [songs] : [],
      onlineDb: null,
    });
    break;
  }

  return found;
}
