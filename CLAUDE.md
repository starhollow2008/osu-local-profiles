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
src/identity.ts        per-profile avatar and banner files in data/
src/clients/osu-web.ts optional, on-demand profile lookup (no API, no credentials)
src/clients/session.ts the username osu! is signed in as, from its own config file
tools/PpCalculator/    .NET helper wrapping osu!'s real difficulty/pp code
src/http/              JSON API + SSE
web/index.html         Phase 1 UI (plain; Vite + React planned for Phase 2)
```

The full plan, including later phases, is in the approved plan file referenced by the README.
