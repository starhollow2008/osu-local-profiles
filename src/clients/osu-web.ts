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
 * The public user object osu-web renders the profile page from.
 *
 * The page mounts its React app with the payload in a `data-initial-data` attribute, HTML
 * escaped. That is a private detail of osu-web and may change, hence the explicit error
 * rather than a silent empty result.
 */
function extractUser(html: string): OsuWebUser | null {
  const match = /data-initial-data="([^"]*)"/.exec(html);
  if (!match) return null;

  const json = match[1]!
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    // & last, or it would corrupt the entities decoded above.
    .replaceAll('&amp;', '&');

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
