import { aboutImageFile, saveAboutImage } from '../about-images.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { Tracker } from '../tracker/index.ts';
import type { OsuInstall } from '../clients/detect.ts';
import { isLocale } from '../i18n.ts';
import type { Ruleset } from '../osr.ts';
import { dismissWelcome, welcomePending } from '../welcome.ts';
import { backupFileName, createBackup, discardRestore, localDay, markRestoreReady, stageRestore } from '../backup.ts';
import { scoresTable, workbookTables } from '../export/tables.ts';
import { toCsv } from '../export/csv.ts';
import { toXlsx } from '../export/xlsx.ts';
import { translator } from '../export/words.ts';
import { openFolder } from '../browser.ts';
import {
  unsubmittedAttemptCount,
  computeStats,
  modesWithPlays,
  mostPlayed,
  mostPlayedTotal,
  recentPlayTotal,
  mostRecentMode,
  pinnedPlays,
  recentPlays,
  topPlays,
} from '../calc/stats.ts';
import { buildHistory, medalEvents } from '../calc/history.ts';

/**
 * osu! only ever weights the top 100 plays, so Best Performance cannot be longer than that
 * however many eligible maps a profile has.
 */
const TOP_PLAYS = 100;

/** Rulesets by `Ruleset`, for naming one in a message about an import that failed. */
const MODE_LABELS = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'] as const;

/** The most rows one request may ask a section for: see `MAX_PAGE_ROWS`. */
const MAX_PAGE = MAX_PAGE_ROWS;
import { computeMedals, earnedMedalCount, isAppMedal } from '../calc/medals.ts';
import { clearImportedMedals, saveImportedMedals } from '../imported-medals.ts';
import type { PpSourceService } from '../pp-source.ts';
import { estimateRank, rankTable } from '../calc/rank.ts';
import {
  activeProfileId,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  renameProfile,
  setActiveProfile,
} from '../profiles.ts';
import { getSettings, MAX_PAGE_ROWS, updateSettings, type Settings } from '../settings.ts';
import { appVersion, installDir } from '../config.ts';
import {
  applyUpdate,
  checkForUpdate,
  offeredVersion,
  onUpdateChange,
  prepareUpdate,
  updateState,
} from '../update/index.ts';
import { nudgeShown } from '../update/notes.ts';
import { dismissNudge, markSeen, nudgeDismissal, whatsNew } from '../update/whats-new.ts';
import { filterNarrows } from '../tracking-filter.ts';
import { REPLAYS_ONLY, type BackfillSources, type InstallChoice } from '../tracker/index.ts';
import { MAX_REPLAY_BYTES, releaseUploadedReplay, storeUploadedReplay } from '../uploaded-replays.ts';
import {
  checkScoreLink,
  enterScore,
  findBeatmap,
  importScoreLink,
  searchBeatmaps,
  convertImportedScores,
  trackerEntryDeps,
  type EntryDeps,
  type EntryResult,
  type ManualInput,
} from '../score-entry.ts';
import { clearDeclines, declineCount, declinedPlayer, deleteDeclines, listDeclines } from '../tracker/declined.ts';
import { eligibilityOf, visibleSql, type Eligibility } from '../calc/eligibility.ts';
import { capture, findBrowser } from './screenshot.ts';
import { detectLocalSessions } from '../clients/session.ts';
import { APP_ID, isOwnPage } from '../instance.ts';
import {
  downloadImage,
  fetchBeatmapset,
  fetchBestPerformances,
  fetchFavouriteBeatmapsets,
  fetchPinnedScores,
  fetchStanding,
  lookupUser,
  NoSuchUser,
} from '../clients/osu-web.ts';
import { confirmSameAccount } from '../player-identity.ts';
import { importMode, type ModeImportResult } from '../tracker/online-import.ts';
import { clearStanding, importedStanding } from '../standing.ts';
import {
  addFavorite,
  detailsFor,
  favoriteCount,
  favoriteIds,
  importFavorites,
  listFavorites,
  missingDetails,
  removeFavorite,
  saveDetails,
} from '../favorites.ts';

/** How many favourites still missing osu!'s details any favourite action retries. */
const FAVORITE_RETRIES = 3;
import {
  clearImage,
  findImage,
  imageState,
  saveImage,
  sniffImage,
  type ImageKind,
} from '../identity.ts';
import {
  applyScoreAction,
  attachmentHeader,
  deleteRemovedScores,
  hiddenCount,
  hiddenScores,
  outdatedPpCount,
  reorderPins,
  replayDownload,
  replayFileName,
  scoreDetail,
  scoreOwner,
  setIncompleteHidden,
  type RowKind,
  type ScoreAction,
} from '../scores.ts';

/**
 * Is this request coming from the machine the app is running on?
 *
 * Both loopback families, since `localhost` resolves to `::1` before `127.0.0.1` on
 * Windows, and Node reports an IPv4 loopback over a dual-stack socket as `::ffff:127.0.0.1`.
 */
function isLocal(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.');
}

/** Upload ceiling for an avatar or banner; anything larger is a mistake. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Upload ceiling for a backup to restore. A big library's database is tens of MB. */
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  // The translations in web/i18n/, fetched by the page one language at a time.
  '.json': 'application/json; charset=utf-8',
};

export interface ServerOptions {
  db: Db;
  tracker: Tracker;
  installs: OsuInstall[];
  country: string;
  tagline: string;
  dataDir: string;
  port: number;
  /**
   * Install-level options the page can change, stored in `data/config.json` by the caller.
   * Passed in rather than read here so the tests never touch a real config file.
   */
  appConfig: {
    get(): AppConfig;
    set(patch: Partial<AppConfig>): void;
  };
  /**
   * Where osu! is, and how to change the answer.
   *
   * The page needs this because auto-detection can still miss: osu! goes wherever the player
   * put it, and the only certain fix is being told. Implemented by the caller rather than
   * here, because every part of it writes `config.json` -- which the tests must never touch,
   * and which the app re-reads on start.
   *
   * Absent, the page shows the folders being tracked and no way to change them.
   */
  osuFolders?: {
    list(): OsuFolders;
    /** Add a folder by hand. Rejected if it holds no osu! install. */
    add(root: string): Promise<OsuFolders>;
    remove(root: string): OsuFolders;
    /** Search the machine again, from scratch, including every drive. */
    rescan(): Promise<OsuFolders>;
  };
  /**
   * Stop the app: the page's Quit. Absent, the page cannot stop it -- the tests never pass
   * one, so no test can end the process running them.
   */
  onQuit?: () => void;
  /**
   * Stop the app for its launcher to start it again, which is how a restored backup is
   * applied (src/backup.ts). Absent when nothing would start it again -- run from a terminal,
   * or in the tests -- and the page then asks for a restart instead.
   */
  onRestart?: () => void;
  /** What started the app, so the page can say where else it can be stopped from. */
  launcher?: 'tray' | 'terminal';
  /**
   * Settings -> pp calculator: price with the player's osu! source instead of the release
   * (src/pp-source.ts). Absent -- as in the tests -- the page offers only the release.
   */
  ppSource?: PpSourceService;
}

/** The osu! folders on this machine, as the page sees them. */
export interface OsuFolders {
  /** Every osu! folder found, best first. */
  candidates: {
    root: string;
    kind: OsuInstall['kind'];
    /** osu!'s development client, tracked beside release lazer rather than instead of it. */
    development: boolean;
    /** Set by the user, rather than found. Shown differently, and removable. */
    configured: boolean;
    /** Whether this is the one being tracked for its client. */
    active: boolean;
  }[];
  /** The roots in use right now, which change only on a restart. */
  tracking: { root: string; kind: OsuInstall['kind']; development: boolean }[];
  /** Whether the app has ever walked the drives, so the page can offer to. */
  searched: boolean;
  /** True once the list no longer matches what is being tracked. */
  needsRestart: boolean;
}

/** What of config.json the page is allowed to see and change. Deliberately small. */
export interface AppConfig {
  /** Open the page in the default browser when the app starts. */
  openBrowser: boolean;
  /** One Favorite Beatmaps list for every profile (the default), or one each. */
  sharedFavorites?: boolean;
  /**
   * The page's language, as one of osu!'s locale codes. Empty means never chosen, which is
   * what makes the first launch able to ask.
   */
  language?: string;
  /** Show beatmap artists and titles in the song's own script, as osu!'s own option does. */
  originalMetadata?: boolean;
  /** Other settings -> Font: Nunito, shipped with the app, or the system's own font. */
  font?: 'nunito' | 'system';
  /** Options -> Auto-update: download new versions and install them at quit or next start. */
  autoUpdate?: boolean;
}

export function startServer(opts: ServerOptions): http.Server {
  const sseClients = new Set<http.ServerResponse>();

  /*
   * Which profile every request is about. Read live rather than captured at startup,
   * because the page can switch profiles while the server is running -- freezing it here
   * would leave the API answering about a profile the user has already left.
   */
  const current = () => activeProfileId(opts.db);
  /** The Favorite Beatmaps list requests are about: shared by every profile, or the current one's. */
  const favorites = () => ({ profileId: current(), shared: opts.appConfig.get().sharedFavorites === true });

  /*
   * config.json's country and tagline are the *fallback* for a profile that has never
   * edited them, not the value. Anything the user saves from the page is stored per
   * profile and wins from then on, empty included.
   */
  const configFallbacks: Partial<Settings> = { country: opts.country, tagline: opts.tagline };
  const settingsFor = (profileId: number) => getSettings(opts.db, profileId, configFallbacks);

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  opts.tracker.on('score', (score) => broadcast('score', score));
  // A play with no score still moves the play count and the charts, so the page has to be
  // told about it -- it just has nothing to put in a toast beyond which map it was.
  opts.tracker.on('incomplete', (play) => broadcast('incomplete', play));
  /*
   * A play the tracking filter declined. Broadcast because no score is written, so a page that
   * said nothing would leave "why was that play not counted?" to be dug out of Plays not
   * tracked -- and that question is exactly what a too-tight filter produces.
   */
  opts.tracker.on('filtered', (play) => broadcast('filtered', play));
  // A replay turned away as someone else's, or unreadable: the same reasoning. The tray
  // launcher hides the console, so without this a wrongly refused play would go unnoticed.
  opts.tracker.on('refused', (play) => broadcast('refused', play));
  /*
   * A launch brought in what was played while the app was closed. Its own event rather than
   * `backfill`, because the page has to say so: this is the one import nobody pressed a
   * button for, and an unannounced handful of new scores is how someone concludes the app is
   * doing something they did not ask for.
   */
  opts.tracker.on('caughtUp', (result) => broadcast('caught-up', result));
  /*
   * Recalculating every profile's scores, after an update or from Other settings. Progress
   * once per percent, which is all a toast can show; the result to every open page, since
   * the one after an update was started by nobody on any of them.
   */
  let lastPercent = -1;
  opts.tracker.on('recalculating', ({ done, total }) => {
    const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
    if (percent === lastPercent && done !== 0) return;
    lastPercent = percent;
    broadcast('recompute-progress', { done, total, percent });
  });
  opts.tracker.on('recalculated', (result) => {
    lastPercent = -1;
    broadcast('recompute', { ...result, everyProfile: true });
  });
  opts.tracker.on('error', (err) => broadcast('tracker-error', { message: err.message }));
  // The beatmap index runs beside the page; it shows the progress while plays wait on it.
  opts.tracker.on('indexing', (state) => broadcast('indexing', state));
  // A build of the player's osu! source can take minutes; every open page follows it.
  opts.ppSource?.onChange((state) => broadcast('pp-source', state));
  /*
   * The update's state, for the page: what the updater knows, plus whether the notice above
   * the page shows, which depends on what dismissed it last (kept in the database).
   */
  const updateView = () => {
    const u = updateState();
    return { ...u, nudgeShown: nudgeShown(u.nudge, u.notes, nudgeDismissal(opts.db), Date.now()) };
  };
  // A newer release found while the app runs, or a download finishing: the page follows live.
  const stopUpdateFeed = onUpdateChange((_, found) => broadcast('update', { ...updateView(), found }));

  /*
   * The profile page's expensive half, remembered until the database changes.
   *
   * Stats, medals (all four modes, for the header's total), the pp history and two totals
   * each walk every score the profile has in the mode, and together they are nearly all of
   * what a profile request costs -- most of a second on a profile of 20,000 scores. The page
   * asks again on every "show more", every live score and every mode switch, while these
   * numbers change only when something is written.
   *
   * So each entry is stamped with SQLite's own record of change: `total_changes()` counts
   * every row this connection has written -- the tracker, the page's actions and settings
   * all share it -- and `data_version` moves when another connection commits, such as
   * `scripts/reingest.mjs` run beside the app. Nothing has to remember to invalidate it,
   * which is the only way a cache like this stays correct as the code grows.
   */
  const cache = new Map<string, { version: string; value: unknown }>();
  const dataVersion = (): string => {
    const changes = opts.db.prepare('SELECT total_changes() AS n').get() as { n: number };
    const version = opts.db.prepare('PRAGMA data_version').get() as { data_version: number };
    return `${changes.n}:${version.data_version}`;
  };
  const remember = <T>(key: string, compute: () => T): T => {
    const hit = cache.get(key);
    if (hit && hit.version === dataVersion()) return hit.value as T;
    const value = compute();
    // Stamped after computing: reading a beatmap's length for the first time is a write, and
    // stamping before it would throw this entry away on the very next request.
    if (cache.size > 64) cache.clear();
    cache.set(key, { version: dataVersion(), value });
    return value;
  };

  const aggregates = (profileId: number, mode: Ruleset, e: Eligibility) =>
    remember(`aggregates:${profileId}:${mode}:${JSON.stringify(e)}`, () => {
      const medals = computeMedals(opts.db, profileId, mode, e);
      return {
        stats: computeStats(opts.db, profileId, mode, e),
        medals,
        medalTotal: earnedMedalCount(opts.db, profileId, e, { mode, summary: medals }),
        // Every event, newest first; the request slices off the page it asked for.
        history: buildHistory(opts.db, profileId, mode, Number.POSITIVE_INFINITY, e, medalEvents(medals.medals)),
        recentTotal: recentPlayTotal(opts.db, profileId, mode, e),
        mostPlayedCount: mostPlayedTotal(opts.db, profileId, mode, e),
      };
    });

  /*
   * One screenshot at a time. Every capture starts a throwaway browser on the same debugging
   * port, so two at once -- "Save screenshot" then "Copy screenshot" in quick succession --
   * would have the second connect to the first's browser, or fail to start at all.
   */
  let captures: Promise<unknown> = Promise.resolve();
  const queueCapture = <T>(job: () => Promise<T>): Promise<T> => {
    const next = captures.then(job, job);
    captures = next.catch(() => undefined);
    return next;
  };

  const json = (res: http.ServerResponse, body: unknown, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  /** Collect a JSON request body, rejecting malformed input before the handler sees it. */
  const readBody = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (body: Record<string, unknown>) => void | Promise<void>,
  ) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>;
      } catch {
        return json(res, { error: 'expected a JSON body' }, 400);
      }
      void Promise.resolve(handler(body)).catch((e: unknown) =>
        json(res, { error: (e as Error).message }, 500),
      );
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    /*
     * Refuse anyone who is not on this machine. There is no switch for this: the page can
     * reset a profile, delete one and remove scores, and none of those endpoints asks who
     * is calling. Sharing a profile means saving it as a page or an image.
     *
     * Enforced here rather than by binding to 127.0.0.1, because a host-bound listen also
     * cuts off IPv6 loopback -- and `localhost` resolves to ::1 first on Windows -- so
     * binding "safely" would leave the app unreachable from its own browser.
     */
    if (!isLocal(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('osu! local profiles only answers the machine it runs on.\n');
      return;
    }

    /*
     * Which app this is. Cheap and constant, because it is asked often: by a second start
     * deciding whether to open this copy's page instead (src/instance.ts), and by the tray
     * launcher waiting for the app to come up and showing whether it is tracking.
     */
    if (url.pathname === '/api/app') {
      return json(res, {
        app: APP_ID,
        version: appVersion(),
        pid: process.pid,
        tracking: opts.tracker.isTracking,
        // The tray launcher polls this, and offers the update from its menu.
        update: offeredVersion(),
        // Downloading and installing now, for the tray's status line.
        updating: updateState().applying,
      });
    }

    /*
     * Quit, from the page. Answered first and stopped after, so the page hears that it
     * worked. Refused for another website's page: see `isOwnPage`.
     */
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      if (!isOwnPage(req.headers.origin, req.socket.localPort)) {
        return json(res, { error: "only this app's own page can stop it" }, 403);
      }
      const quit = opts.onQuit;
      if (!quit) return json(res, { error: 'this copy cannot be stopped from the page' }, 400);
      res.once('finish', () => setTimeout(quit, 250));
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/state') {
      const profile = getProfile(opts.db, current())!;
      const settings = settingsFor(profile.id);
      return json(res, {
        settings,
        // What is running, so the page can print it and the update check has something to
        // compare against. Null when package.json could not be read, which the page shows
        // as an unknown version rather than inventing one.
        app: {
          version: appVersion(),
          update: updateView(),
          // What this version brought, once, after an update.
          whatsNew: whatsNew(opts.db, appVersion(), installDir(), opts.dataDir),
          config: opts.appConfig.get(),
          launcher: opts.launcher ?? null,
          platform: process.platform,
        },
        profile: {
          id: profile.id,
          name: profile.name,
          country: settings.country,
          tagline: settings.tagline,
          createdAt: profile.createdAt,
          trackingSince: profile.trackingSince,
          ...imageState(opts.dataDir, profile.id),
        },
        profiles: listProfiles(opts.db),
        tracking: opts.tracker.isTracking,
        scoresThisSession: opts.tracker.scoresAdded,
        // Plays the tracking filter has declined since the app started, for the Options menu.
        // The plays themselves are in `declinedPlays` below.
        playsFiltered: opts.tracker.playsFiltered,
        // Replays refused as another player's or unreadable since the app started. The same.
        playsRefused: opts.tracker.playsRefused,
        // Whether that filter can actually turn a play away, decided by src/tracking-filter.ts
        // rather than by the page -- there is one definition of "this filter narrows something".
        filterNarrowing: filterNarrows(settings.trackingFilter),
        // A page opened mid-index shows where it has got to, not only what arrives next.
        indexing: opts.tracker.indexState,
        /*
         * Which osu! release prices scores, and how many of this profile's were priced by a
         * different one -- after an update that brings a pp rework, the ones still on the old
         * algorithm, which Settings offers to recalculate.
         */
        ppCalculator: {
          version: opts.tracker.calculatorVersion,
          // The player's own osu! source, when that is what prices (roadmap 5.70); null when the
          // page cannot offer it at all.
          source: opts.ppSource?.state() ?? null,
          // A page opened half-way through a recalculation holds its button rather than start a second.
          recalculating: opts.tracker.recalculating,
          outdated:
            opts.tracker.calculatorVersion === null
              ? 0
              : outdatedPpCount(opts.db, profile.id, opts.tracker.calculatorVersion),
        },
        // Scores ingested before the eligibility columns existed. Non-zero means the
        // Settings dialog should offer a recompute rather than silently under-reporting.
        staleScores: opts.tracker.staleScores,
        // Scores removed from the profile. They are never deleted, so they can be put back.
        hiddenScores: hiddenCount(opts.db, current()),
        // Plays the app turned away, kept so Settings can list them and track one anyway.
        declinedPlays: declineCount(opts.db, current()),
        // Attempts osu! could not submit -- offline, signed out, or an unsubmittable beatmap.
        // Recorded whether or not they count, so Settings can say how many there are before
        // anyone decides to count them.
        unsubmittedAttempts: unsubmittedAttemptCount(opts.db, current()),
        // Whether the Share dialog can offer an image as well as a web page.
        sharing: { canScreenshot: findBrowser() !== null },
        defaultMode: mostRecentMode(opts.db, current()),
        modesWithPlays: modesWithPlays(
          opts.db,
          current(),
          eligibilityOf(settings, opts.tracker.beatmaps.knowsStatus),
        ),
        // A brand-new install's one-time offer to import from an osu! account.
        welcome: welcomePending(opts.db),
        installs: opts.installs.map((i) => ({
          kind: i.kind,
          // osu!'s development client, a lazer of its own beside release lazer.
          development: i.development === true,
          root: i.root,
          hasOnlineDb: i.onlineDb !== null,
        })),
      });
    }

    /*
     * The welcome, left. Skip, the close button, Escape, the backdrop and an import all end
     * it for good, so there is nothing to send but that it happened.
     */
    if (url.pathname === '/api/welcome' && req.method === 'POST') {
      dismissWelcome(opts.db);
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/profile') {
      const mode = (Number(url.searchParams.get('mode') ?? '0') || 0) as Ruleset;
      const profileId = current();
      const settings = settingsFor(profileId);
      const e = eligibilityOf(settings, opts.tracker.beatmaps.knowsStatus);

      /*
       * The paged sections. The page shows five rows of each and asks for more as the user
       * expands, so what comes back is normally tiny -- and the cost of expanding is one
       * request rather than a payload sized for the largest thing anyone might scroll to.
       */
      const page = (name: string, fallback: number) => {
        // `Number(null)` is 0, not NaN, so an absent parameter has to be rejected before the
        // finite check -- otherwise every unparameterised request clamped to a page of one.
        const raw = url.searchParams.get(name);
        if (raw === null || raw.trim() === '') return fallback;
        const asked = Number(raw);
        if (!Number.isFinite(asked)) return fallback;
        // Clamped: this is a query parameter, and an unbounded one would let a stray URL
        // ask the database to build a list of every score ever tracked.
        return Math.min(Math.max(Math.floor(asked), 1), MAX_PAGE);
      };

      const { stats, medals, medalTotal, history, recentTotal, mostPlayedCount } = aggregates(
        profileId,
        mode,
        e,
      );
      const rulesKey = `${profileId}:${mode}:${JSON.stringify(e)}`;
      const table = rankTable(mode);
      return json(res, {
        mode,
        stats,
        // What the profile is counting, so the page can say when it is not scoring the way
        // osu! would rather than quietly showing an inflated number.
        counting: {
          ...e,
          // Priced by the player's own osu! source rather than a release: the one departure
          // from osu! that is about the formula itself, so the note has to say it.
          ppSource: opts.ppSource && opts.ppSource.state().source !== '' ? opts.tracker.calculatorVersion : null,
        },
        // Estimated offline from a data.ppy.sh sample, and null when no curve has been
        // built for this mode. Country rank has no equivalent: 10,000 users split across
        // ~200 countries is far too thin to interpolate per country.
        rank: estimateRank(stats.totalPp, mode),
        rankSource: table === null ? null : { dump: table.dump, sampled: table.sampled },
        /*
         * What this profile borrowed from osu!, when it is borrowing. Sent whenever there is
         * a record of one so the page can name where the figure came from and when -- a
         * number standing in for a play history nobody here has seen has to say so.
         */
        imported: stats.bonusPpBorrowed ? importedStanding(opts.db, profileId, mode) : null,
        medals,
        // osu!'s header figure: every medal the profile holds, whichever mode is showing.
        medalTotal,
        pinned: remember(`pinned:${rulesKey}`, () => pinnedPlays(opts.db, profileId, mode, e)),
        top: remember(`top:${rulesKey}:${page('top', 100)}`, () =>
          topPlays(opts.db, profileId, mode, page('top', 100), e),
        ),
        // Recent Plays reads only the newest rows through an index, so it is not worth keeping.
        recent: recentPlays(opts.db, profileId, mode, page('recent', 25), e, settings.showIncompleteInRecent),
        // Keyed by the rules too: whether unsubmitted attempts count changes what it lists.
        mostPlayed: remember(`mostPlayed:${rulesKey}:${page('mostPlayed', 15)}`, () =>
          mostPlayed(opts.db, profileId, mode, page('mostPlayed', 15), e),
        ),
        // Favourites are the profile's, not a mode's, exactly as osu!'s are the account's.
        favorites: listFavorites(opts.db, favorites(), page('favorites', 6), opts.tracker.beatmaps),
        favoriteIds: favoriteIds(opts.db, favorites()),
        /*
         * How many rows each of those sections has in full, so the headings can show a real
         * count and "show more" can know when to stop offering. Top Ranks is capped at 100
         * because that is all osu! ever weights.
         */
        totals: {
          top: Math.min(stats.distinctRankedBeatmaps, TOP_PLAYS),
          recent: recentTotal,
          mostPlayed: mostPlayedCount,
          events: history.eventsTotal,
          favorites: favoriteCount(opts.db, favorites()),
        },
        ppHistory: history.pp,
        // osu-web charts global rank here, so do the same wherever a curve exists.
        rankHistory: history.pp.map((p) => ({ at: p.at, rank: estimateRank(p.pp, mode)?.rank ?? null })),
        monthlyPlaycounts: history.monthlyPlaycounts,
        // The cached history holds every event; the page asked for this many.
        events: history.events.slice(0, page('events', 15)),
      });
    }

    // This profile's avatar or banner, served only if it has one.
    const image = /^\/api\/image\/(avatar|cover)$/.exec(url.pathname);
    if (image && req.method !== 'PUT') {
      // `?profile=` names another profile's, for a score page showing whose score it is.
      const asked = Number(url.searchParams.get('profile'));
      const imageProfile = Number.isInteger(asked) && getProfile(opts.db, asked) ? asked : current();
      const file = findImage(opts.dataDir, imageProfile, image[1] as ImageKind);
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        res.end(buf);
      });
      return;
    }

    /*
     * Settings the page edits directly. A GET is only needed by anything that did not come
     * through /api/state; the page itself already has them from there.
     */
    if (url.pathname === '/api/settings') {
      if (req.method !== 'POST') return json(res, { settings: settingsFor(current()) });

      return readBody(req, res, (body) => {
        // The whole body is the patch. Keys that are not settings are ignored, so the page
        // can post a form's worth of fields without filtering them first.
        const settings = updateSettings(opts.db, current(), body, configFallbacks);
        broadcast('settings', settings);
        return json(res, { ok: true, settings });
      });
    }

    /*
     * The install's own options, as opposed to a profile's. Only the keys in `AppConfig` can
     * be changed, and only to a value of the right type: this writes the file the app needs
     * to boot, so nothing the page sends is passed through unchecked.
     */
    if (url.pathname === '/api/app-config') {
      if (req.method !== 'POST') return json(res, { config: opts.appConfig.get() });

      return readBody(req, res, (body) => {
        const patch: Partial<AppConfig> = {};
        for (const key of ['openBrowser', 'sharedFavorites', 'originalMetadata', 'autoUpdate'] as const) {
          if (!(key in body)) continue;
          if (typeof body[key] !== 'boolean') return json(res, { error: `${key} must be true or false` }, 400);
          patch[key] = body[key];
        }
        /*
         * Checked against the list rather than stored as sent: this ends up in config.json
         * and is read back on every start, and a language that does not exist would leave
         * the page falling back on every string forever with nothing to say why.
         */
        if ('language' in body) {
          if (!isLocale(body['language'])) {
            return json(res, { error: `${String(body['language'])} is not a language this app has` }, 400);
          }
          patch.language = body['language'];
        }
        if ('font' in body) {
          if (body['font'] !== 'nunito' && body['font'] !== 'system') {
            return json(res, { error: 'font must be nunito or system' }, 400);
          }
          patch.font = body['font'];
        }
        if (Object.keys(patch).length === 0) {
          return json(res, { error: 'openBrowser must be true or false' }, 400);
        }
        opts.appConfig.set(patch);
        const config = opts.appConfig.get();
        broadcast('app-config', config);
        return json(res, { ok: true, config });
      });
    }

    /*
     * Settings -> pp calculator. GET says what is in use, and whether the source has changed
     * since it was built; POST with a folder builds from it (when needed) and switches every
     * profile to it, and with '' switches back to the release. Answered at once: a build takes
     * minutes, and `pp-source` events follow it, then the recalculation's own.
     */
    if (url.pathname === '/api/pp-source') {
      const service = opts.ppSource;
      if (!service) return json(res, { error: 'this app cannot use an osu! source' }, 404);
      if (req.method !== 'POST') return json(res, service.view());
      return readBody(req, res, (body) => {
        const source = typeof body['source'] === 'string' ? body['source'].trim() : null;
        if (source === null) return json(res, { error: 'source must be a folder, or empty for the release' }, 400);
        void (source === '' ? service.useRelease() : service.use(source));
        // Whatever the switch decided before its first wait -- a refusal, or a build begun.
        return json(res, service.state());
      });
    }

    /*
     * Where osu! is.
     *
     * Read by anyone; changed only through the three verbs, one at a time, so a page that
     * sends something unexpected gets an error rather than a half-applied change. Adding a
     * folder that holds no osu! install is refused *with the reason*: "that is not an osu!
     * folder" is the whole value of the endpoint over editing config.json by hand.
     */
    if (url.pathname === '/api/installs') {
      const folders = opts.osuFolders;
      if (!folders) return json(res, { error: 'this copy cannot change its osu! folders' }, 400);
      if (req.method !== 'POST') return json(res, folders.list());

      return readBody(req, res, async (body) => {
        if (body['rescan'] === true) return json(res, await folders.rescan());

        const add = body['add'];
        if (typeof add === 'string') {
          if (add.trim().length === 0) return json(res, { error: 'give a folder to add' }, 400);
          try {
            return json(res, await folders.add(add.trim()));
          } catch (e) {
            return json(res, { error: (e as Error).message }, 400);
          }
        }

        const remove = body['remove'];
        if (typeof remove === 'string') return json(res, folders.remove(remove));

        return json(res, { error: 'expected add, remove or rescan' }, 400);
      });
    }

    /*
     * Recalculate stored scores from their replays.
     *
     * Needed because scores ingested before the eligibility settings existed were never
     * given a pp value for anything osu! would not rank -- there was no reason to calculate
     * one. Turning "include unranked mods" on without this would show an empty section.
     *
     * Explicit and confirmed, like every other operation that rewrites stored scores.
     */
    if (url.pathname === '/api/recompute' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        if (body['confirm'] !== true) {
          return json(res, { error: 'recomputing requires an explicit confirmation' }, 400);
        }
        /*
         * Every score of every profile, the same run a new calculator starts by itself after
         * an update. Its progress and result reach the page through the tracker's events.
         */
        if (body['all'] === true) {
          try {
            /*
             * Best performances still on osu!'s figures first, each built into a replay priced
             * here, so this run recalculates them too. A beatmap not installed is downloaded:
             * this is the one button that means "put every score on this calculator".
             */
            let converted = 0;
            for (const profile of listProfiles(opts.db)) {
              const deps = trackerEntryDeps(opts.tracker, opts.db, opts.dataDir, profile.id);
              converted += (await convertImportedScores(deps, profile.id, { download: true })).converted;
            }
            const result = await opts.tracker.recalculate(false);
            console.log(
              `\n  recalculated ${result.updated} score(s) in every profile from their replays` +
                `${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}` +
                `${converted > 0 ? `, and priced ${converted} imported from osu! here` : ''}\n`,
            );
            return json(res, { ok: true, ...result });
          } catch (e) {
            return json(res, { error: (e as Error).message }, 409);
          }
        }
        const onlyMissing = true;
        try {
          let lastReported = -1;
          const result = await opts.tracker.recompute(onlyMissing, (done, total) => {
            // One event per percent: a 2,000-score recompute would otherwise flood the SSE
            // stream with updates the page cannot draw fast enough anyway.
            const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
            if (percent === lastReported) return;
            lastReported = percent;
            broadcast('recompute-progress', { done, total, percent });
          });
          broadcast('recompute', result);
          console.log(
            `\n  recomputed ${result.updated} score(s) from their replays` +
              `${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}\n`,
          );
          return json(res, { ok: true, ...result });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
      });
    }

    /*
     * Uploading an avatar or a banner.
     *
     * A raw PUT rather than a multipart form: the page has one file and no other fields, so
     * multipart would mean writing a parser to recover a body we already have. The bytes are
     * sniffed rather than trusted -- the content-type is whatever the page chose to send.
     */
    if (image && req.method === 'PUT') {
      const kind = image[1] as ImageKind;
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          aborted = true;
          json(res, { error: 'that image is too large (8MB max)' }, 413);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        const bytes = Buffer.concat(chunks);
        const extension = sniffImage(bytes);
        if (!extension) {
          return json(res, { error: 'that file is not a PNG, JPEG, WebP or GIF' }, 400);
        }
        try {
          saveImage(opts.dataDir, current(), kind, bytes, extension);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
        broadcast('identity', { kind });
        return json(res, { ok: true, ...imageState(opts.dataDir, current()) });
      });
      return;
    }

    /*
     * Images pasted or dropped into the me! editor. Stored per profile and named by their
     * content (src/about-images.ts), then served back by that name -- always the same bytes,
     * so the browser may keep them. The upload is the avatar's: a raw PUT, capped and sniffed.
     */
    if (url.pathname === '/api/about-image' && req.method === 'PUT') {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          aborted = true;
          json(res, { error: 'that image is too large (8MB max)' }, 413);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          const saved = saveAboutImage(opts.dataDir, current(), Buffer.concat(chunks));
          if (saved === null) return json(res, { error: 'that file is not a PNG, JPEG, WebP or GIF' }, 400);
          return json(res, { ok: true, url: saved });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 500);
        }
      });
      return;
    }

    /*
     * A replay file chosen or dropped into Import past plays, one per request: a raw body like
     * the images above, capped and sniffed. A copy is kept in data/replays (src/uploaded-
     * replays.ts) and imported through the same checks as any past play; one that brought in
     * nothing and is not listed as turned away is not kept. `?applyFilter=0` is the dialog's
     * box unticked, as for a range.
     */
    if (url.pathname === '/api/replays' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_REPLAY_BYTES) {
          aborted = true;
          json(res, { error: 'that file is too large to be a replay' }, 413);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          const file = storeUploadedReplay(opts.dataDir, Buffer.concat(chunks));
          if (file === null) return json(res, { error: 'that file is not an osu! replay' }, 400);
          const result = await opts.tracker.importReplayFile(file, url.searchParams.get('applyFilter') !== '0');
          // Kept only when a score, or a play not tracked, now points at it.
          releaseUploadedReplay(opts.db, file);
          return json(res, result);
        })().catch((e: unknown) => json(res, { error: (e as Error).message }, 500));
      });
      return;
    }

    /*
     * One score added by name: from its link on osu.ppy.sh, or typed in by hand. Both become a
     * replay this app builds and prices like any other -- see src/score-entry.ts. A link is
     * checked first (whose score, already here?) and imported on a second request, so nothing
     * is written until the page has shown what it found.
     */
    const entryDeps = (profileId = current()): EntryDeps =>
      trackerEntryDeps(opts.tracker, opts.db, opts.dataDir, profileId);
    const entryAnswer = (result: EntryResult) =>
      result.status === 'added' && result.outcome.status === 'added'
        ? { status: 'added', score: result.outcome.score }
        : { status: 'already' };

    if (url.pathname === '/api/score-link/check' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        try {
          return json(res, await checkScoreLink(entryDeps(), String(body['link'] ?? '')));
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }
    if (url.pathname === '/api/score-link' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        try {
          const profileId = current();
          const result = await importScoreLink(entryDeps(profileId), String(body['link'] ?? ''));
          if (result.status !== 'added' || result.outcome.status !== 'added') return json(res, entryAnswer(result));
          /*
           * The replay osu! wrote for it, if this computer still has it: it takes the place of
           * the one just built from the link, and is priced from it -- so the pp the page
           * announces is read back rather than the built replay's.
           */
          const score = result.outcome.score;
          const { attached } = await opts.tracker.attachLocalReplays(profileId, [score.id]);
          if (attached === 0) return json(res, { ...entryAnswer(result), replay: false });
          const priced = opts.db.prepare('SELECT pp FROM scores WHERE id = ?').get(score.id) as
            { pp: number | null } | undefined;
          broadcast('scores', { action: 'import' });
          return json(res, { status: 'added', score: { ...score, pp: priced?.pp ?? null }, replay: true });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }
    if (url.pathname === '/api/beatmaps/search' && req.method === 'GET') {
      return json(res, { beatmaps: searchBeatmaps(entryDeps(), url.searchParams.get('q') ?? '') });
    }
    if (url.pathname === '/api/beatmaps/find' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        try {
          const md5 = typeof body['md5'] === 'string' ? body['md5'] : undefined;
          return json(res, await findBeatmap(entryDeps(), { md5, link: String(body['link'] ?? '') }));
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }
    if (url.pathname === '/api/manual-score' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        try {
          // The name the replay is written under: whoever this profile is, as it knows itself.
          const player = opts.tracker.playerIdentity.displayName || getProfile(opts.db, current())?.name || '';
          const result = await enterScore(entryDeps(), body as unknown as ManualInput, player);
          return json(res, entryAnswer(result));
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }

    const aboutImage =
      req.method === 'GET' || req.method === 'HEAD' ? aboutImageFile(opts.dataDir, url.pathname) : null;
    if (aboutImage) {
      fs.readFile(aboutImage.file, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': aboutImage.mime, 'cache-control': 'max-age=31536000, immutable' });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
      return;
    }

    /*
     * Identity: the profile's name, avatar and banner, and the optional osu! account they
     * can be borrowed from.
     *
     * Every network action here happens because a button was pressed, makes one request,
     * and copies what it finds into `data/`. Nothing is fetched on a schedule, and with no
     * network the upload and typing paths still work. See src/clients/osu-web.ts.
     */
    if (url.pathname === '/api/identity' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        const action = String(body['action'] ?? '');
        const id = current();

        try {
          switch (action) {
            /** What can be offered without touching the network. */
            case 'suggestions': {
              return json(res, {
                sessions: detectLocalSessions(opts.installs),
                linked: (() => {
                  const settings = settingsFor(id);
                  return settings.linkedUserId > 0
                    ? { id: settings.linkedUserId, username: settings.linkedUsername }
                    : null;
                })(),
              });
            }

            /** One request, on an explicit press, showing what was found before using it. */
            case 'lookup': {
              const user = await lookupUser(String(body['query'] ?? ''));
              return json(res, { ok: true, user });
            }

            /**
             * Adopt a looked-up account: remember it, and copy its pictures in. The name is
             * *not* changed -- renaming a profile is a separate, deliberate act.
             */
            case 'link': {
              const user = await lookupUser(String(body['query'] ?? ''));
              updateSettings(
                opts.db,
                id,
                { linkedUserId: user.id, linkedUsername: user.username },
                configFallbacks,
              );

              // Best effort: a linked account with an unreachable image is still linked.
              const failures: string[] = [];
              for (const [kind, source] of [
                ['avatar', user.avatarUrl],
                ['cover', user.coverUrl],
              ] as const) {
                if (!source || body[kind] === false) continue;
                try {
                  const downloaded = await downloadImage(source);
                  saveImage(opts.dataDir, id, kind, downloaded.bytes, downloaded.extension);
                } catch (e) {
                  failures.push(`${kind}: ${(e as Error).message}`);
                }
              }

              broadcast('identity', { linked: user.id });
              return json(res, {
                ok: true,
                user,
                failures,
                settings: settingsFor(id),
                ...imageState(opts.dataDir, id),
              });
            }

            /**
             * Copy what was chosen from an osu! account, and link the profile to it. Everything
             * happens because the Import button was pressed: one lookup, one download per image,
             * one request per hundred favourites. Each part is best effort -- a banner that will
             * not download does not undo the avatar -- and the answer says what worked.
             */
            case 'import': {
              const user = await lookupUser(String(body['query'] ?? ''));
              const want = (key: string, fallback: boolean) =>
                typeof body[key] === 'boolean' ? (body[key] as boolean) : fallback;
              const done: string[] = [];
              const failures: string[] = [];

              const patch: Record<string, unknown> = {
                linkedUserId: user.id,
                linkedUsername: user.username,
                // Kept because deciding whether a replay is yours comes down to the name
                // inside it, and an osu!stable replay carries no user id -- so a play set
                // before a rename would look like a stranger's. See src/player-identity.ts.
                linkedPreviousNames: user.previousUsernames,
                // The list has now actually been asked for, which is what makes it safe to
                // remove a play on the strength of it -- see `linkedNamesKnown`.
                linkedNamesKnown: true,
              };
              if (want('country', true)) {
                if (user.countryCode) {
                  patch['country'] = user.countryCode;
                  done.push('flag');
                } else {
                  failures.push('flag: that account shows no country');
                }
              }
              if (want('aboutMe', true)) {
                // An empty me! on osu! leaves this one alone rather than wiping it.
                if (user.pageRaw !== null) {
                  patch['aboutMe'] = user.pageRaw;
                  done.push('me!');
                } else {
                  failures.push("me!: that account's me! is empty");
                }
              }
              updateSettings(opts.db, id, patch, configFallbacks);

              for (const [kind, source, label] of [
                ['avatar', user.avatarUrl, 'avatar'],
                ['cover', user.coverUrl, 'banner'],
              ] as const) {
                if (!want(kind, true)) continue;
                if (!source) {
                  failures.push(`${label}: that account has none`);
                  continue;
                }
                try {
                  const downloaded = await downloadImage(source);
                  saveImage(opts.dataDir, id, kind, downloaded.bytes, downloaded.extension);
                  done.push(label);
                } catch (e) {
                  failures.push(`${label}: ${(e as Error).message}`);
                }
              }

              let favouritesFound = 0;
              let favouritesAdded = 0;
              if (want('favorites', false)) {
                try {
                  const sets = await fetchFavouriteBeatmapsets(user.id);
                  favouritesFound = sets.length;
                  favouritesAdded = importFavorites(opts.db, favorites(), sets);
                  done.push(`${favouritesFound} favourite beatmap${favouritesFound === 1 ? '' : 's'}`);
                } catch (e) {
                  failures.push(`favourite beatmaps: ${(e as Error).message}`);
                }
              }

              /*
               * Medals, when asked for: the ones this app awards, as osu! awarded them, in place
               * of what an earlier import copied. They join the medals this profile's plays earn
               * rather than replacing them -- see src/imported-medals.ts.
               */
              const wantMedals = want('medals', false);
              if (wantMedals) {
                const kept = saveImportedMedals(opts.db, id, user.medals.filter((m) => isAppMedal(m.slug)));
                done.push(`${kept} medal${kept === 1 ? '' : 's'}`);
              }

              /*
               * Best performances and pinned scores, which are the only part of an import
               * that writes plays rather than decoration.
               *
               * Both lists per ruleset in one pass, because they overlap and because the
               * weighting depends on osu!'s order: see src/tracker/online-import.ts. All
               * four rulesets are asked -- osu! keeps a separate 200 for each, an account
               * that never played one answers empty, and importing mode by mode would leave
               * a profile whose other tabs are silently blank.
               */
              const scores: ModeImportResult[] = [];
              const wantBest = want('bestPerformances', false);
              const wantPinned = want('pinnedScores', false);
              if (wantBest || wantPinned) {
                for (const mode of [0, 1, 2, 3] as const) {
                  try {
                    const best = wantBest ? await fetchBestPerformances(user.id, mode) : [];
                    const pinned = wantPinned ? await fetchPinnedScores(user.id, mode) : [];
                    if (best.length === 0 && pinned.length === 0) continue;
                    // Only worth a request once there is something to correct the bonus of.
                    const standing = wantBest && best.length > 0
                      ? await fetchStanding(user.id, mode)
                      : null;
                    scores.push(
                      importMode(opts.db, opts.tracker.beatmaps, id, mode, best, pinned, standing),
                    );
                  } catch (e) {
                    failures.push(`${MODE_LABELS[mode]} scores: ${(e as Error).message}`);
                  }
                }
                const added = scores.reduce((n, r) => n + r.added, 0);
                const pins = scores.reduce((n, r) => n + r.pinned, 0);
                if (wantBest && added > 0) done.push(`${added} score${added === 1 ? '' : 's'}`);
                if (wantPinned && pins > 0) done.push(`${pins} pinned`);
                /*
                 * The replays osu! wrote for these plays, where this computer still has them:
                 * each takes its play's place, so it has a replay to watch and download and is
                 * priced from it. First, so what is left is all the next step has to build.
                 */
                if (scores.length > 0) {
                  const { attached } = await opts.tracker.attachLocalReplays(id);
                  if (attached > 0) done.push(`${attached} replay${attached === 1 ? '' : 's'} from this computer`);
                }
                /*
                 * Then priced here: each built into a replay from what osu! handed over, so a
                 * pp rework reprices it with everything else. A beatmap not installed is
                 * downloaded now, while the import is online anyway.
                 */
                if (scores.length > 0) {
                  const conversion = await convertImportedScores(entryDeps(id), id, { download: true });
                  if (conversion.converted > 0) done.push(`${conversion.converted} priced here`);
                }
              }

              // First, so every open page takes the medals osu! already awarded as its starting
              // point before anything below makes it render them as newly unlocked.
              if (wantMedals) broadcast('medals', { action: 'import' });
              broadcast('identity', { linked: user.id });
              broadcast('settings', settingsFor(id));
              if (favouritesAdded > 0) broadcast('favorites', { action: 'import' });
              if (scores.length > 0) broadcast('scores', { action: 'import' });
              return json(res, {
                ok: true,
                user,
                done,
                failures,
                favorites: { found: favouritesFound, added: favouritesAdded },
                scores,
                settings: settingsFor(id),
                ...imageState(opts.dataDir, id),
              });
            }

            case 'unlink': {
              updateSettings(opts.db, id, { linkedUserId: 0, linkedUsername: '' }, configFallbacks);
              broadcast('identity', { linked: 0 });
              return json(res, { ok: true, settings: settingsFor(id) });
            }

            case 'clear-image': {
              const kind = String(body['kind'] ?? '');
              if (kind !== 'avatar' && kind !== 'cover') {
                return json(res, { error: 'kind must be "avatar" or "cover"' }, 400);
              }
              clearImage(opts.dataDir, id, kind);
              broadcast('identity', { kind });
              return json(res, { ok: true, ...imageState(opts.dataDir, id) });
            }

            default:
              return json(res, { error: `unknown action ${JSON.stringify(action)}` }, 400);
          }
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }

    /*
     * Pinning, ordering pins, and removing a score from the profile.
     *
     * Removing is a hide rather than a delete -- the replay is still on disk, and a deleted
     * row would be re-ingested with dedupe no longer able to suppress it. See src/scores.ts.
     */
    if (url.pathname === '/api/scores' && req.method === 'POST') {
      return readBody(req, res, (body) => {
        const action = String(body['action'] ?? '');
        // An unfinished play is a row of incomplete_plays, and a collapsed one is several.
        const kind: RowKind = body['kind'] === 'incomplete' ? 'incomplete' : 'score';
        const ids = Array.isArray(body['ids']) ? (body['ids'] as unknown[]).map(Number) : [Number(body['id'])];
        try {
          if (kind === 'incomplete' && (action === 'hide' || action === 'restore')) {
            setIncompleteHidden(opts.db, current(), ids, action === 'hide');
          } else if (action === 'reorder') {
            const ids = Array.isArray(body['ids']) ? (body['ids'] as unknown[]).map(Number) : [];
            reorderPins(opts.db, current(), ids);
          } else if (action === 'list-hidden') {
            return json(res, { hidden: hiddenScores(opts.db, current()) });
          } else if (action === 'delete' || action === 'delete-all-removed') {
            // For good: see deleteRemovedScores, and why the key outlives the row.
            const deleted = deleteRemovedScores(
              opts.db,
              current(),
              action === 'delete' ? ids : 'all',
              Date.now(),
              kind,
            );
            broadcast('scores', { action });
            return json(res, { ok: true, deleted, hiddenScores: hiddenCount(opts.db, current()) });
          } else {
            applyScoreAction(opts.db, current(), Number(body['id']), action as ScoreAction);
          }
          broadcast('scores', { action });
          return json(res, { ok: true, hiddenScores: hiddenCount(opts.db, current()) });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }

    /*
     * Plays the app turned away rather than tracked -- the filter, another player's replay, one
     * that could not be read -- and Track anyway for one of them. See src/tracker/declined.ts.
     *
     * The list is fetched when Settings opens rather than carried in /api/state, like Removed
     * scores: an import can put hundreds in it.
     */
    if (url.pathname === '/api/declined' && req.method === 'GET') {
      return json(res, { plays: listDeclines(opts.db, current()) });
    }
    if (url.pathname === '/api/declined' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        const action = String(body['action'] ?? '');
        // For good, as a removed score is deleted: see deleteDeclines.
        if (action === 'delete' || action === 'delete-all') {
          try {
            const deleted = deleteDeclines(opts.db, current(), action === 'delete' ? [Number(body['id'])] : 'all');
            return json(res, { ok: true, deleted, declinedPlays: declineCount(opts.db, current()) });
          } catch (e) {
            return json(res, { error: (e as Error).message }, 400);
          }
        }
        /*
         * "It's me": a play refused as another player's that is the owner's own, under a name
         * osu! changed. One request to osu! on the press -- see `confirmSameAccount` -- and on a
         * yes, the account's every name is kept and each play refused under one is judged again.
         */
        if (action === 'its-me') {
          const profileId = current();
          const player = declinedPlayer(opts.db, profileId, Number(body['id']));
          if (player === null) return json(res, { error: 'that play is not in the list any more' }, 400);
          try {
            const account = await confirmSameAccount(
              player,
              opts.tracker.playerIdentity,
              lookupUser,
              (e) => e instanceof NoSuchUser,
            );
            if (account === null) {
              const owner = opts.tracker.playerIdentity.displayName;
              return json(
                res,
                {
                  error:
                    owner === ''
                      ? `osu! cannot say whether ${player} is you. If this play is yours, use Track anyway.`
                      : `osu! does not list ${player} as a name of ${owner}, the account signed in here. ` +
                        'If this play is yours, use Track anyway.',
                },
                400,
              );
            }
            updateSettings(
              opts.db,
              profileId,
              {
                // The newest first, so the list's cap never costs the account just confirmed.
                accountNames: [
                  account.username,
                  ...account.previousUsernames,
                  ...settingsFor(profileId).accountNames,
                ],
              },
              configFallbacks,
            );
            const tracked = await opts.tracker.retrackOwnNames();
            return json(res, {
              ok: true,
              account: account.username,
              tracked,
              declinedPlays: declineCount(opts.db, profileId),
            });
          } catch (e) {
            return json(res, { error: (e as Error).message }, 400);
          }
        }
        if (action !== 'track') return json(res, { error: `unknown action ${JSON.stringify(action)}` }, 400);
        const id = Number(body['id']);
        if (!Number.isInteger(id)) return json(res, { error: 'a play id is needed' }, 400);
        try {
          // A play tracked this way is announced by the tracker, as a live one is.
          const result = await opts.tracker.trackAnyway(id);
          return json(res, { ok: true, result, declinedPlays: declineCount(opts.db, current()) });
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }

    /*
     * One score, for the View Details card, and its replay file, for Download Replay.
     *
     * The replay is streamed from wherever osu! keeps it -- lazer's file store or stable's
     * Data/r -- as an attachment, so the browser saves it to Downloads like any download.
     * The request names a score id, never a path: see `replayDownload`. HEAD answers the
     * same question without the file, which is how the page checks before it starts a
     * download that would otherwise fail silently in the browser's download bar.
     */
    const scoreRoute = /^\/api\/scores\/(\d+)(\/replay|\/screenshot)?$/.exec(url.pathname);
    if (scoreRoute && (req.method === 'GET' || req.method === 'HEAD')) {
      const id = Number(scoreRoute[1]);
      // Answered as the profile that owns the score, so its link outlives a profile switch.
      const ownerId = scoreOwner(opts.db, id);
      const owner = ownerId === null ? null : getProfile(opts.db, ownerId);
      if (owner === null) return json(res, { error: `there is no score ${id}` }, 404);

      if (!scoreRoute[2]) {
        void (async () => {
          const rules = eligibilityOf(settingsFor(owner.id), opts.tracker.beatmaps.knowsStatus);
          let detail = scoreDetail(opts.db, owner.id, id, rules);
          if (!detail) return json(res, { error: `there is no score ${id}` }, 404);
          /*
           * A score calculated before breakdowns were kept is recalculated now, with the current
           * calculator, so its parts belong to the pp shown beside them. Normally a fraction of
           * a second; never waited on for long, and not at all while the beatmap index still
           * holds the queue -- the card opens without a breakdown rather than hanging.
           */
          if (
            detail.ppBreakdown === null &&
            detail.pp !== null &&
            detail.replayAvailable &&
            opts.tracker.calculatorVersion !== null &&
            !opts.tracker.indexState.active
          ) {
            await Promise.race([
              opts.tracker.recomputeScore(id, owner.id),
              new Promise((resolve) => setTimeout(resolve, 8000)),
            ]);
            detail = scoreDetail(opts.db, owner.id, id, rules) ?? detail;
          }
          const images = imageState(opts.dataDir, owner.id);
          return json(res, {
            score: detail,
            // What prices scores now, so the card can say when this one came from another.
            calculator: opts.tracker.calculatorVersion,
            owner: {
              id: owner.id,
              name: owner.name,
              country: settingsFor(owner.id).country,
              avatar: images.hasAvatar ? `/api/image/avatar?profile=${owner.id}` : null,
              // None of its own: the card shows osu-web's default banner.
              cover: images.hasCover ? `/api/image/cover?profile=${owner.id}` : null,
              active: owner.id === current(),
              tracking: owner.id === current() && opts.tracker.isTracking,
            },
          });
        })().catch((e: unknown) => json(res, { error: (e as Error).message }, 500));
        return;
      }

      /*
       * The card as a PNG: the score's own page, rendered by an installed browser at osu-web's
       * 1000px, with the page's controls taken off (`?export=1`). The same mechanism as the
       * profile's screenshot -- see src/http/screenshot.ts -- queued behind it, because both
       * drive a throwaway browser on one debugging port.
       */
      if (scoreRoute[2] === '/screenshot') {
        const play = scoreDetail(opts.db, owner.id, id);
        void queueCapture(() => capture({
          url: `http://127.0.0.1:${opts.port}/scores/${id}?export=1`,
          width: 1000,
          selector: '#scoreCard',
        }))
          .then((png) => {
            // Named as its replay would be, so the two files sort side by side.
            const name = replayFileName({
              player: owner.name,
              artist: play?.artist ?? null,
              title: play?.title ?? null,
              creator: play?.creator ?? null,
              version: play?.version ?? null,
              playedAt: play?.playedAt ?? Date.now(),
            }).replace(/\.osr$/, '.png');
            res.writeHead(200, {
              'content-type': 'image/png',
              'content-length': png.length,
              'content-disposition': attachmentHeader(name),
              'cache-control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : png);
          })
          .catch((e: unknown) => json(res, { error: (e as Error).message }, 503));
        return;
      }

      const found = replayDownload(opts.db, owner.id, id, owner.name);
      if ('error' in found) return json(res, { error: found.error }, 404);

      fs.stat(found.path, (err, stat) => {
        if (err) return json(res, { error: 'the replay could not be read' }, 404);
        res.writeHead(200, {
          // osu-web's own type for a replay download.
          'content-type': 'application/x-osu-replay',
          'content-length': stat.size,
          'content-disposition': attachmentHeader(found.fileName),
          'cache-control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(found.path)
          .on('error', () => res.destroy())
          .pipe(res);
      });
      return;
    }

    /*
     * Favorite Beatmaps: add or remove a set from this profile's favourites.
     *
     * Adding makes one request to osu.ppy.sh for the set's details, because the button was
     * pressed -- the rule src/clients/osu-web.ts keeps. The favourite is saved first and
     * regardless: offline, the card is built from what is on this machine. Any action also
     * retries a few favourites still missing their details, so an offline favourite fills in
     * the next time one is pressed with a connection, still without anything on a timer.
     */
    if (url.pathname === '/api/favorites' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        const action = String(body['action'] ?? '');
        const id = Number(body['beatmapsetId']);
        if (!Number.isInteger(id) || id <= 0) {
          return json(res, { error: 'a beatmapset id is needed' }, 400);
        }
        if (action !== 'add' && action !== 'remove') {
          return json(res, { error: 'action must be add or remove' }, 400);
        }

        if (action === 'remove') {
          removeFavorite(opts.db, favorites(), id);
        } else {
          addFavorite(opts.db, favorites(), id);
        }

        let detailsError: string | null = null;
        const wanted = action === 'add' && detailsFor(opts.db, id) === null ? [id] : [];
        for (const missing of missingDetails(opts.db, favorites(), FAVORITE_RETRIES)) {
          if (!wanted.includes(missing)) wanted.push(missing);
        }
        for (const setId of wanted) {
          try {
            saveDetails(opts.db, await fetchBeatmapset(setId));
          } catch (e) {
            if (setId === id) detailsError = (e as Error).message;
            // Offline is offline for every set; asking again for the rest only waits longer.
            if ((e as Error).message === 'could not reach osu.ppy.sh') break;
          }
        }

        broadcast('favorites', { action, beatmapsetId: id });
        return json(res, {
          ok: true,
          favorites: favoriteIds(opts.db, favorites()),
          detailsError,
        });
      });
    }

    /*
     * A full-page PNG, rendered by an already-installed Chrome or Edge. Nothing is bundled;
     * see src/http/screenshot.ts for why, and what happens when neither is there.
     */
    if (url.pathname === '/api/screenshot') {
      void (async () => {
        try {
          const png = await queueCapture(() => capture({ url: `http://127.0.0.1:${opts.port}/?export=1` }));
          const stamp = new Date().toISOString().slice(0, 10);
          const profile = getProfile(opts.db, current())!;
          const name = `${profile.name.replace(/[^\w.-]+/g, '-')}-${stamp}.png`;
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-disposition': `attachment; filename="${name}"`,
            'cache-control': 'no-store',
          });
          res.end(png);
        } catch (e) {
          json(res, { error: (e as Error).message }, 503);
        }
      })();
      return;
    }

    if (url.pathname === '/api/profile/reset' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let confirmed = false;
        try {
          confirmed = (JSON.parse(body) as { confirm?: boolean }).confirm === true;
        } catch {
          /* treated as unconfirmed */
        }
        if (!confirmed) {
          return json(res, { error: 'reset requires an explicit confirmation' }, 400);
        }

        const before = opts.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ?)
                  + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ?) AS n`,
          )
          .get(current(), current()) as { n: number };

        const now = Date.now();
        // Moving tracking_since forward is what makes this a *fresh* profile: without it
        // the watcher would re-accept replays already on disk from before the reset.
        opts.db.exec('BEGIN');
        try {
          opts.db.prepare('DELETE FROM scores WHERE profile_id = ?').run(current());
          // Abandoned attempts are part of the profile's play count, so a reset that left
          // them behind would clear the scores and still show an evening of plays.
          opts.db.prepare('DELETE FROM incomplete_plays WHERE profile_id = ?').run(current());
          // A fresh start forgets deletions too; tracking_since keeps the old replays out.
          opts.db.prepare('DELETE FROM deleted_scores WHERE profile_id = ?').run(current());
          // And what it turned away: Track anyway on a play from before the reset would bring
          // back exactly what the reset cleared.
          clearDeclines(opts.db, current());
          // And what it borrowed from osu!: a profile with no scores left must not still be
          // priced against an account none of them came from any more.
          clearStanding(opts.db, current());
          clearImportedMedals(opts.db, current());
          opts.db
            .prepare('UPDATE profiles SET tracking_since = ? WHERE id = ?')
            .run(now, current());
          opts.db.exec('COMMIT');
        } catch (e) {
          opts.db.exec('ROLLBACK');
          return json(res, { error: (e as Error).message }, 500);
        }

        opts.tracker.setTrackingSince(now);
        broadcast('reset', { deleted: before.n, trackingSince: now });
        console.log(`\n  profile reset -- ${before.n} play(s) erased, tracking from now\n`);
        json(res, { ok: true, deleted: before.n, trackingSince: now });
      });
      return;
    }

    /*
     * Importing plays made while the app was closed. Split into a preview and a commit on
     * purpose: the user picks a cutoff, sees exactly how many scores it would bring in,
     * and only then confirms. Nothing here ever runs by itself.
     */
    const backfill = /^\/api\/backfill(\/preview)?$/.exec(url.pathname);
    if (backfill && req.method === 'POST') {
      const preview = backfill[1] !== undefined;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        void (async () => {
          let since: number;
          let until: number | null = null;
          let confirmed = false;
          let applyFilter = true;
          let sources: BackfillSources = REPLAYS_ONLY;
          let installs: InstallChoice = null;
          try {
            const parsed = JSON.parse(body) as {
              since?: number;
              until?: number | null;
              confirm?: boolean;
              sources?: unknown;
              applyFilter?: boolean;
              installs?: unknown;
            };
            since = Number(parsed.since);
            // The end of the range. Absent or null means now, which is what an import was
            // before it could be given one.
            until = parsed.until === undefined || parsed.until === null ? null : Number(parsed.until);
            confirmed = parsed.confirm === true;
            // Absent means apply it, which is what an import did before it could be asked
            // not to -- so an older page, or a script, keeps the behaviour it expects.
            applyFilter = parsed.applyFilter !== false;
            // Which kinds of past play to bring in. Absent means replays alone, which is what an
            // import meant before it read lazer's logs; a name it does not know is ignored.
            if (Array.isArray(parsed.sources)) {
              const named = new Set(parsed.sources);
              sources = {
                replays: named.has('replays'),
                unfinished: named.has('unfinished'),
                attempts: named.has('attempts'),
              };
            }
            // Which osu! installs to look in, by root. Absent means every one, as before it
            // could be chosen; a root this app is not tracking is dropped (`InstallChoice`).
            if (Array.isArray(parsed.installs)) {
              installs = parsed.installs.filter((r): r is string => typeof r === 'string');
            }
          } catch {
            return json(res, { error: 'expected a JSON body with a "since" timestamp' }, 400);
          }

          // 0 is every play on this computer, however old: the dialog's All.
          if (!Number.isFinite(since) || since < 0) {
            return json(res, { error: '"since" must be a millisecond timestamp' }, 400);
          }
          if (since > Date.now()) {
            return json(res, { error: '"since" is in the future' }, 400);
          }
          if (until !== null) {
            if (!Number.isFinite(until)) {
              return json(res, { error: '"until" must be a millisecond timestamp' }, 400);
            }
            if (until <= since) return json(res, { error: '"until" must be after "since"' }, 400);
            // An end still to come is the same range as one ending now.
            if (until >= Date.now()) until = null;
          }
          if (!preview && !confirmed) {
            return json(res, { error: 'importing requires an explicit confirmation' }, 400);
          }
          if (installs !== null && !opts.installs.some((i) => installs.includes(i.root))) {
            return json(res, { error: 'choose at least one osu! install to look in' }, 400);
          }

          try {
            if (preview) {
              const scan = await opts.tracker.previewBackfill(since, applyFilter, until, installs);
              // The candidate list carries absolute paths; the page only needs the counts.
              return json(res, {
                since,
                until,
                scanned: scan.scanned,
                importable: scan.importable,
                duplicates: scan.duplicates,
                filtered: scan.filtered,
                starsUnchecked: scan.starsUnchecked,
                // Replays found in osu!'s folders that somebody else set -- ones watched,
                // not played. Never offered, and named so the dialog can say why the count
                // is lower than the folder holds.
                otherPlayers: scan.otherPlayers,
                earliest: scan.earliest,
                latest: scan.latest,
                // lazer's logs: counts only, by the same checks the import will make.
                log: scan.log,
              });
            }

            const result = await opts.tracker.backfill(since, sources, applyFilter, 'import', until, installs);
            broadcast('backfill', result);
            console.log(
              `\n  imported ${result.imported} past play(s) ` +
                `${since === 0 ? 'from every play on this computer' : `from ${new Date(since).toLocaleString()}`}` +
                `${until === null ? '' : ` to ${new Date(until).toLocaleString()}`}` +
                `${result.unfinished + result.attempts > 0 ? `, and from osu!lazer's logs ${result.unfinished} unfinished and ${result.attempts} not submitted` : ''}` +
                `${result.filtered > 0 ? ` (${result.filtered} declined by the tracking filter)` : ''}` +
                `${result.otherPlayers > 0 ? ` (${result.otherPlayers} were set by other players)` : ''}\n`,
            );
            return json(res, result);
          } catch (e) {
            return json(res, { error: (e as Error).message }, 500);
          }
        })();
      });
      return;
    }

    /*
     * Profile management. Several playstyles can be tracked side by side, each with its
     * own scores, pp and start date; only one is live at a time.
     */
    if (url.pathname === '/api/profiles' && req.method === 'POST') {
      return readBody(req, res, async (body) => {
        const action = String(body['action'] ?? '');
        try {
          switch (action) {
            case 'create': {
              const profile = createProfile(opts.db, body['name']);
              // A new profile is switched to immediately: creating one and then still
              // recording into the old one would be a trap.
              setActiveProfile(opts.db, profile.id);
              await opts.tracker.switchProfile(profile.id, profile.trackingSince);
              broadcast('profiles', { active: profile.id });
              console.log(`\n  new profile "${profile.name}" -- tracking from now\n`);
              return json(res, { ok: true, profile, profiles: listProfiles(opts.db) });
            }

            case 'switch': {
              const id = Number(body['id']);
              setActiveProfile(opts.db, id);
              const profile = getProfile(opts.db, id)!;
              await opts.tracker.switchProfile(profile.id, profile.trackingSince);
              broadcast('profiles', { active: profile.id });
              console.log(`\n  now tracking "${profile.name}"\n`);
              return json(res, { ok: true, profile, profiles: listProfiles(opts.db) });
            }

            case 'rename': {
              const profile = renameProfile(opts.db, Number(body['id']), body['name']);
              broadcast('profiles', { active: current() });
              return json(res, { ok: true, profile, profiles: listProfiles(opts.db) });
            }

            case 'delete': {
              if (body['confirm'] !== true) {
                return json(res, { error: 'deleting a profile requires an explicit confirmation' }, 400);
              }
              const id = Number(body['id']);
              const name = getProfile(opts.db, id)?.name ?? String(id);
              const result = deleteProfile(opts.db, id);
              const next = getProfile(opts.db, result.nextActive)!;
              await opts.tracker.switchProfile(next.id, next.trackingSince);
              broadcast('profiles', { active: next.id });
              console.log(`\n  deleted profile "${name}" (${result.deletedScores} score(s))\n`);
              return json(res, { ok: true, ...result, profiles: listProfiles(opts.db) });
            }

            default:
              return json(res, { error: `unknown action ${JSON.stringify(action)}` }, 400);
          }
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
      });
    }

    /*
     * Export the active profile as JSON: every score with the beatmap it was set on, plus
     * the computed totals. Replays stay on disk and are the real source of truth, but this
     * is portable, readable, and survives the app being deleted.
     */
    /*
     * The update check and the update itself.
     *
     * A GET reports what the last check found; a POST re-runs it. The automatic check is
     * at startup and then daily (`keepCheckingForUpdates`).
     */
    if (url.pathname === '/api/update') {
      if (req.method !== 'POST') return json(res, updateView());
      return void checkForUpdate().then(() => json(res, updateView()));
    }

    /*
     * Replace this install with the newest release and restart.
     *
     * The response is sent *before* the process exits, because the page has to be told what
     * is happening while it still has something to be told by. The exit is deliberate and
     * is what the detached updater is waiting for -- see scripts/apply-update.mjs.
     */
    if (url.pathname.startsWith('/api/update/') && req.method === 'POST' && !isOwnPage(req.headers.origin, req.socket.localPort)) {
      // Another website open in the browser must not be able to download or install anything.
      return json(res, { error: "only this app's own page can update it" }, 403);
    }

    /*
     * "When I quit": download it now, install it at the next deliberate quit or start. Answered
     * at once; the download's progress and outcome reach the page on the live feed.
     */
    if (url.pathname === '/api/update/later' && req.method === 'POST') {
      void prepareUpdate('user').catch(() => {});
      return json(res, { ok: true });
    }

    // What changed, after an update: seen, so it is not shown again.
    if (url.pathname === '/api/update/seen' && req.method === 'POST') {
      markSeen(opts.db, appVersion());
      return json(res, { ok: true });
    }

    // The notice above the page, put away for NUDGE_QUIET_DAYS or an important release.
    if (url.pathname === '/api/update/dismiss' && req.method === 'POST') {
      const latest = updateState().latestVersion;
      if (latest !== null) dismissNudge(opts.db, latest);
      broadcast('update', { ...updateView(), found: false });
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
      return void applyUpdate(opts.dataDir).then(
        (result) => {
          json(res, {
            ok: true,
            version: result.version,
            message: `Installing ${result.version}. The app will close and reopen.`,
          });
          // Long enough for the response to reach the browser, short enough that the
          // updater is not left waiting on a process with nothing left to do.
          // The exit code tells a launcher that restarts the app to wait for the swap.
          setTimeout(() => process.exit(result.exitCode), 750);
        },
        (e: Error) => json(res, { error: e.message }, 400),
      );
    }

    /*
     * Share & back up -> Export for a spreadsheet (src/export/). The scores alone as .csv, the one
     * file almost anyone can open; or the whole profile as an .xlsx workbook, a sheet per table.
     * Both are this profile, as its page shows it: its settings decide the pp, and removed
     * scores are not in either.
     */
    if ((url.pathname === '/api/export/scores.csv' || url.pathname === '/api/export/profile.xlsx') && req.method === 'GET') {
      const id = current();
      const profile = getProfile(opts.db, id)!;
      const e = eligibilityOf(settingsFor(id), opts.tracker.beatmaps.knowsStatus);
      // Whatever the profile is called, bar what a file name cannot hold on some system.
      const stem = `${profile.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'profile'}-${localDay(new Date())}`;
      const csv = url.pathname.endsWith('.csv');
      // In the language the page is in, which it says; the saved one, or English, if it does not.
      const lang = url.searchParams.get('lang');
      const t = translator(isLocale(lang) ? lang : opts.appConfig.get().language || 'en');
      const body = csv
        ? toCsv(scoresTable(opts.db, id, e, null, t))
        : toXlsx(workbookTables(opts.db, id, profile.name, e, favorites(), opts.tracker.beatmaps, t));
      res.writeHead(200, {
        'content-type': csv
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': attachmentHeader(csv ? `${stem}-scores.csv` : `${stem}.xlsx`),
        'content-length': body.length,
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/export') {
      const id = current();
      const profile = getProfile(opts.db, id)!;
      const settings = settingsFor(id);
      const modes = [0, 1, 2, 3] as Ruleset[];
      const payload = {
        exportedAt: new Date().toISOString(),
        app: 'osu! local profiles',
        profile: {
          name: profile.name,
          createdAt: profile.createdAt,
          trackingSince: profile.trackingSince,
          country: settings.country,
          tagline: settings.tagline,
        },
        settings,
        modes: modes.map((mode) => ({
          mode,
          stats: computeStats(opts.db, id, mode, eligibilityOf(settings, opts.tracker.beatmaps.knowsStatus)),
          rank: estimateRank(
            computeStats(opts.db, id, mode, eligibilityOf(settings, opts.tracker.beatmaps.knowsStatus)).totalPp,
            mode,
          ),
          scores: opts.db
            .prepare(
              `SELECT s.*, b.artist, b.title, b.version, b.creator, b.beatmapset_id
                 FROM scores s
                 LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
                -- A score removed from the profile is not one of its scores, here as anywhere.
                WHERE s.profile_id = ? AND s.mode = ? AND ${visibleSql()}
                ORDER BY s.played_at ASC`,
            )
            .all(id, mode),
        })).filter((m) => m.stats.playcount > 0),
      };

      const filename = `${profile.name.replace(/[^\w.-]+/g, '-')}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    /*
     * Back up everything: every profile, with the pictures and me! images kept beside the
     * database, as one zip laid out the way `data/` is. See src/backup.ts.
     */
    if (url.pathname === '/api/backup') {
      const at = new Date();
      let zip: Buffer;
      try {
        zip = createBackup(opts.db, opts.dataDir, at);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 500);
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${backupFileName(at)}"`,
        'cache-control': 'no-store',
      });
      res.end(zip);
      return;
    }

    /*
     * Restore from a backup, in two steps so the page can say what it is about to replace
     * everything with: a PUT of the file checks and stages it and answers with its profiles,
     * then a POST applies it by restarting (or a DELETE drops it). Only this app's own page
     * may do any of it, as with Quit: any website open in the browser can send a POST here.
     */
    if (url.pathname === '/api/restore' || url.pathname === '/api/restore/apply') {
      if (!isOwnPage(req.headers.origin, req.socket.localPort)) {
        return json(res, { error: "only this app's own page can restore a backup" }, 403);
      }

      if (url.pathname === '/api/restore' && req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
          if (aborted) return;
          size += chunk.length;
          if (size > MAX_BACKUP_BYTES) {
            aborted = true;
            json(res, { error: 'that file is too large to be a backup (1GB max)' }, 413);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          try {
            return json(res, { ok: true, ...stageRestore(opts.dataDir, Buffer.concat(chunks)) });
          } catch (e) {
            return json(res, { error: (e as Error).message }, 400);
          }
        });
        return;
      }

      if (url.pathname === '/api/restore' && req.method === 'DELETE') {
        discardRestore(opts.dataDir);
        return json(res, { ok: true });
      }

      if (url.pathname === '/api/restore/apply' && req.method === 'POST') {
        try {
          markRestoreReady(opts.dataDir);
        } catch (e) {
          return json(res, { error: (e as Error).message }, 400);
        }
        const restart = opts.onRestart;
        if (restart) res.once('finish', () => setTimeout(restart, 250));
        return json(res, { ok: true, restarting: Boolean(restart) });
      }
    }

    /*
     * Where `data/` is, for Share & back up's note that copying it is a backup too. An
     * endpoint of its own rather than a field in /api/state, because the saved web page is
     * built from /api/state and must hold nothing about this computer.
     */
    if (url.pathname === '/api/data-folder' && req.method === 'GET') {
      return json(res, { path: opts.dataDir });
    }

    if (url.pathname === '/api/data-folder/open' && req.method === 'POST') {
      if (!isOwnPage(req.headers.origin, req.socket.localPort)) {
        return json(res, { error: "only this app's own page can open the data folder" }, 403);
      }
      openFolder(opts.dataDir);
      return json(res, { ok: true });
    }

    if (url.pathname === '/api/tracking' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let enabled = !opts.tracker.isTracking;
        try {
          enabled = Boolean((JSON.parse(body) as { enabled?: boolean }).enabled);
        } catch {
          /* toggle */
        }
        opts.tracker.setTracking(enabled);
        broadcast('tracking', { tracking: enabled });
        json(res, { tracking: opts.tracker.isTracking });
      });
      return;
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* dropped */
        }
      }, 20_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    // Static files.
    /*
     * A score's own page: this app's `osu.ppy.sh/scores/<id>`. One file for every id; the page
     * reads the id from its address and asks /api/scores/<id> for the rest.
     */
    const rel = url.pathname === '/'
      ? 'index.html'
      : /^\/scores\/\d+\/?$/.test(url.pathname)
        ? 'score.html'
        : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(webRoot, rel);
    if (!file.startsWith(webRoot)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        // Without this the page and its modules carry no freshness information at all, and a
        // browser is free to keep serving them from its own cache indefinitely -- so an update
        // swapped in underneath the app would still be running last week's UI against this
        // week's API. `no-cache` still caches; it only requires a revalidation first.
        'cache-control': 'no-cache',
      });
      res.end(buf);
    });
  });

  server.on('close', stopUpdateFeed);
  server.listen(opts.port);
  return server;
}
