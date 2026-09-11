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
| 5.10 | macOS and Linux support                       | in progress |
| 5.11 | Incomplete plays (fails, quits, retries)      | done   |
| 5.12 | Incomplete plays on osu!stable                | todo   |
| 5.13 | Paged sections and osu!'s own charts          | done   |
| 5.14 | The osu-web fidelity kit                      | done   |
| 5.15 | Scrollable dialogs, footer, dismissible warning | done |
| 5.16 | One-click update from GitHub releases         | done   |
| 5.17 | osu! parity: header, Scores, medals, badges   | done   |
| 5.18 | Rename to **osu! local profiles**             | done   |
| 5.19 | Open in browser on start, and a menu toggle   | done   |
| 5.20 | Beatmaps section: Favorite Beatmaps           | done   |
| 5.21 | View Details (score card) and Download Replay | done   |
| 5.22 | Floating audio player; pause resumes          | done   |
| 5.23 | Score links, pages and screenshots            | done   |
| 5.24 | Performance and cleanup pass                  | done   |

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
dropped and missing ids inserted on load -- *revised in 5.20:* after the section they follow in
the default order rather than appended, since appending put Beatmaps below a Medals the user
had moved to the bottom (`reconcileSectionOrder` in `web/js/sections.js`), so adding a section later (5.8) never leaves a
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

*Superseded in 5.17:* the LAN option was removed outright at the user's request. The live
page is never served off the machine; the HTML export and the PNG are the ways to share.

---

## 5.10 — macOS and Linux support

**Status:** in progress — written and covered by CI on all three platforms; **unverified
against a real osu! install on macOS or Linux**

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

### What was built

- **Detection** was rewritten around an injected `DetectEnvironment` (platform, home, env)
  so the candidate paths are a *pure function* and can be tested for a platform this machine
  is not -- which is the only way any of this could be checked here at all. `os.homedir()`
  replaces `$HOME`, so an unset variable no longer sends it looking in a directory called
  "undefined". `XDG_DATA_HOME` is honoured, and a relative one ignored as the spec requires.
- **osu!stable under Wine** covers the Wineskin bundles (`osu!.app/drive_c/...`, which sits
  beside `Contents` rather than inside it), plain and `WINEPREFIX` prefixes, CrossOver
  bottles listed rather than guessed, Wine's per-account profile directory, and
  **osu-winello** -- which writes the install path it was given to
  `$XDG_DATA_HOME/osuconfig/osupath` and links it as the prefix's `D:` drive, so both are
  *read* rather than guessed. A missing prefix is the normal case and never an error.
- **`installRoots` now actually works.** It was documented in `config.json`, printed in the
  "no osu! found" message as the thing to set, and read by nothing. That was survivable on
  Windows, where detection nearly always succeeds, and would have been the first thing a
  macOS or Linux user hit. A configured root is classified by what is inside it, so the user
  does not also have to say which client it is.
- **The pp helper's pruning is platform-aware.** It deleted a hardcoded list of `.dll`
  names, so on macOS or Linux it would have matched nothing and silently shipped a 273MB
  helper instead of a 114MB one -- **including BASS**, which is not freely redistributable.
  Matching is now by base name across `.dll`/`.dylib`/`.so` with either version convention,
  anchored so `ppy.ManagedBass.dll` (which the helper cannot start without) is untouched.
  The patterns are pinned by tests against the verified Windows list, the macOS and Linux
  spellings, and every one of the 273 files in a real pruned helper. The build warns loudly
  if it prunes nothing.
- **The runtime identifier defaults to the host** rather than always `win-x64`.
- **Packaging** writes a `.command` on macOS (the extension Finder will run; a `.sh` opens
  in a text editor) and `start.sh` on Linux, both `chmod 0o755`, and a `README.txt` for that
  platform -- including that macOS *will* refuse the first launch, because the build is
  unsigned, and the two ways round it. Building for a different OS than the host is refused:
  the bundled Node runtime is a copy of the running one, so a cross-built archive would look
  complete and start on nothing.
  - That text lives in `scripts/package-files.mjs` as pure functions of the platform, for
    the same reason detection does: otherwise the macOS and Linux launchers are unread text
    first seen by whoever downloads them. `test/package-files.test.ts` pins the extension,
    the executable bit, the shebang, the `cd` line every launcher exists for, and that each
    README names the launcher its own platform actually has.
  - Verified not to have changed the Windows output: the rebuilt package is the same 272MB
    -> 112MB prune, the same 203MB/83MB result, and a byte-identical `.bat`.
- **Browser discovery** for the screenshot and the UI check is now one shared function that
  also searches `PATH`, instead of the UI check's two hardcoded Windows paths -- which meant
  `npm run ui` could not run at all on macOS or Linux.
- **`--check-only` reports both answers.** It used to stop at "no osu! installation found"
  and never reach the pp calculator; "osu! is not where I looked" and "the helper will not
  start" are separate faults with separate fixes.
- **CI** runs on `windows-latest`, `ubuntu-latest` and `macos-latest` with `fail-fast:
  false`, and now also starts the app far enough to prove the modules load, the schema
  applies and the pp calculator runs on that platform.
  - **Green on all three as of run 34446669359 (2026-09-10)**, which is the first time this
    project has been run on macOS or Linux at all.
  - It earned its keep immediately, and not in the direction anyone expected: **ubuntu and
    macOS passed while Windows failed.** `fs.watch` was being handed a path that was not
    canonical, which makes libuv *abort the process* rather than raise -- see
    `CLAUDE.md`, "Never hand `fs.watch` a path you have not resolved". A GitHub runner's
    `TEMP` is an 8.3 short name, so it fired there and never locally, and because the
    process died rather than a test failing it took two unrelated test files down at once.
    Two commits had already shipped red before anyone looked. **Check CI after pushing.**

### What is left, and needs a real machine

None of this can be done from Windows:

1. `npm run check:app` against an **actual osu! installation** on macOS and on Linux --
   that detection finds it, not merely that the code runs.
2. `npm run package` on each, and a packaged build started from a fresh directory after
   being unzipped -- especially that the executable bit survives the archive.
3. `npm run ui` on each, which needs a browser and a running app.
4. The **file watcher**, which is the mechanism the whole tracker rests on. `fs.watch` with
   `recursive: true` means one `ReadDirectoryChangesW` handle on Windows, but on Linux the
   kernel watches a single directory at a time, so Node implements recursion in JavaScript
   by adding an inotify watch **per directory** -- and lazer's store is ~4,000 of them. On a
   system with a low `fs.inotify.max_user_watches` that fails with `ENOSPC`, which reads as
   "disk full" and is not. `explainWatchError` in `src/tracker/watcher.ts` now says what it
   actually means and how to raise the limit, but nobody has yet watched a real store on
   Linux to see whether the default limit is enough.
5. **osu!stable under Wine**, against a real wrapper. Every path in `wineStableCandidates`
   is from documentation and source, not from a machine.

**Done when.** `npm run check:app` passes on each platform against a real osu! install, and
a packaged build starts from a fresh directory. Until someone can run it, the README says
which platforms are verified and which are only written.

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

---

## 5.13 — Paged sections, and charts that match osu!'s

**Status:** done

**Goal.** Four things the profile page did differently from osu!'s own, all asked for
together because they are the same complaint: the page did not look or behave like the
thing it is modelled on.

1. Recent, Top Ranks, Most Played Beatmaps and Recent Plays start at **five rows** with a
   **show more** button, expanding to 25 and then 25 at a time.
2. The rank graph is **osu!'s yellow**, not this page's pink.
3. The rank graph is **hoverable**, reading out `Global Ranking #120,000` / `40 days ago`
   at daily granularity.
4. Monthly Playcounts becomes **Play History**: a yellow line chart, monthly, hoverable for
   `Plays 430` / `March 2020`.

### Everything here was read off osu-web rather than eyeballed

Each value below comes from osu-web's own source, so this is a match rather than an
impression of one:

- The line is **`@yellow`, `#ffcc22`, at 2px** — `.line-chart--profile-page` in
  `resources/css/bem/line-chart.less`. It is a literal rather than one of this project's
  `--hsl-*` tokens because it is not derived from the page's base hue: it stays gold
  whatever the accent is.
- The **hover marker** is a 20px circle filled `--hsl-b5` with a 4px yellow border, over a
  full-height 2px yellow line — same file.
- The **tooltip** is pinned to a top corner and *flips away from the cursor* rather than
  following the point (`data-float`), which is what keeps it from sitting under the pointer.
  Its value line is white and its date line `--hsl-l1`, with the value on top.
- The **rank wording** is `<strong>Global Ranking</strong> #123` over `40 days ago`, from
  `profile-page/rank-chart.tsx` — the x axis there really is days-ago rather than a date,
  which is why the tooltip says so.
- **Play History** is the section's real name (`users.show.extra.historical.monthly_playcounts.title`),
  its tooltip is `<strong>Plays</strong> 430` over `March 2020`
  (`MMMM YYYY`), and it is a `curveLinear` line — `profile-page/chart.tsx`.
- The **button** is `show-more-link`: a centred pill, white on `--hsl-b2`, `--hsl-b1` on
  hover, label between two chevrons, reading `show more`.

### Decisions

- **The hover marker and tooltip are HTML over the plot, not SVG inside it.** The charts
  stretch with `preserveAspectRatio="none"` in a 0..100 space, which is what makes them
  responsive without measuring the DOM — and would render a circle as an ellipse whose shape
  depended on the window width. osu-web does the same thing for the same reason: its hover
  circle is a `div`.
- **The tooltip text is formatted at render time and carried on the element as JSON.** The
  hover handler is then a pure lookup that never has to know which chart it is attached to,
  and re-arming after a re-render is one call rather than one per chart.
- **Hovering snaps to the nearest real point** rather than interpolating. That is what makes
  the granularity real: daily on the rank chart, monthly on Play History. You are always
  reading a value that was actually recorded.
- **Paging is server-side.** The page sends the size it wants for each section and gets
  totals back. The alternative — fetch everything and slice in the browser — would either
  cap how far "show more" can go or make opening a profile cost as much as its whole
  history. Now a profile with thousands of plays opens with twenty rows, and expanding
  stays honest for however long the list is.
- **The bracketed remaining count was dropped.** osu-web's `ShowMoreLink` can show one, but
  the profile page does not pass it — and here it would be subtly wrong, because Recent
  Plays counts *plays* while it draws *rows*, and a collapsed run of retries is several
  plays in one row.
- **Knowing when to stop offering needs both halves of the test**, and this is the one real
  trap in the feature. A page shorter than what was asked for is definitely the end. But the
  total counts plays, so a section that came back exactly full might still be complete once
  retries collapse — `total <= returned` catches that. Either test alone leaves a button
  that reveals nothing.
- **Top Ranks is capped at 100** regardless of how many eligible maps a profile has, because
  100 is all osu! ever weights.
- Switching mode **resets the expansion**: a different mode is a different set of lists, and
  carrying an expansion over would ask for 200 rows of a mode with three.

**Done when.** All four sections start at five and expand; both charts are osu!'s yellow and
read out on hover at the right granularity; and `npm run ui` checks each of those against
computed style in a real browser rather than against markup.


---

## 5.14 — The osu-web fidelity kit

Every "make it look more like osu!" request so far cost a round trip, because the design was
being reconstructed from description rather than read from the thing that defines it. The
chart colour, the hover readout, the missing flag and the washed-out SS badge were all the
same failure. This makes the source readable and writes down what may be taken from it.

**Status: done.**

### Decisions

- **A sparse, gitignored reference checkout, not a fork.** `reference/osu-web` is 6.5MB of
  the 158MB repo — the LESS, the profile-page TSX, the badge images and `database/mods.json`.
  Building *on* osu-web was considered and rejected: it is a Laravel app needing PHP, MySQL
  8.4+, Elasticsearch 7+ and Redis, its profile page reads osu!'s API schema rather than
  this app's, and 14.5MB of its 158MB is PHP against 689KB of LESS. The part worth having is
  the part that is readable in place.
- **Values, never files, and the licence is the reason.** osu-web is AGPL-3.0-or-later.
  Copying its stylesheets or images would relicense this project away from MIT and, because
  the app serves a page over HTTP, engage AGPL §13 the moment it is served to anyone else
  (then via `shareOnNetwork`, since removed -- the reasoning still holds for the HTML export).
  Colours, ratios and wording are facts and carry no such condition.
- **`ppy/osu-resources` is off limits, and it is the trap.** lazer's own flag and mod
  textures look like the obvious source. They are **CC-BY-NC 4.0** — incompatible with MIT
  *and* with AGPL, and NonCommercial sits badly beside taking donations. Flags come from
  Twemoji, which is where osu-resources' own `osu_flags.sh` gets them.
- **Flags are vendored, not fetched.** `country` is a setting that can be typed with no
  network, so any of the 258 codes has to resolve offline. 636KB for the set; the page loads
  one 2.4KB file. `scripts/build-flags.mjs` reads the npm tarball with a 40-line tar reader
  rather than adding a dependency.
- **The country's *name* is shown beside the flag, as osu! does**, via `Intl.DisplayNames`.
  A table of 250 country names would have been the obvious way and would have shipped bytes
  the browser already has.
- **The mod type table is generated now.** It was hand-written and its own comment called it
  "rough"; the type is what picks a mod's colour, so a wrong row was a visibly wrong badge.
  `database/mods.json` also supplies real mod names, so a tooltip says `Double Time (1.3×)`
  rather than listing raw setting keys.
- **The mod badge is osu!'s shape, with the acronym where the glyph goes.** The hexagon,
  the type colour, the extender tab and the cog are all reproduced from `mod.less`'s
  measurements — including both darkenings, which happen in *different colour spaces*
  (linear sRGB for the glyph at 10%, plain sRGB for the extender at 26.3%, from
  `Colour4.Darken(2.8f)`). The 71 per-mod glyphs are AGPL artwork and are not reproduced;
  osu! itself falls back to the acronym for any mod it has no glyph for.
- **The gold on SS and S was a half-implemented gradient**, not a palette error. Both
  variants are the same badge with two different letterform gradients — gold #FFE7A8 →
  #FFB800, silver white → #AADFF0 — and only the silver one had been implemented, so SS and
  S fell back to the flat outline colour and read as washed out.

**Done when.** `docs/osu-web-fidelity.md` maps every region of the page to the osu-web file
that defines it and states what may be taken; flags and mod badges render from generated
data; and `npm run ui` measures the badge height and the flag's ratio in a real browser.


---

## 5.15 — Scrollable dialogs, a footer, a dismissible warning

Three small things asked for together.

**Status: done.**

### Decisions

- **The cap is on the dialog, not the backdrop.** `.backdrop` is `position: fixed` and
  centres its child, so a dialog taller than the window overflowed in *both* directions and
  the top went off-screen where nothing could scroll to it. Capping `.modal` at the viewport
  keeps it centred and moves only its content. `100dvh` after `100vh` matters on mobile,
  where browser chrome makes `100vh` taller than what is visible.
- **The footer carries the version.** It is the one number someone has to be able to read
  out when reporting a problem, and 5.16 needed somewhere to put it anyway.
- **Dismissing the warning is a per-profile setting, not a global one.** A profile that has
  deliberately turned on relax scoring does not need telling twice; another profile on the
  same install may still be scoring officially and must still be warned.
- **It hides the sentence, not the fact.** Unranked-mod scores keep their `*`, the Settings
  dialog still explains what each option does, and a toggle there turns the warning back on
  -- otherwise "don't show again" would be a one-way door on the app's only disclosure that
  its numbers are not osu!'s.

## 5.16 — One-click update from GitHub releases

**Status: done.** The one part that cannot be verified from here is the download itself:
the repository is private, so the unauthenticated releases API answers 404. Everything
either side of it is exercised -- see **What was actually tested** below.

### Decisions

- **In place, with a rollback copy.** The alternative considered was a side-by-side install,
  which can never break what you have but leaves every shortcut pointing at the old folder
  and accumulates version directories. In place keeps the path stable; the outgoing files
  are *moved* to `.rollback-<stamp>/` rather than deleted, so a swap that dies half way
  leaves both halves on disk.
- **`data/` is stepped around, and that is the whole safety story.** `dataDir()` is
  `<install>/data`, so the user's database, settings and images sit *inside* the thing being
  replaced. The swap works on the install's other top-level entries and skips that one.
- **Nothing is swapped until the new build is verified on disk**: the download's size is
  checked before it is unpacked, the unpacked tree must contain `package.json`, `src`, `web`
  and a runtime, and its `package.json` must say the version that was advertised.
- **A source checkout refuses outright.** `start.bat` runs `node src/main.ts` from the
  repository, and an "update" there would overwrite a working tree with a release zip. Both
  a `.git` directory and a missing bundled runtime block it, because either test alone can
  be fooled.
- **The swap runs from the *new* build, not this one.** On Windows the running `node.exe` is
  locked by the process that would replace it, so `scripts/apply-update.mjs` is spawned
  detached from the staged tree using the staged tree's own runtime. A release therefore
  always installs itself with its own updater rather than with whatever the older version
  shipped -- which is why that script is now part of every package.
- **The zip reader is ours.** No dependency was available (`node:sqlite` and one pure-JS
  LZMA codec are the entire runtime dependency list) and shelling out to Windows' `tar.exe`
  would have put the riskiest path in the app behind a binary that exists on one OS. It
  refuses zip64 rather than half-reading it, and refuses any entry whose path escapes the
  target -- this runs on a file fetched over the network.
- **Backslash separators had to be handled.** This project's own packager writes them: a
  release archive says `osu-local-profiles-<version>-win-x64\node.exe`. Read to the letter that
  is one very long filename.
- **Relaunch goes through `cmd`'s `start`.** Spawning the runtime directly is simpler and
  wrong: `detached` maps to DETACHED_PROCESS on Windows, so the app would come back running,
  tracking and *invisible*. The launcher is called `Start osu! local profiles.bat`, so the
  quoting is the difficulty -- an unquoted path runs a program called `Start`, which is
  exactly what the first attempt did.
- **One request, at startup.** Not a timer, for the reason in `docs/reference-links.md`.
  `checkForUpdates: false` in `config.json` turns off the app's only outgoing request.
- **A failed check shows nothing.** No network, a private repository and a rate limit are
  all ordinary; none is a reason to put an error where a button would go.

### What was actually tested

- The zip reader against the **real 82.7MB 1.2.0 release**: 443 entries, 438 files, and
  `node.exe` hashes byte-identical to the one in `dist/`.
- The swap end to end against a throwaway install: `data/` survives, every other entry is
  replaced, the rollback copy holds the old files and *not* `data/`, `data/update.log` says
  what happened, and the app is relaunched in a visible window.
- The refusal path: while the parent process is still alive the updater waits and touches
  nothing.
- `fetchLatestRelease` against a real public repository, to prove the request, the tag
  parsing and the asset matching work against GitHub's actual JSON.
- Version comparison, including `1.9.0 < 1.10.0` and pre-releases sorting below their
  release, in `test/update.test.ts`.

### Verified end to end (2026-09-10, after the repository was made public)

Nothing is left unproven. The whole path was run for real against the public repository,
without waiting for a 1.4.0 release: a throwaway copy of the packaged 1.3.0 build had its
`package.json` set to **1.2.9**, so the genuine 1.3.0 release looked like an update to it,
and it then updated itself. **18/18 checks passed.**

What that exercised, all of it real: the startup check against `api.github.com`, the asset
match, the 83MB download, the size check, the unpack, the version verification, the detached
swap, the rollback copy, and the relaunch.

The proof that `data/` came through untouched is the port. The throwaway copy was configured
to listen on **7333** in its own `data/config.json`, a value that appears nowhere in the
release archive. After the swap the app came back **on 7333, under its own profile name**,
with a canary file still in `data/` -- so the folder cannot have been replaced by the one
from the archive. The rollback copy held 1.2.9 and contained no `data/` directory, and
`data/update.log` recorded `OK: updated to 1.3.0`.

The test is `scratchpad/update-e2e.mjs`; it is not in the repository because it downloads
83MB and needs a packaged build, but the shape is worth repeating after any change to the
swap: **copy a package, lower its version, let it update itself, then check that a value
that exists only in `data/` survived.**

### What the first real update got wrong: 400MB of leftovers

Shipped in 1.3.0 and found by running it. An update left **two whole copies of the app**
on a 628MB install:

| | |
|---|---|
| the app | ~203MB |
| `.rollback-<stamp>` beside it | ~203MB, kept for **7 days** |
| `data/update/<version>` | ~203MB, **never cleaned up at all** |

The rollback was noticed; the staged tree was not, because it hides inside `data/` where it
reads as user data.

- **The rollback now goes as soon as the new build is in place and its manifest reads back.**
  It exists for the window between "old files moved aside" and "new files all copied in" --
  a crash in there is the only thing it protects against, and that window has closed by then.
  Keeping ~200MB at rest to insure against a risk that has passed is not a trade worth
  making, and the way back from a *bad* release is to download the previous one, which is
  public. The mid-swap safety is unchanged: an interrupted update still leaves both halves.
- **The staged tree cannot be deleted by the swap**, because the swap is *running from it*
  and on Windows its own `node.exe` is locked for as long as it lives. So the app that comes
  back afterwards does it: `pruneUpdateLeftovers` runs at startup, clears `data/update/` and
  any `.rollback-*` still present, and prints how much it reclaimed.
- `data/update.log` is kept -- it is a *file* beside that directory, and the record of what
  the last update did.

This also means **upgrading from 1.3.0 tidies up after 1.3.0**, which is what makes the
fix reach installs that already have the leftovers.

**Verified by the first real update between two releases (2026-09-11).** A genuine,
untouched 1.3.0 package updated itself to the published 1.4.0 -- no version faked this time
-- and passed **19/19**: no `.rollback-` folder afterwards, `data/update/` swept by the
relaunched app, `data/` intact, and the install **238MB** where 1.3.0's own update had left
it at 628MB. The log shows the rollback created and removed within one second.

**One thing that remains true:** a **1.2.0** install cannot use the button, because it has
no `scripts/apply-update.mjs` inside it to run. v1.3.0 is the first build that can be
updated *from*, so 1.2.0 users must download 1.3.0 by hand once.

---

## 5.17 — osu! parity: header, Scores, medals, badges

**Status: done.** Eight requests arrived together; seven are this entry, the rename is 5.18.

### Decisions

- **The tab icon is drawn here, and says "home".** The old one was a pink ring written
  inline in `index.html` in the commit that rebuilt the page (43109ca) -- one `<circle>`, not
  taken from anywhere, but a pink ring is also the core of osu!'s own logo, which is why it
  looked familiar. The new one is `web/favicon.svg`, a white house on osu!'s `#ff66ab`: local
  without reading as "offline" or broken. It is a file rather than a data URI so it can be
  swapped by dropping in another; the HTML export inlines it. **An XML comment may not
  contain `--`** -- the first draft did, rendered as nothing, and the UI check only asked
  whether the file was *served*. It now decodes it.
- **Header figures are osu-web's `detail-stats.tsx`**: Medals, pp, Total Play Time, in a
  four-column grid with play time spanning two (`value-display--plain-wide`). Ranked
  Beatmaps and bonus pp moved into the pp figure's hover title rather than disappearing.
- **The medal count is account-wide** (`user_achievements.length` on osu!), so it does not
  change with the mode tab, unlike the section below it. Counted by slug, so a rank medal
  reached in two modes is one medal.
- **Total Play Time is osu!'s rule, not a formula of our own.** Read from
  osu-queue-score-statistics: `PlayTimeProcessor` (runs on failed scores too) adds
  `PlayValidityHelper.GetPlayLength` = `min(total_length / rate, ended_at - started_at)`.
  Scores have no start time, so they count `length / rate` -- which *is* the minimum for a
  completed map. Incomplete plays have both ends in lazer's log; `started_at` was parsed
  already and simply never stored, so it now is. Older incomplete rows count nothing rather
  than a guess. Lengths are read lazily from the `.osu` into `beatmaps.length_ms`.
- **"Scores" and "Pinned Scores"** are osu-web's `extra.top_ranks.title` and `.pinned.title`.
  The section id stays `top_ranks`, because saved section orders refer to it.
- **Medals: icons only, osu-web's layout.** One `medals-group` titled *Skill & Dedication*
  (the only group this app can award from), a `medals-group__medals` row per `ordering`
  (combo 0, plays 1, rank 2, hits 3, pass 4, fc 5 -- rank moved to its real place), badges
  70px wide at osu!'s 110:118, 10px/20px gaps, locked at 25% opacity and desaturated. The
  progress bars and every line of text are gone.
- **The hover card is `qtip--achievement` + `tooltip-achievement`**: 200px, 32px radius on
  b6, grouping, then icon (72px), name (24px) and description on b5, then `Achieved on
  <date>` (moment's `ll`) or `Locked` at half opacity; a 56x20 tip; 200ms show and hide
  delays, and it stays open while hovered (`hide.fixed`). One shared `#medalTooltip` in
  window coordinates, like `#playMenu`, flipping below when there is no room above. osu!'s
  achieved-count and rarity lines are left out -- there is no population to count.
- **Rank medals have no date to announce.** They are computed once from the current total,
  so `achievedAt` is just the latest play; `dated: false` keeps them out of Recent, and the
  card says "from the estimated rank" rather than a borrowed date.
- **Recent uses osu!'s wording** (`events.achievement`: unlocked the "…" medal!) and its
  28x22 icon column, kept on every row so text lines up. A toast announces a medal unlocked
  while the page is open -- only against what the page already saw in that mode, so opening
  the page never announces old medals.
- **Network sharing is removed, not just hidden.** `shareOnNetwork`, `localAddresses`, the
  dialog block and its CSS are gone; `loadConfig` drops the key via `RETIRED_KEYS`. The
  per-request loopback check stays and now has no off switch.
- **Badge lettering is sized for the fallback face.** osu! uses Venera, which is not
  shipped; the fallback is narrower and lighter, so osu!'s own sizes read small. Grades go
  11 -> 12.5 (weight 900), letters about a fifth darker, and the gold/silver letters get a
  faint dark edge; mod acronyms 28 -> 34 units (0.4em -> ~0.49em, three-letter ones stay at
  28) and a touch darker; the level number is osu-web's `@font-size--large`, 20px.

### What was checked

`npm run check` (212 tests, new `test/play-time.test.ts` and medal-ordering/Recent/count
tests), and `npm run ui` at **177/177** including a real hover that reads the card, its
width, its placement and that it closes. Screenshots of each region were looked at, which
is what caught the favicon.

---

## 5.18 — Rename to osu! local profiles

**Status: done** -- released as 1.5.0 (2026-09-11). The local checkout folder and its
Claude memory directory were renamed to `Desktop\osu! local profiles` by the user
afterwards. **The user wants this to be the only name anywhere**: after 1.6.0 the previous
name was removed from the code, the docs, and every GitHub release -- titles, notes and
download files. Do not reintroduce it, not even as a compatibility alias.

### Decisions

- **For 1.5.0 and 1.6.0, older installs were bridged, and then deliberately not.**
  Renaming a GitHub repository redirects its old URLs, the API included, and `fetch`
  follows the redirect -- so a 1.3.0 or 1.4.x install still finds the newest release. What
  it cannot find is the file: those versions ask for an archive under the app's previous
  name, exactly. So 1.5.0 and 1.6.0 were published with the same archive under both names,
  and a real 1.4.0 install updated itself to 1.5.0 that way (below). **At the user's request
  the duplicates were then deleted and the compatibility code removed**, accepting the cost:
  a 1.3.0 or 1.4.x install is no longer offered updates and must download a newer version
  once by hand. 1.5.0 and later look for `osu-local-profiles-<version>-<target>.zip` and
  are unaffected.
- **Do not create a new repository at the previous name.** The redirect is still what lets
  anything pointing at the old URL find this one.
- **The archives of 1.0.0-1.4.0 still say the previous name inside** -- their top folder and
  their launcher are what those builds shipped. Their download files and release titles were
  renamed; their contents were not rebuilt, and their notes describe the launcher without
  naming the file.
- **What cannot be renamed for the user**: an existing install's own folder (it is the
  running app, and `data/` is inside it), and any shortcut they made to the launcher, which
  an update replaces.
- **Prose** that used the previous name as a noun for what the app makes now says "local
  profile", and "new profile" where it meant a brand-new player (the rank-curve notes).
  "Erase and start fresh" is a verb and stays. The first profile's default name is
  `Local Profile`; existing profiles keep theirs.

### How it was finished, and verified

1. `gh repo rename osu-local-profiles`, then `git remote set-url origin
   https://github.com/jonathant09/osu-local-profiles.git`. Straight after the rename, the
   exact request a 1.4.0 install makes -- the old repository path, its own user agent --
   answered **200 via redirect** with the latest release.
2. CI went red on macOS only, **twice in a row**, and not because of the rename:
   `a play appended to the live log is picked up` appended the instant its watcher started,
   and the first `fs.watch` in a process is when libuv starts macOS's FSEvents thread. The
   previous commit, re-run on the same day's runners, was green -- so the suite's timing had
   shifted enough to lose a race that test had always been running. Fixed in the test
   (f18c350); the app reads by byte offset and is not exposed. **Green on all three after.**
3. **The bridge, end to end, 14/14.** The genuine 1.4.0 release, unzipped untouched, was
   given port 7334, the profile name `Bridge Canary` and a canary file -- all only in its
   own `data/`. It found 1.5.0, offered it, installed it, and came back as 1.5.0 on 7334
   under `Bridge Canary` with the canary intact, `Start osu! local profiles.bat` in place of
   its old launcher, no `.rollback-` folder, and `data/update.log` recording the update and
   the relaunch. The harness is `scratchpad/bridge-e2e.mjs`, not in the repository for the
   same reason as 5.16's: it downloads 83MB and needs a published release. A first run
   indexes ~63k beatmap files before it listens, so give it minutes, not seconds.
4. **After 1.6.0, the scrub**: the duplicate archives on 1.5.0 and 1.6.0 deleted; the
   single archives of 1.0.0-1.4.0 renamed; every release title and every set of notes
   rewritten and checked to contain no trace of the previous name.

---

## 5.19 — Open in browser on start, and a menu toggle

**Status: done** -- released as 1.6.0 (2026-09-11). A genuine 1.5.0 install updated itself
to the published 1.6.0 with the button, **14/14**: back on its own port and profile name,
canary in `data/` intact, `openBrowser` read from its own config, no rollback left.

Asked for as a new feature: launching the app should open the page in the default browser,
with an option in the Options menu, on by default.

### What it turned out to be

**The feature already existed and had never worked on Windows.** `openBrowser` in
`src/main.ts` spawned `cmd /c start "" <url>`, and `config.openBrowser` defaulted to true.
But Node quotes spawn arguments by the C runtime's rules, so the empty title `""` reached
`cmd` as `"\"\""`. `cmd` does not treat a backslash as an escape: `start` read a title of
`\` and then tried to run a program called `\""`, and the URL never opened. Shown directly
by having `cmd` echo what it received -- `start "\"\"" http://localhost:7272` before,
`start "" http://localhost:7272` after. Roadmap 5.10 had recorded "`openBrowser` already
branches correctly"; it branched correctly and then failed on the one platform verified.

### Decisions

- **`src/browser.ts` builds the command as a pure function of the platform**, the
  `clients/detect.ts` pattern, so `test/browser.test.ts` pins the Windows line from any OS.
  Windows passes `windowsVerbatimArguments` and escapes `&` and `^`, the two URL
  characters `cmd` would act on.
- **Verified against a real browser, not just the command line**: a throwaway local server,
  the app's own `openBrowser`, and a URL containing `&`; the default browser requested it.
- **The toggle is install-level, stored in `config.json`, not a profile setting.** It
  decides what happens before any profile is on screen. This is the one place the page
  writes `config.json`, which 5.1 deliberately avoided, so it goes through a narrow door:
  `POST /api/app-config` accepts exactly `openBrowser` as a boolean and nothing else, and
  the write re-reads the file first so a hand edit made while the app runs survives.
  `startServer` takes an `appConfig` get/set pair so tests never touch a real config file.
- **It sits in the Options menu itself as a switch**, not in Settings, whose dialog says
  everything in it belongs to the current profile. The menu stays open when it is pressed,
  so the switch visibly flips.
- **1.6.0, not a replacement 1.5.0.** The updater only offers a *higher* version, so an
  install already on 1.5.0 would never have received a changed 1.5.0 -- and replacing the
  published archive would have swapped the build verified end to end for one that was not.

---

## 5.20 — Beatmaps section: Favorite Beatmaps

**Status: done** -- released as 1.7.0 (2026-09-11). A genuine 1.6.0 install updated itself
to the published 1.7.0 with the button, **15/15**, including its existing database serving
the new Favorite Beatmaps tables.

**Goal.** osu!'s **Beatmaps** section with its **Favorite Beatmaps** subsection: osu-web's
beatmapset card (cover strip, faded cover behind the info, title, artist, mapper, status
pill, a coloured dot per difficulty per mode, explicit / featured artist / spotlight badges,
a difficulty popup on hovering the dots, and a heart + download strip on hovering the card),
6 cards at first, then 50, then 50 more at a time. Scores and Recent Plays rows gain
**Favorite this beatmap** in their menu.

### Established before building

- **osu-web, read rather than guessed** (sparse checkout now also takes
  `resources/js/beatmapset-panel`, `resources/js/utils` and `resources/lang/en`):
  `beatmapset-panel/index.tsx` + `.less` (100px card on desktop, 10px radius, b2 panel,
  a 90px `list` cover strip, the `card` cover behind a b2 -> b2/0.8 gradient that becomes
  b4 on hover, a 10px b3 menu strip that widens to 30px on hover, stats row hidden until
  hover); `beatmaps-popup.tsx` (below the card, 2px h1 outline round card + popup, 100ms
  show / 500ms hide); `difficulty-badge`; `beatmapset-status--panel`; `beatmapset-badge`;
  `page-extra__beatmapsets` (two columns on desktop, so osu!'s "3 rows" is 6 cards).
- **The difficulty colour** is `getDiffColour`: an 11-stop ramp (0.1 -> 9 stars,
  `#4290FB` ... `#000000`) interpolated in gamma-2.2 RGB, `#AAAAAA` below 0.1; text is
  black below 6.5 stars and `#F6F05C` above.
- **Status and badge colours** are osu-web's palette: a hue per name (lime 90, pink 333,
  blue 200, orange 45, darkorange 20, green 125) at fixed saturation/lightness steps
  (1 = 100%/70%, 2 = 80%/60%); status text is b3, graveyard is b1 on black.
- **lazer's `online.db`** lists every difficulty of a set (`osu_beatmaps` with filenames,
  so versions), its mapper (`users`), status and dates -- but no star ratings, modes, or
  explicit / featured artist / spotlight flags.
- **`osu.ppy.sh/beatmapsets/<id>` embeds `json-beatmapset`** with all of it: per-difficulty
  `difficulty_rating`, `mode`, `version`; `nsfw`, `spotlight`, `track_id` (featured
  artist); `status`, counts, dates, `covers`. Verified with one request against set 8495.

### Decisions

- **Favourites are per profile**, as osu!'s are per account, and are this app's own: nothing
  is written to osu!. Stored as `favorite_beatmapsets(profile_id, beatmapset_id,
  favorited_at)`; deleting a profile takes them with it; resetting a profile keeps them,
  as it keeps its settings -- they are curation, not tracked plays.
- **One request, when the button is pressed**, the `osu-web.ts` rule: favouriting fetches
  that set's page once and caches the trimmed JSON in `beatmapset_details` (shared across
  profiles). Nothing is fetched on a timer or on page view. If osu.ppy.sh cannot be reached
  the favourite is still saved and the card is built from local data -- `online.db`, the
  beatmap cache and the profile's own scores (whose star ratings are osu!'s own) -- and the
  next favourite action retries a few missing ones.
- **Covers stay remote** (`assets.ppy.sh`), as Most Played's do: a failed request leaves
  the panel colour, and the card is complete without them.
- **Only beatmaps with a beatmapset id can be favourited** -- a never-submitted map has no
  card to show and nothing to link to, so the menu does not offer it.
- **Wording is the user's**: "Favorite Beatmaps" / "Favorite this beatmap" (osu-web says
  "Favourite"). The card's own labels (status, "mapped by", badges) follow osu-web.
- **Left out on purpose**: hype and nomination counts, and osu-web's mobile expand button
  (touch shows the menu instead). "Open in osu!" was weighed and declined by the user:
  lazer turns `osu://b/<id>` (osu-web's own link format, forwarded to the running game by
  its `OsuSchemeLinkIPCChannel`) into its beatmap *info overlay*, not song select, and
  nothing short of scripting input into the client would reach song select.
- **Audio preview and video/storyboard icons, added after.** osu-web's `osu-audio` player
  (sparse checkout now also takes `resources/js/core/osu-audio`): one clip at a time, at the
  `audio_volume` default of 0.45; pressing the playing card or the clip ending stops it; the
  card carries `data-audio-state` and `--progress`. The clip is osu!'s own
  `b.ppy.sh/preview/<id>.mp3` -- measured at ~100KB and ~10s, served with a week's browser
  cache -- fetched only when played; nothing is stored. As on osu!, an Explicit set gets no
  play button (`showAudio`). The ring is `circular-progress--beatmapset-panel`: 50px, a 0.1em
  highlight-coloured border, drawn here as a masked conic gradient. Video and storyboard are
  the page JSON's own booleans; details cached before they were kept count as stale, and are
  refreshed by the same few-per-favourite-action retry, reading as unknown (no icon) until
  then. Playing the full song from the local install was ruled out: lazer names its files by
  hash, resolvable only through its Realm database, which this project does not read.

### What was checked

- `test/favorites.test.ts`: per-profile favourites, paging order, osu!'s details shared by
  profiles, the local fallback (a DT score's star rating is *not* taken as the difficulty's;
  an HD one is), profile deletion, `extractBeatmapset` against a saved page shape, the
  difficulty colour ramp, grouping, and escaping in the card.
- `npm run ui`: the heading, six cards at most before "show more", 100px cards, the popup
  opening under the card at its width and closing after the pointer leaves, the menu strip
  showing, **the rows fitting the card** (the first build overflowed: the page's 1.5 line
  height makes five rows taller than 100px, so the card sets 1.25), and the row menus
  offering Favorite/Unfavorite -- only that, on an unfinished play.
- Real sets favourited on this machine all fetched their details from osu.ppy.sh, and
  screenshots of the section at rest, hovered and with the popup open were compared against
  osu!'s own card.

---

## 5.21 — View Details (score card) and Download Replay

**Status:** done -- released as 1.8.0 (2026-09-11).

**Goal.** Two entries from osu-web's score menu (`components/play-detail-menu.tsx`), in its
order after Pin: **View Details**, osu!'s score page (`osu.ppy.sh/scores/<id>`), and
**Download Replay**, the score's `.osr` saved by the browser.

### Established before building

- **osu-web, read rather than guessed** (sparse checkout now also takes
  `resources/js/scores-show` and `resources/js/scores`): `main.tsx` (beatmap strip, info
  band, stats band), `info.tsx` (cover under b6/0.75; tower, dial, player, buttons),
  `dial.tsx` (200px; inner ring r68-73 split at the grade cutoffs in rank colours; outer
  r75-100 filled with the accuracy in a blue-1 -> lime-1 gradient, rest b6; grade at 50px in
  `@font-grade` with a c1 glow), `tower.tsx` (SS..D, reached grade bright, below it 0.4,
  above it 0.1 and greyscale), `player.tsx` (22px mods, 70px/300 total score, `Played by` /
  `Submitted on` / `Played on`), `buttons.tsx` (`btn-osu-big--rounded` Download Replay and a
  35px menu circle), `stats.tsx` (360px user card; Accuracy / Max Combo / pp, then the
  judgements, then `value/maximum` rows shown only when the maximum is above 0).
- **`utils/score-helper.ts`** supplies the statistics mapping per ruleset (`slider end` is
  `small_tick_hit + slider_tail_hit`), the grade cutoffs (`current` and `legacy`, citing the
  ppy/osu processors), and `displayAccuracy = min(accuracy, the grade's upper cutoff)` -- so an
  A with 97.99% fills the ring only to 95%. Accuracy is floored to 4 decimals, as osu! shows it.
- **A stable score shows a big letter, not the dial** (`legacy_score_id != null`). Verified
  on the user's own stable score on osu.ppy.sh, screenshotted for reference.
- **The score page is hue 200**: osu-web's `section_to_hue_map` puts scores under *beatmaps*.
- **osu-web names a download `solo-replay-<mode>_<beatmap>_<scoreid>.osr`** and serves it as
  `application/x-osu-replay` (`ScoresController::download`).
- **lazer names an exported replay** `<user> playing <artist> - <title> (<mapper>)
  [<version>] (<yyyy-MM-dd_HH-mm>).osr`, local time, invalid filename characters stripped
  (`LegacyScoreExporter`, `GetDisplayTitle`, `GetValidFilename` in ppy/osu).
- **The file in lazer's store is the `.osr` byte for byte**, so it can be served as it is.

### Decisions

- **A card over the profile, not a new page.** The user leaned that way, and it keeps the
  page exactly where it was -- scroll position, expanded sections -- which a navigation would
  lose. Closed by the X, Escape, or a click on the backdrop beside it.
- **Re-hued to 200 through `.hue-scope`.** A custom property that refers to `--base-hue` is
  resolved where it is declared, so the b/h/l tokens are now declared on `:root, .hue-scope`
  and the card sets its own hue. osu-web's named palette (`--hsl-blue-1`, `--hsl-lime-1`, ...)
  is added to `tokens.css` for the dial and the judgement colours.
- **Global Rank and "Watched" are left out**, per the project's offline convention and the
  user's own suggestion: both come from osu!'s leaderboards. The user card's online dot says
  whether the profile is tracking, since a local profile has no presence.
- **The filename is lazer's export name, not osu-web's.** osu-web's needs an online score id,
  which most local scores lack (offline, or stable). The player is the profile's name.
- **Download Replay is offered when a replay was recorded** (`replay_path`), and the file's
  existence is checked when it is asked for. The page sends a HEAD first and shows a toast if
  the file is gone, because a failed download is otherwise reported only in the browser's
  download list. The route takes a score id, never a path, and only serves this profile's
  visible scores.
- **The difficulty badge is the difficulty's own rating**, never a modded score's: osu!'s from
  a favourited set's cached details, else any score on it whose mods leave the rating alone
  (`ratingNeutral`, shared with Favorite Beatmaps), else no badge.
- **Full combo** uses the medals' definition (`max_combo >= beatmap_max_combo`), so the lime
  combo and the FC medals cannot disagree; unknown when the beatmap's maximum is.
- **A stable score's statistics** are derived from its six counters with lazer's own mapping
  per ruleset (`legacyStatistics`); it has no maxima, so, as on osu!, only the judgements show.
- **The stable grade letter is drawn**, not copied: osu-web's `legacy-ranking-*.png` is
  stable's skin artwork. F keeps the dial, since osu-web has no F letter.
- **The card's own menu** is the same shared `#playMenu`, minus View Details, Download Replay
  and Move up/down. Pinning from it refreshes the card; removing the score closes it.
- **pp in the card explains itself exactly as the row does** -- `ppNotes` in `sections.js` is
  now shared, so the `*` and the uncounted grey cannot drift between the two.

### What was checked

- `test/score-details.test.ts` (10 tests): legacy statistics per ruleset, the statistics
  mapping against a real lazer score's JSON, dial clamping and cutoffs, escaping in the card,
  the download button only when the file exists, stable letter vs dial, the detail's fields,
  the difficulty-rating fallbacks, the filename and its RFC 5987 header, and the routes over
  HTTP -- detail, HEAD, the bytes themselves, and 404s.
- `npm run ui`: **215/215**, 14 new -- the card hidden on load, the menu offering both items,
  the card opening at <= 1000px with a 200px dial and 32x16 tower badges, the hue measured
  against a probe, its own menu without the two items, Escape closing the menu before the
  card, backdrop click and the X, and the replay answering HEAD.
- A real browser download from both the row menu and the card's button: the file arrived as
  `Tangy playing Taylor Swift - Cruel Summer (funny) [Seolv's Hard] (2026-09-10_20-36).osr`,
  **SHA-256 identical to the file in lazer's store**.
- Screenshots of a lazer score, a simulated stable SS, all eight stable letters, and the card
  at phone width, compared with the real score page.

---

## 5.22 — The floating audio player, and pause that resumes

**Status:** done -- released as 1.8.0 (2026-09-11).

**Goal.** osu-web's bar in the bottom-right corner while a Favorite Beatmaps preview plays:
previous / play-pause / next, the clip's progress, the time, the volume slider (and mute),
and autoplay. And pausing as osu! pauses: pressing a playing card pauses it, and pressing it
again carries on from there instead of starting over.

### Established before building

- **`core/osu-audio/main.ts`** is the whole behaviour: one `Audio`; `onClickPlay` toggles when
  the pressed card is the current one and loads otherwise; `load` rewinds and plays;
  `togglePlay` pauses or resumes in place; `ended` stops (rewinds) and, with `audio_autoplay`,
  loads the next; `setState` shows the bar while loading or playing and hides it **4000ms**
  after anything else. Seeking lands on release, and a seek to 100% goes to `duration - 0.01`.
  The volume follows the pointer. `volumeIcon`: muted, silent (0), quiet (< 0.4), normal.
- **Previous / next** walk the players inside the nearest `.js-audio--group`. On the profile
  that is `page-extra__beatmapsets` -- the favourites list -- so they go card to card in page
  order, and a card with no play button (Explicit) is not a stop.
- **`audio-player.less`**: 40px, max 520px, b2, `margin-left: auto` in a fixed full-width
  strip; 40px below the window at opacity 0 until visible, 120ms. Buttons c1 -> l1 on hover,
  14px (play 16px); prev/next at 0.5 and inert with nowhere to go. Bars 2px on b6, 6px with a
  14px h1 head while hovered or dragged, a 10px/5px invisible hit area; volume 50px. Times
  12px tabular, total in c2, `--:--` until the duration is known. Autoplay at 0.5 unless on.
- **`time-format.ts`**: the format follows the clip's length -- `0:07` under ten minutes.
- **A paused card is a plain card**: `play-button` and the dark play area key on `loading`
  and `playing` only, so paused shows play again; its ring keeps its place under hover.
- **Guests' audio preferences live in localStorage** on osu-web; there is no account here.

### Decisions

- **Volume, mute and autoplay are kept in the browser's localStorage**, not profile settings:
  they are about the speakers in front of you, as osu-web treats them for a visitor, and the
  page must work with them missing (defaults 45%, unmuted, autoplay off).
- **The clip keeps playing if its card disappears** (unfavourited, or paged away), as osu!'s
  does -- the bar still controls it; previous / next are dimmed until it is back in the list.
- **Pointer events** replace osu-web's mouse/touch pair, one path for both.
- **The toast moves up** above the bar while it is showing: both live in the bottom-right.
- The icons are drawn for this page, like every other icon here (Font Awesome is not shipped),
  and sized to Font Awesome's fixed 1.25em width so the bar spaces out as osu!'s does.

### What was checked

- `npm run ui` **226/226**, 15 audio checks replacing the old 4: hidden until played; plays;
  ring moves; bar in the bottom-right at 520x40; `m:ss / m:ss`; previous dimmed on the first
  card; pressing the card pauses **and keeps its place**; pressing again carries on from it;
  the bar's button pauses; the volume slider sets, shows "quiet" and persists; mute; next
  plays the next card and clears the first; the bar gone four seconds after pausing.
- In a real browser, separately: a seek to 90% landed at 0:09, the clip ended, and autoplay
  started the next card; Previous went back.
- `audioTime` against osu-web's four formats in `test/favorites.test.ts`.
- A zoomed screenshot of the bar compared with the user's own screenshot of osu!'s.

---

## 5.23 — Score links, score pages and score screenshots

**Status:** done -- released as 1.8.0 (2026-09-11).

**Goal.** From a score's View Details card, **Copy link** to a local address -- the
equivalent of `osu.ppy.sh/scores/<id>` -- that opens the score on a page of its own; and on
both the pop-up and that page, **Save screenshot** and **Copy screenshot** of the card.

### Decisions

- **The address is `/scores/<id>`**, osu!'s own shape, using the database's score id. Ids are
  unique across profiles, as osu!'s are across the site, so no profile is named in it.
- **The link outlives a profile switch.** The read-only score endpoints (`/api/scores/<id>`,
  its replay and its screenshot) answer as the profile that *owns* the score (`scoreOwner`),
  using that profile's settings, name, avatar and banner -- `/api/image/*` takes `?profile=`
  for that. Changing things stays with the active profile, so the page offers Pin only when
  the score is the active profile's (`owner.active`).
- **One page for every id**: the server maps `/scores/<digits>` to `web/score.html`, which
  reads the id from its own address. It carries osu-web's HeaderV4 title for the score page,
  "performance", a link back to the profile, the card, and the card's menu. Its title is
  osu-web's `:username on :title [:version]`. The whole page is hue 200, as osu!'s is.
- **The screenshot is rendered server-side by the installed Chrome/Edge**, the profile PNG's
  mechanism, from `/scores/<id>?export=1` (the page with its header and buttons off). A
  browser-side capture was ruled out: the cover is on `assets.ppy.sh`, and a cross-origin
  image cannot be read back out of a canvas, so the picture would lose the art -- and it would
  need a library this project does not ship. `capture()` gained `selector`, which sets the
  viewport to exactly the width asked for (a window of 1000px lost 18px to its frame) and
  crops to the element: the card comes out at osu!'s **1000px**, nothing around it.
- **Captures are queued.** Each one starts a throwaway browser on the same debugging port, so
  two at once (Save then Copy) would collide; the profile PNG shares the queue.
- **Copying the image hands the clipboard a promise** (`new ClipboardItem({'image/png':
  promise})`), so the copy still belongs to the click even though the render takes seconds.
  A browser without image clipboard support is told to use Save instead. Copy link falls
  back to `execCommand('copy')`.
- **The PNG is named like the replay** (lazer's export name, `.png`), so the two sort together.
- **Sharing lives in the card's menu only**, pop-up and page -- the row menu is unchanged, as
  asked. `web/js/score-share.js` holds all four actions for both.

### What was checked

- `test/score-details.test.ts`: the page route, a non-digit id refused, the owner and replay
  still answering after `setActiveProfile` moves to another profile (`active: false`), and a
  removed score's page, detail and screenshot all 404.
- `npm run ui` **228/228**: the card's menu has the three items and the link serves the page.
- In a real browser with clipboard permission, from the page *and* the pop-up: Copy link put
  `http://localhost:7272/scores/42` on the clipboard, Copy screenshot a **1000x529 PNG**, Save
  screenshot a file named like the replay; the row menu showed none of them. The profile's
  own PNG still renders after the `capture()` change. The page checked at phone width.

---

## 5.24 — Performance and cleanup pass

**Status:** done -- released as 1.8.0 (2026-09-11).

**Goal.** Review the whole codebase for redundancy, dead weight and speed, without touching
anything that exists for macOS, Linux or osu!stable.

### Measured first

A synthetic profile of 20,000 scores on 3,000 beatmaps plus 6,000 unfinished plays, timing
each piece of `/api/profile`. **About one second per request, every request** -- including
every "show more", every live score and every mode switch, since the page re-asks for the
whole profile each time. The pp history was 311ms of it, stats 146ms (play time 104ms of
that), medals 87ms and the header's medal total another 76ms.

### What changed

- **Aggregates are cached until the database changes** (`remember` in `src/http/server.ts`).
  The stamp is `total_changes()` (every write on the app's one connection) plus
  `data_version` (commits from another connection, e.g. `reingest.mjs`), so nothing has to
  remember to invalidate it. Stamped *after* computing, because a first read of a beatmap's
  length is itself a write. Recent Plays is not cached: it reads a few rows through an index.
- **The pp history keeps the per-beatmap bests sorted as they change** instead of re-sorting
  all of them for every day of history. Verified **deep-equal** to the old output on a
  randomised 20,000-score profile full of tied values.
- **Play time parses each distinct mod list once**, and fills beatmap lengths without
  gathering every beatmap the profile has played on every request.
- **The medal total reuses the mode already computed** instead of computing it twice.
- **Result**, same benchmark through the real endpoint: 1144 / 1008 / 1012 / 979ms before
  (first load, again, show more, show more) -> **548 / 8 / 9 / 20ms**, and a write correctly
  brings back one full recompute. A (profile, mode, time) index was measured and **not**
  added: within noise, and it would cost every insert.
- **Dead code**: `dayLabel`; four CSS rules nothing renders; 24 unused design tokens, including
  `--mod-*`, a second copy of the mod colour table whose real home is `badges.js`; five
  unused imports; the `snapshots` table, which nothing ever wrote -- dropped on open by
  `RETIRED_TABLES` (always empty, and an older build recreates its own).
- **One copy of the page plumbing**: `web/js/ui.js` holds `postJson`, `downloadBlob`,
  `toast` and `hint`, replacing 15 hand-written POSTs, four identical hint functions and two
  toasts; `countryName` moved to `format.js` from its two copies.
- **Packaging**: the LZMA codec lists `@types/node` as a runtime dependency, so 2.4MB of
  TypeScript declarations -- 85% of the copied dependency -- shipped in every release. Now
  copied without its nested `node_modules` (231KB, round-trip verified), and the page's
  test-only `.d.ts` files are left out.

### Looked at and left alone

- The startup index walk of the file store: ~0.45s warm. Skipping directories by mtime would
  be faster and would be wrong for osu!stable's `Songs`, which changes in place.
- No timers or polling exist beyond an SSE keep-alive.
- Everything platform- or stable-specific: detection, Wine paths, the pp helper's pruning,
  the `cmd` quoting, `fs.watch` path resolution.
- `scripts/check-replays.mjs` is referenced nowhere but is the tool behind the corpus
  findings in `CLAUDE.md`, and is not shipped.

### What was checked

`npm run check` 249/249 (a new test that the cache follows writes from this connection and
another); `npm run ui` 228/228 against the real database; the replay download and the
copy/save screenshot flows re-run end to end in a real browser.

### Released as 1.8.0, and the update verified (2026-09-11)

5.21-5.24 shipped together as **1.8.0**, published after CI was green on all three platforms
for the release commit. The package is 201MB unpacked / 83MB zipped; its `node_modules` is
227KB (2.8MB in 1.7.0).

**A genuine 1.7.0 release updated itself to 1.8.0 with its own button.** The 1.7.0 zip was
downloaded from GitHub, given port 7336, the profile name `Update Canary` and a canary file
-- all only in its `data/` -- started, found 1.8.0, and was told to apply it. It came back as
**1.8.0 on 7336 under `Update Canary`**, the canary intact, no `.rollback-` folder, no
`data/update/`, `data/update.log` recording the swap, removal of the rollback and the
relaunch, and the new `/scores/<id>` page served.

**It also found a launcher bug present in every release.** The relaunched app was running
on `C:\Program Files\nodejs\node.exe`, not the bundled runtime: the `.bat` said `node.exe`
with no path, and the shell it was started from had NoDefaultCurrentDirectoryInExePath set,
which stops `cmd` looking in the current folder. Reproduced directly -- the old launcher ran
the system Node, `.\node.exe` ran the bundled one -- and fixed in `scripts/package-files.mjs`,
with the test that claimed "not one from PATH" now actually checking it on Windows. Not in
1.8.0; released on its own as **1.8.1** the same day, because the updater replaces the
launcher on every update and so reaches everyone who presses the button.
