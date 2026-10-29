/** Types for the release notes that `test/release-notes.test.ts` checks. */
declare module '*/release-notes.mjs' {
  /** The text under `## <version>` in CHANGELOG.md, or null when there is none. */
  export function changelogSection(changelog: string, version: string): string | null;

  /** The archive each platform's release build is named. One per row of the release matrix. */
  export function assetsFor(version: string): {
    windows: string;
    macos: string;
    macosIntel: string;
    linux: string;
  };

  /** How many changes a release lists before pointing at the CHANGELOG for the rest. */
  export const MAX_HIGHLIGHTS: number;

  /** One line for a CHANGELOG entry. */
  export function headline(entry: string): string;

  /** What a release changed, a line each. */
  export function highlights(section: string): string[];

  /** The paragraph a section opens with, when it is short. */
  export function intro(section: string): string | null;

  /**
   * The whole release body, naming the downloads in `assets` (every platform by default).
   * Throws when CHANGELOG.md has nothing for the version.
   */
  export function releaseNotes(changelog: string, version: string, assets?: string[]): string;

  /** The line that marks a version everyone should have. */
  export const IMPORTANT_MARK: string;
  export function isImportant(changelog: string, version: string): boolean;
  /** The line that puts a version's entries on its release page and patch notes whole. */
  export const IN_FULL_MARK: string;
  export function isInFull(changelog: string, version: string): boolean;
  /** Past this, every installed app cuts a patch-notes line short. */
  export const MAX_NOTE_LINE: number;
  /** A section's entries whole, as plain lines of at most `MAX_NOTE_LINE`. */
  export function fullLines(section: string): string[];
  /** Every version with a section, newest first. */
  export function changelogVersions(changelog: string): string[];
  export const MAX_NOTES_VERSIONS: number;
  /** Every version's highlights as data, for the app. */
  export function notesJson(
    changelog: string,
    dates?: Record<string, string>,
  ): {
    versions: { version: string; date: string | null; important: boolean; highlights: string[] }[];
  };
  /** Each tagged version's day. */
  export function tagDates(cwd?: string): Record<string, string>;
}
