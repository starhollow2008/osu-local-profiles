# Maintaining

Owner's procedures: releases, the rank curves, recalculation, and keeping pp current. The
reasoning behind each rule is in `docs/architecture.md`. Carried over from the README as it
stood at 1.21.0.

## Development

```
npm run typecheck
npm test
npm run check        # both
npm run ui           # drives the real page in headless Chrome (app must be running)
node src/main.ts --check-only   # is osu! found, and does the pp calculator start?
```

After changing `tools/PpCalculator/Program.cs`, run **`npm run build:pp:local`** rather than
`npm run build:pp`. `tools/pp/` holds a self-contained build that the app prefers over the plain
output, and a stale copy there does not fail loudly - it answers the old protocol and quietly
returns values calculated the old way.

The page is plain HTML, CSS and ES modules with **no build step** - edit `web/` and reload.
`npm run ui` covers dialog behaviour and the design tokens actually resolving, since a mistyped
custom property fails silently as a slightly-off shade. It exists because some bugs only show
up in computed style: the reset dialog once set `display: grid` on the element it also toggled
with the `hidden` attribute; `hidden` lost that specificity fight, so the dialog was visible on
load and Cancel appeared dead - leaving the destructive button as the only one that worked.

## Building a release

```
npm run package
```

Produces `dist/osu-local-profiles-<version>-<rid>/` and a zip beside it: **203MB on disk, 83MB
to download** for `win-x64` (measured before 1.21.0), containing Node, osu!'s pp calculator and
the app. The user extracts it and runs the launcher; there is nothing to install and no admin
rights needed, and because `data/` lives beside the app the whole folder can be moved or carried
on a stick.

**A package has to be built on the system it is for.** The runtime identifier defaults to the
machine's own (`win-x64`, `osx-arm64`, `linux-x64`, ...) and `--rid` can only narrow that to a
different architecture, not a different OS: `dotnet publish` would happily cross-compile the pp
helper, but the bundled Node runtime is a copy of the one running the script, and there is no
cross-platform equivalent of that. Building for another OS is refused rather than producing an
archive that starts on nothing.

So releases are built by **GitHub Actions** (`.github/workflows/release.yml`): pushing a
`v<version>` tag packages the app on each platform's runner and attaches the zips to that
version's release, with notes from `CHANGELOG.md`. Running the workflow by hand with no tag is a
dry run that builds them all and publishes nothing.

The notes are short on purpose (`scripts/release-notes.mjs`): each entry's bold lead, at most
eight, a link to the full CHANGELOG entry, and which download is which. GitHub lists the
downloads *under* the notes, and a whole CHANGELOG section there meant scrolling past it to
reach them. So the bold lead of a CHANGELOG entry is what a release page shows: write it to say
what changed on its own.

Most of that script is *removal*. osu!'s NuGet packages carry the entire game - fonts,
textures, audio samples, ffmpeg, SDL, a shader compiler - and a self-contained publish is
273MB, of which 125MB is `osu.Game.Resources.dll` alone.

Less can go than you would think. osu.Framework's `Logger` static constructor pulls in nearly
the whole managed assembly graph, so what is safe to delete is only what loads lazily: the
resources assembly, localisation satellites, and native libraries reached by P/Invoke. The
native BASS audio binaries are commercially licensed and this app never plays a sound, so they
are excluded (see [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)). Trimming is not an
option either; see `docs/architecture.md`, "Do not trim the helper".

The script also starts the packaged app from an unrelated directory and **refuses to finish
unless it reports finding its pp calculator**. An early build looked perfectly fine and silently
recorded no pp, because the helper's path was resolved from the working directory - which, for
a double-clicked process, is whatever Explorer decides.

## Keeping pp current

Every *reimplementation* of osu!'s algorithm lags its reworks, which is why pp comes from osu!'s
own packages. `rosu-pp` 4.0.1 (its newest release at the time) implemented the 2025-10-29
algorithm, but osu! reworked difficulty again on 2026-07-03. On a real play:

| | rosu-pp | osu! official | osu! website |
|---|---|---|---|
| stars | 7.030 | **6.933** | 6.93 |
| pp | 142.43 | **151.23** | 151 |

After an osu! pp rework:

1. Bump the package versions in `tools/PpCalculator/PpCalculator.csproj`. Check what .NET the
   new release targets (`NU1202 ... supports: net10.0` if it moved): osu! moves ahead of the
   project now and then, and the helper's `TargetFramework`, `setup-dotnet` in both workflows,
   the `bin/Release/<tfm>` fallback in `src/calc/official.ts` and THIRD-PARTY-NOTICES then all
   move with it. 2026.916.0 was the move to .NET 10.
2. `npm run build:pp:local`. It builds beside `tools/pp` and swaps only on success, so a failed
   build leaves the old helper working. Close the app first: it holds `tools/pp` open.
3. Read the diff of `osu.Game.Rulesets.*/Difficulty` between the two releases before calling
   it a rework, and price a few real scores with both: 2026.916.0 changed eleven difficulty
   files and not one pp value.
4. Ship it. Every install recalculates the scores the old release priced on its first launch
   after updating (`Tracker.recalculateAfterUpdate`), and **Recalculate every score** under
   Other settings -> pp calculator does the same on demand. Locally, restart the app, or run
   `node scripts/reingest.mjs` with it stopped to rebuild the rows outright.
5. Refresh the rank curves (below) in the same pass.

## Refreshing the rank curves

osu!'s rankings API only exposes the top 10,000, which never covers a new profile. Rank is
instead interpolated from a small curve built from data.ppy.sh's random sample of the whole
ladder, in which every sampled user carries their own real rank:

```
npm run rank:refresh                                # all four modes, newest dump
node scripts/build-rank-table.mjs osu --latest      # one mode
node scripts/build-rank-table.mjs osu --dump 2026_09_01
```

The script streams each ~1GB archive through `bzip2` and `tar` and keeps only the user-stats
table inside it, so nothing large is written to disk. That table is deleted as soon as the curve
is written, and the script says so; the checked-in result is ~3KB per mode. All four modes
shipped with a curve built from the 2026_09_01 dump.

**Never automatically.** Nothing in the app triggers this, on a timer or otherwise - it is a
multi-gigabyte download and it is the owner's call. Run it by hand when:

- **osu! reworks pp.** The curve maps pp to rank, so a rework moves both sides at once and the
  old curve becomes wrong immediately.
- **Every few months otherwise.** Ranks drift as the playerbase plays on: the same pp buys a
  slightly worse rank over time. It degrades gradually, so this is not urgent.

data.ppy.sh publishes monthly. `--latest` picks the newest automatically, and re-running against
a dump you already built from just rewrites the same curve, so it is safe to run whenever you
are unsure. Budget roughly 15-30 minutes per mode, depending on your connection - the
bottleneck is the download, not the decompression.

## Recalculating

Replays on disk are the source of truth, so any calculation fix can be applied retroactively.
Stop the app and run:

```
node scripts/reingest.mjs
```

This rebuilds every tracked score from its replay file. It must not pass a play tracking filter.

To fill in values on existing scores *without* replacing them - keeping their ids, which is what
you want in normal use - the page's **Options -> Other settings** offers a recalculation
instead, and the app can stay running.

## README screenshots

The README's images live in `docs/images/`, as `.webp`. Git keeps every version of a file
forever, so every replaced screenshot stays in every clone for good: keep them few, cropped to
what they show, and re-encoded (a full-width page section is 60-160KB as WebP at quality 90,
against 150KB-1.4MB as PNG), and replace one only when the page actually looks different.
`docs/` is never packaged, so none of this reaches a release. Never put them in `web/`, which
ships with every release.

## The sample profile

The README's sample profile is `index.html` on the `gh-pages` branch, served by GitHub Pages at
https://jonathant09.github.io/osu-local-profiles/. It is a copy saved from Share -> Save as a
web page, so it is updated by saving a new one and committing it there. That branch shares no
history with `main`, which keeps a file of a megabyte or more out of every clone of the code.
Open a new copy from disk before publishing it: anything it still fetches from the app shows
up there, broken, exactly as it would online.
