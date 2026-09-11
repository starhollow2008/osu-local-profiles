/**
 * Finding out whether a newer release exists.
 *
 * One unauthenticated request to the public releases API, made because a button was
 * pressed or once when the app starts -- never on a timer. That is the same rule the osu!
 * API notes in docs/reference-links.md impose, applied here for the same reason: this app
 * is not entitled to somebody else's bandwidth just because it is running.
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
export async function fetchLatestRelease(repo: string, timeoutMs = 10_000): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
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

  const body = (await response.json()) as Record<string, unknown>;
  const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
  if (tag === null) throw new Error('the release has no tag');

  const assets = Array.isArray(body.assets) ? body.assets : [];
  return {
    version: tag.replace(/^v/, ''),
    releaseUrl:
      typeof body.html_url === 'string' ? body.html_url : `https://github.com/${repo}/releases`,
    assets: assets.flatMap((raw): ReleaseAsset[] => {
      const a = raw as Record<string, unknown>;
      if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') return [];
      return [
        {
          name: a.name,
          url: a.browser_download_url,
          size: typeof a.size === 'number' ? a.size : 0,
        },
      ];
    }),
  };
}
