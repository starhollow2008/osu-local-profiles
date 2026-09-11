# Matching osu!'s profile page

`docs/osu-web-reference.md` records the design *system* — tokens, palettes, metrics. This
file is the other half: **which osu-web file defines each visible region**, so a request to
make one part exact can be answered by reading the thing that defines it instead of
inferring it from a screenshot.

That inference loop is what this file exists to end. The chart colour, the hover readout
and the gold on the SS badge were each corrected in a separate later pass, and none of
them needed a design decision — they needed the file.

## The reference checkout

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/ppy/osu-web.git reference/osu-web
cd reference/osu-web
git sparse-checkout set resources/css resources/js/profile-page resources/js/components \
    resources/js/beatmapset-panel resources/js/utils resources/js/core/osu-audio resources/lang/en \
    resources/views/users public/images/badges public/images/flags database
```

6.5 MB instead of 158 MB, and `reference/` is gitignored.

**It is a reference, not a source of files.** osu-web is AGPL-3.0-or-later; this project is
MIT. Nothing is copied out of it: not a LESS rule, not an SVG path, not an image. What is
taken is *values* — colours, sizes, ratios, the order of things, the names in a tooltip —
which is why every table in `osu-web-reference.md` is a table of numbers rather than a
stylesheet. Keep it that way, and the licence question never arises.

Refresh it with `git -C reference/osu-web pull` before a fidelity pass, since osu-web moves.

## What can and cannot be taken

| | source | licence | usable here |
|---|---|---|---|
| colours, metrics, ratios, layout order | osu-web LESS/TSX | facts, not expression | **yes** |
| mod names, types, setting labels | osu-web `database/mods.json` | facts about the game | **yes**, via `scripts/build-mod-table.mjs` |
| country flags | [Twemoji](https://github.com/jdecked/twemoji) | CC-BY 4.0 | **yes**, vendored by `scripts/build-flags.mjs` |
| grade badges, mod glyphs, medal art | osu-web `public/images/` | AGPL-3.0 | **no** — redraw, or fall back |
| in-game textures, lazer's flags | `ppy/osu-resources` | **CC-BY-NC 4.0** | **no** — NonCommercial is incompatible with MIT *and* AGPL, and with taking donations |
| Torus, Venera | Monotype / Paulo Goode | commercial | **no** — used if the machine already has it, never shipped |

The osu-resources row is the one that catches people: lazer's own flag and mod textures
look like the obvious source and are the one source that cannot be used at all. Twemoji is
where osu! got the flags from in the first place (`osu-resources`' own `osu_flags.sh`
generates them from it), so going upstream gets the same artwork under a licence that
allows redistribution.

## Region map

| region | this project | osu-web |
|---|---|---|
| cover image | `#cover`, `.profile-info__bg` | `profile-page/cover.tsx`, `bem/profile-info.less` |
| avatar, name | `#avatar`, `#pname` | `bem/profile-info.less` |
| flag + country name | `#pflags`, `.flag-country` | `components/flag-country.tsx`, `bem/flag-country.less` |
| mode tabs | `#modes`, `.game-mode` | `bem/game-mode.less`, `bem/game-mode-link.less` |
| level bar and hexagon | `.profile-detail-bar__level` | `bem/profile-detail-bar.less`, `bem/user-level.less` |
| global rank, pp, ranked maps | `#globalRank`, `#totalPp` | `profile-page/detail-stats.tsx`, `bem/profile-detail-stats.less` |
| rank chart | `#ppChart` | `profile-page/rank-chart.tsx`, `bem/line-chart.less` |
| grade counts | `#gradeCounts`, `.profile-rank-count` | `bem/profile-rank-count.less`, `bem/score-rank.less` |
| grade badges | `gradeBadge()` in `web/js/badges.js` | `public/images/badges/score-ranks-v2019/GradeSmall-*.svg` |
| hit counts / stats box | `#profileStats`, `.profile-stats` | `bem/profile-stats.less` |
| section tabs | `#sectionTabs`, `.page-mode` | `bem/page-mode.less`, `bem/page-mode-link.less` |
| section panels | `.page-extra` | `bem/page-extra.less`, `bem/title.less` |
| score rows | `.play-detail` | `profile-page/play-detail.tsx`, `bem/play-detail.less` |
| mod badges | `modPill()` in `web/js/badges.js` | `components/mod.tsx`, `bem/mod.less`, `bem/mods.less` |
| most played | `.beatmap-playcount` | `profile-page/beatmap-playcount.tsx`, `bem/beatmap-playcount.less` |
| play history chart | `#playHistory` | `profile-page/chart.tsx`, `profile-page/historical.tsx` |
| medals | `.medals` | `profile-page/medals.tsx`, `bem/profile-badges.less` |

## Known deltas

What is deliberately not identical, and why. Anything not on this list that looks wrong is
a bug, not a decision.

- **Typeface, and it is the largest remaining difference.** osu! sets **Torus** for the page
  (`@font-default`) and **Venera** for the letter on a grade badge and the acronym on a mod
  (`@font-grade`). Both are commercial and neither can be shipped. `--font-default` and
  `--font-grade` name them first, so a machine that already has them uses them; every other
  machine falls through to Inter and the body font. Venera is a heavy display face, so those
  letterforms are lighter and narrower here than on osu! even though the sizes match
  (`0.4em` on a mod acronym, straight from `mod.less`). Sizes are osu!'s and should not be
  tuned upward to compensate — that trades a measured value for an eyeballed one.
- **Mod glyphs.** osu-web masks a per-mod SVG (`public/images/badges/mods/mod-*.svg`, 71 of
  them, AGPL) into the badge. `badges.js` draws the badge, the type colour, the darkened
  foreground, the extender tab and the cog exactly, and puts the **acronym** where the glyph
  would go — which is what osu! itself does for any mod it has no glyph for. The badge is
  right; the pictogram inside it is not there.
- **Grade badge facets.** The pill's colours, gradients and 32x16 geometry are osu!'s. The
  flat triangles that facet the background are drawn to match rather than traced.
- **Customised-mod cog** sits inside the badge instead of overhanging its top-right corner,
  because each badge is its own SVG and overhanging would make a customised mod a different
  size from its neighbours.
- **Country rank** is not shown at all — see `CLAUDE.md`. Not a fidelity gap; a deliberate
  refusal to fabricate a number.

## Generated from osu!

Regenerate after an osu-web change; both fail loudly rather than writing a partial file.

```sh
node scripts/build-mod-table.mjs   # web/js/mod-definitions.js  — 69 mods
node scripts/build-flags.mjs       # web/flags/<cc>.svg         — 258 flags
node scripts/build-medal-table.mjs # src/calc/medal-definitions.json
```

## Working on fidelity

1. Refresh the checkout.
2. Find the region in the map above and **read the LESS and the TSX**.
3. Take values, never files.
4. Record any new deviation under **Known deltas**, with the reason.
5. `npm run check`, then `npm run ui` — the browser check asserts computed style, which is
   where a fidelity change actually lands.
