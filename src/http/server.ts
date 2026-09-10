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
  mostRecentMode,
  pinnedPlays,
  recentPlays,
  topPlays,
} from '../calc/stats.ts';
import { buildHistory } from '../calc/history.ts';
import { computeMedals } from '../calc/medals.ts';
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
import { eligibilityOf } from '../calc/eligibility.ts';
import { detectLocalSessions } from '../clients/session.ts';
import { downloadImage, lookupUser } from '../clients/osu-web.ts';
import {
  clearImage,
  findImage,
  imageState,
  MIME_FOR_EXTENSION,
  saveImage,
  sniffImage,
  type ImageKind,
} from '../identity.ts';
import {
  applyScoreAction,
  hiddenCount,
  hiddenScores,
  reorderPins,
  type ScoreAction,
} from '../scores.ts';

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
}

export function startServer(opts: ServerOptions): http.Server {
  const sseClients = new Set<http.ServerResponse>();

  /*
   * Which profile every request is about. Read live rather than captured at startup,
   * because the page can switch profiles while the server is running -- freezing it here
   * would leave the API answering about a profile the user has already left.
   */
  const current = () => activeProfileId(opts.db);

  /*
   * config.json's country and tagline are the *fallback* for a profile that has never
   * edited them, not the value. Anything the user saves from the page is stored per
   * profile and wins from then on, empty included.
   */
  const configFallbacks: Partial<Settings> = { country: opts.country, tagline: opts.tagline };
  const settingsFor = (profileId: number) => getSettings(opts.db, profileId, configFallbacks);
  /** How this profile counts scores right now. Read per request, never captured. */
  const rules = () => eligibilityOf(settingsFor(current()));


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
  opts.tracker.on('error', (err) => broadcast('tracker-error', { message: err.message }));

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

    if (url.pathname === '/api/state') {
      const profile = getProfile(opts.db, current())!;
      const settings = settingsFor(profile.id);
      return json(res, {
        settings,
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
        // Scores ingested before the eligibility columns existed. Non-zero means the
        // Settings dialog should offer a recompute rather than silently under-reporting.
        staleScores: opts.tracker.staleScores,
        // Scores removed from the profile. They are never deleted, so they can be put back.
        hiddenScores: hiddenCount(opts.db, current()),
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
      const e = rules();
      const history = buildHistory(opts.db, current(), mode, 15, e);
      const stats = computeStats(opts.db, current(), mode, e);
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
        medals: computeMedals(opts.db, current(), mode, e),
        pinned: pinnedPlays(opts.db, current(), mode, e),
        top: topPlays(opts.db, current(), mode, 100, e),
        recent: recentPlays(opts.db, current(), mode, 25, e),
        mostPlayed: mostPlayed(opts.db, current(), mode, 15),
        ppHistory: history.pp,
        // osu-web charts global rank here, so do the same wherever a curve exists.
        rankHistory: history.pp.map((p) => ({ at: p.at, rank: estimateRank(p.pp, mode)?.rank ?? null })),
        monthlyPlaycounts: history.monthlyPlaycounts,
        events: history.events,
      });
    }

    // This profile's avatar or banner, served only if it has one.
    const image = /^\/api\/image\/(avatar|cover)$/.exec(url.pathname);
    if (image && req.method !== 'PUT') {
      const file = findImage(opts.dataDir, current(), image[1] as ImageKind);
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
          .prepare('SELECT COUNT(*) AS n FROM scores WHERE profile_id = ?')
          .get(current()) as { n: number };

        const now = Date.now();
        // Moving tracking_since forward is what makes this a *fresh* profile: without it
        // the watcher would re-accept replays already on disk from before the reset.
        opts.db.exec('BEGIN');
        try {
          opts.db.prepare('DELETE FROM scores WHERE profile_id = ?').run(current());
          opts.db.prepare('DELETE FROM snapshots WHERE profile_id = ?').run(current());
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
        console.log(`\n  profile reset -- ${before.n} score(s) erased, tracking from now\n`);
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
                earliest: scan.earliest,
                latest: scan.latest,
              });
            }

            const result = await opts.tracker.backfill(since);
            broadcast('backfill', result);
            console.log(
              `\n  imported ${result.imported} past play(s) from ` +
                `${new Date(since).toLocaleString()}\n`,
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
    if (url.pathname === '/api/export') {
      const id = current();
      const profile = getProfile(opts.db, id)!;
      const settings = settingsFor(id);
      const modes = [0, 1, 2, 3] as Ruleset[];
      const payload = {
        exportedAt: new Date().toISOString(),
        app: 'osu! fresh profile',
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
          stats: computeStats(opts.db, id, mode, eligibilityOf(settings)),
          rank: estimateRank(computeStats(opts.db, id, mode, eligibilityOf(settings)).totalPp, mode),
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
          'content-disposition': `attachment; filename="osu-fresh-profile-${stamp}.db"`,
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
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
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
      });
      res.end(buf);
    });
  });

  server.listen(opts.port);
  return server;
}
