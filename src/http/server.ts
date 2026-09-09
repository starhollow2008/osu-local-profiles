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
  recentPlays,
  topPlays,
} from '../calc/stats.ts';
import { buildHistory } from '../calc/history.ts';
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

/**
 * Images the user can drop into `data/` to personalise the profile, in preference order.
 * Nothing is required: without them the page draws its own avatar and uses the cover of
 * the profile's best play.
 */
const LOCAL_IMAGES: Record<string, string[]> = {
  avatar: ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp'],
  cover: ['cover.jpg', 'cover.png', 'cover.jpeg', 'cover.webp'],
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

  const localImage = (kind: string): string | null => {
    for (const name of LOCAL_IMAGES[kind] ?? []) {
      const file = path.join(opts.dataDir, name);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };

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
      return json(res, {
        profile: {
          id: profile.id,
          name: profile.name,
          country: opts.country,
          tagline: opts.tagline,
          createdAt: profile.createdAt,
          trackingSince: profile.trackingSince,
          hasAvatar: localImage('avatar') !== null,
          hasCover: localImage('cover') !== null,
        },
        profiles: listProfiles(opts.db),
        tracking: opts.tracker.isTracking,
        scoresThisSession: opts.tracker.scoresAdded,
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
      const history = buildHistory(opts.db, current(), mode);
      const stats = computeStats(opts.db, current(), mode);
      const table = rankTable(mode);
      return json(res, {
        mode,
        stats,
        // Estimated offline from a data.ppy.sh sample, and null when no curve has been
        // built for this mode. Country rank has no equivalent: 10,000 users split across
        // ~200 countries is far too thin to interpolate per country.
        rank: estimateRank(stats.totalPp, mode),
        rankSource: table === null ? null : { dump: table.dump, sampled: table.sampled },
        top: topPlays(opts.db, current(), mode, 100),
        recent: recentPlays(opts.db, current(), mode, 25),
        mostPlayed: mostPlayed(opts.db, current(), mode, 15),
        ppHistory: history.pp,
        // osu-web charts global rank here, so do the same wherever a curve exists.
        rankHistory: history.pp.map((p) => ({ at: p.at, rank: estimateRank(p.pp, mode)?.rank ?? null })),
        monthlyPlaycounts: history.monthlyPlaycounts,
        events: history.events,
      });
    }

    // data/avatar.* and data/cover.*, served only if the user put one there.
    const image = /^\/api\/image\/(avatar|cover)$/.exec(url.pathname);
    if (image) {
      const file = localImage(image[1]!);
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
      const modes = [0, 1, 2, 3] as Ruleset[];
      const payload = {
        exportedAt: new Date().toISOString(),
        app: 'osu! fresh profile',
        profile: {
          name: profile.name,
          createdAt: profile.createdAt,
          trackingSince: profile.trackingSince,
          country: opts.country,
          tagline: opts.tagline,
        },
        modes: modes.map((mode) => ({
          mode,
          stats: computeStats(opts.db, id, mode),
          rank: estimateRank(computeStats(opts.db, id, mode).totalPp, mode),
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
