/**
 * Rebuild every tracked score from the replay files on disk.
 *
 * Use after a calculation fix or an osu! pp rework: the replays are the source of truth,
 * so nothing is lost by recomputing from them. Only replays played after the profile's
 * tracking_since are considered, exactly as live tracking would.
 *
 *   node scripts/reingest.mjs [profileName]
 *
 * Stop the app first -- it holds the database open for writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, getOrCreateProfile } from '../src/db/index.ts';
import { detectInstalls } from '../src/clients/detect.ts';
import { BeatmapResolver } from '../src/clients/beatmaps.ts';
import { looksLikeReplay } from '../src/osr.ts';
import { ingestReplayFile } from '../src/tracker/ingest.ts';
import { loadConfig } from '../src/config.ts';
import { OfficialCalculator } from '../src/calc/official.ts';

const config = loadConfig();
const profileName = process.argv[2] ?? config.profileName;

const installs = detectInstalls();
if (installs.length === 0) {
  console.error('no osu! installation found');
  process.exit(1);
}

const db = openDb(path.join(process.cwd(), 'data', 'profiles.db'));
const profileId = getOrCreateProfile(db, profileName);
const { tracking_since: since } = db
  .prepare('SELECT tracking_since FROM profiles WHERE id = ?')
  .get(profileId);

const before = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE profile_id = ?').get(profileId).n;
console.log(`profile "${profileName}": ${before} scores, tracking since ${new Date(since).toLocaleString()}`);

// Replays are only worth reading if they were written after tracking started.
const candidates = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs >= since) candidates.push(p);
  }
})(installs[0].replayDir);

const head = Buffer.alloc(8);
const replays = candidates.filter((p) => {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return false; }
  const n = fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  return looksLikeReplay(head.subarray(0, n));
});
console.log(`${candidates.length} files newer than tracking start, ${replays.length} of them replays`);

const resolver = new BeatmapResolver(db, installs);
const official = await OfficialCalculator.create();
if (!official) {
  // Bail out before touching stored scores: without the calculator this would replace
  // every score with a pp-less one.
  console.error('the pp calculator is not built -- run: npm run build:pp');
  process.exit(1);
}
console.log("using osu!'s official calculator");

db.prepare('DELETE FROM scores WHERE profile_id = ?').run(profileId);
const ctx = { db, resolver, profileId, trackingSince: since, official };

let added = 0;
const skipped = {};
for (const file of replays) {
  const result = await ingestReplayFile(file, ctx);
  if (result.status === 'added') {
    added++;
    const s = result.score;
    console.log(
      `  ${s.grade.padEnd(2)} ${(s.accuracy * 100).toFixed(2)}%  ` +
      `${s.pp === null ? '   -  ' : `${s.pp.toFixed(0).padStart(4)}pp`}  ` +
      `${s.modsLabel.padEnd(6)} ${(s.stars?.toFixed(2) ?? '-').padStart(5)}*  ${s.title}`,
    );
  } else {
    skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
  }
}

console.log(`\nre-ingested ${added} scores` + (Object.keys(skipped).length ? `  (skipped: ${JSON.stringify(skipped)})` : ''));
official?.dispose();
db.close();
