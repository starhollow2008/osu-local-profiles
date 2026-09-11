import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIME_FOR_EXTENSION, sniffImage } from './identity.ts';

/**
 * Images in a profile's me!, pasted or dropped into its editor.
 *
 * Stored in `data/about-images/<profile id>/`, like every other image this app keeps, so the
 * page is complete with no network and a portable build carries them. Each is named by its
 * own content, so pasting the same picture twice stores it once, and a name always means the
 * same bytes -- which is what lets the browser keep them for good.
 *
 * The page refers to one as `[img]/api/about-image/<profile>/<name>[/img]`; web/js/bbcode.js
 * accepts exactly that shape and nothing else that points at this app.
 */

const ROUTE = /^\/api\/about-image\/(\d+)\/([0-9a-f]{16})\.(png|jpg|webp|gif)$/;

const folder = (dataDir: string, profileId: number | string) => path.join(dataDir, 'about-images', String(profileId));

/** Keep an uploaded image and return the address the page uses for it; null if it is not an image. */
export function saveAboutImage(dataDir: string, profileId: number, bytes: Buffer): string | null {
  const extension = sniffImage(bytes);
  if (extension === null) return null;
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${extension}`;
  fs.mkdirSync(folder(dataDir, profileId), { recursive: true });
  const file = path.join(folder(dataDir, profileId), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return `/api/about-image/${profileId}/${name}`;
}

/** The file behind an address from `saveAboutImage`, or null for anything else. */
export function aboutImageFile(dataDir: string, pathname: string): { file: string; mime: string } | null {
  const m = ROUTE.exec(pathname);
  if (!m) return null;
  const file = path.join(folder(dataDir, m[1]!), `${m[2]}.${m[3]}`);
  const mime = MIME_FOR_EXTENSION[`.${m[3]}`];
  return mime !== undefined && fs.existsSync(file) ? { file, mime } : null;
}
