# Architecture & Project Lore

## osu! file format findings (verified against a 2408-replay corpus)

**lazer appends an extended block to every `.osr`.** After replay frames comes an `int64` online score id, then `int32` length, then LZMA-compressed JSON blob (`LegacyReplaySoloScoreInfo`) holding authoritative mods, statistics, and rank. The legacy header alone reports rank `F` for plays that actually ranked A. `osu-parsers` reads only the legacy header - we don't use it.

- lazer replays: version >= 30000001; stable replays lack the block
- ~35% of a typical store is stable-format (older imports)
- Legacy mod bitmask *is* correct (AP bit was genuinely set)

**lazer accuracy ≠ stable formula.** lazer judges slider tails (150) and large ticks (30) toward accuracy. Formula: `sum(statistics × value) / sum(maximum_statistics × value)`. Values in `HIT_VALUES` in `src/calc/grade.ts`.

**lazer stores files by SHA-256, not beatmap MD5.** A score references beatmap by MD5, so matching requires the MD5 index in `osu_files` (`src/clients/beatmaps.ts`). Building it: sniff every file in store once (~63k files: 9s warm, ~140s cold read). Entries immutable, never re-read. Stable's `Songs` filters by `.osu` extension instead.

**The index runs beside the app, never before it.** `indexBeatmapFiles` works in 25ms slices, commits before every pause (shared connection; holding a tx across a pause swallows other writes). `Tracker.indexBeatmaps` puts it at head of ingest queue *before* watchers start.

**`online.db`** is a plain SQLite file shipped by lazer: `osu_beatmaps(beatmap_id, beatmapset_id, checksum, approved, ...)`, ~234k rows, `checksum` = beatmap MD5. Open read-only, never write. Cross-platform; fetched asynchronously by lazer when absent, refreshed if >1 month old. Not guaranteed to exist on any platform.

**A `.osu` section ends at the next line beginning with `[`, never at the next `[`** (`osuSection` in `src/clients/beatmaps.ts`). `[` is ordinary inside values - mappers like `cRyo[iceeicee]`, artists tagged `[CV. …]`, audio files named `[HD] …`. The old rule lost or corrupted 327 of 12,811 beatmap names here and filed 23 beatmaps under the wrong mode (roadmap 5.45).

## pp: osu!'s own code

`tools/PpCalculator/Program.cs` references official `ppy.osu.Game.Rulesets.*` NuGet packages. Driven over JSON-lines pipe from `src/calc/official.ts`.

**Hand the replay file, not a reconstructed ScoreInfo.** `LegacyScoreDecoder` sets `IsLegacyScore` from replay version, applies Classic mod to legacy scores, populates `MaximumStatistics`, reads lazer's extended block. Stable scores: `isLegacy=true` with `CL` added (selects classic slider accuracy + legacy miss estimation in `OsuPerformanceCalculator`). McOsu keeps no replay, so the app builds a stable one for each McOsu play and hands that over - see McOsu below.

**Difficulty calculator is Relax-aware.** Same RX replay: 6.26★/110.93pp as played, 7.83★/238.54pp mod-removed. `unrankedModPp` setting picks between them. Both stored at ingest (`pp`/`stars` and `pp_nomod`/`stars_nomod`).

**pp calculated for every score, not just ranked.** Eligibility = query-time decision (`src/calc/eligibility.ts`), never stored. `scores` stores facts (`map_status`, `mods_ranked`, `mods_countable`, both pp). `countsSql()` turns settings into predicate. One definition of "counts"; never write `ranked = 1` in a new query.

**Which mods are ranked is osu!'s answer.** `rankedByOsu` asks the helper (`"type": "ranked"`), which builds osu!'s own mod objects from the replay's mods and settings (or converts stable's bitmask) and reads `Mod.Ranked`. It differs by ruleset (MR ranked only in mania, HR everywhere but mania) and by setting (speed unranks DT, pitch does not), and osu! changes it between releases: a hand-kept list missed AL, SG, TC, BL, NS, AC, MU, SW, CO, FI and 4K–9K, and counted CL chosen on lazer. `scores.mods_ranked_by` holds the release that answered; NULL (helper down, or a row from before) is unranked and stale until a recompute. The Classic mod the decoder adds to stable plays is not part of the question.

**Score removal = hide, not DELETE.** Replay stays on disk - a deleted row re-ingests when the file is noticed again. `scores.hidden_at` set instead; `visibleSql()` filters it from *every* query. A removed score leaves play count + level bar too.

**Deleting a removed score for good keeps its key.** Row deleted, but `dedupe_key` written to `deleted_scores` first. Ingest + Import refuse a key listed there (`wasDeleted`). Never delete a score row any other way.

**`tools/pp/` shadows the plain build.** `src/calc/official.ts` prefers it. A stale copy answers old protocol silently. After changing `Program.cs`: run `npm run build:pp:local`, not just `npm run build:pp`. `scripts/build-pp-helper.mjs` shared with `npm run package`.

**Every pp value carries the osu! release.** Helper reports `ppy.osu.Game` version on ready line + each response, alongside `breakdown`. Both in `scores.pp_version` and `pp_parts`/`pp_nomod_parts`. Parts must belong to the pp beside them.

**No fallback calculator.** `rosu-pp` removed on purpose. Reimplementations lag osu!'s reworks.

**The helper ships slim only when proven identical, per platform, per build.** Full `PublishTrimmed` takes it 113MB -> 36MB but breaks inside osu!'s own graph (`StringEnumConverter`, reading lazer's extended block; roadmap 5.44). The slim helper is `TrimMode=partial` -- only .NET's own libraries trimmed, osu!'s and every third-party one whole -- plus the natives in `SLIM_PRUNE_NATIVES`: 58MB against 121MB on Windows, 64MB against 132MB on Linux. `buildCheckedPpHelper` (scripts/build-pp-helper.mjs) builds the full and the slim helper side by side and runs `scripts/pp-parity.mjs` over **generated** plays (`scripts/pp-parity-corpus.mjs`): beatmaps of all four rulesets built to reach every slider curve, BPM and velocity change, spinner, drumroll, juice stream and hold, with stable, lazer (LZMA block included) and McOsu replays; the app's own requests for each, every mod per ruleset, the ranked-mods questions and ten error paths, each answer compared as text. About 1,800 requests in under 30 seconds, identical on every machine, nothing private in the repository and nothing to download -- so any contributor, CI runner or agent can run it. It catches what matters: a fully trimmed helper (5.44) fails it on the generated lazer replays. Slim ships only if all are identical; any difference, crash or unrunnable platform ships the full helper and says why, and never fails a release build. The `pp helper` workflow runs it with `--require-slim` on all four platforms whenever something that could change the answer changes. `--live` adds this machine's own replays, for extra assurance, never required. Compare a platform's helpers only with each other. Unseeded Random and Target Practice are never sent: osu! itself prices them differently on every run.

**After a pp rework:** bump package versions in `PpCalculator.csproj`, `npm run build:pp:local`. Installs reprice themselves.

**A new calculator reprices what the old one priced, once, on its first launch.** `Tracker.recalculateAfterUpdate`, after the index and catch-up (an unindexed beatmap prices as missing). Picks `outdatedPpSql` across every profile, hidden scores included; `outdatedPpCount` is the same predicate plus `visibleSql`. Done once per release (`kv` `pp_recalculated_for`, written when it finishes): a score whose replay is gone stays on the old release for good and must not be retried and announced every launch. Queued `RECALCULATE_BATCH` scores at a time, never as one task, so a live play waits seconds, not minutes. One run at a time; Other settings' **Recalculate every score** is the same run over every score (`recalculate(false)`). Progress and result go out as tracker events to every page, since nobody on any page started the automatic one.

## Incomplete plays: over half of plays leave no replay

**osu! counts a play it never keeps.** `SubmittingPlayer.submitScore` submits on fail, quit, or retry. No minimum object count - only: token issued, ≥1 non-miss judgement, total score > 0. Quitting before hitting anything is the only discard (`No hits registered, skipping score submission`).

**lazer keeps a score only for maps played to end.** `Player.prepareAndImportScoreAsync` imports when `ScoreProcessor.HasCompleted && GameplayState.HasPassed`, or `forceImport` (fail screen's "Save replay" button). Solo HP-fail, quit, retry write nothing to disk.

Measured: 54 plays started, 45 counted by osu!, 19 replays written. Replay watcher misses ~58%.

**Every rank-F replay = multiplayer.** `MultiplayerPlayer.PerformFail` suppresses failing - runs to end, imports normally. All 22 F replays in corpus judged 100% of hit objects. No partially-played replays on disk.

**Incomplete plays come from lazer's log.** `<lazer>/logs/<session>.runtime.log` + `.network.log`. `Score submission completed!` = osu! accepted the submission → play count agrees with website by construction. Pass detected by screen stack logging `suspended <Player> (waiting on <...>ResultsScreen)`. Verified: fired 19 times, 19 replays on disk.

Log timestamps: **UTC**. Beatmap ID in network log's submission `PUT`, joined to runtime log by token. Multiplayer submits via `/rooms/...`, resolves to no ID (always writes a replay anyway).

**`incomplete_plays` rows are NOT in `scores`.** An abandoned play has no accuracy, combo, mods, pp, or total score. A row of zeroes in `scores` corrupts weighted accuracy, grade counts, ranked score, level bar, medals. Only 4 aggregates read `incomplete_plays`: play count, monthly play counts, Most Played, Recent Plays. `hitsPerPlay` divides by *scored* plays only.

Counting them is not optional (osu! counts them). `showIncompleteInRecent` (`yes` | `collapse` | `no`) only controls listing.

**The user can remove one, as a score is removed.** `setIncompleteHidden` sets `incomplete_plays.hidden_at`, which `incompleteSql` already excludes, so it leaves the play count and every other figure at once. A collapsed Recent Plays row carries every attempt's id (`IncompletePlay.ids`) and removing it removes them all; Removed scores lists them folded back by shared `hidden_at`. Deleting one for good writes `incomplete:<dedupe_key>` to `deleted_scores` (`deletedIncompleteKey`) - prefixed so a replay key can never match - and both the live log watcher and Import past plays treat that key as already recorded.

**Offline or signed out, osu! counts nothing - but lazer still says so** (roadmap 5.45). With no token, `SubmittingPlayer.submitScore` logs `No token, skipping score submission`, just before the solo gameplay screen exits (93 of 94 here; the one exception came a few seconds after). That line against a `SoloPlayer#N` screen that did not reach results is an *unsubmitted attempt*. It is never inferred from a token merely being absent; a screen that had a token is never one; `ReplayPlayer`, the skin editor's `EndlessPlayer` and multiplayer screens never are. It is distinct from `No hits registered`, which is osu!'s own discard and stays uncounted.

Stored in `incomplete_plays` with `unsubmitted = 1`, keyed `unsubmitted:<log session>:<screen>:<entered>` (screen numbers repeat within a day). **Recorded always** - the log is only followed live, so an attempt skipped today is gone - and **counted only through `incompleteSql(e)`**, when the profile's `countUnsubmittedAttempts` is on - **on by default**, at the user's call: osu! never received these, so counting them takes nothing from what osu! shows. The Scores note mentions them only once some are recorded.

**Import past plays reads the logs too** (`src/tracker/log-backfill.ts`): counted unfinished plays and unsubmitted attempts from the cutoff on, each kind a separate source beside replays. Preview and import go through the same `checkIncompletePlay`/`checkUnsubmittedAttempt`, so the preview's numbers are the import's. An import naming no sources means replays alone, as before. Every figure that reads unfinished plays goes through it: play count, monthly play counts, Most Played, Recent Plays, Total Play Time, modes with plays.

An attempt has no beatmap id (no submission request), so it is matched by the log's `Game-wide working beatmap updated to` name against `osu_files.name` - lazer's `BeatmapInfo.ToString()`, `Artist - Title (Creator) [Version]`, built from each `.osu`, unique matches only. Measured on 20 real logs: 59 attempts, 59 matched, where the beatmap cache alone matched 12. Needs no `online.db`.

**osu!stable incomplete plays cannot be covered** (measured 2026-09-11, stable `b20260711.1`):

- Logs say nothing about plays (OpenGL init, updater, encrypted auth log only)
- Only trace: per-beatmap "last played" in `osu!.db` - a quit/fail/retry on one diff produced one timestamp between them, flushed minutes later, cannot tell fail from pass
- A pass reaches the app when results screen closes (stable writes replay then)

`renderStableNote` in main.js, `showStableNote` per profile. Do not build a play counter on that timestamp. `ingestIncompletePlay` stays client-agnostic.

## Whose replay is it?

**osu! keeps the replays you watch in the same folders as the ones you set.** Stable caches a downloaded leaderboard replay in `Data/r`; lazer imports one into its content-addressed store. Nothing about the file says which it is - only the name written inside it. Measured on one real machine: 2,499 replays, 2,411 the owner's and **88 belonging to 62 other players**. Import past plays brought all 88 in, and the profile read 16,109pp because its top play was mrekk's 1,857pp Crystalia.

**Everything fails towards yours.** A wrongly tracked play is visible and removable; a wrongly refused one is gone. So `ownsPlay` returns `false` only on positive evidence, and these are always yours:

- **No name at all** - osu!stable writes an empty name for a play made signed out (3 in that corpus).
- **lazer's `Guest`** - what lazer calls the local user when not signed in (1 in that corpus). Offline plays are what this app is *for*.
- **A name you used to have.** osu! publishes `previous_usernames`; the test account has two. Stable replays carry no user id, only the name current when the play was set, so without that list every pre-rename play looks like a stranger's.
- **A play osu! never accepted.** osu!stable's username is a line in a config file: anyone can set `Username = Cat` and play offline, and the replay then says `Cat` - possibly a real player's name. But a replay you *downloaded* is by definition a score osu! put on a leaderboard, so it always carries a score id. One with none was never on a leaderboard, so it cannot have been downloaded, so it was set here. Measured: **all 91 replays by other players carried an id; 258 of the owner's own - 164 stable, 94 lazer - did not.**
- **Not knowing.** An identity nothing could establish never refuses anything.

**Who am I?**, in order of certainty (`resolveIdentity`): the linked osu! account (numeric id + every previous name) → osu!stable's own `osu!.*.cfg` `Username` → the name behind ≥80% of the profile's own tracked plays, over at least 10. A lazer replay's `user_id` settles it outright and survives renames; stable records none.

`scores.player_name` / `player_id` record who set each play at ingest, so nothing later has to reopen a replay file that may be gone.

**The score id is read from wherever the replay keeps it.** lazer writes the legacy header field as `0` and the real solo id in its own block, so reading only the header called every lazer play unsubmitted - and left an imported osu! score with nothing to match a lazer replay on but the weaker fallback. `online_score_id` now stores whichever is real.

### Removing ones already tracked

Runs once per profile (`kv` `foreignScoresSwept:<id>`), and **only on a linked account whose previous-name list was actually fetched** - `linkedNamesKnown`, because an empty list cannot be told from one nobody asked for, and an older version never asked. A profile that fails that test is left *unmarked*, so the next launch after an Import from osu! does it properly.

Every removal is a **hide**, the same one the `···` menu performs: the row stays, appears under Removed scores, and goes back with one click. That is what makes doing it unprompted defensible. Measured on the test profile: 84 removed, 0 of 2,327 own plays, 0 of 3 nameless, 0 of 1 `Guest`; total pp 16,109 → 7,394.

## Importing an osu! account's own scores

**Why it cannot be done locally.** A best performance may have been set years ago on another PC, on a beatmap never installed here, with a replay this machine has never held. Nothing local can find it. osu! still has it.

**No credentials, as with the rest of the osu! import.** `/users/{id}/scores/best` and `/users/{id}/scores/pinned` answer JSON to anyone, exactly as `/beatmapsets/favourite` does. `?mode=osu|taiko|fruits|mania&limit=100&offset=N`, paged until a page comes back empty.

**osu! keeps 200 best performances per ruleset, not the 100 its page shows.** Measured: offset 100 returns a full second page, offset 200 empty. Scores 100–199 were worth 34.14pp on the test account - taken, not dropped.

**pp is osu!'s own, and nothing recomputes it.** A number osu! published *is* "pp from osu!'s own code". What cannot come with it is a breakdown - the helper needs the replay file - so `pp_parts` stays NULL and `pp_source` is `osu-web`, keeping the rule that parts always belong to the pp beside them. Recompute excludes `imported_at IS NOT NULL`.

**Star rating is stored only when the mods cannot have changed it** (`RATING_NEUTRAL_MODS`). osu! hands over the *unmodded* rating and there is no replay to ask the difficulty calculator about, so an HR or DT play stores none rather than one that is wrong.

### Deduplication: the hard part

The same play arrives twice - from osu!'s record, and from its replay when a history is imported later - and the two share no key. A replay knows its own hash; osu! knows its score id. `dedupe_key` can never match across them, so `findExistingScore` is what both sides go through, in `src/tracker/online-import.ts`:

1. **An online id.** Conclusive. lazer and osu!stable number scores differently, an imported row keeps both (`online_score_id` + `legacy_score_id`), and a replay carries whichever its client used - so ids are matched as a set against both columns. Stable's `0` for an unsubmitted play is discarded, not treated as an id.
2. **The play itself**, for a stable replay older than 2014 with no id: same beatmap MD5, same total *on some scale*, same max combo, within 5 minutes. An imported row stores `total_score` on the scale its replay would have carried - osu!'s old uncapped number for a stable play, the standardised one for a lazer play - which is what makes the exact-total match possible.

A play already tracked from its replay is left alone (`tracked`): that row was priced by osu!'s calculator here and carries the breakdown. A row a previous import wrote is *updated*, because osu! reworks pp and re-ranks maps.

### Borrowed bonus pp

osu! awards bonus pp for how many distinct ranked beatmaps an account has ever played - thousands. A profile holding 200 imported scores earns the bonus for 200 and lands hundreds of pp adrift. So an import records osu!'s own total (`imported_standing`) and stores the shortfall: `osu! total − weighted sum over TOP_PLAY_LIMIT of the same scores`. Measured: 7,380.07 − 6,931.85 = 448.22, landing the profile's total on 7,380.07 exactly.

The subtraction is against the app's own top-100 weighting, not all 200, so the tail past the hundredth is carried too rather than lost. `computeStats` takes `max(earned, borrowed)`: real plays supersede it gradually, with nothing to clear and no backwards jump. A reset clears it.

On a long-played account it may never be superseded, which is right rather than a gap: `bonusPp` tops out at 413.894 on any number of beatmaps, while the borrowed figure also carries the uncounted tail - measured at 448.22 against an account whose own 939 ranked maps earn 412.9. The larger number is what osu! actually awards there.

## Live tracking starts at the launch, never earlier

**A play set while the app was closed is never tracked when it opens.** Closing the app is how tracking is stopped - a different playstyle, a warm-up, an account that is not this profile - so catching up at the next launch overrules that, and irreversibly: the scores are in, and the profile has to be picked through by hand.

`Tracker.liveCutoff` = `max(profile.trackingSince, liveSince)`, where `liveSince` is set by `start()`. All three live paths ingest against it (`handleReplay`, `handleLoggedPlays`, `handleUnsubmittedAttempts`); a play below it is `skipped: 'too-old'`. Toggling tracking off and on re-arms it, because that is the same decision as closing the app.

Each watcher already begins at *now* on its own - `ReplayWatcher` never scans the store, `LogWatcher` tails from the current end of the session - but those are two promises in two files, either weakenable by a change that looks unrelated (a directory listing added for warm-up, a session re-read after the game restarts). The cutoff is the same promise made once, where every live play passes, at one comparison.

**Import past plays is unaffected.** It supplies its own `since` and is the way to bring in an evening played with the app closed: chosen, previewed, confirmed. `TrackerOptions.liveSince` overrides the cutoff and exists only so tests can replay a historical replay through the watcher; nothing in the app passes it.

The start-up banner says so every launch - it is the one tracking rule decided by when the app is open rather than by anything on the page.

### Catching up on the gap, when the profile asks

`importPlaysWhileClosed` (per profile, **off by default**) makes a launch import what was played while the app was shut. It does not weaken the cutoff above: `Tracker.catchUp` calls `Tracker.backfill`, so it is an import with an import's filter, dedupe and owner check, and `liveCutoff` still refuses everything it did before.

The gap is `[kv.lastRunAt, now]`, floored at the profile's `trackingSince` (`catchUpSince`). `lastRunAt` is written at startup, at shutdown, and on a 30-minute heartbeat - slow, because every write throws away `/api/profile`'s `total_changes()` cache stamp, and slowness is safe here: a stamp left by a crash is *older* than the true shutdown, so the next launch scans further back and dedupe turns the overlap away. No stamp at all (a first launch) means no catch-up, not a catch-up from an invented date.

Every source, because a gap is a gap - replays, counted unfinished plays and unsubmitted attempts together, or the play count stops agreeing with osu!'s. Announced through the `caughtUp` event → the `caught-up` SSE event → a toast: it is the only import nobody pressed a button for.

## Play tracking filter

Decides whether a play is **written**. Declined play leaves no row anywhere.

- Off by default. Switching it on narrows nothing (every criterion starts widest). `filterNarrows` separate from `enabled`.
- A fact the filter doesn't have never rejects a play (quit/HP fail/retry has no mod list or star rating - those two criteria don't judge it).
- Declined play announced: console line, SSE `filtered` event, toast naming criterion, running count in `/api/state`.

Nine criteria matched against replay, `.osu`, `online.db`. Same answer at live ingest and Import past plays - **unless that import says otherwise**. Import past plays carries a checkbox, ticked by default, and unticking it runs that one import against `defaultTrackingFilter()` (permits everything) rather than the profile's. The filter is a rule about how you play *now*; an import reaches back to evenings it was never written for, and the alternative was turning the filter off, importing, and turning it back on. `applyFilter` is absent-means-true on the API, so an older page or a script keeps the old behaviour. Preview and import are given the same answer, so the counts shown are the counts imported. `scripts/reingest.mjs` must NOT pass a filter.

Live tracking is never affected: the box is re-ticked every time the dialog opens, so bypassing is a decision about the import in front of you rather than a setting that persists.

`online.db` has second table: `osu_beatmapsets(beatmapset_id, submit_date, approved_date, approved)` - 60k rows vs 234k in `osu_beatmaps`. `approved` values 1, 2, 4 only (ranked/approved/loved). Earliest `submit_date`: 2007-10-06 (slider floor).

**Date added = file creation time, never mtime.** Lazer imports keep mtimes from 2019-2021, created 2025-11-06. mtime = beatmap's own age. No creation time → mtime fallback.

Star rating and length judged **as played** (mods included). Beatmap dates and length filled lazily on `beatmaps`: NULL = never looked up, 0 = looked up and unknowable.

## Total Play Time

Follows osu! server rule (`PlayValidityHelper.GetPlayLength`): per play, `min(beatmap total_length / rate speed product, ended_at - started_at)`. Runs on failed scores too.

`src/calc/play-time.ts`: finished score (no start time) uses length/rate (smaller side). Incomplete play uses token time → submission, capped at map length. Rows before `started_at` existed count nothing. Beatmap lengths read lazily into `beatmaps.length_ms` (0 = unreadable).

## Favorite Beatmaps

One request per favourite. `osu.ppy.sh/beatmapsets/<id>` embeds full set as `<script id="json-beatmapset">`. Favouriting fetches once, caches in `beatmapset_details`. Offline: `localCard` in `src/favorites.ts` builds from `online.db`, beatmap cache, profile's own scores. Per profile, survive reset, never written to osu!.

## osu! account link: no API, no credentials

`osu.ppy.sh/users/<name>` redirects to numeric ID, embeds full public user object as `data-initial-data` attribute. Same data as API's `/users/{user}`. No OAuth needed. May change - `src/clients/osu-web.ts` fails loudly rather than returning empty user. One request per button press, copies to `data/`. Nothing on a timer.

## Server: localhost-only, enforced per request

Page can reset/delete profiles and remove scores with no auth. `startServer` refuses any non-loopback request, no switch to turn off. `loadConfig` drops old `shareOnNetwork` key (`RETIRED_KEYS`). Do not bring it back.

**Do not bind to `127.0.0.1`.** Drops IPv6 loopback; `localhost` resolves to `::1` before `127.0.0.1` on Windows → unreachable. Also makes `listen` async, breaks `server.address()` in tests.

## osu-web fidelity

Read `docs/osu-web-fidelity.md` before any "make it look more like osu!" work. Maps every visible region to osu-web LESS/TSX. Carries clone command for `reference/osu-web` (6.5MB sparse, gitignored checkout).

**osu-web's own files, under its own licence.** Project relicensed MIT → AGPL-3.0-or-later (roadmap 5.57), the licence osu-web is under, so osu-web code and artwork may be used with credit. Up to v1.22.0 stays MIT; its notice is kept in `THIRD-PARTY-NOTICES.md`.

- **Artwork is vendored, never hand-copied.** `scripts/build-osu-web-art.mjs` (`npm run build:osu-web`) copies mod glyphs + badge blanks, GradeSmall badges, stable's `legacy-ranking-*@2x.png`, the guest avatar into `web/osu-web/` byte for byte from one osu-web commit (recorded in `web/osu-web/README.md`; `.gitattributes` keeps line endings untouched), and writes `web/css/osu-web-art.css` mapping classes to files. The acronym → glyph table is read from osu-web's `mod.less`, so new glyphs arrive on the next run. `test/osu-web-art.test.ts` checks every mod in `mod-definitions.js` has one.
- **Pictures via stylesheet `url()`, not `assetUrl()`.** CSS masks/backgrounds, as osu-web does them. A saved copy inlines the stylesheets, so `inlineCssUrls` in `share-copy.js` turns each same-origin `url()` into a data: URI.
- **Markup follows osu-web's.** `modPill()` builds `mod.tsx`'s DOM; `.mod` in `profile.css` is `mod.less` ported (`color-mix` darkenings included). `gradeBadge()` is `score-rank`; `legacyRank()` is `legacy-rank`; `guestAvatar()` is `avatar--guest`.
- **Still off limits:** `ppy/osu-resources` (CC-BY-NC, incompatible with AGPL's no-further-restrictions), Torus/Venera (MyFonts licence restricted to ppy), osu!/ppy logos (trademarks, outside osu-web's grant).

Flags from Twemoji (CC-BY 4.0, same source as osu!). Generated: `web/js/mod-definitions.js` (`npm run build:mods`), `web/flags/` (`npm run build:flags`), `web/osu-web/` + `web/css/osu-web-art.css` (`npm run build:osu-web`).

## Medal definitions: from osu!, not symmetric

`src/calc/medal-definitions.json` generated by `scripts/build-medal-table.mjs` from osu! profile-page payload. Do not hand-edit.

- Combo + play-count medals exist for **osu!standard only**
- taiko, catch, mania have **hit-count** medals instead
- Star pass/FC medals: 1–10 for standard, 1–8 elsewhere
- **Mod Introduction** is the only other group (user chose it). Rules: mod alone at defaults, system mods + CL ignored, SO in standard only, NC/DC ≠ DT/HT, passes only, Conversion/Fun = lazer-only mod types

Page shows no text for a medal (icons only, groups: Mod Introduction then Skill & Dedication per `ordering`). Hover card: `#medalTooltip`, one shared element positioned in window coords. Header medals figure = account-wide `earnedMedalCount`. Earned medal = Recent-feed event (`medalEvents`) - except rank medals (`dated: false`).

Medals derived from scores on every request, never stored. Full combo needs `beatmap_max_combo` (lazer drops slider ends without breaking combo - "no misses" alone awards FC to a run dropping hundreds). Rows without it: unknown, never guessed.

## Global rank: estimated from sampled curve

Rank from `src/calc/rank-tables/<mode>.json`, built by `scripts/build-rank-table.mjs` from `data.ppy.sh`'s `performance_<mode>_random_10000` dump. Random sample across whole ladder; every user carries actual rank → no modelling needed.

Script streams ~1GB archive through `bzip2` + `tar`, keeps only user-stats table. Interpolation linear in **log** rank (spans 6 orders of magnitude vs 3 for pp).

Labelled as estimate in UI. Allowed where second pp calc is not (stale curve degrades gradually). Refresh: re-run script with newer `--dump` date.

**Country rank deliberately not shown.** 10k sampled users over ~200 countries too thin.

## `fs.watch`: never pass an unresolved path

On Windows, libuv compares filename from `ReadDirectoryChangesW` against the given path and **aborts the process** on mismatch. Junction, drive substitution, or 8.3 short name triggers it. Caught on CI runners (`C:\Users\RUNNER~1\...`).

**Watcher test must let watch come up before first write.** macOS FSEvents thread starts at first `fs.watch`; write during startup is not reported. `await sleep(SETTLED_MS)` after `start()`.

`watchablePath` in `src/tracker/watcher.ts` resolves the directory. Paths reported against configured directory - downstream never sees two spellings.

## Charts: not ordinary SVG

Both charts draw in 0..100 space with `preserveAspectRatio="none"` (responsive without measuring DOM). Everything inside sheared by container aspect ratio (circle = ellipse). Axis labels, hover marker, tooltip: HTML positioned over plot in percentages. osu-web does the same.

Colours/wording from osu-web source: line `@yellow` `#ffcc22` at 2px, tooltip `Global Ranking #123` over `40 days ago`, Play History `Plays 430` over `March 2020`.

Section lists **paged by server**. Page asks for size per section, gets totals. "Show more" needs both "page came back full" AND "total > returned". Recent Plays counts plays but draws rows - collapsed retries are several plays in one row.

## osu!stable specifics (verified on real install)

- **Songs folder can be moved.** Stable writes path to `BeatmapDirectory` in `osu!.<user>.cfg`. `stableSongs` in `src/clients/detect.ts` reads it. Relative values resolve against install dir; stale value falls back to `<root>/Songs`.
- **Signed-in username** only present when "remember" was checked (`Username` field in cfg). `detectLocalSessions` finds nothing for stable → page falls back to manual name entry. Correct behavior.
- **Ranked status for stable plays** comes from lazer's `online.db`. Stable-only install → every beatmap = `UNRESOLVED_STATUS`. pp unaffected (needs `.osu` from Songs). `BeatmapResolver.knowsStatus` = false, `countUnresolved` in eligibility, `countsSql` counts unresolved beatmaps *in addition*. Page says so in Scores note. Beatmap-status settings dimmed. Not a setting - follows what the machine knows.
- **A beatmap downloaded mid-session** (osu!direct, every multiplayer pick you lacked) lands in a new `Songs` folder the replay watcher does not see. `SongsWatcher` (`src/tracker/songs-watcher.ts`) watches `Songs` itself, **non-recursively** - a recursive watch is an inotify watch per set folder on Linux - and indexes each new set folder's `.osu` files. A lookup that finds no file calls `BeatmapResolver.onMiss` → `flush()` first, in case the play landed before osu! finished extracting. A cached miss is never the last word: `resolve` looks again and replaces it once the file is indexed, and `Tracker.repairScores` recalculates plays stored before their file was found (every launch, after the index).
- **Mods are the whole bitmask, per ruleset.** `decodeLegacyMods(bits, ruleset)` mirrors each ruleset's `ConvertFromLegacyMods`. It once read only bits 0-14, so ScoreV2 (bit 29) was stored as nomod while osu!, asked about the raw bitmask, called it unranked. Rows stored that way are re-decoded once (`misdecodedIds`, `legacyModsRedecoded` in `kv`). Stable writes no replay for a multiplayer fail, as for a solo one - nothing to track.

## McOsu (roadmap 5.58)

McOsu writes **no replays and no log** - only its own `scores.db` (and `scoresvr.db` for VR), rewritten whole after each play it keeps: finished, not failed, score > 0, not Autoplay or AP+RX. Fails, quits and retries leave nothing anywhere, so, as with stable, they cannot be counted.

- **Each play becomes a built osu!stable replay** in `data/mcosu/<md5>-<unix seconds>.osr`: the entry's judgements, combo, total and mods, no cursor data, then this app's own block (`MCOSU_BLOCK` + JSON of what the bitmask cannot hold). osu!'s decoder treats it as the stable replay it is - Classic, classic slider accuracy, maximum statistics - and ignores the block. From there it is an ordinary replay: dedupe (`mcosu:<md5>:<ms>`), Import past plays, recalculation. Kept when the entry is deleted in McOsu. **Never offered for download** (`has_replay`, `replayAvailable`, `replayDownload`).
- **Live:** `McosuWatcher` watches the McOsu folder (through `watchablePath`), remembers what was there at start, and builds a replay for each new entry. Import past plays builds the range first (`buildMcosuReplays`), then scans `data/mcosu/` with every other replay folder. McOsu's copies of stable scores (`isImportedLegacyScore`) are never built.
- **Mods** are what osu! would write (`mcosuMods`): speed from what was played, not the bits (the speed slider sets none); overrides as Difficulty Adjust **after** EZ/HR, because osu! applies mods in order; Nightmare (Cinema's bit in McOsu) and experimental mods as the app's own **MC**, never shown to osu!'s calculator. Speed outside 0.5x-2.0x or a value past DA's extended limits stores no pp: osu! would clamp, not refuse.
- **The helper takes McOsu's mods after decoding** (`mods` on a calculation request) and can withhold the stable total (`ignoreLegacyTotalScore`), which osu! uses to estimate combo breaks assuming stable's mod multipliers. Withheld only where McOsu's multipliers for its bits differ from osu!'s for the priced mods (`legacyTotalComparable`).
- **Scored as stable everywhere** (`scoredAsStable`). Its player name is McOsu's `name` setting and is left out of `dominantTrackedName`. Found on every launch from Steam's libraries, outside `missing()` so it never triggers a drive walk.

## Windows: only verified platform

macOS and Linux written, CI-covered, never run against real osu! install. Since 1.10.0: `osx-arm64` + `linux-x64` zips in releases.

**Platform rules:**

1. Platform-varying behavior behind pure function taking platform. `src/clients/detect.ts` takes `DetectEnvironment`, never reads `process` directly.
2. Platform-specific list must fail loudly on empty match. pp helper pruning matches by base name across `.dll`/`.dylib`/`.so`, warns when nothing pruned.

**The runtime is the one beside the launcher**, by absolute path (`tools/launcher/launcher.go`). The old `.bat` needed `.\node.exe`, because `cmd` searches PATH for a bare name when `NoDefaultCurrentDirectoryInExePath` is set (Claude Code's shell sets it). The root `start.bat` is for development only. Test a `.bat` as `.\x.bat`.

**`cmd` spawns need `windowsVerbatimArguments`.** Node quotes by C runtime rules; `cmd` doesn't unescape. `start` title `""` must arrive as `"\"\""`. `src/browser.ts` builds line as pure function. Updater relaunch = same trap.

**macOS: one approval, then the launcher lifts quarantine.** Browsers and Archive Utility quarantine every unpacked file, and Gatekeeper refuses each unsigned one as it loads: `node` is Node.js Foundation-notarized, but `osu-pp` and its native libraries are ad-hoc signed (16 files in 1.14.0). The `.app` (or the `.command`) must be approved once (macOS 15: Privacy & Security -> Open Anyway); it then runs `xattr -dr com.apple.quarantine <folder>` when `node` or `osu-pp` still carries the attribute. No password needed for the user's own files. Updates never carry quarantine: the app downloads them with `fetch`. Real fix is Developer ID signing + notarization ($99/yr), not done.

`config.installRoots`: escape hatch for unanticipated layouts (macOS/Linux stable via Wine wrappers). Was documented + printed but read by nothing at all.

## Updater: rewrites app's own directory

`src/update/` + `scripts/apply-update.mjs`.

**Four safety properties:**

1. `data/` never touched. `dataDir()` = `<install>/data`. Swap enumerates other top-level entries and steps around it.
2. Nothing deleted while still needed. Outgoing files *moved* to `.rollback-<stamp>/`. Swap deletes it once new build is on disk and manifest reads back (~200MB, keep insures against passed risk). Way back from bad release: download previous.
3. Nothing swapped until new build verified: download size, unpacked tree shape, version in `package.json`.
4. Source checkout refuses (`start.bat` = `node src/main.ts`). Both `.git` + missing bundled runtime checked.

**Swap runs from staged build using its own runtime.** On Windows, running `node.exe` locked by the process. `scripts/apply-update.mjs` copied into every package.

**Relaunch: somewhere the app can be stopped from, or not at all.** A copy started with nothing to stop it keeps tracking and the port, findable only in a process list. Up to 1.13.2 the app came back exactly so on macOS/Linux: no TTY, output to `/dev/null`, outliving its terminal.

- **The tray launcher restarts the app itself, on every platform.** It runs the app with `OSU_LOCAL_PROFILES_LAUNCHER=tray`; the app passes `--launcher-restarts` to the swapper, writes its pid to `data/update/swapper.pid` and exits 75 (`RESTART_EXIT_CODE`). The launcher waits for that pid, releases its instance lock, starts the launcher now at its own path (the new release's) and exits. `test/launcher.test.ts` runs the real launcher through this.
- **A running launcher can be swapped on Windows.** Renaming a running `.exe` works; deleting one fails with `EPERM` (measured). The swap renames first, so it succeeds; a rollback copy left holding the old exe is swept by `pruneUpdateLeftovers`. A running `.bat` could not be restarted from, which is why 1.14-1.16 Windows let the swapper relaunch.
- **`start.sh` with no desktop** keeps the terminal loop: `OSU_LOCAL_PROFILES_LAUNCHER=restarts`, wait for the pid, re-run itself.
- **Otherwise the swapper relaunches, per `relaunchPlan`** (pure, in `scripts/apply-update.mjs`). Windows: the launcher exe. macOS: `open -n` on the bundle (`-n`, or a launcher still exiting is only brought forward). Linux: the launcher when `DISPLAY`/`WAYLAND_DISPLAY` is set, else no relaunch, said in `data/update.log`. Never the runtime directly. Reached only from releases that do not restart the app: up to 1.13.2 on unix, 1.16 on Windows.
- **The swapper is the new release's; the launcher is the old one's.** 1.14-1.16 unix launchers restart by running `./<own name>` again, so the new `start.sh` and `Start osu! local profiles.command` exist under those names and start the tray launcher.
- `verifyStaged` requires the tray launcher in a downloaded build, since the relaunch depends on it.

**Zip reader** is ours (`src/update/zip.ts`): no dependency overhead, avoids `tar.exe` (Windows-only). Refuses zip64, refuses path traversal. Handles backslash separators from own packager.

**Update leaves two ~200MB copies.** Rollback is visible one; other is staged tree in `data/update/`. Swap deletes its own rollback but cannot delete staged tree (running from it; `node.exe` locked). `pruneUpdateLeftovers` at startup clears both. Keeps `data/update.log`.

**One request at startup, never a timer.** `checkForUpdates: false` turns off the app's only outgoing request. Failed check shows nothing.

## Launcher: a tray icon

`tools/launcher/` (Go, `fyne.io/systray`). It is what a package opens: `osu! local profiles.exe`, `osu! local profiles.app`, or `osu-local-profiles`. Built by `scripts/build-launcher.mjs`, so a package needs Go to build.

**Why Go:** one codebase gives a small native binary for all three systems. The Node process stays free of native modules, and no GUI toolkit or webview ships. Windows and Linux need no cgo. macOS does (Cocoa), so like the rest of a package it builds only on a Mac.

**It is the app's off switch, so it must never lose the app:**

- The app's stdin is a pipe whose write end only the launcher holds. Tray Quit closes it; so does the system when the launcher dies however it dies. The app's `stopWhenLauncherCloses` then shuts down.
- Quit escalates to a kill after 15s.
- Exit 0 (any deliberate stop) ends the launcher. Exit 75 is an update (see Updater). Anything else keeps the icon with **Start again** and the log, and shows the log's last lines in a dialog.

**Finding it again:** the page's Quit, and starting the launcher again. A second start finds the instance lock taken (a named mutex per folder on Windows, `flock` on `data/launcher.lock` elsewhere, both released by the system however the process ends) and opens the first copy's page once `/api/app` answers. A start that finds `/api/app` answering on the port (another folder, or `npm run dev`) opens that page. `node src/main.ts` makes the same check itself (`runningInstance`).

**No console:** output goes to `data/logs/app.log`, and the previous run's to `app.previous.log`.

**Per platform:**

- **Windows:** GUI subsystem (`-H windowsgui`), and the app runs with `CREATE_NO_WINDOW`. Its children (pp helper, `cmd` for the browser) share that windowless console. go-winres embeds the icon, version and a DPI-aware manifest. Click the icon opens the page; right-click shows the menu. Unsigned, so SmartScreen asks once.
- **macOS:** a bundle with `LSUIElement` (no Dock icon or app menu), plus `setActivationPolicy:Accessory` for a bare binary. Template icon, tinted by the bar. Signed ad hoc as a bundle: an unsigned one downloaded on Apple silicon reads as damaged. A quarantined bundle opened in place is App Translocated (run from a random read-only copy, where no `data/` is beside it). The launcher finds the real path (`SecTranslocateCreateOriginalPathForURL`), lifts the quarantine there, `open -n`s it and exits.
- **Linux:** StatusNotifierItem over D-Bus. With no `org.kde.StatusNotifierWatcher` (plain GNOME without the AppIndicator extension) the icon would never show, so it runs without one and says so with `notify-send`. `start.sh` with no desktop runs the app in its terminal instead.

**`OSU_LOCAL_PROFILES_NO_TRAY`** runs it with no icon and no dialogs, messages to stderr. This is how the tests drive it; no runner has a tray.

**Icons** are committed in `tools/launcher/icon/`, rendered from `web/favicon.svg` by `npm run build:icons` with the Chromium Share already finds.

**Not run on real hardware:** the macOS and Linux builds. CI compiles and runs them headless. The tray itself, Gatekeeper and translocation need a real desktop.

## me! (BBCode): never trusted

`web/js/bbcode.js` is our renderer (osu-web's library is server-side PHP; tag semantics only taken). me! imported from anyone's profile → text treated as hostile:

- Escaped first, never parsed as HTML
- Every tag emitted is one written in that file
- Argument validation: colours by pattern, sizes as numbers, links/images by scheme
- Failed/unclosed tag stays visible text

Pasted images: `data/about-images/<profile>/`, named by content (`src/about-images.ts`). `[img]` accepts only that exact local shape.

## Shared web page = the page itself

Share → Save as web page (`web/js/share-copy.js`): saves index.html + CSS + bundled modules (`web/js/bundle.js`) + API snapshot. `web/js/static-mode.js` (main.js's **first** import) serves snapshot in place of app (stand-in `fetch` + no-op `EventSource`).

**Consequences:**

1. Page modules must stay bundleable: named `import { } from './x.js'` + `export function / async function / const / class` only. `test/bundle.test.ts` bundles real page and syntax-checks it. `npm run ui` loads real copy, clicks Show more.
2. Images served by app go through `assetUrl()`. Copy never contains install paths or other profiles. So the data folder's path has its own endpoint (`/api/data-folder`), never a field in `/api/state`.

## Backup and restore: `data/` as a zip, swapped in at startup

`src/backup.ts`. A backup = `profiles.db` (`VACUUM INTO` snapshot: WAL mode means the file alone can miss writes) + pictures + `about-images/`, under their `data/` names. `isProfileFile` is the one list of what that is; a restore writes nothing else, whatever the zip holds. `config.json` left out: install settings, wrong on another machine.

**Restore never swaps a running app's database.** The handle is shared by tracker, server and `total_changes()`-stamped caches. Upload is checked (read-only probe for `profiles` + `scores` *before* `openDb`, which would create them in any SQLite file) and staged in `data/restore/`; apply writes `ready` and exits `RESTART_EXIT_CODE`; `applyPendingRestore` swaps before `openDb`. Tray launcher only (`onRestart`): `start.sh`'s loop would announce it as an update. Stale `update/swapper.pid` removed first, or the launcher waits on whatever process owns that pid now.

- Nothing deleted: replaced files → `data/before-restore-<local time>/`. Any failed move is undone. Staging is dropped either way, so a bad backup is not retried every launch.
- **A restore marks the app as running now** (`markRunning`). The restored `kv` last-run is the backup's, and `importPlaysWhileClosed` would import everything since as a gap the app was closed for.
- `PUT /api/restore`, `POST /api/restore/apply`, `POST /api/data-folder/open` refuse other origins (`isOwnPage`), like `/api/quit`.

## Score scales

osu! profile page has lazer scoring switch (on by default). Off = uncapped classic scale. Both from osu!'s code via pp helper: `GetDisplayScore(Standardised)`, `GetDisplayScore(Classic)`, `LegacyTotalScore`. Stored in `scores.score_standard` and `score_classic`. Classic show rule: `legacyTotalScore ?? classicScore`.

`scoreColumn(e)` in `src/calc/eligibility.ts` is the *only* place a query names a score column. Do not write `s.total_score` in a new query (raw replay number, fallback only).

**Stable scores listed with CL.** osu! adds Classic to every legacy score before scoring. `withClassicMod` (`src/calc/pp.ts`) adds it when building rows/cards. `mods_json` keeps what player chose.

**Multi-column UPDATE generated from one list.** `UPDATE_COLUMNS` in `src/tracker/recompute.ts` builds SET clause. Never hand-align placeholders there.

## Favorites: shared by default

`config.sharedFavorites` (default true). `FavoriteScope` in `src/favorites.ts` picks table. `syncFavoriteSharing` merges per-profile lists ↔ shared, once per switch (recorded in `kv`). Nothing lost. Removing shared favorite removes from every profile's own list.

## Beatmap names, and the same names in their own script

osu!'s "prefer metadata in original language". `beatmaps.artist_unicode` / `title_unicode` come from the `.osu`'s `ArtistUnicode` / `TitleUnicode`. `''` = looked and there is none; NULL = never looked (the `length_ms` convention). `backfillOriginalMetadata` fills the NULLs in one sliced pass after the beatmap index - needed for a hundred rows at once, unlike every other lazily-filled column - with no transaction of its own, because the connection is shared with the tracker.

`src/calc/metadata.ts` is the only definition: `NAME_COLUMNS` for what a naming query selects, `names()` for what a row means, `beatmapName` / `beatmapNameOriginal` for the joined `artist - title` that Milestones, medals and Removed scores carry. Do not build `artist - title` by hand in a new query.

**Both names go to the page; the page chooses** (`web/js/metadata.js`), as osu-web does. Server-side choosing would put a display preference into `/api/profile`'s cache key - which is about what is *stored* - and make a checkbox cost a round trip. An original-language name is sent **only when it differs**, so `??` is the whole rule on the page and nearly every row carries nothing extra.

The answer lives in `config.originalMetadata` and in `localStorage`, exactly as the language does, and for the same reason: config arrives with the first API response, after the first paint.
