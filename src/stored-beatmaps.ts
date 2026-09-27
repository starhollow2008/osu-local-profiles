import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db/index.ts';
import { indexOneFile, type BeatmapResolver } from './clients/beatmaps.ts';
import { fetchBeatmapFile } from './clients/osu-web.ts';

/**
 * Beatmap files this app downloaded, for a score imported from its link or entered by hand on a
 * beatmap that is not installed.
 *
 * osu!'s calculator prices a play against its beatmap's `.osu` file, so a score on a map this
 * machine does not have cannot be priced without one. osu! serves any beatmap's file to anyone,
 * and it is fetched once, when the score is imported, then kept here in `data/beatmaps/` --
 * indexed like any other, so every recalculation after that is offline -- and carried by Back
 * up everything, so a restore does not need the internet either. Named by its MD5, which is
 * checked against the score's: osu! serves a beatmap's *current* version, and a map updated
 * since the play is a different map, on which the play cannot be priced.
 */

export const BEATMAPS_DIR = 'beatmaps';

/** A stored beatmap's path relative to `data/`, as a backup lists it. */
export const isStoredBeatmap = (relative: string): boolean => /^beatmaps\/[0-9a-f]{32}\.osu$/.test(relative);

/** Keep a downloaded beatmap and index it. Returns its path and MD5. */
export function storeBeatmapFile(db: Db, dataDir: string, bytes: Buffer): { path: string; md5: string } {
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  const dir = path.join(dataDir, BEATMAPS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${md5}.osu`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  indexOneFile(db, file);
  return { path: file, md5 };
}

/**
 * The `.osu` file a score on beatmap `md5` needs: the one installed, or else osu!'s, downloaded
 * and kept. Throws with a message worth showing when neither can be had.
 */
export async function ensureBeatmapFile(
  db: Db,
  resolver: BeatmapResolver,
  dataDir: string,
  beatmap: { id: number; md5: string },
): Promise<string> {
  const local = resolver.resolve(beatmap.md5).osuPath;
  if (local !== null && fs.existsSync(local)) return local;

  const stored = storeBeatmapFile(db, dataDir, await fetchBeatmapFile(beatmap.id));
  if (stored.md5 !== beatmap.md5) {
    fs.rmSync(stored.path, { force: true });
    db.prepare('DELETE FROM osu_files WHERE path = ?').run(stored.path);
    throw new Error(
      'this beatmap has been updated on osu! since the score was set, and its old version cannot be downloaded to price it',
    );
  }
  return stored.path;
}
