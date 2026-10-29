/**
 * Do the Node app and its C# port answer the same? (docs/csharp-port.md, rule 3)
 *
 *   node scripts/api-parity.mjs [data folder] [--keep]
 *
 * Starts both apps on copies of one `data/` folder (default: this checkout's), asks each the
 * same questions, and compares the answers: JSON as parsed values, files byte for byte, plus
 * status and headers. Exit 0 when every answer matches, 1 when any differs.
 *
 * Nothing is written to the data folder given: the database is copied with VACUUM INTO, which
 * reads a consistent snapshot even while the app is running on it. The Node app still needs an
 * osu! installation to start, so this runs on a player's machine, not in CI.
 *
 * Each endpoint the port answers goes in ENDPOINTS, and each write in `writeSteps`, which ends
 * the run by sending both apps the same writes and comparing their answers, live feeds and
 * tables. A field left out of the comparison is listed with the reason, so a difference is never
 * ignored without saying why. The copies point at the uploads in the real data/replays: the
 * writes are chosen so that none is let go of, and the run fails if one goes missing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { entryData, extractZip, readZipEntries } from '../src/update/zip.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fields not compared, by endpoint, each with why. Paths are dotted (`settings.country`). */
const ENDPOINTS = [
  {
    path: '/api/app',
    ignore: {
      pid: 'each app is its own process',
    },
  },
  { path: '/api/settings' },
  { path: '/api/state' },
  { path: '/api/app-config' },
  { path: '/api/declined' },
  { path: '/api/data-folder', ignore: { path: 'each app runs on its own copy of data/' } },
  // Every mode, with the page's own first pages, and with every section asked for in full.
  ...[0, 1, 2, 3].flatMap((mode) => [
    { path: `/api/profile?mode=${mode}` },
    { path: `/api/profile?mode=${mode}&top=100&recent=10000&mostPlayed=10000&favorites=10000&events=10000` },
  ]),
  // What the page never sends, read as the Node app reads it.
  { path: '/api/profile?mode=abc&top=0&recent=-3&events=2.9' },
];

/** Endpoints whose answer depends on the active profile, asked again for every other profile. */
const PER_PROFILE = ['/api/settings', '/api/declined', '/api/profile'];

/** Files and pages, compared byte for byte. */
const STATIC = ['/', '/scores/1', '/scores/1/', '/js/main.js', '/css/base.css', '/favicon.svg', '/i18n/en.json', '/no-such-file.js'];

/** Headers that must match on every answer. */
const HEADERS = ['content-type', 'cache-control', 'content-disposition'];

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const source = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(repo, 'data'));
const exe = process.platform === 'win32' ? '.exe' : '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Every link made, removed on its own before the work folder is, so a delete never follows one. */
const links = [];

/** A folder reached through a link, so the copy shares it without copying it. */
function link(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(at);
}

/** Remove the links, then the work folder, but only if no link is left in it. */
function cleanUp(work) {
  for (const at of links) {
    try {
      fs.unlinkSync(at);
    } catch {
      /* checked below */
    }
  }
  const left = links.filter((at) => {
    try {
      fs.lstatSync(at);
      return true;
    } catch {
      return false;
    }
  });
  if (left.length > 0) {
    console.log(`  left ${work} in place: could not remove the link(s) ${left.join(', ')}`);
    return;
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

/** `data/` for one app: the database snapshot, and the top-level files beside it. */
function copyData(to, port) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('profiles.db') || entry.name === 'update.log') continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(to, entry.name));
  }
  const snapshot = new DatabaseSync(path.join(source, 'profiles.db'), { readOnly: true });
  snapshot.exec(`VACUUM INTO '${path.join(to, 'profiles.db').replaceAll("'", "''")}'`);
  snapshot.close();
  // No catch-up: an import can let go of an uploaded replay, and the copies' replays are the real
  // data folder's own files. Tracking otherwise runs as it does for the player.
  const copy = new DatabaseSync(path.join(to, 'profiles.db'));
  copy.exec(`INSERT INTO profile_settings (profile_id, key, value)
               SELECT id, 'importPlaysWhileClosed', 'false' FROM profiles WHERE true
               ON CONFLICT (profile_id, key) DO UPDATE SET value = excluded.value`);
  copy.close();

  const file = path.join(to, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // Its own port, no browser, and no request of its own to GitHub.
  Object.assign(config, { port, openBrowser: false, checkForUpdates: false, autoUpdate: false });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

async function waitFor(port, child, name, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode}) before answering; see its log`);
    try {
      const r = await fetch(`http://localhost:${port}/api/app`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not answer within ${timeoutMs / 1000}s`);
}

/**
 * Until the work each app does after its start is over: the beatmap index, an import, a
 * recalculation. Then a moment more, for what follows them without saying so.
 */
async function settled(port, timeoutMs = 600_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await (await fetch(`http://localhost:${port}/api/state`)).json();
    if (!state.indexing.active && !state.importing.active && !state.ppCalculator.recalculating) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

/** Whether a dotted path is left out: named exactly, or by a pattern where `*` stands for one part. */
function ignored(ignore, dotted) {
  if (Object.hasOwn(ignore, dotted)) return true;
  const parts = dotted.split('.');
  return Object.keys(ignore).some((key) => {
    const want = key.split('.');
    return key.includes('*') && want.length === parts.length && want.every((w, i) => w === '*' || w === parts[i]);
  });
}

/** Every difference between two parsed values, as `path: node | cs` lines. Key order is not one. */
function differences(a, b, at = '', ignore = {}) {
  if (ignored(ignore, at.slice(1))) return [];
  if (isDeepStrictEqual(a, b)) return [];
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) return [`${at.slice(1) || '(whole answer)'}: node ${JSON.stringify(a)} | cs ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) => differences(a[key], b[key], `${at}.${key}`, ignore));
}

/**
 * One request, answered whenever it is answered. Not `fetch`, which gives up on an answer whose
 * headers take more than five minutes: importing a whole osu! account takes longer than that.
 */
function ask(port, pathname, init) {
  const body = init?.body === undefined ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body, 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port, path: pathname, method: init?.method ?? 'GET', headers: { ...(body ? { 'content-length': body.length } : {}), ...init?.headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = Object.fromEntries(HEADERS.map((h) => [h, res.headers[h] === undefined ? null : String(res.headers[h])]));
          resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

/* ---------------------------------------------------------------- the writes */

/**
 * Columns holding the moment an app did something, left out when the tables are compared: each
 * app did it at its own moment. The `kv` keys the same.
 */
const MOMENTS = new Set([
  'created_at', 'tracking_since', 'hidden_at', 'pinned_at', 'declined_at', 'deleted_at',
  'imported_at', 'cached_at', 'indexed_at', 'fetched_at', 'favorited_at',
]);
const KV_MOMENTS = new Set(['lastRunAt']);

/** Tables not compared, each with why. */
const TABLES_SKIPPED = {};

/**
 * Fields of every answer a write is followed by that hold a moment, or a number osu! keeps
 * changing, each with why. osu!'s counts are asked once per app, a minute or two apart.
 */
const AFTER_IGNORED = {
  'imported.importedAt': 'the moment each app imported it',
  'favorites.*.favoritedAt': 'the moment each app favourited it',
  'favorites.*.playCount': "osu!'s own count, which moves between the two apps asking",
  'favorites.*.favouriteCount': 'the same',
};

/** In `beatmapset_details`, the counts osu! keeps changing, as above. */
const LIVE_DETAILS = ['playCount', 'favouriteCount'];

/** Events left out of the feed comparison, each with why. */
const EVENTS_SKIPPED = {
  'rank-events': 'sent when osu! answers the rank event watcher, which each app asks at its own moment',
};

/** Events whose count depends on timing: only the last of each is compared. */
const PROGRESS_EVENTS = new Set(['indexing', 'importing', 'recompute-progress', 'osu-progress']);

/** Every event an app's live feed sends from now until `stop()`, parsed. */
function listen(port) {
  const events = [];
  const controller = new AbortController();
  const done = (async () => {
    const r = await fetch(`http://localhost:${port}/api/events`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of r.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffered.indexOf('\n\n')) !== -1) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (name !== undefined) events.push({ name, data: data === undefined ? null : JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return {
    events,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

/**
 * A copy's tables, every row with its moments taken out and the copy's own data folder named
 * `<data>` (where a downloaded beatmap or a built replay is kept), sorted so the order rows were
 * written in is not compared.
 */
function tables(file, dataDir = path.dirname(file)) {
  const own = JSON.stringify(dataDir).slice(1, -1);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    return new Map(names.filter((name) => !Object.hasOwn(TABLES_SKIPPED, name)).map((name) => {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().map((row) => {
        if (name === 'kv' && KV_MOMENTS.has(row.key)) return JSON.stringify({ key: row.key });
        // The notice's dismissal keeps the version and the moment; the moment is each app's own.
        if (name === 'kv' && row.key === 'updateNudgeDismissed') {
          try {
            const { at: _, ...rest } = JSON.parse(row.value);
            return JSON.stringify({ key: row.key, value: rest });
          } catch {
            /* compared as it is */
          }
        }
        if (name === 'beatmapset_details' && typeof row.data === 'string') {
          try {
            const data = JSON.parse(row.data);
            for (const key of LIVE_DETAILS) delete data[key];
            row = { ...row, data: JSON.stringify(data) };
          } catch {
            /* compared as it is */
          }
        }
        return JSON.stringify(Object.fromEntries(Object.entries(row).filter(([column]) => !MOMENTS.has(column)))).replaceAll(own, '<data>');
      });
      return [name, rows.sort()];
    }));
  } finally {
    db.close();
  }
}

/** The files in a folder, by name, or none when it is not there. */
function listing(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * The same writes, in the same order, to both apps, built from what the copy holds. Each step's
 * answer is compared, then the answers it should have changed (`after`). Removing, emptying and
 * deleting happen in a profile made for it, never one with the player's own plays: a play turned
 * away can point at an uploaded replay in the real data/replays, which the copies share, and
 * letting go of the play would delete that file.
 */
function writeSteps(file, csData) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const active = Number(db.prepare("SELECT value FROM kv WHERE key = 'activeProfileId'").get()?.value);
    const visible = db
      .prepare('SELECT id, mode FROM scores WHERE profile_id = ? AND hidden_at IS NULL ORDER BY played_at DESC LIMIT 3')
      .all(active);
    const unfinished = db
      .prepare('SELECT id FROM incomplete_plays WHERE profile_id = ? AND hidden_at IS NULL ORDER BY played_at DESC LIMIT 1')
      .get(active);
    // Plays not tracked with no uploaded copy to let go of.
    const declined = db
      .prepare("SELECT id, replay_path FROM declined_plays WHERE profile_id = ? AND kind = 'score' ORDER BY declined_at DESC")
      .all(active)
      .filter((r) => r.replay_path === null || !/[\\/]replays[\\/][0-9a-f]{32}\.osr$/.test(r.replay_path))
      .slice(0, 2);
    // A replay osu! wrote, to upload.
    const upload = db
      .prepare("SELECT replay_path FROM scores WHERE replay_path IS NOT NULL AND origin IS NULL AND client <> 'mcosu' ORDER BY played_at DESC")
      .all()
      .map((r) => r.replay_path)
      .find((p) => !/[\\/]replays[\\/][0-9a-f]{32}\.osr$/.test(p) && fs.existsSync(p));
    const nextProfile = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM profiles').get().id);
    const picture = fs.readFileSync(path.join(repo, 'web', 'feed-icons', 'level-up.png'));
    const monthAgo = Date.now() - 30 * 86_400_000;
    const profile = (mode) => `/api/profile?mode=${mode}&top=100&recent=10000&mostPlayed=10000&events=10000`;
    const turnedAway = { 'plays.*.declinedAt': 'the moment each app turned the play away' };
    const created = { 'profile.createdAt': 'the moment each app made it', 'profile.trackingSince': 'the same', 'profiles.*.createdAt': 'the same', 'profiles.*.trackingSince': 'the same' };

    const [first, second, third] = visible;

    // The player's own osu! account, as linked to the profile on screen, for the steps that ask osu!.
    const setting = (key) => {
      const row = db.prepare('SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?').get(active, key);
      return row === undefined ? null : JSON.parse(row.value);
    };
    const linked = setting('linkedUsername') || null;
    // A score osu! has, set on lazer, to import by its link.
    const onlineScore = db
      .prepare("SELECT online_score_id FROM scores WHERE client = 'lazer' AND CAST(online_score_id AS INTEGER) > 0 AND origin IS NULL ORDER BY played_at DESC LIMIT 1")
      .get()?.online_score_id;
    // An installed osu! beatmap with its object count, to enter a score on by hand.
    const installed = db
      .prepare(`SELECT b.md5, b.beatmap_id, b.osu_path FROM beatmaps b JOIN osu_files f ON f.md5 = b.md5
                 WHERE b.beatmap_id IS NOT NULL AND b.osu_path IS NOT NULL ORDER BY b.md5 LIMIT 50`)
      .all()
      .map((b) => {
        try {
          const text = fs.readFileSync(b.osu_path, 'utf8');
          // An osu! beatmap: its Mode is 0, or not written at all.
          if (/^Mode:/m.test(text) && !/^Mode:\s*0\s*$/m.test(text)) return null;
          // The objects of its [HitObjects] section, as the app counts them (osuSection).
          const section = text.split(/^\[HitObjects\]\s*$/m)[1] ?? '';
          const objects = section.split(/^\[/m)[0].split(/\r?\n/).filter((l) => l.trim() !== '').length;
          return objects > 0 ? { ...b, objects } : null;
        } catch {
          return null;
        }
      })
      .find((b) => b !== null);
    const searchWord = installed ? (db.prepare('SELECT name FROM osu_files WHERE md5 = ?').get(installed.md5)?.name ?? '').split(/[^A-Za-z0-9]+/).find((w) => w.length > 3) : undefined;
    const otherPlayer = db.prepare("SELECT id FROM declined_plays WHERE profile_id = ? AND reason = 'another-player' ORDER BY declined_at DESC LIMIT 1").get(active)?.id;
    const arriving = { events: 'rank events still arriving', 'totals.events': 'the same' };
    const checked = { checkedAt: 'the moment each app asked GitHub' };
    // Once both apps have asked, /api/state carries that moment in every answer after.
    const stateChecked = { 'app.update.checkedAt': 'the moment each app asked GitHub' };

    return [
      { path: '/api/welcome' },
      { path: '/api/settings', body: { tagline: 'parity check', country: 'NZ' }, after: ['/api/settings'] },
      ...['null', '[1]', '{', '5'].map((raw) => ({ path: '/api/settings', raw })),
      { path: '/api/app-config', body: { font: 'system', originalMetadata: true }, after: ['/api/app-config'] },
      { path: '/api/app-config', body: { openBrowser: 'no' } },
      { path: '/api/app-config', body: { language: 'xx' } },
      { path: '/api/app-config', body: { language: {} } },
      { path: '/api/app-config', body: {} },
      { path: '/api/app-config', body: { sharedFavorites: false }, after: [`${profile(0)}&favorites=10000`] },
      { path: '/api/app-config', body: { sharedFavorites: true }, after: [`${profile(0)}&favorites=10000`] },
      ...(first && second && third
        ? [
            { path: '/api/scores', body: { action: 'pin', id: first.id } },
            { path: '/api/scores', body: { action: 'pin', id: second.id } },
            { path: '/api/scores', body: { action: 'reorder', ids: [second.id, first.id] }, after: [profile(first.mode)] },
            { path: '/api/scores', body: { action: 'hide', id: first.id }, after: [profile(first.mode), '/api/state'] },
            { path: '/api/scores', body: { action: 'list-hidden' }, ignore: { 'hidden.*.hiddenAt': 'the moment each app removed it' } },
            { path: '/api/scores', body: { action: 'restore', id: first.id }, after: [profile(first.mode)] },
            { path: '/api/scores', body: { action: 'unpin', id: second.id } },
            { path: '/api/scores', body: { action: 'hide', id: third.id } },
            { path: '/api/scores', body: { action: 'delete', ids: [third.id] }, after: [profile(third.mode)] },
            { path: '/api/scores', body: { action: 'delete', ids: [first.id] } },
            { path: '/api/scores', body: { action: 'destroy', id: first.id } },
            { path: '/api/scores', body: { action: 'pin', id: 99_999_999 } },
            { path: '/api/scores', body: { action: 'pin' } },
          ]
        : []),
      ...(unfinished
        ? [
            { path: '/api/scores', body: { action: 'hide', kind: 'incomplete', ids: [unfinished.id] }, after: [profile(0)] },
            { path: '/api/scores', body: { action: 'restore', kind: 'incomplete', ids: [unfinished.id, 99_999_999] } },
          ]
        : []),
      ...(declined.length > 0 ? [{ path: '/api/declined', body: { action: 'track', id: declined[0].id }, after: [{ path: '/api/declined', ignore: turnedAway }, profile(0)] }] : []),
      ...(declined.length > 1 ? [{ path: '/api/declined', body: { action: 'delete', id: declined[1].id }, after: [{ path: '/api/declined', ignore: turnedAway }] }] : []),
      { path: '/api/declined', body: { action: 'track', id: 'x' } },
      { path: '/api/declined', body: { action: 'nonsense' } },
      { path: '/api/tracking', body: { enabled: false } },
      { path: '/api/tracking', raw: 'nonsense' },
      { path: '/api/identity', body: { action: 'suggestions' } },
      { path: '/api/identity', body: { action: 'clear-image', kind: 'banner' } },
      { path: '/api/identity', body: { action: 'nope' } },
      { path: '/api/recompute', body: { confirm: false } },
      { path: '/api/recompute', body: { confirm: true } },
      { path: '/api/installs', method: 'GET' },
      { path: '/api/installs', body: { add: '  ' } },
      { path: '/api/installs', body: { add: path.join(csData, 'no such folder') }, ignore: { error: 'each app names its own copy of data/' } },
      { path: '/api/installs', body: {} },
      // Settings -> pp calculator. Each refusal comes before anything is built or switched, so
      // neither app writes config.json, and the error stays in /api/state until the next try.
      { path: '/api/pp-source', method: 'GET' },
      { path: '/api/pp-source', body: {} },
      { path: '/api/pp-source', body: { source: 5 } },
      { path: '/api/pp-source', body: { source: path.join(csData, 'no such folder') }, after: [{ path: '/api/pp-source', method: 'GET' }] },
      { path: '/api/pp-source', body: { source: `  ${csData}  ` }, after: [{ path: '/api/pp-source', method: 'GET' }, { path: '/api/state' }] },
      { path: '/api/startup', method: 'GET' },
      { path: '/api/backfill/preview', body: { since: 0, sources: ['replays', 'unfinished', 'attempts'] } },
      { path: '/api/backfill/preview', body: { since: monthAgo, until: monthAgo } },
      { path: '/api/backfill/preview', body: { since: -1 } },
      { path: '/api/backfill/preview', raw: 'null' },
      { path: '/api/backfill', body: { since: monthAgo } },

      // A profile of its own, for what empties one.
      { path: '/api/profiles', body: { action: 'create', name: '  Parity check  ' }, ignore: created, after: [{ path: '/api/state', ignore: created }] },
      { path: '/api/profiles', body: { action: 'create', name: 'Parity check' } },
      { path: '/api/profiles', body: { action: 'switch', id: 'x' } },
      { path: '/api/profiles', body: { action: 'switch', id: 1.5 } },
      { path: '/api/profiles', body: { action: 'rename', id: nextProfile, name: '' } },
      { path: '/api/backfill', body: { since: monthAgo, confirm: true, sources: ['replays', 'unfinished', 'attempts'] }, after: [profile(0), { path: '/api/declined', ignore: turnedAway }] },

      // Asked of osu! itself: one app at a time, so osu! is never asked twice as fast as one app asks.
      { path: '/api/identity', body: { action: 'lookup', query: '%E0%A4%A' } },
      { path: '/api/identity', body: { action: 'lookup', query: 'x'.repeat(40) } },
      ...(linked
        ? [
            { path: '/api/identity', body: { action: 'lookup', query: linked }, sequential: true },
            {
              path: '/api/identity',
              body: { action: 'import', query: linked, favorites: true, medals: true, bestPerformances: true, pinnedScores: true },
              sequential: true,
              // Recent's rank events arrive when osu! answers each app's watcher; the table is compared at the end.
              after: [{ path: profile(0), ignore: arriving }, { path: profile(3), ignore: arriving }, { path: `${profile(0)}&favorites=10000`, ignore: arriving }, '/api/settings'],
            },
            { path: '/api/favorites', body: { action: 'remove', beatmapsetId: 1 } },
            { path: '/api/favorites', body: { action: 'add', beatmapsetId: 1.5 } },
          ]
        : []),
      ...(onlineScore
        ? [
            { path: '/api/score-link/check', body: { link: `https://osu.ppy.sh/scores/${onlineScore}` }, sequential: true },
            { path: '/api/score-link', body: { link: `https://osu.ppy.sh/scores/${onlineScore}` }, sequential: true, after: [profile(0)] },
          ]
        : []),
      { path: '/api/score-link/check', body: { link: 'https://example.com/scores/1' } },
      ...(installed
        ? [
            { path: `/api/beatmaps/search?q=${encodeURIComponent(searchWord ?? 'a')}`, method: 'GET' },
            { path: '/api/beatmaps/find', body: { md5: installed.md5 } },
            { path: '/api/beatmaps/find', body: { link: String(installed.beatmap_id) } },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 9 } },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 0, counts: { c300: installed.objects + 1 }, maxCombo: 1, mods: 'HD', playedAt: monthAgo } },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 0, counts: { c300: installed.objects }, maxCombo: 1, mods: 'EZHR', playedAt: monthAgo } },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 0, counts: { c300: installed.objects }, maxCombo: 99999, mods: 'HD', playedAt: monthAgo } },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 0, counts: { c300: installed.objects }, maxCombo: 1, mods: 'HD', playedAt: monthAgo }, after: [profile(0)] },
            { path: '/api/manual-score', body: { md5: installed.md5, mode: 0, counts: { c300: installed.objects }, maxCombo: 1, mods: 'HD', playedAt: monthAgo } },
          ]
        : []),
      { path: '/api/beatmaps/find', body: { link: 'nonsense' } },
      { path: '/api/manual-score', body: {} },

      // Pictures of the page and of a score card, by the browser installed here: one app at a
      // time, since both drive it on one debugging port.
      { path: '/api/screenshot', method: 'GET', png: true, sequential: true },
      ...(second ? [{ path: `/api/scores/${second.id}/screenshot`, method: 'GET', png: true, sequential: true }] : []),

      // The update check, asked of GitHub once by each app in turn, and what this copy refuses.
      { path: '/api/update', method: 'GET' },
      { path: '/api/update', sequential: true, ignore: checked, after: [{ path: '/api/state', ignore: { ...created, ...stateChecked } }, { path: '/api/app', ignore: { pid: 'each app is its own process' } }] },
      { path: '/api/update/later', body: {}, headers: { origin: 'https://example.com' } },
      { path: '/api/update/later', body: {} },
      { path: '/api/update/apply', body: {} },
      { path: '/api/update/seen', body: {} },
      { path: '/api/update/dismiss', body: {}, after: [{ path: '/api/update', method: 'GET', ignore: checked }] },

      // Back up everything, and restoring it: staged and confirmed, never applied under the app.
      { path: '/api/backup', method: 'GET', zip: true },
      { path: '/api/restore', method: 'PUT', raw: 'not a backup at all' },
      { path: '/api/restore', method: 'PUT', raw: 'not a backup at all', headers: { origin: 'https://example.com' } },
      { path: '/api/restore/apply', body: {} },
      { path: '/api/restore', method: 'PUT', raw: 'backup', backup: true },
      { path: '/api/restore', method: 'DELETE' },
      { path: '/api/restore/apply', body: {} },
      { path: '/api/restore', method: 'PUT', raw: 'backup', backup: true },
      { path: '/api/restore/apply', body: {} },
      ...(upload
        ? [
            { path: '/api/replays?applyFilter=0', raw: fs.readFileSync(upload), after: [profile(0)] },
            { path: '/api/replays', raw: fs.readFileSync(upload) },
          ]
        : []),
      { path: '/api/replays', raw: 'definitely not a replay' },
      { path: '/api/image/avatar', method: 'PUT', raw: picture, after: [`/api/image/avatar?profile=${nextProfile}`] },
      { path: '/api/image/cover', method: 'PUT', raw: 'not a picture at all' },
      { path: '/api/about-image', method: 'PUT', raw: picture },
      { path: '/api/identity', body: { action: 'clear-image', kind: 'avatar' } },
      { path: '/api/profile/reset', body: { confirm: 'yes' } },
      { path: '/api/profile/reset', body: { confirm: true }, ignore: { trackingSince: 'the moment each app reset it' }, after: [profile(0)] },
      { path: '/api/profiles', body: { action: 'rename', id: nextProfile, name: 'Parity renamed' }, ignore: created },
      { path: '/api/profiles', body: { action: 'switch', id: active }, ignore: created },
      { path: '/api/profiles', body: { action: 'delete', id: nextProfile } },
      { path: '/api/profiles', body: { action: 'delete', id: nextProfile, confirm: true }, after: [{ path: '/api/state', ignore: { ...created, ...stateChecked } }] },
      ...(otherPlayer ? [{ path: '/api/declined', body: { action: 'its-me', id: otherPlayer }, sequential: true }] : []),
      { path: '/api/declined', body: { action: 'its-me', id: 99_999_999 } },
      { path: '/api/recompute', body: { confirm: true, all: true }, sequential: true, after: [profile(0)] },
      { path: '/api/tracking', body: { enabled: true } },
    ];
  } finally {
    db.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(source, 'profiles.db'))) throw new Error(`no profiles.db in ${source}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olp-parity-'));
  const children = [];
  try {
    const [nodePort, csPort] = [await freePort(), await freePort()];

    console.log('  building the C# app');
    const bin = path.join(work, 'cs-bin');
    const build = spawnSync('dotnet', ['build', path.join(repo, 'dotnet', 'App', 'App.csproj'), '-c', 'Release', '-o', bin, '--nologo', '-v', 'q'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('the C# build failed');

    // The Node app finds data/ beside its own src/, so it gets a folder of its own.
    const nodeRoot = path.join(work, 'node');
    fs.mkdirSync(nodeRoot);
    fs.cpSync(path.join(repo, 'src'), path.join(nodeRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(nodeRoot, 'package.json'));
    for (const shared of ['web', 'node_modules', 'tools']) link(path.join(repo, shared), path.join(nodeRoot, shared));
    copyData(path.join(nodeRoot, 'data'), nodePort);

    const csRoot = path.join(work, 'cs');
    fs.mkdirSync(csRoot);
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(csRoot, 'package.json'));
    link(path.join(repo, 'web'), path.join(csRoot, 'web'));
    copyData(path.join(csRoot, 'data'), csPort);

    const log = (name) => fs.openSync(path.join(work, `${name}.log`), 'w');
    const nodeApp = spawn(process.execPath, ['src/main.ts'], { cwd: nodeRoot, stdio: ['pipe', log('node'), log('node-err')] });
    // Writable, as the Node app is: both track, each on its own copy.
    const csApp = spawn(path.join(bin, `osu-local-profiles-app${exe}`), ['--root', csRoot], { stdio: ['pipe', log('cs'), log('cs-err')] });
    children.push(nodeApp, csApp);

    console.log(`  starting both apps (logs in ${work})`);
    await Promise.all([waitFor(nodePort, nodeApp, 'the Node app'), waitFor(csPort, csApp, 'the C# app')]);
    await Promise.all([settled(nodePort), settled(csPort)]);

    let failed = 0;
    const report = (pathname, problems, answer) => {
      if (problems.length === 0) {
        // Status and size, so two apps failing alike cannot pass for agreement.
        console.log(`  same     ${pathname}  (${answer.status}, ${(answer.body.length / 1024).toFixed(1)} KB)`);
        return;
      }
      failed++;
      console.log(`  DIFFERS  ${pathname}`);
      for (const p of problems) console.log(`             ${p}`);
    };
    const compareMeta = (a, b) => [
      ...(a.status === b.status ? [] : [`status: node ${a.status} | cs ${b.status}`]),
      ...HEADERS.filter((h) => a.headers[h] !== b.headers[h]).map((h) => `${h}: node ${a.headers[h]} | cs ${b.headers[h]}`),
    ];

    const compareJson = async (endpoints, label = '') => {
      for (const { path: pathname, ignore = {} } of endpoints) {
        const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
        const problems = compareMeta(a, b);
        try {
          problems.push(...differences(JSON.parse(a.body.toString('utf8')), JSON.parse(b.body.toString('utf8')), '', ignore));
        } catch (e) {
          problems.push(`not JSON: ${e.message}`);
        }
        report(`${label}${pathname}`, problems, a);
      }
    };
    await compareJson(ENDPOINTS);

    // Every score's page, removed ones and one that never existed included, and a sample of
    // replay downloads byte for byte: with a file, and each kind of refusal.
    const scores = (() => {
      const db = new DatabaseSync(path.join(csRoot, 'data', 'profiles.db'), { readOnly: true });
      try {
        return db.prepare('SELECT id, replay_path IS NOT NULL AND origin IS NULL AND client <> \'mcosu\' AS replay FROM scores ORDER BY id').all();
      } finally {
        db.close();
      }
    })();
    const missingId = (scores.at(-1)?.id ?? 0) + 1000;
    await compareJson(
      [...scores.map((s) => s.id), missingId].map((id) => ({ path: `/api/scores/${id}` })),
    );
    const replays = [
      ...scores.filter((s) => s.replay === 1).slice(0, 8),
      ...scores.filter((s) => s.replay !== 1).slice(0, 3),
      { id: missingId },
    ];
    for (const pathname of [
      ...replays.flatMap((s) => [`/api/scores/${s.id}/replay`]),
      '/api/image/avatar', '/api/image/cover', '/api/image/avatar?profile=1', '/api/image/cover?profile=3',
      '/api/image/avatar?profile=99', '/api/image/avatar?profile=abc',
    ]) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }

    // The exports. The JSON's own timestamp is the moment each app answered; a workbook is a zip
    // whose compressed bytes differ between Node's zlib and .NET's, so the files inside it are compared.
    await compareJson([{ path: '/api/export', ignore: { exportedAt: 'the moment each app answered' } }]);
    for (const pathname of ['/api/export/scores.csv', '/api/export/scores.csv?lang=de', '/api/export/scores.csv?lang=xx']) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }
    for (const pathname of ['/api/export/profile.xlsx', '/api/export/profile.xlsx?lang=ja']) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      const unpacked = [a, b].map((answer, i) => {
        const file = path.join(work, `workbook-${i}.xlsx`);
        const dir = path.join(work, `workbook-${i}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(file, answer.body);
        try {
          extractZip(file, dir);
        } catch (e) {
          problems.push(`${i === 0 ? 'node' : 'cs'}: not a zip (${e.message})`);
          return new Map();
        }
        const files = new Map();
        const walk = (at, prefix) => {
          for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(at, entry.name), `${prefix}${entry.name}/`);
            else files.set(`${prefix}${entry.name}`, fs.readFileSync(path.join(at, entry.name)));
          }
        };
        walk(dir, '');
        return files;
      });
      for (const name of new Set([...unpacked[0].keys(), ...unpacked[1].keys()])) {
        const [x, y] = [unpacked[0].get(name), unpacked[1].get(name)];
        if (!x || !y || !x.equals(y)) problems.push(`${name}: node ${x?.length ?? 'missing'} bytes | cs ${y?.length ?? 'missing'} bytes, different`);
      }
      report(pathname, problems, a);
    }

    /*
     * The other profiles: the answers above are the active one's. Each app reads the active
     * profile from its database on every request, so switching it in both copies is enough.
     */
    const copies = [path.join(nodeRoot, 'data', 'profiles.db'), path.join(csRoot, 'data', 'profiles.db')];
    const profileIds = (() => {
      const db = new DatabaseSync(copies[0], { readOnly: true });
      try {
        const active = db.prepare("SELECT value FROM kv WHERE key = 'activeProfileId'").get()?.value;
        return db.prepare('SELECT id FROM profiles ORDER BY id').all().map((r) => r.id).filter((id) => String(id) !== active);
      } finally {
        db.close();
      }
    })();
    for (const id of profileIds) {
      for (const file of copies) {
        const db = new DatabaseSync(file);
        db.prepare("INSERT INTO kv (key, value) VALUES ('activeProfileId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(id));
        db.close();
      }
      await compareJson(ENDPOINTS.filter((e) => PER_PROFILE.some((prefix) => e.path.startsWith(prefix))), `[profile ${id}] `);
    }
    for (const pathname of STATIC) {
      const [a, b] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
      const problems = compareMeta(a, b);
      if (!a.body.equals(b.body)) problems.push(`body: node ${a.body.length} bytes | cs ${b.body.length} bytes, different`);
      report(pathname, problems, a);
    }

    /*
     * The writes: the same requests in order to both, each answer compared and then what it
     * should have changed, the live feed's events, and at the end every table of both copies.
     */
    console.log('\n  writes');
    // Back on the profile each app is tracking, which the loop above moved away from.
    const original = (() => {
      const db = new DatabaseSync(path.join(source, 'profiles.db'), { readOnly: true });
      try {
        return db.prepare("SELECT value FROM kv WHERE key = 'activeProfileId'").get()?.value ?? '1';
      } finally {
        db.close();
      }
    })();
    for (const file of copies) {
      const db = new DatabaseSync(file);
      db.prepare("INSERT INTO kv (key, value) VALUES ('activeProfileId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(original);
      db.close();
    }
    const realReplays = path.join(source, 'replays');
    const replaysBefore = listing(realReplays);
    const feeds = [listen(nodePort), listen(csPort)];
    /** The last backup the Node app made, which the restore steps send to both. */
    let lastBackup = null;
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const step of writeSteps(copies[0], path.join(csRoot, 'data'))) {
      const method = step.method ?? 'POST';
      const body = step.backup ? lastBackup : step.raw ?? (step.body === undefined ? undefined : JSON.stringify(step.body));
      const init = method === 'GET' ? undefined : { method, body, headers: step.headers };
      const label = `${method} ${step.path} ${step.raw !== undefined ? (Buffer.isBuffer(step.raw) ? `(${step.raw.length} bytes)` : step.raw) : (body ?? '')}`.slice(0, 110);
      const [a, b] = step.sequential
        ? [await ask(nodePort, step.path, init), await ask(csPort, step.path, init)]
        : await Promise.all([ask(nodePort, step.path, init), ask(csPort, step.path, init)]);
      const problems = compareMeta(a, b);
      if (step.png) {
        // Rendered twice, a moment apart, so the pixels may differ ("3 minutes ago"); the
        // picture's kind and size may not.
        const size = (png) => (png.length > 24 && png.subarray(1, 4).toString('latin1') === 'PNG' ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : 'not a PNG');
        if (a.status === 200 && size(a.body) !== size(b.body)) problems.push(`picture: node ${size(a.body)} | cs ${size(b.body)}`);
        report(`${label} (${a.status === 200 ? size(a.body) : 'none'})`, problems, a);
        continue;
      }
      if (step.zip) {
        // A zip's compressed bytes differ between Node's zlib and .NET's: its files are compared,
        // the database in it table by table, as the copies' own are.
        lastBackup = a.body;
        const unpack = (answer) => {
          const entries = readZipEntries(answer.body);
          return new Map(entries.map((e) => [e.name, entryData(answer.body, e)]));
        };
        const [x, y] = [unpack(a), unpack(b)];
        for (const name of new Set([...x.keys(), ...y.keys()])) {
          if (name === 'profiles.db' && x.has(name) && y.has(name)) {
            const files = [x, y].map((files, i) => {
              const file = path.join(work, `backup-${i}.db`);
              fs.writeFileSync(file, files.get(name));
              return file;
            });
            const [nodeRows, csRows] = [tables(files[0], path.join(nodeRoot, 'data')), tables(files[1], path.join(csRoot, 'data'))];
            for (const [table, rows] of nodeRows) {
              const other = csRows.get(table) ?? [];
              if (rows.length !== other.length || rows.some((r, i) => r !== other[i])) problems.push(`profiles.db table ${table} differs`);
            }
          } else if (!x.get(name)?.equals(y.get(name) ?? Buffer.alloc(0))) {
            problems.push(`${name}: node ${x.get(name)?.length ?? 'missing'} bytes | cs ${y.get(name)?.length ?? 'missing'} bytes`);
          }
        }
        report(`${label} (${x.size} files)`, problems, a);
        continue;
      }
      try {
        problems.push(...differences(JSON.parse(a.body.toString('utf8')), JSON.parse(b.body.toString('utf8')), '', step.ignore ?? {}));
      } catch (e) {
        problems.push(`not JSON: ${e.message}`);
      }
      report(label, problems, a);
      for (const after of step.after ?? []) {
        const { path: pathname, ignore: own = {} } = typeof after === 'string' ? { path: after } : after;
        const ignore = { ...AFTER_IGNORED, ...own };
        const [x, y] = await Promise.all([ask(nodePort, pathname), ask(csPort, pathname)]);
        const changed = compareMeta(x, y);
        if (pathname.startsWith('/api/image/')) {
          if (!x.body.equals(y.body)) changed.push(`body: node ${x.body.length} bytes | cs ${y.body.length} bytes, different`);
        } else {
          changed.push(...differences(JSON.parse(x.body.toString('utf8')), JSON.parse(y.body.toString('utf8')), '', ignore));
        }
        report(`  then ${pathname}`, changed, x);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await Promise.all(feeds.map((f) => f.stop()));

    // What each live feed said: every event in order, and the last of each kind of progress.
    const told = feeds.map(({ events }) => {
      const last = new Map();
      for (const e of events) if (PROGRESS_EVENTS.has(e.name)) last.set(e.name, e);
      const kept = events.filter((e) => !(e.name === 'scores' && Object.hasOwn(EVENTS_SKIPPED, e.data?.action)));
      return [...kept.filter((e) => !PROGRESS_EVENTS.has(e.name)), ...[...last.values()].sort((x, y) => x.name.localeCompare(y.name))];
    });
    const feedProblems = [];
    if (told[0].length !== told[1].length) {
      feedProblems.push(`count: node ${told[0].length} (${told[0].map((e) => e.name).join(', ')}) | cs ${told[1].length} (${told[1].map((e) => e.name).join(', ')})`);
    }
    for (let i = 0; i < Math.min(told[0].length, told[1].length); i++) {
      const [x, y] = [told[0][i], told[1][i]];
      if (x.name !== y.name) feedProblems.push(`${i}: node ${x.name} | cs ${y.name}`);
      else feedProblems.push(...differences(x.data, y.data, '', { at: 'the moment each app said it', trackingSince: 'the same', checkedAt: 'the same' }).map((d) => `${i} ${x.name}: ${d}`));
    }
    report('/api/events (the writes above)', feedProblems, { status: 200, body: Buffer.from(JSON.stringify(told[0])) });

    // Every table of both copies, with the moments each app wrote taken out.
    const [nodeTables, csTables] = copies.map(tables);
    for (const [name, rows] of nodeTables) {
      const other = csTables.get(name) ?? [];
      const extra = rows.filter((r) => !other.includes(r));
      const missing = other.filter((r) => !rows.includes(r));
      const problems = [
        ...(rows.length === other.length ? [] : [`rows: node ${rows.length} | cs ${other.length}`]),
        ...extra.slice(0, 3).map((r) => `only node: ${r.slice(0, 300)}`),
        ...missing.slice(0, 3).map((r) => `only cs:   ${r.slice(0, 300)}`),
      ];
      report(`table ${name}`, problems, { status: 200, body: Buffer.from(rows.join('\n')) });
    }
    for (const [name, why] of Object.entries(TABLES_SKIPPED)) console.log(`  skipped  table ${name}: ${why}`);
    for (const [name, why] of Object.entries(EVENTS_SKIPPED)) console.log(`  skipped  event scores/${name}: ${why}`);
    // config.json, but for the port each copy was given.
    const configs = [nodeRoot, csRoot].map((root) => {
      const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8'));
      delete config.port;
      return config;
    });
    report('data/config.json', differences(configs[0], configs[1]), { status: 200, body: Buffer.from(JSON.stringify(configs[0])) });
    // The copies' pictures, me! images and uploaded replays, file for file.
    const kept = (root) => {
      const files = [];
      const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (prefix === '' && !['replays', 'about-images'].includes(entry.name)) continue;
            walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
          } else if (/\.(png|jpg|jpeg|webp|gif|osr)$/.test(entry.name)) {
            files.push([`${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name)).toString('base64')]);
          }
        }
      };
      walk(path.join(root, 'data'), '');
      return Object.fromEntries(files.sort(([x], [y]) => (x < y ? -1 : 1)));
    };
    const [nodeFiles, csFiles] = [kept(nodeRoot), kept(csRoot)];
    report('data/ pictures and replays', differences(nodeFiles, csFiles).map((d) => d.slice(0, 200)), { status: 200, body: Buffer.from(Object.keys(nodeFiles).join()) });

    // The safety check: nothing in the real data/replays was let go of by either copy.
    const gone = replaysBefore.filter((name) => !listing(realReplays).includes(name));
    if (gone.length > 0) {
      failed++;
      console.log(`  LOST     ${gone.length} file(s) from ${realReplays}: ${gone.join(', ')}`);
    }

    console.log(failed === 0 ? '\n  Every answer matches.' : `\n  ${failed} answer(s) differ.`);
    process.exitCode = failed === 0 ? 0 : 1;

    // A quit each app treats as deliberate; no Origin, as the tray launcher sends it.
    for (const port of [nodePort, csPort]) await fetch(`http://localhost:${port}/api/quit`, { method: 'POST' }).catch(() => {});
  } finally {
    for (const child of children) {
      if (child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child.exitCode === null) child.kill();
    }
    if (keep) console.log(`  kept ${work}`);
    else cleanUp(work);
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message}`);
  process.exitCode = 2;
});
