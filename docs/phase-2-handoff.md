# Phase 2 — the osu-web-faithful profile page

*Status: built. `npm run check` → 21 tests; `npm run ui` → 19 checks. See
`docs/osu-web-reference.md` for the design system it implements.*

## Decisions settled with the user

1. **Vanilla ES modules, no build step** — not Vite + React. `npm run dev` stays instant,
   Phase 4's single-`.exe` packaging is unaffected, and `npm run ui` keeps working. The
   page is data-in/DOM-out with SSE triggering a refetch, so React bought little.
2. **Local-first assets, CDN when online.** Grade badges, mod pills, the level hexagon and
   the avatar are generated inline SVG. Beatmap covers come from `assets.ppy.sh` keyed by
   the `beatmapset_id` resolved offline, and are set as backgrounds so a failed request
   leaves the placeholder colour rather than a broken image. Covers cannot come from
   lazer's local store: it names files by SHA-256 and the mapping lives in its Realm DB.
3. **First Place Ranks is omitted** — a local profile has no leaderboard to be #1 on.

## What is there

### Backend

| file | role |
|---|---|
| `src/calc/stats.ts` | one normalised `Play` shape shared by Top Ranks and Recent Plays (mod acronyms, `beatmapset_id` for cover art), plus `mostPlayed()` and `modesWithPlays()`. `hitsPerPlay` floors, matching osu-web. |
| `src/calc/history.ts` | one chronological pass over the profile's scores yielding the daily pp series, monthly play counts, and the activity feed. Replayed from scores rather than read from `snapshots`, which would be wrong after a reingest. |
| `src/http/server.ts` | `/api/profile` adds `mostPlayed`, `ppHistory`, `monthlyPlaycounts`, `events`. `/api/state` adds `country`, `tagline`, `createdAt`, `hasAvatar`, `hasCover`, `modesWithPlays`. `/api/image/{avatar,cover}` serves an optional user image from `data/`. |
| `src/config.ts` | `country` (two-letter ISO) and `tagline`. |

### Frontend

```
web/index.html          shell markup; JS fills it by id
web/css/tokens.css      the --hsl-* system, named colours, metrics, font sizes
web/css/base.css        reset, font stack, [hidden] rule, small utilities
web/css/profile.css     the components, named after osu-web's so the two read side by side
web/js/format.js        number / percent / relative-time formatting
web/js/badges.js        grade badges, mod pills, level hexagon, avatar, cover URLs
web/js/charts.js        inline-SVG pp line chart and monthly playcount bars
web/js/sections.js      score row, most-played row, activity row
web/js/main.js          state, mode tabs, SSE, options menu, reset dialog
```

Sections, in page order: header (cover, avatar, name, mode tabs) · ranking panel (global
and country rank, pp chart, pp / ranked beatmaps / bonus pp, grade badges, stats box) ·
level bar · Recent · Top Ranks → Best Performance · Historical → Monthly Playcounts, Most
Played Beatmaps, Recent Plays.

## Things worth knowing before changing it

- **`--hsl-b*`, not `--hsl-d*`.** Two dark families exist and they are not
  interchangeable. Getting this wrong is the single most likely fidelity regression, so
  `npm run ui` asserts four surfaces resolve to their literal token colours. A mistyped
  custom property makes the whole declaration invalid at computed-value time and the
  element silently falls back to transparent, which reads as a slightly-off shade rather
  than as an error.
- **`var()` does not work in SVG presentation attributes.** `stop-color="hsl(var(--x))"`
  is silently dropped; `style="stop-color: hsl(var(--x))"` works, because inline style is
  parsed as CSS. The pp chart's gradient depends on this.
- **The charts stretch with `preserveAspectRatio="none"`**, so anything round would come
  out elliptical and any text sheared. Axis labels are HTML siblings, strokes use
  `vector-effect="non-scaling-stroke"`, and there are no dots.
- **Section headings must stay block-level.** They were `inline-block` at first, which
  flowed "Top Ranks" and "Best Performance" onto the same line, overlapping. `npm run ui`
  asserts they stack.
- **Keep `[hidden] { display: none !important }`** in `base.css` and keep the dialog
  checks. That rule exists because a `display: grid` backdrop once outranked the browser's
  low-specificity `[hidden]`, leaving the reset dialog open on load with Cancel, Escape
  and backdrop-click all apparently dead — so the destructive button was the only one that
  worked, and it cost a user their tracked scores.
- **Torus stays first in the font stack** so a locally installed copy is picked up. It is
  commercially licensed and must never be bundled.

## Deliberate gaps, and how the page handles them

| gap | on screen |
|---|---|
| Global and country rank (Phase 3 — osu!'s rankings API only exposes the top 10k) | `-`, with a tooltip |
| No rank history to plot | the chart shows total pp instead, which a fresh profile does have |
| Play time is not tracked | omitted from the stats box, which osu-web's v1 layout also does |
| Replays watched by others | omitted; not applicable to a local profile |
| Mod settings, e.g. DT at 1.3x | parsed and stored, shown only as the mod acronym |
| A beatmap that was never downloaded has no local `.osu` | the pp cell shows `-` with a tooltip saying why |

## Ideas not taken

- Real country flags from osu!'s flag CDN. The two-letter code pill is offline-safe and
  needs no per-country asset; wire the image in behind it if it turns out to matter.
- Hover tooltips on the pp chart. It would need real coordinates, which the
  stretch-to-fit approach deliberately gives up.
