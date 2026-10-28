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
- `dotnet run --project dotnet/App` serves this checkout's `data/` read-only on its configured
  port. Stop the Node app first, or give the port its own folder with `-- --root <dir>`.
- `src/db/schema.sql` is embedded into the app from where it is, so there is one schema.
- `web/` is served from the install root, as now.
- The weekly maintenance job keeps updating `tools/PpCalculator/PpCalculator.csproj`. Phase 3
  moves the osu! package versions into one place both projects read, and changes
  `docs/automated-maintenance.md` in the same commit.

## Rules while both apps exist

1. **The Node app is the product.** Fixes and features land there first, as now. Anything that
   changes behaviour the C# app already ports gets the same change there, in the same commit
   when it can.
2. **The C# app opens the database read-only** unless started with `--writable`. Until it is
   finished it must not be able to damage real data. The parity script and the tests run it
   writable against copies.
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
| 1   | Foundations                   | in progress |
| 2   | Reading a profile             | not started |
| 3   | pp in-process                 | not started |
| 4   | Tracking                      | not started |
| 5   | Everything that writes        | not started |
| 6   | Updater bridge (Node release) | not started |
| 7   | Packaging                     | not started |
| 8   | Switch-over release           | not started |
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
- [x] Server: listens like Node (all interfaces, dual-stack), refuses every non-loopback
      request, `isOwnPage`, static files from `web/`, the score page route.
- [x] Endpoints: `/api/app`, `GET /api/settings`, `GET /api/app-config`, `GET /api/declined`,
      `GET /api/data-folder`.
- [x] `scripts/api-parity.mjs`: both apps on copies of one `data/`, every ported endpoint
      compared.
- [ ] Single instance (`src/instance.ts`): a second start finds the first and opens its page.
- [ ] stdin protocol with the launcher (`stopWhenLauncherCloses`, metered messages).

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

### 3. pp in-process

- `tools/PpCalculator/Program.cs` becomes a library the app calls; the console protocol stays
  for the source-built helper (5.70) and for `scripts/pp-parity.mjs`.
- One place for the osu! package versions (`Directory.Packages.props` at the repo root), read
  by both projects. Same commit: `docs/automated-maintenance.md` step 2 and
  `docs/maintaining.md` *Keeping pp current*, so the VM job edits the new file.
- Every pp still carries its osu! release version and breakdown.
- A helper failure in-process is an exception per score, as now. A stack overflow or running
  out of memory would end the app, which the launcher then reports. Accepted: neither has
  ever happened with the helper.

### 4. Tracking

The tracker and everything it reads: `src/osr.ts` (or osu!'s own `LegacyScoreDecoder`, if it
answers identically on the replay corpus), `src/tracker/*`, `src/clients/*` (detect,
discover, beatmaps index, lazer log, McOsu, osu-web, sessions), `src/tracking-filter.ts`'s
matching half, `src/player-identity.ts`, `src/built-replays.ts`, `src/replay-writer.ts`,
`src/score-entry.ts`. Ingestion stays serialised through one queue. File watching keeps the
`watchablePath` rule: a non-canonical path never reaches `FileSystemWatcher`.

### 5. Everything that writes

Every POST/PUT/DELETE endpoint, the SSE feed (`/api/events`, same event names and payloads),
backup and restore, uploads, screenshots (Chrome over CDP), start with the computer,
`/api/quit`, the update checker and its installer half (`src/update/*`), the pp source switch.
The database opens writable by default from here.

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

The bridge:

- The Go launcher gains `--apply-update`, taking the same arguments as `apply-update.mjs`
  (`--install`, `--staged`, `--pid`, `--archive`, `--launcher-restarts`, `--no-relaunch`) and
  doing the same swap: wait for the pid, move aside, copy in, read back, delete the rollback,
  write `data/update.log`, relaunch per `relaunchPlan`. Its tests port `test/relaunch.test.ts`.
- `handOff` runs the staged launcher's `--apply-update` when the staged build has one, and the
  script otherwise. `verifyStaged` accepts a build that has the launcher and a `package.json`
  with the right version, with or without `node.exe` and `src/`.

### 7. Packaging

- `scripts/package.mjs` publishes the app self-contained per platform, partially trimmed only
  if a parity check proves it answers identically (the rule 5.60 set for the pp helper).
- The launcher runs the app beside it by absolute path, as now; `runtimeName` and
  `missingFiles` change to the new executable.
- **Stand-ins for installs that never got the bridge.** Their updater still demands Node's
  files, and always downloads the latest release, so they can't be routed through phase 6's.
  The package carries `package.json` (it stays the version file anyway), an `src/` holding a
  placeholder, `scripts/apply-update.mjs` as a placeholder, and a file named `node.exe` (or
  `node`) that is the Go launcher's swap mode under another name, accepting
  `scripts/apply-update.mjs --install ...`. The swap leaves the stand-ins out of the install.
- `start.sh` and `Start osu! local profiles.command` keep their names (1.14-1.16 launchers run
  them after an update).
- Still four zips and nothing else (5.69).
- Measure the zips and memory against the numbers at the top.

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
- **Object key order**: kept where it is visible (settings follow `DEFS`' order); the parity
  script ignores it.
- **`in` on an object** also finds inherited names (`"constructor" in {}` is true). Where the
  TypeScript used it to check a name against a table, the C# checks the table's own keys; fix
  the TypeScript to `Object.hasOwn` when found.
- **Unported endpoints** answer 501 in the port, where Node answers 404 for a path it doesn't
  know at all.
- **Writing the C# sources**: write special characters as code points, such as `(char)0x2028`,
  never as escape sequences in string literals or as the characters themselves. A literal U+2028
  or U+2029 is a line break to the C# compiler, and some editing tools turn escapes into literals.
- **Integers**: SQLite integers are `long`. Values past 2^53 lose precision in JavaScript and
  not here; nothing stores such values.

## Decisions

- **Kestrel** (ASP.NET Core) for HTTP. `HttpListener` on Windows goes through http.sys, which
  needs admin rights to accept anything but `localhost` as the host, and the app is reached as
  `localhost`, `127.0.0.1` and `[::1]`. Kestrel adds a few MB; measure in phase 7.
- **Listening**: on all interfaces, dual-stack, refusing non-loopback requests in code, as
  Node does. Binding to both loopbacks instead (`ListenLocalhost`) would avoid the Windows
  firewall prompt; decide in phase 7, and keep the refusal in code either way.
- **SQLite** through `Microsoft.Data.Sqlite`. Its native library is fine in .NET; the "no
  native modules" rule is about Node.
- **xUnit** for tests, run by `dotnet test dotnet/OsuLocalProfiles.slnx`.

## Open questions

- Whether osu!'s `LegacyScoreDecoder` can replace `src/osr.ts` (phase 4): only if it reads
  every replay in the corpus to the same fields.
- How trimming affects reflection-based JSON (phase 7): source-generated serialisation, or
  partial trimming that leaves the app's own assembly alone.
- The firewall prompt (above).
