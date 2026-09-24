# Matching osu!'s profile page

`docs/osu-web-reference.md` records the design *system* - tokens, palettes, metrics. This
file is the other half: **which osu-web file defines each visible region**, so a request to
make one part exact can be answered by reading the thing that defines it instead of
inferring it from a screenshot.

That inference loop is what this file exists to end. The chart colour, the hover readout
and the gold on the SS badge were each corrected in a separate later pass, and none of
them needed a design decision - they needed the file.

## The reference checkout

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/ppy/osu-web.git reference/osu-web
cd reference/osu-web
git sparse-checkout set resources/css resources/js/profile-page resources/js/components \
    resources/js/beatmapset-panel resources/js/utils resources/js/core/osu-audio resources/lang/en \
    resources/js/scores-show resources/js/scores \
    resources/views/users public/images/badges public/images/flags public/images/layout \
    resources/images/scores database
```

About 7 MB instead of 158 MB, and `reference/` is gitignored.

**It is a reference, and a source.** This project is AGPL-3.0-or-later, the licence osu-web is
under, so osu-web's files can be used as they are (roadmap 5.57). There are two ways in, and
only two:

- **Artwork** goes through `npm run build:osu-web` (`scripts/build-osu-web-art.mjs`), which
  copies it unedited into `web/osu-web/` from one osu-web commit and writes
  `web/css/osu-web-art.css` to point the page's classes at it. Never copy an image by hand,
  and never edit one in place: add it to the script's lists.
- **Code** (a LESS rule, a TSX component's markup) is ported into this project's files, with
  a comment naming the osu-web file it came from. `.mod` in `profile.css` and `modPill()`
  in `badges.js` are the example.

Taking the file beats measuring it: measuring is how the mod glyphs stayed missing for so
long. Where a value is still reimplemented rather than ported, the tables in
`osu-web-reference.md` record where it came from.

Refresh it with `git -C reference/osu-web pull` before a fidelity pass, since osu-web moves.

## What can and cannot be taken

| | source | licence | usable here |
|---|---|---|---|
| LESS, TSX markup, colours, metrics | osu-web `resources/` | AGPL-3.0-or-later | **yes**, ported with its source named |
| mod glyphs and blanks, grade badges, stable's grade letters, guest avatar | osu-web `public/images/`, `resources/images/` | AGPL-3.0-or-later | **yes**, vendored by `scripts/build-osu-web-art.mjs` |
| mod names, types, setting labels | osu-web `database/mods.json` | facts about the game | **yes**, via `scripts/build-mod-table.mjs` |
| country flags | [Twemoji](https://github.com/jdecked/twemoji) | CC-BY 4.0 | **yes**, vendored by `scripts/build-flags.mjs` |
| medal art | `assets.ppy.sh`, not in the osu-web repository | not granted | loaded at runtime over a drawn placeholder, never shipped |
| osu! and ppy logos | osu-web `public/images/layout/` | **trademarks**, outside osu-web's grant | **no** |
| in-game textures, lazer's flags, lazer's mod icons | `ppy/osu-resources` | **CC-BY-NC 4.0** | **no** - NonCommercial is a further restriction, which the AGPL forbids |
| Torus, Venera | Monotype / Paulo Goode, via MyFonts | licensed to osu!'s website alone (`torus.less` says so) | **no** - used if the machine already has it, never shipped |

The osu-resources row is the one that catches people: lazer's own flag and mod textures
look like the obvious source and are the one source that cannot be used at all. osu-web's
copies of the mod glyphs are the usable ones. Twemoji is where osu! got the flags from in the
first place (`osu-resources`' own `osu_flags.sh` generates them from it), and the flags stay
on it: the same artwork, pinned to a version.

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
| grade badges | `gradeBadge()` in `web/js/badges.js`, `.score-rank--*` | `bem/score-rank.less`, `public/images/badges/score-ranks-v2019/GradeSmall-*.svg` |
| hit counts / stats box | `#profileStats`, `.profile-stats` | `bem/profile-stats.less` |
| section tabs | `#sectionTabs`, `.page-mode` | `bem/page-mode.less`, `bem/page-mode-link.less` |
| section panels | `.page-extra` | `bem/page-extra.less`, `bem/title.less` |
| score rows | `.play-detail` | `profile-page/play-detail.tsx`, `bem/play-detail.less` |
| mod badges | `modPill()` in `web/js/badges.js`, `.mod` in `profile.css` | `components/mod.tsx`, `bem/mod.less`, `bem/mods.less`, `public/images/badges/mods/` |
| a stable score's big letter | `legacyRank()` in `web/js/score-card.js` | `bem/legacy-rank.less`, `resources/images/scores/legacy-ranking-*.png` |
| avatar of a profile with no picture | `guestAvatar()` in `web/js/badges.js` | `bem/avatar.less` (`avatar--guest`), `public/images/layout/avatar-guest.png` |
| which score a row shows | `scoreColumn()` in `src/calc/eligibility.ts` | `utils/score-helper.ts` (`totalScore`: legacy, then classic, then standardised) |
| most played | `.beatmap-playcount` | `profile-page/beatmap-playcount.tsx`, `bem/beatmap-playcount.less` |
| play history chart | `#playHistory` | `profile-page/chart.tsx`, `profile-page/historical.tsx` |
| medals | `.medals` | `profile-page/medals.tsx`, `bem/profile-badges.less` |
| floating audio player | `#audioPlayer`, `.audio-player` | `core/osu-audio/main.ts`, `bem/audio-player.less`, `bem/audio-player-floating.less` |
| score row menu | `#playMenu` | `components/play-detail-menu.tsx` |
| score page | `web/score.html`, `web/js/score-page.js` | `scores-show/main.tsx`, `components/header-v4.tsx` |
| View Details card | `#scoreModal`, `web/js/score-card.js` | `scores-show/*.tsx`, `bem/score-{beatmap,info,tower,dial,player,buttons,stats}.less`, `bem/user-card.less`, `bem/legacy-rank.less`, `utils/score-helper.ts` |

## Two things that look wrong and are right

- **A stable play lists `CL`.** osu! adds Classic to every legacy score before scoring it, and
  osu-web shows it, so `withClassicMod` adds it when a row or card is built. It is not in
  `mods_json` and must not be: medals, play time and eligibility read what the player chose.
- **The score on a row changes with a switch.** Options -> Lazer scoring picks the scale, as
  osu!'s own profile page does; `score-helper.ts` above is the rule for which number each
  scale shows. Both are stored per score, so nothing recalculates.

## Known deltas

What is deliberately not identical, and why. Anything not on this list that looks wrong is
a bug, not a decision.

- **Typeface, and it is the largest remaining difference.** osu! sets **Torus** for the page
  (`@font-default`) and **Venera** for display letters (`@font-grade`). Both are licensed to
  osu!'s website alone and neither can be shipped, under any licence. `--font-default` and
  `--font-grade` name them first, so a machine that already has them uses them; every other
  machine falls through to Inter and the body font. Venera now shows in only two places: the
  grade in the middle of a lazer score's dial, and the acronym on a mod osu-web has no glyph
  for (none, as of roadmap 5.57). Grade badges, stable's letters and mod glyphs are osu-web's
  own pictures, so their letterforms are exact. Sizes are osu!'s and should not be tuned
  upward to compensate - that trades a measured value for an eyeballed one.
- **`.mod` takes its size from the row.** osu-web's `.mod` sets its own font-size from
  `--mod-height`; here the row around it does, as every caller already did. The badge
  measures the same.
- **View Details is a card first, and a page second.** osu! opens a score at
  `/scores/<id>`; here View Details is a dialog over the profile, so closing it leaves the
  page as it was, and the same card is also served on a page of its own at `/scores/<id>`
  (the card's Copy link). Neither has osu-web's site navigation; the page keeps only its
  HeaderV4 title, "performance". Both are re-hued to 200 (osu-web's `section_to_hue_map`
  puts scores under *beatmaps*), which is why the pop-up is blue on a pink page -- as the
  real one is.
- **The score card's Global Rank and "Watched" rows** are left out: both are facts about
  osu!'s leaderboards. The user card's online dot says whether the profile is tracking.
- **Country rank** is not shown at all - see `CLAUDE.md`. Not a fidelity gap; a deliberate
  refusal to fabricate a number.

## Generated from osu!

Regenerate after an osu-web change; both fail loudly rather than writing a partial file.

```sh
node scripts/build-osu-web-art.mjs # web/osu-web/, web/css/osu-web-art.css - 70 glyphs, grades, letters
node scripts/build-mod-table.mjs   # web/js/mod-definitions.js  - 69 mods
node scripts/build-flags.mjs       # web/flags/<cc>.svg         - 258 flags
node scripts/build-medal-table.mjs # src/calc/medal-definitions.json
```

## Working on fidelity

1. Refresh the checkout.
2. Find the region in the map above and **read the LESS and the TSX**.
3. Take the file: artwork through `build-osu-web-art.mjs`, code ported with its source named.
4. Record any new deviation under **Known deltas**, with the reason.
5. `npm run check`, then `npm run ui` - the browser check asserts computed style, which is
   where a fidelity change actually lands.
