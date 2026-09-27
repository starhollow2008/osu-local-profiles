import fs from 'node:fs';
import path from 'node:path';
import { installDir } from '../config.ts';
import { DEFAULT_LOCALE, isLocale } from '../i18n.ts';

/**
 * The words an export is written in: the page's own translations (`web/i18n/<locale>.json`),
 * read here so a spreadsheet's headers are in the language the page was in when it was saved.
 *
 * Only literal keys, as on the page: scripts/build-i18n.mjs reads src/export/ for the
 * keys it asks for, so a key that does not exist in en.json fails the check rather than turning
 * up as a raw key in somebody's spreadsheet. A key a translation lacks falls back to English,
 * exactly as the page does.
 */

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

const cache = new Map<string, Record<string, string>>();

function load(dir: string, locale: string): Record<string, string> {
  const file = path.join(dir, `${locale}.json`);
  const hit = cache.get(file);
  if (hit) return hit;
  let strings: Record<string, string> = {};
  try {
    strings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    /* no such language here: English stands in, as on the page */
  }
  cache.set(file, strings);
  return strings;
}

/** Words in `locale`, or in English for anything it does not have or a locale this app lacks. */
export function translator(locale: string = DEFAULT_LOCALE, dir = path.join(installDir(), 'web', 'i18n')): Translate {
  const own = isLocale(locale) ? load(dir, locale) : {};
  const en = load(dir, DEFAULT_LOCALE);
  return (key, vars) => {
    let text = own[key] ?? en[key] ?? key;
    for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}
