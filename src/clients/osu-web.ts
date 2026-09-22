import { UNRESOLVED_STATUS } from './beatmaps.ts';
import type { LazerMod, Ruleset } from '../osr.ts';

/**
 * Looking up an osu! account, so a profile can borrow its name, avatar and banner.
 *
 * **Entirely optional, and never automatic.** Every function here runs only because the
 * user asked for it by pressing a button, makes exactly one request, and saves what it
 * finds to `data/` so it is never fetched twice. Nothing polls. With no network the app
 * behaves as it always has -- the identity is whatever was typed or uploaded.
 *
 * **No credentials, and no API.** The osu! API would need an OAuth application, a client id
 * and a secret from every user. It turns out not to be necessary: `osu.ppy.sh/users/<name>`
 * redirects to the numeric id and embeds the whole public user object in the page as
 * `data-initial-data`, which is the same data the API's `/users/{user}` returns. That keeps
 * this project's promise that it needs no login intact.
 *
 * Scraping a page is more fragile than an API, so every failure here is non-fatal and says
 * what went wrong: the user can always type a name and upload an image instead.
 */

/** How long to wait before giving up. A profile lookup should feel instant or not happen. */
const TIMEOUT_MS = 10_000;

/** Avatars and covers are small; anything larger is a sign of a wrong URL. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const USER_AGENT = 'osu-local-profiles (local profile tracker; one request per user action)';

export interface OsuWebUser {
  id: number;
  username: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  countryCode: string | null;
  /** The account's me! page as BBCode, exactly as its owner wrote it; null when it is empty. */
  pageRaw: string | null;
  /**
   * Every username this account has had before, as osu! publishes them.
   *
   * Read so that a replay set before a rename is still recognised as its owner's: an
   * osu!stable replay carries no user id, only the name that was current when it was set.
   * See `src/player-identity.ts`.
   */
  previousUsernames: string[];
}

/**
 * Reduce whatever the user pasted to the part osu! can look up.
 *
 * Accepts a numeric id, a username, or any profile URL -- `osu.ppy.sh/users/3119700`,
 * `/users/Tangy/mania`, with or without a scheme. Returns null when there is nothing
 * usable, so the caller can say so rather than fetching a nonsense URL.
 */
export function parseUserQuery(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) return null;

  const fromUrl = /osu\.ppy\.sh\/(?:users|u)\/([^/?#\s]+)/i.exec(raw);
  const candidate = decodeURIComponent(fromUrl ? fromUrl[1]! : raw);

  // osu! usernames allow letters, digits, spaces, and - [ ] _ . Anything else is a mistake
  // (an email, a whole sentence, a URL to somewhere else) and is worth rejecting here.
  if (!/^[\w \-[\]]{1,32}$/.test(candidate)) return null;
  return candidate;
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept, 'user-agent': USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Undo the HTML escaping osu-web applies to the `data-initial-data` attribute it mounts its
 * React app with. Shared by every reader of that payload.
 */
function decodeInitialData(attribute: string): string {
  return attribute
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    // & last, or it would corrupt the entities decoded above.
    .replaceAll('&amp;', '&');
}

/**
 * The public user object osu-web renders the profile page from.
 *
 * The payload is a private detail of osu-web and may change, hence the explicit error rather
 * than a silent empty result.
 */
function extractUser(html: string): OsuWebUser | null {
  const match = /data-initial-data="([^"]*)"/.exec(html);
  if (!match) return null;

  const json = decodeInitialData(match[1]!);

  let payload: { user?: Record<string, unknown> };
  try {
    payload = JSON.parse(json) as { user?: Record<string, unknown> };
  } catch {
    return null;
  }

  const user = payload.user;
  if (!user || typeof user['id'] !== 'number') return null;

  const country = user['country'] as { code?: unknown } | undefined;
  const page = user['page'] as { raw?: unknown } | undefined;
  return {
    id: user['id'],
    username: typeof user['username'] === 'string' ? user['username'] : String(user['id']),
    avatarUrl: typeof user['avatar_url'] === 'string' ? user['avatar_url'] : null,
    coverUrl: typeof user['cover_url'] === 'string' ? user['cover_url'] : null,
    countryCode:
      typeof user['country_code'] === 'string'
        ? user['country_code']
        : typeof country?.code === 'string'
          ? country.code
          : null,
    pageRaw: typeof page?.raw === 'string' && page.raw.trim() !== '' ? page.raw : null,
    previousUsernames: Array.isArray(user['previous_usernames'])
      ? user['previous_usernames'].filter((n): n is string => typeof n === 'string' && n !== '')
      : [],
  };
}

/**
 * Look up one osu! account. Throws with a message worth showing the user.
 *
 * Called only from an explicit action -- pressing "Look up" -- so there is one request per
 * button press and no schedule of any kind.
 */
export async function lookupUser(query: string): Promise<OsuWebUser> {
  const clean = parseUserQuery(query);
  if (clean === null) {
    throw new Error('that does not look like an osu! username, user id or profile link');
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://osu.ppy.sh/users/${encodeURIComponent(clean)}`,
      'text/html',
    );
  } catch {
    throw new Error('could not reach osu.ppy.sh -- check your connection, or type a name instead');
  }

  if (response.status === 404) throw new Error(`osu! has no user called "${clean}"`);
  if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

  const user = extractUser(await response.text());
  if (!user) {
    throw new Error(
      'osu.ppy.sh answered, but its profile page was not in the expected shape. ' +
        'Upload an image and type a name instead.',
    );
  }
  return user;
}

const EXTENSION_FOR: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export interface DownloadedImage {
  bytes: Buffer;
  extension: string;
}

/**
 * Fetch one image, so it can be copied into `data/` and served locally from then on.
 *
 * Copying rather than hotlinking is deliberate: the page has to stay complete with no
 * network, a portable build has to carry its own identity, and osu!'s asset host should not
 * be asked for the same file on every page load.
 */
export async function downloadImage(url: string): Promise<DownloadedImage> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, 'image/*');
  } catch {
    throw new Error('could not download that image');
  }
  if (!response.ok) throw new Error(`downloading the image failed (${response.status})`);

  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const extension = EXTENSION_FOR[type];
  if (!extension) throw new Error(`that is not an image this can use (${type || 'unknown type'})`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('that image was empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('that image is too large (8MB max)');

  return { bytes, extension };
}

/* ------------------------------------------------------------------ beatmapsets */

/** A ruleset as osu-web names it; `fruits` is osu!catch. */
export type OsuWebMode = 'osu' | 'taiko' | 'fruits' | 'mania';

export interface BeatmapsetDifficulty {
  id: number;
  mode: OsuWebMode;
  /** osu!'s own current star rating for the difficulty. */
  stars: number;
  version: string;
}

/**
 * A beatmapset as the Favorite Beatmaps card needs it: exactly the fields the card draws,
 * trimmed from osu-web's `json-beatmapset` so the cache holds nothing it does not use.
 */
export interface BeatmapsetDetails {
  id: number;
  title: string;
  artist: string;
  /**
   * osu!'s `title_unicode` / `artist_unicode`: the song's own script, for a profile that
   * prefers metadata in its original language. Null on details cached before these were kept,
   * which the card reads as "no different name" rather than as a blank.
   */
  titleUnicode: string | null;
  artistUnicode: string | null;
  creator: string;
  userId: number;
  /** osu-web's status name: ranked, approved, qualified, loved, pending, wip, graveyard. */
  status: string;
  /** Explicit content. */
  nsfw: boolean;
  spotlight: boolean;
  /** Set when the song is from osu!'s Featured Artist library. */
  featuredArtist: boolean;
  /** The set ships a background video / a storyboard: the two icons on the card's cover. */
  video: boolean;
  storyboard: boolean;
  favouriteCount: number;
  playCount: number;
  /** The date the card shows: when it was ranked or loved, else when it was last updated. */
  date: string | null;
  difficulties: BeatmapsetDifficulty[];
}

const MODES: readonly OsuWebMode[] = ['osu', 'taiko', 'fruits', 'mania'];

/** Statuses whose card shows `ranked_date`; the rest show `last_updated` (osu-web's map). */
const RANKED_DATE_STATUSES = new Set(['ranked', 'approved', 'loved', 'qualified']);

/**
 * The beatmapset osu-web renders its page from, reduced to `BeatmapsetDetails`.
 *
 * `osu.ppy.sh/beatmapsets/<id>` embeds the whole set as JSON in
 * `<script id="json-beatmapset">` -- every difficulty's star rating and mode, the explicit,
 * spotlight and featured-artist flags -- which is what the API's `/beatmapsets/{id}` would
 * return. Like the profile payload it is a private detail of osu-web, so a page in any other
 * shape is null rather than half-read. Pure, so it can be tested on a saved page.
 */
export function extractBeatmapset(html: string): BeatmapsetDetails | null {
  const match = /<script id="json-beatmapset" type="application\/json">\s*([\s\S]*?)\s*<\/script>/.exec(html);
  if (!match) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  return beatmapsetFromJson(raw);
}

/**
 * One beatmapset object as osu-web serialises it -- on its page, or in a profile's favourites
 * list, which use the same shape -- reduced to `BeatmapsetDetails`. Null if it is not one.
 */
export function beatmapsetFromJson(raw: Record<string, unknown>): BeatmapsetDetails | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const id = num(raw['id']);
  const title = str(raw['title']);
  const artist = str(raw['artist']);
  const status = str(raw['status']);
  if (id === null || title === null || artist === null || status === null) return null;

  const difficulties = (Array.isArray(raw['beatmaps']) ? raw['beatmaps'] : []).flatMap(
    (b): BeatmapsetDifficulty[] => {
      const beatmap = b as Record<string, unknown>;
      const mode = str(beatmap['mode']) as OsuWebMode | null;
      const bid = num(beatmap['id']);
      const stars = num(beatmap['difficulty_rating']);
      const version = str(beatmap['version']);
      if (mode === null || !MODES.includes(mode) || bid === null || stars === null || version === null) {
        return [];
      }
      return [{ id: bid, mode, stars, version }];
    },
  );

  const date = RANKED_DATE_STATUSES.has(status) ? str(raw['ranked_date']) : str(raw['last_updated']);

  return {
    id,
    title,
    artist,
    titleUnicode: str(raw['title_unicode']),
    artistUnicode: str(raw['artist_unicode']),
    creator: str(raw['creator']) ?? '',
    userId: num(raw['user_id']) ?? 0,
    status,
    nsfw: raw['nsfw'] === true,
    spotlight: raw['spotlight'] === true,
    featuredArtist: raw['track_id'] != null,
    video: raw['video'] === true,
    storyboard: raw['storyboard'] === true,
    favouriteCount: num(raw['favourite_count']) ?? 0,
    playCount: num(raw['play_count']) ?? 0,
    date: date ?? str(raw['last_updated']),
    difficulties,
  };
}

/** Favourites are read a hundred at a time, and at most fifty pages of them. */
const FAVOURITES_PAGE = 100;
const MAX_FAVOURITE_PAGES = 50;

/**
 * Every beatmapset an osu! account has favourited, as osu! lists them (newest first), with
 * the details each card draws.
 *
 * osu-web's profile page loads more favourites from `/users/<id>/beatmapsets/favourite`,
 * which answers JSON to anyone -- no credentials -- with each set in the same shape as
 * `json-beatmapset`. So an import is one request per hundred favourites and none per set.
 * Pages are read until one comes back empty, not until one comes back short, so a smaller
 * page size on osu!'s side cannot end the import early. Runs only because a button was
 * pressed.
 */
export async function fetchFavouriteBeatmapsets(userId: number): Promise<BeatmapsetDetails[]> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('not a user id');
  const shapeError = 'the favourites were not in the shape expected; osu! may have changed them';

  const sets: BeatmapsetDetails[] = [];
  const seen = new Set<number>();
  let offset = 0;
  for (let page = 0; page < MAX_FAVOURITE_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://osu.ppy.sh/users/${userId}/beatmapsets/favourite?limit=${FAVOURITES_PAGE}&offset=${offset}`,
        'application/json',
      );
    } catch {
      throw new Error('could not reach osu.ppy.sh');
    }
    if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

    let list: unknown;
    try {
      list = await response.json();
    } catch {
      throw new Error(shapeError);
    }
    if (!Array.isArray(list)) throw new Error(shapeError);
    if (list.length === 0) break;

    for (const raw of list) {
      const set = raw !== null && typeof raw === 'object' ? beatmapsetFromJson(raw as Record<string, unknown>) : null;
      if (set !== null && !seen.has(set.id)) {
        seen.add(set.id);
        sets.push(set);
      }
    }
    offset += list.length;
  }
  return sets;
}

/**
 * One request for one beatmapset, made because the user favourited it.
 *
 * Throws with a message worth showing; the caller keeps the favourite regardless and falls
 * back to what is on this machine.
 */
export async function fetchBeatmapset(beatmapsetId: number): Promise<BeatmapsetDetails> {
  if (!Number.isInteger(beatmapsetId) || beatmapsetId <= 0) throw new Error('not a beatmapset id');

  let response: Response;
  try {
    response = await fetchWithTimeout(`https://osu.ppy.sh/beatmapsets/${beatmapsetId}`, 'text/html');
  } catch {
    throw new Error('could not reach osu.ppy.sh');
  }
  if (response.status === 404) throw new Error('osu! has no beatmapset with that id');
  if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

  const details = extractBeatmapset(await response.text());
  if (!details) {
    throw new Error('the beatmapset page was not in the shape expected; osu! may have changed it');
  }
  return details;
}

/* ------------------------------------------------------------------ scores */

/**
 * A score as osu! itself holds it, reduced to what a `scores` row needs.
 *
 * Everything here comes from osu!'s own record of the play rather than from anything on this
 * machine, which is the point: a best performance may have been set years ago on another PC,
 * on a beatmap that was never installed here and whose replay this machine has never held.
 * So the beatmap's checksum, its metadata and osu!'s own pp all travel with the score, and
 * nothing in an import needs a local file to succeed.
 */
export interface OsuWebScore {
  /**
   * lazer's solo score id. Kept as a string because these outgrow `Number.MAX_SAFE_INTEGER`
   * and `JSON.parse` would round one before it could be read -- see `rawScoreIds`.
   */
  id: string;
  /**
   * osu!stable's own score id, set on a play made before lazer. This is the id an osu!stable
   * replay carries, so it is what matches such a replay to this score.
   */
  legacyScoreId: string | null;
  mode: Ruleset;
  /** The beatmap's MD5: how a local replay and this score name the same map. */
  beatmapMD5: string;
  beatmapId: number;
  beatmapsetId: number | null;
  artist: string | null;
  title: string | null;
  version: string | null;
  creator: string | null;
  /** osu!'s `approved` enum, mapped from the status name on the beatmap. */
  mapStatus: number;
  /** The beatmap's own star rating, unmodded, as osu! currently rates it. */
  beatmapStars: number | null;
  mods: LazerMod[];
  statistics: Record<string, number>;
  maximumStatistics: Record<string, number>;
  accuracy: number;
  maxCombo: number;
  /** osu!'s standardised scale, where a nomod SS is 1,000,000. */
  totalScore: number;
  classicTotalScore: number | null;
  legacyTotalScore: number | null;
  grade: string;
  passed: boolean;
  /** Whether osu! itself ranks this score -- its own verdict, so nothing here recomputes it. */
  ranked: boolean;
  /** osu!'s own pp for the play. Null on a score it awards none for. */
  pp: number | null;
  playedAt: number;
  /** Set on a best performance: the percentage osu! weights it at in the list. */
  weightPercentage: number | null;
}

/** osu-web's status names, to osu!'s `approved` enum. */
const STATUS_FOR_NAME: Record<string, number> = {
  graveyard: -2,
  wip: -1,
  pending: 0,
  ranked: 1,
  approved: 2,
  qualified: 3,
  loved: 4,
};

/** `ruleset_id` order, which is also this app's `Ruleset`. */
const MODE_FOR_RULESET: readonly OsuWebMode[] = ['osu', 'taiko', 'fruits', 'mania'];

export function osuWebMode(mode: Ruleset): OsuWebMode {
  return MODE_FOR_RULESET[mode]!;
}

/**
 * One score object as osu-web serialises it, reduced to `OsuWebScore`. Null if it is not one,
 * so a shape osu! has changed is skipped rather than half-read.
 *
 * A score with no usable id is dropped: it could not be deduplicated against a replay, and
 * that is the one thing an imported score has to be able to do.
 */
export function scoreFromJson(raw: Record<string, unknown>): OsuWebScore | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /*
   * A score id, as the text this app stores it as.
   *
   * Guarded rather than trusted: these are the whole basis of never importing a play twice,
   * and an id JSON.parse had to round is not that id. osu!'s are nowhere near the limit
   * today -- a solo id is about 1.7e9 and a legacy one 4.4e9, against 9.0e15 -- so this only
   * ever fires if osu! changes what an id is, and then refusing the score beats filing it
   * under a number that belongs to another play.
   */
  const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null);

  const ruleset = num(raw['ruleset_id']);
  const beatmap = (raw['beatmap'] ?? {}) as Record<string, unknown>;
  const set = (raw['beatmapset'] ?? {}) as Record<string, unknown>;
  const checksum = str(beatmap['checksum']);
  const beatmapId = num(beatmap['id']) ?? num(raw['beatmap_id']);
  const endedAt = str(raw['ended_at']);
  const grade = str(raw['rank']);
  const acc = num(raw['accuracy']);

  const soloId = id(raw['id']);
  if (soloId === null) return null;
  if (ruleset === null || ruleset < 0 || ruleset > 3) return null;
  if (checksum === null || beatmapId === null || endedAt === null) return null;
  if (grade === null || acc === null) return null;

  const playedAt = Date.parse(endedAt);
  if (!Number.isFinite(playedAt)) return null;

  const mods = (Array.isArray(raw['mods']) ? raw['mods'] : []).flatMap((m): LazerMod[] => {
    const mod = m as Record<string, unknown>;
    const acronym = str(mod['acronym']);
    if (acronym === null) return [];
    const settings = mod['settings'];
    return [
      settings !== null && typeof settings === 'object'
        ? { acronym, settings: settings as LazerMod['settings'] }
        : { acronym },
    ];
  });

  const counts = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v === null || typeof v !== 'object') return out;
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  };

  const weight = raw['weight'] as Record<string, unknown> | undefined;
  const statusName = str(beatmap['status']);

  return {
    id: soloId,
    legacyScoreId: id(raw['legacy_score_id']),
    mode: ruleset as Ruleset,
    beatmapMD5: checksum,
    beatmapId,
    beatmapsetId: num(beatmap['beatmapset_id']) ?? num(set['id']),
    artist: str(set['artist']),
    title: str(set['title']),
    version: str(beatmap['version']),
    creator: str(set['creator']),
    // A status osu! has since renamed counts as unresolved rather than as ranked.
    mapStatus:
      statusName !== null && statusName in STATUS_FOR_NAME
        ? STATUS_FOR_NAME[statusName]!
        : UNRESOLVED_STATUS,
    beatmapStars: num(beatmap['difficulty_rating']),
    mods,
    statistics: counts(raw['statistics']),
    maximumStatistics: counts(raw['maximum_statistics']),
    accuracy: acc,
    maxCombo: num(raw['max_combo']) ?? 0,
    totalScore: num(raw['total_score']) ?? 0,
    classicTotalScore: num(raw['classic_total_score']),
    legacyTotalScore: num(raw['legacy_total_score']),
    grade,
    passed: raw['passed'] === true,
    ranked: raw['ranked'] === true,
    pp: num(raw['pp']),
    playedAt,
    weightPercentage: weight ? num(weight['percentage']) : null,
  };
}

/** Scores are read a hundred at a time; osu! keeps 200 best performances per ruleset. */
const SCORES_PAGE = 100;
const MAX_SCORE_PAGES = 20;

/**
 * One page-by-page read of a user's scores, from whichever list osu-web exposes.
 *
 * Both lists the profile page loads more of -- `/scores/best` and `/scores/pinned` -- answer
 * JSON to anyone with no credentials, exactly as the favourites list does, so this keeps the
 * project's promise that it needs no login. Pages are read until one comes back empty rather
 * than until one comes back short, so a smaller page size on osu!'s side cannot end an
 * import early.
 */
async function fetchScoreList(
  userId: number,
  list: 'best' | 'pinned',
  mode: Ruleset,
): Promise<OsuWebScore[]> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('not a user id');
  const shapeError = 'the scores were not in the shape expected; osu! may have changed them';

  const scores: OsuWebScore[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_SCORE_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `https://osu.ppy.sh/users/${userId}/scores/${list}` +
          `?mode=${osuWebMode(mode)}&limit=${SCORES_PAGE}&offset=${offset}`,
        'application/json',
      );
    } catch {
      throw new Error('could not reach osu.ppy.sh');
    }
    if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

    let page_: unknown;
    try {
      page_ = await response.json();
    } catch {
      throw new Error(shapeError);
    }
    if (!Array.isArray(page_)) throw new Error(shapeError);
    if (page_.length === 0) break;

    for (const raw of page_) {
      const score =
        raw !== null && typeof raw === 'object'
          ? scoreFromJson(raw as Record<string, unknown>)
          : null;
      if (score !== null && !seen.has(score.id)) {
        seen.add(score.id);
        scores.push(score);
      }
    }
    // Advanced by what osu! returned, not by the page size, so a short page still walks on.
    offset += page_.length;
  }
  return scores;
}

/**
 * An account's best performances for one ruleset, in osu!'s own order -- which is the order
 * the weighting depends on, so it is never re-sorted.
 *
 * osu! keeps 200 of these per ruleset, not the 100 its profile page shows, and the 200th is
 * still worth something (0.95^199, about 0.004%). All of them are taken.
 */
export function fetchBestPerformances(userId: number, mode: Ruleset): Promise<OsuWebScore[]> {
  return fetchScoreList(userId, 'best', mode);
}

/** The scores an account has pinned to its profile, in the order osu! lists them. */
export function fetchPinnedScores(userId: number, mode: Ruleset): Promise<OsuWebScore[]> {
  return fetchScoreList(userId, 'pinned', mode);
}

/** What osu! itself says an account stands at, for one ruleset. */
export interface OsuWebStanding {
  totalPp: number | null;
  globalRank: number | null;
  countryRank: number | null;
}

/**
 * osu!'s own total pp and global rank for one ruleset.
 *
 * Read for one reason: bonus pp. It comes from how many distinct ranked beatmaps an account
 * has ever played -- thousands -- so an import of 200 best performances can only ever show
 * the bonus for 200, leaving the profile hundreds of pp and tens of thousands of places
 * short of the real one. osu!'s total, minus the weighted sum of the scores it just handed
 * over, *is* that bonus exactly, so it is taken from here rather than guessed.
 */
export async function fetchStanding(userId: number, mode: Ruleset): Promise<OsuWebStanding> {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('not a user id');

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://osu.ppy.sh/users/${userId}/${osuWebMode(mode)}`,
      'text/html',
    );
  } catch {
    throw new Error('could not reach osu.ppy.sh');
  }
  if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

  return extractStanding(await response.text());
}

/**
 * The `statistics` block of the profile payload, for the ruleset whose page was fetched.
 *
 * Pure, so it can be tested on a saved page. Every field is optional: an account that has
 * never played a ruleset has no rank there, and that is not an error.
 */
export function extractStanding(html: string): OsuWebStanding {
  const empty: OsuWebStanding = { totalPp: null, globalRank: null, countryRank: null };
  const match = /data-initial-data="([^"]*)"/.exec(html);
  if (!match) return empty;

  let payload: { user?: { statistics?: Record<string, unknown> } };
  try {
    payload = JSON.parse(decodeInitialData(match[1]!)) as typeof payload;
  } catch {
    return empty;
  }

  const stats = payload.user?.statistics;
  if (!stats) return empty;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    totalPp: num(stats['pp']),
    globalRank: num(stats['global_rank']),
    countryRank: num(stats['country_rank']),
  };
}
