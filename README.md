# osu! fresh profile

Track an alternative osu! playstyle as if it were a brand new account.

osu! allows one account per person, so there is no way to find out what your rank and pp
*would* be if you switched from tablet to mouse, or from your right hand to your left. This
runs locally, watches your plays while it is open, and builds a separate profile from
scratch — starting at 0pp, unranked, level 1.

Inspired by [Sheppsu's osu-score-tracker](https://github.com/Sheppsu/osu-score-tracker).

## Status

Phase 1 — the tracking pipeline works end to end. The web page is functional but plain;
the osu-web-faithful design is Phase 2.

## Running it

```
npm install
npm run build:pp     # builds the osu! pp helper (needs the .NET 8 SDK)
npm run dev          # or double-click start.bat
```

`build:pp` is required for pp. Without it the app still tracks scores, but records no pp or
star rating rather than guessing -- see below.

Then open <http://localhost:7272>. Play osu! and scores appear as you set them.

Closing the window stops tracking. The page also has a pause button if you want to keep it
open without recording.

**First run takes about a minute** while it indexes your local beatmaps. Later runs are fast.

## How it works

Everything happens locally. There is no polling loop and no account login.

```
  lazer:  %APPDATA%/osu/files/**        ─┐
  stable: <osu!>/Data/r/*.osr           ─┴─→ new file detected (recursive fs.watch)
                                                     │
                            first bytes look like a replay?
                                                     ▼
                   parse .osr  →  mods, hits, combo, score, timestamp
                                                     ▼
                  beatmap MD5  →  beatmap id + ranked status   (offline)
                                                     ▼
         local .osu  →  osu!'s own difficulty/pp calculator  →  pp   (offline)
                                                     ▼
                          store → recompute profile → live update
```

Three things make the offline path possible:

- **osu!lazer writes a legacy `.osr` for every play** into its content-addressed file
  store, so replays can be watched for without touching its Realm database.
- **lazer ships `online.db`**, a SQLite database of ~234k beatmaps keyed by MD5 with ranked
  status, so a score can be matched to its beatmap with no network access.
- **pp is computed locally**, so it works for plays that were never submitted.

### pp comes from osu!'s own calculator

`tools/PpCalculator` is a small .NET helper referencing the official
`ppy.osu.Game.Rulesets.*` NuGet packages -- osu!'s actual difficulty and performance code.
It stays resident and speaks one JSON object per line, so the cost is a single process
start rather than one per score.

It is handed the replay file and decodes it with osu!'s own `LegacyScoreDecoder`, which is
what makes **osu!stable** replays correct: the decoder sets `IsLegacyScore` from the replay
version, applies the Classic mod (switching the calculator onto classic slider accuracy and
legacy miss estimation), and populates `MaximumStatistics` from the beatmap. Building a
score by hand instead would silently score stable plays as though they were lazer.

This is needed because every *reimplementation* of osu!'s algorithm lags its reworks.
`rosu-pp` 4.0.1 (its newest release) implements the 2025-10-29 algorithm, but osu! reworked
difficulty again on 2026-07-03. On a real play:

| | rosu-pp | osu! official | osu! website |
|---|---|---|---|
| stars | 7.030 | **6.933** | 6.93 |
| pp | 142.43 | **151.23** | 151 |

Keeping current with a future rework is a version bump in
`tools/PpCalculator/PpCalculator.csproj`, then `node scripts/reingest.mjs`.

**There is deliberately no fallback calculator.** A second implementation disagreeing by a
few percent would leave one profile holding scores computed two different ways, ranked
against each other and weighted together, with nothing on screen saying which was which.
A missing pp value is recoverable; a silently wrong one is not.

### Why local rather than the osu! API

An offline or logged-out play is never submitted, so it never appears in the osu! API — not
even after you reconnect. In lazer you can only play offline as a guest, so those scores
exist solely on disk. Reading local files is the only approach that covers them, and it is
also instant and costs the API nothing.

The API will be used later only for optional enrichment (cover art, official pp
cross-checks, rank estimation). The app works fully without it.

## Configuration

`data/config.json`, created on first run:

| key | default | meaning |
|---|---|---|
| `profileName` | `Fresh Profile` | name of the tracked playstyle |
| `port` | `7272` | local web server port |
| `openBrowser` | `true` | open the page on start |
| `backfill` | `false` | reserved — importing past plays is not implemented yet (Phase 3) |
| `installRoots` | `[]` | explicit osu! paths if auto-detection fails |

Scores set before the profile was created are never imported — otherwise switching the app
on would pull in the plays you set with your normal playstyle earlier that day.

## Development

```
npm run typecheck
npm test
npm run check        # both
npm run ui           # drives the real page in headless Chrome (app must be running)
```

`npm run ui` exists because some bugs only show up in computed style. The reset dialog once
set `display: grid` on the element it also toggled with the `hidden` attribute; `hidden`
loses that specificity fight, so the dialog was visible on load and Cancel appeared dead --
leaving the destructive button as the only one that worked. No unit test would catch that.

## Known gaps

- **Building the pp helper needs the .NET 8 SDK.** End users of a packaged build will not,
  since the helper can be published self-contained -- but that adds roughly 70MB to the
  download, which is a real tension with the single-.exe goal and is unresolved.
- **Only osu!standard has been checked against known-correct values.** taiko, catch and
  mania go through the same osu! code and should be right, but nothing verifies them yet.
- **Global rank is not yet estimated.** The osu! rankings API only exposes the top 10,000,
  and a fresh profile sits well below that for a long time.
- **Mod settings** (e.g. DT at 1.3x rather than 1.5x) are read but not yet surfaced.
- Only the local `.osu` files you already have can be used for pp; a map you have never
  downloaded cannot be calculated offline.

## Recalculating

Replays on disk are the source of truth, so any calculation fix can be applied
retroactively. Stop the app and run:

```
node scripts/reingest.mjs
```

This rebuilds every tracked score from its replay file.

## Licence

MIT. This project reimplements osu-web's visual design from its published design tokens
rather than copying its stylesheets, which are AGPL-3.0.
