import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand } from '../src/browser.ts';

/*
 * The Windows command was broken from the first release until 1.6.0: Node's argument quoting
 * turned the `""` title into `"\"\""`, which `cmd` does not unescape, so `start` never
 * opened the page. These pin what `cmd` is actually handed.
 */

test('Windows hands cmd a verbatim start line with an empty title', () => {
  const c = browserCommand('win32', 'http://localhost:7272');
  assert.equal(c.command, 'cmd');
  assert.equal(c.args.join(' '), '/c start "" http://localhost:7272');
  assert.equal(c.options.windowsVerbatimArguments, true);
});

test('characters cmd would act on are escaped', () => {
  const c = browserCommand('win32', 'http://localhost:7272/?a=1&b=2');
  assert.equal(c.args.at(-1), 'http://localhost:7272/?a=1^&b=2');
});

test('macOS and Linux use their own openers, with the URL as a plain argument', () => {
  assert.deepEqual(
    [browserCommand('darwin', 'http://x').command, browserCommand('darwin', 'http://x').args],
    ['open', ['http://x']],
  );
  assert.deepEqual(
    [browserCommand('linux', 'http://x').command, browserCommand('linux', 'http://x').args],
    ['xdg-open', ['http://x']],
  );
});
