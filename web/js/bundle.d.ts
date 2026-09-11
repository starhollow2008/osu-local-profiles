/** Types for web/js/bundle.js, which the tests exercise. */

/** The module at `entry` and everything it imports, as one script. */
export function bundleModules(
  entry: string,
  load: (path: string) => string | Promise<string>,
): Promise<string>;
