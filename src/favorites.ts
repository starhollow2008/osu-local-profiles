import type { Db } from './db/index.ts';
import type { BeatmapResolver } from './clients/beatmaps.ts';
import { beatmapMode } from './clients/beatmaps.ts';
import type { BeatmapsetDetails, OsuWebMode } from './clients/osu-web.ts';
import type { LazerMod } from './osr.ts';
import { visibleSql } from './calc/eligibility.ts';

/**
 * Favorite Beatmaps: the profile's own list of beatmapsets, shown as osu-web's cards.
 *
 * Per profile, as osu! keeps favourites per account, and this app's own -- nothing is ever
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
  favouriteCount: number | null;
  playCount: number | null;
  date: string | null;
  difficulties: FavoriteDifficulty[];
  /** Where the details came from: osu.ppy.sh, or only what is on this machine. */
  source: 'osu' | 'local';
  favoritedAt: number;
}

/* --------------------------------------------------------------- the list */

/** Add a set; true if it was not already a favourite. */
export function addFavorite(db: Db, profileId: number, beatmapsetId: number, now = Date.now()): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO favorite_beatmapsets (profile_id, beatmapset_id, favorited_at)
       VALUES (?, ?, ?)`,
    )
    .run(profileId, beatmapsetId, now);
  return result.changes > 0;
}

/** Remove a set; true if it was a favourite. */
export function removeFavorite(db: Db, profileId: number, beatmapsetId: number): boolean {
  const result = db
    .prepare('DELETE FROM favorite_beatmapsets WHERE profile_id = ? AND beatmapset_id = ?')
    .run(profileId, beatmapsetId);
  return result.changes > 0;
}

/** Every favourited set id, so the page can label each row's menu Favorite or Unfavorite. */
export function favoriteIds(db: Db, profileId: number): number[] {
  return (
    db
      .prepare('SELECT beatmapset_id FROM favorite_beatmapsets WHERE profile_id = ?')
      .all(profileId) as { beatmapset_id: number }[]
  ).map((r) => r.beatmapset_id);
}

export function favoriteCount(db: Db, profileId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM favorite_beatmapsets WHERE profile_id = ?').get(profileId) as {
      n: number;
    }
  ).n;
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

/** Favourites osu.ppy.sh has not described yet, most recent first -- the ones worth a retry. */
export function missingDetails(db: Db, profileId: number, limit: number): number[] {
  return (
    db
      .prepare(
        `SELECT f.beatmapset_id FROM favorite_beatmapsets f
           LEFT JOIN beatmapset_details d ON d.beatmapset_id = f.beatmapset_id
          WHERE f.profile_id = ? AND d.beatmapset_id IS NULL
          ORDER BY f.favorited_at DESC LIMIT ?`,
      )
      .all(profileId, limit) as { beatmapset_id: number }[]
  ).map((r) => r.beatmapset_id);
}

/* -------------------------------------------------------------- the cards */

/**
 * The profile's favourites as cards, most recently favourited first, `limit` at a time.
 */
export function listFavorites(
  db: Db,
  profileId: number,
  limit: number,
  resolver: BeatmapResolver | null,
): FavoriteCard[] {
  const rows = db
    .prepare(
      `SELECT beatmapset_id, favorited_at FROM favorite_beatmapsets
        WHERE profile_id = ? ORDER BY favorited_at DESC, beatmapset_id DESC LIMIT ?`,
    )
    .all(profileId, limit) as { beatmapset_id: number; favorited_at: number }[];

  return rows.map((r) => {
    const details = detailsFor(db, r.beatmapset_id);
    return details
      ? fromDetails(details, r.favorited_at)
      : localCard(db, profileId, r.beatmapset_id, r.favorited_at, resolver);
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

function ratingNeutral(modsJson: string): boolean {
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
    favouriteCount: null,
    playCount: null,
    date: null,
    difficulties: list,
    source: 'local',
    favoritedAt,
  };
}
