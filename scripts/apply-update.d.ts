/**
 * Types for the relaunch decision that `test/relaunch.test.ts` checks.
 *
 * The same arrangement as `package-files.d.ts`: `scripts/` is plain JavaScript outside
 * `tsconfig.json`'s `include`, and this declares the shape the tests depend on.
 */
declare module '*/apply-update.mjs' {
  import type { SpawnOptions } from 'node:child_process';

  /** Something to spawn, or the reason nothing should be. */
  export type RelaunchPlan =
    | { command: string; args: string[]; options: SpawnOptions }
    | { skip: string };

  export function launcherName(platform: string): string;

  export const LINUX_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]>;

  export function relaunchPlan(input: {
    platform: string;
    installDir: string;
    /** The app was started by a launcher that will start it again after the swap. */
    launcherRestarts: boolean;
    exists: (file: string) => boolean;
    findOnPath: (program: string) => string | null;
    env: Record<string, string | undefined>;
  }): RelaunchPlan;
}
