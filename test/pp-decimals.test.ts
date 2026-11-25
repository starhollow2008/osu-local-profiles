import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtPp, MAX_PP_DECIMALS, setPpDecimals } from '../web/js/format.js';

/*
 * Settings -> Appearance -> Decimal places on pp (issue #42): whole numbers as osu! shows them,
 * until asked for more, and never more than osu!'s own API gives.
 */
test('pp is a whole number unless asked for decimals', () => {
  setPpDecimals(0);
  assert.equal(fmtPp(379.4567), '379');
  setPpDecimals(2);
  assert.equal(fmtPp(379.4567), '379.46');
  setPpDecimals(3);
  assert.equal(fmtPp(1234.5), '1,234.500');
  setPpDecimals(0);
});

test('anything but a whole number from 0 to 3 is whole numbers', () => {
  assert.equal(MAX_PP_DECIMALS, 3);
  for (const bad of [4, -1, 1.5, '2', null, undefined, Number.NaN]) {
    setPpDecimals(2);
    setPpDecimals(bad);
    assert.equal(fmtPp(379.4567), '379', `for ${String(bad)}`);
  }
});
