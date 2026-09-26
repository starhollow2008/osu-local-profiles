import { syncFavoriteSharing } from './favorites.ts';
import fs from 'node:fs';
import path from 'node:path';
import { offerWelcome } from './welcome.ts';
import { loadConfig, saveConfig, dataDir, type Config } from './config.ts';
import { openBrowser } from './browser.ts';
import { discoverInstalls, type DiscoveryResult } from './clients/discover.ts';
import { osuFolderService } from './clients/folders.ts';
import { backfillOriginalMetadata, BeatmapResolver } from './clients/beatmaps.ts';
import { openDb } from './db/index.ts';
import { activeProfileId, getProfile, seedFirstProfile } from './profiles.ts';
import { Tracker, type IndexState } from './tracker/index.ts';
import { catchUpSince, HEARTBEAT_MS, lastRunAt, markRunning } from './tracker/catch-up.ts';
import { explainWatchError } from './tracker/watcher.ts';
import { startServer } from './http/server.ts';
import {
  checkForUpdate,
  launchedFromTray,
  pruneUpdateLeftovers,
  RESTART_EXIT_CODE,
  SWAPPER_PID_FILE,
} from './update/index.ts';
import { applyPendingRestore } from './backup.ts';
import { recalculatedFor, recalculationBatches } from './tracker/recompute.ts';
import { runningInstance, stopWhenLauncherCloses } from './instance.ts';
import { OfficialCalculator } from './calc/official.ts';
import { computeStats } from './calc/stats.ts';
import { estimateRank } from './calc/rank.ts';
import { eligibilityOf } from './calc/eligibility.ts';
import { getSettings } from './settings.ts';
import { replayPlayer, sweepForeignScores, type ReplayPlayer } from './player-identity.ts';
import { parseReplay } from './osr.ts';

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

/**
 * Write down what the search found, so the next launch does not have to search again.
 *
 * Only the roots the app worked out are stored; `installRoots` is the user's and is never
 * written to from here. `searchedForInstalls` latches on, including when the search found
 * nothing at all -- that is the case worth remembering, because it is the one that would
 * otherwise walk every drive on every launch forever.
 *
 * Saved only when something changed, so a normal start still writes the config file exactly
 * once, at the top of `main`.
 */
function rememberDiscovery(config: Config, discovery: DiscoveryResult): void {
  const discovered = discovery.candidates
    .filter((c) => c.source !== 'configured')
    .map((c) => c.root);
  const searched = config.searchedForInstalls || discovery.searched;
  const same =
    searched === config.searchedForInstalls &&
    discovered.length === config.discoveredRoots.length &&
    discovered.every((root, i) => root === config.discoveredRoots[i]);
  if (same) return;

  config.discoveredRoots = discovered;
  config.searchedForInstalls = searched;
  saveConfig(config);
}

/** Started by the tray launcher: no console, and it stops when the launcher does. */
const fromTray = launchedFromTray();

async function main(): Promise<void> {
  console.log('\n  osu! local profiles');
  console.log('  -------------------');

  const config = loadConfig();
  saveConfig(config);

  /*
   * Already running: open that copy's page rather than starting a second one, which would
   * only fail on the port. Starting the app again is how to find it again -- see
   * src/instance.ts. `--check-only` never serves, so it has nothing to collide with.
   */
  if (!checkOnly) {
    const running = await runningInstance(config.port);
    if (running) {
      const url = `http://localhost:${config.port}`;
      banner(`Already running${running.version ? ` (${running.version})` : ''} -> ${url}`);
      console.log('  Opened its page instead of starting a second copy.\n');
      openBrowser(url);
      return;
    }
  }

  /*
   * Where osu! is.
   *
   * `config.installRoots` -- what the user pointed at from the page -- is tried first and is
   * never overruled. After that it is `discoverInstalls`, which asks the machine what it
   * already knows before it goes looking, and only walks the drives when a client is still
   * unaccounted for. See `src/clients/discover.ts` for why the search runs when *either*
   * client is missing rather than only when both are.
   */
  const discovery = await discoverInstalls({
    configured: config.installRoots,
    remembered: config.discoveredRoots,
    // A search that has already happened is not repeated on every launch. The cheap tiers
    // still run, so a stable installed since then is still found; only the walk is skipped.
    noSearch: config.searchedForInstalls,
    onProgress: (p) => process.stdout.write(`\r  searching for osu!... ${p.dirs} folders`),
  });
  const installs = discovery.installs;
  rememberDiscovery(config, discovery);

  if (installs.length === 0) {
    banner('No osu! installation found.');
    console.log(`  Looked for osu!lazer (${lazerSearchHint()})`);
    console.log('  osu!stable (a folder containing osu!.exe) and McOsu (in any Steam library),');
    console.log(
      discovery.searched
        ? '  in the registry, in your shortcuts, and through every drive on this machine.'
        : '  everywhere they are normally installed.',
    );
    console.log('  The page opens anyway: use Options -> osu! folders to point at it.');

    /*
     * A diagnostic that stops at the first problem makes you run it twice. "osu! is not
     * where I looked" and "the pp helper will not start" are separate faults with separate
     * fixes, so `--check-only` reports both from one run -- which also lets CI, where there
     * is never an osu! install, still check that the helper works on that platform.
     */
    if (checkOnly) {
      process.exitCode = 1;
      await reportPpCalculator();
      return;
    }
    /*
     * ...but a normal run carries on, with nothing to watch.
     *
     * It used to stop here, and stopping was the worst possible answer: the one thing that
     * fixes a missed install is telling the app where osu! is, and the place to tell it is
     * the page -- which an app that has exited is not serving. So the whole of it starts,
     * the tracker watches nothing, and Options -> osu! folders is there to be used.
     *
     * A folder added there takes effect on the next start, not immediately: the watchers and
     * the beatmap resolver are built from the install list once, and the resolver holds open
     * handles on lazer's `online.db`. Rebuilding both at runtime is a bigger change than the
     * problem deserves, so the page says to restart and means it.
     */
  }

  for (const i of installs) {
    console.log(`  found ${i.kind.padEnd(6)} ${i.root}${i.onlineDb ? '  (+ online.db)' : ''}`);
  }
  // More than one of a kind means a choice was made on the user's behalf. Say so, once,
  // rather than leaving them to wonder why it is tracking the practice copy.
  const extra = discovery.candidates.length - installs.length;
  if (extra > 0) {
    console.log(`  (${extra} other osu! folder(s) found -- Options -> osu! folders to switch)`);
  }

  const dbFile = path.join(dataDir(), 'profiles.db');
  // Decided before openDb creates the file: only a brand-new install is welcomed, never one
  // upgraded from a version that had no welcome. `npm run package` deletes the data/ its own
  // --check-only run makes, so a download still starts new.
  /*
   * A backup restored from the page is swapped in here, before anything opens the database
   * it replaces -- see src/backup.ts. What it replaced is moved aside, never deleted.
   */
  const restored = applyPendingRestore(dataDir());
  if (restored.applied) {
    console.log(`\n  Restored a backup. What was here before is in ${restored.aside}\n`);
  } else if (restored.error) {
    console.log(`\n  The backup could not be restored, and nothing was changed: ${restored.error}\n`);
  }
  const firstRun = !fs.existsSync(dbFile);
  const db = openDb(dbFile);
  /*
   * A restored database remembers the app last running when the backup was made. Left alone,
   * `importPlaysWhileClosed` would read everything since then as a gap the app was closed for
   * and import it -- but the app was running for all of it, only on the data now aside.
   */
  if (restored.applied) markRunning(db);

  // config.profileName only seeds the very first profile. After that the set of profiles
  // lives in the database and which one is live is chosen from the page, so that renaming
  // or switching never has to round-trip through a config file.
  seedFirstProfile(db, config.profileName);
  if (firstRun) offerWelcome(db);
  const active = getProfile(db, activeProfileId(db))!;
  const profileId = active.id;
  const profileName = active.name;

  /*
   * When this app was last running, read before anything writes it again. It is the cutoff
   * for `importPlaysWhileClosed` -- the gap between that moment and now is the only stretch a
   * launch may bring in -- and null on a first launch, which means no catch-up at all.
   */
  const gapSince = catchUpSince(lastRunAt(db), active.trackingSince);

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
    console.log('  Build it with:  npm run build:pp    (needs the .NET 10 SDK)');
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
    const rules = eligibilityOf(getSettings(db, tracker.profileId), tracker.beatmaps.knowsStatus);

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
    // Labelled apart: an attempt osu! could not submit may not count at all, depending on the
    // profile's setting, and a line that read like a counted play would say otherwise.
    const what = play.unsubmitted ? 'not submitted to osu!' : 'did not finish';
    console.log(`  [${time}]   --   -- ${what.padEnd(22)}${play.title}`);
  });
  /*
   * A play the tracking filter declined. Worth a line of its own: no row is written anywhere,
   * so without this the play simply does not appear and a filter set a notch too tight looks
   * exactly like tracking having stopped.
   */
  tracker.on('filtered', (play) => {
    const time = new Date(play.at).toLocaleTimeString();
    console.log(`  [${time}] not tracked -- ${play.criterion.padEnd(13)} ${play.title}`);
  });
  /*
   * A replay somebody else set, or one that could not be read. osu! caches the replays you
   * watch beside the ones you play, so the first is a normal thing to see -- but it has to be
   * *seen*, because a profile quietly collecting other people's plays is exactly the failure
   * the check exists to end, and a wrong refusal is a play of your own gone. The page says so
   * too: the tray launcher hides this console.
   */
  tracker.on('refused', (play) => {
    const time = new Date(play.at).toLocaleTimeString();
    console.log(
      play.reason === 'another-player'
        ? `  [${time}] not tracked -- set by ${play.player || 'another player'}: ${play.title}`
        : `  [${time}] not tracked -- a replay that could not be read`,
    );
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
  // McOsu's Songs folder is a stable one -- usually stable's own, so it is walked only once.
  const roots = installs
    .flatMap((i) => i.beatmapRoots.map((p) => ({ path: p, byExtension: i.kind !== 'lazer' })))
    .filter((r, n, all) => all.findIndex((o) => path.resolve(o.path).toLowerCase() === path.resolve(r.path).toLowerCase()) === n);
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
  void tracker.indexBeatmaps(roots).then(async () => {
    tracker.off('indexing', onIndexing);
    const s = tracker.indexState;
    if (s.error) console.log(`  beatmap index failed: ${s.error}`);
    else if (s.indexed > 0 || s.firstRun) {
      const total = (db.prepare('SELECT COUNT(*) AS n FROM osu_files').get() as { n: number }).n;
      console.log(`  ${total.toLocaleString()} beatmaps indexed (${s.indexed.toLocaleString()} new)\n`);
    }
    /*
     * Original-language titles for beatmaps cached before there were columns to hold them.
     * After the index, so a beatmap it has just found is one whose names can be read; and
     * unannounced, because it is one pass over the maps actually played and finishes well
     * inside the time the index above takes. See backfillOriginalMetadata.
     */
    await backfillOriginalMetadata(db).catch(() => 0);

    /*
     * The plays set while the app was closed, for a profile that asked for them. After the
     * index for the same reason a live play waits for it: a beatmap resolved before its file
     * is indexed caches "not found" and leaves the score with no pp.
     *
     * Queued like every other import, so a play landing right now is ingested before or after
     * it and never during. Nothing happens at all unless the setting is on -- see
     * Tracker.catchUp.
     */
    const caught = await tracker.catchUp(gapSince).catch(() => null);
    if (caught && caught.imported + caught.unfinished + caught.attempts > 0) {
      const parts = [
        `${caught.imported} score(s)`,
        `${caught.unfinished} unfinished`,
        `${caught.attempts} not submitted`,
      ];
      console.log(`\n  Brought in what was played while the app was closed: ${parts.join(', ')}`);
      if (caught.filtered > 0) console.log(`  (${caught.filtered} declined by the tracking filter)`);
    }

    /*
     * Ranked statuses brought up to date with lazer's online.db, a snapshot it downloads about
     * once a month: a map ranked since the last one was stored with no status, and is put right
     * once a newer snapshot has it. Only when the file has changed. See refreshBeatmapStatuses.
     */
    const statuses = await tracker.refreshStatuses().catch((e: Error) => {
      console.log(`  ranked status refresh failed: ${e.message}`);
      return null;
    });
    if (statuses && statuses.scores > 0) {
      console.log(`  Ranked status updated for ${statuses.beatmaps} beatmap(s), from osu!lazer's newer beatmap list\n`);
    }

    /*
     * Plays stored wrongly by an older version, put right from their replays: ones on a
     * beatmap the index has only now found, and -- once -- stable plays whose mods were read
     * from part of their bitmask. After the index, which both need. See Tracker.repairScores.
     */
    const repaired = await tracker.repairScores().catch((e: Error) => {
      console.log(`  score repair failed: ${e.message}`);
      return null;
    });
    if (repaired && repaired.considered > 0) {
      console.log(
        `  Put right ${repaired.considered} score(s) stored before this version could read them fully` +
          `${repaired.gainedPp > 0 ? ` (${repaired.gainedPp} now have pp)` : ''}\n`,
      );
    }

    /*
     * An update that brings a new osu! release -- a pp rework, typically -- reprices what the
     * old one priced, on its first launch, so no profile ranks scores from two algorithms
     * against each other. After the index for the reason above: a beatmap not yet indexed
     * would price as missing. See Tracker.recalculateAfterUpdate.
     */
    const outdated = official?.version ? recalculationBatches(db, official.version) : [];
    if (outdated.length > 0 && recalculatedFor(db) !== official?.version) {
      const n = outdated.reduce((sum, b) => sum + b.ids.length, 0);
      console.log(`\n  pp: osu! ${official?.version} is new here -- recalculating ${n} score(s) priced by an older release`);
    }
    const repriced = await tracker.recalculateAfterUpdate().catch((e: Error) => {
      console.log(`  pp recalculation failed: ${e.message}`);
      return null;
    });
    if (repriced) {
      const { updated, skipped } = repriced.result;
      console.log(
        `  pp: recalculated ${updated} score(s) with osu! ${repriced.release}` +
          `${skipped > 0 ? ` (${skipped} left as they were: replay or beatmap no longer on disk)` : ''}\n`,
      );
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
    onQuit: () => shutdown(),
    /*
     * Only the tray launcher: it starts the app again on the updater's exit code, and with no
     * update in progress there is no swap to wait for. `start.sh`'s terminal loop would too,
     * but announces it as installing an update.
     */
    onRestart: fromTray ? () => shutdown(RESTART_EXIT_CODE) : undefined,
    launcher: fromTray ? 'tray' : 'terminal',
    /*
     * The page's "Open in browser on start" toggle. It is install-level, not per profile --
     * it decides what happens before any profile is on screen -- so it lives in config.json
     * beside the port, and is re-read from disk before each write so a hand edit made while
     * the app runs is not overwritten.
     */
    appConfig: {
      get: () => ({
        openBrowser: config.openBrowser,
        sharedFavorites: config.sharedFavorites,
        language: config.language,
        originalMetadata: config.originalMetadata,
      }),
      set: (patch) => {
        const current = loadConfig();
        if (patch.openBrowser !== undefined) current.openBrowser = config.openBrowser = patch.openBrowser;
        if (patch.language !== undefined) current.language = config.language = patch.language;
        if (patch.originalMetadata !== undefined) {
          current.originalMetadata = config.originalMetadata = patch.originalMetadata;
        }
        if (patch.sharedFavorites !== undefined) {
          current.sharedFavorites = config.sharedFavorites = patch.sharedFavorites;
          // Merge or copy the lists now, so the next request already reads the right one.
          syncFavoriteSharing(db, patch.sharedFavorites);
        }
        saveConfig(current);
      },
    },
    /*
     * Options -> osu! folders. The one repair for an install the app did not find, and it
     * has to live on the page: whoever needs it is whoever the app has already failed, and
     * they should not have to edit JSON to be heard. Writes `config.json` through the same
     * re-read-then-save as above, so a hand edit made while the app runs survives.
     */
    osuFolders: osuFolderService({
      config,
      save: (next) => {
        const current = loadConfig();
        current.installRoots = next.installRoots;
        current.discoveredRoots = next.discoveredRoots;
        current.searchedForInstalls = next.searchedForInstalls;
        saveConfig(current);
      },
      tracking: installs,
      initial: discovery,
    }),
  });

  // Before any request is answered: the lists must agree with the setting as it stands.
  syncFavoriteSharing(db, config.sharedFavorites !== false);

  const url = `http://localhost:${config.port}`;
  // The banner reports osu!standard; other modes are a click away on the page.
  const standing = computeStats(
    db,
    profileId,
    0,
    eligibilityOf(getSettings(db, profileId), tracker.beatmaps.knowsStatus),
  );
  const standingRank = estimateRank(standing.totalPp, 0);
  banner(`Tracking "${profileName}" -> ${url}`);
  console.log(
    `  ${standing.playcount} play(s), ${standing.totalPp.toFixed(0)}pp` +
      `${standingRank ? `, around #${standingRank.rank.toLocaleString()}` : ', unranked'}` +
      `, level ${standing.level.current}`,
  );
  console.log('  Play osu! (online or offline) and scores will appear below.');
  /*
   * Said every launch, because it is the one thing about tracking that is decided by when the
   * app is open rather than by anything on the page: plays set while it was closed are not
   * picked up when it opens again (see `Tracker.liveCutoff`). Anyone who did want them has two
   * answers now -- once, or every launch -- and both should be on screen rather than found by
   * hunting through the menu.
   *
   * The wording follows the setting rather than describing both cases: a profile that has
   * turned catching up on should not be told every launch that it does not happen.
   */
  if (getSettings(db, profileId).importPlaysWhileClosed) {
    console.log('  Plays set while this app was closed are brought in when it opens.');
    console.log('  Options -> Other settings turns that off.');
  } else {
    console.log('  Plays set while this app is closed are not tracked.');
    console.log('  Options -> Import past plays brings them in if you want them,');
    console.log('  and Other settings can have every launch do it for you.');
  }
  if (installs.some((i) => i.kind === 'lazer')) {
    // Worth saying plainly, because the difference is invisible otherwise. Signed in, an
    // unfinished play counts when osu! counted it; offline or signed out, osu! submits
    // nothing, so the attempt is read from its log instead -- and counts unless Settings says
    // not to.
    console.log('  Unfinished plays (quit, retried, failed) count too, online or offline.');
  }
  if (installs.some((i) => i.kind === 'mcosu')) {
    // McOsu saves a play only once it is finished and passed, and keeps no log, so the rest
    // leave nothing to count. Its pp here is osu!'s own, not McOsu's.
    console.log("  McOsu: finished plays are tracked, priced by osu!'s own calculator; quits,");
    console.log('  retries and fails are not, because McOsu records nothing of them.');
  }
  /*
   * Said at start-up only when the filter can actually turn a play away. A profile that has
   * set one and forgotten about it would otherwise look broken the first time a play did not
   * appear, and this is the one setting whose effect cannot be undone afterwards.
   */
  if (tracker.filterNarrowing) {
    console.log('  A play tracking filter is on -- plays it declines are not recorded at all.');
  }
  /*
   * Who the profile belongs to, and how it knows. Worth a line because it decides which
   * replays are tracked at all: osu! caches the replays you watch in the same folders as the
   * ones you set, and only the name inside them tells the two apart. A profile that cannot
   * say who it is tracks everything, as it always did, and should say so.
   */
  const identity = tracker.playerIdentity;
  if (identity.source === 'unknown') {
    console.log('  Not sure whose plays these are, so every replay found is tracked.');
    console.log("  Signing in to osu! with 'remember username' on settles it.");
  } else {
    const earlier = identity.names.size - 1;
    console.log(
      `  Tracking plays set by ${identity.displayName || `user ${identity.userId}`}` +
        `${earlier > 0 ? ` (and ${earlier} earlier name${earlier === 1 ? '' : 's'})` : ''}` +
        ' -- replays you watched are not counted.',
    );
  }
  console.log(
    fromTray
      ? '  Quit from the tray icon, or with Quit on the page.\n'
      : '  Close this window, press Ctrl+C, or press Quit on the page to stop tracking.\n',
  );

  // Restarted from the page to restore a backup, that page reloads itself: no second tab.
  if (config.openBrowser && !(restored.applied && fromTray)) openBrowser(url);

  /*
   * Tidy away what a previous update left, then ask once whether there is a newer release.
   * Both are deliberately after the banner and the browser: neither is allowed to delay the
   * app being usable, and a failed check is not worth a word on screen -- the page simply
   * has no update button to show.
   *
   * The cleanup *is* worth a word, because it is hundreds of megabytes and silently
   * reclaiming that much disk should not be invisible.
   */
  /*
   * Once per profile: take out the plays somebody else set that were tracked before this
   * check existed. Every one is a *hide*, so it appears under Removed scores and can be put
   * back -- which is what makes doing it unprompted defensible.
   *
   * Only ever on a linked account, because only that brings osu!'s list of previous
   * usernames, and without it a play set before a rename looks exactly like a stranger's.
   * Queued behind ingestion like every other write, and after the banner so it never delays
   * the app being usable.
   */
  const sweptKey = `foreignScoresSwept:${profileId}`;
  const alreadySwept =
    db.prepare('SELECT 1 AS hit FROM kv WHERE key = ?').get(sweptKey) !== undefined;
  /*
   * `namesComplete` as well as `linked`: an account linked by a version that never asked osu!
   * for previous usernames has an empty list, and an empty list cannot be told from one
   * nobody fetched. Marking such a profile swept would spend its one chance for nothing --
   * so it is left unmarked, and the next launch after an Import from osu! does it properly.
   */
  if (!alreadySwept && identity.source === 'linked' && identity.namesComplete) {
    const readPlayer = async (file: string): Promise<ReplayPlayer | null> => {
      try {
        return replayPlayer(await parseReplay(fs.readFileSync(file)));
      } catch {
        // Gone, or unreadable. Such a row cannot be attributed and is left alone.
        return null;
      }
    };
    const sweep = await sweepForeignScores(db, profileId, identity, readPlayer);
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(sweptKey, '1');
    if (sweep.hidden > 0) {
      const who = sweep.byPlayer
        .slice(0, 4)
        .map((p) => `${p.name} (${p.count})`)
        .join(', ');
      console.log(
        `  Removed ${sweep.hidden} play(s) set by someone else -- replays you watched: ` +
          `${who}${sweep.byPlayer.length > 4 ? `, and ${sweep.byPlayer.length - 4} more` : ''}`,
      );
      console.log('  They are in Options -> Other settings -> Removed scores if any are yours.\n');
    }
  }

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

  // Reachable four ways now -- Ctrl+C, a signal, the page's Quit and the tray -- and two can
  // arrive together, so only the first one stops anything.
  /*
   * Record that the app is running, so the next launch knows where the gap it was closed for
   * begins. Written now, at shutdown, and on a slow heartbeat in between -- see
   * src/tracker/catch-up.ts for why a stamp that errs early is the safe kind.
   */
  markRunning(db);
  const heartbeat = setInterval(() => markRunning(db), HEARTBEAT_MS);
  heartbeat.unref();

  let stopping = false;
  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    console.log('\n  stopping...');
    clearInterval(heartbeat);
    tracker.stop();
    // The last thing written before the database closes: everything after this instant
    // happened while the app was shut, which is exactly what the next launch may bring in.
    markRunning(db);
    official?.dispose();
    server.close();
    db.close();
    if (code === RESTART_EXIT_CODE) {
      // Left by an update long finished, a swapper pid would have the launcher wait on
      // whatever process has that number now.
      fs.rmSync(path.join(dataDir(), 'update', SWAPPER_PID_FILE), { force: true });
    }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  if (fromTray) stopWhenLauncherCloses(process.stdin, () => shutdown());
}

await main();
