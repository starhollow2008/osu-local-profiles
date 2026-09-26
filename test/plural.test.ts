import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installMessages, plural, t, tOwn } from '../web/js/i18n.js';

/*
 * A count's sentence by the language's own plural rules. Polish puts 2-4 (and 22-24 ...) in a
 * form of their own -- "2 podejścia", not "2 podejść" -- which a one/many pair cannot say.
 */

const read = (code: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(`web/i18n/${code}.json`, 'utf8')) as Record<string, string>;

const done = (n: number) =>
  plural(
    n,
    () => t('recompute.doneOne', { n }),
    () => tOwn('recompute.doneFew', { n }),
    () => t('recompute.doneMany', { n }),
  );

test('Polish uses its own form for 2-4 and 22-24, and the many form around them', () => {
  installMessages(read('pl'), read('en'), 'pl');
  assert.equal(done(1), 'Przeliczono 1 podejście');
  assert.equal(done(2), 'Przeliczono 2 podejścia');
  assert.equal(done(4), 'Przeliczono 4 podejścia');
  assert.equal(done(5), 'Przeliczono 5 podejść');
  assert.equal(done(12), 'Przeliczono 12 podejść', '12-14 are not "few" in Polish');
  assert.equal(done(22), 'Przeliczono 22 podejścia');
});

test('English is exactly the old one-or-many', () => {
  const en = read('en');
  installMessages(en, en, 'en');
  assert.deepEqual([done(1), done(2), done(5)], ['Recalculated 1 play', 'Recalculated 2 plays', 'Recalculated 5 plays']);
});

/*
 * Russian has a "few" form too, but its translation has no few sentences: its many sentences
 * are written to read right for any count. It must get those, never the English few string.
 */
test('a language with a few form but no few sentence falls back to its own many, not to English', () => {
  const ru = read('ru');
  installMessages(ru, read('en'), 'ru');
  assert.equal(done(3), formatMessageLike(ru['recompute.doneMany']!, 3));
  // And exactly one is still the one sentence, even though Russian calls 21 "one" as well.
  assert.equal(done(21), formatMessageLike(ru['recompute.doneMany']!, 21));
});

const formatMessageLike = (text: string, n: number) => text.replace('{n}', String(n));
