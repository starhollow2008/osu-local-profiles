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
