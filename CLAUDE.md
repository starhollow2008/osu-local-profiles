# Notes for working in this repo

## Current work

**v1.10.0 shipped.** The app is **osu! local profiles**, at
`github.com/jonathant09/osu-local-profiles`, and the user wants that to be the only name
anywhere -- the previous one was scrubbed from the code, docs and every GitHub release. Do
not reintroduce it, including as a compatibility alias (roadmap 5.18). Ongoing work is
**Phase 5**, planned in
[docs/roadmap.md](docs/roadmap.md) —
read it before starting anything new. It holds one entry per feature with its design
decisions, the files it touches, and a status column that is the resume point if a session
is interrupted mid-feature. Update the status as you go.

Reference links (osu-web, ppy/osu, the API docs) are in
[docs/reference-links.md](docs/reference-links.md).

## TypeScript runs unbuilt — strip-only mode

`node src/main.ts` runs TypeScript directly via Node's type stripping. Types are *erased*,
never compiled, so any TS feature that emits runtime code is a hard error:

- **no parameter properties** — `constructor(private readonly db: Db)` fails. Declare the
  field and assign in the body.
- no `enum` (use `const` objects `as const`), no `namespace`, no decorators.

`npm run typecheck` catches type errors; it will *not* catch these. Run `npm run check`.

Test files are run the same way. `node --test test/` does not work here — pass a quoted
glob: `node --test "test/**/*.test.ts"`.

## osu! file format findings (verified against a real 2408-replay corpus)

These were established empirically and are the load-bearing assumptions of the whole design.

**lazer appends an extended block to every `.osr`.** After the replay frames comes an
`int64` online score id, then an `int32` length, then an LZMA-compressed JSON blob
(`LegacyReplaySoloScoreInfo`) holding the *authoritative* mods, statistics and rank. The
legacy header alone is misleading: it reports rank `F` for plays that actually ranked A.
Anything reading only the legacy header — `osu-parsers` included, which is why we do not use
it — gets lazer scores wrong. See `src/osr.ts`.

- lazer replays have version >= 30000001; stable replays do not have the block at all.
- ~35% of a typical store is stable-format replays (older imports), so both paths matter.
- The legacy mod bitmask *is* correct — an implausible-looking `AP` bit was genuinely set.

**lazer accuracy is not the stable formula.** lazer judges slider tails (worth 150) and
large ticks (30) and counts them toward accuracy, so the legacy 300/100/50 formula
under-reports: a play lazer calls 90.81% comes out as 89.11%. Accuracy is
`sum(statistics x value) / sum(maximum_statistics x value)` — hence both blocks are stored
per score. Values are in `HIT_VALUES` in `src/calc/grade.ts`.

**lazer stores files by SHA-256, not by beatmap MD5.** A score names its beatmap by MD5, so
matching it to a local `.osu` requires the MD5 index in `osu_files` (see
`src/clients/beatmaps.ts`). Building it means sniffing every file in the store once (~63k
files here: 9s warm, ~140s on a first, cold read); entries are immutable so nothing is ever
re-read. osu!stable's `Songs` is filtered by the `.osu` extension instead, which lazer's
hash-named files do not have.

**The index runs beside the app, never before it** (roadmap 5.25). `indexBeatmapFiles` works
in 25ms slices and **commits before every pause**: the connection is shared, and a transaction
held open across a pause would swallow whatever else wrote meanwhile. `Tracker.indexBeatmaps`
puts it at the head of the ingest queue *before the watchers start*, because `resolve()`
caches a miss for good -- a score resolved mid-index would never get pp.

**`online.db` is a plain SQLite file** shipped by lazer:
`osu_beatmaps(beatmap_id, beatmapset_id, checksum, approved, ...)`, ~234k rows, `checksum`
being the beatmap MD5. This is what makes offline ranked-status resolution possible. Open it
read-only and never write to it.

## pp must come from osu!'s own code

`tools/PpCalculator` references the official `ppy.osu.Game.Rulesets.*` NuGet packages and is
driven over a JSON-lines pipe from `src/calc/official.ts`.

**Hand it the replay file; do not reconstruct a ScoreInfo.** The helper decodes the .osr with
osu!'s `LegacyScoreDecoder`, which sets `IsLegacyScore` from the replay version, applies the
Classic mod to legacy scores, populates `MaximumStatistics`, and reads lazer's extended block
including mod settings. Verified on real replays: stable scores come back
`isLegacy=true` with `CL` added to their mods (e.g. `HRCL`, `DTHDCL`), which is what selects
classic slider accuracy and legacy miss estimation in `OsuPerformanceCalculator`. An earlier
version that built the ScoreInfo from parsed statistics would have scored stable plays as
lazer.

**osu!'s difficulty calculator is Relax-aware, not just its performance calculator.**
Measured on this corpus: the same RX replay is 6.26 stars / 110.93pp scored as played, and
7.83 / 238.54 with the mod removed. AP is 3.14 / 57.44 against 4.45 / 101.09. So "what is
this relax play worth" has two legitimate osu!-produced answers that differ by more than
2x, and the setting `unrankedModPp` picks between them. Both are stored at ingest
(`pp`/`stars` and `pp_nomod`/`stars_nomod`), so switching never needs a recompute.

The helper's `stripMods` request field removes acronyms from the decoded score's mod list
before calling the calculators. That is the *only* deviation, and it is still osu!'s code
doing the arithmetic -- it does not create a second implementation. Any value derived this
way must be labelled in the UI, because osu! itself would never award it.

**pp is calculated for every score, not only the ranked ones.** Eligibility is a query-time
decision (`src/calc/eligibility.ts`), never a stored verdict, so a settings change is
instant instead of a reingest. `scores` stores the *facts* -- `map_status`, `mods_ranked`,
`mods_countable`, both pp values -- and `countsSql()` turns settings into the predicate.
There is exactly one definition of "counts"; do not write `ranked = 1` in a new query.
Rows ingested before those columns existed have NULL in them and fall back to `ranked`;
`POST /api/recompute` fills them in from the replays.

**Removing a score is a hide, never a `DELETE`.** The replay stays in osu!'s file store, so
a deleted row would be re-ingested the next time that file was noticed -- and with its
`dedupe_key` gone, it would come back looking like a brand new score. `scores.hidden_at`
is set instead, and `visibleSql()` in `src/calc/eligibility.ts` filters it out of *every*
query over `scores`, not just the ones about pp: a removed score has to leave the play
count and the level bar too, or it has not really been removed.

**Deleting a removed score for good keeps its key.** Settings can delete a removed score
(`deleteRemovedScores`), and the row really goes -- but its `dedupe_key` is written to
`deleted_scores` first, and ingest and Import past plays both refuse a key listed there
(`wasDeleted`). That is what keeps the rule above true. Never delete a score row any
other way; a reset clears `deleted_scores` with the rest.

**`tools/pp/` shadows the plain build.** `src/calc/official.ts` prefers it, and a stale copy
there does not fail loudly -- it answers the *old* protocol and quietly returns values
calculated the old way. After changing `Program.cs`, run `npm run build:pp:local`, not just
`npm run build:pp`. `scripts/build-pp-helper.mjs` is shared with `npm run package` so the
shipped helper and the development one cannot diverge.

**Every pp value carries the osu! release that produced it.** The helper reports the
`ppy.osu.Game` package version on its ready line and in each response, alongside `breakdown`
(`GetAttributesForDisplay()` minus the total). Both land in `scores.pp_version` and
`pp_parts`/`pp_nomod_parts`. A score's breakdown must belong to the pp shown beside it, so a
score with no parts is recalculated *whole* when its card is opened -- never given parts
from a newer calculator next to pp from an older one.

**Do not add a fallback calculator.** `rosu-pp` was removed on purpose. Every reimplementation
lags osu!'s reworks: rosu-pp 4.0.1 (its latest release, and the latest of the underlying Rust
crate) implements the 2025-10-29 algorithm, so after osu!'s 2026-07-03 rework it reported
7.03 stars / 142pp for a play osu! scores at 6.93 / 151. Two calculators in one profile means
scores ranked against each other under different algorithms. When the helper is unavailable,
store no pp and say so loudly.

**After an osu! pp rework:** bump the package versions in `PpCalculator.csproj`, then run
`node scripts/reingest.mjs` to recompute every stored score from its replay.

osu! computes accuracy itself during decoding and returns it; `test/official.test.ts` asserts
our `src/calc/grade.ts` implementation agrees with it on both a lazer and a stable replay.

## Over half of what osu! counts as a play leaves no replay

This is the load-bearing finding behind `incomplete_plays`, and it is not obvious.

**osu! counts a play it never keeps.** `SubmittingPlayer.submitScore` submits on fail *or*
quit *or* retry. There is **no minimum object count** -- the rule is only: a token was
issued, **at least one non-miss judgement landed**, and total score > 0. Quitting before
hitting anything is the sole case osu! discards, and it logs `No hits registered, skipping
score submission` when it does.

**lazer keeps a score only for a map played to the end.**
`Player.prepareAndImportScoreAsync` imports when `ScoreProcessor.HasCompleted &&
GameplayState.HasPassed`, or on `forceImport`, which only the fail screen's "Save replay"
button sets. So a solo HP-fail, a quit and a retry write *nothing* to disk.

Measured on one real session of this machine's corpus: **54 plays started, 45 counted by
osu!, 19 replays written.** The replay watcher alone therefore misses ~58% of the play count.

**Every rank-`F` replay in the store is a multiplayer play, not a fail you can learn from.**
`MultiplayerPlayer.PerformFail` suppresses failing outright -- "failing in multiplayer only
marks the score with F rank" -- so the map runs to the end and is imported normally. All 22
`F` replays in this corpus judged **100%** of their beatmap's hit objects; there is not one
partially-played replay on disk. Do not go looking for fails among the replays.

**So incomplete plays come from lazer's log**, `<lazer>/logs/<session>.runtime.log` and
`.network.log`. `Score submission completed!` is emitted exactly when osu! accepted the
submission, which makes the app's play count agree with the website by construction rather
than by reimplementing the rule above -- and both go silent together when you play offline.
A pass is told apart by the screen stack logging `suspended <Player> (waiting on
<...>ResultsScreen)`; verified against the corpus, that fired 19 times in a session with
exactly 19 replays on disk, matching one to one. lazer's submission token is the dedupe key.

Log timestamps are **UTC**. The beatmap id lives only in the *network* log's submission
`PUT`, joined to the runtime log by token. Multiplayer submits via `/rooms/...` and so
resolves to no id there, which costs nothing since it always writes a replay anyway.

**These rows are not in `scores`, and must not be.** An abandoned play has no accuracy,
combo, mods, pp or total score -- lazer never writes them down. A row of zeroes in `scores`
would corrupt weighted accuracy, the grade counts, ranked score, the level bar and every
medal. Only the four aggregates that should include them read `incomplete_plays`: the play
count, the monthly play counts, Most Played and Recent Plays. `hitsPerPlay` deliberately
keeps dividing by *scored* plays, since the hits from an abandoned play are unknowable.

Counting them is not a setting -- osu! counts them, so this does.
`showIncompleteInRecent` (`yes` | `collapse` | `no`) only decides whether they are *listed*.

**osu!stable is not covered, and the gap is the same shape.** The submission rule above is
the *server's*, so stable counts fails and quits too, and stable does not save a replay for
a failed play either -- "Option to save failed replays" is a standing request against it
(`ppy/osu-stable-issues#254`). What is unknown is only where the evidence lives on a stable
install, and it is unknown because there is no stable install on this machine to look at.
**Do not guess at it in code.** `logDirOf` returns null for a stable install, so stable is
skipped cleanly rather than half-supported, and `ingestIncompletePlay` is already
client-agnostic -- it wants a token, a timestamp, a beatmap and a pass flag, from anywhere.
The leads worth chasing, the ones already ruled out, and the measurement to run first are
written up in `docs/roadmap.md` under **5.12**.

## Total Play Time follows osu!'s server rule

osu-queue-score-statistics' `PlayValidityHelper.GetPlayLength` adds, per play,
`min(beatmap total_length / product of rate-adjust speed changes, ended_at - started_at)`,
and runs on failed scores too. `src/calc/play-time.ts` applies exactly that: a finished
score has no start time, so it counts its length/rate (the smaller side for a completed
map); an incomplete play uses lazer's token time (`incomplete_plays.started_at`) to its
submission, capped at the map length. Rows from before `started_at` existed count nothing
-- do not "estimate" them. Beatmap lengths are read lazily from the `.osu` into
`beatmaps.length_ms`, with 0 meaning unreadable, so no file is ever parsed twice.

## Favorite Beatmaps come from one request per favourite

`osu.ppy.sh/beatmapsets/<id>` embeds the whole set as `<script id="json-beatmapset">` --
every difficulty's star rating and mode, `nsfw`, `spotlight`, `track_id` (featured
artist) -- which nothing on this machine records (`online.db` has every difficulty and its
mapper, but no ratings, modes or badges). So favouriting fetches that page once, because the
button was pressed, and caches the trimmed result in `beatmapset_details`; the card is
drawn from it forever after, offline. Without it, `localCard` in `src/favorites.ts` builds
one from `online.db`, the beatmap cache and the profile's own scores -- taking a score's
star rating only when its mods leave the rating alone, since a stored rating includes the
mods. Favourites are per profile, survive a reset, and are never written to osu!.

## The osu! account link needs no API and no credentials

`osu.ppy.sh/users/<name>` redirects to the numeric id and embeds the whole public user
object -- id, username, `avatar_url`, `cover_url`, `country_code` -- in the page as a
`data-initial-data` attribute, HTML escaped. That is the same data the API's `/users/{user}`
returns, so the OAuth application, client id and secret an API call would need are all
avoidable. This is what keeps the project's "no login anywhere" promise true.

It is a private detail of osu-web and may change, so `src/clients/osu-web.ts` fails loudly
with a message worth reading rather than returning an empty user. Every path through it runs
because a button was pressed, makes one request, and copies what it finds into `data/`.
Nothing is on a timer -- see `docs/reference-links.md` for why that matters.

## The server is localhost-only, and that is enforced per request

The page can reset a profile, delete one and remove scores; none of those endpoints asks
who is calling. So `startServer` refuses any request whose remote address is not loopback,
**with no switch to turn that off**. It listened on every interface by default until
Phase 5, which meant the whole LAN could reset a profile; the opt-in `shareOnNetwork` that
replaced that was then removed outright in 1.5.0 at the user's request. `loadConfig` drops
the key from an old `config.json` (`RETIRED_KEYS`). Do not bring it back: sharing a profile
is the HTML export and the PNG, both of which are read-only.

**Do not "fix" this by binding to `127.0.0.1`.** A host-bound listen drops IPv6 loopback,
and `localhost` resolves to `::1` before `127.0.0.1` on Windows, so the app becomes
unreachable from its own browser. It also makes `listen` asynchronous, which breaks
`server.address()` for the tests. The request-level check covers both families, including
the `::ffff:127.0.0.1` form Node reports on a dual-stack socket.

## Looking like osu! means reading osu-web, not guessing at it

The page is a reimplementation of osu!'s profile page, and the way to make any part of it
exact is to **read the file that defines that part**. `docs/osu-web-fidelity.md` maps every
visible region to the osu-web LESS and TSX that defines it, and carries the clone command
for `reference/osu-web` — a 6.5MB sparse, gitignored checkout. Read it before any "make it
look more like osu!" work; the chart colour, the hover readout and the gold on the SS badge
each cost a separate round trip because it did not exist.

**Values, never files.** osu-web is AGPL-3.0-or-later and this project is MIT, so nothing
is copied out of it: not a rule, not a path, not an image. Colours, sizes, ratios and
wording are facts and are fair game — which is why `docs/osu-web-reference.md` is a table
of numbers. `ppy/osu-resources` is worse than osu-web, not better: it is **CC-BY-NC**, so
lazer's own textures cannot be used at all. Flags come from Twemoji (CC-BY 4.0), which is
where osu! got them.

Two tables are generated rather than written: `web/js/mod-definitions.js` (`npm run
build:mods`) and `web/flags/` (`npm run build:flags`). The mod table is what gives a mod its
colour, and it replaced a hand-kept mapping whose own comment called it "rough".

## Medal definitions come from osu!, and are not symmetric

`src/calc/medal-definitions.json` is generated by `scripts/build-medal-table.mjs` from the
same profile-page payload the account lookup reads. Do not hand-edit it, and do not assume
the families are the same in every mode -- taking them from osu! is what revealed that they
are not:

- Combo and play-count medals exist for **osu!standard only**.
- taiko, catch and mania have **hit-count** medals in their place.
- Star pass/FC medals run **1..10** for osu!standard and **1..8** elsewhere.

**Mod Introduction is the only other group, on purpose.** The user chose it after asking
what every medal would cost: the rest are beatmap packs, specific maps or hidden conditions a
local profile cannot judge. Its rules are osu-queue-score-statistics' (the mod alone at its
defaults, System mods and CL ignored; SO in osu!standard only; NC/DC are not DT/HT; passes
only; Conversion/Fun are lazer-only mod *types*, from osu-web's `mods.json`). Do not add
other groups without asking.

**The page shows no text for a medal.** osu-web's listing is icons only, in its groups
(Mod Introduction, then `Skill & Dedication` with a row per `ordering`: combo 0, plays 1,
rank 2, hits 3, pass 4, fc 5); everything else is in the hover card (`#medalTooltip`, one shared element
positioned in window coordinates like `#playMenu`). The header's Medals figure is
account-wide (`earnedMedalCount`), as osu!'s is. An earned medal is a Recent-feed event
(`medalEvents`) -- except rank medals, which carry no real date (`dated: false`) because
they are decided once from the current total.

Medals are derived from the scores on every request, never stored -- the same reasoning as
`history.ts`. A full combo needs `beatmap_max_combo`, because a lazer score can drop slider
ends without breaking combo, so "no misses" alone would award FC medals to a run that
dropped a hundred of them. Rows without it are reported as unknown, never guessed.

## Global rank is estimated from a sampled curve, and says so

osu!'s rankings API only exposes the top 10,000, which never covers a new profile. The
rank shown instead comes from `src/calc/rank-tables/<mode>.json`, a pp->rank curve built by
`scripts/build-rank-table.mjs` from data.ppy.sh's `performance_<mode>_random_10000` dump --
a random sample across the whole ladder in which every user carries their own actual rank,
so the curve needs no modelling.

The script streams the ~1GB archive through `bzip2` and `tar` and keeps only the user-stats
table, so nothing large is ever written to disk. Interpolation is linear in *log* rank:
rank spans six orders of magnitude across the ladder while pp spans three, and a new
profile sits in the long tail where a linear axis would flatten everything.

This is an estimate and is labelled as one in the UI. It is allowed to exist where a second
pp calculator is not, because pp values are ranked and weighted against each other whereas
rank is a single derived readout -- a stale curve degrades gradually instead of corrupting
the profile. Refresh it by re-running the script with a newer `--dump` date.

**Country rank is deliberately not shown.** 10,000 sampled users spread over ~200 countries
is far too thin to interpolate per country, and a fabricated number would be worse than the
dash osu! itself shows for an unranked user.

## Never hand `fs.watch` a path you have not resolved

On Windows libuv compares the filename `ReadDirectoryChangesW` reports against the path it
was given and **aborts the process** when they differ:

    Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72

It is an `abort()` inside the runtime, not an exception -- there is nothing to catch and
nothing to recover. Any non-canonical path triggers it: a junction, a drive substitution, or
an 8.3 short name like `C:\Users\RUNNER~1\...`. That last one is what a GitHub runner's
`TEMP` is, which is how this shipped -- it passed on every local run and then killed two
unrelated test files on CI, because the process died rather than a test failing.

**A watcher test must let the watch come up before its first write.** On macOS the first
`fs.watch` in a process starts libuv's FSEvents thread, and a write landing during that is
not reported. Two tests appended the instant `start()` returned; both passed for months and
then failed CI on macOS once the suite's timing shifted, one of them on a docs-only commit.
The app is not exposed (reads go by byte offset), so this is a test rule: `await
sleep(SETTLED_MS)` after `start()`.

`watchablePath` in `src/tracker/watcher.ts` resolves the directory, and both watchers go
through it. Paths are still *reported* against the directory as configured, so nothing
downstream ever sees two spellings of one file.

## The profile page's charts are not ordinary SVG

Both charts draw in a 0..100 space with `preserveAspectRatio="none"`, which is what makes
them responsive without measuring the DOM -- and means **anything drawn inside them is
sheared by the container's aspect ratio**. A circle comes out an ellipse whose shape depends
on the window width. So the axis labels, the hover marker and the tooltip are all HTML
positioned over the plot in percentages. osu-web does exactly the same: its hover circle is
a `div`. Keep it that way.

Colours and wording come from osu-web's own source, not from looking at a screenshot -- the
line is `@yellow` `#ffcc22` at 2px, the tooltip says `Global Ranking #123` over `40 days
ago`, and Play History says `Plays 430` over `March 2020`. `docs/roadmap.md` 5.13 records
where each of those came from.

Section lists are **paged by the server**: the page asks for a size per section and gets
totals back. Deciding whether to offer "show more" needs *both* "the page came back full"
and "the total is larger than what was returned" -- Recent Plays counts plays but draws
rows, and a collapsed run of retries is several plays in one row, so either test alone
leaves a button that reveals nothing.

## Windows is the only verified platform

macOS and Linux are written, covered by CI on `ubuntu-latest` and `macos-latest`, and
**have never been run against a real osu! install**. Treat anything platform-specific as
unproven rather than working, and see `docs/roadmap.md` 5.10 for the list of what still
needs a real machine. Since 1.10.0 each release carries `osx-arm64` and `linux-x64` zips,
built by `.github/workflows/release.yml` on those runners (a package can only be built on
its own OS); the user intends to test them, and osu!stable, on real machines later.

Two rules follow from that, and both were learned by getting them wrong:

- **Anything that varies by platform belongs behind a pure function that takes the
  platform.** `src/clients/detect.ts` takes a `DetectEnvironment` (platform, home, env)
  rather than reading `process`, which is the only reason macOS and Linux paths can be
  tested at all from here -- see `test/detect.test.ts`. Reading `process.env` directly makes
  a behaviour that can only be checked by owning the machine.
- **A platform-specific list must fail loudly when it matches nothing.** The pp helper's
  pruning deleted a hardcoded list of `.dll` names; on macOS or Linux it would have matched
  nothing at all, and *silently* shipped a 273MB helper instead of a 114MB one, BASS
  included -- which is not ours to redistribute. It now matches by base name across
  `.dll`/`.dylib`/`.so` and warns when it prunes nothing.

**The Windows launcher runs `.\node.exe`, never a bare `node.exe`.** `cmd` looks in the
current folder for a bare name only while NoDefaultCurrentDirectoryInExePath is unset; with it
set -- a real hardening switch, and set in Claude Code's own shell -- it searches PATH, so the
app ran on the system Node. Found by an update's relaunch in 1.8.0; `test/package-files.test.ts`
pins the `.\`. When testing a `.bat` from such a shell, invoke it as `.\x.bat` too.

**Anything spawned through `cmd` needs `windowsVerbatimArguments`.** Node quotes spawn
arguments by the C runtime's rules and `cmd` does not unescape them: the `""` title
`start` needs arrived as `"\"\""`, so opening the browser silently did nothing on Windows
from the first release until 1.6.0. `src/browser.ts` builds the line as a pure function and
`test/browser.test.ts` pins it. The updater's relaunch is the same trap, handled there.

`config.installRoots` is the escape hatch for a layout nobody anticipated, and on macOS and
Linux that is the normal case for osu!stable: there is no official build, only Wine
wrappers. It had been documented and printed in the "no osu! found" message while being read
by nothing at all.

## The updater rewrites the app's own directory

`src/update/` and `scripts/apply-update.mjs` replace the install in place. Four properties
make that safe, and none of them is optional:

- **`data/` is never touched.** `dataDir()` is `<install>/data`, so the database, settings
  and images sit *inside* the thing being replaced. The swap enumerates the install's other
  top-level entries and steps around that one. Anything that changes where data lives, or
  how the swap enumerates, has to keep this true.
- **Nothing is deleted while it could still be needed.** Outgoing files are *moved* to
  `.rollback-<stamp>/`, so a swap that dies half way leaves both halves on disk instead of a
  hole. That window closes the moment the new build is on disk and its manifest reads back,
  and the swap deletes the copy right there -- it is **~200MB**, and keeping it at rest
  insures against a risk that has already passed. The way back from a *bad* release is to
  download the previous one, not to keep a spare copy of it forever.
- **Nothing is swapped until the new build is verified**: the download's size before it is
  unpacked, then the unpacked tree's shape and the version its `package.json` claims.
- **A source checkout refuses.** `start.bat` runs `node src/main.ts` from the repository, so
  an "update" there would overwrite a working tree with a release zip. Both `.git` and a
  missing bundled runtime are checked; either test alone can be fooled.

**The swap runs from the *staged* build, using the staged build's own runtime.** On Windows
the running `node.exe` is locked by the process that would replace it, so nothing inside the
app can do this. It follows that a release installs itself with *its own* updater, which is
why `scripts/apply-update.mjs` is copied into every package — a build that does not ship it
cannot be updated *from*, and `applyUpdate` says so rather than staging a swap with no
swapper.

**Relaunch goes through `cmd`'s `start`, and the quoting is load-bearing.** Spawning the
runtime directly is simpler and wrong: `detached` maps to DETACHED_PROCESS on Windows, so
the app comes back running, tracking and with no console at all. The launcher is called
`Start osu! local profiles.bat`, so an unquoted path runs a program called `Start` — which
is what the first attempt did, caught only because the swap was tested end to end.

The zip reader is ours (`src/update/zip.ts`) because no dependency was available and
shelling out to Windows' `tar.exe` would put the riskiest path in the app behind a binary
that exists on one OS. It refuses zip64 rather than half-reading it, refuses any entry whose
path escapes the target — this runs on a file fetched over the network — and handles the
**backslash separators this project's own packager writes**: a release archive says
`osu-local-profiles-1.5.0-win-x64\node.exe`.

**This path has been run end to end against the real public repository** -- see
`docs/roadmap.md` 5.16. The way to re-verify it after changing anything here, without
waiting for a release: copy a packaged build, set its `package.json` version *below* the
published one, start it, and let it update itself. Put a value in that copy's
`data/config.json` that exists nowhere in the release archive -- the port is ideal -- and
check the app comes back using it. That is what proves `data/` survived, rather than
assuming it.

**An update leaves two ~200MB copies of the app behind, and both must be swept.** The
rollback is the visible one; the other is the staged tree in `data/update/`, which hides
where it reads as user data -- one real update left **406MB** between them before this was
fixed. The swap deletes its own rollback, but it *cannot* delete the staged tree: it is
running from it, and on Windows its own `node.exe` is locked for as long as it lives. So
`pruneUpdateLeftovers` runs at startup and clears whatever is there -- the staged tree
always, and any `.rollback-*` a failed swap or an older version left. It keeps
`data/update.log`, which is a *file* beside that directory and is the record of what the
last update did.

The check is one request at startup, never a timer, and `checkForUpdates: false` turns off
the app's only outgoing request. A failed check shows nothing: no network, a private
repository and a rate limit are all ordinary, and none is a reason to put an error where a
button would go.

## me! is osu!'s BBCode, and never trusted

`web/js/bbcode.js` is this project's own renderer (osu-web's BBCode library is AGPL; only
the tag *semantics* are taken). me! can be imported from anyone's osu! profile, so the text
is treated as hostile: it is escaped first and never parsed as HTML, every tag emitted is
one written in that file, and every argument reaching an attribute is validated (colours by
pattern, sizes as numbers, links and images by scheme). A tag that fails, or is never
closed, stays visible text. Keep all three properties when adding a tag, and add a case to
`test/bbcode.test.ts`. Pasted images live in `data/about-images/<profile>/`, named by
content (`src/about-images.ts`); `[img]` accepts only that exact local shape.

## The shared web page is the page itself

Share -> Save as a web page (`web/js/share-copy.js`) saves index.html with its CSS, the
page's own modules bundled into one script by `web/js/bundle.js`, and a snapshot of the
API's answers. `web/js/static-mode.js` -- main.js's **first** import -- serves the snapshot
in place of the app (a stand-in `fetch` and a no-op `EventSource`), so the same code runs
in both. Two consequences:

- **The page's modules must stay bundleable**: named `import { } from './x.js'` and
  `export function / async function / const / class` only. The bundler refuses anything
  else by name (and `export let`, whose live binding it cannot keep); `test/bundle.test.ts`
  bundles the real page and syntax-checks it, and `npm run ui` loads a real copy and clicks
  Show more in it.
- **An image the app serves must go through `assetUrl()`** so the copy can carry it. The copy
  must never contain install paths or other profiles; share-copy.js strips them.

## Favorites are shared by default

`config.sharedFavorites` (default true) puts every profile on `shared_favorite_beatmapsets`;
`FavoriteScope` in `src/favorites.ts` picks the table. `syncFavoriteSharing` merges the
per-profile lists into the shared one when sharing is switched on and copies it back when it
is switched off, once per switch (recorded in `kv`), so nothing is ever lost. Removing a
shared favorite removes it from every profile's own list too, so switching off cannot bring
it back.

## Design constraints worth preserving

- **No native modules in the Node process.** `node:sqlite` is built in and the LZMA codec
  is pure JS (the only runtime dependency) — do not introduce `better-sqlite3`, `realm`, or
  similar. (The .NET helper is a separate process, not a native binding.)
- **`/api/profile` caches its aggregates until the database changes** — see `remember` in
  `src/http/server.ts`. The stamp is SQLite's own `total_changes()` plus `data_version`, so
  any write invalidates it with nothing to remember. Anything added to that cache must
  depend only on the database; a value that depends on the clock or a file would go stale.
- **No API polling in the hot path.** Detection is local. The osu! API is optional
  enrichment only, and the app must keep working with no credentials and no network.
- **Never scan-and-import on startup.** Only live watch events count. An automatic
  backfill would retroactively import plays set with the user's normal playstyle while the
  app was closed, which defeats the purpose of a separate local profile.
  Importing past plays *does* exist (`src/tracker/backfill.ts`), but only as an explicit
  action: the user picks a cutoff, sees a preview of exactly what it would bring in, and
  confirms. Keep all three of those. The mtime pre-filter is only a filter -- the
  authoritative timestamp is the one inside the replay, because lazer stamps imported
  replays with the import time.
- Ingestion is serialised through a promise queue in `src/tracker/index.ts` so simultaneous
  replays cannot interleave DB writes.

## The page is checked in a real browser

`npm run ui` (with the app running) drives `web/index.html` in headless Chrome over CDP and
asserts **computed style**, not markup.

It exists because of a shipped bug: `.backdrop` set `display: grid` on the same element that
was toggled via the `hidden` attribute. The browser's `[hidden] { display: none }` is
low-specificity and lost, so the reset dialog rendered on page load and Cancel, Escape and
backdrop-click all appeared broken -- leaving "Erase and start fresh" as the only working
button, which cost a user their tracked scores. `[hidden] { display: none !important; }` is
now declared globally; keep it, and prefer adding checks here for anything that toggles
visibility.

## Layout

```
src/osr.ts             replay parser (legacy header + lazer extended block)
src/clients/           install detection, beatmap MD5 index, online.db resolution
src/tracker/           recursive fs.watch, settle-on-write, ingest + dedupe
src/calc/              pp (official helper only), level, grades, aggregation
src/calc/official.ts   JSON-lines client for the .NET calculator
src/calc/eligibility.ts  the single definition of "this score counts toward pp"
src/settings.ts        per-profile settings, stored one row per key
src/tracker/recompute.ts  recalculate stored scores in place from their replays
src/scores.ts          pin, order pins, remove a score (a hide); View Details data, replay download
web/js/score-card.js   View Details: osu!'s score page as a card (dial, tower, stats)
web/score.html         a score's own page, /scores/<id>; web/js/score-page.js drives it
web/js/score-share.js  copy link, save/copy the card as a PNG, download the replay
web/js/medals.js       the Medals section and the hover card over any medal
web/js/audio-player.js the beatmap preview player (card button and corner bar)
web/js/bbcode.js       osu!'s BBCode for me!, escaped first; the editor lives in main.js
src/about-images.ts    images pasted into me!, stored by content in data/about-images
web/js/share-copy.js   Save as a web page: the page, bundled, with an API snapshot
web/js/static-mode.js  in a saved copy, answers the page's requests from the snapshot
web/js/bundle.js       the few-line bundler share-copy.js uses
.github/workflows/release.yml  a v* tag builds win/osx/linux zips onto the release
src/calc/medals.ts     medals, derived from scores; definitions from osu!'s own list
src/http/screenshot.ts full-page PNG via an already-installed Chrome/Edge over CDP
src/identity.ts        per-profile avatar and banner files in data/
src/clients/osu-web.ts optional, on-demand profile lookup (no API, no credentials)
src/clients/session.ts the username osu! is signed in as, from its own config file
src/clients/lazer-log.ts  lazer's own log, the only record of a play that left no replay
src/tracker/log-watcher.ts  follows the live session log from its current end
src/tracker/incomplete.ts   an abandoned play -> a tracked one
src/update/            check GitHub releases, unpack a release, hand off the swap
scripts/apply-update.mjs   the detached swapper; ships inside every package
tools/PpCalculator/    .NET helper wrapping osu!'s real difficulty/pp code
src/http/              JSON API + SSE
web/index.html         Phase 1 UI (plain; Vite + React planned for Phase 2)
```

The full plan, including later phases, is in the approved plan file referenced by the README.
