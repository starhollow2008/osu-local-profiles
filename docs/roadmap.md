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
| 5.8  | Medals                                        | in progress |
| 5.9  | Share: screenshot and standalone HTML         | todo   |
| 5.10 | macOS and Linux support                       | todo   |

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

**Status:** in progress

**Goal.** A Medals section mirroring the official profile's, restricted to the medals that
are actually computable from local data:

- **Combo**: 500, 750, 1000, 2000
- **Play count**: 5,000 · 15,000 · 25,000 · 50,000
- **Rank**: top 50,000 · 10,000 · 5,000 · 1,000
- **Beatmap pass** and **FC**, 1★ through 10★

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
- **Artwork**: official medal images from `assets.ppy.sh` when reachable, cached to `data/`;
  a generated SVG medal in the project's own style otherwise, so the section is never empty
  offline. Same pattern as beatmap covers today.
- Locked medals are shown greyed with their requirement, as osu! does.

**Plan.** `src/calc/medals.ts` (pure, tested against fixture score sets), the section markup,
`web/js/badges.js` gains the generated medal, and `/api/profile` returns the medal list.

**Done when.** Medals unlock at the right thresholds with the right dates, the section
renders offline, and `test/medals.test.ts` covers each family including the boundaries.

---

## 5.9 — Share: screenshot and standalone HTML

**Status:** todo

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

**Status:** todo

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
