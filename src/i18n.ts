/**
 * The languages this app is offered in, for the parts of it that are not the page.
 *
 * The list is osu!'s own -- osu-web's `available_locales` -- so a player finds their language
 * here under the code and the name they already know from osu.ppy.sh.
 *
 * It exists twice: here, and as `LOCALES` in `web/js/i18n.js`, which is the one the page
 * uses and the one that also carries each language's own name, its flag and its direction.
 * Duplicated rather than shared because the page has no build step and cannot import a `.ts`
 * file; `test/i18n.test.ts` pins the two lists together, so they cannot drift apart without
 * a test saying so.
 *
 * The server's only interest is validation: a language arriving from the page is written to
 * `config.json`, so it has to be one that exists before it is stored.
 */

export const DEFAULT_LOCALE = 'en';

export const LOCALE_CODES = [
  'en',
  'ar',
  'be',
  'bg',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'es-419',
  'fi',
  'fil',
  'fr',
  'he',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'pt-br',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
  'zh-tw',
] as const;

export type Locale = (typeof LOCALE_CODES)[number];

const KNOWN = new Set<string>(LOCALE_CODES);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * The language the page should start in, given what is stored.
 *
 * An empty string means "never chosen", which is not the same as English: the first launch
 * asks, and it can only ask if "not answered yet" is a state the config can hold.
 */
export function resolveLocale(stored: unknown): Locale {
  return isLocale(stored) ? stored : DEFAULT_LOCALE;
}
