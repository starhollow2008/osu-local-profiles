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
  profileId: number;
  profileName: string;
  country: string;
  tagline: string;
  dataDir: string;
  port: number;
}

export function startServer(opts: ServerOptions): http.Server {
  const sseClients = new Set<http.ServerResponse>();

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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/state') {
      return json(res, {
        profile: {
          id: opts.profileId,
          name: opts.profileName,
          country: opts.country,
          tagline: opts.tagline,
          createdAt: (
            opts.db
              .prepare('SELECT created_at FROM profiles WHERE id = ?')
              .get(opts.profileId) as { created_at: number }
          ).created_at,
          hasAvatar: localImage('avatar') !== null,
          hasCover: localImage('cover') !== null,
        },
        tracking: opts.tracker.isTracking,
        scoresThisSession: opts.tracker.scoresAdded,
        defaultMode: mostRecentMode(opts.db, opts.profileId),
        modesWithPlays: modesWithPlays(opts.db, opts.profileId),
        installs: opts.installs.map((i) => ({
          kind: i.kind,
          root: i.root,
          hasOnlineDb: i.onlineDb !== null,
        })),
      });
    }

    if (url.pathname === '/api/profile') {
      const mode = (Number(url.searchParams.get('mode') ?? '0') || 0) as Ruleset;
      const history = buildHistory(opts.db, opts.profileId, mode);
      return json(res, {
        mode,
        stats: computeStats(opts.db, opts.profileId, mode),
        top: topPlays(opts.db, opts.profileId, mode, 100),
        recent: recentPlays(opts.db, opts.profileId, mode, 25),
        mostPlayed: mostPlayed(opts.db, opts.profileId, mode, 15),
        ppHistory: history.pp,
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
          .get(opts.profileId) as { n: number };

        const now = Date.now();
        // Moving tracking_since forward is what makes this a *fresh* profile: without it
        // the watcher would re-accept replays already on disk from before the reset.
        opts.db.exec('BEGIN');
        try {
          opts.db.prepare('DELETE FROM scores WHERE profile_id = ?').run(opts.profileId);
          opts.db.prepare('DELETE FROM snapshots WHERE profile_id = ?').run(opts.profileId);
          opts.db
            .prepare('UPDATE profiles SET tracking_since = ? WHERE id = ?')
            .run(now, opts.profileId);
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
