import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modDefinition, modList, modPill } from '../web/js/badges.js';
import { TORII_DEFINITIONS } from '../web/js/torii-mods.js';

/* Torii's and Ritsu's own mods on the badges every list draws (dotnet/App/Clients/Torii.cs). */

test('a Torii or Ritsu mod is named and coloured by its own type', () => {
  const pill = modPill({ acronym: 'SA', settings: { object_spacing: 1.5 } });
  assert.match(pill, /class="mod mod--type-Conversion"/);
  assert.match(pill, /title="Spacing Adjust \(Object spacing: 1\.5\)"/);
  assert.match(pill, /mod__customised-indicator/);
  assert.equal(modDefinition('PA')?.modes.length, 4);
  for (const acronym of Object.keys(TORII_DEFINITIONS)) assert.ok(acronym.length <= 4, acronym);
});

test("MC is McOsu's on a play osu! scores as stable, and Ritsu's Miss Challenge on a lazer play", () => {
  const mcosu = { acronym: 'MC', settings: { nightmare: true } };
  assert.match(modPill(mcosu), /title="McOsu \(Nightmare\)"/);
  assert.match(modList([mcosu], 'mcosu'), /title="McOsu \(Nightmare\)"/);
  assert.doesNotMatch(modList([mcosu], 'mcosu'), /mod__customised-indicator/);

  const ritsu = modList([{ acronym: 'MC', settings: { max_misses: 3 } }], 'lazer');
  assert.match(ritsu, /class="mod mod--type-DifficultyIncrease"/);
  assert.match(ritsu, /title="Miss Challenge \(Max misses: 3\)"/);
  assert.match(ritsu, /mod__customised-indicator/);
});
