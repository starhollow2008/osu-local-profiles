# osu-web design reference

Facts extracted from `ppy/osu-web` (AGPL-3.0) and `ppy/osu` (MIT) so the Phase 2 profile
page can be **reimplemented** from them. Nothing here is a copy of their stylesheets or
assets: this file records the design *system* — token tables, colour values, metrics, and
the DOM skeleton — which is what the page needs in order to look right.

Do not paste osu-web LESS or their SVG path data into this repo. Redraw shapes; reuse
values.

Everything below was read from these files on 2026-09-09:

| what | url |
|---|---|
| colour tokens | `raw.githubusercontent.com/ppy/osu-web/master/resources/css/colors.less` |
| metrics, font sizes | `.../resources/css/variables.less`, `.../bootstrap-variables.less` |
| mixins | `.../resources/css/functions.less` |
| profile components | `.../resources/css/bem/{profile-info,profile-detail,profile-detail-bar,profile-detail-stats,profile-stats,profile-rank-count,play-detail,value-display,bar,user-level,score-rank,page-extra,title,page-mode}.less` |
| profile page structure | `.../resources/js/profile-page/{detail,detail-stats,stats,detail-bar,rank,rank-count,pp,historical,play-detail}.tsx` |
| grade badges | `.../public/images/badges/score-ranks-v2019/GradeSmall-*.svg` |
| rank + mod colours | `raw.githubusercontent.com/ppy/osu/master/osu.Game/Graphics/OsuColour.cs` |

---

## 1. The colour token system

osu-web derives its entire palette from one hue. `--base-hue` is injected on `body`
(osu! pink = **333**; other sections of the site swap it). Each token is a *fragment* —
`hue, saturation%, lightness%` — consumed as `hsl(var(--hsl-b3))`.

```
--hsl-<key>: var(--base-hue), <saturation>, <lightness>;
```

| key | sat | light | | key | sat | light |
|---|---|---|---|---|---|---|
| `p`  | 100% | 50%  | | `d1` | 20% | 35% |
| `h1` | 100% | 70%  | | `d2` | 20% | 30% |
| `h2` | 50%  | 45%  | | `d3` | 20% | 25% |
| `c1` | 40%  | 100% | | `d4` | 20% | 20% |
| `c2` | 40%  | 90%  | | `d5` | 20% | 15% |
| `l1` | 40%  | 80%  | | `d6` | 20% | 10% |
| `l2` | 40%  | 75%  | | `f1` | 10% | 60% |
| `l3` | 40%  | 70%  | | `b1` | 10% | 40% |
| `l4` | 40%  | 50%  | | `b2` | 10% | 30% |
|      |      |      | | `b3` | 10% | 25% |
|      |      |      | | `b4` | 10% | 20% |
|      |      |      | | `b5` | 10% | 15% |
|      |      |      | | `b6` | 10% | 10% |

**The `b*` family, not `d*`, is what the profile page is built on.** Phase 1's page used
`d*` throughout, which is why it read as too saturated. Backgrounds, in order of depth:

- page background / separators — `b6`
- section panels (`.page-extra`) — `b4`
- header block, stats cards, score row body — `b3`
- score row title strip (`--bg-main`), hover — `b2`
- `.profile-stats` key/value box — `b4`

Text: `c1` is effectively white, `c2` is the slightly-tinted value colour, `f1` is the
muted timestamp grey, `h1` is the pink accent (links, pp values, level bar fill, section
title underline).

### Fixed named colours

```
yellow        #ffcc22   yellow-light  #ffdd55   yellow-dark   #eeaa00
green         #88b300   green-light   #b3d944   green-dark    #668800
blue          #66ccff   blue-light    #99eeff   blue-dark     #44aadd
pink          #ff66aa   pink-light    #ff99cc   pink-dark     #cc5288
purple        #8866ee   purple-light  #aa88ff
red           #ed1221   red-light     #ed7887   red-dark      #ba0011
```

`.play-detail` uses `@yellow` for accuracy and `@yellow-dark` for the difficulty name.

### Score rank colours

Same values in `osu-web/colors.less` and `ppy/osu`'s `OsuColour.ForRank`:

```
D #ff5a5a   C #ff8e5d   B #e3b130   A #88da20   S/SH #02b5c3   X/XH #de31ae   F #3f3f3f
```

### Mod colours — `OsuColour.ForModType` (ppy/osu, MIT)

| mod type | colour |
|---|---|
| DifficultyReduction | Lime1 `#b2ff66` |
| DifficultyIncrease | Red1 `#ff6666` |
| Automation | Blue1 `#66ccff` |
| Conversion | Purple1 `#8c66ff` |
| Fun | Pink1 `#ff66ab` |
| System | Yellow `#ffcc22` |

Rough acronym → type mapping to implement (unknown acronyms should fall back to a neutral
grey rather than being silently mislabelled):

- reduction: `EZ NF HT DC`
- increase: `HR SD PF DT NC HD FL AC BL ST`
- automation: `AT CN RX AP SO`
- conversion: `CL DA RD MR TP AL SG 1K`–`9K DS CS`
- fun: `TR WG SI MG RP AS MU NS BR BU SY DP BM`
- system: `SV2 TD`

---

## 2. Metrics

```
breakpoint "desktop"      min-width: 900px       (@screen-sm-min)
page container            1000px                 (@container-tablet)
gutter                    10px  / desktop 50px   (@gutter-v2 / @gutter-v2-desktop)
border-radius--large      10px
border-radius base        4px
bar-size                  3px
box shadow                0 1px 3px rgba(0,0,0,.25)
profile avatar            120px desktop, 65px mobile   (@profile-avatar-size)
cover height              250px desktop, 100px mobile
profile header height     65px content + 10px vertical padding
stats box width desktop   300px
```

### Font sizes (`@font-size--*`)

```
tiny 8   small 10   small-2 11   normal 12   normal-2 13
title-small 14   title-small-2 15   title-small-3 16   title-small-4 18
large 20   title 24   large-2 35   large-3 40   large-4 50   extra-large 70
header-title 32   new-header-title 30
```

Body base is **14px**.

### Fonts

osu-web: `Torus, Inter, "Helvetica Neue", Tahoma, Arial`. **Torus is commercially
licensed and cannot be redistributed** — leave it first in the stack so a locally
installed copy is picked up, and fall back to a geometric sans. Grade letterforms use
`Venera`, also unavailable; approximate with a heavy sans.

---

## 3. Page skeleton

Section order on `osu.ppy.sh/users/{id}` (from `profile-page/detail.tsx`,
`detail-stats.tsx`, `historical.tsx`). `DetailStats` v1 is the default — `detail-stats-v2`
is behind a user preference and is *not* what the live page shows.

```
.profile-info                              header block, bg-colour b3
  .profile-info__bg                        cover image, 250px desktop
  .profile-info__details                   flex row
    .profile-info__avatar                  120px, border-radius 40px desktop
    .profile-info__info
      .profile-info__name                  font-size 24px desktop
      .profile-info__flags                 country flag + name

.profile-detail                            padding 10px var(--page-gutter); no bg of its own --
                                           shows .osu-page--generic-compact's default, b5
  .profile-detail-stats                    grid: 1fr auto auto on desktop
    <div>
      .profile-detail-stats__chart-numbers--top
        .profile-detail-stats__values      Global Ranking, Country Ranking
                                           (value-display--rank)
      .profile-detail-stats__chart         height 90px, rank line chart,
                                           or __empty-chart with "unranked"
      .profile-detail-stats__chart-numbers
        .profile-detail-stats__values--grid    4 cols: Medals, pp, Play Time
        .profile-detail-stats__values
          .profile-rank-count              5 grade badges + counts
    .profile-detail-stats__separator       2px, colour b6
    .profile-stats                         dl grid, bg b4, radius 10px, padding 18px 12px

.profile-detail-bar                        bg b3, level bar + hexagon pushed right
  .profile-detail-bar__level
    .bar.bar--user-profile                 200px, 6px tall, track b6, fill h1, radius pill
    .user-level                            50px hexagon, font-size 20px

.page-mode.page-mode--profile-page-extra   section tabs (Recent / Top Ranks / Historical)

.user-profile-pages                        grid, gap 10px
  .page-extra   x N                        bg b4, radius 10px, padding 20px
    .title.title--page-extra               section heading, 16px bold,
                                           2px bottom border in h1
```

### `.profile-stats` entries, in display order

`ranked_score, hit_accuracy, play_count, play_time*, total_score, total_hits,
hits_per_play, maximum_combo, replays_watched_by_others`

`play_time` is rendered **only** in the v2 layout, so v1 omits it. `hits_per_play` is
`Math.floor(total_hits / play_count)`.

### `.play-detail` — the score row

The single most repeated component. Desktop is a flex row of three coloured blocks:

```
.play-detail                               radius 10px, --bg b3, --bg-main b2
                                           (hover: --bg b2, --bg-main b1)
  .play-detail__group--top                 flex:1, bg --bg-main, radius 10px 0 0 10px
    .play-detail__icon--main               40x20 grade badge
    .play-detail__detail
      .play-detail__title                  14px, white; title then small artist
      .play-detail__beatmap-and-time       flex gap 15px
        .play-detail__beatmap              difficulty name, @yellow-dark
        .play-detail__time                 relative time, colour f1
  .play-detail__group--bottom              flex
    .play-detail__score-detail             bg --bg-main, padding 5px 10px
      .play-detail__accuracy               @yellow, min-width 60px
      .play-detail__weighted-pp            min-width 60px, margin-left 10px
      .play-detail__pp-weight              "weighted 95%"
    .play-detail__mods                     bg --bg-main, order -1 on desktop
    .play-detail__pp                       bg --bg, radius 0 10px 10px 0,
                                           min-width 110px, 16px/700, colour h1
                                           ::before = 10px arrow notch in --bg-main
                                           (clip-path polygon(0 0, 100% 50%, 0 100%))
      .play-detail__pp-unit                "pp", 12px, colour l3
```

Unranked / no pp renders `-` in the pp slot.

### Historical section order

1. `Monthly Playcounts` bar chart (`.page-extra__chart`, height 250px)
2. `Most Played Beatmaps` list, with a count pill in the title
3. `Recent Plays (24h)` — a `.play-detail` list
4. *(Replays Watched — excluded from this project)*

---

## 4. Grade badges

`GradeSmall-*.svg` is a **32×16** pill, `rx="8"`, decorated with flat triangular facets
and the letterform on top. Redraw the facets; reuse the palette.

| grade | pill | facet light | facet dark A | facet dark B | letter |
|---|---|---|---|---|---|
| X / XH | `#CE1C9D` | `#DE31AE` | `#C30B90` | `#BE0089` | `#5E244E` |
| S / SH | `#00A8B5` | `#02B5C3` | `#009DAA` | `#0096A2` | `#095056` |
| A | `#7CCE14` | `#88DA20` | `#72C904` | `#69BB00` | `#275227` |
| B | `#E3B130` | `#EBBD48` | `#DCA519` | `#D99D03` | `#553A2B` |
| C | `#F18252` | `#FF8E5D` | `#EA7948` | `#E67342` | `#473625` |
| D | `#E95353` | `#FF5A5A` | `#DE4949` | `#D63D3D` | `#512525` |
| F | `#373737` | `#3F3F3F` | `#2E2E2E` | `#2E2E2E` | `#2B2B2B` |

**The silver variants (XH, SH) are not a different hue.** They use the identical palette;
the only difference is that the *letterform* is filled with a vertical gradient from
`white` to `#AADFF0` instead of the flat dark letter colour. That gloss on the letters is
the whole "silver" cue.

Display sizes: `.score-rank` is `2em × 1em`; profile grade counts use `font-size: 22px`
(so 44×22), score rows use 40×20, `--tiny` is 14px.

---

## 5. Beatmap cover art

Covers are on a plain image CDN, not the API, and are keyed by **beatmapset** id — which
`online.db` already gives us offline:

```
https://assets.ppy.sh/beatmaps/{beatmapsetId}/covers/list@2x.jpg    small row thumbnail
https://assets.ppy.sh/beatmaps/{beatmapsetId}/covers/card@2x.jpg    wide card
https://assets.ppy.sh/beatmaps/{beatmapsetId}/covers/cover@2x.jpg   full-width banner
```

These must degrade to a generated placeholder on `error`, since the app is required to
work with no network.
