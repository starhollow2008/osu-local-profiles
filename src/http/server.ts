import { aboutImageFile, saveAboutImage } from '../about-images.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.ts';
import type { Tracker } from '../tracker/index.ts';
import type { OsuInstall } from '../clients/detect.ts';
import type { Ruleset } from '../osr.ts';
import {
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

/**
 * The most rows one request may ask a section for.
 *
 * The page expands 25 at a time and would have to be driven for a very long while to reach
 * this. It is here because the limits arrive as query parameters, and an unbounded one lets
 * a stray URL ask the database to assemble every score ever tracked.
 */
const MAX_PAGE = 2000;
import { computeMedals, earnedMedalCount } from '../calc/medals.ts';
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
import { getSettings, updateSettings, type Settings } from '../settings.ts';
import { appVersion } from '../config.ts';
import { applyUpdate, checkForUpdate, updateState } from '../update/index.ts';
import { filterNarrows } from '../tracking-filter.ts';
import { eligibilityOf, type Eligibility } from '../calc/eligibility.ts';
import { capture, findBrowser } from './screenshot.ts';
import { detectLocalSessions } from '../clients/session.ts';
import { downloadImage, fetchBeatmapset, fetchFavouriteBeatmapsets, lookupUser } from '../clients/osu-web.ts';
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
}

/** What of config.json the page is allowed to see and change. Deliberately small. */
export interface AppConfig {
  /** Open the page in the default browser when the app starts. */
  openBrowser: boolean;
  /** One Favorite Beatmaps list for every profile (the default), or one each. */
  sharedFavorites?: boolean;
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
   * A play the tracking filter declined. Broadcast because it is the only trace of it: nothing
   * is written, so a page that said nothing would leave "why was that play not counted?"
   * unanswerable -- and that question is exactly what a too-tight filter produces.
   */
  opts.tracker.on('filtered', (play) => broadcast('filtered', play));
  opts.tracker.on('error', (err) => broadcast('tracker-error', { message: err.message }));
  // The beatmap index runs beside the page; it shows the progress while plays wait on it.
  opts.tracker.on('indexing', (state) => broadcast('indexing', state));

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
        recentTotal: recentPlayTotal(opts.db, profileId, mode),
        mostPlayedCount: mostPlayedTotal(opts.db, profileId, mode),
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

    if (url.pathname === '/api/state') {
      const profile = getProfile(opts.db, current())!;
      const settings = settingsFor(profile.id);
      return json(res, {
        settings,
        // What is running, so the page can print it and the update check has something to
        // compare against. Null when package.json could not be read, which the page shows
        // as an unknown version rather than inventing one.
        app: { version: appVersion(), update: updateState(), config: opts.appConfig.get() },
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
        // Plays the tracking filter has declined since the app started. They leave no row
        // anywhere, so this running count is the only record there is.
        playsFiltered: opts.tracker.playsFiltered,
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
        // Whether the Share dialog can offer an image as well as a web page.
        sharing: { canScreenshot: findBrowser() !== null },
        defaultMode: mostRecentMode(opts.db, current()),
        modesWithPlays: modesWithPlays(opts.db, current()),
        installs: opts.installs.map((i) => ({
          kind: i.kind,
          root: i.root,
          hasOnlineDb: i.onlineDb !== null,
        })),
      });
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
        counting: e,
        // Estimated offline from a data.ppy.sh sample, and null when no curve has been
        // built for this mode. Country rank has no equivalent: 10,000 users split across
        // ~200 countries is far too thin to interpolate per country.
        rank: estimateRank(stats.totalPp, mode),
        rankSource: table === null ? null : { dump: table.dump, sampled: table.sampled },
        medals,
        // osu!'s header figure: every medal the profile holds, whichever mode is showing.
        medalTotal,
        pinned: remember(`pinned:${rulesKey}`, () => pinnedPlays(opts.db, profileId, mode, e)),
        top: remember(`top:${rulesKey}:${page('top', 100)}`, () =>
          topPlays(opts.db, profileId, mode, page('top', 100), e),
        ),
        // Recent Plays reads only the newest rows through an index, so it is not worth keeping.
        recent: recentPlays(opts.db, profileId, mode, page('recent', 25), e, settings.showIncompleteInRecent),
        mostPlayed: remember(`mostPlayed:${profileId}:${mode}:${page('mostPlayed', 15)}`, () =>
          mostPlayed(opts.db, profileId, mode, page('mostPlayed', 15)),
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
        for (const key of ['openBrowser', 'sharedFavorites'] as const) {
          if (!(key in body)) continue;
          if (typeof body[key] !== 'boolean') return json(res, { error: `${key} must be true or false` }, 400);
          patch[key] = body[key];
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
        const onlyMissing = body['all'] !== true;
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

              const patch: Record<string, unknown> = { linkedUserId: user.id, linkedUsername: user.username };
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

              broadcast('identity', { linked: user.id });
              broadcast('settings', settingsFor(id));
              if (favouritesAdded > 0) broadcast('favorites', { action: 'import' });
              return json(res, {
                ok: true,
                user,
                done,
                failures,
                favorites: { found: favouritesFound, added: favouritesAdded },
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
        try {
          if (action === 'reorder') {
            const ids = Array.isArray(body['ids']) ? (body['ids'] as unknown[]).map(Number) : [];
            reorderPins(opts.db, current(), ids);
          } else if (action === 'list-hidden') {
            return json(res, { hidden: hiddenScores(opts.db, current()) });
          } else if (action === 'delete' || action === 'delete-all-removed') {
            // For good: see deleteRemovedScores, and why the key outlives the row.
            const deleted = deleteRemovedScores(
              opts.db,
              current(),
              action === 'delete' ? [Number(body['id'])] : 'all',
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
          // With no banner of its own, a profile shows its best play's art -- in this mode.
          const best = images.hasCover
            ? null
            : topPlays(opts.db, owner.id, detail.mode, 1, rules)[0];
          return json(res, {
            score: detail,
            // What prices scores now, so the card can say when this one came from another.
            calculator: opts.tracker.calculatorVersion,
            owner: {
              id: owner.id,
              name: owner.name,
              country: settingsFor(owner.id).country,
              avatar: images.hasAvatar ? `/api/image/avatar?profile=${owner.id}` : null,
              cover: images.hasCover
                ? `/api/image/cover?profile=${owner.id}`
                : best?.beatmapsetId
                  ? `https://assets.ppy.sh/beatmaps/${best.beatmapsetId}/covers/cover@2x.jpg`
                  : null,
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
          let confirmed = false;
          try {
            const parsed = JSON.parse(body) as { since?: number; confirm?: boolean };
            since = Number(parsed.since);
            confirmed = parsed.confirm === true;
          } catch {
            return json(res, { error: 'expected a JSON body with a "since" timestamp' }, 400);
          }

          if (!Number.isFinite(since) || since <= 0) {
            return json(res, { error: '"since" must be a millisecond timestamp' }, 400);
          }
          if (since > Date.now()) {
            return json(res, { error: '"since" is in the future' }, 400);
          }
          if (!preview && !confirmed) {
            return json(res, { error: 'importing requires an explicit confirmation' }, 400);
          }

          try {
            if (preview) {
              const scan = await opts.tracker.previewBackfill(since);
              // The candidate list carries absolute paths; the page only needs the counts.
              return json(res, {
                since,
                scanned: scan.scanned,
                importable: scan.importable,
                duplicates: scan.duplicates,
                filtered: scan.filtered,
                starsUnchecked: scan.starsUnchecked,
                earliest: scan.earliest,
                latest: scan.latest,
              });
            }

            const result = await opts.tracker.backfill(since);
            broadcast('backfill', result);
            console.log(
              `\n  imported ${result.imported} past play(s) from ` +
                `${new Date(since).toLocaleString()}` +
                `${result.filtered > 0 ? ` (${result.filtered} declined by the tracking filter)` : ''}\n`,
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
     * A GET reports what the last check found; a POST re-runs it. Both are cheap and
     * neither is on a timer -- the automatic check happens once, at startup.
     */
    if (url.pathname === '/api/update') {
      if (req.method !== 'POST') return json(res, updateState());
      return void checkForUpdate().then((s) => json(res, s));
    }

    /*
     * Replace this install with the newest release and restart.
     *
     * The response is sent *before* the process exits, because the page has to be told what
     * is happening while it still has something to be told by. The exit is deliberate and
     * is what the detached updater is waiting for -- see scripts/apply-update.mjs.
     */
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
          setTimeout(() => process.exit(0), 750);
        },
        (e: Error) => json(res, { error: e.message }, 400),
      );
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
                WHERE s.profile_id = ? AND s.mode = ?
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
     * A copy of the whole database, every profile included.
     *
     * `VACUUM INTO` rather than copying the file: the database runs in WAL mode, so the
     * .db on disk is not self-contained and a plain copy can miss the most recent writes.
     * This produces a consistent, already-compacted snapshot.
     */
    if (url.pathname === '/api/backup') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(opts.dataDir, `backup-${stamp}.db`);
      try {
        fs.rmSync(file, { force: true });
        opts.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      } catch (e) {
        return json(res, { error: (e as Error).message }, 500);
      }

      fs.readFile(file, (err, buf) => {
        if (err) return json(res, { error: err.message }, 500);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="osu-local-profiles-${stamp}.db"`,
          'cache-control': 'no-store',
        });
        res.end(buf);
        // The download has the bytes; leaving a copy in data/ would just accumulate.
        fs.rmSync(file, { force: true });
      });
      return;
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

  server.listen(opts.port);
  return server;
}
