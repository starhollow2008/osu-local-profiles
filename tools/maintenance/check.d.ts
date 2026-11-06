/**
 * Types for what `test/maintenance-check.test.ts` imports from the daily job's check, which is
 * plain JavaScript like `scripts/` (see `scripts/build-pp-helper.d.ts`).
 */
declare module '*/maintenance/check.mjs' {
  /** The day a data.ppy.sh dump such as `2026_11_05` was taken, as a UTC timestamp. */
  export function dumpDate(dump: string): number;

  /** The day osu! released a `YYYY.MDD.N` version, as a UTC timestamp. */
  export function versionDate(version: string): number;

  /** How old a source's newest release is, and whether it has gone quiet: null means none was found. */
  export function staleness(
    newest: number | null,
    now: number,
    days?: number,
  ): { ageDays: number | null; stale: boolean };
}
