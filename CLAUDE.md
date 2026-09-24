# osu! local profiles

The app is **osu! local profiles**, at `github.com/jonathant09/osu-local-profiles`, and that
is the only name anywhere. The previous one was scrubbed from the code, docs and every GitHub
release. Never reintroduce it, including as a compatibility alias (roadmap 5.18).

## Rules that must not break

Each has its reasoning in `docs/architecture.md`.

- **Removing a score is a hide, never a `DELETE`.** Set `scores.hidden_at`; every query over
  `scores` goes through `visibleSql()`. Deleting a removed score for good writes its
  `dedupe_key` to `deleted_scores` first, or it comes back as a new score on the next ingest.
- **One definition each, in `src/calc/eligibility.ts`:** `countsSql()` for "counts toward
  pp" (never write `ranked = 1`), `ppColumn`/`scoreColumn` for the pp and score columns
  (never `s.total_score`).
- **Beatmap names go through `src/calc/metadata.ts`.** `NAME_COLUMNS` for what a naming query
  selects, `names()` for a row, `beatmapName`/`beatmapNameOriginal` for the joined
  `artist - title`. Never build that string by hand in a new query, and send the
  original-language name only where it *differs* from the romanised one (roadmap 5.55).

- **Incomplete plays live in `incomplete_plays`, never in `scores`.** A row of zeroes there
  corrupts accuracy, grades, ranked score, the level bar and medals.
- **Attempts osu! could not submit count only through `incompleteSql()`.** Stored with
  `incomplete_plays.unsubmitted = 1` and recorded always; counted when the profile's
  `countUnsubmittedAttempts` is on (the default). Never read `incomplete_plays` for a figure
  without it.
- **A `.osu` section ends at a line beginning with `[`** (`osuSection`), never at the next `[`,
  which is ordinary inside values.
- **The play tracking filter decides what is written, so it cannot be undone.** Off by
  default and widest when on; a fact it lacks never rejects a play; every declined play is
  announced. `scripts/reingest.mjs` must not pass a filter.
- **The server refuses non-loopback requests, with no switch.** Do not bring back
  `shareOnNetwork`, and do not "fix" it by binding to `127.0.0.1` (drops `::1`).
- **This repo is AGPL-3.0-or-later, as osu-web is, so osu-web's files may be used.** Its
  artwork arrives only through `npm run build:osu-web` into `web/osu-web/`, never edited
  (roadmap 5.57); ported LESS/TSX names the osu-web file it came from; anything new from a
  third party goes in `THIRD-PARTY-NOTICES.md`. Never, under any licence: `ppy/osu-resources`
  (CC-BY-NC), Torus or Venera, or the osu!/ppy logos. It cannot return to MIT while it
  carries osu-web's files.
- **Medals: osu!'s own definitions plus Mod Introduction only.** Do not add other medal
  groups without asking.
- **No play counter from osu!stable's `osu!.db` last-played time** without asking: it cannot
  count retries or tell a fail from a pass.
- **The updater never touches `data/`**, swaps nothing until the new build is verified,
  refuses in a source checkout, and never relaunches the app anywhere it cannot be stopped
  from. The tray launcher restarts it itself (`test/launcher.test.ts`); the swapper only ever
  starts a launcher, never the runtime (`test/relaunch.test.ts`).
- **The app never outlives its tray launcher.** It stops when the launcher closes its stdin
  (`stopWhenLauncherCloses`). `start.sh` and the `.command` keep their names: 1.14-1.16
  launchers run them again after an update.
- **`/api/quit` refuses any `Origin` but the app's own page** (`isOwnPage`), or any website
  open in the browser could stop the app.
- **`fs.watch` only gets paths through `watchablePath`.** On Windows a non-canonical path
  aborts the process. Watcher tests `await sleep(SETTLED_MS)` after `start()`.
- **Recompute's UPDATE is generated from `UPDATE_COLUMNS`.** Never hand-align placeholders.
- **After changing `Program.cs`, run `npm run build:pp:local`.** A stale `tools/pp/` answers
  the old protocol silently.
- **Web modules stay bundleable** (named imports, `export function/const/class`, no
  `export let`), and every served image goes through `assetUrl()`, or through a relative
  `url()` in a stylesheet, which Share inlines (`inlineCssUrls`).
- **me! BBCode is hostile:** escaped first, only tags written in `web/js/bbcode.js`, every
  attribute validated. Add a case to `test/bbcode.test.ts` with any new tag.
- **The launcher runs the runtime beside it**, by absolute path, never one from PATH; anything
  spawned through `cmd` needs `windowsVerbatimArguments`.

## Tray launcher: Go, in `tools/launcher/`

What a package opens: `osu! local profiles.exe`, `.app`, or `osu-local-profiles`. It runs the
app with no console and keeps a tray (menu bar) icon. A separate process, so Node still loads
no native modules.

- `npm run check` builds and runs it, so it needs Go on PATH; without Go those tests skip.
- Decisions go in `plan.go`, pure and tested for every OS from any machine.
- Icons are committed; `npm run build:icons` remakes them from `web/favicon.svg`.
- The macOS build (cgo) cannot be compiled on Windows; CI's macOS runner is its only check.

## Before roadmap work

For roadmap-tracked implementation, search [`docs/roadmap.md`](docs/roadmap.md) for the relevant entry; never read it whole. Update it only when the task changes its status.

Read only relevant sections of [`docs/architecture.md`](docs/architecture.md) when architecture context is needed.

## TS: strip-only, no runtime emit

`node src/main.ts` runs TS via Node type stripping. Types erased, never compiled.

- No `constructor(private db: Db)` - declare field + assign in body
- No `enum` (use `const` objects `as const`)
- No `namespace`, no decorators

`npm run check` = typecheck + full test suite. Run it before every commit.

Tests: `node --test "test/**/*.test.ts"` (quoted glob required).

## pp: official .NET helper only

`tools/PpCalculator/` wraps `ppy.osu.Game.Rulesets.*` NuGet. Driven via JSON-lines pipe from `src/calc/official.ts`.

- Hand the replay file, never a reconstructed ScoreInfo
- No fallback calc (`rosu-pp` removed). Helper down = store no pp, say so
- Do not trim it. `PublishTrimmed` breaks osu!'s own graph - see `docs/architecture.md`, roadmap 5.44
- Every pp carries osu! release version + breakdown. Parts must match the pp beside them
- `docs/reference-links.md` has links to osu-web, ppy/osu, API docs

## Design constraints

- No native modules in Node process. `node:sqlite` + pure-JS LZMA only
- `/api/profile` cached until DB changes (`total_changes()` stamp)
- No API polling. Local detection only. Works with no credentials, no network
- No scan-and-import on startup *unless the profile asked for it*. Import past plays is
  explicit: pick cutoff, preview, confirm. A launch imports the gap it was closed for only
  with `importPlaysWhileClosed` on (off by default), never further back than the app last
  ran, and through `Tracker.backfill` like any other import (roadmap 5.56)
- Ingestion serialized through promise queue (`src/tracker/index.ts`)
- Live feed is SSE, and a browser allows 6 connections per origin. Only a *visible* tab may
  hold the stream open, or open tabs starve the page itself (`web/js/main.js`)

## UI checks

`npm run ui` drives the **running app** (`http://localhost:7272/`, override with an argv
URL) in headless Chrome via CDP and asserts computed style. Start the app first, or it
fails.

`[hidden] { display: none !important; }` in `web/css/base.css` is global. Keep it.

## Git

Conventional Commits, scope optional: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`,
`perf:`, `style:`. Releases are `chore: release vX.Y.Z`.

History is linear - rebase onto `main`, do not merge it into a branch.

## Key entry points

- `src/main.ts`: application startup
- `tools/launcher/main.go`: the tray launcher (`launcher.go` runs the app, `tray.go` the icon)
- `src/osr.ts`: legacy and lazer replay parser
- `src/tracker/index.ts`: serialized replay ingestion
- `src/calc/official.ts`: JSON-lines bridge to `tools/PpCalculator/`
- `src/http/server.ts`: HTTP API and static serving
