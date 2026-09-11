/**
 * Rebuild `src/calc/medal-definitions.json` from osu!'s own achievement list.
 *
 *   node scripts/build-medal-table.mjs [username-or-id]
 *
 * osu! publishes every medal's name, description and icon in the payload it renders a
 * profile page from -- the same `data-initial-data` attribute `src/clients/osu-web.ts`
 * reads. Taking the definitions from there rather than typing them out is the difference
 * between medals that say what osu! says and medals that say what someone remembered.
 *
 * Only the "Skill & Dedication" group is kept, and only the families this app can actually
 * decide from local scores. Notably, what exists is **not the same in every mode**:
 *
 * - Combo and play-count medals exist for osu!standard only.
 * - The other three modes have hit-count medals in their place.
 * - Star pass/FC medals run 1..10 for osu!standard and 1..8 elsewhere.
 *
 * The thresholds are parsed out of osu!'s own slugs (`osu-combo-500`, `taiko-hits-30000`,
 * `mania-skill-fc-8`), so they cannot drift from the names beside them.
 *
 * One request, run by hand, exactly like `npm run rank:refresh`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src', 'calc', 'medal-definitions.json');

/** Any public profile carries the whole medal list; whose it is does not matter. */
const who = process.argv[2] ?? 'peppy';

/** osu!'s `ordering` within the Skill & Dedication group, which is how it groups families. */
const FAMILY_ORDERING = { combo: 0, plays: 1, hits: 3, pass: 4, fc: 5 };

/** osu!'s mode names, in ruleset id order. `fruits` is what the API calls osu!catch. */
const MODES = ['osu', 'taiko', 'fruits', 'mania'];

/** The four rank medals, which belong to no single mode. Ordered easiest to hardest. */
const RANK_MEDALS = [
  ['I Can See The Top', 50_000],
  ['The Gradual Rise', 10_000],
  ['Scaling Up', 5_000],
  ['Approaching The Summit', 1_000],
];

const response = await fetch(`https://osu.ppy.sh/users/${encodeURIComponent(who)}`, {
  headers: { accept: 'text/html', 'user-agent': 'osu-local-profiles medal table builder' },
});
if (!response.ok) throw new Error(`osu.ppy.sh answered ${response.status}`);

const match = /data-initial-data="([^"]*)"/.exec(await response.text());
if (!match) throw new Error('the profile page was not in the expected shape');

const payload = JSON.parse(
  match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&'),
);

const skill = payload.achievements.filter((a) => a.grouping === 'Skill & Dedication');
console.log(`${payload.achievements.length} medals, ${skill.length} of them Skill & Dedication`);

/** The number at the end of a slug: the combo, the play count, or the star level. */
const thresholdOf = (slug) => Number(/(\d+)$/.exec(slug)?.[1] ?? 0);

const describe = (a, threshold) => ({
  slug: a.slug,
  name: a.name,
  description: a.description,
  icon: a.icon_url,
  threshold,
});

const table = {
  builtAt: new Date().toISOString().slice(0, 10),
  source: 'osu.ppy.sh profile page achievements payload',
  rank: RANK_MEDALS.map(([name, threshold]) => {
    const medal = skill.find((a) => a.name === name);
    if (!medal) throw new Error(`osu! no longer has a medal called "${name}"`);
    return describe(medal, threshold);
  }),
  modes: {},
};

for (const [id, mode] of MODES.entries()) {
  const family = {};
  for (const [name, ordering] of Object.entries(FAMILY_ORDERING)) {
    const items = skill
      .filter((a) => a.mode === mode && a.ordering === ordering)
      .map((a) => describe(a, thresholdOf(a.slug)))
      .sort((a, b) => a.threshold - b.threshold);
    // Families a mode simply does not have are left out rather than stored empty.
    if (items.length > 0) family[name] = items;
  }
  table.modes[id] = family;
  console.log(
    `  mode ${id} (${mode}): ` +
      Object.entries(family).map(([k, v]) => `${k} x${v.length}`).join(', '),
  );
}

fs.writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
console.log(`\nwrote ${path.relative(root, out)}`);
