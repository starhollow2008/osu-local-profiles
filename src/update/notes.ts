import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from './github.ts';

/**
 * Patch notes: what is new before an update, and what changed after one (roadmap 5.66).
 *
 * Both come from the CHANGELOG, made into a line per change by `scripts/release-notes.mjs`
 * (`notesJson`) -- the same lines a release page lists. Before an update they are the release's
 * `-notes.json` asset, fetched once per new version found; after one, `release-notes.json`
 * inside the package, so the new version can say what it brought with no network at all.
 */

export interface VersionNotes {
  version: string;
  /** The day it was released, `YYYY-MM-DD`, where that is known. */
  date: string | null;
  /** Marked in the CHANGELOG as one everyone should have. */
  important: boolean;
  highlights: string[];
}

/** Where every changed line lives in full. */
export const CHANGELOG_URL = 'https://github.com/jonathant09/osu-local-profiles/blob/main/CHANGELOG.md';

const MAX_LINE = 200;
const MAX_LINES = 30;

/** Checked and trimmed: this arrives over the network, and ends up on the page. */
export function parseNotes(raw: unknown): VersionNotes[] {
  const versions = (raw as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) return [];
  return versions.flatMap((v): VersionNotes[] => {
    const n = v as Partial<Record<keyof VersionNotes, unknown>>;
    if (typeof n?.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(n.version)) return [];
    return [
      {
        version: n.version,
        date: typeof n.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : null,
        important: n.important === true,
        highlights: (Array.isArray(n.highlights) ? n.highlights : [])
          .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
          .slice(0, MAX_LINES)
          .map((h) => (h.length > MAX_LINE ? `${h.slice(0, MAX_LINE)}...` : h)),
      },
    ];
  });
}

/** The versions after `from` (not included; null for "unknown") up to `to`, newest first. */
export function notesBetween(all: VersionNotes[], from: string | null, to: string): VersionNotes[] {
  return all
    .filter((n) => compareVersions(n.version, to) <= 0 && (from === null ? n.version === to : compareVersions(n.version, from) > 0))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Written into a release page by `releaseNotes` when the version's CHANGELOG section carries
 * it (`IMPORTANT_MARK` in scripts/release-notes.mjs). An HTML comment, so GitHub shows nothing.
 */
export const IMPORTANT_MARK = '<!-- important -->';

/**
 * A release's notes from its page, which is what `releaseNotes` wrote: a line per change, then
 * a link to the CHANGELOG, and the important mark when the version is one everyone should have.
 */
export function notesFromBody(body: string, version: string, publishedAt: string | null): VersionNotes[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((l) => /^Everything in this release/i.test(l));
  const highlights = (end < 0 ? lines : lines.slice(0, end))
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
  const date = publishedAt !== null && /^\d{4}-\d{2}-\d{2}/.test(publishedAt) ? publishedAt.slice(0, 10) : null;
  const important = lines.some((l) => l.trim() === IMPORTANT_MARK);
  return parseNotes({ versions: [{ version, date, important, highlights }] });
}

/** This package's own notes, for after an update. Empty in a checkout, which has none. */
export function localNotes(dir: string): VersionNotes[] {
  try {
    return parseNotes(JSON.parse(fs.readFileSync(path.join(dir, 'release-notes.json'), 'utf8')));
  } catch {
    return [];
  }
}

/**
 * The version `data/update.log` says the last update installed, if it succeeded. How the first
 * version to show notes after an update knows it was updated to: the one before it recorded
 * no "last version seen" to compare with.
 */
export function updatedToFromLog(dataDir: string): string | null {
  try {
    const first = fs.readFileSync(path.join(dataDir, 'update.log'), 'utf8').split('\n')[0] ?? '';
    return /^OK: updated to (\S+)/.exec(first)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Past this, the update waiting is said above the page, not only by its button. */
export const BEHIND_DAYS = 14;

/**
 * How loudly to say an update is waiting: `important` when a missing version is marked so,
 * `behind` when the oldest missing one came out `BEHIND_DAYS` ago, otherwise only the button.
 */
export function nudgeFor(missing: VersionNotes[], now: number): 'important' | 'behind' | null {
  if (missing.some((n) => n.important)) return 'important';
  const dates = missing.map((n) => n.date).filter((d): d is string => d !== null).sort();
  const oldest = dates[0];
  if (oldest !== undefined && now - Date.parse(`${oldest}T00:00:00Z`) >= BEHIND_DAYS * 86_400_000) return 'behind';
  return null;
}

export interface NudgeDismissal {
  /** The newest version when it was dismissed. */
  version: string;
  at: number;
}

/** A dismissed notice stays away for this long, unless something important comes out. */
export const NUDGE_QUIET_DAYS = 7;

/** Whether the notice above the page shows, given what dismissed it last. */
export function nudgeShown(
  nudge: 'important' | 'behind' | null,
  missing: VersionNotes[],
  dismissed: NudgeDismissal | null,
  now: number,
): boolean {
  if (nudge === null) return false;
  if (dismissed === null) return true;
  const importantSince = missing.some((n) => n.important && compareVersions(n.version, dismissed.version) > 0);
  return importantSince || now - dismissed.at >= NUDGE_QUIET_DAYS * 86_400_000;
}
