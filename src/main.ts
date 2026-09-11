import { syncFavoriteSharing } from './favorites.ts';
import path from 'node:path';
import { loadConfig, saveConfig, dataDir } from './config.ts';
import { openBrowser } from './browser.ts';
import { detectInstalls } from './clients/detect.ts';
import { BeatmapResolver } from './clients/beatmaps.ts';
import { openDb } from './db/index.ts';
import { activeProfileId, getProfile, seedFirstProfile } from './profiles.ts';
import { Tracker, type IndexState } from './tracker/index.ts';
import { explainWatchError } from './tracker/watcher.ts';
import { startServer } from './http/server.ts';
import { checkForUpdate, pruneUpdateLeftovers } from './update/index.ts';
import { OfficialCalculator } from './calc/official.ts';
import { computeStats } from './calc/stats.ts';
import { estimateRank } from './calc/rank.ts';
import { eligibilityOf } from './calc/eligibility.ts';
import { getSettings } from './settings.ts';

const MODE_NAMES = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

/** Verify the install and exit, rather than starting to track. */
const checkOnly = process.argv.includes('--check-only');

function banner(text: string): void {
  console.log(`\n  ${text}`);
}

/** Start the pp helper, say whether it worked, and shut it down again. */
async function reportPpCalculator(): Promise<boolean> {
  const official = await OfficialCalculator.create();
  if (official) {
    console.log("\n  pp: osu!'s official calculator");
    official.dispose();
    return true;
  }
  console.log('\n  pp: NOT AVAILABLE -- scores would be tracked with no pp or star rating');
  return false;
}

/** Name the place this platform actually keeps lazer, rather than Windows' answer always. */
function lazerSearchHint(): string {
  if (process.platform === 'win32') return '%APPDATA%/osu';
  if (process.platform === 'darwin') return '~/Library/Application Support/osu';
  return '~/.local/share/osu';
}

async function main(): Promise<void> {
  console.log('\n  osu! local profiles');
  console.log('  -------------------');

  const config = loadConfig();
  saveConfig(config);

  // config.installRoots is tried before anything auto-detected. On macOS and Linux there is
  // no official osu!stable build to detect, only community Wine wrappers, so this is the
  // answer for a layout nobody anticipated.
  const installs = detectInstalls(config.installRoots);
  if (installs.length === 0) {
    banner('No osu! installation found.');
    console.log(`  Looked for osu!lazer (${lazerSearchHint()})`);
    console.log('  and osu!stable (a folder containing osu!.exe).');
    console.log(`  Set "installRoots" in ${path.join(dataDir(), 'config.json')} and restart:`);
    console.log('    "installRoots": ["/path/to/osu!"]');
    process.exitCode = 1;
    /*
     * A diagnostic that stops at the first problem makes you run it twice. "osu! is not
     * where I looked" and "the pp helper will not start" are separate faults with separate
     * fixes, so `--check-only` reports both from one run -- which also lets CI, where there
     * is never an osu! install, still check that the helper works on that platform.
     */
    if (checkOnly) await reportPpCalculator();
    return;
  }

  for (const i of installs) {
    console.log(`  found ${i.kind.padEnd(6)} ${i.root}${i.onlineDb ? '  (+ online.db)' : ''}`);
  }

  const db = openDb(path.join(dataDir(), 'profiles.db'));

  // config.profileName only seeds the very first profile. After that the set of profiles
  // lives in the database and which one is live is chosen from the page, so that renaming
  // or switching never has to round-trip through a config file.
  seedFirstProfile(db, config.profileName);
  const active = getProfile(db, activeProfileId(db))!;
  const profileId = active.id;
  const profileName = active.name;

  /*
   * `--check-only` verifies the install and exits: does it find osu!, and does it find the
   * pp calculator? It skips the beatmap index, which is slow and irrelevant to that
   * question. `npm run package` uses it to prove a packaged build works before shipping,
   * and it doubles as the first thing to run when something looks wrong.
   */
  if (checkOnly) {
    const ok = await reportPpCalculator();
    console.log(`  data: ${dataDir()}`);
    db.close();
    process.exitCode = ok ? 0 : 1;
    return;
  }

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
    trackingSince: active.trackingSince,
    official,
  });

  tracker.on('score', (s) => {
    // Read per score rather than captured: the page can change these while this is running.
    const rules = eligibilityOf(getSettings(db, tracker.profileId));

    // A score can now carry pp without counting -- an unranked map, or unranked mods the
    // settings have not opted into. The console has to say which, or the running total
    // underneath it looks broken.
    const counted = s.ranked || (rules.includeUnrankedMods && s.mapRanked);
    const shownPp = rules.preferStrippedPp && s.ppNomod !== null ? s.ppNomod : s.pp;

    const pp =
      shownPp === null
        ? s.mapRanked
          ? '  --  '
          : ' unrkd'
        : `${shownPp.toFixed(0).padStart(4)}pp${counted ? ' ' : '*'}`;
    const stars = s.stars === null ? '' : ` ${s.stars.toFixed(2)}*`;
    const time = new Date(s.playedAt).toLocaleTimeString();
    console.log(
      `  [${time}] ${pp} ${s.grade.padEnd(2)} ${(s.accuracy * 100).toFixed(2)}%  ` +
        `${s.modsLabel.padEnd(6)}${stars}  ${s.title}`,
    );

    // Where that play left the profile. The point of the whole app is the running total,
    // and reading it off the console beats switching to the browser for every score.
    if (counted && shownPp !== null) {
      const totals = computeStats(db, tracker.profileId, s.mode, rules);
      const rank = estimateRank(totals.totalPp, s.mode);
      console.log(
        `            -> ${totals.totalPp.toFixed(0)}pp` +
          `${rank ? `  #${rank.rank.toLocaleString()}` : ''}` +
          `  ${(totals.accuracy * 100).toFixed(2)}%  lv${totals.level.current}`,
      );
    } else if (shownPp !== null) {
      console.log('            -> does not count toward this profile');
    }
  });
  /*
   * A play osu! counted that produced no score -- a quit, a retry, an HP fail. There is no
   * grade, accuracy or pp to print, because lazer records none of it for a play it throws
   * away; only that it happened, and on what.
   */
  tracker.on('incomplete', (play) => {
    const time = new Date(play.playedAt).toLocaleTimeString();
    console.log(`  [${time}]   --   -- did not finish        ${play.title}`);
  });
  tracker.on('error', (e) => console.error(`  watcher error: ${explainWatchError(e)}`));

  /*
   * The MD5 -> path index is what lets a score be matched to its beatmap offline. It runs
   * beside the page rather than before it: on a first launch it opens every file in osu!'s
   * folder once, which on a big library read cold can take a long time, and a page that
   * would not load until then looks broken. Plays set meanwhile wait in the tracker's queue
   * and are added, with pp, as soon as it finishes; the page shows the progress.
   *
   * Started before the watchers, so no play can reach the queue ahead of it.
   */
  const roots = installs.flatMap((i) =>
    i.beatmapRoots.map((p) => ({ path: p, byExtension: i.kind === 'stable' })),
  );
  let lastLine = 0;
  const onIndexing = (s: IndexState) => {
    // Only a first run, or one that has turned out slow, is worth a line.
    if (!s.active || !s.visible || Date.now() - lastLine < 2000) return;
    lastLine = Date.now();
    const where =
      s.phase === 'counting'
        ? `looking through osu!'s files (${s.total.toLocaleString()} so far)`
        : `${Math.floor((s.scanned / Math.max(1, s.total)) * 100)}% of ${s.total.toLocaleString()} files`;
    console.log(`  indexing beatmaps: ${where}${s.waiting ? `, ${s.waiting} play(s) waiting` : ''}`);
  };
  tracker.on('indexing', onIndexing);
  void tracker.indexBeatmaps(roots).then(() => {
    tracker.off('indexing', onIndexing);
    const s = tracker.indexState;
    if (s.error) console.log(`  beatmap index failed: ${s.error}`);
    else if (s.indexed > 0 || s.firstRun) {
      const total = (db.prepare('SELECT COUNT(*) AS n FROM osu_files').get() as { n: number }).n;
      console.log(`  ${total.toLocaleString()} beatmaps indexed (${s.indexed.toLocaleString()} new)\n`);
    }
  });

  tracker.start();
  const server = startServer({
    db,
    tracker,
    installs,
    country: config.country,
    tagline: config.tagline,
    dataDir: dataDir(),
    port: config.port,
    /*
     * The page's "Open in browser on start" toggle. It is install-level, not per profile --
     * it decides what happens before any profile is on screen -- so it lives in config.json
     * beside the port, and is re-read from disk before each write so a hand edit made while
     * the app runs is not overwritten.
     */
    appConfig: {
      get: () => ({ openBrowser: config.openBrowser, sharedFavorites: config.sharedFavorites }),
      set: (patch) => {
        const current = loadConfig();
        if (patch.openBrowser !== undefined) current.openBrowser = config.openBrowser = patch.openBrowser;
        if (patch.sharedFavorites !== undefined) {
          current.sharedFavorites = config.sharedFavorites = patch.sharedFavorites;
          // Merge or copy the lists now, so the next request already reads the right one.
          syncFavoriteSharing(db, patch.sharedFavorites);
        }
        saveConfig(current);
      },
    },
  });

  // Before any request is answered: the lists must agree with the setting as it stands.
  syncFavoriteSharing(db, config.sharedFavorites !== false);

  const url = `http://localhost:${config.port}`;
  // The banner reports osu!standard; other modes are a click away on the page.
  const standing = computeStats(db, profileId, 0, eligibilityOf(getSettings(db, profileId)));
  const standingRank = estimateRank(standing.totalPp, 0);
  banner(`Tracking "${profileName}" -> ${url}`);
  console.log(
    `  ${standing.playcount} play(s), ${standing.totalPp.toFixed(0)}pp` +
      `${standingRank ? `, around #${standingRank.rank.toLocaleString()}` : ', unranked'}` +
      `, level ${standing.level.current}`,
  );
  console.log('  Play osu! (online or offline) and scores will appear below.');
  if (installs.some((i) => i.kind === 'lazer')) {
    // Worth saying plainly, because the difference is invisible otherwise: an unfinished
    // play is only counted when osu! counted it, and osu! only counts one it was told
    // about. Signed out or offline, the game does not submit and neither side counts it.
    console.log('  Unfinished plays (quit, retried, failed) count too, while osu! is signed in.');
  }
  console.log('  Close this window or press Ctrl+C to stop tracking.\n');

  if (config.openBrowser) openBrowser(url);

  /*
   * Tidy away what a previous update left, then ask once whether there is a newer release.
   * Both are deliberately after the banner and the browser: neither is allowed to delay the
   * app being usable, and a failed check is not worth a word on screen -- the page simply
   * has no update button to show.
   *
   * The cleanup *is* worth a word, because it is hundreds of megabytes and silently
   * reclaiming that much disk should not be invisible.
   */
  const leftovers = pruneUpdateLeftovers();
  if (leftovers.removed.length > 0) {
    console.log(
      `  Cleaned up after the last update: ${leftovers.removed.join(', ')}` +
        ` (${(leftovers.bytes / 1024 / 1024).toFixed(0)}MB)
`,
    );
  }
  if (config.checkForUpdates) {
    void checkForUpdate().then((u) => {
      if (u.available) console.log(`  Update available: ${u.latestVersion} (see the page)
`);
    });
  }

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
