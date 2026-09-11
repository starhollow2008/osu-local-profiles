import type { Db } from './db/index.ts';
import type { BeatmapResolver } from './clients/beatmaps.ts';
import { beatmapMode } from './clients/beatmaps.ts';
import type { BeatmapsetDetails, OsuWebMode } from './clients/osu-web.ts';
import type { LazerMod } from './osr.ts';
import { visibleSql } from './calc/eligibility.ts';

/**
 * Favorite Beatmaps: the profile's own list of beatmapsets, shown as osu-web's cards.
 *
 * One list shared by every profile by default (`config.sharedFavorites`), or one per profile
 * as osu! keeps them per account; see `FavoriteScope`. This app's own -- nothing is ever
 * written to osu!. A card is drawn from the details osu.ppy.sh gave when the set was
 * favourited (`beatmapset_details`); if that request could not be made, from what this
 * machine knows instead: lazer's `online.db` lists every difficulty and its mapper, the
 * beatmap cache has the names, and the profile's own scores carry osu!'s star ratings.
 */

const MODE_BY_RULESET: readonly OsuWebMode[] = ['osu', 'taiko', 'fruits', 'mania'];

/** osu!'s `approved` enum, as the status names osu-web prints on a card. */
const STATUS_NAME: Readonly<Record<number, string>> = {
  [-2]: 'graveyard',
  [-1]: 'wip',
  0: 'pending',
  1: 'ranked',
  2: 'approved',
  3: 'qualified',
  4: 'loved',
};

export interface FavoriteDifficulty {
  id: number | null;
  mode: OsuWebMode | null;
  /** osu!'s star rating for the difficulty itself, or null when it is not known here. */
  stars: number | null;
  version: string;
}

export interface FavoriteCard {
  id: number;
  title: string;
  artist: string;
  creator: string | null;
  userId: number | null;
  status: string | null;
  nsfw: boolean;
  spotlight: boolean;
  featuredArtist: boolean;
  /** Whether the set has a video / a storyboard; null when osu! has not been asked. */
  video: boolean | null;
  storyboard: boolean | null;
  favouriteCount: number | null;
  playCount: number | null;
  date: string | null;
  difficulties: FavoriteDifficulty[];
  /** Where the details came from: osu.ppy.sh, or only what is on this machine. */
  source: 'osu' | 'local';
  favoritedAt: number;
}

/* --------------------------------------------------------------- the list */

/**
 * Whose favourites: one profile's (a bare id), or the list every profile shares.
 *
 * Shared is the default, at the user's request: favourites are a player's taste, which does
 * not change with the hand they play with. The profile id still matters when shared -- a
 * card built from local data takes star ratings from that profile's own scores.
 */
export type FavoriteScope = number | { profileId: number; shared: boolean };

interface ResolvedScope {
  table: 'favorite_beatmapsets' | 'shared_favorite_beatmapsets';
  where: string;
  params: number[];
  profileId: number;
}

function resolveScope(scope: FavoriteScope): ResolvedScope {
  if (typeof scope === 'number' || !scope.shared) {
    const profileId = typeof scope === 'number' ? scope : scope.profileId;
    return { table: 'favorite_beatmapsets', where: 'profile_id = ?', params: [profileId], profileId };
  }
  return { table: 'shared_favorite_beatmapsets', where: '1 = 1', params: [], profileId: scope.profileId };
}

/** Add a set; true if it was not already a favourite. */
export function addFavorite(db: Db, scope: FavoriteScope, beatmapsetId: number, now = Date.now()): boolean {
  const s = resolveScope(scope);
  const result =
    s.table === 'shared_favorite_beatmapsets'
      ? db
          .prepare('INSERT OR IGNORE INTO shared_favorite_beatmapsets (beatmapset_id, favorited_at) VALUES (?, ?)')
          .run(beatmapsetId, now)
      : db
          .prepare(
            `INSERT OR IGNORE INTO favorite_beatmapsets (profile_id, beatmapset_id, favorited_at)
             VALUES (?, ?, ?)`,
          )
          .run(s.profileId, beatmapsetId, now);
  return result.changes > 0;
}

/**
 * Remove a set; true if it was a favourite.
 *
 * Removing from the shared list removes it from every profile's own list as well, so that
 * switching sharing off later cannot bring back a favourite the user already took away.
 */
export function removeFavorite(db: Db, scope: FavoriteScope, beatmapsetId: number): boolean {
  const s = resolveScope(scope);
  if (s.table === 'shared_favorite_beatmapsets') {
    const result = db.prepare('DELETE FROM shared_favorite_beatmapsets WHERE beatmapset_id = ?').run(beatmapsetId);
    db.prepare('DELETE FROM favorite_beatmapsets WHERE beatmapset_id = ?').run(beatmapsetId);
    return result.changes > 0;
  }
  const result = db
    .prepare('DELETE FROM favorite_beatmapsets WHERE profile_id = ? AND beatmapset_id = ?')
    .run(s.profileId, beatmapsetId);
  return result.changes > 0;
}

/** Every favourited set id, so the page can label each row's menu Favorite or Unfavorite. */
export function favoriteIds(db: Db, scope: FavoriteScope): number[] {
  const s = resolveScope(scope);
  return (
    db.prepare(`SELECT beatmapset_id FROM ${s.table} WHERE ${s.where}`).all(...s.params) as {
      beatmapset_id: number;
    }[]
  ).map((r) => r.beatmapset_id);
}

export function favoriteCount(db: Db, scope: FavoriteScope): number {
  const s = resolveScope(scope);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${s.table} WHERE ${s.where}`).get(...s.params) as { n: number }).n;
}

/**
 * Add an osu! account's favourites, keeping osu!'s order (newest first) and caching each
 * set's details, which the favourites list already carries. Returns how many were new.
 */
export function importFavorites(db: Db, scope: FavoriteScope, sets: BeatmapsetDetails[], now = Date.now()): number {
  let added = 0;
  db.exec('BEGIN');
  try {
    sets.forEach((set, index) => {
      saveDetails(db, set, now);
      // A millisecond apart, so the first in osu!'s list stays the newest here too.
      if (addFavorite(db, scope, set.id, now - index)) added++;
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/**
 * Bring the two lists together when sharing is switched, so nothing is lost either way.
 *
 * On: every profile's own favourites join the shared list. Off: the shared list is copied
 * into every profile's own. What was last applied is kept in `kv`, so this runs once per
 * switch -- including a switch made by hand in config.json while the app was closed -- and
 * an install from before sharing existed (per profile, in effect) merges on its first start.
 */
export function syncFavoriteSharing(db: Db, shared: boolean): 'merged' | 'copied' | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'favoritesShared'").get() as { value: string } | undefined;
  const was = row?.value === '1';
  const record = () =>
    db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('favoritesShared', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(shared ? '1' : '0');
  if (was === shared) {
    if (!row) record();
    return null;
  }

  db.exec('BEGIN');
  try {
    if (shared) {
      db.exec(
        `INSERT OR IGNORE INTO shared_favorite_beatmapsets (beatmapset_id, favorited_at)
         SELECT beatmapset_id, MAX(favorited_at) FROM favorite_beatmapsets GROUP BY beatmapset_id`,
      );
    } else {
      db.exec(
        `INSERT OR IGNORE INTO favorite_beatmapsets (profile_id, beatmapset_id, favorited_at)
         SELECT p.id, s.beatmapset_id, s.favorited_at FROM profiles p CROSS JOIN shared_favorite_beatmapsets s`,
      );
    }
    record();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return shared ? 'merged' : 'copied';
}

/* ---------------------------------------------------------- the details */

export function saveDetails(db: Db, details: BeatmapsetDetails, now = Date.now()): void {
  db.prepare(
    `INSERT INTO beatmapset_details (beatmapset_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(beatmapset_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(details.id, JSON.stringify(details), now);
}

export function detailsFor(db: Db, beatmapsetId: number): BeatmapsetDetails | null {
  const row = db.prepare('SELECT data FROM beatmapset_details WHERE beatmapset_id = ?').get(beatmapsetId) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as BeatmapsetDetails;
  } catch {
    return null;
  }
}

/**
 * Favourites osu.ppy.sh has not described yet, most recent first -- the ones worth a retry.
 *
 * Includes details cached before the card kept the video and storyboard flags: they are
 * stale rather than missing, and are refreshed the same way, a few per favourite action.
 */
export function missingDetails(db: Db, scope: FavoriteScope, limit: number): number[] {
  const s = resolveScope(scope);
  return (
    db
      .prepare(
        `SELECT f.beatmapset_id FROM ${s.table} f
           LEFT JOIN beatmapset_details d ON d.beatmapset_id = f.beatmapset_id
          WHERE ${s.where}
            AND (d.beatmapset_id IS NULL OR json_type(d.data, '$.video') IS NULL)
          ORDER BY f.favorited_at DESC LIMIT ?`,
      )
      .all(...s.params, limit) as { beatmapset_id: number }[]
  ).map((r) => r.beatmapset_id);
}

/* -------------------------------------------------------------- the cards */

/**
 * The profile's favourites as cards, most recently favourited first, `limit` at a time.
 */
export function listFavorites(
  db: Db,
  scope: FavoriteScope,
  limit: number,
  resolver: BeatmapResolver | null,
): FavoriteCard[] {
  const s = resolveScope(scope);
  const rows = db
    .prepare(
      `SELECT beatmapset_id, favorited_at FROM ${s.table}
        WHERE ${s.where} ORDER BY favorited_at DESC, beatmapset_id DESC LIMIT ?`,
    )
    .all(...s.params, limit) as { beatmapset_id: number; favorited_at: number }[];

  return rows.map((r) => {
    const details = detailsFor(db, r.beatmapset_id);
    return details
      ? fromDetails(details, r.favorited_at)
      : localCard(db, s.profileId, r.beatmapset_id, r.favorited_at, resolver);
  });
}

function fromDetails(d: BeatmapsetDetails, favoritedAt: number): FavoriteCard {
  return {
    id: d.id,
    title: d.title,
    artist: d.artist,
    creator: d.creator || null,
    userId: d.userId || null,
    status: d.status,
    nsfw: d.nsfw,
    spotlight: d.spotlight,
    featuredArtist: d.featuredArtist,
    // Details cached before these were kept have neither; unknown, not false.
    video: typeof d.video === 'boolean' ? d.video : null,
    storyboard: typeof d.storyboard === 'boolean' ? d.storyboard : null,
    favouriteCount: d.favouriteCount,
    playCount: d.playCount,
    date: d.date,
    difficulties: d.difficulties.map((x) => ({ id: x.id, mode: x.mode, stars: x.stars, version: x.version })),
    source: 'osu',
    favoritedAt,
  };
}

/**
 * Mods that leave a difficulty's star rating untouched. A score's stored rating is the one
 * osu! calculated *with its mods*, so a DT score's stars are not the difficulty's own; only
 * a score made with nothing but these can stand in for the difficulty.
 */
const RATING_NEUTRAL_MODS = new Set(['NF', 'SD', 'PF', 'HD', 'CL', 'MR', 'TD', 'SV2']);

export function ratingNeutral(modsJson: string): boolean {
  try {
    const mods = JSON.parse(modsJson) as LazerMod[];
    return mods.every((m) => RATING_NEUTRAL_MODS.has(m.acronym));
  } catch {
    return false;
  }
}

/**
 * A card from local knowledge alone, for a set osu.ppy.sh could not be asked about.
 *
 * Every difficulty `online.db` lists, named from its `.osu` filename; star ratings only where
 * this profile has a score that took none that change them; the mode from that score or the
 * `.osu` itself. What is not known stays null rather than being guessed.
 */
export function localCard(
  db: Db,
  profileId: number,
  beatmapsetId: number,
  favoritedAt: number,
  resolver: BeatmapResolver | null,
): FavoriteCard {
  const cached = db
    .prepare(
      `SELECT md5, beatmap_id, artist, title, version, creator, status, osu_path
         FROM beatmaps WHERE beatmapset_id = ?`,
    )
    .all(beatmapsetId) as {
    md5: string;
    beatmap_id: number | null;
    artist: string | null;
    title: string | null;
    version: string | null;
    creator: string | null;
    status: number | null;
    osu_path: string | null;
  }[];

  const online = resolver?.beatmapsInSet(beatmapsetId) ?? [];

  // Per difficulty (keyed by checksum): what this profile's own scores say about it.
  const md5s = [...new Set([...cached.map((c) => c.md5), ...online.flatMap((o) => (o.md5 ? [o.md5] : []))])];
  const played = new Map<string, { mode: number; stars: number | null }>();
  if (md5s.length > 0) {
    const scores = db
      .prepare(
        `SELECT s.beatmap_md5, s.mode, s.stars, s.mods_json FROM scores s
          WHERE s.profile_id = ? AND ${visibleSql()}
            AND s.beatmap_md5 IN (${md5s.map(() => '?').join(',')})`,
      )
      .all(profileId, ...md5s) as { beatmap_md5: string; mode: number; stars: number | null; mods_json: string }[];
    for (const s of scores) {
      const entry = played.get(s.beatmap_md5) ?? { mode: s.mode, stars: null };
      if (entry.stars === null && s.stars !== null && ratingNeutral(s.mods_json)) entry.stars = s.stars;
      played.set(s.beatmap_md5, entry);
    }
  }

  const difficulties = new Map<string, FavoriteDifficulty>();
  const modeOf = (md5: string | null, osuPath: string | null): OsuWebMode | null => {
    const fromScore = md5 ? played.get(md5)?.mode : undefined;
    if (fromScore !== undefined) return MODE_BY_RULESET[fromScore] ?? null;
    return osuPath ? (MODE_BY_RULESET[beatmapMode(osuPath)] ?? null) : null;
  };

  for (const o of online) {
    const key = o.md5 ?? `id:${o.beatmapId}`;
    const local = cached.find((c) => c.md5 === o.md5);
    difficulties.set(key, {
      id: o.beatmapId,
      mode: modeOf(o.md5, local?.osu_path ?? null),
      stars: o.md5 ? (played.get(o.md5)?.stars ?? null) : null,
      version: o.version ?? local?.version ?? '?',
    });
  }
  for (const c of cached) {
    if (difficulties.has(c.md5)) continue;
    difficulties.set(c.md5, {
      id: c.beatmap_id,
      mode: modeOf(c.md5, c.osu_path),
      stars: played.get(c.md5)?.stars ?? null,
      version: c.version ?? '?',
    });
  }

  // A difficulty whose mode is still unknown takes the set's: sets are almost always one mode.
  const known = [...difficulties.values()].find((d) => d.mode !== null)?.mode ?? 'osu';
  const list = [...difficulties.values()].map((d) => ({ ...d, mode: d.mode ?? known }));

  const first = cached.find((c) => c.title) ?? cached[0];
  const userId = online.find((o) => o.userId !== null)?.userId ?? null;
  const statusCode = first?.status ?? online.find((o) => o.status !== null)?.status ?? null;

  return {
    id: beatmapsetId,
    title: first?.title ?? `beatmapset ${beatmapsetId}`,
    artist: first?.artist ?? '',
    creator: first?.creator ?? (userId !== null ? resolver?.username(userId) ?? null : null),
    userId,
    status: statusCode === null ? null : (STATUS_NAME[statusCode] ?? null),
    nsfw: false,
    spotlight: false,
    featuredArtist: false,
    video: null,
    storyboard: null,
    favouriteCount: null,
    playCount: null,
    date: null,
    difficulties: list,
    source: 'local',
    favoritedAt,
  };
}
