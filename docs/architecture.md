# Architecture

Why the code is the way it is. Each section records what was measured or decided, so the next
change doesn't undo it by accident. Roadmap numbers (5.xx) point to the fuller history in
`docs/roadmap.md`.

## osu! files

Verified against a corpus of about 2,400 real replays.

**lazer appends its own block to every `.osr`.** After the replay frames come an `int64` online
score id, an `int32` length, and LZMA-compressed JSON (`LegacyReplaySoloScoreInfo`) holding the
real mods, statistics and rank. The legacy header alone reports rank F for plays that ranked A,
which is why `osu-parsers` isn't used. lazer replays have version 30000001 or higher; stable
replays have no block. About a third of a typical lazer store is stable-format imports.

**lazer's accuracy isn't stable's formula.** It counts slider tails (150) and large ticks (30):
`sum(statistics × value) / sum(maximum_statistics × value)`, with the values in `HIT_VALUES`
(`src/calc/grade.ts`).

**lazer stores files by SHA-256, not by beatmap MD5.** A score names its beatmap by MD5, so the
app builds an MD5 index in `osu_files` (`src/clients/beatmaps.ts`) by reading every file in the
store once: about 63k files, 9s warm and 140s cold. Entries never change, so they're never re-read.
Stable's `Songs` is filtered by the `.osu` extension instead.

**The index runs beside the app, never before it.** `indexBeatmapFiles` works in 25ms slices and
commits before every pause. The connection is shared, and a transaction held across a pause would
swallow other writes. `Tracker.indexBeatmaps` puts it at the head of the ingest queue before the
watchers start, so no play resolves against a half-built index (roadmap 5.25).

**`online.db`** is a plain SQLite file lazer ships: `osu_beatmaps(beatmap_id, beatmapset_id,
checksum, approved, ...)`, about 234k rows, with `checksum` as the beatmap MD5. It's opened
read-only and may not exist on any platform. A second table, `osu_beatmapsets`, has submit and
ranked dates for ranked, approved and loved sets only.

**Never hold `online.db` open.** lazer refreshes it in place with an exclusive `File.OpenWrite`,
which fails on Windows while another process has it open (measured). `BeatmapResolver.fromOnline`
opens it per lookup, and `onlineBeatmaps` once per batch. A map ranked after the snapshot has no
status until lazer refreshes the file, so `refreshBeatmapStatuses` re-reads every played beatmap
when the file's mtime changes (`onlineDbStamp` in `kv`) and updates `map_status` and `ranked`. No
pp recalculation is needed: pp exists for every play regardless of status.

**A `.osu` section ends at the next line beginning with `[`**, never at the next `[`
(`osuSection`). `[` is ordinary inside values: mappers like `cRyo[iceeicee]`, artists tagged
`[CV. …]`, audio files named `[HD] …`. The old rule lost or corrupted 327 of 12,811 beatmap names
and filed 23 beatmaps under the wrong mode (roadmap 5.45).

## pp: osu!'s own code

`tools/PpCalculator/Program.cs` references the official `ppy.osu.Game.Rulesets.*` NuGet packages
and is driven over a JSON-lines pipe from `src/calc/official.ts`.

**Hand the helper the replay file, not a reconstructed ScoreInfo.** `LegacyScoreDecoder` sets
`IsLegacyScore` from the replay version, adds the Classic mod to legacy scores (which selects
classic slider accuracy and legacy miss estimation), fills `MaximumStatistics` and reads lazer's
block. McOsu keeps no replay, so the app builds one (see McOsu below).

**The difficulty calculator is Relax-aware.** The same RX replay is 6.26★/110.93pp as played and
7.83★/238.54pp with the mod removed. Both are stored at ingest (`pp`/`stars` and
`pp_nomod`/`stars_nomod`), and `unrankedModPp` picks one.

**pp is calculated for every score, not just ranked ones.** Whether a score counts is decided at
query time (`src/calc/eligibility.ts`), never stored. `scores` holds facts (`map_status`,
`mods_ranked`, `mods_countable`, both pp values), and `countsSql()` turns settings into the
predicate. There's one definition of "counts"; never write `ranked = 1` in a new query.

**Which mods are ranked is osu!'s answer.** `rankedByOsu` asks the helper (`"type": "ranked"`),
which builds osu!'s own mod objects and reads `Mod.Ranked`. It differs by ruleset (MR is ranked
only in mania, HR everywhere but mania), by setting (a speed change unranks DT, a pitch change
doesn't) and between releases. A hand-kept list missed AL, SG, TC, BL, NS, AC, MU, SW, CO, FI and
4K-9K, and counted CL chosen on lazer. `scores.mods_ranked_by` holds the release that answered;
NULL means unranked and stale until a recompute. The Classic mod the decoder adds to stable plays
isn't part of the question.

**Removing a score is a hide, never a DELETE.** The replay is still on disk, and a deleted row
would come back as a new play the next time the file is noticed. `scores.hidden_at` is set
instead, and `visibleSql()` filters it from every query. A removed score leaves the play count and
level bar too.

**Deleting a removed score for good keeps its key.** The row goes, but its `dedupe_key` is written
to `deleted_scores` first, and ingest and Import past plays refuse any key listed there
(`wasDeleted`). Never delete a score row any other way.

**`tools/pp/` shadows the plain build.** `src/calc/official.ts` prefers it, and a stale copy
answers the old protocol silently. After changing `Program.cs`, run `npm run build:pp:local`, not
just `npm run build:pp`.

**Every pp value carries its osu! release.** The helper reports the `ppy.osu.Game` version on its
ready line and on every answer, with a `breakdown`. Both are stored (`scores.pp_version`,
`pp_parts`, `pp_nomod_parts`), and the parts must belong to the pp beside them.

**No fallback calculator.** `rosu-pp` was removed on purpose: reimplementations lag osu!'s
reworks. When the helper is down, no pp is stored and the app says so. The only other calculator
is the same helper built from the player's own osu! source (below), which replaces the release
for the whole app and never stands in for it.

**The helper ships slim only when proven identical, on each platform, for each build** (roadmap
5.60). Full `PublishTrimmed` (113MB to 36MB) breaks inside osu!'s own graph (5.44). The slim
helper is `TrimMode=partial`, which trims only .NET's own libraries, plus the natives in
`SLIM_PRUNE_NATIVES`: 58MB against 121MB on Windows. `buildCheckedPpHelper` builds both and runs
`scripts/pp-parity.mjs` over generated plays (`scripts/pp-parity-corpus.mjs`): beatmaps for all
four rulesets built to reach every slider curve, BPM change, spinner, drumroll, juice stream and
hold, with stable, lazer and McOsu replays, every mod per ruleset, the ranked-mods question and
ten error paths. About 1,800 requests in under 30 seconds, the same on every machine, with
nothing private and nothing to download. A fully trimmed helper fails it. Slim ships only if every
answer matches; otherwise the full helper ships with the reason, and the build never fails for
it. The `pp helper` workflow runs this with `--require-slim` on all four platforms whenever an
answer could change. `--live` adds this machine's own replays. Only compare a platform's helpers
with each other. Unseeded Random and Target Practice are never sent, since osu! prices them
differently on every run.

**After a pp rework,** bump the package versions in `PpCalculator.csproj` and run
`npm run build:pp:local`. Installs reprice themselves (below).

**pp from the player's own osu! source** (roadmap 5.70; `src/calc/source-helper.ts`,
`src/pp-source.ts`). The same `Program.cs` is built against a clone of ppy/osu: a generated
project in `data/pp-source/project/` with `ProjectReference`s to the clone's `osu.Game` and
rulesets in place of the NuGet packages (what osu-tools' UseLocalOsu does), published
framework-dependent for this machine into `data/pp-source/<version>/` and pruned by the shipped
helper's own lists (`src/calc/helper-prune.ts`). It's 49MB, where unpruned it was 649MB twice
over. It needs the .NET SDK, which anyone building osu! has. A source build reports osu!'s
placeholder `0.0.0`, so its version is `source <commit>` plus `+<hash>` of every change git sees
(`git diff HEAD --binary` and untracked files): an uncommitted formula edit must change the
label, or recalculation wouldn't notice it. `config.ppSource` names the folder only once its
helper has started. `Tracker.switchCalculator` swaps between ingests and reprices every score with
a replay (not only `outdatedPpSql`'s: a custom-mod play the release couldn't price is exactly one
to reprice). A build or start that fails changes nothing, and at launch a configured source with
no working helper means no calculator (`startupCalculator`), never the release.

**A new calculator reprices what the old one priced, once, on its first launch.**
`Tracker.recalculateAfterUpdate` runs after the index and catch-up (an unindexed beatmap prices as
missing). It picks `outdatedPpSql` across every profile, hidden scores included, and runs once per
release (`kv` `pp_recalculated_for`, written when it finishes): a score whose replay is gone stays
on the old release rather than being retried and announced every launch. It's queued
`RECALCULATE_BATCH` scores at a time, so a live play waits seconds, not minutes. Other settings'
Recalculate every score is the same run over every score. Progress goes to every page as tracker
events, since nobody pressed a button for the automatic one.

## Incomplete plays: over half of plays leave no replay

**osu! counts plays it never keeps.** `SubmittingPlayer.submitScore` submits on a fail, a quit or
a retry, with no minimum object count. It needs a token, at least one non-miss judgement, and a
total above zero. Quitting before hitting anything is the only discard
(`No hits registered, skipping score submission`).

**lazer keeps a score only for a map played to the end.** `Player.prepareAndImportScoreAsync`
imports when the map was completed and passed, or when the fail screen's Save replay is pressed.
A solo fail, a quit or a retry writes nothing. Measured: 54 plays started, 45 counted by osu!, 19
replays written.

**Every rank-F replay is multiplayer.** `MultiplayerPlayer.PerformFail` suppresses failing, so the
map plays to the end and imports normally. All 22 F replays in the corpus judged 100% of their
hit objects.

**Incomplete plays come from lazer's logs**, `<lazer>/logs/<session>.runtime.log` and
`.network.log`. `Score submission completed!` means osu! accepted the play, so the play count
agrees with the website by construction. A pass shows as the screen stack logging
`suspended <Player> (waiting on <...>ResultsScreen)`; on the test session that fired 19 times
against 19 replays. Log timestamps are UTC. The beatmap id is in the network log's submission
`PUT`, joined to the runtime log by token. Multiplayer submits through `/rooms/...` and resolves to
no id, but always writes a replay anyway.

**`incomplete_plays` rows are never in `scores`.** An abandoned play has no accuracy, combo, mods,
pp or score, and a row of zeroes in `scores` corrupts weighted accuracy, grade counts, ranked
score, the level bar and medals. Counting them isn't optional, since osu! counts them;
`showIncompleteInRecent` (`yes`, `collapse`, `no`) only controls listing. `hitsPerPlay` divides by
scored plays only.

**Every figure that reads unfinished plays goes through `incompleteSql(e)`**: play count, monthly
play counts, Most Played, Recent Plays, Total Play Time and modes with plays.

**They can be removed like a score.** `setIncompleteHidden` sets `incomplete_plays.hidden_at`,
which `incompleteSql` excludes. A collapsed Recent Plays row carries every attempt's id
(`IncompletePlay.ids`), and Removed scores folds them back by shared `hidden_at`. Deleting one for
good writes `incomplete:<dedupe_key>` to `deleted_scores` (`deletedIncompleteKey`), prefixed so it
can never match a replay's key.

**Offline or signed out, osu! counts nothing, but lazer still logs it** (roadmap 5.45). With no
token, `SubmittingPlayer.submitScore` logs `No token, skipping score submission` just before the
gameplay screen exits. That line against a `SoloPlayer#N` screen that didn't reach results is an
*unsubmitted attempt*. It's never inferred from a token merely being absent; a screen that had a
token is never one; `ReplayPlayer`, the skin editor's `EndlessPlayer` and multiplayer screens
never are. These are stored in `incomplete_plays` with `unsubmitted = 1`, keyed
`unsubmitted:<log session>:<screen>:<entered>` (screen numbers repeat within a day). They're
**always recorded**, because the log is only followed live, and **counted only through
`incompleteSql(e)`** when the profile's `countUnsubmittedAttempts` is on (the default, at the
user's call: osu! never received them, so counting them contradicts nothing osu! shows).

An attempt has no beatmap id, so it's matched by the log's `Game-wide working beatmap updated to`
name against `osu_files.name`, which is lazer's own `Artist - Title (Creator) [Version]` built
from each `.osu`, unique matches only. On 20 real logs it matched 59 of 59 attempts, with no
`online.db` needed.

**Import past plays reads the logs too** (`src/tracker/log-backfill.ts`). Counted unfinished plays
and unsubmitted attempts are separate sources beside replays, and preview and import share
`checkIncompletePlay`/`checkUnsubmittedAttempt`, so the preview's numbers are the import's.

**osu!stable's unfinished plays can't be counted** (measured on `b20260711.1`, roadmap 5.12). Its
logs say nothing about plays. The only trace is a per-beatmap "last played" time in `osu!.db`,
which can't count retries or tell a fail from a pass. Don't build a play counter on it. The page
says so (`showStableNote`), and `ingestIncompletePlay` stays client-agnostic.

## Whose replay is it?

**osu! keeps the replays you watch in the same folders as the ones you set.** Stable caches a
downloaded replay in `Data/r`; lazer imports one into its store. Only the name inside tells them
apart. On one machine, 88 of 2,499 replays belonged to 62 other players, and a profile read
16,109pp because its top play was mrekk's 1,857pp Crystalia.

**Everything fails towards yours.** A wrongly tracked play can be seen and removed; a wrongly
refused one is gone. So `ownsPlay` refuses only on positive evidence, and these are always yours:

- **No name at all.** osu!stable writes an empty name for a play made signed out.
- **lazer's `Guest`**, its name for the local user when not signed in.
- **A name you used to have.** Stable replays carry no user id, only the name current when the
  play was set, so without osu!'s `previous_usernames` every pre-rename play looks like a
  stranger's.
- **A play osu! never accepted.** Stable's username is a line in a config file, so an offline play
  can carry any name, even a real player's. But a downloaded replay is a score osu! put on a
  leaderboard, so it always has a score id. Measured: all 91 replays by other players had an id,
  and 258 of the owner's did not.
- **A play set just now** (`setJustNow`). A replay arriving while tracking, set within
  `JUST_SET_MS` (5 minutes) before it arrived, was set here, whatever name it carries; a
  downloaded one carries the time it was set on osu!. After a rename osu! can remember the old
  sign-in name while every replay says the new one, and this alone keeps those plays. Live only.
  A differing lazer `user_id` still outweighs it.
- **Not knowing.** An identity nothing could establish never refuses anything.

**Who am I?** (`resolveIdentity`): whoever osu! says is signed in here (lazer's `game.ini` and
stable's `osu!.*.cfg`, both `Username`, via `detectLocalSessions`; both, if the clients are signed
in as different accounts). Failing that, the name behind at least 80% of the profile's own tracked
plays, over at least 10. Failing that, nobody, and nothing is refused. A lazer replay's `user_id`
settles it outright and survives renames; stable records none.

**A linked account isn't ownership.** Import from osu! lets a profile borrow a name, avatar and
banner, often someone else's. When the link decided ownership, a profile linked to another account
refused the real player's every submitted play while keeping their fails. Now a link counts only
when its name or a previous name matches a signed-in name. It then adds osu!'s previous usernames,
and its id only when every signed-in client is that account.

**"It's me"** on a play refused as another player's asks osu!, once on the press, whether that
name and the profile's are one account (`confirmSameAccount`). On a yes, the account's every name
goes into `accountNames`, which joins the profile's names only while one of them is signed in.
Plays refused under those names are then judged again by the ordinary ingest
(`Tracker.retrackOwnNames`), filter included; Track anyway stays the only way past the filter.
osu! being unreachable is an error, never a "not you".

`scores.player_name` and `player_id` record who set each play at ingest, so nothing later has to
reopen a replay that may be gone.

**The score id is read from wherever the replay keeps it.** lazer writes `0` in the legacy header
and the real id in its own block. `online_score_id` stores whichever is real.

**Removing ones already tracked** ran once per profile (`kv` `foreignScoresSwept:<id>`), only on a
linked account that's the one signed in and whose previous names were actually fetched
(`linkedNamesKnown`: an empty list can't be told from one nobody asked for). Every removal is a
hide, listed under Removed scores and reversible, which is what makes doing it unprompted
defensible.

## Importing an osu! account's own scores

A best performance may have been set years ago on another PC, on a map never installed here.
Nothing local can find it, but osu! has it.

**No credentials.** `/users/{id}/scores/best` and `/scores/pinned` answer JSON to anyone, like
`/beatmapsets/favourite`, paged with `?mode=&limit=100&offset=N` until a page comes back empty.
osu! keeps 200 best performances per ruleset, not the 100 its page shows.

**Stored with osu!'s pp, then priced here** (roadmap 5.64). The import stores osu!'s figure first
(`pp_source` `osu-web`), then builds each score into a replay from what osu! sent and puts that in
its row's place (`convertImportedScores`). From then on it's priced like any other score, so a
rework never leaves imported scores on old numbers. A score whose beatmap isn't installed keeps
osu!'s figures (which recompute leaves alone, `imported_at IS NOT NULL`) until the beatmap is
downloaded, after an import or on Recalculate every score, or installed.

**Star rating is stored only when the mods can't have changed it** (`RATING_NEUTRAL_MODS`). osu!
sends the unmodded rating, so an HR or DT play stores none rather than a wrong one.

### Deduplication

The same play can arrive from osu!'s record and from its replay, and the two share no key: a
replay knows its hash, osu! knows its score id. So both go through `findExistingScore`
(`src/tracker/online-import.ts`):

1. **An online id**, which is conclusive. lazer and stable number scores differently, an imported
   row keeps both (`online_score_id`, `legacy_score_id`), and a replay carries whichever its client
   used, so ids are matched as a set against both columns. Stable's `0` isn't an id.
2. **The play itself**, for a stable replay from before 2014 with no id: same beatmap MD5, same
   total on some scale, same max combo, within 5 minutes. An imported row stores `total_score` on
   the scale its replay would carry, which is what makes the exact match possible.

**The best record of a play wins, in place.** `findExistingScore` reports how good the existing
row is (`RecordKind`: `osu` figures, a `built` replay, a `replay` osu! wrote), and a better one
replaces it with the same row id, pin and removal kept, and `imported_at` cleared. An equal or
worse record leaves it alone. A re-import only updates rows still on osu!'s figures, since osu!
reworks pp and re-ranks beatmaps.

**Replays are looked for right after an import** (`Tracker.attachLocalReplays`,
`src/tracker/replay-search.ts`). An import from osu! and a score link search every install's replay
folder for the replays of the plays they brought in, and ingest each one found in its row's place.
Only for rows with no replay osu! wrote (never one entered by hand), and only their own replays,
never "everything in the range". No filter or owner check, since the play is already in the
profile. Files older than the oldest wanted play are skipped by mtime, the rest are read a header
at a time, and only replays on a wanted beatmap are inflated.

### Borrowed bonus pp

osu! awards bonus pp for how many ranked beatmaps an account has ever played, so a profile holding
200 imported scores would land hundreds of pp short. The import records osu!'s own total
(`imported_standing`) and stores the shortfall: osu!'s total minus the weighted sum over
`TOP_PLAY_LIMIT` of the same scores. Measured: 7,380.07 − 6,931.85 = 448.22, landing the profile on
7,380.07 exactly. `computeStats` takes `max(earned, borrowed)`, so real plays take over gradually
with no backwards jump. A reset clears it. On a long-played account it may never be superseded,
which is right: `bonusPp` tops out at 413.894, while the borrowed figure also carries the tail past
the hundredth play.

## Live tracking starts at the launch

**A play set while the app was closed is never tracked when it opens.** Closing the app is how
people stop tracking (another playstyle, a warm-up, someone else on the keyboard), and catching up
at the next launch would overrule that irreversibly.

`Tracker.liveCutoff` is `max(profile.trackingSince, liveSince)`, with `liveSince` set by `start()`.
All three live paths ingest against it (`handleReplay`, `handleLoggedPlays`,
`handleUnsubmittedAttempts`), and a play before it is `skipped: 'too-old'`. Toggling tracking off
and on re-arms it. Each watcher also starts at "now" on its own, but that's two promises in two
files that an unrelated change could weaken; the cutoff makes the promise once.

Import past plays supplies its own `since` and is unaffected. `TrackerOptions.liveSince` exists
only for tests; nothing in the app passes it. The startup banner states the rule every launch.

### Catching up on the gap, when the profile asks

`importPlaysWhileClosed` (per profile, off by default) makes a launch import what was played while
the app was shut. It doesn't weaken the cutoff: `Tracker.catchUp` calls `Tracker.backfill`, so it's
an import with an import's filter, dedupe and owner check.

The gap is `[kv.lastRunAt, now]`, floored at the profile's `trackingSince` (`catchUpSince`).
`lastRunAt` is written at startup, at shutdown and on a 30-minute heartbeat. The heartbeat is slow
because every write resets `/api/profile`'s cache, and slowness is safe: a stamp left by a crash is
older than the real shutdown, so the next launch scans a little further back and dedupe turns away
the overlap. No stamp (a first launch) means no catch-up. It covers every source, and is announced
through the `caught-up` SSE event and a toast.

## Play tracking filter

Decides whether a play is **written**. A declined play is never a row of `scores` or
`incomplete_plays`; it's recorded in `declined_plays`, which no figure reads.

- Off by default, and switching it on narrows nothing, since every criterion starts widest.
  `filterNarrows` is separate from `enabled`.
- A fact the filter doesn't have never rejects a play. A quit or fail has no mods or star rating,
  so those two criteria don't judge it.
- A declined play is announced: a log line, an SSE `filtered` event, a toast naming the criterion,
  a count in `/api/state`, and a row in `declined_plays`.
- Nine criteria, matched against the replay, the `.osu` and `online.db`. The same answer at live
  ingest and in Import past plays, unless that import is told otherwise: its checkbox (ticked by
  default, re-ticked every time the dialog opens) can run one import against
  `defaultTrackingFilter()`, which permits everything. `applyFilter` is absent-means-true on the API.
  Preview and import get the same answer.
- `scripts/reingest.mjs` must not pass a filter.
- **Date added is the file's creation time, never mtime.** lazer imports keep mtimes from 2019-2021
  and were created in 2025; mtime is the beatmap's own age. With no creation time, mtime stands in.
- Star rating and length are judged as played, mods included. Beatmap dates and length are filled
  lazily on `beatmaps`: NULL is never looked up, 0 is looked up and unknowable.

### Plays not tracked, and Track anyway

A toast reaches only a visible tab, the launcher hides the console, the count resets at launch, and
an import declines hundreds of plays at once, so "why is my play missing?" had no answer a day
later. `src/tracker/declined.ts` keeps what the app announces: plays the filter declined, replays
another player set, and replays that couldn't be read, from live tracking, Import past plays and the
launch catch-up (`source`). Skips that are the app working as meant (duplicate, deleted for good,
before the cutoff) aren't kept.

- Recorded by whatever turned the play away, when its context names a `declines` source:
  `ingestScore`/`ingestReplayFile`, `settle` in `incomplete.ts`, and the import scan's
  `onOtherPlayer`. A preview, a re-ingest and Track anyway record nothing.
- One row per play (`UNIQUE (profile_id, kind, dedupe_key)`), at most `MAX_DECLINES` (1,000) per
  profile, newest kept. Each row is named when declined (`describe`), so it still reads if the
  beatmap goes.
- **A play tracked by any route leaves the list and never re-enters it.** `recordDecline` refuses a
  play already in the profile; without that, a play tracked anyway came back at the next import. A
  reset clears the list.
- Deleted for good (the red minus) as a removed score is: the key goes to `deleted_scores`,
  `incomplete:`-prefixed for an unfinished play. An unreadable replay has no such key (it's keyed
  `file:<path>`), so deleting one only takes it off the list.

**Track anyway** (`Tracker.trackAnyway`, `POST /api/declined`) is the one exception to "the filter's
decision stands": one play, pressed by name, never a setting. It re-ingests that play with a filter
that permits everything, no owner (`UNKNOWN_IDENTITY`) and no cutoff, and skips nothing else, so the
duplicate and deleted-for-good checks still hold. A replay is read again from its file (gone means
`missing`, still listed); an unfinished play is written from the `Recording` stored when it was
declined. The page asks twice before tracking someone else's play.

## Total Play Time

osu!'s server rule (`PlayValidityHelper.GetPlayLength`): per play,
`min(beatmap total_length / rate, ended_at - started_at)`, failed plays included. In
`src/calc/play-time.ts`, a finished score (which has no start time) uses length over rate, which is
the smaller side for a completed map anyway. An incomplete play uses token time to submission,
capped at the map's length. Rows from before `started_at` existed count nothing. Beatmap lengths
are read lazily into `beatmaps.length_ms` (0 means unreadable).

## Favorites

One request per favourite: `osu.ppy.sh/beatmapsets/<id>` embeds the whole set as
`<script id="json-beatmapset">`, cached in `beatmapset_details`. Offline, `localCard` in
`src/favorites.ts` builds the card from `online.db`, the beatmap cache and the profile's own
scores. Favourites survive a reset and are never written to osu!.

Shared by default (`config.sharedFavorites`). `FavoriteScope` picks the table, and
`syncFavoriteSharing` merges per-profile lists with the shared one once per switch (recorded in
`kv`), so nothing is lost. Removing a shared favourite removes it from every profile's own list.

## osu! account link: no API, no credentials

`osu.ppy.sh/users/<name>` redirects to the numeric id and embeds the public user object as
`data-initial-data`, the same data as the API's `/users/{user}`, with no OAuth. It may change, so
`src/clients/osu-web.ts` fails loudly rather than returning an empty user. One request per button
press, copied into `data/`, nothing on a timer.

## Server: localhost only, checked on every request

The page can reset and delete profiles and remove scores with no auth, so `startServer` refuses
every non-loopback request, with no switch. `loadConfig` drops the old `shareOnNetwork` key
(`RETIRED_KEYS`). Don't bring it back.

**Don't bind to `127.0.0.1`.** It drops IPv6 loopback, and on Windows `localhost` resolves to `::1`
first, so the app would be unreachable from its own browser. It also makes `listen` async, which
breaks `server.address()` in tests.

`/api/quit`, `/api/update/*`, `PUT /api/restore`, `POST /api/restore/apply` and
`POST /api/data-folder/open` refuse any `Origin` but the app's own page (`isOwnPage`), or any
website open in the browser could call them.

## The page

Plain HTML, CSS and ES modules, with no framework and no build step. The page is data in, DOM out:
an SSE event triggers a refetch and a re-render of the affected block, which is plenty for a page
that changes when a play lands, and editing `web/` is just a reload.

**Keep `[hidden] { display: none !important; }` in `web/css/base.css`.** A `display: grid` backdrop
once outranked the browser's low-specificity `[hidden]`, so the reset dialog was open on load with
Cancel, Escape and the backdrop all apparently dead. The destructive button was the only one that
worked, and it cost a user their tracked scores. `npm run ui` checks dialog visibility for this
reason.

**Use `--hsl-b*`, not `--hsl-d*`.** osu-web has two dark families and the profile page is built on
`b*`. A mistyped custom property makes the whole declaration invalid and silently falls back to
transparent, which reads as a slightly-off shade rather than an error, so `npm run ui` checks that
surfaces resolve to their token colours.

**`var()` doesn't work in SVG presentation attributes.** `stop-color="hsl(var(--x))"` is silently
dropped; `style="stop-color: hsl(var(--x))"` works, because inline style is parsed as CSS.

**The typeface is Nunito, drawn heavier than asked.** osu! uses Torus, which can't be shipped.
Nunito is the closest free face, and ships in `web/fonts/nunito/` (`web/css/fonts.css`). Measured
against osu.ppy.sh in the same browser: at 200px the two have the same stem at weight 400, but at
12-16px, where most of the page's text is, Torus snaps its stems to whole pixels and Nunito's blur
to grey, so Nunito at the same weight puts down about a fifth less ink and reads skinny. So each
`@font-face` band draws Nunito heavier than the weight asked for (`font-variation-settings`):
400 as 600, 600/700 as 750 (osu! only loads Torus up to SemiBold, so its 600 and 700 are the same
face), 800+ as 850, and 300, the big light figures, as asked, since it already matches. The CSS
everywhere else keeps osu-web's own weights. The one trade-off is large 400 text, like the 24px
name, which comes out a little heavier than osu!'s.

Other settings -> Font can switch to the system's own font instead (`config.font`, `web/js/font.js`),
kept in `config.json` and `localStorage` like the language: `data-font="system"` on `<html>` brings
back the old font list at osu-web's weights as asked. The score page asks `/api/app-config` for it,
so a score screenshot, rendered in a browser with no storage, agrees. Both pages wait for
`document.fonts.ready` before telling the screenshot renderer they're done, since Nunito's text isn't
drawn at all until it loads (`font-display: block`). A saved copy carries the font files, once per
weight band.

**Section headings stay block-level.** As `inline-block` they flowed "Top Ranks" and "Best
Performance" onto one line. `npm run ui` checks they stack.

### Charts

Both charts draw in a 0..100 space with `preserveAspectRatio="none"`, so they're responsive without
measuring the DOM, and everything inside is stretched by the container (a circle becomes an
ellipse). So axis labels, the hover marker and the tooltip are HTML positioned over the plot in
percentages, strokes use `vector-effect="non-scaling-stroke"`, and there are no dots. osu-web does
the same. The line is `@yellow` `#ffcc22` at 2px; tooltips read `Global Ranking #123` over
`40 days ago` and `Plays 430` over `March 2020`, all from osu-web's source.

Section lists are paged by the server: the page asks for a size per section and gets totals.
"Show more" needs both "the page came back full" and "total > returned", because Recent Plays counts
plays but draws rows, and collapsed retries are several plays in one row.

### Shared web page = the page itself

Share -> Save as web page (`web/js/share-copy.js`) saves `index.html`, the CSS, the bundled modules
(`web/js/bundle.js`) and a snapshot of the API. `web/js/static-mode.js`, `main.js`'s first import,
serves the snapshot in place of the app with a stand-in `fetch` and a no-op `EventSource`. So:

1. Page modules must stay bundleable: named `import { } from './x.js'` and
   `export function / async function / const / class` only. `test/bundle.test.ts` bundles the real
   page and syntax-checks it, and `npm run ui` loads a real copy and clicks Show more.
2. Images the app serves go through `assetUrl()`, and stylesheet pictures through relative
   `url()`s, which `inlineCssUrls` turns into data URIs. A copy never contains install paths or
   other profiles, which is why the data folder's path has its own endpoint (`/api/data-folder`)
   rather than a field in `/api/state`.

The live feed is SSE, and a browser allows 6 connections per origin, so only a visible tab holds
the stream open (`web/js/main.js`), or open tabs starve the page itself.

## osu-web fidelity

Read `docs/osu-web-fidelity.md` before any "make it look more like osu!" work. It maps every
visible region to the osu-web file behind it and has the clone command for the gitignored
`reference/osu-web` checkout.

**osu-web's own files, under its licence** (roadmap 5.57). The project moved from MIT to
AGPL-3.0-or-later, osu-web's licence, so osu-web code and artwork can be used with credit. Up to
v1.22.0 stays MIT, and that notice is kept in `THIRD-PARTY-NOTICES.md`.

- **Artwork is vendored, never hand-copied.** `npm run build:osu-web`
  (`scripts/build-osu-web-art.mjs`) copies mod glyphs and badge blanks, GradeSmall badges, stable's
  `legacy-ranking-*@2x.png`, the guest avatar, the default banner and the four mode icons into
  `web/osu-web/` byte for byte from one osu-web commit (recorded in `web/osu-web/README.md`;
  `.gitattributes` keeps line endings untouched), and writes `web/css/osu-web-art.css`. The
  acronym-to-glyph table is read from osu-web's `mod.less`. `test/osu-web-art.test.ts` checks every
  mod in `mod-definitions.js` has a glyph.
- **Markup follows osu-web's.** `modPill()` builds `mod.tsx`'s DOM and `.mod` in `profile.css` is
  `mod.less` ported. `gradeBadge()` is `score-rank`, `legacyRank()` is `legacy-rank`, `guestAvatar()`
  is `avatar--guest`.
- **Still off limits:** `ppy/osu-resources` (CC-BY-NC, incompatible with the AGPL), Torus and Venera
  (licensed to osu!'s website alone), and the osu!/ppy logos (trademarks).

Flags come from Twemoji (CC-BY 4.0, where osu! got them too). Generated files:
`web/js/mod-definitions.js` (`npm run build:mods`), `web/flags/` (`npm run build:flags`),
`web/osu-web/` and `web/css/osu-web-art.css` (`npm run build:osu-web`).

## Medals: osu!'s definitions, not symmetric

`src/calc/medal-definitions.json` is generated by `scripts/build-medal-table.mjs` from osu!'s
profile-page payload. Don't hand-edit it.

- Combo and play-count medals exist for osu!standard only. taiko, catch and mania have hit-count
  medals instead.
- Star pass and FC medals are 1-10 in standard and 1-8 elsewhere. Following osu!'s
  `StarRatingMedalAwarder`, each is its own band (`n <= stars < n+1`), never the ones below; it
  needs a play that `countsSql`, never on Qualified or Loved, with no Difficulty Reduction or
  Automation mod (`modTypes.reduction`), no key mods or DS in mania, and taiko beatmap 19990 exempt.
- **Mod Introduction** is the only other group (the user chose it): the mod alone at its defaults,
  system mods and CL ignored, SO in standard only, NC and DC aren't DT and HT, passes only, and
  Conversion and Fun are lazer-only mod types.

The page shows icons only, grouped Mod Introduction then Skill & Dedication. The hover card is one
shared `#medalTooltip` positioned in window coordinates. The header's medal figure is account-wide
(`earnedMedalCount`). An earned medal is a Milestones event (`medalEvents`), except rank medals
(`dated: false`).

Medals are derived from scores on every request and never stored, except what an Import from osu!
with Medals ticked copies (`imported_medals`, `src/imported-medals.ts`): only slugs `isAppMedal`
knows, replaced whole per import, cleared by a reset. `computeMedals` takes whichever of derived
and imported is earlier and marks imported ones `fromOsu`. The server broadcasts `medals` before any
other event of that import, so pages don't toast dozens of old medals. A full combo needs
`beatmap_max_combo`, since lazer drops slider ends without breaking combo; rows without it are
unknown, never guessed.

## Global rank: estimated from a sampled curve

Rank comes from `src/calc/rank-tables/<mode>.json`, built by `scripts/build-rank-table.mjs` from
data.ppy.sh's `performance_<mode>_random_10000` dump: a random sample across the whole ladder in
which every user carries their real rank, so nothing needs modelling. Interpolation is linear in
log rank (6 orders of magnitude, against 3 for pp). It's labelled as an estimate. It's allowed where
a second pp calculator isn't, because a stale curve degrades gradually. Refresh it with a newer
`--dump` (see `docs/maintaining.md`).

**Country rank is deliberately not shown.** 10,000 sampled users over about 200 countries is far
too thin, and a made-up number would be worse than a dash.

## `fs.watch`: never pass an unresolved path

On Windows, libuv compares the filename from `ReadDirectoryChangesW` against the path it was given
and **aborts the process** on a mismatch: a junction, a drive substitution or an 8.3 short name does
it. CI runners hit it (`C:\Users\RUNNER~1\...`). `watchablePath` in `src/tracker/watcher.ts`
resolves the folder, and paths are reported against the configured folder so nothing downstream
sees two spellings.

**Watcher tests must let the watch come up before the first write.** macOS starts its FSEvents
thread at the first `fs.watch`, and a write during startup isn't reported. `await sleep(SETTLED_MS)`
after `start()`.

## osu!stable specifics

Verified on a real install.

- **The Songs folder can be moved.** Stable writes its path to `BeatmapDirectory` in
  `osu!.<user>.cfg`, which `stableSongs` (`src/clients/detect.ts`) reads. A relative value resolves
  against the install; a stale one falls back to `<root>/Songs`.
- **The signed-in username** is in the cfg only if "remember" was ticked. Otherwise
  `detectLocalSessions` finds nothing and the page falls back to typing a name.
- **Ranked status for stable plays comes from lazer's `online.db`.** A stable-only install resolves
  every beatmap to `UNRESOLVED_STATUS`; pp is unaffected. `BeatmapResolver.knowsStatus` is false and
  `countsSql` counts unresolved beatmaps too. The Scores note says so and the beatmap-status
  settings are dimmed. It isn't a setting: it follows what the machine knows.
- **A beatmap downloaded mid-session** (osu!direct, every multiplayer pick you lacked) lands in a new
  `Songs` folder the replay watcher doesn't see. `SongsWatcher` (`src/tracker/songs-watcher.ts`)
  watches `Songs` itself, non-recursively (a recursive watch is an inotify watch per set folder on
  Linux), and indexes each new set's `.osu` files. A lookup that finds nothing calls
  `BeatmapResolver.onMiss` to flush first. A cached miss is never final: `resolve` looks again once
  the file is indexed, and `Tracker.repairScores` recalculates plays stored before their file was
  found.
- **Mods are the whole bitmask, per ruleset.** `decodeLegacyMods(bits, ruleset)` mirrors each
  ruleset's `ConvertFromLegacyMods`. It once read only bits 0-14, so ScoreV2 (bit 29) was stored as
  nomod; rows stored that way are re-decoded once (`legacyModsRedecoded` in `kv`).
- Stable writes no replay for a multiplayer fail, as for a solo one.

## Scores with no replay: from a link, or by hand

**pp never reads where anything happened** (roadmap 5.64). osu!'s calculator prices from
judgements, combo, mods and, for a stable play, the total stable recorded: everything a replay's
header and lazer's block hold. Cursor data never enters it. So a replay *built* from a score's
numbers gives the calculator exactly what the real one would. Measured: a 2015 stable score with no
replay anywhere, 175.697pp on osu! and 175.6969 here; a lazer score, 338.837 and 338.8372.

So these follow McOsu's arrangement rather than storing and re-fetching osu!'s pp: the user wanted
every score repriced here, offline, by one calculator.

- **Built replays** (`src/built-replays.ts`, written by `src/replay-writer.ts`, shared with McOsu): a
  stable score from its link as a stable replay with its legacy id and stable's total; a lazer one
  as a lazer replay with its statistics, mods and settings in lazer's own block; a hand entry as a
  stable replay of the judgements typed. An app block (`osu-local-profiles:built`) records `origin`
  (`link`/`manual`) and whether the header's total is stable's (`legacyTotal`); without one, pricing
  gets `ignoreLegacyTotalScore`, as McOsu does. Kept in `data/replays/` (named by MD5) and in every
  backup.
- **Beatmaps**: one not installed is downloaded once from `osu.ppy.sh/osu/<id>` (no login), its MD5
  checked against the score's (osu! serves the current version, and a map updated since can't price
  the play), then kept in `data/beatmaps/`, indexed and backed up.
- **`scores.origin`** (`link`/`manual`, NULL otherwise) is written by ingest from the block. It
  drives `Play.source`, the "Manually entered by hand" tag on a typed-in score (the only tag a
  score carries: osu!'s own record of a play gets none, at the user's request), and the refusal
  of Download Replay. Recompute re-reads the file, so nothing else special-cases them.
- **A link** is read from the score page's `<script id="json-show">`, the same object `/scores/best`
  returns. **There are two id schemes:** a stable replay's online id is a legacy id, found only at
  `/scores/<ruleset>/<id>`; the same number at `/scores/<id>` is a different player's score.
  `parseScoreLink` keeps the form it was given. No filter or owner check: the user named this score.
- **By hand**, everything is checked before anything is kept: the ruleset, judgements adding up to
  the objects, mods that are the ruleset's stable mods, a date after osu!'s release, and the combo
  against osu!'s own maximum for the beatmap, priced first without writing (`Tracker.priceReplay`).
  No calculator, no entry: pp is never typed.

## McOsu

McOsu writes **no replays and no log** (roadmap 5.58), only its own `scores.db` (and `scoresvr.db`
for VR), rewritten after each play it keeps: finished, not failed, score above zero, not Autoplay or
AP+RX. Fails, quits and retries leave nothing, so they can't be counted.

- **Each play becomes a built osu!stable replay** in `data/mcosu/<md5>-<unix seconds>.osr`: the
  entry's judgements, combo, total and mods, no cursor data, then the app's own block
  (`MCOSU_BLOCK` plus JSON of what the bitmask can't hold). osu!'s decoder treats it as a stable
  replay and ignores the block. From there it's an ordinary replay for dedupe
  (`mcosu:<md5>:<ms>`), import and recalculation. It survives deletion in McOsu. **Never offered for
  download** (`has_replay`, `replayAvailable`, `replayDownload`).
- **Live:** `McosuWatcher` watches the McOsu folder (through `watchablePath`), remembers what was
  there at start, and builds a replay for each new entry. Import past plays builds the range first
  (`buildMcosuReplays`). McOsu's copies of stable scores (`isImportedLegacyScore`) are never built.
- **Mods are what osu! would write** (`mcosuMods`): speed from what was played, not the bits (the
  speed slider sets none); overrides as Difficulty Adjust after EZ/HR, since osu! applies mods in
  order; Nightmare (Cinema's bit in McOsu) and the experimental mods as the app's own **MC**, never
  shown to osu!'s calculator. A speed outside 0.5x-2.0x or a value past DA's limits stores no pp,
  since osu! would clamp rather than refuse.
- **The stable total is withheld** (`ignoreLegacyTotalScore`) where McOsu's multipliers for its bits
  differ from osu!'s for the priced mods (`legacyTotalComparable`). osu! uses the total to estimate
  combo breaks.
- **Scored as stable everywhere** (`scoredAsStable`). The player name is McOsu's `name` setting and
  is left out of `dominantTrackedName`. Found on every launch from Steam's libraries, outside
  `missing()`, so it never triggers a drive walk.

## osu!'s development client

A Debug build of ppy/osu is tracked **beside** release lazer (roadmap 5.68): `OsuInstall.development`,
with its own slot in `installsFrom` and `discoverInstalls`.

- It's recognised by its realm, `client_<schema>.realm` (`DEVELOPMENT_REALM`, `lazerRealm`). The
  number is osu!'s realm schema version and moves, so never match a fixed name. Release builds never
  write one, and a folder with both is development.
- It's looked for on every launch (`lazerDevelopmentCandidates`: `osu-development`, then
  `osu-development-<n>`, beside lazer's `osu`), outside `missing()`. Its `storage.ini` is followed.
- Its account is `game.dev.ini`'s, read first in `detectLocalSessions`. Everything else (`files/`,
  `logs/`, `online.db`) is lazer's.
- Nothing records which of the two lazers a score came from.

## Windows: only verified platform

macOS and Linux are written and covered by CI, but have never run against a real osu! install.
Releases have carried `osx-arm64` and `linux-x64` zips since 1.10.0 and `osx-x64` since 1.21.0.

1. Behaviour that varies by platform sits behind a pure function that takes the platform.
   `src/clients/detect.ts` takes a `DetectEnvironment` and never reads `process` directly.
2. A platform-specific list must fail loudly when it matches nothing. The pp helper's pruning
   matches by base name across `.dll`/`.dylib`/`.so` and warns when nothing is pruned.

**The launcher runs the runtime beside it**, by absolute path (`tools/launcher/launcher.go`). The
old `.bat` needed `.\node.exe`, because `cmd` searches PATH for a bare name when
`NoDefaultCurrentDirectoryInExePath` is set (Claude Code's shell sets it). The root `start.bat` is
for development only. Test a `.bat` as `.\x.bat`.

**`cmd` spawns need `windowsVerbatimArguments`.** Node quotes by C runtime rules and `cmd` doesn't
unescape, so `start ""` arrives as `start "\"\""`. `src/browser.ts` builds the line as a pure
function.

**macOS: one approval, then the launcher lifts quarantine.** Browsers and Archive Utility quarantine
every unpacked file, and Gatekeeper refuses each unsigned one as it loads: `node` is notarized, but
`osu-pp` and its native libraries are ad-hoc signed. After the `.app` is approved once (macOS 15:
Privacy & Security -> Open Anyway), it runs `xattr -dr com.apple.quarantine <folder>` when `node` or
`osu-pp` still carries the attribute. Updates never carry quarantine, since the app downloads them
with `fetch`. The real fix is Developer ID signing and notarization ($99 a year), not done.

`config.installRoots` is the escape hatch for layouts nobody anticipated (stable under unusual Wine
wrappers, say).

## Updater: rewrites the app's own folder

`src/update/` and `scripts/apply-update.mjs`.

**Four safety properties:**

1. **`data/` is never touched.** `dataDir()` is `<install>/data`, and the swap steps around it.
2. **Nothing is deleted while still needed.** Outgoing files are moved to `.rollback-<stamp>/`,
   which the swap deletes once the new build is on disk and its manifest reads back. The way back
   from a bad release is to download the previous one.
3. **Nothing is swapped until the new build is verified**: download size, unpacked tree shape, and
   the version in its `package.json`.
4. **A source checkout refuses** (`start.bat` runs `node src/main.ts`). Both `.git` and a missing
   bundled runtime are checked.

**The swap runs from the staged build using its own runtime**, because the running `node.exe` is
locked on Windows. That's why `scripts/apply-update.mjs` ships in every package.

**Relaunch only somewhere the app can be stopped from, or not at all.** A copy started with nothing
to stop it keeps tracking and holds the port, findable only in a process list. Up to 1.13.2 it came
back exactly so on macOS and Linux.

- **The tray launcher restarts the app itself, on every platform.** It runs the app with
  `OSU_LOCAL_PROFILES_LAUNCHER=tray`; the app passes `--launcher-restarts` to the swapper, writes
  its pid to `data/update/swapper.pid` and exits 75 (`RESTART_EXIT_CODE`). The launcher waits for
  that pid, releases its instance lock, starts the launcher now at its own path (the new release's)
  and exits. `test/launcher.test.ts` runs the real launcher through this.
- **A running launcher can be swapped on Windows.** Renaming a running `.exe` works; deleting one
  fails with `EPERM` (measured). The swap renames, and a rollback copy still holding the old exe is
  swept by `pruneUpdateLeftovers`.
- **`start.sh` with no desktop** keeps a terminal loop: `OSU_LOCAL_PROFILES_LAUNCHER=restarts`, wait
  for the pid, run itself again.
- **Otherwise the swapper relaunches, per `relaunchPlan`** (pure, in `scripts/apply-update.mjs`).
  Windows: the launcher exe. macOS: `open -n` on the bundle (without `-n`, a launcher still exiting
  is only brought forward). Linux: the launcher when `DISPLAY` or `WAYLAND_DISPLAY` is set, else no
  relaunch, noted in `data/update.log`. Never the runtime directly. This is reached only from
  releases that don't restart the app (up to 1.13.2 on unix, 1.16 on Windows).
- **The swapper is the new release's; the launcher is the old one's.** 1.14-1.16 unix launchers
  restart by running `./<own name>` again, so `start.sh` and `Start osu! local profiles.command`
  keep those names and start the tray launcher.
- `verifyStaged` requires the tray launcher in a downloaded build, since the relaunch depends on it.

**The zip reader is our own** (`src/update/zip.ts`), which avoids a dependency and Windows-only
`tar.exe`. It refuses zip64 and path traversal, handles the backslash separators our packager
writes, and restores Unix permission bits.

**`pruneUpdateLeftovers` at startup** clears the staged tree in `data/update/` (the swap can't
delete the folder it's running from) and any rollback left over, but keeps `data/update.log` and a
waiting build that's still newer than the running version.

**Checked at startup, then daily while running** (`keepCheckingForUpdates`, roadmap 5.65), by the
wall clock, looked at every 10 minutes since a timer doesn't count sleep: due 24h after a check, 1h
after a failed one. A newer release is broadcast once (`update` SSE event) and offered by the tray
through `/api/app`'s `update` (`offeredVersion`). `checkForUpdates: false` turns it all off. A
failed check shows nothing.

**Installing ahead of time, and at quit** (roadmap 5.66):

- **A release is its four zips and nothing else** (5.69). 5.66 also published each package in parts
  with a manifest, which put 21 extra files on every release page, several of them zips that looked
  like the download and wouldn't run, so the user had it taken out. An update downloads the full
  zip, which 1.27.0 installs fall back to when they find no parts.
- **Waiting builds.** `prepareUpdate` stages into `data/update/<version>` and writes
  `data/update/ready.json` (`requested: auto | user`, `attempts`). It installs at a deliberate quit
  (`installAtQuit`, swapper `--no-relaunch`) or at the next start (`installAtStart`, before anything
  is tracked), and only if the user asked ("When I quit") or Auto-update is on. **One attempt
  each**: a start that finds `attempts > 0` still on the old version drops it, or a failing swap
  would stop the app ever starting.
- **A deliberate quit** is the page's Quit, Ctrl+C, or the tray's Quit, which writes
  `{"quit":true}` down stdin before closing it (`stopWhenLauncherCloses`). The launcher dying or the
  system shutting down closes stdin with no such line, and never starts a swap that could be cut off
  halfway.
- **Metered connections.** The launcher reads the system's answer (Windows
  `GetNetworkConnectivityHint`, NetworkManager's `Metered` over D-Bus; macOS isn't asked) and writes
  `{"metered":...}` on change. Auto-update never downloads on a metered connection; a download the
  user asks for does.
- **`--no-relaunch` is permanent.** An older app hands the swap to the new release's swapper, so
  every later `apply-update.mjs` must keep understanding it.
- **Patch notes.** Before an update: each release page's own lines, which `releaseNotes` writes from
  the CHANGELOG, including `<!-- important -->` (`notesFromBody`), fetched in one API request per new
  version found (`fetchRecentReleases`). After one: `release-notes.json` in the package
  (`notesJson`), shown since `kv.lastSeenVersion` (`src/update/whats-new.ts`). `nudgeFor` shows the
  notice at the foot of the page for an important version, or once the oldest missing one is 14 days
  old; dismissed, it stays away 7 days unless something important comes out.

## Launcher: a tray icon

`tools/launcher/` (Go, `fyne.io/systray`) is what a package opens: `osu! local profiles.exe`,
`osu! local profiles.app` or `osu-local-profiles`. Built by `scripts/build-launcher.mjs`, so a
package needs Go.

**Why Go:** one codebase gives a small native binary for all three systems, the Node process stays
free of native modules, and no GUI toolkit or webview ships. Windows and Linux need no cgo; macOS
does (Cocoa), so like the rest of a package it builds only on a Mac.

**It's the app's off switch, so it must never lose the app:**

- The app's stdin is a pipe whose write end only the launcher holds. Tray Quit closes it, and so
  does the system when the launcher dies however it dies. The app's `stopWhenLauncherCloses` then
  shuts down.
- Quit escalates to a kill after 15 seconds.
- Exit 0 ends the launcher. Exit 75 is an update. Anything else keeps the icon with **Start again**
  and the log, and shows the log's last lines in a dialog.

**Finding it again:** a second start finds the instance lock taken (a named mutex per folder on
Windows, `flock` on `data/launcher.lock` elsewhere, both released however the process ends) and
opens the first copy's page once `/api/app` answers. A start that finds `/api/app` answering on the
port (another folder, or `npm run dev`) opens that page. `node src/main.ts` makes the same check
(`runningInstance`).

**No console:** output goes to `data/logs/app.log`, and the previous run's to `app.previous.log`.

**Per platform:**

- **Windows:** GUI subsystem (`-H windowsgui`), and the app runs with `CREATE_NO_WINDOW`, which its
  children (the pp helper, `cmd` for the browser) share. go-winres embeds the icon, version and a
  DPI-aware manifest. Unsigned, so SmartScreen asks once.
- **macOS:** a bundle with `LSUIElement` (no Dock icon), plus `setActivationPolicy:Accessory` for a
  bare binary, and a template icon. Signed ad hoc as a bundle, since an unsigned one downloaded on
  Apple silicon reads as damaged. A quarantined bundle opened in place is App Translocated (run from
  a random read-only copy with no `data/` beside it); the launcher finds the real path
  (`SecTranslocateCreateOriginalPathForURL`), lifts the quarantine there, `open -n`s it and exits.
- **Linux:** StatusNotifierItem over D-Bus. With no `org.kde.StatusNotifierWatcher` (plain GNOME
  without the AppIndicator extension) it runs without an icon and says so with `notify-send`.
  `start.sh` with no desktop runs the app in its terminal.

**`OSU_LOCAL_PROFILES_NO_TRAY`** runs it with no icon and no dialogs, with messages on stderr. That's
how tests drive it.

Icons are committed in `tools/launcher/icon/`, rendered from `web/favicon.svg` by
`npm run build:icons`.

Not run on real hardware: the macOS and Linux builds (CI compiles and runs them headless), the tray
itself, Gatekeeper and translocation.

## me! (BBCode): never trusted

`web/js/bbcode.js` is our own renderer; osu-web's is server-side PHP, and only the tag meanings are
taken. me! can be imported from anyone's profile, so the text is treated as hostile:

- Escaped first, never parsed as HTML.
- Every tag emitted is one written in that file.
- Every argument is validated: colours by pattern, sizes as numbers, links and images by scheme.
- A failed or unclosed tag stays visible as text.

Pasted images go in `data/about-images/<profile>/`, named by content (`src/about-images.ts`), and
`[img]` accepts only that exact local shape.

## Export to a spreadsheet

`src/export/tables.ts` turns the profile into tables of cells: scores (every mode, pp descending,
no pp last), per-mode scores, Summary, Most played, Favorite beatmaps and Medals. Every query is the
page's own (`visibleSql`, `countsSql`, `ppColumn`, `scoreColumn`, `names`), so the export is what the
profile shows.

- `csv.ts` writes the scores for Excel: a BOM, CRLF, local `yyyy-mm-dd hh:mm:ss`, and a `'` before
  text starting with `= + - @` (formula injection from beatmap metadata).
- `xlsx.ts` writes SpreadsheetML by hand through `writeZip`: inline strings only (never evaluated),
  dates as serial days, a frozen bold header, an autofilter with `_xlnm._FilterDatabase`, and column
  widths. No library: the minimal part set opened cleanly in Excel 16 and openpyxl.
- It's in the page's language: the page sends `?lang=`, and `src/export/words.ts` reads the page's
  own `web/i18n/*.json` (English for a missing key). Keys are literal, and `scripts/build-i18n.mjs`
  scans `src/export/` for them. osu!'s own names (modes, clients, grades, judgements, medals) stay as
  osu! writes them.

## Backup and restore

`src/backup.ts`. A backup is `profiles.db` (a `VACUUM INTO` snapshot, since in WAL mode the file
alone can miss writes), the pictures and `about-images/`, under their `data/` names. `isProfileFile`
is the one list of what that is, and a restore writes nothing else, whatever the zip holds.
`config.json` is left out: install settings are wrong on another machine.

**A restore never swaps a running app's database.** The handle is shared by the tracker, the server
and the `total_changes()`-stamped caches. The upload is checked (a read-only probe for `profiles`
and `scores` before `openDb`, which would create them in any SQLite file) and staged in
`data/restore/`. Applying writes `ready` and exits `RESTART_EXIT_CODE`, and `applyPendingRestore`
swaps it in before `openDb`. Tray launcher only (`onRestart`), since `start.sh`'s loop would announce
it as an update. A stale `update/swapper.pid` is removed first, or the launcher would wait on
whatever process owns that pid now.

- Nothing is deleted: replaced files move to `data/before-restore-<local time>/`, a failed move is
  undone, and staging is dropped either way so a bad backup isn't retried every launch.
- **A restore marks the app as running now** (`markRunning`). Otherwise the restored `kv.lastRunAt`
  is the backup's, and `importPlaysWhileClosed` would import everything since as a gap.

## Score scales

osu!'s profile page has a lazer scoring switch (on by default); off shows the uncapped classic
scale. Both come from osu!'s code through the helper (`GetDisplayScore(Standardised)`,
`GetDisplayScore(Classic)`, `LegacyTotalScore`) and are stored in `scores.score_standard` and
`score_classic`. Classic shows `legacyTotalScore ?? classicScore`, osu-web's own rule.

`scoreColumn(e)` in `src/calc/eligibility.ts` is the only place a query names a score column. Don't
write `s.total_score` in a new query (it's the raw replay number, a fallback only).

**Stable scores are listed with CL.** osu! adds Classic to every legacy score before scoring it, so
`withClassicMod` (`src/calc/pp.ts`) adds it when building rows and cards. `mods_json` keeps what the
player chose.

**The wide INSERT and UPDATE are generated from the row.** Ingest's INSERT and recompute's UPDATE take
their column lists from the row object, so no value can be bound to the wrong column. What pricing a
replay decides (pp, stars, status, the ranked flags, pp parts) is one definition, `pricedColumns` in
`src/tracker/pricing.ts`; `BEATMAP_PRICED` is the part a recompute keeps when the `.osu` is gone.
Hand-aligned placeholders once let a recompute "update" 45 rows and write nothing (roadmap 5.40).

## Beatmap names in their original language

osu!'s "prefer metadata in original language". `beatmaps.artist_unicode` and `title_unicode` come
from the `.osu`'s `ArtistUnicode` and `TitleUnicode`; `''` means looked and there's none, NULL means
never looked. `backfillOriginalMetadata` fills the NULLs in one sliced pass after the beatmap index,
with no transaction of its own because the connection is shared.

`src/calc/metadata.ts` is the only definition: `NAME_COLUMNS` for what a naming query selects,
`names()` for a row, and `beatmapName`/`beatmapNameOriginal` for the joined `artist - title` that
Milestones, medals and Removed scores carry. Don't build `artist - title` by hand in a new query.

**Both names go to the page, and the page chooses** (`web/js/metadata.js`), as osu-web does.
Choosing on the server would put a display preference in `/api/profile`'s cache key and make a
checkbox cost a round trip. The original-language name is sent only when it differs, so `??` is the
whole rule on the page. The choice lives in `config.originalMetadata` and in `localStorage`, like
the language, because config arrives with the first API response, after the first paint.
