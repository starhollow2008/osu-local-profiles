/**
 * Types for the one build script the tests reach into.
 *
 * `scripts/` is plain JavaScript and outside `tsconfig.json`'s `include`, which is right:
 * build tooling should not need a typecheck to run. But `test/pp-helper.test.ts` imports
 * from it, and an untyped import would be `any` under `strict`, so the shape it depends on
 * is declared here rather than the test being exempted from checking.
 */
declare module '*/build-pp-helper.mjs' {
  /** Whether a published file is one the pp helper has no use for: the slim one by default. */
  export function shouldPrune(filename: string, slim?: boolean): boolean;

  /** The `dotnet publish` arguments that make the slim helper. */
  export const SLIM_PUBLISH_ARGS: readonly string[];

  /** The .NET runtime identifier for the machine this is running on. */
  export function defaultRid(): string;

  /** How this machine can run a helper for `target`: pp-parity flags, or null when it cannot. */
  export function runnerFor(target: string): string[] | null;

  /** Publish the helper into `outDir` and prune it, full or slim, unchecked. */
  export function buildPpHelper(
    outDir: string,
    target?: string,
    options?: { slim?: boolean },
  ): { before: number; after: number; removed: number; slim: boolean };

  /** Publish the helper that ships: slim only if the parity check passes, full otherwise. */
  export function buildCheckedPpHelper(
    outDir: string,
    target?: string,
    options?: { corpus?: string | null },
  ): { slim: boolean; reason: string; before: number; full: number; after: number; removed: number };
}
