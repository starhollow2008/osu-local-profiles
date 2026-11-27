import './english.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inModOrder, modDefinition, modList, modPill } from '../web/js/badges.js';
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

/* Mods to choose from in osu-web's order, which is osu!'s (issue #50). */

test("mods to choose from follow osu-web's order, each ruleset's own, and not the alphabet", () => {
  // The issue's own example, osu!'s first rows: reduction, then increase.
  assert.deepEqual(inModOrder(['HR', 'DC', 'NF', 'EZ', 'HT', 'SD', 'PF'], 0), ['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF']);
  assert.deepEqual(inModOrder(['SG', 'AL', 'MR', 'RD', 'CL', 'DA', 'TP'], 0), ['TP', 'DA', 'CL', 'RD', 'MR', 'AL', 'SG']);
  // The rulesets do not all agree, and each is drawn in its own: taiko has Random before Difficulty Adjust.
  assert.deepEqual(inModOrder(['DA', 'RD'], 0), ['DA', 'RD']);
  assert.deepEqual(inModOrder(['DA', 'RD'], 1), ['RD', 'DA']);
  // A mania key mod in its place among the conversions, 1K to 10K in order.
  assert.deepEqual(inModOrder(['10K', '2K', '1K', 'HO'], 3), ['HO', '1K', '2K', '10K']);
  // With no ruleset, one order for all four; a mod only another client has comes after osu!'s, as given.
  assert.deepEqual(inModOrder(['TD', 'NEO', 'MC', 'EZ', 'NR']), ['EZ', 'NR', 'TD', 'NEO', 'MC']);
  // Nothing is lost or repeated.
  const every = Object.keys(TORII_DEFINITIONS).concat(['EZ', 'HD', 'DT']);
  assert.deepEqual([...inModOrder(every)].sort(), [...every].sort());
});
