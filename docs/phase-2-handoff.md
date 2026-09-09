# Phase 2 handoff — the osu-web-faithful profile page

*Written 2026-09-09, mid-phase. Backend work is done and green; the frontend rebuild has
not started. Read `docs/osu-web-reference.md` first — it holds the design facts, and
re-deriving them costs a dozen network round trips.*

## Decisions settled with the user

These close the open questions the plan flagged. They are settled; do not reopen them.

1. **Frontend stays hand-written — vanilla ES modules, no build step.** Not Vite + React.
   Reasoning: `npm run dev` stays instant, Phase 4's single-`.exe` packaging is unaffected,
   the page is data-in/DOM-out with SSE triggering a refetch, and `npm run ui` keeps
   working unchanged. Split `web/` into real `.css` and `.js` module files rather than one
   monolithic `index.html`.

2. **Assets are local-first, CDN when online.** Grade badges, mod pills, the level
   hexagon and the country flag are generated inline SVG so they always render. Beatmap
   cover art comes from `assets.ppy.sh` keyed by the `beatmapset_id` we already resolve
   offline, and **must** fall back to a generated gradient card on `error`. Note that
   covers cannot be pulled from lazer's local store — it names files by SHA-256 and the
   filename mapping lives in its Realm DB — so this is the only source for lazer users.

3. **First Place Ranks is omitted.** A local fresh profile has no leaderboard to be #1 on.
   Top Ranks shows Best Performance only.

## What is already done (uncommitted, on `phase-1-tracking`)

`npm run check` → **21 tests, 0 failures**. The old `web/index.html` still works against
the new API, so the tree is in a runnable state.

| file | change |
|---|---|
| `src/calc/stats.ts` | rewritten. One normalised `Play` shape shared by Top Ranks and Recent Plays (camelCase, mods parsed to acronym arrays, `beatmapset_id` joined in for cover art). Added `mostPlayed()` and `modesWithPlays()`. `hitsPerPlay` now floors, matching osu-web. |
| `src/calc/history.ts` | **new.** One chronological pass over the profile's scores yields three things the page needs: a daily total-pp series for the chart, monthly play counts for the Historical bar chart, and an activity feed (`first` / `level` / `best` events) for the Recent section. Replayed from scores rather than read from `snapshots`, because snapshots would be wrong after a reingest. |
| `src/http/server.ts` | `/api/profile` now also returns `mostPlayed`, `ppHistory`, `monthlyPlaycounts`, `events`. `/api/state` returns `country`, `tagline`, `createdAt`, `hasAvatar`, `hasCover`, `modesWithPlays`. New `/api/image/{avatar,cover}` serves an optional user-supplied image from `data/`. MIME map gained jpg/jpeg/webp/woff2. |
| `src/config.ts` | added `country` (2-letter ISO, empty by default) and `tagline` (what to call the playstyle). |
| `src/main.ts` | passes the new options through to `startServer`. |
| `test/reset.test.ts` | updated for the widened `ServerOptions`. |
| `docs/osu-web-reference.md` | **new.** The extracted design system. |

## Next steps, in order

### 1. Write the CSS token layer

`web/css/tokens.css` — the full `--hsl-*` table from the reference doc, driven by
`--base-hue: 333`. **Phase 1's page used the `d*` family; the profile page is built on
`b*`.** Fixing that is most of what makes it stop looking "off".

Also carry over, unchanged, the fix that `npm run ui` exists to protect:

```css
[hidden] { display: none !important; }
```

A shipped bug once cost a user their tracked scores because `.backdrop { display: grid }`
outranked the browser's low-specificity `[hidden]`. Keep the global rule, keep the check.

### 2. Build the page as ES modules

Planned layout — nothing here is written yet:

```
web/index.html          shell markup only
web/css/tokens.css      the --hsl-* system + named colours + font sizes
web/css/base.css        reset, font stack, page container
web/css/profile.css     the BEM-ish components below
web/js/format.js        number / percent / relative-time formatting, escapeHtml
web/js/badges.js        grade badge SVG, mod pills, level hexagon, cover URLs
web/js/charts.js        inline-SVG line chart (pp) + bar chart (monthly playcounts)
web/js/sections.js      play row, most-played row, section builders
web/js/main.js          state, mode tabs, SSE wiring, options menu, reset dialog
```

The server already serves subdirectories and the right MIME types.

Font stack: keep `Torus` first so a locally installed copy is used, then a geometric sans
fallback. Torus is commercially licensed and must not be bundled.

### 3. Sections to build, matching the reference doc's skeleton

- **Header** — cover, avatar, name, country pill, tagline. Cover falls back to the
  beatmapset cover of the profile's best play, then to a gradient. Avatar is generated
  unless `data/avatar.*` exists. Keep the existing tracking dot / pause button and the
  options menu (they are ours, not osu-web's, but they have to live somewhere).
- **Gamemode tabs** — bottom-right of the cover, defaulting to `defaultMode` from
  `/api/state`. Mode glyphs come from osu-web's icon font, which we cannot ship: use text
  labels.
- **Ranking panel** — Global / Country Ranking both render `-` (rank estimation is
  Phase 3), pp, the chart slot, and the grade badge row.
- **Chart** — osu-web plots global rank over 90 days. We have no rank, so plot
  `ppHistory` and label it accordingly; use osu-web's `__empty-chart` "unranked" empty
  state when there is no data.
- **Stats box** — the `.profile-stats` dl, minus `play_time` (v1 omits it, and we do not
  track it) and minus `replays_watched_by_others` (not applicable).
- **Level bar** — `.profile-detail-bar`, bar plus hexagon.
- **Recent** — the activity feed from `events`.
- **Top Ranks** — Best Performance, from `top`, with pp weighting shown.
- **Historical** — monthly playcount bar chart, Most Played Beatmaps, Recent Plays.

### 4. Verify in a real browser

`npm run dev` in one terminal, then `npm run ui`. Extend `scripts/ui-check.mjs` with
computed-style assertions for anything new that toggles visibility, and for the token
layer actually resolving (e.g. that `.page-extra` computes to the `b4` background rather
than a fallback, which is how a typo'd `--hsl-*` var shows up).

There are two real tracked scores in `data/profiles.db` to render against — enough to
exercise every section but not enough to judge list density.

## Still deferred to Phase 3, so the page must degrade gracefully

- Global and country rank (osu!'s rankings API only exposes the top 10k).
- Mod settings, e.g. DT at 1.3× — parsed and stored, not surfaced.
- Play time — not tracked at all.
- A beatmap that was never downloaded has no local `.osu`, so it has no pp or stars.
