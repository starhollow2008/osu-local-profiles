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
}
