/** Types for scripts/dev-app.mjs, which the tests use to run the app's own code. */
declare module '*/dev-app.mjs' {
  /** Whether the .NET SDK is here to build the app with. */
  export function canBuildApp(): boolean;

  /** Run the app's `--dev <command> ...args`, built from this checkout, and parse each line it answers. */
  export function devApp(command: string, ...args: string[]): unknown[];

  /** Write `items` as JSON lines (strings as they are) to `file`, and return `file`. */
  export function writeList(file: string, items: readonly unknown[]): string;
}
