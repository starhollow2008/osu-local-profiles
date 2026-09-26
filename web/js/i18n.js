/**
 * The page in the player's own language.
 *
 * Every language osu! itself offers, and nothing invented: the list is osu-web's
 * `available_locales`, so somebody who reads osu.ppy.sh in Polish finds Polish here under
 * the same name they are used to. Codes match osu!'s too (`pt-br`, `zh-tw`, `es-419`),
 * because a player who knows their code should not have to learn a second one.
 *
 * How it works, and why it is this shape:
 *
 * - **The English is in the HTML**, as ordinary text, and `data-i18n` names the key that
 *   replaces it. So the page reads correctly before any script runs, in a saved copy, and in
 *   a browser where the fetch failed -- the translation is an improvement on a page that
 *   already works, never the thing holding it up.
 * - **One file per language**, fetched once. `en` is never fetched at all: its strings are
 *   the ones already on the page.
 * - **A missing key falls back to English** rather than showing the key. A part-finished
 *   translation is then a page with some English in it, which is fine, instead of a page
 *   with `folders.rescan` written across a button, which is not.
 *
 * The choice is saved in `config.json` so the app starts in it, and mirrored to
 * `localStorage` so the *page* starts in it -- the config arrives with the first API
 * response, which is later than the first paint.
 */

import { assetUrl, snapshot } from './static-mode.js';

/**
 * Every language osu! is offered in.
 *
 * The whole list is here, including the ones not translated yet, because it is the plan as
 * much as it is the state: the codes, the names and the flags are settled, and adding a
 * language is then only a matter of writing its file and setting `done`.
 *
 * **`done` is what the picker shows.** A language with no file would fetch nothing, fall
 * back to English on every key, and leave somebody who picked their own language looking at
 * an English page wondering what went wrong -- so an untranslated one is simply not offered.
 * `LOCALES` keeps it, `availableLocales()` is what the menu iterates, and
 * `scripts/build-i18n.mjs` refuses a `done` that does not match the files on disk.
 *
 * `flag` is a country, which a language is not -- so the mapping is a convention, not a
 * fact, and the two-letter code beside it is what actually identifies the language. The
 * awkward ones are called out rather than pretended about: `ca` (Catalan) has no country of
 * its own and borrows Spain's, `es-419` is Latin America as a region and borrows Mexico's,
 * and `en` uses the UK's because the language is named after it.
 */
export const LOCALES = [
  { code: 'en', native: 'English', english: 'English', flag: 'gb', done: true },
  { code: 'ar', native: 'العربية', english: 'Arabic', flag: 'sa', dir: 'rtl' },
  { code: 'be', native: 'Беларуская', english: 'Belarusian', flag: 'by' },
  { code: 'bg', native: 'Български', english: 'Bulgarian', flag: 'bg' },
  { code: 'ca', native: 'Català', english: 'Catalan', flag: 'es' },
  { code: 'cs', native: 'Čeština', english: 'Czech', flag: 'cz' },
  { code: 'da', native: 'Dansk', english: 'Danish', flag: 'dk', done: true },
  { code: 'de', native: 'Deutsch', english: 'German', flag: 'de', done: true },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', flag: 'gr' },
  { code: 'es', native: 'Español', english: 'Spanish', flag: 'es', done: true },
  { code: 'es-419', native: 'Español (Latinoamérica)', english: 'Spanish (Latin America)', flag: 'mx' },
  { code: 'fi', native: 'Suomi', english: 'Finnish', flag: 'fi', done: true },
  { code: 'fil', native: 'Filipino', english: 'Filipino', flag: 'ph' },
  { code: 'fr', native: 'Français', english: 'French', flag: 'fr', done: true },
  { code: 'he', native: 'עברית', english: 'Hebrew', flag: 'il', dir: 'rtl' },
  { code: 'hu', native: 'Magyar', english: 'Hungarian', flag: 'hu' },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', flag: 'id' },
  { code: 'it', native: 'Italiano', english: 'Italian', flag: 'it', done: true },
  { code: 'ja', native: '日本語', english: 'Japanese', flag: 'jp', done: true },
  { code: 'ko', native: '한국어', english: 'Korean', flag: 'kr', done: true },
  { code: 'lt', native: 'Lietuvių', english: 'Lithuanian', flag: 'lt' },
  { code: 'lv', native: 'Latviešu', english: 'Latvian', flag: 'lv' },
  { code: 'ms', native: 'Bahasa Melayu', english: 'Malay', flag: 'my' },
  { code: 'nl', native: 'Nederlands', english: 'Dutch', flag: 'nl', done: true },
  { code: 'no', native: 'Norsk', english: 'Norwegian', flag: 'no' },
  { code: 'pl', native: 'Polski', english: 'Polish', flag: 'pl', done: true },
  { code: 'pt', native: 'Português', english: 'Portuguese', flag: 'pt' },
  { code: 'pt-br', native: 'Português (Brasil)', english: 'Portuguese (Brazil)', flag: 'br', done: true },
  { code: 'ro', native: 'Română', english: 'Romanian', flag: 'ro' },
  { code: 'ru', native: 'Русский', english: 'Russian', flag: 'ru', done: true },
  { code: 'sk', native: 'Slovenčina', english: 'Slovak', flag: 'sk' },
  { code: 'sl', native: 'Slovenščina', english: 'Slovenian', flag: 'si' },
  { code: 'sr', native: 'Српски', english: 'Serbian', flag: 'rs' },
  { code: 'sv', native: 'Svenska', english: 'Swedish', flag: 'se', done: true },
  { code: 'th', native: 'ไทย', english: 'Thai', flag: 'th' },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', flag: 'tr' },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', flag: 'ua' },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', flag: 'vn' },
  { code: 'zh', native: '简体中文', english: 'Chinese (Simplified)', flag: 'cn', done: true },
  { code: 'zh-tw', native: '繁體中文', english: 'Chinese (Traditional)', flag: 'tw', done: true },
];

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));

export const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'osu-local-profiles.locale';

/** The messages of the language in use. Empty for English, whose strings are in the HTML. */
let messages = {};
/** English, kept as the fallback for a key a translation has not reached yet. */
let fallback = {};
let active = DEFAULT_LOCALE;

/**
 * The languages that have a translation and can therefore be chosen.
 *
 * In `LOCALES` order, so English stays first and the rest keep the order osu! lists them in.
 */
export function availableLocales() {
  return LOCALES.filter((l) => l.done === true);
}

/** Whether `code` is a language this app *has a file for*, and so can actually be used. */
export function knownLocale(code) {
  return typeof code === 'string' && BY_CODE.get(code)?.done === true;
}

/** Whether `code` is one of osu!'s locales at all, translated here or not. */
export function listedLocale(code) {
  return typeof code === 'string' && BY_CODE.has(code);
}

export function localeInfo(code) {
  return BY_CODE.get(code) ?? BY_CODE.get(DEFAULT_LOCALE);
}

export function currentLocale() {
  return active;
}

/**
 * The best match for a language the browser asks for.
 *
 * `pt-BR` matches `pt-br` exactly; `pt-PT` has no entry and falls back to `pt`; `en-US`
 * falls back to `en`. Done here rather than by asking the user first, so the first launch
 * can *offer* the right language rather than making them find it.
 */
export function matchLocale(tags) {
  for (const raw of tags ?? []) {
    const tag = String(raw).toLowerCase();
    // Only a translated one: suggesting a language that would render in English is worse
    // than suggesting nothing, because the person picks it and then wonders why.
    if (knownLocale(tag)) return tag;
    const base = tag.split('-')[0];
    if (knownLocale(base)) return base;
  }
  return null;
}

/** What the page should start in, before the app has answered anything. */
export function storedLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (knownLocale(saved)) return saved;
  } catch {
    // A browser with site data blocked. The app's own config still arrives shortly.
  }
  return null;
}

/**
 * One string, by key, with `{name}` placeholders filled in.
 *
 * Falls back to English, and then to the key itself -- which only happens for a key that
 * exists in no file at all, i.e. a typo, and showing it is how that gets noticed.
 */
export function t(key, vars) {
  return formatMessage(messages[key] ?? fallback[key] ?? key, vars);
}

/**
 * Fill `{name}` placeholders in a string.
 *
 * Split out from `t` so it can be tested without a loaded language. A placeholder with no
 * value is left as it was written rather than becoming `undefined` -- a translator who
 * typed `{cnt}` where the code passes `count` then sees which word they got wrong.
 */
export function formatMessage(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/**
 * A string in the language in use only -- no English fallback -- or null when it has none.
 *
 * For a form only some languages need: a Polish "few" sentence has no English counterpart
 * worth showing, and falling back to it would put English in the middle of a Russian page.
 */
export function tOwn(key, vars) {
  const text = messages[key];
  return text === undefined ? null : formatMessage(text, vars);
}

/**
 * The sentence for a count, by the language's own plural rules.
 *
 * Exactly 1 is `one`, as it always was: some of those sentences are written for exactly one
 * ("One play brought in") and would be wrong for 21, which Russian calls "one" too. Otherwise
 * a count the language puts in its "few" form (Polish 2-4, 22-24 ...) uses `few`, when the
 * language has written one; everything else, and every language without one, uses `many`.
 * English has no "few", so for it this is exactly the old `n === 1 ? one : many`.
 *
 * Each form is a function, so only the chosen sentence is built -- and so each key is still
 * written out in full in a `t` or `tOwn` call at the call site, which is what the i18n check
 * can see.
 */
export function plural(n, one, few, many) {
  if (n === 1) return one();
  if (pluralRules().select(n) === 'few') {
    const text = few();
    if (text !== null) return text;
  }
  return many();
}

let rules = null;
function pluralRules() {
  if (rules?.resolvedOptions().locale.toLowerCase() !== active.toLowerCase()) {
    try {
      rules = new Intl.PluralRules(active);
    } catch {
      rules = new Intl.PluralRules(DEFAULT_LOCALE);
    }
  }
  return rules;
}

/** Whether a key has any translation at all, for a caller that wants to leave text alone. */
export function hasTranslation(key) {
  return key in messages || key in fallback;
}

/**
 * Put a language's strings in place.
 *
 * The seam between *how strings arrive* and *how they are used*. `useLocale` calls it after
 * fetching; a test calls it with `en.json` read off disk, which is how a module that builds
 * a sentence out of several keys can be checked without a browser -- with `code`, as that
 * language, which is what decides its plural forms (`plural`).
 */
export function installMessages(strings, english = strings, code = undefined) {
  messages = strings;
  fallback = english;
  if (code !== undefined) active = code;
}

async function fetchFile(code) {
  const r = await fetch(`/i18n/${code}.json`);
  if (!r.ok) throw new Error(`no translation for ${code}`);
  return r.json();
}

/**
 * Load a language and apply it to the page.
 *
 * English is always loaded, even when English is the language being used, because it is the
 * fallback *and* the source of every string the scripts build rather than the HTML. Without
 * it, `t('folders.rescan')` in English would have nowhere to look and would render its own
 * key across a button.
 *
 * Nothing here can fail in a way that leaves the page unreadable. A fetch that does not
 * arrive leaves the English that is already in the HTML, which is why it is left there.
 */
export async function useLocale(code, root = document) {
  // A copy is in the language it was saved in, whatever this browser last chose.
  const wanted = snapshot?.strings ? snapshot.locale : code;
  const target = knownLocale(wanted) ? wanted : DEFAULT_LOCALE;

  /*
   * A saved copy of the page carries one set of strings -- the language it was saved in --
   * and has no app to fetch another from. There is nothing to fall back to and nothing to
   * switch to, which is correct: a copy is a copy of what was on screen.
   */
  if (snapshot?.strings) {
    installMessages(snapshot.strings);
  } else {
    if (Object.keys(fallback).length === 0) {
      // englishFromPage is the last resort: the page's own text, keyed the same way, so a
      // missing or unserved en.json still leaves every key resolvable.
      fallback = await fetchFile(DEFAULT_LOCALE).catch(() => englishFromPage(root));
    }
    installMessages(
      target === DEFAULT_LOCALE ? fallback : await fetchFile(target).catch(() => ({})),
      fallback,
    );
  }
  active = target;

  try {
    localStorage.setItem(STORAGE_KEY, target);
  } catch {
    /* site data blocked: the app's config still remembers */
  }

  const info = localeInfo(target);
  root.documentElement.lang = target;
  root.documentElement.dir = info.dir ?? 'ltr';
  applyTranslations(root);
  return target;
}

/**
 * The English already written into the page, keyed the same way.
 *
 * The fallback of last resort, and the reason the English is left in the HTML in the first
 * place: whatever happens to the JSON files, the page can always recover the text it shipped
 * with.
 */
export function englishFromPage(root = document) {
  const out = {};
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!(el.dataset.i18n in out)) out[el.dataset.i18n] = el.textContent.trim();
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key && !(key in out)) out[key] = el.getAttribute(attr.trim()) ?? '';
    }
  }
  return out;
}

/**
 * Replace the text of everything the page has marked up.
 *
 * Three markers, because three things need translating and they are not the same job:
 *
 * - `data-i18n` -- the element's text. The common case by far.
 * - `data-i18n-attr="title:key;aria-label:other"` -- attributes, which are invisible until
 *   somebody hovers or uses a screen reader, and are exactly the text that gets forgotten.
 * - `data-i18n-html` -- text with markup inside it, `<b>` and `<a>` and the like. The value
 *   is trusted because it comes from this app's own files and nowhere else; nothing a user
 *   or a server types ever reaches it.
 */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const value = messages[el.dataset.i18n];
    if (value !== undefined) el.textContent = value;
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    const value = messages[el.dataset.i18nHtml];
    if (value !== undefined) el.innerHTML = value;
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s?.trim());
      if (!attr || !key) continue;
      const value = messages[key];
      if (value !== undefined) el.setAttribute(attr, value);
    }
  }
}

/**
 * The flag image for a language, for the picker and the button that opens it.
 *
 * Through `assetUrl` like every other served image, so a saved copy of the page carries its
 * flag with it rather than pointing at an app that is not running.
 */
export function localeFlagUrl(code) {
  return assetUrl(`/flags/${localeInfo(code).flag}.svg`);
}
