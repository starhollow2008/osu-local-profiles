# Porting the app to C# (roadmap 5.82)

The plan for replacing the Node app with one .NET app, and the record of where the port has got
to. Nothing here ships until the switch-over release in phase 8: until then every release is
the Node app, built and tested exactly as before.

## What changes and what doesn't

- **One runtime.** The server, the tracker and pp run in one .NET process. Node and the JSON
  pipe to `tools/PpCalculator/` go. Measured on the 1.32.0 Windows release: 161 MB installed
  (62 MB zipped), of which `node.exe` is 90 MB (33.5 MB zipped) and the pp helper 59 MB. The
  helper already carries the whole .NET runtime, so the expected result is about 75 MB
  installed and 31 MB zipped. Memory was 125 MB for Node (while indexing) plus 32 MB for an
  idle helper; one process is expected at roughly 80-110 MB. Measure both again in phase 7.
- **Same page.** `web/` stays as it is, JavaScript in the browser, served by the new server.
  The page only talks to `/api/...`, so the API is the contract.
- **Same data.** The new app opens the same `data/` folder: `profiles.db` with the same schema,
  `config.json`, the images. Nobody migrates anything.
- **Same rules.** Every rule in `CLAUDE.md` holds for the C# code, and the reasons in
  `docs/architecture.md` still apply. A rule that is about Node itself (no native modules,
  type stripping, `node:sqlite`) stops applying at the switch-over, not before.
- **Same pp.** osu!'s own packages, now called in-process. The calculator built from the
  player's own osu! source (5.70) stays a separate process, since it runs code nobody has
  checked.
- **The Go tray launcher stays.** It is small, tested, and already does the job on all three
  systems. It starts the new app instead of `node.exe`.

## Where it lives

`dotnet/` on `main`, beside the Node app, and not in any package until phase 7.

```
dotnet/
  OsuLocalProfiles.slnx
  Directory.Build.props       shared project settings
  App/                        the app (assembly osu-local-profiles-app)
  App.Tests/                  xUnit tests, mirroring test/*.test.ts
```

- `npm run check:port` runs the C# tests (CI's `port` job runs them on all three systems).
  `npm run parity:api` starts both apps on copies of `data/` and compares every ported answer;
  it needs an osu! installation, so it runs on a player's machine, not in CI.
- `dotnet run --project dotnet/App` runs the app on this checkout's `data/`, writing to it as
  the Node app does. While a Node app answers on the same port it only opens that one's page. To
  try something out, give it a folder of its own with `-- --root <dir>`.
- `src/db/schema.sql` is embedded into the app from where it is, so there is one schema.
- `web/` is served from the install root, as now.
- The weekly maintenance job keeps updating `tools/PpCalculator/PpCalculator.csproj`. Phase 3
  moves the osu! package versions into one place both projects read, and changes
  `docs/automated-maintenance.md` in the same commit.

## Rules while both apps exist

1. **The Node app is the product.** Fixes and features land there first, as now. Anything that
   changes behaviour the C# app already ports gets the same change there, in the same commit
   when it can.
2. **Only on copies until it ships.** Until phase 5 the C# app opened the database read-only
   unless started with `--writable`; it now writes as the Node app does, so try it on a copy
   (`--root`), as the parity script and the tests do.
3. **Ported means proven.** A module is ported when its tests are ported and pass, and an
   endpoint is ported when `scripts/api-parity.mjs` finds its answers identical to the Node
   app's on a copy of real data. Any difference that is kept on purpose is listed in the
   script, with the reason.
4. **Port the behaviour, including the odd parts.** Where JavaScript and .NET differ, the C#
   code does what the JavaScript did (see *JavaScript in C#* below). If the JavaScript was
   wrong, fix it in Node first, then port the fix.
5. **Comments carry over.** The reasons written beside the TypeScript are part of the code;
   port them with it, shortened where they can be.

## Phases

| #   | Phase                         | Status      |
| --- | ----------------------------- | ----------- |
| 0   | This plan                     | done        |
| 1   | Foundations                   | done        |
| 2   | Reading a profile             | done        |
| 3   | pp in-process                 | done        |
| 4   | Tracking                      | done        |
| 5   | Everything that writes        | done        |
| 6   | Updater bridge (Node release) | built, ships with the next release |
| 7   | Packaging                     | done        |
| 8   | Switch-over release           | rehearsing  |
| 9   | Removing the Node app         | not started |

### 1. Foundations

- [x] Solution, shared settings, test project; CI job building and testing it.
- [x] Install root, `data/` and version (`src/config.ts`), with `--root` for development.
- [x] `config.json` read with defaults and retired keys dropped (`loadConfig`).
- [x] Database open, schema, migrations and the three pins (`src/db/index.ts`).
- [x] Profiles: list, get, active (`src/profiles.ts`, reading half).
- [x] Settings: defaults, coercion, read and update (`src/settings.ts`), with the tracking
      filter's shape, coercion and `filterNarrows` (`src/tracking-filter.ts`).
- [x] Eligibility: `eligibilityOf`, `countsSql`, `visibleSql`, `incompleteSql`, `ppColumn`,
      `scoreColumn`, `starsColumn` (`src/calc/eligibility.ts`).
- [x] Server: listens on both loopbacks only (see Decisions), refuses every non-loopback
      request, `isOwnPage`, static files from `web/`, the score page route.
- [x] Endpoints: `/api/app`, `GET /api/settings`, `GET /api/app-config`, `GET /api/declined`,
      `GET /api/data-folder`.
- [x] `scripts/api-parity.mjs`: both apps on copies of one `data/`, every ported endpoint
      compared.
- [x] Single instance (`src/instance.ts`): a second start finds the first and opens its page,
      or opens nothing when the computer started it.
- [x] Stopping: Ctrl+C, SIGTERM, the launcher closing stdin (`{"quit":true}` first makes it
      deliberate) and `/api/quit` from the app's own page, one stop path for all four. The
      metered messages are read but not kept until the updater is ported (phase 5).

First parity run, 2026-10-28, on the owner's data (3 profiles, 47 setting rows, a declined
play): all five endpoints and eight static paths identical. Found on the way: the Node app kept
inherited names such as `constructor` in a stored `includeUnrankedMaps` (`in` instead of
`Object.hasOwn`), fixed in Node first.

### 2. Reading a profile

Everything the page reads, without the tracker: `src/calc/*` (stats, medals, history, rank,
grade, play time, metadata), `src/scores.ts`, `src/favorites.ts`, `src/standing.ts`,
`src/rank-events.ts`, the export tables, CSV and XLSX. Endpoints: `/api/state` (tracker
fields stubbed until phase 4), `/api/profile`, `/api/scores/:id`, `/api/image/*`,
about-images, `/api/export/*`. The `/api/profile` cache keeps its `total_changes()` and
`data_version` stamp. Port `test/calc.test.ts`, `eligibility`, `medals`, `rank`,
`play-time`, `metadata`, `scores`, `favorites`, `export` alongside.

- [x] `/api/profile`: stats, top, pinned, recent (with runs of quits folded), most played,
      medals (every family, imported ones, the all-mode count), history (pp and rank charts,
      monthly play counts, the Recent feed with medal and rank events), rank estimate, borrowed
      standing, favourites, behind the same database-stamped cache. Identical on every profile in
      every mode on the owner's data, up to 472 KB an answer.
- [x] Two stand-ins until phase 4 (below): lazer's `online.db` is assumed found (`StatusKnown`, which
      decides whether unresolved beatmaps count), and a favourite with no osu! details is drawn
      without the other difficulties `online.db` lists.
- [x] `/api/scores/:id` and its replay download, `/api/image/*`: every score's page identical,
      and the replays and pictures byte for byte. Two parts wait: a score priced before
      breakdowns were kept is recalculated on view by the pp helper (phase 3; none in the
      owner's data), and the card as a PNG needs a browser (phase 5).
- [x] me! images, and the exports: `/api/export` (JSON), `/api/export/scores.csv` byte for byte, and
      `/api/export/profile.xlsx` file for file inside the zip (Node's zlib and .NET's compress the
      same files differently), each in the page's language. Numbers are written as JavaScript writes
      them (`Js.NumberToString`), since an export is text.
- [x] `/api/state`, with the update notes it reads (version order, release notes, what's new,
      the behind notice's dismissal) and the browser finder for Share's image option.

What phase 2 leaves to later phases, each listed in `scripts/api-parity.mjs` with its reason:
`/api/state`'s tracker fields (tracking, the beatmap index, installs; phase 4) and pp helper fields
(phase 3); a score's `calculator` (phase 3); `StatusKnown` and the local favourite card's
`online.db` difficulties (phase 4); the score card as a PNG (phase 5).

### 3. pp in-process

Done (2026-10-28):

- **The helper's own code, called in-process.** `Program.cs`'s request loop body is
  `Program.Respond(line)`, which the loop calls for the separate helper and the app calls
  directly (`dotnet/App/Calc/Official.cs`), with the same JSON requests and answers. Proven a
  pure extraction by `scripts/pp-parity.mjs`: the helper before and after answered all 1820
  corpus requests identically, and `npm run build:pp:local`'s slim check passed.
- **The osu! package versions stay in `tools/PpCalculator/PpCalculator.csproj` alone.** The app
  references that project instead of listing the packages again, so a pp rework is still a
  version bump in one file and the weekly job's procedure is unchanged. (The plan was a shared
  `Directory.Packages.props`; referencing the project needs no change to the job at all.)
- Every pp still carries its osu! release version: `/api/state`'s calculator version and
  outdated count, and a score's `calculator`, now match the Node app's.
- No fallback: when osu!'s code cannot be loaded there is no calculator and no pp, as before.
  A failure in-process is an error answer per request, as over the pipe. A stack overflow or
  running out of memory would end the app, which the launcher then reports. Accepted: neither
  has ever happened with the helper.

Moved to phase 5, since Settings switches it: the calculator built from the player's own osu!
source (5.70), which stays a separate process. Until then a configured source means no
calculator, and Settings says why.

### 4. Tracking

The tracker and everything it reads: `src/osr.ts` (or osu!'s own `LegacyScoreDecoder`, if it
answers identically on the replay corpus), `src/tracker/*`, `src/clients/*` (detect,
discover, beatmaps index, lazer log, McOsu, osu-web, sessions), `src/tracking-filter.ts`'s
matching half, `src/player-identity.ts`, `src/built-replays.ts`, `src/replay-writer.ts`,
`src/score-entry.ts`. Ingestion stays serialised through one queue. File watching keeps the
`watchablePath` rule: a non-canonical path never reaches `FileSystemWatcher`.

Each part below is checked against the Node app's own code on the owner's files by
`scripts/port-checks.mjs`, which asks the C# app through `--dev` commands that nothing else uses.

- [x] The replay parser (`Replays/Osr.cs`): every replay the owner's profiles know of, and every
      file in osu!stable's `Data/r`, read to the same fields (607 of 607). `src/osr.ts` stays the
      model rather than osu!'s `LegacyScoreDecoder`, which reads a replay into osu!'s own score
      objects rather than the fields the tracker stores.
- [x] Finding osu! (`Clients/Detect.cs`, `Clients/Discover.cs`): the installs and candidates
      startup finds, and the Rescan button's full search (registry, shortcuts, every drive),
      identical. Paths are joined as Node's `path` joins them (`NodePath.cs`).
- [x] The beatmap index and resolver (`Clients/Beatmaps.cs`): the index built from nothing, every
      row identical (14,820 beatmaps, 59,024 lazer files remembered as not beatmaps), and every
      beatmap the profiles have played resolved to the same answer and cached row (681 of 681).
      SQLite is shared by threads here, so every database call holds one lock, and the indexer
      holds it for each slice of work as Node's single thread did.
- [x] Ingesting a replay (`Tracker/Ingest.cs`), with what it decides on: grades and accuracy,
      mods (stable's bits both ways, McOsu's mods), pricing (`Tracker/Pricing.cs`), whose play
      it is (`PlayerIdentity.cs`, the sessions osu! is signed in as), the filter's matching half,
      duplicates under another record, and declined plays. Every replay the owner's profiles know
      of, ingested by both apps into fresh profiles, gives the same outcome and the same rows
      (607 of 607): once as a re-ingest, and once as an import with the owner worked out and a
      filter that turns plays away on every criterion (492 added, 108 filtered, 1 another
      player's). JSON is written as `JSON.stringify` writes it (`JsonText`), numbers and key
      order included, since mods and statistics are stored as JSON.
- [x] McOsu's `scores.db` and the replays built from it (`Clients/Mcosu.cs`,
      `Replays/ReplayWriter.cs`): the real file from the tests and generated ones reaching every
      branch of the format read to the same plays, and the built replays identical byte for
      byte; then ingested by both, priced on beatmaps this machine has, with McOsu's rates,
      overrides and own mods (8 of 8).
- [x] lazer's log and unfinished plays (`Clients/LazerLog.cs`, `Tracker/Incomplete.cs`).
- [x] The tracker (`Tracker/Tracker.cs`): one queue for every write, the watchers
      (`Tracker/Watchers.cs`: replays, lazer's live log, McOsu's scores files, stable's Songs),
      Import past plays and its preview (`Tracker/Backfill.cs`), catch-up, Track anyway,
      recalculation and the startup repairs (`Tracker/Recompute.cs`), wired into startup as
      src/main.ts runs them (`Startup.cs`). An import of everything on the owner's machine by both
      apps into fresh profiles, with the owner worked out and a filter on, gives the same preview,
      the same result and the same rows: 73,704 files walked, 2,273 scores, 136 unfinished plays
      from lazer's logs, 401 filtered and 98 replays of other players turned away. With both
      apps tracking, every `/api/state` answer matches, the tracker's, the index's and the installs'
      fields included.
- [x] Found on the way: the sort of other players' names used `localeCompare`, whose order is the
      machine's locale, so it differed between computers. Fixed in Node first (`compareNames`).
- Left for phase 5, since each comes with an endpoint that writes: replays built from a score's
  osu! link or entered by hand, and pricing the scores imported from osu! from their own
  numbers at startup (`src/score-entry.ts`, `src/built-replays.ts`, `src/clients/osu-web.ts`),
  and the live feed the tracker's events go to.
- A read-only copy (the default until the switch-over) finds osu! and reads `online.db`, but
  tracks nothing: tracking is writing.

### 5. Everything that writes

The calculator built from the player's osu! source (5.70, `src/pp-source.ts`,
`src/calc/source-helper.ts`), a separate process as now. Every POST/PUT/DELETE endpoint, the
SSE feed (`/api/events`, same event names and payloads),
backup and restore, uploads, screenshots (Chrome over CDP), start with the computer,
the update checker and its installer half (`src/update/*`), the pp source switch.

#### Where phase 5 stands (2026-10-29): done

Each proven by the parity script's write stage (below) and ported tests:

- [x] **The live feed** (`Http/LiveFeed.cs`): `/api/events` with `retry: 2000`, a ping every
      20s, and every tracker event under Node's names and payloads. Each page has its own queue,
      so none is held up by another or sees events out of order.
- [x] **Request bodies** (`Http/WriteApi.cs`): `JSON.parse(raw || '{}')`, and anything but an
      object refused with 400 `expected a JSON body`; a handler's exception is a 500. Fixed in
      Node first: a `null` or non-object body used to reach a handler that read a field of it
      before its first await, and the TypeError ended the app.
- [x] **The local writes**: `/api/welcome`, `/api/settings` POST (with `retrackOwnNames`),
      `/api/app-config` POST (into config.json read afresh), `/api/tracking`, `/api/scores` POST,
      `/api/declined` POST (track, delete, delete-all), `/api/profiles` POST,
      `/api/profile/reset`, `/api/backfill` and its preview, `/api/recompute` (one profile),
      avatar and banner PUT, `/api/about-image` PUT, `/api/replays` upload, `/api/identity`
      `suggestions`, `unlink` and `clear-image`, `/api/installs` (`Clients/Folders.cs`),
      `/api/startup` (`StartWithComputer.cs`), `/api/data-folder/open`.
- [x] **Startup writes**: `seedSeenVersion`, `offerWelcome` on a first run,
      `syncFavoriteSharing`.
- [x] Found on the way: Microsoft.Data.Sqlite refuses to bind NaN, where SQLite and node:sqlite
      make it NULL (`Number(body.id)` of a missing id); and the C# file times rounded the last
      digit of `mtimeMs` differently, so lazer's `online.db` stamp differed (`Js.MtimeMs`).
- [x] **osu!'s website** (`Clients/OsuWeb.cs`): every request through one gate, one a second,
      waiting as long as osu! asks on a 429. Built on it: `/api/favorites` POST, `/api/identity`
      `lookup`, `link` and `import` (`Tracker/OnlineImport.cs`: best performances, pins,
      standing, medals), `/api/declined` `its-me`, `/api/score-link` and its `/check`,
      `/api/beatmaps/search` and `/find`, `/api/manual-score` (`ScoreEntry.cs`), the imported
      scores priced here at startup and by `/api/recompute`'s `all`, and the rank event watcher
      (`RankEvents.cs`). The parity script imports the owner's own account into a profile made for
      it, one app at a time.
- [x] Found on the way: osu-web.ts read a status, mode or image type through `in` or a plain
      index, so `constructor` was a value; fixed in Node first (`Object.hasOwn`). lazer's block in
      a built replay is compressed as lzma-js compresses it: SharpCompress's encoder with
      lzma-js's mode 1 (64 KB dictionary, BT2, an end marker) and Java's text encoding gives the
      same bytes (`ReplayWriter.LazerBlock`, pinned by `BuiltReplayTests`).
- [x] **Backup and restore** (`Backup.cs`, `Http/BackupApi.cs`): `/api/backup`, `/api/restore` PUT,
      DELETE and apply, and `applyPendingRestore` then `markRunning` at startup. Zips are read as
      well as written (`Zip.ReadEntries`, `EntryData`). The parity script compares the two apps'
      backups file for file, the database in them table by table.
- [x] **Screenshots** (`Http/Screenshot.cs`): `/api/screenshot` and a score card's `/screenshot`,
      Chrome or Edge over the DevTools protocol, one capture at a time. The parity script asks
      each app in turn (they share the debugging port) and compares the pictures' size.
- [x] **The updater** (`Update/Updater.cs`, `Http/UpdateApi.cs`): the GitHub check, the waiting
      build (`data/update/ready.json`), install at a deliberate quit and at a start, the hand-off
      to the release's own swapper, `pruneUpdateLeftovers`, Auto-update and the launcher's
      metered message, `/api/update*`, and `/api/app`'s `update` and `updating`. "Packaged"
      means `app/osu-local-profiles-app(.exe)` is beside `package.json` (phase 6's
      `nativeAppFor`), so a source checkout and the parity copies are refused as Node's are.
      Releases unpack with `Zip.Extract`, which keeps Unix modes.
- [x] **The pp source switch** (5.70; `PpSource.cs`, `Calc/SourceHelper.cs`): `/api/pp-source`
      and its `pp-source` events, the build from the player's clone, and `startupCalculator`.
      That helper stays a separate process (`HelperProcess` in `Calc/Official.cs`: a ready line
      first, one JSON request per line, 30s timeouts, "calculator exited" when it dies); the
      release is still in-process. What prices now is the tracker's calculator
      (`ServerOptions.CalculatorVersion`), since a switch replaces it. The build itself, against
      a real clone, is checked by hand as in Node (roadmap 5.70).
- [x] **Writable by default**: `--writable` and the read-only mode are gone, and so is the 501
      for unported paths: an unknown `/api/` path is a 404 `not found`, as Node's static files
      answer it.
- [x] Found on the way: `NodePath.Resolve` kept a trailing separator that `path.resolve` drops,
      so a folder added in Options as `C:\osu\` was stored differently. And a `helper.json` whose
      `source` is not text threw at a Node launch (`readSourceHelper`, fixed in Node first). The
      parity script's requests went through `fetch`, which gives up when an answer's headers take
      more than five minutes, as the account import does: it uses `node:http` now.

#### Hand-off (2026-10-29)

Pushed to `main`. Phase 5 is done: the last parity run matched every answer. Phase 7
(packaging) is done: built and checked on all three platforms, listening on the loopbacks only.
Phase 8 is rehearsing: Windows done, macOS and Linux next (see its section).

**Pitfalls met this session:**

- A JavaScript `replace()` replacement string treats `$$` as one `$`: pass a function
  (`s.replace(a, () => b)`) when editing C# with node. A template literal turns `\\n` into a real
  newline and `\r` into a carriage return: write those lines with the editor instead.
- The file-writing tool turns `﻿` into the character itself, in regexes too: use
  `(char)0xFEFF`, or `Js.IsSpace` for JavaScript's whitespace.
- lzma-js's mode 1 is its first table entry (64 KB dictionary, BT2), not 1 MB.
- Both apps' screenshots use Chrome's debugging port 9455, and every step that asks osu! or
  GitHub must not double the rate: mark such parity steps `sequential`.
- After `--keep`, or a stopped run, unlink the work folder's junctions (`node/web`,
  `node/node_modules`, `node/tools`, `cs/web`) before deleting it.

**Checking writes.** `scripts/api-parity.mjs` ends with a write stage (`writeSteps`): the same
requests in order to both apps, each answer compared and then the answers it should have
changed, both live feeds' events, and at the end every table of both copies (the moments each
app wrote left out: `MOMENTS`), config.json, and the pictures and uploads file for file. Add each
newly ported write there.

The copies' databases point at uploads in the real `data/replays/`, and letting go of a play
(deleting a declined play, a reset, Track anyway on one already there) deletes its upload once
nothing points at it. So the stage empties and deletes only in a profile it makes for that, picks
declined plays with no upload, and fails with `LOST` if any file in the real `data/replays/` went
missing. The copies turn catch-up off for the same reason. With `--keep`, the work folder holds
junctions into this checkout (`web`, `node_modules`, `tools`): unlink them before deleting it.

**Commands:**

- `npm run check`: the Node typecheck and tests. Run it before every commit.
- `npm run check:port`: the C# tests.
- `node scripts/api-parity.mjs`: every API answer of both apps (about 15 minutes: it imports the
  owner's osu! account into a scratch profile, one app at a time).
- `node scripts/port-checks.mjs [--only <check>]`: replays, index, resolve, ingest, mcosu,
  backfill and discover against the Node app's own code (about 15 minutes in all).

**Pitfalls met so far:**

- The file-writing tool turns `\uXXXX` escapes into literal characters. Write `(char)0x2028`,
  or patch the file with node using `String.fromCharCode(92)`.
- Never put backticks in a shell command: the shell runs them. Use the editor for Markdown and
  JavaScript template literals.
- `InvariantGlobalization` is on, so culture-aware comparison is ordinal. Port any
  `localeCompare` as an explicit rule, fixing it in Node first.
- node:sqlite binds every JavaScript number as REAL. That only matters for a TEXT column.
- SQLite is shared by threads in C#. Every `Database` call holds one re-entrant lock; use
  `db.Serialized` for multi-statement work. Never call a callback while holding a watcher's lock
  (a deadlock with `BeatmapResolver.OnMiss`).

### 6. Updater bridge, in a Node release

This can be done at any time, and should ship well before phase 8, so that most installs
already have it when the C# release appears. Findings it is based on:

- The swap already removes every old file. `scripts/apply-update.mjs` moves everything but
  `data/` and `.rollback-*` aside, copies the new build in and deletes the old copy.
- The tray launcher already starts whichever launcher is at its path after a swap
  (`relaunchAfterSwap`), so a new launcher that runs the C# app takes over by itself.
- **What breaks:** every installed app checks the download for `node.exe`, `src/`, `web/`,
  `package.json` and the launcher (`verifyStaged`), and then runs the new build's
  `node.exe scripts/apply-update.mjs` (`handOff`). A build without Node fails both.

What was built (2026-10-28):

- **The launcher swaps** (`tools/launcher/swap.go`): `--apply-update` with `apply-update.mjs`'s
  arguments, doing the same swap with the same log lines and outcome (`OK: updated to ...`,
  which `updatedToFromLog` reads). `relaunchPlan` is ported with `test/relaunch.test.ts`'s
  cases. Two deliberate differences: a staged `data/` is never copied in, and neither are a
  release's stand-ins (phase 7).
- **A release without Node is marked by its app**, `app/osu-local-profiles-app(.exe)`, so a Node
  release that only lost `node.exe` is still refused. `verifyStaged` then asks for
  `package.json` at the right version, `web/` and the launcher; `swapperFor` picks the
  launcher's `--apply-update`. Node releases are swapped by their script exactly as before.
- **Tested for real**: `test/launcher.test.ts` builds the launcher and swaps a Node install to a
  staged release without Node, asked both as `--apply-update` and as
  `<runtime> scripts/apply-update.mjs ...`, on all three systems in CI.
- **This only helps once installed.** It reaches players in the next Node release; phase 8
  should come several releases later, and phase 7's stand-ins cover anyone who skipped them.

### 7. Packaging

`npm run package -- --native` builds the C# package; `npm run package` is still the Node
release, unchanged. CI's `package-native` job builds it on all three systems and keeps the zip
as a workflow artifact for 14 days, never on a release.

#### Where phase 7 stands (2026-10-29)

- [x] **The app, self-contained, in `app/`** (`buildCheckedApp` in
      `scripts/build-pp-helper.mjs`): published per platform and pruned as the full helper is
      (osu!'s resources, BASS, ffmpeg, SDL, the translation folders). Then
      `scripts/pp-parity.mjs` asks it every request it asks the full helper, through
      `--dev pp-helper` (the helper's protocol answered in-process), and the build fails unless
      every answer is identical: the app resolves osu!'s dependencies beside its own, and a
      library at another version would otherwise price plays differently without saying so.
      On Windows: 1,820 of 1,820 identical.
- [x] **`--check-only`**, as Node's: finds osu!, loads the calculator, says so and exits. The
      package starts the packaged app with it from another folder before it ships.
- [x] **The launcher runs `app/` when a release has it** (`nativeRelease`, `appCommand` in
      `plan.go`): by absolute path, with no arguments; Node on `src/main.ts` otherwise. A
      release without Node is judged by its app alone in `missingFiles`, so the stand-ins never
      cover a missing app. macOS lifts the quarantine when the app carries it.
- [x] **Stand-ins for installs that never got the bridge**: `node(.exe)` is a copy of the tray
      launcher (signed on its own on macOS), `src/README.txt` and `scripts/apply-update.mjs` are
      placeholders. Every release from 1.14 checks the download for `package.json`, `src`,
      `web` and the runtime (and from 1.17 the launcher), runs the downloaded runtime on the
      downloaded script, and keeps Unix modes when it unpacks. The package checks the stand-in
      answers `--version` as this release's launcher.
- [x] `start.sh` and the `.command` keep their names, and check and run the app
      (`launcherFor(os, node, true)`); the README says what is included (`readmeFor(os, true)`).
- [x] Still four zips: the native package has the Node one's name, as the release replacing it
      will.
- [x] Tried for real on Windows, untrimmed and trimmed: the package's tray launcher started the
      app, which found osu!,
      indexed 73,848 files, tracked, priced with osu! 2026.916.0, and stopped with its launcher
      on Quit.
- [x] **Trimmed, only where proven** (decided 2026-10-29): each build makes the app twice and
      ships the trimmed one only if, on that platform, it answers every pp parity request and
      every `scripts/api-parity.mjs` answer as the untrimmed one does; the untrimmed one
      otherwise, with the reason, as a CI warning. Trimmed as the slim helper is
      (`SLIM_PUBLISH_ARGS`: partial, so the app's own assembly and osu!'s stay whole, with
      reflection-based JSON on), and pruned of the slim helper's natives except SQLite's, which
      the app opens. The API check needs no osu! install: `scripts/parity-data.mjs` builds a
      stand-in osu!stable install from the pp check's generated beatmaps and replays, the
      untrimmed app imports it (19 scores in all four rulesets, priced), and
      `api-parity.mjs --reference <untrimmed> --app <trimmed>` compares the two on that (213
      answers on Windows). Before settling on it, the trimmed app also matched the Node app on
      all 840 answers on the owner's data.
- [x] **Built and checked on all three platforms** by CI's `package-native` job (2026-10-29):
      each ships trimmed, identical to the untrimmed app on every pp and API parity request.
      The app is 70 MB on Windows, 75 MB on Linux and 72 MB on macOS. Three macOS runs in four
      froze on `/api/screenshot`, the whole runner with them (no step timeout fired, no log
      kept), while its Chrome rendered the picture. So on GitHub's macOS runners the build's API
      check leaves the two pictures out (`--no-screenshots`); Windows and Linux check the same
      capture code. A capture also has a minute now in both apps (`CAPTURE_LIMIT_MS`), and
      api-parity's requests 20 minutes of silence.

**Measured on Windows, 1.32.0, against the numbers at the top:**

| | Node release | C# untrimmed | C# trimmed (ships) |
| --- | --- | --- | --- |
| Installed | 161 MB | 166 MB (app 149) | 87 MB (app 70) |
| Zipped | 62 MB | 72 MB | 37 MB |
| Memory, idle | 125 + 32 MB (helper) | 107 MB | 87 MB |
| Memory, peak while indexing | 125 MB | 284 MB | 275 MB |

Untrimmed, the package was bigger than the Node one: the Node release ships the slim pp helper
(58 MB), and the app carries the full one's files plus ASP.NET Core. The peak while indexing
(73,848 files, falling back under 110 MB by the end) is worth a look: the C# indexer holds more
at once than Node's.

### 8. Switch-over release

- **Rehearse on a test repository first.** The updater reads its repository from the
  installed `package.json` (`repoFromPackage`), so installs of old versions pointed at a
  private test repository can update to a C# build published there, without touching the real
  releases. Run it from at least: the oldest version with an updater, 1.16 (last before the
  tray restarts on Windows), the last release before the bridge, and the bridge release. On
  each: the update installs, old files are gone, data is intact, the app comes back from the
  tray, and the next update after that works too.
- macOS and Linux get the same rehearsal (CI runners and a Linux VM; the `.app` bundle is the
  case to watch).
- Then a normal release: changelog says what changed for players (smaller download, nothing
  else to do).

#### Where phase 8 stands (2026-10-29)

The test repository is `jonathant09/osu-local-profiles-switchover-test`, public because the
updater asks GitHub without signing in (a private one has "no published releases"), with full
releases because old updaters skip pre-releases. Delete it once the rehearsal is over. Its
builds come from a worktree of `main` with `package.json`'s version and repository changed:
1.33.0 is a Node release with the bridge, 1.34.x are C# releases.

- [x] **Windows, every path** (old installs' `package.json` pointed at the test repository,
      each on its own port):

      | From | To | How | Result |
      | --- | --- | --- | --- |
      | 1.16.0 (started as its `.bat` does) | 1.34.0 | Install now | came back from the tray launcher |
      | 1.32.0 (tray) | 1.34.0 | Install now | came back; the old launcher handed over and exited |
      | 1.33.0, the bridge (tray) | 1.34.0 | When I quit | installed at quit, stayed closed, then started as 1.34.0 |
      | 1.33.0, the bridge (tray) | 1.34.2 | Install now | came back |
      | 1.34.2, from the bridge | 1.34.3 | Install now | came back |
      | 1.34.2, a fresh download | 1.34.3 | When I quit | installed at quit; the stand-ins went with the swap |

      Each time: `OK: updated to` in `data/update.log`, no Node files left (`node.exe`, `src`,
      `scripts`, `node_modules`), the profiles, their dates and a tagline as before, the
      beatmap index still answering, and Quit stopping launcher and app.
- [x] **Found and fixed: no C# install could update.** Dropping a waiting build deleted
      `data/update/ready.json` with `File.Delete`, which throws when `data/update` is gone, and
      every C# install sweeps it away at start (1.34.0 refused 1.34.1). Hence 1.34.2 and 1.34.3.
- Notes, none needing a change: when the old tray launcher is still running, the swap cannot
  remove the rollback copy (its `.exe` is locked) and the new app's startup sweep does. A zip
  made by Windows PowerShell's `Compress-Archive` on this machine has backslashes in its paths
  (the release zips, built by CI, do not); every updater unpacked it anyway. 1.16's `.bat`
  goes with the swap, as it already did on any update to 1.17 or later.
- [ ] macOS and Linux: the same, on CI runners (the `.app` bundle is the case to watch).

### 9. Removing the Node app

`src/`, `test/`, the Node scripts that only served it, `package.json`'s Node parts, and the
Node rules in `CLAUDE.md`. `package.json` stays as the version file if nothing better is
chosen in phase 7. `docs/architecture.md` is updated as each phase lands, not here.

## JavaScript in C#

Differences that change answers, and what the port does about each. `dotnet/App/Js.cs` holds
the helpers.

- **`Number(x)`**: `Js.ToNumber` follows the spec for strings (trimmed, empty is 0, hex,
  `Infinity`), booleans, null, and arrays (`[]` is 0, `[5]` is 5). Undefined is NaN.
- **`Math.round`** rounds halves up: `Js.Round`, never `Math.Round`.
- **`trim()`** strips a different whitespace set from .NET's `Trim()`: `Js.Trim`.
- **`toUpperCase()`/`toLowerCase()`** use full Unicode case mapping (`ß` becomes `SS`, a final
  `Σ` lowers to `ς`, `İ` to `i̇`). `Js.ToUpper`/`Js.ToLower` handle the cases that change a
  result here.
- **Regex `$`** matches before a final newline in .NET. Use `\z`.
- **Sorting**: JavaScript's sort is stable; use `OrderBy`, never `List.Sort`/`Array.Sort`, where
  equal keys can occur.
- **`Date.parse`**: `Js.DateParse` handles ISO dates (date-only is UTC, date-time without an
  offset is local), and falls back to .NET's parser for anything else, which may differ.
- **JSON**: answers are compared as parsed values, so number formatting and escaping don't
  matter. Strings are written unescaped like `JSON.stringify` (`UnsafeRelaxedJsonEscaping`). A
  lone surrogate (text cut in the middle of an emoji) is written as U+FFFD, where JavaScript
  keeps it; accepted.
- **NaN and Infinity** are written as `null`, as `JSON.stringify` writes them (.NET would throw).
- **SQLite values** come back as node:sqlite returns them through `Row`: whole numbers, decimals,
  text or null, read with the TypeScript's own casts and `=== 1` tests.
- **NaN bound to SQL** is NULL, as SQLite and node:sqlite make it, so `WHERE id = ?` with
  `Number('x')` finds nothing. Microsoft.Data.Sqlite refuses NaN; `Database` binds it as NULL.
- **An id from the page** is a JavaScript number, so it can be NaN or 1.5: pass it on as a
  `double`, as the TypeScript does, and the refusal names it as `String(id)` would.
- **Object key order**: kept where it is visible (settings follow `DEFS`' order); the parity
  script ignores it.
- **`in` on an object** also finds inherited names (`"constructor" in {}` is true). Where the
  TypeScript used it to check a name against a table, the C# checks the table's own keys; fix
  the TypeScript to `Object.hasOwn` when found.
- **Paths**: `path.join` and `path.resolve` normalise where `Path.Combine` doesn't, and
  `path.resolve` drops a trailing separator (`C:\osu\` is `C:\osu`): `NodePath.Join` and
  `NodePath.Resolve`, wherever a path is stored or compared.
- **Writing the C# sources**: write special characters as code points, such as `(char)0x2028`,
  never as escape sequences in string literals or as the characters themselves. A literal U+2028
  or U+2029 is a line break to the C# compiler, and some editing tools turn escapes into literals.
- **Integers**: SQLite integers are `long`. Values past 2^53 lose precision in JavaScript and
  not here; nothing stores such values.

## Decisions

- **Kestrel** (ASP.NET Core) for HTTP. `HttpListener` on Windows goes through http.sys, which
  needs admin rights to accept anything but `localhost` as the host, and the app is reached as
  `localhost`, `127.0.0.1` and `[::1]`. Kestrel adds a few MB; measure in phase 7.
- **Listening** (decided 2026-10-29): on `127.0.0.1` and `[::1]` only, unlike Node's every
  interface, so no other machine reaches the port and Windows shows no firewall prompt. The
  refusal of non-loopback requests stays in code. `::1` is left out only where the machine
  cannot bind it, and a failure to bind either stops the start: not `ListenLocalhost`, which
  carries on with one of the two and a warning.
- **SQLite** through `Microsoft.Data.Sqlite`. Its native library is fine in .NET; the "no
  native modules" rule is about Node.
- **xUnit** for tests, run by `dotnet test dotnet/OsuLocalProfiles.slnx`.

## Open questions

None.
