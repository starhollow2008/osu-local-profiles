# Maintaining

The owner's procedures: releases, keeping pp current, the rank curves and recalculation. The
reasoning behind each rule is in `docs/architecture.md`.

## Development

```
npm run check        # typecheck and the full test suite
npm run ui           # drives the running app in headless Chrome
node src/main.ts --check-only   # is osu! found, and does the pp calculator start?
```

After changing `tools/PpCalculator/Program.cs`, run `npm run build:pp:local`, not
`npm run build:pp`. The app prefers the build in `tools/pp/`, and a stale one there doesn't fail:
it answers the old protocol and quietly returns old values.

The page has no build step, so edit `web/` and reload. `npm run ui` exists because some bugs only
show up in computed style, like a mistyped custom property or a dialog that's visible when it
shouldn't be.

## Building a release

```
npm run package
```

This makes `dist/osu-local-profiles-<version>-<rid>/` and a zip beside it, holding Node, osu!'s pp
calculator and the app. There's nothing to install, and since `data/` lives beside the app the
folder can be moved anywhere.

**A package has to be built on the system it's for.** The bundled Node is a copy of the one running
the script, so building for another OS is refused. `--rid` can only pick another architecture.

So releases are built by GitHub Actions (`.github/workflows/release.yml`): pushing a `v<version>`
tag packages the app on each platform's runner and attaches the four zips to that release. Running
the workflow by hand with no tag is a dry run that publishes nothing. A release is the four zips
and nothing else.

The release notes come from `CHANGELOG.md` through `scripts/release-notes.mjs`: each entry's bold
lead (at most eight), a link to the full entry, and which download is which. The app shows the same
lines as its patch notes. So write each bold lead to say what changed on its own. Put
`<!-- important -->` on its own line in a version's section to mark a release everyone should have.

Most of the packaging script is removal: osu!'s NuGet packages carry the whole game (fonts,
textures, audio, ffmpeg, SDL), and the native BASS audio libraries are commercially licensed, so
they're excluded. The pp helper ships slim only when it's proven to give identical answers (roadmap
5.60); full trimming breaks it (5.44).

The script also starts the packaged app from an unrelated folder and refuses to finish unless it
finds its pp calculator. An early build looked fine and silently recorded no pp, because the
helper's path was resolved from the working directory, which for a double-clicked program is
wherever Explorer decides.

## Keeping pp current

Reimplementations of osu!'s algorithm lag its reworks, which is why pp comes from osu!'s own
packages. When osu! reworks pp:

1. Bump the package versions in `tools/PpCalculator/PpCalculator.csproj`. Check which .NET the new
   release targets (`NU1202 ... supports: net10.0` means it moved). If it moved, the helper's
   `TargetFramework`, `setup-dotnet` in all three workflows, the `bin/Release/<tfm>` fallback in
   `src/calc/official.ts` and THIRD-PARTY-NOTICES all move with it.
2. Close the app (it holds `tools/pp` open) and run `npm run build:pp:local`. It builds beside
   `tools/pp` and swaps only on success.
3. Read the diff of `osu.Game.Rulesets.*/Difficulty` between the two releases and price a few real
   scores with both before calling it a rework. 2026.916.0 changed eleven difficulty files and not
   one pp value.
4. Ship it. Every install recalculates what the old release priced on its first launch after
   updating, and Recalculate every score does the same on demand. Locally, restart the app, or run
   `node scripts/reingest.mjs` with it stopped.
5. Refresh the rank curves in the same pass.

## Refreshing the rank curves

osu!'s rankings API only covers the top 10,000, so rank comes from a curve built from data.ppy.sh's
random sample of the whole ladder:

```
npm run rank:refresh                                # all four modes, newest dump
node scripts/build-rank-table.mjs osu --latest      # one mode
node scripts/build-rank-table.mjs osu --dump 2026_09_01
```

The script streams each ~1GB archive through `bzip2` and `tar`, keeps only the user-stats table,
and deletes it once the curve is written. The result is about 3KB per mode. All four modes
currently use the 2026_09_01 dump.

Never run it automatically: it's a multi-gigabyte download and the owner's call. Run it when osu!
reworks pp (the curve maps pp to rank, so a rework breaks it at once), and every few months
otherwise, since the same pp slowly buys a worse rank. data.ppy.sh publishes monthly, re-running
against a dump you already used just rewrites the same curve, and it takes roughly 15-30 minutes
per mode, mostly download.

## Recalculating

Replays on disk are the source of truth, so any calculation fix can be applied to old scores. To
rebuild every score from its replay, stop the app and run:

```
node scripts/reingest.mjs
```

It must not pass a play tracking filter. To fill in values without replacing rows (keeping their
ids), use Options -> Other settings -> Recalculate every score, with the app running.

## README screenshots

The README's images are `.webp` in `docs/images/`. Git keeps every version forever, so keep them
few, cropped and re-encoded (a full-width section is 60-160KB as WebP at quality 90, against
150KB-1.4MB as PNG), and replace one only when the page actually looks different. `docs/` is never
packaged. Don't put them in `web/`, which ships with every release.

## The sample profile

The README's sample profile is `index.html` on the `gh-pages` branch, served at
https://jonathant09.github.io/osu-local-profiles/. It's a copy saved with Share -> Save as a web
page, so update it by saving a new one and committing it there. That branch shares no history with
`main`, which keeps a megabyte-sized file out of every clone. Open the new copy from disk before
publishing it: anything it still fetches from the app will show up broken there, as it would
online.
