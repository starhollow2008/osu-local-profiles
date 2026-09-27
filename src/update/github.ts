/**
 * Finding out whether a newer release exists.
 *
 * One unauthenticated request to the public releases API: when the app starts, then once a
 * day while it runs (`keepCheckingForUpdates`), or when a button is pressed. GitHub allows 60
 * an hour; the no-polling rule in docs/reference-links.md is osu!'s, and covers osu!.
 *
 * Everything here takes what it needs as an argument rather than reading `process`, so the
 * asset a Linux build would look for can be checked from Windows -- the lesson from
 * `clients/detect.ts`.
 */

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  /** The tag with any leading `v` removed, e.g. `1.3.0`. */
  version: string;
  releaseUrl: string;
  assets: ReleaseAsset[];
  /** The release page's text: its notes, for a release that has no `-notes.json`. */
  body: string;
  publishedAt: string | null;
}

/** `https://github.com/owner/repo.git` -> `owner/repo`. Null if it is not a GitHub URL. */
export function parseRepo(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function parts(version: string): { numbers: number[]; pre: string } {
  const [main = '', pre = ''] = version.replace(/^v/, '').split('-', 2);
  return { numbers: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
}

/**
 * Compare two versions: -1 if `a` is older, 1 if newer, 0 if the same.
 *
 * A pre-release sorts *below* the release it leads to, so 1.3.0-beta.1 is older than
 * 1.3.0 -- otherwise a build that shipped a beta tag would refuse the real release that
 * followed it.
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < Math.max(left.numbers.length, right.numbers.length); i += 1) {
    const l = left.numbers[i] ?? 0;
    const r = right.numbers[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The archive this platform would install, named as `scripts/package.mjs` names it. */
export function assetNameFor(version: string, platform: string, arch: string): string {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  return `osu-local-profiles-${version}-${os}-${cpu}.zip`;
}

export function assetFor(release: Release, platform: string, arch: string): ReleaseAsset | null {
  const wanted = assetNameFor(release.version, platform, arch).toLowerCase();
  return release.assets.find((a) => a.name.toLowerCase() === wanted) ?? null;
}

/**
 * The newest published release, or throw with a message worth showing.
 *
 * A private repository answers 404 to an unauthenticated caller -- indistinguishable from
 * "no releases yet" -- so that case is named explicitly rather than reported as a missing
 * release, which would send someone looking for the wrong problem.
 */
/** One request to GitHub's releases API, with its failures named for what they mean here. */
async function githubApi(repo: string, pathname: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      // GitHub rejects an API request with no user agent.
      'user-agent': 'osu-local-profiles',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 404) {
    throw new Error(`${repo} has no published releases, or is private`);
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub rate limit reached; try again later');
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  return response.json();
}

/** A release as the API describes it, or null for one that is not a usable release. */
function releaseFrom(raw: unknown, repo: string): Release | null {
  const body = raw as Record<string, unknown>;
  const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
  if (tag === null || body.draft === true || body.prerelease === true) return null;

  const assets = Array.isArray(body.assets) ? body.assets : [];
  return {
    version: tag.replace(/^v/, ''),
    releaseUrl:
      typeof body.html_url === 'string' ? body.html_url : `https://github.com/${repo}/releases`,
    body: typeof body.body === 'string' ? body.body : '',
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    assets: assets.flatMap((a): ReleaseAsset[] => {
      const asset = a as Record<string, unknown>;
      if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return [];
      return [
        {
          name: asset.name,
          url: asset.browser_download_url,
          size: typeof asset.size === 'number' ? asset.size : 0,
        },
      ];
    }),
  };
}

export async function fetchLatestRelease(repo: string, timeoutMs = 10_000): Promise<Release> {
  const release = releaseFrom(await githubApi(repo, '/releases/latest', timeoutMs), repo);
  if (release === null) throw new Error('the release has no tag');
  return release;
}

/**
 * The newest releases, newest first: what an install that is several versions behind has
 * missed, each with its notes and its date. Asked once per new version found, never on the
 * daily check itself, since it is a larger answer than the latest release alone.
 */
export async function fetchRecentReleases(repo: string, count = 30, timeoutMs = 15_000): Promise<Release[]> {
  const list = await githubApi(repo, `/releases?per_page=${count}`, timeoutMs);
  if (!Array.isArray(list)) throw new Error('GitHub did not answer with a list of releases');
  return list.map((raw) => releaseFrom(raw, repo)).filter((r): r is Release => r !== null);
}
