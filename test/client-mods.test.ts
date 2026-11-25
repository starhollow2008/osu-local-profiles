import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_MODS, OTHER_CLIENT_MODS, shownClientMods } from '../web/js/client-mods.js';

/*
 * Mods only another client has are offered only for a client the app found, unless Other
 * settings shows them all (web/js/client-mods.js).
 */

test("a client's own mods are shown only once it is found, or when all are asked for", () => {
  assert.deepEqual([...shownClientMods()], []);
  assert.deepEqual([...shownClientMods({ clients: ['mcosu'] })], ['MC']);
  assert.deepEqual([...shownClientMods({ clients: ['neomod'] })], ['NEO']);
  assert.deepEqual([...shownClientMods({ clients: ['torii'] })].sort(), ['HS', 'PA']);
  // Ritsu is built on Torii: its mods include Torii's two, and its Miss Challenge is MC.
  const ritsu = shownClientMods({ clients: ['ritsu'] });
  assert.ok(['HS', 'PA', 'MC', 'RDV2', 'SA'].every((a) => ritsu.has(a)));
  assert.equal(ritsu.has('NEO'), false);
  // An unknown client offers nothing.
  assert.deepEqual([...shownClientMods({ clients: ['stable', 'lazer', 'neki'] })], []);

  assert.deepEqual(shownClientMods({ all: true }), OTHER_CLIENT_MODS);
  assert.equal(OTHER_CLIENT_MODS.size, 18);
});

test('a mod the saved filter names is shown either way', () => {
  assert.deepEqual([...shownClientMods({ named: ['RDV2', 'HD', 'DT'] })], ['RDV2']);
  for (const mods of Object.values(CLIENT_MODS)) assert.ok(mods.length > 0);
});
