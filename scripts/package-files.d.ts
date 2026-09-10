/**
 * Types for the packaging text that `test/package-files.test.ts` checks.
 *
 * `scripts/` is plain JavaScript and outside `tsconfig.json`'s `include`, which is right:
 * build tooling should not need a typecheck to run. The shape the tests depend on is
 * declared here so the import is not `any` under `strict`.
 */
declare module '*/package-files.mjs' {
  /** `win` | `osx` | `linux` -- the first half of a .NET runtime identifier. */
  export type HostOs = 'win' | 'osx' | 'linux';

  /** The launcher for a platform: what to call it, what is in it, and its file mode. */
  export function launcherFor(
    hostOs: HostOs,
    nodeBinary: string,
  ): { name: string; content: string; mode: number | null };

  /** The README.txt that ships beside it. */
  export function readmeFor(hostOs: HostOs): string;
}
