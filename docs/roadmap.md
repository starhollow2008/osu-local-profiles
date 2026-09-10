# Roadmap — Phase 5

Everything in this file comes from the user's `next steps.txt` (now retired; its content is
captured here). Phases 1–4 shipped as v1.0.0 — see the CHANGELOG.

**This file is the resume point.** Each feature below is self-contained and ordered so that
work can stop after any one of them and leave the app shippable. Update the `Status` line as
you go, and record any decision you had to make under `Decisions` so the next session does
not re-litigate it.

Status values: `todo` · `in progress` · `done` · `deferred`

| #    | Feature                                       | Status |
| ---- | --------------------------------------------- | ------ |
| 5.0  | Retire `prompt.txt`, keep the reference links | done   |
| 5.1  | Settings store and Settings dialog            | done   |
| 5.2  | Include pp for unranked **mods**              | done   |
| 5.3  | Include pp for unranked **maps**              | done   |
| 5.4  | Score actions: pin, reorder, hide             | done   |
| 5.5  | Editable identity + linked osu! account       | done   |
| 5.6  | `me!` section                                 | done   |
| 5.7  | Draggable section order                       | done   |
| 5.8  | Medals                                        | done   |
| 5.9  | Share: screenshot and standalone HTML         | done   |
| 5.10 | macOS and Linux support                       | deferred |
| 5.11 | Incomplete plays (fails, quits, retries)      | done   |
| 5.12 | Incomplete plays on osu!stable                | todo   |

5.11 was added after v1.1.0 shipped, on the finding that the app was missing well over half
of what osu! counts as a play. It is ordered before 5.10 because it can be verified on this
machine and 5.10 cannot.

Ordering is by dependency, not by the order they were written down. 5.1 is the foundation
every toggle needs. 5.2 and 5.3 share one schema and ingest change, so they are adjacent.
5.5 is what supplies the name/avatar/banner that 5.9 then has to capture. 5.10 is last
because it is the only item that cannot be verified on this machine.

---

## Constraints that apply to every item

These are already load-bearing in the codebase (see `CLAUDE.md`) and none of the work below
is allowed to break them:

- **No native modules in the Node process.** `node:sqlite` and WASM only.
- **No API polling in the hot path.** Detection stays local. The osu! API is optional
  enrichment; the app must work with no credentials and no network.
- **Never scan-and-import on startup.** Importing past plays stays explicit.
- **pp comes only from osu!'s own code.** No second calculator, ever. Where 5.2 changes
  what pp is asked for, it changes the *input mods* handed to osu!'s calculator — it never
  computes a pp value itself.
- **TypeScript runs unbuilt.** No `enum`, no parameter properties, no decorators. Run
  `npm run check` (typecheck + tests), and `npm run ui` for anything that toggles
  visibility.

---

## 5.0 — Retire `prompt.txt`, keep the reference links

**Status:** done

**Goal.** `prompt.txt` is the original project brief; it has been fully superseded by the
README, `CLAUDE.md` and `docs/`. The only part still worth keeping is its list of reference
links.

**Plan.**
- Create `docs/reference-links.md` holding the inspiration project, `ppy/osu`,
  `ppy/osu-web`, the reference profile, the API docs, and the API-usage etiquette quote
  (which is the reason this app does not poll).
- Link it from the README's existing docs paragraph.
- `git rm prompt.txt`.

**Done when.** `prompt.txt` is gone, every link in it survives in `docs/reference-links.md`,
and the README points at it.

---

## 5.1 — Settings store and Settings dialog

**Status:** done

**Goal.** A place for user-facing toggles to live, since 5.2, 5.3, 5.6, 5.7 and 5.9 all need
one. Reached from the existing Options menu.

**Decisions.**
- Settings live in the **database**, not `config.json`. `config.json` is a startup/install
  file (port, install roots); settings are app state edited from the page, and the page must
  not be able to corrupt the file the app needs to boot.
- Settings that describe *the profile* (its me! text, its section order, its identity) are
  **per profile** — two playstyles are two profiles and should not share a description.
  Settings that describe *how scores are counted* (5.2, 5.3) are **also per profile**, so
  one profile can be a strict fresh account and another can be a relax-tracking profile.
  Everything is therefore keyed by `profile_id`.
- Unknown keys are ignored and defaults fill in, the same way `loadConfig` already behaves.

**Plan.**
- `src/settings.ts`: `SETTINGS_DEFAULTS`, `getSettings(db, profileId)`,
  `updateSettings(db, profileId, patch)`. Backed by a new table
  `profile_settings(profile_id, key, value)` (`ON DELETE CASCADE`), one row per key so
  adding a key never needs a migration.
- `GET /api/settings` and `POST /api/settings` in `src/http/server.ts`; include the current
  settings in `/api/state` so the page has them on first paint.
- `web/index.html`: a Settings modal, following the existing `.backdrop`/`.modal` pattern
  exactly (**note the `[hidden]` trap documented in `CLAUDE.md`**). Options menu gains
  `Settings…` above `Profiles…`.
- `web/js/main.js`: render toggles from a declarative list so 5.2/5.3 only add entries.
- `test/settings.test.ts`: defaults, round-trip, per-profile isolation, cascade on delete.

**Done when.** A toggle can be flipped, survives a restart, is scoped to its profile, and
`npm run check` and `npm run ui` pass.

---

## 5.2 — Include pp for unranked mods

**Status:** done

**Goal.** An opt-in toggle, *"Include pp for unranked mods"*, that lets scores osu! would
never rank still count toward Best Performance:

- **Relax / Autopilot** count *as if the mod were not on* — RX alone scores as nomod, RX+DT
  scores as DT. (The user asked for this explicitly.)
- **Rate-changed DT/NC/HT/DC** (1.45×, 1.55×, 1.6× …) count, scored at their actual rate.

**Decisions.**
- *Verified against the corpus (2,412 replays), and it matters:* osu!'s **difficulty**
  calculator is Relax-aware too, not just the performance calculator. Real numbers from
  this machine's replays:

  | mods | as played | with the mod stripped |
  | ---- | --------- | --------------------- |
  | `RX` | 6.26★ / 110.93pp | 7.83★ / **238.54pp** |
  | `AP` | 3.14★ / 57.44pp  | 4.45★ / 101.09pp |

  So *both* readings are genuine osu! output, and they are more than twice apart. The
  stripped value is inflated in a way worth understanding: a relax play's accuracy and
  combo are not what the player could reach by hand, so scoring those statistics as if the
  mod were off flatters the score. That is inherent to what was asked for.
- Therefore: **store both**, default to the stripped value the user asked for, and expose
  the choice as a second setting. Both numbers come out of osu!'s own code, so neither is a
  reimplementation, and storing both means changing the choice never needs a recompute.
  **The stripped basis must be labelled in the UI** wherever it appears.
- The corpus also contains real `HT` at `speed_change: 0.5` and `DA` scores, both of which
  today are stored as `ranked = 1`. The bug is not hypothetical.
- *Why not just compute pp lazily when the toggle is flipped?* Because the toggle would then
  take minutes and need the pp helper running. Instead: **always compute pp at ingest**
  whenever a local `.osu` exists, and make eligibility a query-time decision. Flipping the
  toggle then re-renders instantly.
- Rate-changed rate mods are **not** currently detected — `modsAwardPp` only looks at
  acronyms, so a 1.45× DT score is stored as `ranked = 1` today. That is a real bug; fixing
  it is part of this item, and the toggle is what gives those scores a way back in.

**Plan.**
- **.NET helper** (`tools/PpCalculator/Program.cs`): `Request` gains
  `stripMods: string[]`. After decoding, remove any mod whose acronym is in that list from
  `scoreInfo.Mods` before calling the difficulty and performance calculators. Everything
  else — legacy detection, `CL`, `MaximumStatistics` — is untouched.
- **Schema** (`src/db/schema.sql` + `ADDED_COLUMNS` in `src/db/index.ts`):
  - `map_status INTEGER` — the beatmap's `approved` value at ingest (null = unsubmitted).
  - `mods_ranked INTEGER` — would osu! rank this mod combination?
  - `pp_nomod REAL` — pp with RX/AP stripped; only set when the score actually has one.
  - Keep `ranked` meaning *"vanilla osu! ranks this"* so nothing existing shifts under it.
- **`src/calc/pp.ts`**: `modsAwardPp` learns about mod settings (a rate-adjust mod with a
  non-default `speed_change` is unranked); add `UNRANKED_BUT_STRIPPABLE = ['RX', 'AP']` and
  a helper that reports which of those a score carries.
- **`src/tracker/ingest.ts`**: always calculate when `beatmap.osuPath` exists; calculate a
  second time with `stripMods` when RX/AP are present. Store both.
- **`src/calc/stats.ts` + `history.ts`**: every query that says `ranked = 1` takes an
  eligibility predicate built from the settings — a shared `eligibilitySql(settings)` helper
  so there is exactly one definition. `topPlays` selects `pp_nomod` in preference to `pp`
  when the setting is on and the score has one.
- **Recomputing old scores.** Existing rows have no pp for ineligible scores. Add
  `POST /api/recompute` (explicit, confirmed, progress over SSE) that walks stored scores
  with a `replay_path` and fills in missing pp — and offer it from the toggle when it finds
  scores that need it. `scripts/reingest.mjs` keeps working unchanged.
- **UI.** Plays counted only because of this toggle get a marker in `playRow` (e.g. the pp
  value in the "unofficial" accent with a tooltip saying why), and the Best Performance
  heading says the profile is not scoring like osu!.
- **Tests.** `test/eligibility.test.ts` for the predicate; extend `test/official.test.ts`
  with a strip-mods round trip if a suitable replay exists in the corpus.

**Done when.** With the toggle off, every number matches today exactly. With it on, RX plays
appear with their nomod pp and a marker, rate-changed DT plays appear, and flipping the
toggle back removes them with no reingest.

---

## 5.3 — Include pp for unranked maps

**Status:** done

**Goal.** A second toggle, *"Include pp for unranked beatmaps"*, covering pending, WIP,
graveyard, qualified, loved and never-submitted maps.

**Decisions.**
- Rides on the same machinery as 5.2 — `map_status` plus a query-time predicate. Do 5.2
  first; this is then mostly settings, SQL and copy.
- Offer it as a **set of statuses**, not one boolean: loved and qualified are a very
  different proposition from a graveyarded map someone made yesterday. Default all off.
- A never-submitted map has no `online.db` row (`map_status` null) and no beatmap id, but if
  the `.osu` is on disk it can still be scored. It gets its own checkbox.

**Plan.** Settings keys, `eligibilitySql`, the Settings dialog section, marker in `playRow`,
and tests covering each status.

**Done when.** Each status can be included independently, Ranked Beatmaps / bonus pp / level
all follow, and the toggle is instant.

---

## 5.4 — Score actions: pin, reorder, hide

**Status:** done

**Goal.** osu!'s three-dot menu on a score row, plus one thing osu! does not have: removing a
score from the profile entirely.

- Pin a score → a **Pinned** section above Top Ranks, matching osu-web.
- Drag pinned scores to reorder; the order persists.
- Remove a score from the profile. It must disappear from Top Ranks, Recent Plays, Recent
  activity, Most Played, the stats totals and the pp history.

**Decisions.**
- "Remove" is a **hide**, not a `DELETE`: the row stays with `hidden_at` set. Reasons —
  re-ingest would bring it straight back, dedupe would no longer suppress the replay on
  disk, and an accidental removal has to be undoable. Hidden scores are filtered out of
  every query at the source (one shared `WHERE` fragment, next to `eligibilitySql`).
- Give the Settings dialog a *"Show removed scores"* / restore list so a hide is reversible.
- Pinned scores are pinned **per mode**, as on osu!, and a pinned score does not have to be
  in the top 100.

**Plan.**
- Schema: `hidden_at INTEGER`, `pinned_at INTEGER`, `pin_order INTEGER` on `scores`.
- `POST /api/scores/:id` with `action: pin | unpin | hide | restore | reorder`.
- `src/calc/stats.ts`: `pinnedPlays()`, and `AND hidden_at IS NULL` everywhere.
- `web/js/sections.js`: `playRow` gains a `⋯` button and a small popover menu.
- Drag-and-drop: native HTML5 DnD, no library, keyboard-accessible fallback (move up/down
  in the menu) — the drag is a convenience, not the only way.
- `test/scores-actions.test.ts`; `npm run ui` checks for the popover's visibility toggle.

**Done when.** Pinning, reordering and hiding all survive a reload, hidden scores are absent
from every section and from the totals, and a hidden score can be restored.

---

## 5.5 — Editable identity, and linking an official osu! account

**Status:** done

**Goal.** Profile name, avatar and banner become click-to-edit, with four sources each:
the local osu! session, a typed username / id / profile link, a manual file upload, or the
linked account set in Settings.

**Decisions.**
- **Linking is one setting** (`osuUserId` + cached username), and everything else defaults
  from it. It lives in Settings; the click-to-edit controls are shortcuts into the same
  state.
- **Network layering, in order of preference** — each step is optional and degrades:
  1. Avatar: `https://a.ppy.sh/<id>` needs no credentials at all. Cached to `data/`.
  2. **The OAuth layer turned out to be unnecessary and was dropped.** The public profile
     page redirects username -> id and embeds the whole public user object (id, username,
     `avatar_url`, `cover_url`, `country_code`) as `data-initial-data` -- the same data the
     API's `/users/{user}` returns. So there is no client id, no secret, and nothing for the
     user to register. Verified against a real profile.
  3. Nothing works: manual entry and file upload are always available.
- Fetched images are **copied into `data/`** so the page stays complete offline, and so a
  packaged build carries its own identity.
- **The local osu! session**: osu!stable stores the username in `osu!.<user>.cfg`
  (`Username = …`); lazer stores it in its own config. Read-only, best effort, and only
  used to *prefill* — never applied without the user confirming.

**Plan.** `src/clients/osu-api.ts` (tiny, optional, all failures non-fatal),
`POST /api/identity` (set name / set avatar / upload / clear), file upload via a plain
`multipart` or raw-body PUT, `LOCAL_IMAGES` extended to cover per-profile images, and edit
affordances on the avatar, name and cover in `web/js/main.js`.

**Done when.** With no network and no credentials, everything still works via upload and
typing. With a linked account, avatar and banner appear and are cached.

---

## 5.6 — `me!` section

**Status:** done

**Goal.** The description box from the official profile page, click-to-edit, per profile.

**Decisions.** Stored as **plain text**, rendered with line breaks and autolinked URLs. Not
BBCode and not full Markdown: osu!'s BBCode subset is large, and a local profile gains
nothing from an HTML sanitiser it would have to get exactly right. Escape everything.

**Plan.** Settings-backed value, a `me!` section in the section list (so 5.7 can move it),
an editing state with Save/Cancel, and an empty state that invites the first edit.

**Done when.** Text survives a reload, is per profile, and `<script>` typed into it renders
as literal text.

---

## 5.7 — Draggable section order

**Status:** done

**Goal.** Reorder `me!`, Recent, Top Ranks, Historical, Medals by dragging, order saved —
the way osu! lets you rearrange your own profile.

**Decisions.** The order lives in settings as an array of section ids. Unknown ids are
dropped and missing ids appended on load, so adding a section later (5.8) never leaves a
saved order stale. The section tab bar follows the same order.

**Plan.** Reuse whatever drag helper 5.4 produced. Drag handles appear on the section
headings. Keyboard fallback again. Reset-to-default button.

**Done when.** A reordered page comes back reordered, and adding a new section id to the
code appends it cleanly to an existing saved order.

---

## 5.8 — Medals

**Status:** done

**Goal.** A Medals section mirroring the official profile's, restricted to the medals that
are actually computable from local data:

- **Combo**: 500, 750, 1000, 2000 — *osu!standard only; osu! has no others*
- **Play count**: 5,000 · 15,000 · 25,000 · 50,000 — *osu!standard only*
- **Hit count**: four tiers — *the other three modes' equivalent, which osu! does have*
- **Rank**: top 50,000 · 10,000 · 5,000 · 1,000 — real osu! medals, all modes
- **Beatmap pass** and **FC**: 1★–10★ for osu!standard, 1★–8★ elsewhere

**Decisions.**
- Derived on the fly from stored scores, not stored as awards — the same reasoning as
  `history.ts`: a reingest or a settings change must not leave stale medals behind. The
  *date* a medal was reached comes from the first score that satisfied it.
- **FC detection** needs the beatmap's maximum combo, which is not stored per score today.
  The pp helper already returns `maxCombo`; add a `beatmap_max_combo` column and populate it
  at ingest. Definition: no misses **and** combo ≥ the beatmap max (allowing for slider-end
  losses on lazer scores, which is why the map's own value is needed rather than a guess).
- **Rank medals** use the estimated rank curve, so they are estimates and say so — the same
  disclaimer the Global Ranking panel already carries.
- **Artwork and every name**: taken from osu!'s *published achievement list*, which the
  profile-page payload already carries -- so `scripts/build-medal-table.mjs` generates
  `medal-definitions.json` rather than anyone typing names out. That is what revealed the
  asymmetry above. The icons load from `assets.ppy.sh` over a drawn placeholder, exactly as
  beatmap covers do, so the section is complete offline.
- Locked medals are shown greyed with their requirement, as osu! does.

**Plan.** `src/calc/medals.ts` (pure, tested against fixture score sets), the section markup,
`web/js/badges.js` gains the generated medal, and `/api/profile` returns the medal list.

**Done when.** Medals unlock at the right thresholds with the right dates, the section
renders offline, and `test/medals.test.ts` covers each family including the boundaries.

---

## 5.9 — Share: screenshot and standalone HTML

**Status:** done

**Goal.** Hand someone else the profile. Three ways, in increasing fidelity:

1. **Standalone `.html`** — one self-contained file with the CSS, the SVG badges and the
   data inlined, and remote covers either inlined as data URIs or dropped. Opens anywhere,
   offline, forever. This is the primary answer.
2. **PNG screenshot** — full-page render.
3. **Share on your network** — print the LAN URL and a QR code so a phone on the same
   Wi-Fi can open the live page. (This is the option the user asked to be told about: it
   needs no export at all. It is opt-in, because the server currently binds locally.)

**Decisions.**
- The screenshot is produced by driving an **already-installed** Chrome or Edge over CDP —
  the mechanism `scripts/ui-check.mjs` already uses — never by bundling a browser, which
  would dwarf the 83MB package. If none is found, say so and offer the HTML export instead.
- The HTML export must be generated from the same section renderers as the live page, or it
  will drift. That means a small amount of restructuring in `web/js/` so the section markup
  can be produced server-side too, or a "render then serialise the DOM" approach driven from
  the page itself. Prefer the latter: no duplication, and it captures exactly what is on
  screen including 5.7's ordering.
- The exported file must not contain absolute `localhost` URLs.

**Done when.** The exported HTML opens with the app closed and looks like the page, the PNG
matches, and the LAN option is off by default.

---

## 5.10 — macOS and Linux support

**Status:** deferred to a later phase

**Goal.** Everything above works on macOS and Linux. This is last because it cannot be
verified on the development machine — treat every step as "written carefully, needs a real
run on the target OS".

**Scope.**
- **Detection** (`src/clients/detect.ts`): lazer at `~/.local/share/osu` and
  `~/Library/Application Support/osu` is already listed but only reached when `HOME` is set —
  verify, and add `XDG_DATA_HOME`. osu!stable under Wine/CrossOver lives at
  `~/.wine/drive_c/…` and inside the osu! Wine wrapper's bottle; support it if the paths
  can be found, but do not let a missing Wine prefix be an error.
- **Paths**: audit for `\\`, drive letters, and `%APPDATA%`; `path.join` everywhere.
- **The pp helper**: `PpCalculator.csproj` publishes `win-x64` today. Add `osx-arm64`,
  `osx-x64` and `linux-x64`, and make `src/calc/official.ts` find the right executable and
  its extension.
- **Packaging** (`scripts/package.mjs`): per-platform artifacts, a `start.sh` /
  `.command` beside `start.bat`, and the executable bit set in the archive. Note macOS
  Gatekeeper will quarantine a downloaded unsigned binary — document the workaround rather
  than pretending it does not happen.
- **`openBrowser`** already branches correctly.
- **CI** (`.github/workflows/`): run `npm run check` on ubuntu and macos runners.

**Done when.** `npm run check:app` passes on each platform and a packaged build starts from
a fresh directory. Until someone can run it, the README says which platforms are verified.

---

## Notes for whoever picks this up

- Read `CLAUDE.md` first. The findings in it were established against a real 2,408-replay
  corpus and several are counter-intuitive.
- `npm run check` is typecheck + tests; `npm run ui` drives the real page in headless Chrome
  and is the only thing that catches CSS/visibility regressions. The reset-dialog bug it was
  written for cost a user their tracked scores.
- Anything that changes what a stored score means needs a migration entry in
  `ADDED_COLUMNS`, because `schema.sql` is `CREATE TABLE IF NOT EXISTS` only.
- Dev and packaged builds keep separate `data/` directories. Do not alternate between them
  while testing a data change.

---

## 5.11 — Incomplete plays (fails, quits and retries)

**Status:** done

**Goal.** Count the plays osu! counts and this app does not: a play that was started but
never finished, whether by early exit, a retry, or an HP fail. They join the play count, the
monthly play counts, Most Played, and (configurably) Recent Plays.

### What osu! actually counts — established from ppy/osu, not guessed

`SubmittingPlayer.submitScore` submits a score on fail *or* quit *or* retry. There is **no
minimum object count** — the questions we assumed might exist ("15 objects? 25?") are not
what osu! asks. It asks exactly three things, and a play counts if all three hold:

1. a score token was issued (the play started while online and logged in, with
   user-playable mods),
2. **at least one non-miss judgement landed** (`Statistics.Any(s => s.Key.IsHit() && s.Value > 0)`),
3. total score > 0.

Quitting before hitting anything is the only case osu! itself throws away, and it says so:
`No hits registered, skipping score submission`.

### Why the replay watcher cannot see these plays

`Player.prepareAndImportScoreAsync` imports a score locally only when
`ScoreProcessor.HasCompleted && GameplayState.HasPassed`, or when `forceImport` is set —
which only `FailOverlay.SaveReplay` does, i.e. the user clicking "Save replay" by hand. So:

| play type | replay in lazer's store | osu! counts it |
| --------- | ----------------------- | -------------- |
| passed | yes | yes |
| multiplayer HP-fail | yes, rank `F` | yes |
| solo HP-fail | **no**, unless "Save replay" is clicked | yes |
| quit / early exit / retry | **no** | yes |

Multiplayer is the odd one out because `MultiplayerPlayer.PerformFail` suppresses the fail
outright — "failing in multiplayer only marks the score with F rank" — so the map plays to
the end and is imported normally. That is what every rank-`F` replay in this machine's store
turned out to be: all 22 of them judged **100%** of their beatmap's hit objects. There is not
one partially-played replay on disk, which is the clearest possible confirmation that a real
fail or quit leaves nothing behind.

Measured on one real session (`logs/1789001733.*`): **54 plays started, 45 counted by osu!,
19 replays written**. The app was therefore missing 58% of its own play count.

### Decisions

- **The source is lazer's own log files**, `<lazer>/logs/<session>.runtime.log` plus
  `.network.log`. This is the only local record of a play that leaves no replay, and it
  needs no API, no credentials and no polling — the same trade already accepted for
  `src/clients/osu-web.ts`. Like that module it is a private detail of osu! and must fail
  quietly and visibly rather than inventing plays.
- **A play is counted when osu! counted it.** The log line `Score submission completed!` is
  emitted exactly when osu! accepted the submission, so the app's play count agrees with the
  website by construction rather than by reimplementing rule 2 above. Better still, both go
  silent together: play offline and there is no token, no submission, and no play count on
  either side.
- **A pass is told apart by the results screen**, not by matching against replays. While a
  play is open the screen stack logs `suspended <Player> (waiting on <...>ResultsScreen)`
  for a completed map and `exit from <Player>` for one that was abandoned. Verified against
  the corpus: in that session the signal fired 19 times and there were exactly 19 replays on
  disk, matching one-to-one on time and beatmap. A time-window match against ingested scores
  was considered and rejected — two attempts at the same map minutes apart are genuinely
  ambiguous, and the log answers the question directly.
- **lazer's submission token is the dedupe key.** It is server-issued and unique per play,
  so re-reading a log can never duplicate a play, and it needs no synthesised identity.
- **Stored in their own table, not in `scores`.** An incomplete play has no accuracy, no
  combo, no mods, no pp and no total score — that data never leaves lazer's memory. Putting
  a row of zeroes into `scores` would silently poison weighted accuracy, grade counts,
  ranked score, the level bar and every medal. `incomplete_plays` keeps them separate and
  the four aggregates that should include them opt in explicitly.
- **Counting them is not a setting.** osu! counts them, so the play count counts them.
  What *is* a setting is whether they appear in Recent Plays, because a player who retries
  a lot would otherwise see a feed that is mostly retries: `showIncompleteInRecent` is
  `yes` | `collapse` | `no`, default **`collapse`**, which folds consecutive attempts on one
  beatmap into a single row carrying the attempt count.
- **`hitsPerPlay` keeps dividing by scored plays.** osu!'s own figure includes the hits from
  failed plays, which we do not have; dividing hits we *do* have by a play count inflated
  with plays contributing none would bias it low by the size of the gap. The ratio over the
  scored subset is the better estimate of osu!'s number.
- **The mode comes from the beatmap**, since the log never names the ruleset. A converted
  play therefore lands under the beatmap's own mode. Noted rather than guessed at.
- **Nothing is scanned at startup**, exactly as for replays: tailing begins at the current
  end of the log. Past sessions are an explicit, previewed backfill or nothing.
- **lazer only.** osu!stable submits fails too but keeps no comparable log, so a stable
  install contributes passes exactly as it does today.

### Plan

- `src/clients/lazer-log.ts` — the log grammar and a `LogSession` that turns lines into
  plays. Pure and line-at-a-time, so live tailing and whole-file parsing share one path.
- `src/tracker/log-watcher.ts` — follow the newest session's logs by byte offset.
- `src/tracker/incomplete.ts` — resolve the beatmap, apply the cutoff, insert.
- Schema: `incomplete_plays`, keyed by profile and token, with `hidden_at` so `visibleSql()`
  applies to it verbatim.
- `src/calc/stats.ts` and `src/calc/history.ts`: play count, monthly play counts, Most
  Played, Recent Plays.
- `src/settings.ts` + the Settings dialog: `showIncompleteInRecent`.
- `web/js/sections.js`: a dimmed row with a "Didn't finish" badge and no invented numbers.
- `test/lazer-log.test.ts` against real log excerpts, plus aggregate tests.

**Done when.** A quit, a retry and an HP fail each raise the play count, appear in the
monthly chart and Most Played, and show in Recent Plays according to the setting — and a
passed play is still counted exactly once.

---

## 5.12 — Incomplete plays on osu!stable

**Status:** todo — blocked on having an osu!stable install to inspect

**Goal.** What 5.11 does for lazer, for osu!stable: count the plays that were started and
never finished. Today a stable install contributes its passes exactly as it always has, and
nothing else, so a stable player's play count is short by however much they quit and retry.

**Read 5.11 first.** Its findings about what osu! counts are about the *server*, and so they
hold for stable too. What differs is only where the evidence lives on disk.

### Established (verified against ppy/osu and this machine's corpus)

- **osu! counts a fail, a quit and a retry**, on any client, provided a token was issued, at
  least one non-miss judgement landed, and the score is above zero. There is no minimum
  object count. This is server-side behaviour and is not lazer-specific.
- **stable does not save a replay for a failed play.** "Option to save failed replays" is a
  standing feature request against stable
  (<https://github.com/ppy/osu-stable-issues/issues/254>), which settles it: `Data/r/` holds
  passes only, the same shape of gap lazer has.
- **`scores.db` is "the local leaderboards"** per osu!'s own wiki, and a local leaderboard
  is a list of completed plays — so it is very unlikely to hold an abandoned one. Worth
  five minutes to disprove, not worth building on.

### Unverified leads, in the order worth trying

Nothing below has been confirmed, because there is no stable install here. Treat each as a
question, not a fact, and **write the answer back into this section** either way — a lead
ruled out is as useful to the next session as one that worked.

1. **Does stable have a `Logs/` directory, and does it record score submission?** Several
   sources say stable writes `network.log`, `runtime.log`, `osu!auth.log`, `performance.log`
   and `session.log` under the install root, but osu!'s own wiki page for the program files
   does not list a `Logs` folder at all, and the sources may be describing lazer. **Check
   this first**: if stable logs its submissions the way lazer does, 5.12 is mostly a second
   grammar and very little else.
   - What to look for: a line written when a score is submitted, and anything naming the
     beatmap. stable is a different codebase from lazer, so the *wording* will differ — do
     not expect `Score submission completed!`.
   - stable's logs are widely described as being obfuscated/minimal compared to lazer's, so
     be ready for this to come to nothing.
2. **`osu!.db`.** The wiki calls it "osu!'s database of beatmaps"; it is known to record
   whether a beatmap has been played. If it also keeps a per-beatmap *play count* that
   includes failed attempts, that is a source for Most Played and the play count, though
   not for Recent Plays — a counter has no timestamps, so it can say how much but never
   when. Deltas on a counter would also be fragile across restarts.
3. **`scores.db`.** Rule it out (see above) rather than assume it.
4. **Nothing local at all.** If none of the above pans out, say so in the README and stop.
   The osu! API's `include_fails=1` would answer it completely, and is still refused: it
   needs an OAuth client id and secret and breaks the project's "no login anywhere"
   promise. Not counting a play is much better than that.

### The experiment that made 5.11 tractable

Do this before writing any code. It is what turned "lazer probably drops some plays" into a
number, and it will do the same for stable:

1. Play one normal session — pass some maps, quit some, retry some, fail some.
2. Count **plays started**, **plays osu! counted**, and **replays written to disk** over
   that window. For lazer those came from the session log and from the file store's replay
   timestamps; for stable, `Data/r/` file times will give the third number, and your own
   profile page on the website gives the second.
3. The gap between the second and third numbers is the whole feature. On lazer it was 45
   against 19.

### Where it plugs in

The ingest is already client-agnostic and does not need changing:

- `ingestIncompletePlay` in `src/tracker/incomplete.ts` takes a `ResolvedLoggedPlay` —
  token, timestamp, beatmap id or name, and whether it passed — and knows nothing about
  where that came from. Give it those five facts from any source and everything downstream
  (the play count, the monthly counts, Most Played, Recent Plays, reset, delete) already
  works.
- `src/clients/lazer-log.ts` and `src/tracker/log-watcher.ts` are the lazer-specific half.
  A stable source is a sibling of those two, not a change to them.
- The dedupe key must stay something stable and unique per play. lazer's submission token is
  ideal because osu! issues it. If stable offers nothing equivalent, a key will have to be
  synthesised, and it must survive a re-read of the same source without producing a second
  play — see how `dedupe_key` is used in `src/tracker/incomplete.ts`.
- `logDirOf` in `src/clients/lazer-log.ts` already returns null for a stable install, so
  stable installs are silently skipped today rather than half-supported.

**Done when.** A quit and a retry on osu!stable raise the play count the same way they do on
lazer — or this section records, with evidence, that stable keeps no local trace of them and
the README says so plainly.
