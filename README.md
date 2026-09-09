# osu! fresh profile

Track an alternative osu! playstyle as if it were a brand new account.

osu! allows one account per person, so there is no way to find out what your rank and pp
*would* be if you switched from tablet to mouse, or from your right hand to your left. This
runs locally, watches your plays while it is open, and builds a separate profile from
scratch — starting at 0pp, unranked, level 1.

Inspired by [Sheppsu's osu-score-tracker](https://github.com/Sheppsu/osu-score-tracker).

## Status

**All four phases are done.** Scores are tracked live, the page matches `osu.ppy.sh`'s
profile design, global rank is estimated offline, past plays can be imported deliberately,
several playstyles can be tracked side by side, and `npm run package` produces a portable
build that needs nothing installed.

[docs/osu-web-reference.md](docs/osu-web-reference.md) records the design system it is
built on -- osu-web's colour tokens, metrics and layout -- and
[docs/phase-2-handoff.md](docs/phase-2-handoff.md) covers what the page does, the gaps it
handles deliberately, and what to know before changing it.

Country rank still shows `-`, on purpose; see Known gaps.

## Running it

**If you have a packaged build**, unzip it anywhere and double-click
`Start osu! fresh profile.bat`. Nothing needs installing.

**From source:**

```
npm install
npm run build:pp     # builds the osu! pp helper (needs the .NET 8 SDK)
npm run dev          # or double-click start.bat
npm run check:app    # verify the install without starting to track
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

**No osu! API credentials are needed, and none are used.** There is no OAuth application,
no client id, no secret and no login anywhere in this project. Nothing polls the API.

Two hosts are contacted, both public and unauthenticated, and both optional:

| host | what for | if it fails |
|---|---|---|
| `assets.ppy.sh` | beatmap cover art, keyed by the beatmapset id already resolved offline | the placeholder colour shows instead |
| `data.ppy.sh` | the rank-curve dumps, only when you run `npm run rank:refresh` by hand | nothing; the checked-in curves keep working |

Rank estimation was the one feature that looked like it would need the API, and it does not:
the rankings endpoint only exposes the top 10,000 anyway, which never covers a fresh
profile, so the curve comes from the public dumps instead.

## Configuration

`data/config.json`, created on first run:

| key | default | meaning |
|---|---|---|
| `profileName` | `Fresh Profile` | name of the *first* profile only; after that, manage profiles from the page |
| `port` | `7272` | local web server port |
| `openBrowser` | `true` | open the page on start |
| `installRoots` | `[]` | explicit osu! paths if auto-detection fails |
| `country` | `""` | two-letter ISO code shown beside the profile name, as osu! shows one |
| `tagline` | `""` | what to call the playstyle, e.g. `left hand, mouse only` |

Drop an image at `data/avatar.png` or `data/cover.jpg` (`.jpg`/`.jpeg`/`.png`/`.webp` all
work) to use it on the profile. Neither is required.

Scores set before the profile was created are never imported — otherwise switching the app
on would pull in the plays you set with your normal playstyle earlier that day.

## Development

```
npm run typecheck
npm test
npm run check        # both
npm run ui           # drives the real page in headless Chrome (app must be running)
```

The page is plain HTML, CSS and ES modules with **no build step** -- edit `web/` and
reload. `npm run ui` covers both the dialog behaviour below and the design tokens actually
resolving, since a mistyped custom property fails silently as a slightly-off shade.

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
- **Global rank is an estimate, and ages.** It is interpolated from a pp->rank curve built
  from a monthly data.ppy.sh sample of the whole ladder, so it drifts as the playerbase
  grows. Refresh it with `node scripts/build-rank-table.mjs osu --dump YYYY_MM_DD`.
- **Country rank is not shown at all.** A 10,000-user sample spread over ~200 countries is
  far too thin to estimate one, and a fabricated number would be worse than a dash.
- **The rank curves cover all four modes**, but only osu!standard's pp is verified against
  known-correct values, so the other three inherit that caveat.
- Only the local `.osu` files you already have can be used for pp; a map you have never
  downloaded cannot be calculated offline.

## Profiles

**Options -> Profiles** manages several playstyles side by side -- "left hand", "mouse
only", "tablet again" -- each with its own scores, pp, level and start date. Only the
selected one records plays. A new profile starts empty and tracks from the moment you
create it, never from earlier plays.

Deleting a profile takes its tracked scores with it and needs an explicit confirmation.
The last remaining profile cannot be deleted; reset it instead.

## Backing up and exporting

- **Options -> Export this profile** downloads the active profile as JSON: every score with
  its beatmap, plus the computed totals and rank.
- **Options -> Back up everything** downloads a copy of the whole database, all profiles
  included. It is written with `VACUUM INTO` rather than copied, because the database runs
  in WAL mode and a plain file copy can miss recent writes.

Replays on disk remain the real source of truth -- `node scripts/reingest.mjs` rebuilds
everything from them -- but these are portable and outlive the app.

## Importing plays you set while it was closed

Scores are only tracked while the app is running, so a session played with it closed is
missed. **Options -> Import past plays** covers that: pick how far back to look, check what
would be imported, then confirm.

It never runs by itself, and the warning in the dialog is the important part -- reach back
further than the session you actually played with this playstyle and you will pull in plays
set with your normal one, which is the one thing a fresh profile must not contain.

## Rank estimation

osu!'s rankings API only exposes the top 10,000, which never covers a fresh profile. Rank
is instead interpolated from a small curve built from data.ppy.sh's random sample of the
whole ladder, in which every sampled user carries their own real rank:

```
npm run rank:refresh                                # all four modes, newest dump
node scripts/build-rank-table.mjs osu --latest      # one mode
node scripts/build-rank-table.mjs osu --dump 2026_09_01
```

The script streams each ~1GB archive through `bzip2` and `tar` and keeps only the
user-stats table inside it, so nothing large is written to disk. That table is deleted as
soon as the curve is written, and the script says so; the checked-in result is ~3KB per
mode. All four modes ship with a curve built from the 2026_09_01 dump.

### When to refresh

**Never automatically.** Nothing in the app triggers this, on a timer or otherwise -- it is
a multi-gigabyte download and it is the owner's call. Run it by hand when:

- **osu! reworks pp.** The curve maps pp to rank, so a rework moves both sides at once and
  the old curve becomes wrong immediately. Do this in the same pass as bumping
  `PpCalculator.csproj` and running `reingest.mjs`.
- **Every few months otherwise.** Ranks drift as the playerbase plays on: the same pp buys
  a slightly worse rank over time. It degrades gradually, so this is not urgent.

data.ppy.sh publishes monthly. `--latest` picks the newest automatically, and re-running
against a dump you already built from just rewrites the same curve, so it is safe to run
whenever you are unsure.

Budget roughly 15-30 minutes per mode, depending on your connection -- the bottleneck is
the download, not the decompression.

## Building a release

```
npm run package
```

Produces `dist/osu-fresh-profile-<version>-win-x64/` and a zip beside it: **203MB on disk,
83MB to download**, containing Node, osu!'s pp calculator and the app. The user extracts it
and double-clicks the launcher; there is nothing to install and no admin rights needed, and
because `data/` lives beside the app the whole folder can be moved or carried on a stick.

Most of that script is *removal*. osu!'s NuGet packages carry the entire game -- fonts,
textures, audio samples, ffmpeg, SDL, a shader compiler -- and a self-contained publish is
273MB, of which 125MB is `osu.Game.Resources.dll` alone.

Less can go than you would think. osu.Framework's `Logger` static constructor pulls in
nearly the whole managed assembly graph, so what is safe to delete is only what loads
lazily: the resources assembly, localisation satellites, and native libraries reached by
P/Invoke. One of those is worth calling out -- the native BASS audio binaries are
commercially licensed and this app never plays a sound, so they are excluded (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

The script also starts the packaged app from an unrelated directory and **refuses to finish
unless it reports finding its pp calculator**. An early build looked perfectly fine and
silently recorded no pp, because the helper's path was resolved from the working directory
-- which, for a double-clicked process, is whatever Explorer decides.

## Recalculating

Replays on disk are the source of truth, so any calculation fix can be applied
retroactively. Stop the app and run:

```
node scripts/reingest.mjs
```

This rebuilds every tracked score from its replay file.

## Licence

MIT — see [LICENSE](LICENSE).

The visual design is reimplemented from osu-web's *published design tokens* rather than
copied from its stylesheets, which are AGPL-3.0. No osu-web CSS or image asset is included;
the token table it was rebuilt from is recorded in
[docs/osu-web-reference.md](docs/osu-web-reference.md).

A packaged build bundles other people's software — osu!'s own pp code, the .NET runtime,
Node.js and their dependencies. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists
what, and what is deliberately excluded — notably the commercially-licensed BASS audio
library, which this app has no use for.

**What this does not do:** it never contacts osu!'s game servers, never logs in, uses no
API credentials, and only reads replay and beatmap files already on your disk. It does not
automate or assist play in any way.
