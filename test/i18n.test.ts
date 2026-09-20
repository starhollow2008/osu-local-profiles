import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, formatMessage, matchLocale } from '../web/js/i18n.js';
import { DEFAULT_LOCALE, LOCALE_CODES, isLocale, resolveLocale } from '../src/i18n.ts';
import { check, keysFromJs, stringsFromHtml } from '../scripts/build-i18n.mjs';

/*
 * The page in every language osu! is offered in.
 *
 * Most of what can go wrong here is silent: a key renamed in one place, a locale file that
 * no longer matches the page, a flag that does not exist. None of it throws, and all of it
 * shows as English text -- or as a raw key -- on somebody else's screen, in a language
 * nobody here reads. So it is pinned.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(root, 'web', 'i18n');

const localeFile = (code: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(i18nDir, `${code}.json`), 'utf8')) as Record<string, string>;

const english = localeFile('en');

/* ------------------------------------------------------------- the list */

/**
 * The list exists twice -- `src/i18n.ts` for the server's validation, `web/js/i18n.js` for
 * the page -- because the page has no build step and cannot import a `.ts` file. This is
 * what stops them drifting.
 */
test('the server and the page offer exactly the same languages, in the same order', () => {
  assert.deepEqual(
    LOCALES.map((l) => l.code),
    [...LOCALE_CODES],
  );
});

test('every language has a name of its own, an English name and a flag that exists', () => {
  for (const locale of LOCALES) {
    assert.ok(locale.native.length > 0, `${locale.code} has no native name`);
    assert.ok(locale.english.length > 0, `${locale.code} has no English name`);
    assert.ok(
      fs.existsSync(path.join(root, 'web', 'flags', `${locale.flag}.svg`)),
      `${locale.code} points at a flag this app does not ship: ${locale.flag}.svg`,
    );
  }
});

test('the two right-to-left languages say so, and nothing else does', () => {
  const rtl = LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code);
  assert.deepEqual(rtl, ['ar', 'he']);
});

test('a language code is checked against the list before it is stored', () => {
  assert.equal(isLocale('pt-br'), true);
  assert.equal(isLocale('PT-BR'), false, 'osu!’s codes are lower case');
  assert.equal(isLocale('xx'), false);
  assert.equal(isLocale(''), false);
  assert.equal(isLocale(null), false);
  // Empty means "never chosen", which resolves to English without becoming it in config.
  assert.equal(resolveLocale(''), DEFAULT_LOCALE);
  assert.equal(resolveLocale('de'), 'de');
});

test('a browser’s language is matched exactly, then by its base', () => {
  assert.equal(matchLocale(['pt-BR', 'en']), 'pt-br');
  assert.equal(matchLocale(['pt-PT']), 'pt', 'no pt-PT, so the language without the region');
  assert.equal(matchLocale(['en-US']), 'en');
  assert.equal(matchLocale(['zh-TW', 'zh']), 'zh-tw');
  assert.equal(matchLocale(['kl-GL']), null, 'Greenlandic is not offered, and saying so is right');
  assert.equal(matchLocale(undefined), null);
});

/* --------------------------------------------------------------- strings */

test('a placeholder is filled, and one the code does not pass is left to be seen', () => {
  assert.equal(formatMessage('{count} folders', { count: 3 }), '3 folders');
  assert.equal(formatMessage('{a} and {b}', { a: 'x', b: 'y' }), 'x and y');
  // A translator who typed the wrong name sees the name, not "undefined".
  assert.equal(formatMessage('{cnt} folders', { count: 3 }), '{cnt} folders');
  assert.equal(formatMessage('no placeholders', { count: 3 }), 'no placeholders');
});

/**
 * The page carries the English too, so it reads correctly before any script runs. That only
 * holds while the two say the same thing.
 */
test('en.json and the page agree, and nothing asks for a key that does not exist', () => {
  assert.deepEqual(check(), []);
});

test('the markers are read the way the page reads them', () => {
  const found = stringsFromHtml(
    '<h3 id="t" data-i18n="a.title">Hello &amp; welcome</h3>' +
      '<p data-i18n-html="a.body">Press <b>Skip</b></p>' +
      '<button title="Quit it" data-i18n-attr="title:a.quit">x</button>',
  );
  // data-i18n becomes textContent, so entities are resolved...
  assert.equal(found.get('a.title'), 'Hello & welcome');
  // ...and data-i18n-html becomes innerHTML, where the markup is the point.
  assert.equal(found.get('a.body'), 'Press <b>Skip</b>');
  assert.equal(found.get('a.quit'), 'Quit it');
});

test('only a literal key is collected, because only a literal one can be checked', () => {
  assert.deepEqual(keysFromJs("t('folders.rescan'); t('lang.change', { n: 1 });"), [
    'folders.rescan',
    'lang.change',
  ]);
  // A key built at runtime would pass this check and fail on somebody's screen, so the page
  // does not build any -- and this is the line that would notice if it started.
  assert.deepEqual(keysFromJs('t(key); t(`a.${b}`);'), []);
});

/* ---------------------------------------------------------- translations */

/**
 * The app has one name (CLAUDE.md, roadmap 5.18). A translation may translate the sentence
 * around it, never the name itself -- and never reintroduce the one that was scrubbed.
 */
test('every language keeps the app’s own name', () => {
  for (const code of LOCALE_CODES) {
    const file = path.join(i18nDir, `${code}.json`);
    if (!fs.existsSync(file)) continue;
    const strings = localeFile(code);
    for (const key of ['welcomeTitle', 'quitBtn.title']) {
      if (!(key in strings)) continue;
      assert.match(
        strings[key]!,
        /osu! local profiles/,
        `${code}.json translated the app's name in "${key}"`,
      );
    }
  }
});

/**
 * A translation may be incomplete -- a missing key falls back to English, which is the whole
 * design. What it may not do is be *empty*, which renders as a blank label rather than as
 * readable English.
 */
test('no translation holds an empty string where English has text', () => {
  for (const file of fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json'))) {
    const strings = localeFile(path.basename(file, '.json'));
    for (const [key, value] of Object.entries(strings)) {
      assert.equal(typeof value, 'string', `${file}: "${key}" is not a string`);
      if (english[key]) {
        assert.notEqual(value.trim(), '', `${file}: "${key}" is empty, so it would render blank`);
      }
    }
  }
});

/**
 * A translated string may only carry the placeholders its English does. An invented one
 * renders as literal braces; a dropped one loses the number it was meant to show.
 */
test('a translation carries the same placeholders as its English', () => {
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  for (const file of fs.readdirSync(i18nDir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    const strings = localeFile(path.basename(file, '.json'));
    for (const [key, value] of Object.entries(strings)) {
      const source = english[key];
      if (source === undefined) continue; // `check()` reports an unknown key already
      assert.deepEqual(
        placeholders(value),
        placeholders(source),
        `${file}: "${key}" does not use the same placeholders as English`,
      );
    }
  }
});

test('every language the picker offers is one the app can actually serve', () => {
  for (const locale of LOCALES) {
    if (locale.code === DEFAULT_LOCALE) continue;
    const file = path.join(i18nDir, `${locale.code}.json`);
    // Not having a file is allowed -- it falls back to English. Having one that is not JSON
    // is not: the page would fetch it, fail to parse it, and silently show English forever.
    if (!fs.existsSync(file)) continue;
    assert.doesNotThrow(() => localeFile(locale.code), `${locale.code}.json is not valid JSON`);
  }
});
