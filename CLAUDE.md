# Notes for working in this repo

## Current work

v1.0.0 shipped. Ongoing work is **Phase 5**, planned in [docs/roadmap.md](docs/roadmap.md) —
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
`src/clients/beatmaps.ts`). Building it means sniffing every file in the store (~63k files,
~40s once); entries are immutable so nothing is ever re-read.

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

**`tools/pp/` shadows the plain build.** `src/calc/official.ts` prefers it, and a stale copy
there does not fail loudly -- it answers the *old* protocol and quietly returns values
calculated the old way. After changing `Program.cs`, run `npm run build:pp:local`, not just
`npm run build:pp`. `scripts/build-pp-helper.mjs` is shared with `npm run package` so the
shipped helper and the development one cannot diverge.

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
who is calling. So `startServer` refuses any request whose remote address is not loopback
unless `config.shareOnNetwork` is set. It listened on every interface by default until
Phase 5, which meant the whole LAN could reset a profile.

**Do not "fix" this by binding to `127.0.0.1`.** A host-bound listen drops IPv6 loopback,
and `localhost` resolves to `::1` before `127.0.0.1` on Windows, so the app becomes
unreachable from its own browser. It also makes `listen` asynchronous, which breaks
`server.address()` for the tests. The request-level check covers both families, including
the `::ffff:127.0.0.1` form Node reports on a dual-stack socket.

## Medal definitions come from osu!, and are not symmetric

`src/calc/medal-definitions.json` is generated by `scripts/build-medal-table.mjs` from the
same profile-page payload the account lookup reads. Do not hand-edit it, and do not assume
the families are the same in every mode -- taking them from osu! is what revealed that they
are not:

- Combo and play-count medals exist for **osu!standard only**.
- taiko, catch and mania have **hit-count** medals in their place.
- Star pass/FC medals run **1..10** for osu!standard and **1..8** elsewhere.

Medals are derived from the scores on every request, never stored -- the same reasoning as
`history.ts`. A full combo needs `beatmap_max_combo`, because a lazer score can drop slider
ends without breaking combo, so "no misses" alone would award FC medals to a run that
dropped a hundred of them. Rows without it are reported as unknown, never guessed.

## Global rank is estimated from a sampled curve, and says so

osu!'s rankings API only exposes the top 10,000, which never covers a fresh profile. The
rank shown instead comes from `src/calc/rank-tables/<mode>.json`, a pp->rank curve built by
`scripts/build-rank-table.mjs` from data.ppy.sh's `performance_<mode>_random_10000` dump --
a random sample across the whole ladder in which every user carries their own actual rank,
so the curve needs no modelling.

The script streams the ~1GB archive through `bzip2` and `tar` and keeps only the user-stats
table, so nothing large is ever written to disk. Interpolation is linear in *log* rank:
rank spans six orders of magnitude across the ladder while pp spans three, and a fresh
profile sits in the long tail where a linear axis would flatten everything.

This is an estimate and is labelled as one in the UI. It is allowed to exist where a second
pp calculator is not, because pp values are ranked and weighted against each other whereas
rank is a single derived readout -- a stale curve degrades gradually instead of corrupting
the profile. Refresh it by re-running the script with a newer `--dump` date.

**Country rank is deliberately not shown.** 10,000 sampled users spread over ~200 countries
is far too thin to interpolate per country, and a fabricated number would be worse than the
dash osu! itself shows for an unranked user.

## Windows is the only verified platform

macOS and Linux are written, covered by CI on `ubuntu-latest` and `macos-latest`, and
**have never been run against a real osu! install**. Treat anything platform-specific as
unproven rather than working, and see `docs/roadmap.md` 5.10 for the list of what still
needs a real machine.

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

`config.installRoots` is the escape hatch for a layout nobody anticipated, and on macOS and
Linux that is the normal case for osu!stable: there is no official build, only Wine
wrappers. It had been documented and printed in the "no osu! found" message while being read
by nothing at all.

## Design constraints worth preserving

- **No native modules in the Node process.** `node:sqlite` is built in, `rosu-pp-js` is
  WASM, the LZMA codec is pure JS — do not introduce `better-sqlite3`, `realm`, or similar.
  (The .NET helper is a separate process, not a native binding.)
- **No API polling in the hot path.** Detection is local. The osu! API is optional
  enrichment only, and the app must keep working with no credentials and no network.
- **Never scan-and-import on startup.** Only live watch events count. An automatic
  backfill would retroactively import plays set with the user's normal playstyle while the
  app was closed, which defeats the purpose of a fresh profile.
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
src/scores.ts          pin, order pins, remove a score from the profile (a hide)
src/calc/medals.ts     medals, derived from scores; definitions from osu!'s own list
src/http/screenshot.ts full-page PNG via an already-installed Chrome/Edge over CDP
src/identity.ts        per-profile avatar and banner files in data/
src/clients/osu-web.ts optional, on-demand profile lookup (no API, no credentials)
src/clients/session.ts the username osu! is signed in as, from its own config file
src/clients/lazer-log.ts  lazer's own log, the only record of a play that left no replay
src/tracker/log-watcher.ts  follows the live session log from its current end
src/tracker/incomplete.ts   an abandoned play -> a tracked one
tools/PpCalculator/    .NET helper wrapping osu!'s real difficulty/pp code
src/http/              JSON API + SSE
web/index.html         Phase 1 UI (plain; Vite + React planned for Phase 2)
```

The full plan, including later phases, is in the approved plan file referenced by the README.
