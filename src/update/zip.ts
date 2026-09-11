import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Just enough ZIP to unpack a release.
 *
 * A dependency is not available here -- `node:sqlite` and one pure-JS LZMA codec are the
 * whole runtime dependency list, and an archive extractor pulled off npm is exactly the
 * kind of thing that ends up being a native module. Shelling out to Windows' `tar.exe` was
 * the other option and was rejected for the same reason `detect.ts` takes a platform: it
 * would make the one risky path in the app depend on a binary that is only there on one OS.
 *
 * ZIP is read back to front. The End of Central Directory record at the tail points at the
 * central directory, which is the authoritative list of what is in the file; each entry
 * then points at its own local header, and the bytes follow that.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** Stored and deflated. Nothing else has ever come out of the packager. */
const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  /** Always with forward slashes, whatever the archive used. */
  name: string;
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The record is 22 bytes plus a comment of up to 64KB, so this is the whole search space.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Normalise a name out of the archive, and refuse anything that points outside the target.
 *
 * This runs on a file downloaded over the network, so it is a security check rather than a
 * tidiness one: an entry named `..\..\Windows\System32\...` would otherwise be written
 * exactly where it asked to be. Backslashes are normalised because *this project's own
 * packager writes them* -- the ZIP spec says forward slashes, and the entries in a release
 * built on Windows say `osu-local-profiles-1.5.0-win-x64\node.exe`.
 */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (name === '') return null;
  if (/^[a-zA-Z]:/.test(name)) return null;
  if (name.split('/').some((part) => part === '..')) return null;
  return name;
}

/** Read the central directory. Throws rather than guessing if the archive is not one we read. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  /*
   * Zip64 is refused rather than half-supported. The counts and offsets in a plain EOCD are
   * 16- and 32-bit, so an archive that needed zip64 would silently read as a truncated one
   * -- a partial extraction that looks like a success is the worst outcome for something
   * that then replaces an install.
   */
  const locator = eocd - 20;
  if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('zip64 archives are not supported');
  }

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${i + 1} of ${count}`);
    }

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const raw = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    const name = safeName(raw);
    if (name === null) throw new Error(`refusing entry with an unsafe path: ${raw}`);

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      method,
      compressedSize,
      size,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** The bytes of one entry, decompressed. */
function entryData(buf: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  if (buf.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }

  // The local header repeats the name and carries its own extra field, which is frequently
  // a different length from the central directory's -- so the data start has to be computed
  // from *this* header, not from the central one.
  const nameLength = buf.readUInt16LE(header + 26);
  const extraLength = buf.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === STORED) return Buffer.from(raw);
  if (entry.method === DEFLATED) return zlib.inflateRawSync(raw);
  throw new Error(`${entry.name} uses unsupported compression method ${entry.method}`);
}

/**
 * Extract `file` into `dest`, dropping `stripComponents` leading path segments.
 *
 * A release archive wraps everything in one `osu-local-profiles-<version>-<target>/` folder,
 * so extracting it usefully means stripping that. Returns how many files were written, so
 * the caller can refuse a suspiciously empty result rather than swapping in nothing.
 */
export function extractZip(file: string, dest: string, stripComponents = 0): number {
  const buf = fs.readFileSync(file);
  const entries = readZipEntries(buf);

  let written = 0;
  for (const entry of entries) {
    const parts = entry.name.split('/').slice(stripComponents);
    const relative = parts.join('/');
    if (relative === '') continue;

    const target = path.join(dest, ...parts);
    // Belt and braces: `safeName` already refused traversal, but the target is what matters.
    const resolvedDest = path.resolve(dest);
    if (!path.resolve(target).startsWith(resolvedDest)) {
      throw new Error(`refusing to write outside the target: ${entry.name}`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = entryData(buf, entry);
    if (data.length !== entry.size) {
      throw new Error(`${entry.name} unpacked to ${data.length} bytes, expected ${entry.size}`);
    }
    fs.writeFileSync(target, data);
    written += 1;
  }

  return written;
}
