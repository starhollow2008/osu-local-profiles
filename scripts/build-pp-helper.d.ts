/**
 * Types for the one build script the tests reach into.
 *
 * `scripts/` is plain JavaScript and outside `tsconfig.json`'s `include`, which is right:
 * build tooling should not need a typecheck to run. But `test/pp-helper.test.ts` imports
 * from it, and an untyped import would be `any` under `strict`, so the shape it depends on
 * is declared here rather than the test being exempted from checking.
 */
declare module '*/build-pp-helper.mjs' {
  /** Whether a published file is one the pp helper has no use for. */
  export function shouldPrune(filename: string): boolean;

  /** The .NET runtime identifier for the machine this is running on. */
  export function defaultRid(): string;

  /** Publish the helper into `outDir` and prune it. */
  export function buildPpHelper(
    outDir: string,
    target?: string,
  ): { before: number; after: number; removed: number };
}
