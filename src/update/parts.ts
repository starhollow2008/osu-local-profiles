/**
 * An update in parts: download only what changed.
 *
 * A package is four things of very different sizes and lifetimes: the app itself (a few MB,
 * different every release), the Node runtime (most of the download, changing only when the
 * runtime is bumped), the pp helper (the rest, changing with osu!'s calculator) and the tray
 * launcher. Every release publishes each as a zip of its own beside the full one, with a
 * manifest of every file's SHA-256, and an install that already holds a part's files byte for
 * byte copies them from itself instead of downloading them again (roadmap 5.66).
 *
 * Nothing about the swap changes: the staged tree is the whole release, assembled and then
 * checked file by file against the manifest before anything is swapped. A part that is
 * missing, or anything that does not check out, falls back to the full zip.
 *
 * Pure: `scripts/package.mjs` names and fills the parts with this, and the updater reads them
 * back with it, so the two cannot disagree.
 */

export const PARTS = ['app', 'runtime', 'pp', 'launcher'] as const;
export type PartName = (typeof PARTS)[number];

export interface ManifestFile {
  /** Relative to the install, with `/` separators. */
  path: string;
  sha256: string;
  size: number;
  part: PartName;
}

export interface PartsManifest {
  version: string;
  /** `win-x64`, `osx-arm64`... as the full archive is named. */
  rid: string;
  /** Each part's zip, and its size, so a download can be checked before it is unpacked. */
  parts: Partial<Record<PartName, { asset: string; size: number }>>;
  files: ManifestFile[];
}

/** The platform half of a RID, in `process.platform`'s words. */
export function platformOfRid(rid: string): string {
  const os = rid.split('-')[0];
  return os === 'win' ? 'win32' : os === 'osx' ? 'darwin' : 'linux';
}

/** The RID this process would install, as `assetNameFor` names it. */
export function ridFor(platform: string, arch: string): string {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'osx' : 'linux';
  return `${os}-${cpu}`;
}

/** What each platform's package opens (scripts/package-files.mjs, `trayLauncherFor`). */
export function launcherNameFor(platform: string): string {
  if (platform === 'win32') return 'osu! local profiles.exe';
  if (platform === 'darwin') return 'osu! local profiles.app';
  return 'osu-local-profiles';
}

/** Which part a file of the install belongs to. */
export function partOf(relPath: string, platform: string): PartName {
  const top = relPath.split('/')[0];
  if (top === 'node.exe' || top === 'node') return 'runtime';
  if (top === 'tools') return 'pp';
  if (top === launcherNameFor(platform)) return 'launcher';
  return 'app';
}

export const partAssetName = (version: string, rid: string, part: PartName): string =>
  `osu-local-profiles-${version}-${rid}-${part}.zip`;

export const manifestAssetName = (version: string, rid: string): string =>
  `osu-local-profiles-${version}-${rid}-manifest.json`;

/** Checked before anything in it is trusted: this arrives over the network. */
export function parseManifest(raw: unknown, version: string, rid: string): PartsManifest {
  const m = raw as Partial<PartsManifest> | null;
  if (m === null || typeof m !== 'object') throw new Error('the manifest is not an object');
  if (m.version !== version || m.rid !== rid) {
    throw new Error(`the manifest is for ${String(m.version)} ${String(m.rid)}, not ${version} ${rid}`);
  }
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('the manifest lists no files');
  for (const f of m.files) {
    const ok =
      typeof f?.path === 'string' &&
      f.path.length > 0 &&
      // Relative, inside the install, and never data/: the swap steps around that.
      !f.path.startsWith('/') &&
      !/^[A-Za-z]:/.test(f.path) &&
      !f.path.split('/').includes('..') &&
      f.path.split('/')[0] !== 'data' &&
      typeof f.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(f.sha256) &&
      typeof f.size === 'number' &&
      (PARTS as readonly string[]).includes(f.part);
    if (!ok) throw new Error(`the manifest has an entry that is not a file of the app: ${JSON.stringify(f)}`);
  }
  if (m.parts === null || typeof m.parts !== 'object') throw new Error('the manifest names no parts');
  return m as PartsManifest;
}

export interface PartsPlan {
  /** Parts to download: at least one of their files is missing here, or different. */
  download: PartName[];
  /** Files to copy from this install, all in parts that are not downloaded. */
  reuse: ManifestFile[];
  /** What the download costs, from the manifest's sizes. */
  bytes: number;
}

/**
 * Which parts have to be downloaded, given what each file hashes to here (null: not here).
 *
 * A part is all or nothing: one changed file downloads the whole part, which is small next to
 * the bookkeeping a file-by-file download would need, and keeps every download a plain zip.
 */
export function planParts(manifest: PartsManifest, localHash: (relPath: string) => string | null): PartsPlan {
  const needed = new Set<PartName>();
  for (const f of manifest.files) {
    if (needed.has(f.part)) continue;
    if (localHash(f.path) !== f.sha256) needed.add(f.part);
  }
  for (const part of needed) {
    if (!manifest.parts[part]) throw new Error(`the release has no ${part} part to download`);
  }
  const download = PARTS.filter((p) => needed.has(p));
  return {
    download,
    reuse: manifest.files.filter((f) => !needed.has(f.part)),
    bytes: download.reduce((n, p) => n + (manifest.parts[p]?.size ?? 0), 0),
  };
}
