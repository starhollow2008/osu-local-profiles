# Architecture & Project Lore

## osu! file format findings (verified against a 2408-replay corpus)

**lazer appends an extended block to every `.osr`.** After replay frames comes an `int64` online score id, then `int32` length, then LZMA-compressed JSON blob (`LegacyReplaySoloScoreInfo`) holding authoritative mods, statistics, and rank. The legacy header alone reports rank `F` for plays that actually ranked A. `osu-parsers` reads only the legacy header — we don't use it.

- lazer replays: version >= 30000001; stable replays lack the block
- ~35% of a typical store is stable-format (older imports)
- Legacy mod bitmask *is* correct (AP bit was genuinely set)

**lazer accuracy ≠ stable formula.** lazer judges slider tails (150) and large ticks (30) toward accuracy. Formula: `sum(statistics × value) / sum(maximum_statistics × value)`. Values in `HIT_VALUES` in `src/calc/grade.ts`.

**lazer stores files by SHA-256, not beatmap MD5.** A score references beatmap by MD5, so matching requires the MD5 index in `osu_files` (`src/clients/beatmaps.ts`). Building it: sniff every file in store once (~63k files: 9s warm, ~140s cold read). Entries immutable, never re-read. Stable's `Songs` filters by `.osu` extension instead.

**The index runs beside the app, never before it.** `indexBeatmapFiles` works in 25ms slices, commits before every pause (shared connection; holding a tx across a pause swallows other writes). `Tracker.indexBeatmaps` puts it at head of ingest queue *before* watchers start.

**`online.db`** is a plain SQLite file shipped by lazer: `osu_beatmaps(beatmap_id, beatmapset_id, checksum, approved, ...)`, ~234k rows, `checksum` = beatmap MD5. Open read-only, never write. Cross-platform; fetched asynchronously by lazer when absent, refreshed if >1 month old. Not guaranteed to exist on any platform.

**A `.osu` section ends at the next line beginning with `[`, never at the next `[`** (`osuSection` in `src/clients/beatmaps.ts`). `[` is ordinary inside values — mappers like `cRyo[iceeicee]`, artists tagged `[CV. …]`, audio files named `[HD] …`. The old rule lost or corrupted 327 of 12,811 beatmap names here and filed 23 beatmaps under the wrong mode (roadmap 5.45).

## pp: osu!'s own code

`tools/PpCalculator/Program.cs` references official `ppy.osu.Game.Rulesets.*` NuGet packages. Driven over JSON-lines pipe from `src/calc/official.ts`.

**Hand the replay file, not a reconstructed ScoreInfo.** `LegacyScoreDecoder` sets `IsLegacyScore` from replay version, applies Classic mod to legacy scores, populates `MaximumStatistics`, reads lazer's extended block. Stable scores: `isLegacy=true` with `CL` added (selects classic slider accuracy + legacy miss estimation in `OsuPerformanceCalculator`).

**Difficulty calculator is Relax-aware.** Same RX replay: 6.26★/110.93pp as played, 7.83★/238.54pp mod-removed. `unrankedModPp` setting picks between them. Both stored at ingest (`pp`/`stars` and `pp_nomod`/`stars_nomod`).

**pp calculated for every score, not just ranked.** Eligibility = query-time decision (`src/calc/eligibility.ts`), never stored. `scores` stores facts (`map_status`, `mods_ranked`, `mods_countable`, both pp). `countsSql()` turns settings into predicate. One definition of "counts"; never write `ranked = 1` in a new query.

**Score removal = hide, not DELETE.** Replay stays on disk — a deleted row re-ingests when the file is noticed again. `scores.hidden_at` set instead; `visibleSql()` filters it from *every* query. A removed score leaves play count + level bar too.

**Deleting a removed score for good keeps its key.** Row deleted, but `dedupe_key` written to `deleted_scores` first. Ingest + Import refuse a key listed there (`wasDeleted`). Never delete a score row any other way.

**`tools/pp/` shadows the plain build.** `src/calc/official.ts` prefers it. A stale copy answers old protocol silently. After changing `Program.cs`: run `npm run build:pp:local`, not just `npm run build:pp`. `scripts/build-pp-helper.mjs` shared with `npm run package`.

**Every pp value carries the osu! release.** Helper reports `ppy.osu.Game` version on ready line + each response, alongside `breakdown`. Both in `scores.pp_version` and `pp_parts`/`pp_nomod_parts`. Parts must belong to the pp beside them.

**No fallback calculator.** `rosu-pp` removed on purpose. Reimplementations lag osu!'s reworks.

**Do not trim the helper.** `PublishTrimmed` takes it 113MB -> 36MB but breaks inside osu!'s own graph (`StringEnumConverter`, reading lazer's extended block); .NET's linker warns osu.Game, osu.Framework, Realm, Newtonsoft, AutoMapper and MongoDB.Bson are all trim-unsafe. Measured at 1.13.1. Making it work means a trimmer root descriptor over osu!'s internals, re-verified on every package bump, guarding against a *wrong pp value* rather than a crash. `docs/roadmap.md` 5.44 has the four failures in order and the reproduction.

**After a pp rework:** bump package versions in `PpCalculator.csproj`, run `node scripts/reingest.mjs`.

## Incomplete plays: over half of plays leave no replay

**osu! counts a play it never keeps.** `SubmittingPlayer.submitScore` submits on fail, quit, or retry. No minimum object count — only: token issued, ≥1 non-miss judgement, total score > 0. Quitting before hitting anything is the only discard (`No hits registered, skipping score submission`).

**lazer keeps a score only for maps played to end.** `Player.prepareAndImportScoreAsync` imports when `ScoreProcessor.HasCompleted && GameplayState.HasPassed`, or `forceImport` (fail screen's "Save replay" button). Solo HP-fail, quit, retry write nothing to disk.

Measured: 54 plays started, 45 counted by osu!, 19 replays written. Replay watcher misses ~58%.

**Every rank-F replay = multiplayer.** `MultiplayerPlayer.PerformFail` suppresses failing — runs to end, imports normally. All 22 F replays in corpus judged 100% of hit objects. No partially-played replays on disk.

**Incomplete plays come from lazer's log.** `<lazer>/logs/<session>.runtime.log` + `.network.log`. `Score submission completed!` = osu! accepted the submission → play count agrees with website by construction. Pass detected by screen stack logging `suspended <Player> (waiting on <...>ResultsScreen)`. Verified: fired 19 times, 19 replays on disk.

Log timestamps: **UTC**. Beatmap ID in network log's submission `PUT`, joined to runtime log by token. Multiplayer submits via `/rooms/...`, resolves to no ID (always writes a replay anyway).

**`incomplete_plays` rows are NOT in `scores`.** An abandoned play has no accuracy, combo, mods, pp, or total score. A row of zeroes in `scores` corrupts weighted accuracy, grade counts, ranked score, level bar, medals. Only 4 aggregates read `incomplete_plays`: play count, monthly play counts, Most Played, Recent Plays. `hitsPerPlay` divides by *scored* plays only.

Counting them is not optional (osu! counts them). `showIncompleteInRecent` (`yes` | `collapse` | `no`) only controls listing.

**Offline or signed out, osu! counts nothing — but lazer still says so** (roadmap 5.45). With no token, `SubmittingPlayer.submitScore` logs `No token, skipping score submission`, just before the solo gameplay screen exits (93 of 94 here; the one exception came a few seconds after). That line against a `SoloPlayer#N` screen that did not reach results is an *unsubmitted attempt*. It is never inferred from a token merely being absent; a screen that had a token is never one; `ReplayPlayer`, the skin editor's `EndlessPlayer` and multiplayer screens never are. It is distinct from `No hits registered`, which is osu!'s own discard and stays uncounted.

Stored in `incomplete_plays` with `unsubmitted = 1`, keyed `unsubmitted:<log session>:<screen>:<entered>` (screen numbers repeat within a day). **Recorded always** — the log is only followed live, so an attempt skipped today is gone — and **counted only through `incompleteSql(e)`**, when the profile's `countUnsubmittedAttempts` is on — **on by default**, at the user's call: osu! never received these, so counting them takes nothing from what osu! shows. The Scores note mentions them only once some are recorded.

**Import past plays reads the logs too** (`src/tracker/log-backfill.ts`): counted unfinished plays and unsubmitted attempts from the cutoff on, each kind a separate source beside replays. Preview and import go through the same `checkIncompletePlay`/`checkUnsubmittedAttempt`, so the preview's numbers are the import's. An import naming no sources means replays alone, as before. Every figure that reads unfinished plays goes through it: play count, monthly play counts, Most Played, Recent Plays, Total Play Time, modes with plays.

An attempt has no beatmap id (no submission request), so it is matched by the log's `Game-wide working beatmap updated to` name against `osu_files.name` — lazer's `BeatmapInfo.ToString()`, `Artist - Title (Creator) [Version]`, built from each `.osu`, unique matches only. Measured on 20 real logs: 59 attempts, 59 matched, where the beatmap cache alone matched 12. Needs no `online.db`.

**osu!stable incomplete plays cannot be covered** (measured 2026-09-11, stable `b20260711.1`):

- Logs say nothing about plays (OpenGL init, updater, encrypted auth log only)
- Only trace: per-beatmap "last played" in `osu!.db` — a quit/fail/retry on one diff produced one timestamp between them, flushed minutes later, cannot tell fail from pass
- A pass reaches the app when results screen closes (stable writes replay then)

`renderStableNote` in main.js, `showStableNote` per profile. Do not build a play counter on that timestamp. `ingestIncompletePlay` stays client-agnostic.

## Play tracking filter

Decides whether a play is **written**. Declined play leaves no row anywhere.

- Off by default. Switching it on narrows nothing (every criterion starts widest). `filterNarrows` separate from `enabled`.
- A fact the filter doesn't have never rejects a play (quit/HP fail/retry has no mod list or star rating — those two criteria don't judge it).
- Declined play announced: console line, SSE `filtered` event, toast naming criterion, running count in `/api/state`.

Nine criteria matched against replay, `.osu`, `online.db`. Same answer at live ingest and Import past plays. `scripts/reingest.mjs` must NOT pass a filter.

`online.db` has second table: `osu_beatmapsets(beatmapset_id, submit_date, approved_date, approved)` — 60k rows vs 234k in `osu_beatmaps`. `approved` values 1, 2, 4 only (ranked/approved/loved). Earliest `submit_date`: 2007-10-06 (slider floor).

**Date added = file creation time, never mtime.** Lazer imports keep mtimes from 2019-2021, created 2025-11-06. mtime = beatmap's own age. No creation time → mtime fallback.

Star rating and length judged **as played** (mods included). Beatmap dates and length filled lazily on `beatmaps`: NULL = never looked up, 0 = looked up and unknowable.

## Total Play Time

Follows osu! server rule (`PlayValidityHelper.GetPlayLength`): per play, `min(beatmap total_length / rate speed product, ended_at - started_at)`. Runs on failed scores too.

`src/calc/play-time.ts`: finished score (no start time) uses length/rate (smaller side). Incomplete play uses token time → submission, capped at map length. Rows before `started_at` existed count nothing. Beatmap lengths read lazily into `beatmaps.length_ms` (0 = unreadable).

## Favorite Beatmaps

One request per favourite. `osu.ppy.sh/beatmapsets/<id>` embeds full set as `<script id="json-beatmapset">`. Favouriting fetches once, caches in `beatmapset_details`. Offline: `localCard` in `src/favorites.ts` builds from `online.db`, beatmap cache, profile's own scores. Per profile, survive reset, never written to osu!.

## osu! account link: no API, no credentials

`osu.ppy.sh/users/<name>` redirects to numeric ID, embeds full public user object as `data-initial-data` attribute. Same data as API's `/users/{user}`. No OAuth needed. May change — `src/clients/osu-web.ts` fails loudly rather than returning empty user. One request per button press, copies to `data/`. Nothing on a timer.

## Server: localhost-only, enforced per request

Page can reset/delete profiles and remove scores with no auth. `startServer` refuses any non-loopback request, no switch to turn off. `loadConfig` drops old `shareOnNetwork` key (`RETIRED_KEYS`). Do not bring it back.

**Do not bind to `127.0.0.1`.** Drops IPv6 loopback; `localhost` resolves to `::1` before `127.0.0.1` on Windows → unreachable. Also makes `listen` async, breaks `server.address()` in tests.

## osu-web fidelity

Read `docs/osu-web-fidelity.md` before any "make it look more like osu!" work. Maps every visible region to osu-web LESS/TSX. Carries clone command for `reference/osu-web` (6.5MB sparse, gitignored checkout).

**Values, never files.** osu-web is AGPL-3.0-or-later, this project is MIT. No code/image copied out. Colours, sizes, ratios, wording are facts. `ppy/osu-resources` is CC-BY-NC — cannot use.

Flags from Twemoji (CC-BY 4.0, same source as osu!). Two generated tables: `web/js/mod-definitions.js` (`npm run build:mods`), `web/flags/` (`npm run build:flags`).

## Medal definitions: from osu!, not symmetric

`src/calc/medal-definitions.json` generated by `scripts/build-medal-table.mjs` from osu! profile-page payload. Do not hand-edit.

- Combo + play-count medals exist for **osu!standard only**
- taiko, catch, mania have **hit-count** medals instead
- Star pass/FC medals: 1–10 for standard, 1–8 elsewhere
- **Mod Introduction** is the only other group (user chose it). Rules: mod alone at defaults, system mods + CL ignored, SO in standard only, NC/DC ≠ DT/HT, passes only, Conversion/Fun = lazer-only mod types

Page shows no text for a medal (icons only, groups: Mod Introduction then Skill & Dedication per `ordering`). Hover card: `#medalTooltip`, one shared element positioned in window coords. Header medals figure = account-wide `earnedMedalCount`. Earned medal = Recent-feed event (`medalEvents`) — except rank medals (`dated: false`).

Medals derived from scores on every request, never stored. Full combo needs `beatmap_max_combo` (lazer drops slider ends without breaking combo — "no misses" alone awards FC to a run dropping hundreds). Rows without it: unknown, never guessed.

## Global rank: estimated from sampled curve

Rank from `src/calc/rank-tables/<mode>.json`, built by `scripts/build-rank-table.mjs` from `data.ppy.sh`'s `performance_<mode>_random_10000` dump. Random sample across whole ladder; every user carries actual rank → no modelling needed.

Script streams ~1GB archive through `bzip2` + `tar`, keeps only user-stats table. Interpolation linear in **log** rank (spans 6 orders of magnitude vs 3 for pp).

Labelled as estimate in UI. Allowed where second pp calc is not (stale curve degrades gradually). Refresh: re-run script with newer `--dump` date.

**Country rank deliberately not shown.** 10k sampled users over ~200 countries too thin.

## `fs.watch`: never pass an unresolved path

On Windows, libuv compares filename from `ReadDirectoryChangesW` against the given path and **aborts the process** on mismatch. Junction, drive substitution, or 8.3 short name triggers it. Caught on CI runners (`C:\Users\RUNNER~1\...`).

**Watcher test must let watch come up before first write.** macOS FSEvents thread starts at first `fs.watch`; write during startup is not reported. `await sleep(SETTLED_MS)` after `start()`.

`watchablePath` in `src/tracker/watcher.ts` resolves the directory. Paths reported against configured directory — downstream never sees two spellings.

## Charts: not ordinary SVG

Both charts draw in 0..100 space with `preserveAspectRatio="none"` (responsive without measuring DOM). Everything inside sheared by container aspect ratio (circle = ellipse). Axis labels, hover marker, tooltip: HTML positioned over plot in percentages. osu-web does the same.

Colours/wording from osu-web source: line `@yellow` `#ffcc22` at 2px, tooltip `Global Ranking #123` over `40 days ago`, Play History `Plays 430` over `March 2020`.

Section lists **paged by server**. Page asks for size per section, gets totals. "Show more" needs both "page came back full" AND "total > returned". Recent Plays counts plays but draws rows — collapsed retries are several plays in one row.

## osu!stable specifics (verified on real install)

- **Songs folder can be moved.** Stable writes path to `BeatmapDirectory` in `osu!.<user>.cfg`. `stableSongs` in `src/clients/detect.ts` reads it. Relative values resolve against install dir; stale value falls back to `<root>/Songs`.
- **Signed-in username** only present when "remember" was checked (`Username` field in cfg). `detectLocalSessions` finds nothing for stable → page falls back to manual name entry. Correct behavior.
- **Ranked status for stable plays** comes from lazer's `online.db`. Stable-only install → every beatmap = `UNRESOLVED_STATUS`. pp unaffected (needs `.osu` from Songs). `BeatmapResolver.knowsStatus` = false, `countUnresolved` in eligibility, `countsSql` counts unresolved beatmaps *in addition*. Page says so in Scores note. Beatmap-status settings dimmed. Not a setting — follows what the machine knows.

## Windows: only verified platform

macOS and Linux written, CI-covered, never run against real osu! install. Since 1.10.0: `osx-arm64` + `linux-x64` zips in releases.

**Platform rules:**

1. Platform-varying behavior behind pure function taking platform. `src/clients/detect.ts` takes `DetectEnvironment`, never reads `process` directly.
2. Platform-specific list must fail loudly on empty match. pp helper pruning matches by base name across `.dll`/`.dylib`/`.so`, warns when nothing pruned.

**Windows launcher**: `.\node.exe`, never bare `node.exe`. `cmd` searches PATH when `NoDefaultCurrentDirectoryInExePath` is set (Claude Code's shell sets it). `test/package-files.test.ts` pins the `.\`. Test a `.bat` as `.\x.bat`.

**`cmd` spawns need `windowsVerbatimArguments`.** Node quotes by C runtime rules; `cmd` doesn't unescape. `start` title `""` must arrive as `"\"\""`. `src/browser.ts` builds line as pure function. Updater relaunch = same trap.

`config.installRoots`: escape hatch for unanticipated layouts (macOS/Linux stable via Wine wrappers). Was documented + printed but read by nothing at all.

## Updater: rewrites app's own directory

`src/update/` + `scripts/apply-update.mjs`.

**Four safety properties:**

1. `data/` never touched. `dataDir()` = `<install>/data`. Swap enumerates other top-level entries and steps around it.
2. Nothing deleted while still needed. Outgoing files *moved* to `.rollback-<stamp>/`. Swap deletes it once new build is on disk and manifest reads back (~200MB, keep insures against passed risk). Way back from bad release: download previous.
3. Nothing swapped until new build verified: download size, unpacked tree shape, version in `package.json`.
4. Source checkout refuses (`start.bat` = `node src/main.ts`). Both `.git` + missing bundled runtime checked.

**Swap runs from staged build using its own runtime.** On Windows, running `node.exe` locked by the process. `scripts/apply-update.mjs` copied into every package.

**Relaunch: in a console the user can stop it from, or not at all.** A console app's only off switch is its console. `detached` = `DETACHED_PROCESS` on Windows (no console); on macOS/Linux a process the swapper starts has no terminal. Up to 1.13.2 the app came back exactly so on macOS/Linux: no TTY, output to `/dev/null`, outliving its terminal.

- **Unix launchers restart the app themselves.** They run it (no `exec`) with `OSU_LOCAL_PROFILES_LAUNCHER=restarts`; the app passes `--launcher-restarts` to the swapper, writes its pid to `data/update/swapper.pid` and exits 75 (`RESTART_EXIT_CODE`); the launcher waits for that pid and re-runs itself in the same terminal. `test/relaunch.test.ts` runs the real launcher under `sh`.
- **Otherwise the swapper relaunches, per `relaunchPlan`** (pure, in `scripts/apply-update.mjs`): Windows `cmd /d /s /c "start "" cmd /d /c ""<bat>"""` — a `.bat` handed straight to `start` runs as `cmd /K`, leaving the window open after the app stops; macOS `open` on the `.command`; Linux a terminal program from `LINUX_TERMINALS` when `DISPLAY`/`WAYLAND_DISPLAY` is set, else no relaunch, said in `data/update.log`. Never the runtime directly.
- **Windows cannot restart in the launcher:** `cmd` re-reads a running `.bat` from disk by byte offset, and the swap replaces it.
- **The swapper is the new release's; the launcher is the old one's.** The first update from 1.13.2 or earlier always takes the swapper's path.

**Zip reader** is ours (`src/update/zip.ts`): no dependency overhead, avoids `tar.exe` (Windows-only). Refuses zip64, refuses path traversal. Handles backslash separators from own packager.

**Update leaves two ~200MB copies.** Rollback is visible one; other is staged tree in `data/update/`. Swap deletes its own rollback but cannot delete staged tree (running from it; `node.exe` locked). `pruneUpdateLeftovers` at startup clears both. Keeps `data/update.log`.

**One request at startup, never a timer.** `checkForUpdates: false` turns off the app's only outgoing request. Failed check shows nothing.

## me! (BBCode): never trusted

`web/js/bbcode.js` is our renderer (osu-web's library is AGPL; tag semantics only taken). me! imported from anyone's profile → text treated as hostile:

- Escaped first, never parsed as HTML
- Every tag emitted is one written in that file
- Argument validation: colours by pattern, sizes as numbers, links/images by scheme
- Failed/unclosed tag stays visible text

Pasted images: `data/about-images/<profile>/`, named by content (`src/about-images.ts`). `[img]` accepts only that exact local shape.

## Shared web page = the page itself

Share → Save as web page (`web/js/share-copy.js`): saves index.html + CSS + bundled modules (`web/js/bundle.js`) + API snapshot. `web/js/static-mode.js` (main.js's **first** import) serves snapshot in place of app (stand-in `fetch` + no-op `EventSource`).

**Consequences:**

1. Page modules must stay bundleable: named `import { } from './x.js'` + `export function / async function / const / class` only. `test/bundle.test.ts` bundles real page and syntax-checks it. `npm run ui` loads real copy, clicks Show more.
2. Images served by app go through `assetUrl()`. Copy never contains install paths or other profiles.

## Score scales

osu! profile page has lazer scoring switch (on by default). Off = uncapped classic scale. Both from osu!'s code via pp helper: `GetDisplayScore(Standardised)`, `GetDisplayScore(Classic)`, `LegacyTotalScore`. Stored in `scores.score_standard` and `score_classic`. Classic show rule: `legacyTotalScore ?? classicScore`.

`scoreColumn(e)` in `src/calc/eligibility.ts` is the *only* place a query names a score column. Do not write `s.total_score` in a new query (raw replay number, fallback only).

**Stable scores listed with CL.** osu! adds Classic to every legacy score before scoring. `withClassicMod` (`src/calc/pp.ts`) adds it when building rows/cards. `mods_json` keeps what player chose.

**Multi-column UPDATE generated from one list.** `UPDATE_COLUMNS` in `src/tracker/recompute.ts` builds SET clause. Never hand-align placeholders there.

## Favorites: shared by default

`config.sharedFavorites` (default true). `FavoriteScope` in `src/favorites.ts` picks table. `syncFavoriteSharing` merges per-profile lists ↔ shared, once per switch (recorded in `kv`). Nothing lost. Removing shared favorite removes from every profile's own list.
