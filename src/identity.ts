import fs from 'node:fs';
import path from 'node:path';

/**
 * The avatar and banner a profile shows, stored as files in `data/`.
 *
 * **Per profile, not per install.** Two profiles are two identities -- that is the whole
 * point of having more than one -- so "left hand" and "mouse only" get their own pictures.
 * The original global `avatar.png` / `cover.jpg` are still honoured as a fallback, so
 * anything dropped into `data/` by hand before this existed keeps working.
 *
 * Images are always *copied* here rather than linked to. The page has to be complete with
 * no network, a portable build has to carry its own identity on a stick, and osu!'s asset
 * host should not be asked for the same file every time the page loads.
 */

export type ImageKind = 'avatar' | 'cover';

/** Extensions accepted for a stored image, in the order they are looked for. */
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

/** The pre-profile names, kept working so nothing anyone set up by hand breaks. */
const LEGACY_NAMES: Record<ImageKind, string[]> = {
  avatar: ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp'],
  cover: ['cover.jpg', 'cover.png', 'cover.jpeg', 'cover.webp'],
};

export const MIME_FOR_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function profileFile(dataDir: string, profileId: number, kind: ImageKind, extension: string): string {
  return path.join(dataDir, `profile-${profileId}-${kind}${extension}`);
}

/** The image this profile should show, or null to fall back to what the page generates. */
export function findImage(dataDir: string, profileId: number, kind: ImageKind): string | null {
  for (const extension of EXTENSIONS) {
    const file = profileFile(dataDir, profileId, kind, extension);
    if (fs.existsSync(file)) return file;
  }
  for (const name of LEGACY_NAMES[kind]) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Replace this profile's image.
 *
 * Every other extension for the same profile and kind is removed first, so switching from a
 * PNG to a JPEG cannot leave two files with the older one winning the lookup order.
 */
export function saveImage(
  dataDir: string,
  profileId: number,
  kind: ImageKind,
  bytes: Buffer,
  extension: string,
): string {
  if (!MIME_FOR_EXTENSION[extension]) throw new Error(`unsupported image type ${extension}`);
  fs.mkdirSync(dataDir, { recursive: true });
  clearImage(dataDir, profileId, kind);

  const file = profileFile(dataDir, profileId, kind, extension);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * Remove this profile's image, returning to the generated avatar or the best play's cover.
 *
 * Only touches this profile's own files: a legacy `data/avatar.png` is left alone, because
 * it was put there by hand and is shared by every profile that has not set its own.
 */
export function clearImage(dataDir: string, profileId: number, kind: ImageKind): void {
  for (const extension of EXTENSIONS) {
    fs.rmSync(profileFile(dataDir, profileId, kind, extension), { force: true });
  }
}

/** Everything a profile's images are made of, for `/api/state`. */
export function imageState(dataDir: string, profileId: number) {
  return {
    hasAvatar: findImage(dataDir, profileId, 'avatar') !== null,
    hasCover: findImage(dataDir, profileId, 'cover') !== null,
  };
}

/**
 * Sniff an uploaded file rather than trusting what it says it is.
 *
 * The browser's content-type is whatever the page chose to send, and the extension is
 * whatever the file was called. Neither is evidence. These magic numbers are, and refusing
 * anything else keeps `data/` to actual images.
 */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF89a' ||
      bytes.subarray(0, 6).toString('latin1') === 'GIF87a') return '.gif';
  return null;
}
