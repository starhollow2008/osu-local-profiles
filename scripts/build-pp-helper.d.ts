/**
 * Types for the one build script the tests reach into.
 *
 * `scripts/` is plain JavaScript and outside `tsconfig.json`'s `include`, which is right:
 * build tooling should not need a typecheck to run. But `test/pp-helper.test.ts` imports
 * from it, and an untyped import would be `any` under `strict`, so the shape it depends on
 * is declared here rather than the test being exempted from checking.
 */
declare module '*/build-pp-helper.mjs' {
  /** Managed assemblies every build drops. */
  export const PRUNE_ASSEMBLIES: readonly string[];

  /** Native libraries every build drops, by base name. */
  export const PRUNE_NATIVES: readonly string[];

  /** Whether a published file is one a build has no use for: the trimmed app's list by default. */
  export function shouldPrune(filename: string, slim?: boolean): boolean;

  /** The `dotnet publish` arguments that make the trimmed app. */
  export const SLIM_PUBLISH_ARGS: readonly string[];

  /** The .NET runtime identifier for the machine this is running on. */
  export function defaultRid(): string;

  /** How this machine can run a build for `target`: pp-parity flags, or null when it cannot. */
  export function runnerFor(target: string): string[] | null;

  /** Publish the full helper into `outDir` and prune it. */
  export function buildPpHelper(outDir: string, target?: string): { before: number; after: number; removed: number };

  /** The app for a package: trimmed only if it answers every parity request as the untrimmed one does. */
  export function buildCheckedApp(
    outDir: string,
    target?: string,
  ): { slim: boolean; reason: string; before: number; full: number; after: number };
}
