/** Types for the release notes that `test/release-notes.test.ts` checks. */
declare module '*/release-notes.mjs' {
  /** The text under `## <version>` in CHANGELOG.md, or null when there is none. */
  export function changelogSection(changelog: string, version: string): string | null;

  /** The archive each platform's release build is named. */
  export function assetsFor(version: string): { windows: string; macos: string; linux: string };

  /** The whole release body. Throws when CHANGELOG.md has nothing for the version. */
  export function releaseNotes(changelog: string, version: string): string;
}
