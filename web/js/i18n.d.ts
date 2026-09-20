/** Types for web/js/i18n.js, which the tests exercise. */

export interface LocaleInfo {
  /** osu!'s own locale code: `de`, `pt-br`, `zh-tw`. */
  code: string;
  /** The language's name in that language, which is what the picker shows. */
  native: string;
  /** Its English name, as a search aid only. */
  english: string;
  /** A two-letter country whose flag stands in for the language. A convention, not a fact. */
  flag: string;
  /** Only for the two languages that are written right to left. */
  dir?: 'rtl';
}

export const LOCALES: LocaleInfo[];
export const DEFAULT_LOCALE: string;

export function knownLocale(code: unknown): boolean;
export function localeInfo(code: string): LocaleInfo;
export function currentLocale(): string;
export function matchLocale(tags: readonly string[] | undefined): string | null;
export function storedLocale(): string | null;
export function t(key: string, vars?: Record<string, unknown>): string;
export function formatMessage(text: string, vars?: Record<string, unknown>): string;
export function hasTranslation(key: string): boolean;
export function installMessages(
  active: Record<string, string>,
  english?: Record<string, string>,
): void;
export function useLocale(code: string, root?: Document): Promise<string>;
export function englishFromPage(root?: Document): Record<string, string>;
export function applyTranslations(root?: Document): void;
export function localeFlagUrl(code: string): string;
