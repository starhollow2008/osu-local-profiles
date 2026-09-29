# Matching osu!'s profile page

Which osu-web file defines each part of the page, what may be taken from it, and where this page
still differs on purpose. When something needs to look more like osu!, read the file that defines
it instead of working from a screenshot. Guessing from screenshots is why the chart colour, the
hover readout and the gold on the SS badge each took a separate fix.

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

About 7MB instead of 158MB, and `reference/` is gitignored. Run `git -C reference/osu-web pull`
before a fidelity pass, since osu-web moves.

This project is AGPL-3.0-or-later, like osu-web, so osu-web's files can be used as they are
(roadmap 5.57), in two ways only:

- **Artwork** goes through `npm run build:osu-web` (`scripts/build-osu-web-art.mjs`), which copies
  it unedited into `web/osu-web/` from one osu-web commit and writes `web/css/osu-web-art.css`.
  Never copy an image by hand or edit one in place; add it to the script's lists.
- **Code** (a LESS rule, a TSX component's markup) is ported into this project's files with a
  comment naming the osu-web file it came from. `.mod` in `profile.css` and `modPill()` in
  `badges.js` are the example.

Porting the file beats measuring it.

## What can and cannot be taken

| | source | licence | usable here |
|---|---|---|---|
| LESS, TSX markup, colours, metrics | osu-web `resources/` | AGPL-3.0-or-later | **yes**, ported with its source named |
| mod glyphs and blanks, grade badges, stable's grade letters, guest avatar, default banner | osu-web `public/images/`, `resources/images/` | AGPL-3.0-or-later | **yes**, vendored by `build-osu-web-art.mjs` |
| ruleset icons (the mode switcher) | osu-web `resources/fonts/extra/` (its own icon font) | AGPL-3.0-or-later | **yes**, the four mode glyphs only, each written out as an SVG; never the font, which also holds the osu! logo |
| mod names, types, setting labels | osu-web `database/mods.json` | facts about the game | **yes**, via `scripts/build-mod-table.mjs` |
| country flags | [Twemoji](https://github.com/jdecked/twemoji) | CC-BY 4.0 | **yes**, vendored by `scripts/build-flags.mjs` |
| medal art | `assets.ppy.sh`, not in the osu-web repo | not granted | loaded at runtime over a drawn placeholder, never shipped |
| osu! and ppy logos | osu-web `public/images/layout/` | trademarks, outside osu-web's grant | **no** |
| in-game textures, lazer's flags and mod icons | `ppy/osu-resources` | CC-BY-NC 4.0 | **no**: NonCommercial is a further restriction, which the AGPL forbids |
| Torus, Venera | via MyFonts | licensed to osu!'s website alone | **no**: used if the machine already has them, never shipped |

osu-resources is the one that catches people: lazer's own flags and mod textures look like the
obvious source and are the one source that can't be used at all. osu-web's copies of the mod glyphs
are the usable ones. osu! generates its flags from Twemoji too (osu-resources' `osu_flags.sh`), so
the flags here are the same artwork.

## Design tokens

osu-web builds its whole palette from one hue. `--base-hue` sits on `body` (osu!'s pink is 333;
score pages use 200), and each token is an HSL fragment, used as `hsl(var(--hsl-b3))` or with an
alpha as `hsla(var(--hsl-b6), 0.5)`. The values are in `web/css/tokens.css`, taken from osu-web's
`colors.less`, `variables.less` and `bootstrap-variables.less`.

**The profile page is built on the `b*` family, not `d*`.** The first version of the page used
`d*`, which is why it looked too saturated. By depth:

- page background and separators: `b6`
- section panels (`.page-extra`) and the `.profile-stats` box: `b4`
- header, stats cards, score row body: `b3`
- score row title strip and hover: `b2`

Text: `c1` is near white, `c2` the value colour, `f1` the muted grey for times, `h1` the pink accent
(links, pp, the level bar, section underlines).

Metrics worth knowing: the desktop breakpoint is 900px, the page container 1000px, large radius
10px, body text 14px, avatar 120px (65px on mobile), cover 250px (100px on mobile).

Fonts: osu-web's stack is `Torus, Inter, "Helvetica Neue", Tahoma, Arial`, with Venera for grade
letters. Neither can be shipped, so both are named first and a machine that has them uses them.
Everyone else gets Nunito, which ships with the app (`web/css/fonts.css`).

## Region map

| region | this project | osu-web |
|---|---|---|
| cover image | `#cover`, `.profile-info__bg` | `profile-page/cover.tsx`, `bem/profile-info.less` |
| the page column every band sits in | `.band`, `.profile-info` | `bem/osu-page.less` (`.page-width()`) |
| folding the cover away | `#coverToggle`, `.profile-info--cover-collapsed` | `profile-page/cover.tsx` (`profile_cover_expanded`), `bem/profile-info.less` (`__cover-toggle`) |
| the pencil on the banner | `#coverEdit`, `.profile-page-cover-editor-button` | `profile-page/profile-edit-button.tsx`, `bem/profile-page-cover-editor-button.less` |
| avatar, name | `#avatar`, `#pname` | `bem/profile-info.less` |
| a blank me! | `#aboutNew`, `.profile-extra-user-page--new` | `profile-page/user-page.tsx` (`renderPageNew`), `bem/profile-extra-user-page.less` |
| the pencil that opens me! | `#aboutActions`, `.btn-circle--page-toggle` | `profile-page/user-page.tsx` (`page-extra__actions`), `bem/btn-circle.less` |
| flag and country name | `#pflags`, `.flag-country` | `components/flag-country.tsx`, `bem/flag-country.less` |
| mode tabs | `#modes`, `.game-mode` | `bem/game-mode.less`, `bem/game-mode-link.less`, `playmode-tabs.tsx` |
| level bar and hexagon | `.profile-detail-bar__level` | `bem/profile-detail-bar.less`, `bem/user-level.less`, `components/user-level.tsx`, `css/layout.less` (the `--level-tier-*` gradients) |
| global rank, pp, ranked maps | `#globalRank`, `#totalPp` | `profile-page/detail-stats.tsx`, `bem/profile-detail-stats.less` |
| rank chart | `#ppChart` | `profile-page/rank-chart.tsx`, `bem/line-chart.less` |
| grade counts | `#gradeCounts`, `.profile-rank-count` | `bem/profile-rank-count.less`, `bem/score-rank.less` |
| grade badges | `gradeBadge()` in `web/js/badges.js`, `.score-rank--*` | `bem/score-rank.less`, `public/images/badges/score-ranks-v2019/GradeSmall-*.svg` |
| stats box | `#profileStats`, `.profile-stats` | `bem/profile-stats.less` |
| section tabs | `#sectionTabs`, `.page-mode` | `bem/page-mode.less`, `bem/page-mode-link.less` |
| section panels | `.page-extra` | `bem/page-extra.less`, `bem/title.less` |
| score rows | `.play-detail` | `profile-page/play-detail.tsx`, `bem/play-detail.less` |
| mod badges | `modPill()` in `web/js/badges.js`, `.mod` in `profile.css` | `components/mod.tsx`, `bem/mod.less`, `bem/mods.less`, `public/images/badges/mods/` |
| a stable score's big letter | `legacyRank()` in `web/js/score-card.js` | `bem/legacy-rank.less`, `resources/images/scores/legacy-ranking-*.png` |
| avatar with no picture | `guestAvatar()` in `web/js/badges.js` | `bem/avatar.less` (`avatar--guest`), `public/images/layout/avatar-guest.png` |
| which score a row shows | `scoreColumn()` in `src/calc/eligibility.ts` | `utils/score-helper.ts` (`totalScore`: legacy, then classic, then standardised) |
| most played | `.beatmap-playcount` | `profile-page/beatmap-playcount.tsx`, `bem/beatmap-playcount.less` |
| play history chart | `#playcountChart`, `.line-chart` | `profile-page/chart.tsx`, `profile-page/historical.tsx`, `charts/line-chart.ts`, `bem/line-chart.less`, `bem/page-extra.less` |
| medals | `.medals` | `profile-page/medals.tsx`, `bem/profile-badges.less` |
| favourite beatmap cards | `web/js/beatmapsets.js` | `beatmapset-panel/index.tsx`, `beatmaps-popup.tsx`, `difficulty-badge` |
| floating audio player | `#audioPlayer`, `.audio-player` | `core/osu-audio/main.ts`, `bem/audio-player.less`, `bem/audio-player-floating.less` |
| hover tooltips | `web/js/tooltip.js` | `tooltip-default.less`, `tooltip-default.coffee` |
| score row menu | `#playMenu` | `components/play-detail-menu.tsx` |
| score page | `web/score.html`, `web/js/score-page.js` | `scores-show/main.tsx`, `components/header-v4.tsx` |
| View Details card | `#scoreModal`, `web/js/score-card.js` | `scores-show/*.tsx`, `bem/score-{beatmap,info,tower,dial,player,buttons,stats}.less`, `bem/user-card.less`, `bem/legacy-rank.less`, `utils/score-helper.ts` |

## Two things that look wrong and are right

- **A stable play lists `CL`.** osu! adds Classic to every legacy score before scoring it, and
  osu-web shows it, so `withClassicMod` adds it when a row or card is built. It isn't in `mods_json`
  and mustn't be: medals, play time and eligibility read what the player chose.
- **The score on a row changes with a switch.** Options -> Lazer scoring picks the scale, as on
  osu!'s own profile page, and `score-helper.ts` is the rule for which number each scale shows.

## Known differences

What's deliberately not identical, and why. Anything else that looks wrong is a bug.

- **The typeface, the largest remaining difference.** osu! uses Torus for the page and Venera for
  display letters, and neither can be shipped. The page uses Nunito instead, the closest free
  face, drawn heavier than the weights asked for so small text has Torus's weight (see
  `docs/architecture.md`, "The page"); the CSS keeps osu-web's weights. Venera shows only in the
  grade in the middle of a lazer score's dial and on a mod osu-web has no glyph for (none, as of
  roadmap 5.57). Grade badges, stable's letters and mod glyphs are osu-web's own pictures, so
  their letters are exact. Keep osu!'s sizes rather than tuning them up to compensate.
- **`.mod` takes its size from the row** rather than setting its own from `--mod-height`. The
  badge measures the same.
- **View Details is a card first and a page second.** It opens as a dialog over the profile, so
  closing it leaves the page as it was, and the same card is served at `/scores/<id>`. Neither has
  osu-web's site navigation. Both are re-hued to 200, which is why the pop-up is blue on a pink
  page, as osu!'s is.
- **The score card's Global Rank and "Watched" rows** are left out: both are facts about osu!'s
  leaderboards. The user card's online dot says whether the profile is tracking.
- **Country rank** isn't shown: there's no honest way to estimate one (see
  `docs/architecture.md`).

## Generated from osu!

Regenerate after an osu-web change. Each fails loudly rather than writing a partial file.

```sh
node scripts/build-osu-web-art.mjs # web/osu-web/, web/css/osu-web-art.css
node scripts/build-mod-table.mjs   # web/js/mod-definitions.js (--source reads the local checkout)
node scripts/build-flags.mjs       # web/flags/<cc>.svg
node scripts/build-medal-table.mjs # src/calc/medal-definitions.json
```

## Working on fidelity

1. Refresh the checkout.
2. Find the region in the map above and read the LESS and the TSX.
3. Take the file: artwork through `build-osu-web-art.mjs`, code ported with its source named.
4. Add any new deliberate difference under Known differences, with the reason.
5. Run `npm run check`, then `npm run ui`. The browser check asserts computed style, which is where
   a fidelity change actually shows.
