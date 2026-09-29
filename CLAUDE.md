# osu! local profiles

The app is **osu! local profiles**, at `github.com/jonathant09/osu-local-profiles`, and that
is the only name anywhere. The previous one was scrubbed from the code, docs and every GitHub
release. Never reintroduce it, not even as a compatibility alias (roadmap 5.18).

## Rules that must not break

The reasons are in `docs/architecture.md`.

- **Removing a score is a hide, never a `DELETE`.** Set `scores.hidden_at`; every query over
  `scores` goes through `visibleSql()`. Deleting a removed score for good writes its
  `dedupe_key` to `deleted_scores` first, or it comes back as a new score on the next ingest.
- **One definition each, in `src/calc/eligibility.ts`:** `countsSql()` for "counts toward
  pp" (never write `ranked = 1`), and `ppColumn`/`scoreColumn` for the pp and score columns
  (never `s.total_score`).
- **Beatmap names go through `src/calc/metadata.ts`**: `NAME_COLUMNS` for what a naming query
  selects, `names()` for a row, `beatmapName`/`beatmapNameOriginal` for the joined
  `artist - title`. Never build that string by hand, and send the original-language name only
  where it differs from the romanised one (roadmap 5.55).
- **Incomplete plays live in `incomplete_plays`, never in `scores`.** A row of zeroes there
  corrupts accuracy, grades, ranked score, the level bar and medals.
- **Attempts osu! could not submit count only through `incompleteSql()`.** They're stored with
  `incomplete_plays.unsubmitted = 1` and always recorded, and counted when the profile's
  `countUnsubmittedAttempts` is on (the default). Never read `incomplete_plays` for a figure
  without it.
- **A `.osu` section ends at a line beginning with `[`** (`osuSection`), never at the next `[`,
  which is ordinary inside values.
- **The play tracking filter decides what is written.** Off by default and widest when on. A fact
  it lacks never rejects a play. Every declined play is announced and recorded in
  `declined_plays`, which no figure reads. The only way back is Track anyway, one play at a time
  (`Tracker.trackAnyway`, roadmap 5.61), never a setting. `scripts/reingest.mjs` must not pass a
  filter.
- **The server refuses non-loopback requests, with no switch.** Don't bring back
  `shareOnNetwork`, and don't "fix" it by binding to `127.0.0.1` (that drops `::1`).
- **`/api/quit` refuses any `Origin` but the app's own page** (`isOwnPage`), or any website open
  in the browser could stop the app.
- **This repo is AGPL-3.0-or-later, as osu-web is, so osu-web's files may be used.** Its artwork
  arrives only through `npm run build:osu-web` into `web/osu-web/`, never edited (roadmap 5.57).
  Ported LESS/TSX names the osu-web file it came from. Anything new from a third party goes in
  `THIRD-PARTY-NOTICES.md`. Never, under any licence: `ppy/osu-resources` (CC-BY-NC), Torus or
  Venera, or the osu!/ppy logos. It can't return to MIT while it carries osu-web's files.
- **McOsu plays are built osu!stable replays, scored as stable** (`scoredAsStable`, roadmap
  5.58). Never offered for download, since they hold no cursor data. McOsu's own mods
  (Nightmare, experimental) are one app-own mod, `MC`, never one each and never shown to osu!'s
  calculator.
- **Medals: osu!'s own definitions plus Mod Introduction only.** Don't add other medal groups
  without asking.
- **No play counter from osu!stable's `osu!.db` last-played time** without asking: it can't
  count retries or tell a fail from a pass.
- **The updater never touches `data/`**, swaps nothing until the new build is verified, refuses
  in a source checkout, and never relaunches the app anywhere it can't be stopped from. The tray
  launcher restarts it itself (`test/launcher.test.ts`); the swapper only ever starts a
  launcher, never the runtime (`test/relaunch.test.ts`).
- **A waiting update installs only when asked, and only at a deliberate quit or a start**
  (roadmap 5.66): "When I quit" or Auto-update (off by default), never on a metered connection
  by itself, once per build (`attempts`). Never when stdin closes without `{"quit":true}`, which
  means the launcher died or the system is shutting down. Every swapper keeps `--no-relaunch`:
  an older app hands the swap to the newer one's.
- **A release is its four zips and nothing else** (roadmap 5.69): no update parts, manifests or
  notes files beside them. Anything the app needs to know about a release goes on its page.
- **The app never outlives its tray launcher.** It stops when the launcher closes its stdin
  (`stopWhenLauncherCloses`). `start.sh` and the `.command` keep their names, because 1.14-1.16
  launchers run them again after an update.
- **`fs.watch` only gets paths through `watchablePath`.** On Windows a non-canonical path aborts
  the process. Watcher tests `await sleep(SETTLED_MS)` after `start()`.
- **A score's INSERT and recompute's UPDATE are generated from the row object**, with
  `pricedColumns` in `src/tracker/pricing.ts` for what pricing decides, shared by both. Never
  hand-align placeholders.
- **After changing `Program.cs`, run `npm run build:pp:local`.** A stale `tools/pp/` answers the
  old protocol silently.
- **Web modules stay bundleable** (named imports, `export function/const/class`, no
  `export let`), and every served image goes through `assetUrl()` or a relative `url()` in a
  stylesheet, which Share inlines (`inlineCssUrls`).
- **me! BBCode is hostile:** escaped first, only tags written in `web/js/bbcode.js`, every
  attribute validated. Add a case to `test/bbcode.test.ts` with any new tag.
- **The launcher runs the runtime beside it**, by absolute path, never one from PATH. Anything
  spawned through `cmd` needs `windowsVerbatimArguments`.

## Tray launcher: Go, in `tools/launcher/`

What a package opens: `osu! local profiles.exe`, `.app`, or `osu-local-profiles`. It runs the
app with no console and keeps a tray (menu bar) icon, as a separate process so Node still loads
no native modules.

- `npm run check` builds and runs it, so it needs Go on PATH; without Go those tests skip.
- Decisions go in `plan.go`, pure and tested for every OS from any machine.
- Icons are committed; `npm run build:icons` remakes them from `web/favicon.svg`.
- The macOS build (cgo) can't be compiled on Windows; CI's macOS runner is its only check.

## Docs

For roadmap work, search [`docs/roadmap.md`](docs/roadmap.md) for the entry; don't read it
whole. Update it only when the task changes its status. Read only the relevant sections of
[`docs/architecture.md`](docs/architecture.md).

## TS: strip-only, no runtime emit

`node src/main.ts` runs TypeScript through Node's type stripping, so types are erased, never
compiled:

- No `constructor(private db: Db)`: declare the field and assign it in the body.
- No `enum` (use `const` objects `as const`), no `namespace`, no decorators.

`npm run check` is typecheck plus the full test suite. Run it before every commit. Tests alone:
`node --test "test/**/*.test.ts"` (the quoted glob is required).

## pp: official .NET helper only

`tools/PpCalculator/` wraps the `ppy.osu.Game.Rulesets.*` NuGet packages, driven over a
JSON-lines pipe from `src/calc/official.ts`.

- Hand it the replay file, never a reconstructed ScoreInfo. McOsu writes none, so hand it the
  stable replay the app built for the play (`data/mcosu/`, `src/clients/mcosu.ts`), with a custom
  rate or override as the request's `mods`. A score from its osu! link or entered by hand is the
  same: a replay built from its numbers (`src/built-replays.ts`, `data/replays/`), priced and
  repriced here offline, never osu!'s pp re-fetched (roadmap 5.64). Built replays are never
  offered for download.
- No fallback calculator (`rosu-pp` was removed). Helper down means store no pp and say so.
- The only other calculator is the same helper built from the player's osu! source
  (`src/calc/source-helper.ts`, roadmap 5.70). It prices the whole app, every score is
  recalculated on a switch either way, and it never runs beside the release or stands in for it
  when it fails.
- Slim builds (partially trimmed, extra natives pruned) only through `buildCheckedPpHelper`,
  which ships slim only when `scripts/pp-parity.mjs` finds every answer identical to the full
  helper on that platform, and the full helper otherwise (roadmap 5.60). Its plays are generated
  (`scripts/pp-parity-corpus.mjs`): never commit or upload real replays or beatmaps for it.
  Never put trim settings in `PpCalculator.csproj`, and never full trimming (5.44). `--full`
  builds skip the check, for iterating.
- Every pp carries its osu! release version and breakdown, and the parts must match the pp
  beside them.
- `docs/reference-links.md` has links to osu-web, ppy/osu and the API docs.

## Design constraints

- No native modules in the Node process: `node:sqlite` and pure-JS LZMA only.
- `/api/profile` is cached until the database changes (`total_changes()` stamp).
- No API polling. Local detection only. Works with no credentials and no network.
- No scan-and-import at startup unless the profile asked for it. Importing past plays is
  explicit: pick a range, preview, confirm. A launch imports the gap it was closed for only with
  `importPlaysWhileClosed` on (off by default), never further back than the app last ran, and
  through `Tracker.backfill` like any other import (roadmap 5.56).
- Ingestion is serialized through a promise queue (`src/tracker/index.ts`).
- The live feed is SSE, and a browser allows 6 connections per origin. Only a visible tab may
  hold the stream open, or open tabs starve the page itself (`web/js/main.js`).

## UI text

Option descriptions and hints are short, plain and human: say what it does in one sentence, or
a couple of words ("Optional", "Installation locations"). No copywriting: no dashes for dramatic
pauses, no grandiose asides, no explaining the app's reasoning, no "always/never/nothing is
lost". Every language gets the same (`web/i18n/*.json`).

## UI checks

`npm run ui` drives the **running app** (`http://localhost:7272/`, or a URL given as an
argument) in headless Chrome via CDP and asserts computed style. Start the app first, or it
fails.

`[hidden] { display: none !important; }` in `web/css/base.css` is global. Keep it.

## Git

Conventional Commits, scope optional: `feat:`, `fix:`, `docs:`, `chore:`, `test:`,
`refactor:`, `perf:`, `style:`. Releases are `chore: release vX.Y.Z`.

History is linear: rebase onto `main`, don't merge it into a branch.

## Key entry points

- `src/main.ts`: application startup
- `tools/launcher/main.go`: the tray launcher (`launcher.go` runs the app, `tray.go` the icon)
- `src/osr.ts`: legacy and lazer replay parser
- `src/clients/mcosu.ts`: McOsu's scores.db, the replays built from it, and its mods
- `src/tracker/index.ts`: serialized replay ingestion
- `src/calc/official.ts`: JSON-lines bridge to `tools/PpCalculator/`
- `src/http/server.ts`: HTTP API and static serving
