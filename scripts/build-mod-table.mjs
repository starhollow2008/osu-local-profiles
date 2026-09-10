/**
 * Generate `web/js/mod-definitions.js` — every mod's name, type and setting labels.
 *
 * Same reasoning as `scripts/build-medal-table.mjs`: take the facts from osu! rather than
 * writing them out by hand. The table this replaces was a hand-kept acronym -> type
 * mapping that its own comment called "rough", and the type is what picks a mod's colour,
 * so a wrong entry is a visibly wrong badge.
 *
 * The source is osu-web's `database/mods.json`, which osu-web itself generates from the
 * game's mod definitions. Only the acronym, display name, type and setting labels are
 * kept -- facts about osu!, the same class of thing as the colour tables in
 * docs/osu-web-reference.md. Descriptions and per-ruleset duplicates are dropped.
 *
 * Run: node scripts/build-mod-table.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/ppy/osu-web/master/database/mods.json';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'web', 'js', 'mod-definitions.js');

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`could not download ${SOURCE}: HTTP ${response.status}`);
  process.exit(1);
}
const rulesets = await response.json();

/*
 * osu!standard is read first so that, if a mod's type ever differs between rulesets, the
 * standard one wins rather than whichever happened to be last. A conflict is reported
 * rather than silently resolved -- the same acronym in two colours would be a real find.
 */
const order = ['osu', 'taiko', 'fruits', 'mania'];
const sorted = [...rulesets].sort((a, b) => order.indexOf(a.Name) - order.indexOf(b.Name));

const mods = {};
for (const ruleset of sorted) {
  for (const mod of ruleset.Mods) {
    const settings = {};
    for (const setting of mod.Settings ?? []) {
      if (typeof setting.Label === 'string' && setting.Label !== '') {
        settings[setting.Name] = setting.Label;
      }
    }

    const existing = mods[mod.Acronym];
    if (existing !== undefined) {
      if (existing.type !== mod.Type) {
        console.warn(
          `${mod.Acronym} is ${existing.type} in one ruleset and ${mod.Type} in ${ruleset.Name}; keeping ${existing.type}`,
        );
      }
      // A later ruleset can still contribute setting labels the first one did not have.
      Object.assign(existing.settings, { ...settings, ...existing.settings });
      continue;
    }

    mods[mod.Acronym] = { name: mod.Name, type: mod.Type, settings };
  }
}

const TYPES = new Set([
  'DifficultyReduction',
  'DifficultyIncrease',
  'Conversion',
  'Automation',
  'Fun',
  'System',
]);

const count = Object.keys(mods).length;
const unknownTypes = [...new Set(Object.values(mods).map((m) => m.type))].filter((t) => !TYPES.has(t));

/*
 * A generated table that comes back empty or reshaped must fail loudly rather than
 * overwrite a good file with a useless one -- a wrong table is still valid JavaScript.
 */
if (count < 50) {
  console.error(`only ${count} mods found; expected ~69. Source layout probably changed.`);
  process.exit(1);
}
if (unknownTypes.length > 0) {
  console.error(`unrecognised mod types: ${unknownTypes.join(', ')}`);
  console.error('badges.js has no colour for these; add them there before regenerating.');
  process.exit(1);
}

const entries = Object.keys(mods)
  .sort()
  .map((acronym) => `  ${JSON.stringify(acronym)}: ${JSON.stringify(mods[acronym])},`)
  .join('\n');

const body = `/**
 * Mod names, types and setting labels. GENERATED -- do not edit.
 *
 * Rebuild with \`node scripts/build-mod-table.mjs\`. Source: ${SOURCE}
 *
 * \`type\` is what gives a mod its colour (ppy/osu's OsuColour.ForModType), so this file
 * is the reason a badge is the right one rather than a guess.
 */
export const MOD_DEFINITIONS = {
${entries}
};
`;

fs.writeFileSync(outFile, body);
console.log(`${count} mods -> web/js/mod-definitions.js (${(body.length / 1024).toFixed(1)} KB)`);
