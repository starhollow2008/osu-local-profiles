/**
 * Types for the launcher build that `test/launcher.test.ts` runs. See `package-files.d.ts` for
 * why `scripts/` declares its shape here.
 */
declare module '*/build-launcher.mjs' {
  /** tools/launcher: the Go source, and where `go test` runs. */
  export const launcherSource: string;

  export function goTarget(rid: string): { goos: string; goarch: string };

  export function infoPlist(version: string): string;

  /** Build for `rid` into `outDir`; returns the path of the executable (inside the bundle on macOS). */
  export function buildLauncher(outDir: string, rid?: string, version?: string): string;
}
