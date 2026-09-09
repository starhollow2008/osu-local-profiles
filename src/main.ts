import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, dataDir } from './config.ts';
import { detectInstalls } from './clients/detect.ts';
import { BeatmapResolver, indexBeatmapFiles } from './clients/beatmaps.ts';
import { getOrCreateProfile, openDb } from './db/index.ts';
import { Tracker } from './tracker/index.ts';
import { startServer } from './http/server.ts';
import { OfficialCalculator } from './calc/official.ts';

const MODE_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

function banner(text: string): void {
  console.log(`\n  ${text}`);
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the URL is printed anyway */
  }
}

async function main(): Promise<void> {
  console.log('\n  osu! fresh profile');
  console.log('  ------------------');

  const config = loadConfig();
  saveConfig(config);

  const installs = detectInstalls();
  if (installs.length === 0) {
    banner('No osu! installation found.');
    console.log('  Looked for osu!lazer (%APPDATA%/osu) and osu!stable (osu!.exe).');
    console.log(`  Set "installRoots" in ${path.join(dataDir(), 'config.json')} and restart.`);
    process.exitCode = 1;
    return;
  }

  for (const i of installs) {
    console.log(`  found ${i.kind.padEnd(6)} ${i.root}${i.onlineDb ? '  (+ online.db)' : ''}`);
  }

  const db = openDb(path.join(dataDir(), 'profiles.db'));
  const profileId = getOrCreateProfile(db, config.profileName);
  const profile = db
    .prepare('SELECT tracking_since FROM profiles WHERE id = ?')
    .get(profileId) as { tracking_since: number };

  // The MD5 -> path index is what lets a score be matched to its beatmap offline.
  banner('Indexing local beatmaps (first run takes a minute)...');
  const roots = installs.flatMap((i) => i.beatmapRoots);
  let lastReport = 0;
  const { scanned, indexed } = indexBeatmapFiles(db, roots, (s) => {
    if (s - lastReport >= 10000) {
      lastReport = s;
      process.stdout.write(`\r  scanned ${s} new files...`);
    }
  });
  const totalIndexed = (db.prepare('SELECT COUNT(*) AS n FROM osu_files').get() as { n: number }).n;
  process.stdout.write('\r');
  console.log(`  ${totalIndexed} beatmaps indexed (${indexed} new, ${scanned} files examined)`);

  // There is no fallback calculator on purpose: a second implementation would disagree
  // by a few percent and leave one profile holding scores computed two different ways.
  const official = await OfficialCalculator.create();
  if (official) {
    console.log("  pp: osu!'s official calculator");
  } else {
    console.log('');
    console.log('  WARNING: the pp calculator is not available.');
    console.log('  Scores will still be tracked, but with no pp or star rating.');
    console.log('  Build it with:  npm run build:pp    (needs the .NET 8 SDK)');
    console.log('  Then run:       node scripts/reingest.mjs    to fill in the missing values.');
  }

  const resolver = new BeatmapResolver(db, installs);
  const tracker = new Tracker({
    db,
    resolver,
    installs,
    profileId,
    trackingSince: profile.tracking_since,
    official,
  });

  tracker.on('score', (s) => {
    const pp = s.pp === null ? (s.ranked ? '  --  ' : ' unrkd') : `${s.pp.toFixed(0).padStart(4)}pp`;
    const stars = s.stars === null ? '' : ` ${s.stars.toFixed(2)}*`;
    const time = new Date(s.playedAt).toLocaleTimeString();
    console.log(
      `  [${time}] ${pp}  ${s.grade.padEnd(2)} ${(s.accuracy * 100).toFixed(2)}%  ` +
        `${s.modsLabel.padEnd(6)}${stars}  ${s.title}`,
    );
  });
  tracker.on('error', (e) => console.error(`  watcher error: ${e.message}`));

  tracker.start();
  const server = startServer({
    db,
    tracker,
    installs,
    profileId,
    profileName: config.profileName,
    country: config.country,
    tagline: config.tagline,
    dataDir: dataDir(),
    port: config.port,
  });

  const url = `http://localhost:${config.port}`;
  banner(`Tracking "${config.profileName}" -> ${url}`);
  console.log('  Play osu! (online or offline) and scores will appear below.');
  console.log('  Close this window or press Ctrl+C to stop tracking.\n');

  if (config.openBrowser) openBrowser(url);

  const shutdown = () => {
    console.log('\n  stopping...');
    tracker.stop();
    official?.dispose();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
