/**
 * Types for the i18n consistency check that `test/i18n.test.ts` runs.
 *
 * `scripts/` is plain JavaScript and outside `tsconfig.json`'s `include`, which is right:
 * build tooling should not need a typecheck to run. The shape the tests depend on is
 * declared here so the import is not `any` under `strict`.
 */
declare module '*/build-i18n.mjs' {
  /** What a browser's `textContent` would read, given this HTML source. */
  export function decodeEntities(source: string): string;

  /** Every translated string the HTML declares, keyed as `web/js/i18n.js` looks it up. */
  export function stringsFromHtml(source: string): Map<string, string>;

  /** Every literal `t('key')` a script asks for. A key built at runtime is not collected. */
  export function keysFromJs(source: string): string[];

  /** The locale list out of `web/js/i18n.js`, as `[code, done]` pairs. */
  export function localesFromJs(source?: string): [string, boolean][];

  /** Everything that disagrees between the page, the scripts and the locale files. */
  export function check(): string[];
}
