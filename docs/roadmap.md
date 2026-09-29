# Roadmap

Every feature since 1.0.0, numbered in the order it was taken on. Code comments cite entries
by number ("roadmap 5.66"), so numbers are never reused or renumbered. Each entry keeps the
decisions and findings that still explain the code; the step-by-step plans and test logs they
were written with are gone, and git history has them.

Search this file for the entry you need rather than reading it whole. Update an entry's
status when the work changes it, and write down any decision you make, so the next session
does not have to make it again.

| #    | Feature                                                   | Status |
| ---- | --------------------------------------------------------- | ------ |
| 5.0  | Retire `prompt.txt`, keep the reference links             | done   |
| 5.1  | Settings store and Settings dialog                        | done   |
| 5.2  | Include pp for unranked mods                              | done   |
| 5.3  | Include pp for unranked beatmaps                          | done   |
| 5.4  | Score actions: pin, reorder, remove                       | done   |
| 5.5  | Editable identity and a linked osu! account               | done   |
| 5.6  | me! section                                               | done   |
| 5.7  | Draggable section order                                   | done   |
| 5.8  | Medals                                                    | done   |
| 5.9  | Share: screenshot and standalone HTML                     | done   |
| 5.10 | macOS and Linux support                                   | in progress |
| 5.11 | Incomplete plays (fails, quits, retries)                  | done   |
| 5.12 | Incomplete plays on osu!stable                            | answered: not possible |
| 5.13 | Paged sections and osu!'s own charts                      | done   |
| 5.14 | The osu-web fidelity kit                                  | done   |
| 5.15 | Scrollable dialogs, footer, dismissible warning           | done   |
| 5.16 | One-click update from GitHub releases                     | done   |
| 5.17 | osu! parity: header, Scores, medals, badges               | done   |
| 5.18 | Rename to osu! local profiles                             | done   |
| 5.19 | Open in browser on start                                  | done   |
| 5.20 | Favorite Beatmaps                                         | done   |
| 5.21 | View Details and Download Replay                          | done   |
| 5.22 | Floating audio player                                     | done   |
| 5.23 | Score links, score pages and screenshots                  | done   |
| 5.24 | Performance and cleanup pass                              | done   |
| 5.25 | Beatmap index in the background                           | done   |
| 5.26 | pp breakdown and calculator version                       | done   |
| 5.27 | Mod Introduction medals                                   | done   |
| 5.28 | Recent Plays as a section; Recent becomes Milestones      | done   |
| 5.29 | Release builds for macOS and Linux                        | done   |
| 5.30 | Split `web/js/main.js`                                    | done   |
| 5.31 | Sessions                                                  | todo   |
| 5.32 | Goals and challenges                                      | todo   |
| 5.33 | A page for each beatmap                                   | todo   |
| 5.34 | me! editor with osu!'s BBCode toolbar                     | done   |
| 5.35 | Favourites: import, reminder, shared across profiles      | done   |
| 5.36 | Import from an osu! profile                               | done   |
| 5.37 | Delete removed scores permanently                         | done   |
| 5.38 | An interactive HTML export                                | done   |
| 5.39 | osu!stable scores carry the Classic mod                   | done   |
| 5.40 | Lazer and classic scoring                                 | done   |
| 5.41 | An osu!stable-only install counts pp                      | done   |
| 5.42 | Play tracking filter                                      | done   |
| 5.43 | The launcher says when the folder is incomplete           | done   |
| 5.44 | Trimming the pp helper                                    | rejected |
| 5.45 | Plays osu! could not submit                               | done   |
| 5.46 | An update brings the app back where it can be stopped     | done   |
| 5.47 | Remove an unfinished play                                 | done   |
| 5.48 | Quit from the page, and a tray launcher                   | done   |
| 5.49 | Live tracking starts at the launch                        | done   |
| 5.50 | Import best performances and pinned scores                | done   |
| 5.51 | Replays other people set are not your plays               | done   |
| 5.52 | An import can ignore the play tracking filter             | done   |
| 5.53 | Find osu! wherever it is installed                        | done   |
| 5.54 | Every language osu! is offered in                         | in progress |
| 5.55 | Beatmap metadata in its original language                 | done   |
| 5.56 | Importing plays set while the app was closed              | done   |
| 5.57 | AGPL-3.0, and osu-web's own artwork                       | done   |
| 5.58 | McOsu                                                     | done   |
| 5.59 | Unranked mods and beatmaps count by default               | done   |
| 5.60 | A smaller pp helper, proven identical                     | done   |
| 5.61 | Plays not tracked, and Track anyway                       | done   |
| 5.62 | Import past plays over a range, or everything             | done   |
| 5.63 | Import replay files                                       | done   |
| 5.64 | Scores from their osu! link, and entered by hand          | done   |
| 5.65 | Checking for updates while the app runs                   | done   |
| 5.66 | Updates easier to see, and optionally automatic           | done   |
| 5.67 | How much show more shows                                  | done   |
| 5.68 | osu!'s development client                                 | done   |
| 5.69 | A release is its four zips again                          | done   |
| 5.70 | pp from the player's own osu! source                      | done   |
| 5.71 | Export to a spreadsheet                                   | done   |
| 5.72 | The mode switcher's icons                                 | done   |
| 5.73 | A name osu! changed is still yours                        | done   |
| 5.74 | Beatmap rules replace the filter's keywords               | done   |

## Constraints on every item

These come from `CLAUDE.md`, and nothing below may break them:

- No native modules in the Node process.
- No API polling. Detection is local, and the app works with no credentials and no network.
- No scan-and-import at startup unless the profile asked for it (5.56).
- pp comes only from osu!'s own code. A setting may change which mods are handed to osu!'s
  calculator, but the app never computes pp itself.
- TypeScript runs unbuilt: no `enum`, parameter properties or decorators.
- Anything that changes what a stored score means needs an entry in `ADDED_COLUMNS`, because
  `schema.sql` is only `CREATE TABLE IF NOT EXISTS`.
- Development and packaged builds keep separate `data/` folders. Don't alternate between them
  while testing a data change.

---

## 5.0 - Retire `prompt.txt`, keep the reference links

**Status:** done

The original brief was replaced by the README, `CLAUDE.md` and `docs/`. Its reference links,
including osu!'s API etiquette that explains why nothing polls, moved to
`docs/reference-links.md`.

## 5.1 - Settings store and Settings dialog

**Status:** done

- Settings live in the database (`profile_settings`, one row per key, so a new key needs no
  migration), not in `config.json`. `config.json` is what the app needs to boot, and the page
  must not be able to corrupt it.
- Everything is per profile, including how scores count, so one profile can be a strict fresh
  account and another a relax profile. Install-wide exceptions came later (5.19, 5.55).
- Unknown keys are ignored and defaults fill in, as `loadConfig` does.

## 5.2 - Include pp for unranked mods

**Status:** done (1.1.0; defaults changed in 5.59)

- osu!'s difficulty calculator is Relax-aware, not only the performance calculator. On real
  replays:

  | mods | as played | with the mod removed |
  | ---- | --------- | -------------------- |
  | RX   | 6.26★ / 110.93pp | 7.83★ / 238.54pp |
  | AP   | 3.14★ / 57.44pp  | 4.45★ / 101.09pp |

  Both are genuine osu! output, more than twice apart. The mod-removed figure flatters the
  play, since relax reaches accuracy and combo the player couldn't by hand.
- So both are stored (`pp`/`stars` and `pp_nomod`/`stars_nomod`) and a second setting picks
  one. Switching never needs a recompute.
- pp is calculated at ingest for every score with a local `.osu`, and whether it counts is
  decided at query time (`countsSql()`), so flipping a setting is instant.
- A customised rate (DT at 1.45x, HT at 0.5x) used to be stored as ranked because only the
  acronym was checked. Fixed here. Which mods are ranked later moved to osu! itself (5.17).
- Old scores without pp are filled in by an explicit recompute, never automatically.

## 5.3 - Include pp for unranked beatmaps

**Status:** done (1.1.0)

Same machinery as 5.2 (`map_status` plus the query-time predicate), offered as a set of
statuses rather than one switch: loved, qualified, pending, WIP, graveyarded and never
submitted are different things. A never-submitted map has no `online.db` row but can still be
priced from its `.osu`.

## 5.4 - Score actions: pin, reorder, remove

**Status:** done (1.1.0)

- **Remove is a hide** (`hidden_at`), never a `DELETE`. A deleted row would come straight
  back on the next ingest with nothing to recognise it by, and a mistake has to be undoable.
  Every query filters it through `visibleSql()`.
- Pins are per mode and don't need to be in the top 100. Reorder by drag or by Move up/down
  in the menu, so the drag is never the only way.

## 5.5 - Editable identity and a linked osu! account

**Status:** done (1.1.0)

- No OAuth. `osu.ppy.sh/users/<name>` redirects to the id and embeds the public user object
  as `data-initial-data`, the same data the API's `/users/{user}` returns. So there is no
  client id, no secret, nothing to register.
- Fetched images are copied into `data/`, so the page stays complete offline.
- The name osu! is signed in with (stable's `osu!.<user>.cfg`, lazer's config) only prefills
  the form. It is never applied without the user confirming.

## 5.6 - me! section

**Status:** done (1.1.0; replaced by BBCode in 5.34)

Started as plain text with line breaks and autolinked URLs. URLs are found in the raw text
and each escaped on its own: escaping first turns a typed quote into an entity the URL pattern
runs through.

## 5.7 - Draggable section order

**Status:** done (1.1.0)

The order is an array of section ids in settings. On load, unknown ids are dropped and missing
ones inserted after the section they follow by default (`reconcileSectionOrder` in
`web/js/sections.js`). Appending them at the end, as first written, put Beatmaps below a
Medals section the user had moved to the bottom (fixed in 5.20).

## 5.8 - Medals

**Status:** done (1.1.0)

- Derived from stored scores on every request, never stored as awards, so a reingest or a
  settings change can't leave a stale medal. The date is the first score that satisfied it.
- Names, icons and thresholds come from osu!'s published list via
  `scripts/build-medal-table.mjs`. That is how it came out that combo and play-count medals
  are osu!standard only, the other modes have hit-count medals, and star tiers go to 10 in
  standard and 8 elsewhere.
- A full combo needs the beatmap's maximum combo (`beatmap_max_combo`), because lazer can
  drop slider ends without breaking combo. Scores stored without it are "unknown", never
  guessed.
- Rank medals use the estimated rank curve, and say so.

## 5.9 - Share: screenshot and standalone HTML

**Status:** done (1.1.0)

- The screenshot drives a Chrome or Edge already on the machine over CDP. A bundled browser
  would dwarf the app.
- The HTML export serialises the page itself rather than rendering sections on the server, so
  it can't drift from the live page. (5.38 made it interactive.)
- A third option, the live page on the local network, was removed in 5.17 at the user's
  request.

## 5.10 - macOS and Linux support

**Status:** in progress. Written and green on CI on all three platforms; never run against a
real osu! install on macOS or Linux.

What was built:

- Detection takes a `DetectEnvironment` (platform, home, env), so the paths it looks in are a
  pure function and testable from Windows. `os.homedir()` replaced `$HOME` (unset, it looked in
  a folder called `undefined`), and `XDG_DATA_HOME` is honoured.
- osu!stable under Wine: Wineskin bundles, plain and `WINEPREFIX` prefixes, CrossOver bottles,
  and osu-winello, whose own record of the install path is read. A missing prefix is normal,
  never an error.
- `installRoots` in `config.json` works. It had been documented and named in the "no osu!
  found" message, and nothing read it.
- The pp helper's pruning matches by base name across `.dll`/`.dylib`/`.so` and warns when it
  prunes nothing. The old `.dll` list would have silently shipped a 273MB helper, BASS
  included, on the other platforms.
- Packaging writes a `.command` on macOS (a `.sh` opens in a text editor) and `start.sh` on
  Linux, both executable, with a README for that platform. The text lives in
  `scripts/package-files.mjs` as pure functions so tests can read it. Building for another OS
  is refused.
- Browser discovery for screenshots and `npm run ui` searches `PATH` too.
- `--check-only` reports both "osu! found?" and "pp calculator starts?" instead of stopping at
  the first.
- CI runs on Windows, Ubuntu and macOS. Its first run caught a Windows-only crash: `fs.watch`
  on a non-canonical path (a runner's `TEMP` is an 8.3 short name) aborts the process. Check CI
  after pushing.

Still needs a real machine:

1. `npm run check:app` against an actual osu! install on macOS and on Linux.
2. A packaged build unzipped and started fresh, especially that the executable bit survives.
3. `npm run ui` on each.
4. The file watcher on a real lazer store on Linux. Recursive `fs.watch` there is one inotify
   watch per directory, about 4,000 for lazer's store, and a low `max_user_watches` fails with
   `ENOSPC`. `explainWatchError` says what that means, but nobody has checked whether the
   default limit is enough.
5. osu!stable under a real Wine wrapper. Every path in `wineStableCandidates` comes from
   documentation, not a machine.

## 5.11 - Incomplete plays (fails, quits and retries)

**Status:** done (1.2.0)

What osu! counts, from ppy/osu: `SubmittingPlayer.submitScore` submits on fail, quit or retry,
with no minimum object count. A play counts when a score token was issued, at least one
non-miss judgement landed, and total score is above zero. Quitting before hitting anything is
the only discard (`No hits registered, skipping score submission`).

What lazer keeps: `Player.prepareAndImportScoreAsync` imports a score only when the map was
completed and passed, or when the fail screen's Save replay is pressed. So a solo fail, a quit
or a retry leaves no replay. Multiplayer suppresses failing and plays to the end, which is why
every rank-F replay on this machine (22 of them) judged 100% of its map. On one real session:
54 plays started, 45 counted by osu!, 19 replays written.

Decisions:

- The source is lazer's own logs, `<lazer>/logs/<session>.runtime.log` and `.network.log`.
  No API, credentials or polling.
- A play counts when the log says `Score submission completed!`, which is exactly when osu!
  accepted it, so the play count agrees with the website without reimplementing its rules.
- A pass is recognised by the screen stack logging `suspended <Player> (waiting on
  <...>ResultsScreen)`. On the test session that fired 19 times against 19 replays. Matching
  by time against ingested scores was rejected: two attempts minutes apart are ambiguous.
- lazer's submission token is the dedupe key.
- **Stored in `incomplete_plays`, never in `scores`.** There is no accuracy, combo, mods, pp
  or score for these, and a row of zeroes in `scores` would corrupt accuracy, grades, ranked
  score, the level bar and medals.
- Counting them isn't a setting, since osu! counts them. Listing them in Recent Plays is:
  `showIncompleteInRecent` is `yes`, `collapse` (default, folds consecutive attempts on one
  map into one row) or `no`.
- `hitsPerPlay` divides by scored plays only. We don't have the hits from failed plays, so
  dividing by the full play count would bias it low.
- The log never names the ruleset, so a converted play files under the beatmap's own mode.
- lazer only. osu!stable is 5.12.

## 5.12 - Incomplete plays on osu!stable

**Status:** answered on a real osu!stable install (`b20260711.1`, 2026-09-11). Stable keeps
no usable record of a play it didn't save, so the app says so instead of guessing.

Stable doesn't save a replay for a failed play either (the feature request is still open:
<https://github.com/ppy/osu-stable-issues/issues/254>), so `Data/r/` holds passes only.

What a real install holds, measured over a normal session and then a controlled test:

- **Stable's logs say nothing about plays.** `Logs/` has `runtime.log` (OpenGL setup at
  launch), `update_success.log` and an encrypted `osu!auth.log`. None was written during play.
- **A pass writes its replay when the results screen is left.** `scores.db` recorded passes at
  3:39:25, 3:41:04 and 3:42:12, and the `.osr` files appeared 8 to 23 seconds later. That's
  stable's behaviour, and the page says so.
- **An unfinished play leaves one per-beatmap "last played" time in `osu!.db`.** A quit, a
  fail and a retry on one difficulty produced no replay, no `scores.db` change, and one new
  timestamp.

That timestamp can't count plays: three attempts wrote one time, a pass writes the same
field, it's flushed minutes late, and parsing it means a binary format that has already
changed (a parser written to the documented layout broke on this build).

**Decision:** don't count them, and say so. A dismissible note in Recent Plays and Scores,
wherever a stable install is found, says when a stable score arrives and that quits and fails
aren't counted. A count that silently misses retries would be worse than a stated gap, for
the same reason there's no fallback pp calculator. If this is ever revisited, that timestamp
is the only local source and anything built on it must be labelled as an approximation. The
API's `include_fails=1` stays refused, since it needs OAuth.

`ingestIncompletePlay` in `src/tracker/incomplete.ts` is client-agnostic, so a future source
would sit beside `src/clients/lazer-log.ts` rather than change it.

## 5.13 - Paged sections and osu!'s own charts

**Status:** done (1.2.0)

Values are read from osu-web, not eyeballed: the rank line is `@yellow` `#ffcc22` at 2px
(`line-chart.less`), the tooltip reads `Global Ranking #123` over `40 days ago`
(`rank-chart.tsx`), and Play History is a linear line reading `Plays 430` over `March 2020`
(`chart.tsx`).

- **The hover marker and tooltip are HTML over the chart, not SVG inside it.** The charts
  stretch with `preserveAspectRatio="none"` in a 0..100 space, which would turn a circle into
  an ellipse. osu-web does the same.
- Hover snaps to the nearest real point, so the readout is always a recorded value.
- **Paging is done by the server.** The page asks for a size per section and gets totals, so
  a profile with thousands of plays opens with twenty rows.
- **"Show more" needs two tests:** a page that came back short is the end, and so is
  `total <= returned`. Recent Plays counts plays but draws rows, and a collapsed run of
  retries is several plays in one row, so either test alone can leave a button that shows
  nothing.
- Scores is capped at 100, since that's all osu! weights. Switching mode resets the expansion.

## 5.14 - The osu-web fidelity kit

**Status:** done (1.3.0). Its licence decisions were replaced by 5.57.

Every "make it look more like osu!" request had cost a round trip, because the design was
being guessed from screenshots. This added a sparse, gitignored checkout of osu-web and
`docs/osu-web-fidelity.md`, which maps each region of the page to the osu-web file behind it.

- A reference checkout, not a fork. osu-web is a Laravel app needing PHP, MySQL,
  Elasticsearch and Redis; the part worth having is the LESS and TSX, readable in place.
- `ppy/osu-resources` is CC-BY-NC and can never be used. Flags come from Twemoji, which is
  where osu-resources gets them.
- Flags are vendored, since `country` can be typed with no network. The country's name comes
  from `Intl.DisplayNames` rather than a shipped table.
- The mod table is generated from osu-web's `database/mods.json` instead of hand-written.
- SS and S looked washed out because only the silver letter gradient had been implemented,
  not the gold one.

## 5.15 - Scrollable dialogs, a footer, a dismissible warning

**Status:** done (1.3.0)

- The height cap is on `.modal`, not the fixed backdrop, so a tall dialog scrolls inside
  itself instead of running off the top of the screen. `100dvh` after `100vh` for mobile.
- The footer shows the version, the one number a bug report needs.
- Dismissing the "pp not comparable with osu!" warning is per profile, and hides the sentence,
  not the fact: affected rows keep their `*`, and a setting turns the warning back on.

## 5.16 - One-click update from GitHub releases

**Status:** done (1.3.0). Later changes in 5.46, 5.48, 5.65, 5.66 and 5.69.

- **In place, with a rollback copy.** Outgoing files are moved to `.rollback-<stamp>/`, so a
  swap that dies halfway leaves both halves on disk.
- **`data/` is stepped around.** It sits inside the install, so the swap works on every other
  top-level entry and skips it.
- Nothing is swapped until the new build is verified: download size, unpacked tree shape, and
  the version in its `package.json`.
- A source checkout refuses. Both a `.git` folder and a missing bundled runtime block it,
  since either test alone can be fooled.
- **The swap runs from the new build with its own runtime.** On Windows the running `node.exe`
  is locked. So every release installs itself with its own updater, which is why
  `scripts/apply-update.mjs` ships in every package.
- The zip reader is our own (`src/update/zip.ts`) rather than Windows-only `tar.exe`. It
  refuses zip64 and any path that escapes the target, and accepts the backslash separators
  our own packager writes.
- A failed check shows nothing. No network, a rate limit or a private repo are all normal.

Verified for real: a packaged 1.3.0 with its version lowered to 1.2.9 updated itself from
the public release, and came back on a port set only in its own `data/config.json`, which
proves `data/` survived. Repeat that shape after any change to the swap: copy a package,
lower its version, let it update, check a value that exists only in `data/`.

The first real update (1.3.0) left two extra 200MB copies: the rollback folder, and the
staged build in `data/update/`, which nothing cleaned up. Since 1.4.0 the swap deletes the
rollback once the new build reads back, and `pruneUpdateLeftovers` clears the staged tree at
the next start (the swap can't delete the folder it's running from). `data/update.log` stays.

1.2.0 has no `apply-update.mjs`, so it can't update itself; 1.3.0 is the first version that
can be updated from.

## 5.17 - osu! parity: header, Scores, medals, badges

**Status:** done (1.5.0)

- The tab icon is `web/favicon.svg`, a white house on osu!'s `#ff66ab`. The old pink ring
  looked too much like osu!'s logo. (An XML comment may not contain `--`: the first draft
  rendered as nothing.)
- Header figures follow osu-web's `detail-stats.tsx`: Medals, pp, Total Play Time. Ranked
  Beatmaps and bonus pp moved into the pp figure's tooltip.
- The medal count is account-wide, as on osu!, counted by slug.
- **Total Play Time is osu!'s rule** (`PlayValidityHelper.GetPlayLength`):
  `min(total_length / rate, ended_at - started_at)`. A finished score has no start time, but
  for a completed map the length is the smaller side anyway. Incomplete plays have both ends
  in lazer's log. Rows from before `started_at` was stored count nothing.
- "Scores" and "Pinned Scores" are osu-web's titles. The section id stays `top_ranks`,
  because saved orders refer to it.
- Medals show icons only, in osu-web's layout, with osu!'s hover card
  (`tooltip-achievement`) as one shared `#medalTooltip`. Rank medals have no real date, so
  they stay out of the Recent feed (`dated: false`).
- **Network sharing was removed, not hidden.** `shareOnNetwork` is dropped by `loadConfig`
  (`RETIRED_KEYS`), and the per-request loopback check has no off switch.

## 5.18 - Rename to osu! local profiles

**Status:** done (1.5.0)

**This is the only name anywhere.** After 1.6.0 the previous name was removed from the code,
the docs and every GitHub release: titles, notes and download files. Don't reintroduce it,
not even as a compatibility alias.

- 1.5.0 and 1.6.0 were published under both names so 1.3.0 and 1.4.x could update across
  the rename. The user then had the duplicates deleted, accepting that those versions must
  download once by hand.
- Don't create a new repository at the old name. GitHub's redirect from it is what still
  lets old links find this one.
- The archives of 1.0.0 to 1.4.0 still carry the old name inside. Their files and titles were
  renamed, their contents weren't rebuilt.
- The first profile's default name is `Local Profile`.

## 5.19 - Open in browser on start

**Status:** done (1.6.0)

The feature already existed and had never worked on Windows. Node quotes spawn arguments by
C runtime rules, so `start ""` reached `cmd` as `start "\"\""`, and the URL never opened.
`src/browser.ts` now builds the command as a pure function of the platform, with
`windowsVerbatimArguments` and `&`/`^` escaped, and was checked against a real browser.

`openBrowser` is an install setting in `config.json`, not a profile setting, because it acts
before any profile is on screen. `POST /api/app-config` is a narrow door that accepts only
known keys, and re-reads the file first so a hand edit made while the app runs survives.

## 5.20 - Favorite Beatmaps

**Status:** done (1.7.0)

osu-web's beatmapset card, read from `beatmapset-panel/index.tsx` and its LESS, with the
difficulty popup (`beatmaps-popup.tsx`), `difficulty-badge`, status pill and badges. The
difficulty colour is osu-web's `getDiffColour` ramp. `osu.ppy.sh/beatmapsets/<id>` embeds
`json-beatmapset` with everything the card needs; lazer's `online.db` has the difficulties,
mapper and status but no star ratings, modes or badges.

- Favourites are this app's own and never written to osu!. Per profile at first (shared by
  default since 5.35). A reset keeps them, since they're curation, not tracked plays.
- **One request, when the button is pressed.** Favouriting fetches that set's page once and
  caches it in `beatmapset_details`. Offline, the favourite is still saved and the card is
  built from `online.db`, the beatmap cache and the profile's own scores.
- Covers stay remote on `assets.ppy.sh`, like Most Played's.
- Only beatmaps with a set id can be favourited.
- The wording "Favorite" (not osu-web's "Favourite") is the user's choice.
- "Open in osu!" was declined by the user: `osu://b/<id>` opens lazer's info overlay, not
  song select.
- The audio preview is osu!'s own `b.ppy.sh/preview/<id>.mp3` (about 100KB), fetched only
  when played and never stored. An Explicit set gets no play button, as on osu!. Playing the
  full song from the local install would need lazer's Realm database, which the app doesn't
  read.

## 5.21 - View Details and Download Replay

**Status:** done (1.8.0)

osu!'s score page, read from osu-web's `scores-show/*.tsx` and `utils/score-helper.ts`
(statistics per ruleset, grade cutoffs, and `displayAccuracy`, which caps the dial at the
grade's upper cutoff).

- A card over the profile, not a new page, so the page stays exactly where it was.
- Re-hued to 200 through `.hue-scope`, because osu-web puts scores under beatmaps. A custom
  property that refers to `--base-hue` is resolved where it's declared, so the tokens are
  declared on `:root, .hue-scope`.
- Global Rank and "Watched" are left out: both are facts about osu!'s leaderboards.
- A stable score shows the big grade letter instead of the dial, as osu-web does
  (`legacy_score_id != null`). Its statistics come from its six counters via lazer's own
  mapping (`legacyStatistics`).
- **The download filename is lazer's export name**, `<user> playing <artist> - <title>
  (<mapper>) [<version>] (<yyyy-MM-dd_HH-mm>).osr`. osu-web's needs an online score id, which
  most local scores lack. The file is served byte for byte; the route takes a score id, never a
  path, and the page sends a HEAD first so a missing file becomes a toast, not a failed
  download.
- The difficulty badge is the difficulty's own rating, never a modded score's.
- Full combo uses the medals' definition, so the card and the FC medals can't disagree.
- `ppNotes` in `sections.js` is shared by the row and the card.

## 5.22 - Floating audio player

**Status:** done (1.8.0)

osu-web's audio bar (`core/osu-audio/main.ts`, `audio-player.less`): one `Audio`, pressing
the playing card pauses and pressing again resumes, previous and next walk the favourites in
page order, and the bar hides 4 seconds after playback stops.

- Volume, mute and autoplay live in the browser's localStorage, as osu-web does for a guest.
  They're about the speakers in front of you, not the profile.
- The clip keeps playing if its card disappears, as on osu!.
- Pointer events replace osu-web's mouse/touch pair. The toast moves up while the bar shows.

## 5.23 - Score links, score pages and screenshots

**Status:** done (1.8.0)

- The address is `/scores/<id>`, osu!'s own shape. Ids are unique across profiles, so no
  profile is named in it.
- **A link outlives a profile switch.** The read-only score endpoints answer as the profile
  that owns the score (`scoreOwner`), with its settings and pictures. Changes stay with the
  active profile, so Pin is offered only on the active profile's scores.
- The server maps `/scores/<digits>` to `web/score.html`, which reads the id from its own
  address.
- **The screenshot is rendered by the installed Chrome or Edge**, from `/scores/<id>?export=1`
  cropped to the card at 1000px. A capture in the browser can't include the cover, since a
  cross-origin image can't be read back from a canvas. Captures are queued, because each
  starts a browser on the same debugging port.
- Copy screenshot hands the clipboard a promise (`ClipboardItem({'image/png': promise})`), so
  the copy still belongs to the click while the render takes seconds.

## 5.24 - Performance and cleanup pass

**Status:** done (1.8.0)

On a synthetic 20,000-score profile, every `/api/profile` request took about a second.

- **Aggregates are cached until the database changes** (`remember` in `src/http/server.ts`).
  The stamp is `total_changes()` plus `data_version` (commits from another connection, such
  as `reingest.mjs`), taken after computing, because the first read of a beatmap's length is
  itself a write. Result: 1144ms then 1008ms per request before, 548ms then 8ms after.
- The pp history keeps per-beatmap bests sorted as they change, verified deep-equal to the
  old output.
- A (profile, mode, time) index was measured and not added: within noise, and it costs every
  insert.
- The unused `snapshots` table is dropped on open (`RETIRED_TABLES`). Page plumbing
  (`postJson`, `toast`, `hint`) moved to `web/js/ui.js`. The LZMA codec's 2.4MB of TypeScript
  declarations no longer ship.
- Left alone: the startup walk of the file store (about 0.45s warm; skipping folders by mtime
  would miss stable's `Songs`, which changes in place) and everything platform-specific.

Updating 1.7.0 to 1.8.0 for real found a launcher bug in every release: the `.bat` ran
`node.exe` with no path, and with `NoDefaultCurrentDirectoryInExePath` set, `cmd` found the
system Node instead. Fixed in 1.8.1 with `.\node.exe`.

## 5.25 - Beatmap index in the background

**Status:** done (1.9.0)

A replay names its beatmap by MD5 and lazer stores files by SHA-256, so without lazer's Realm
database the store has to be read once. On this machine that's 63,515 files, 8.7s warm and
about 140s cold, and it ran before the server started, so a first launch was a page that
wouldn't load (99 seconds, measured).

- The page and tracker start first; the index runs beside them in 25ms slices, committing
  before each pause, since the connection is shared.
- It counts files first so the page can show a real percentage.
- **Plays wait for it rather than resolving early.** `resolve()` caches a miss, so a score
  resolved mid-index would never get pp. `Tracker.indexBeatmaps` puts the index at the head of
  the ingest queue before the watchers start, and every ingest path runs through that queue.
- The notice shows on a first run, or when a re-check takes over 1.5s.
- osu!stable: only `*.osu` files are opened. lazer's files have no extension, so they're
  sniffed.

First page answer went from 99 seconds to 129ms.

## 5.26 - pp breakdown and calculator version

**Status:** done (1.10.0)

- The parts are osu!'s own (`GetAttributesForDisplay()` minus the total): Aim, Speed,
  Accuracy, Flashlight and Reading in standard; Difficulty and Accuracy in taiko; Difficulty
  in mania; nothing in catch.
- Shown on the card only, at the user's request.
- Stored per score (`pp_parts`, `pp_nomod_parts`, `pp_version`), because the parts must belong
  to the pp beside them. A score without parts is recalculated from its replay the first time
  its card opens, never shown a newer calculator's split.
- The version is the `ppy.osu.Game` package's, reported on the helper's ready line.

## 5.27 - Mod Introduction medals

**Status:** done (1.10.0)

Most of osu!'s medals are beatmap packs, specific maps or hidden conditions a local profile
can't judge. Mod Introduction is fully decidable from scores, so it's the only other group,
at the user's request. Rules come from ppy/osu-queue-score-statistics: the mod alone at its
defaults, System mods and Classic ignored, Spun Out in standard only, Nightcore and Daycore
are not DT and HT, passes only, and Conversion and Fun are lazer-only mod types.

## 5.28 - Recent Plays as a section; Recent becomes Milestones

**Status:** done (1.10.0)

Recent Plays got its own section under me!, and osu!'s "Recent" feed became Milestones under
Historical, both at the user's request. The ids `recent` (now Milestones) and `top_ranks`
stay, since saved orders name them. A saved order that exactly matches an earlier default is
treated as never arranged (`RETIRED_DEFAULT_ORDERS`).

## 5.29 - Release builds for macOS and Linux

**Status:** done (1.10.0)

`.github/workflows/release.yml` packages on each platform's runner on a `v*` tag. A manual run
with no tag is a dry run. `test/release-notes.test.ts` pins the asset names to the updater's
`assetNameFor`. Found on the way: `src/update/zip.ts` dropped Unix permission bits, so an
update on macOS or Linux would have unpacked a runtime that couldn't run.

## 5.30 - Split `web/js/main.js`

**Status:** done (1.10.0)

The self-contained parts became modules (`medals.js`, `beatmaps-popup.js`,
`audio-player.js`). The rest shares page state (mode, profile, settings, paging) too closely
to split without just passing that state around, so it stays.

The page has no framework on purpose: it's data in, DOM out, and an SSE event triggers a
refetch of the affected block. That's plenty for a page that changes when a play lands, and it
keeps `npm run dev` instant with no build step.

## 5.31 - Sessions

**Status:** todo. The user is still deciding how it should work.

Plays grouped into play sessions, with what changed over each (pp, accuracy, plays). How a
session is bounded and shown is open.

## 5.32 - Goals and challenges

**Status:** todo, for later at the user's request.

Built-in goals or challenges a player can take on and track locally.

## 5.33 - A page for each beatmap

**Status:** todo, for later at the user's request.

A page per beatmap with every play this profile has on it, as the score page does for a
score.

## 5.34 - me! editor with osu!'s BBCode toolbar

**Status:** done (1.11.0)

Reverses 5.6's plain text, at the user's request.

- The toolbar matches osu-web's `bbcode-editor.tsx`, and each button wraps the selection as
  osu-web's does.
- **Our own renderer, `web/js/bbcode.js`.** Tag meanings are osu!'s, but no code comes from
  osu-web's PHP. Input is escaped first and never parsed as HTML, every tag emitted is ours,
  and every attribute is checked. Imported text can be anyone's.
- Pasted or dropped images are stored per profile in `data/about-images/` and referenced as
  `[img]/api/about-image/...[/img]`.
- me! grows to 60,000 characters, since osu! pages are often long.

## 5.35 - Favourites: import, reminder, shared across profiles

**Status:** done (1.11.0)

- Import from any account: `/users/<id>/beatmapsets/favourite` answers JSON with no
  credentials, with the same fields as `json-beatmapset`, so one request per 100 favourites
  fills both the list and the cards.
- A reminder shows while the list is empty, with Don't show again.
- **Shared across profiles by default** (`sharedFavorites` in `config.json`, an install
  choice). Switching on merges every profile's list into the shared one; switching off copies
  it into every profile.

## 5.36 - Import from an osu! profile

**Status:** done (1.11.0)

One dialog: look up an account and choose what to copy (avatar, banner, flag and me! ticked;
favourites not). Importing links the profile to that account. Every request comes from a
button press. Later, at the user's request, a brand-new install opens it once as an optional
welcome that any dismissal ends for good (`src/welcome.ts`); upgraded installs never see it.

## 5.37 - Delete removed scores permanently

**Status:** done (1.11.0)

A red minus per removed score, and Delete all permanently. The row goes, but its
`dedupe_key` is written to `deleted_scores` first, which ingest and Import past plays both
check, so the removal sticks. A reset clears those too.

## 5.38 - An interactive HTML export

**Status:** done (1.11.0)

The saved page is the real page: its CSS, its modules bundled by `web/js/bundle.js`, and a
snapshot of the API answers served by a stand-in `fetch`. Everything that reads works;
anything that would change the profile is hidden. One file, so any static host can serve it.

## 5.39 - osu!stable scores carry the Classic mod

**Status:** done (1.12.0)

osu! adds CL to every legacy score before scoring it, and osu-web lists a stable play as
`DTCL`. `withClassicMod` in `src/calc/pp.ts` adds it where a row or card is built.
`mods_json` keeps exactly what the player chose, and medals, play time and eligibility must
keep reading that.

## 5.40 - Lazer and classic scoring

**Status:** done (1.12.0)

- Both numbers come from osu!: the helper returns `GetDisplayScore(Standardised)`,
  `GetDisplayScore(Classic)` and `LegacyTotalScore` beside the pp.
- Which number classic shows is osu-web's rule (`score-helper.ts`): stable's recorded score if
  there is one, else the classic conversion. `score_classic` stores
  `legacyTotalScore ?? classicScore`.
- Stored per score and chosen at query time (`scoreColumn`), so switching is a redraw. The
  level moves with it.

**This cost an hour, and must not happen again:** two columns added to the recompute UPDATE
without their values didn't fail. node:sqlite bound what it was given and left the rest NULL,
so `WHERE id = ?` became `WHERE id = NULL`, and a recompute "updated 45 rows" and wrote
nothing. The INSERT and UPDATE are now generated from the row object (`pricedColumns`).

## 5.41 - An osu!stable-only install counts pp

**Status:** done (1.12.0)

Only lazer ships `online.db`, the one record of whether a beatmap is ranked. A stable-only
install resolved every beatmap to `UNRESOLVED_STATUS` and counted none of them: a profile
that priced every play and showed zero pp. pp itself is fine (it needs only the `.osu`), and
titles fall back to the file's own `[Metadata]`.

**Decision:** count every beatmap and say so. With no `online.db`,
`BeatmapResolver.knowsStatus` is false and `countsSql` also counts unresolved beatmaps. The
Scores note explains, and the beatmap-status settings are dimmed. It isn't a setting: install
lazer beside stable and statuses resolve. Rejected: parsing stable's `osu!.db` (see 5.12) and
asking osu.ppy.sh per beatmap (breaks offline-first).

## 5.42 - Play tracking filter

**Status:** done (1.13.0)

Options -> Play tracking filter decides which plays are written at all. Off by default, and
every criterion starts wide open, so switching it on changes nothing until something is
narrowed. A declined play gets no `scores` or `incomplete_plays` row.

Where each criterion's facts come from, all offline:

| criterion | source | needs |
|---|---|---|
| keywords (artist, title, difficulty, mapper) | the `.osu`'s `[Metadata]` | nothing |
| mode | the replay, or the `.osu`'s `[General]` for a play with no replay | nothing |
| star rating, as played | osu!'s difficulty calculator at ingest | the pp helper |
| mods | the replay's mods as chosen (no `CL` on a stable play) | nothing |
| category | `online.db` `osu_beatmaps.approved` | osu!lazer |
| length, as played | the `.osu`'s hit objects, divided by the rate | nothing |
| date added | the `.osu` file's creation time | nothing |
| date submitted | `online.db` `osu_beatmapsets.submit_date` | osu!lazer |
| date ranked | `online.db` `osu_beatmapsets.approved_date` | osu!lazer |

- `online.db` has a second table, `osu_beatmapsets` (about 60k rows against 234k), holding
  only ranked, approved and loved sets. Any other set has no dates, so both date criteria have
  an "include beatmaps with no date on record" box, on by default. The earliest `submit_date`
  (2007-10-06) is the sliders' floor.
- **Date added is creation time, not mtime.** Files lazer imported from stable keep mtimes
  from 2019-2021 and were created the day they were imported. Where there's no creation time,
  mtime stands in.
- Star rating and length are judged as played, mods included.
- **Mods have three states**: may be used, must be used, must not be used. A separate nomod
  chip says "no mods at all" or "never a nomod play". The dialog prints the selection as a
  sentence. Autoplay and Cinema aren't offered, since they can never be tracked.
- **A fact the filter doesn't have never rejects a play.** A quit or fail has no mods or star
  rating, so those two criteria don't judge it. Dropping it instead would make the play count
  disagree with osu!'s the moment the filter came on.
- Beatmap dates and length are filled in lazily on `beatmaps`: NULL is never looked up, 0 is
  looked up and unknowable.
- With stable and no lazer, category and both dates have no source; those sections are dimmed.
- `src/tracking-filter.ts` is the only definition. `IngestContext.filter` is optional so
  `scripts/reingest.mjs` can never use it to delete stored rows. The filter is read from
  settings on every ingest.

**5.42a, the accuracy cell (1.13.1):** `.play-detail__score-detail` had `align-items:
baseline` where osu-web's LESS says `center`, which left the accuracy 9px high in Pinned
Scores and Recent Plays. `npm run ui` measures it now.

## 5.43 - The launcher says when the folder is incomplete

**Status:** done (1.13.2)

Nothing needs installing, so a missing runtime means an incomplete download or antivirus, but
`cmd`'s "'node.exe' is not recognized" reads like a missing prerequisite. The launchers check
for the runtime and `src/main.ts`, name what's missing, say nothing needs installing, and link
to the releases. The unix launchers also spot a runtime that lost its executable bit and give
the `chmod +x`. (A `.bat` needs `exit /b` before `:incomplete`, or every successful start ends
by announcing the folder is incomplete.)

## 5.44 - Trimming the pp helper

**Status:** rejected (2026-09-12). Full trimming stays rejected; partial trimming shipped in
5.60 behind a parity check.

`PublishTrimmed` takes the helper from 113MB to 36MB and breaks it in four ways. Three are
ours and fixable (reflection-based `System.Text.Json` off by default, anonymous types losing
constructor parameter names, `Request`'s constructor removed). The fourth decides it: the
helper starts, then fails inside osu!'s own graph constructing
`Newtonsoft.Json.Converters.StringEnumConverter` on every lazer replay, the path that reads
lazer's extended block. ILLink warns about exactly this for `osu.Game`, `osu.Framework`,
`Realm`, `Newtonsoft.Json`, `AutoMapper` and `MongoDB.Bson`.

Fixing it means a root descriptor for osu!'s internals, re-verified on every osu! bump, and
the failure it guards against is a wrong number rather than a crash. That's the same reason
there's no fallback calculator. Re-measure before assuming this still holds:
`dotnet publish -p:PublishTrimmed=true -p:JsonSerializerIsReflectionEnabledByDefault=true`,
pruned with `shouldPrune`, compared against the shipped helper.

## 5.45 - Plays osu! could not submit

**Status:** done (1.14.0)

Offline or signed out, osu! counts nothing, so the unfinished plays from 5.11 went silent too.
The user asked for them anyway, kept apart from what osu! counted.

From this machine's 20 session logs: `SubmittingPlayer.submitScore` logs `No token, skipping
score submission` (94 times) just before the gameplay screen exits. Each retry is a new
`SoloPlayer#N`. The beatmap is the latest `Game-wide working beatmap updated to` line before
the screen entered. Other players (`MultiplayerPlayer`, `ReplayPlayer`, the skin editor's
`EndlessPlayer`, `DailyChallengePlayer`) are never attempts.

- **Only what lazer states.** An attempt is a `SoloPlayer` screen that logged `No token`, didn't
  reach results, and closed. A screen that had a token is never one.
- **Recorded always, counted by choice**: `incomplete_plays.unsubmitted = 1`, counted only
  through `incompleteSql(e)` when `countUnsubmittedAttempts` is on. Recording can't wait for the
  setting, because the log is only followed live.
- **On by default**, at the user's call: osu! never received these plays, so counting them
  contradicts nothing osu! shows. The Scores note mentions them only once some are recorded.
- **Matched by name**, since there's no beatmap id: `osu_files.name` is lazer's own
  `Artist - Title (Creator) [Version]`, built from each `.osu`. It matched all 59 real attempts
  (the score cache alone matched 12) and needs no `online.db`.
- It can't know whether osu! would have counted the attempt online (at least one hit), so an
  attempt quit before hitting anything is included.
- Import past plays reads the logs too (`src/tracker/log-backfill.ts`), with each source as its
  own tick box.

**Found on the way:** `.osu` parsing ended a section at the next `[` anywhere, but `[` is
ordinary inside values (`cRyo[iceeicee]`, `[CV. ...]`, an audio file named `[HD] ...`). Across
12,811 beatmaps that lost or corrupted 327 names and filed 23 beatmaps under the wrong mode.
`osuSection` ends a section at the next line beginning with `[`.

## 5.46 - An update brings the app back where it can be stopped

**Status:** done (1.14.0). Replaced by the tray launcher's restart in 5.48.

After an update on macOS and Linux, the app came back with no terminal: no TTY, output to
`/dev/null`, still tracking and holding the port, stoppable only from a process list. The
swapper had run the launcher from a detached process. On Windows the relaunched `cmd` window
stayed open at a prompt after the app stopped.

The fix: the unix launchers ran the app (rather than `exec`) and restarted it themselves after
an update (`OSU_LOCAL_PROFILES_LAUNCHER=restarts`, the app exits 75, the launcher waits for the
swapper's pid). Otherwise the swapper relaunches only somewhere visible (`relaunchPlan` in
`scripts/apply-update.mjs`) or not at all, and never starts the runtime directly. Windows
couldn't restart from the `.bat`, because `cmd` re-reads a running `.bat` by byte offset and the
swap replaces the file.

## 5.47 - Remove an unfinished play

**Status:** done (1.17.0)

Didn't finish and Not submitted rows get Remove from profile, on the same terms as a score: a
hide on `incomplete_plays.hidden_at`, which `incompleteSql` already excludes. A collapsed row
carries every attempt's id (`IncompletePlay.ids`) and removes them all; Removed scores folds
them back by shared `hidden_at`. Deleting one for good writes `incomplete:<key>` to
`deleted_scores`, prefixed so it can never match a replay.

## 5.48 - Quit from the page, and a tray launcher

**Status:** done (1.17.0)

The console window held a taskbar slot for as long as the app ran. Hiding it needed an off
switch and a way back first.

- **The page's Quit, and a second start opens the running copy's page** (found through
  `/api/app`). `/api/quit` refuses any `Origin` but the app's own page (`isOwnPage`), or a
  script on any open website could stop the app.
- **A tray launcher, not a window.** A cross-platform window means Electron, Tauri or
  Avalonia: tens of MB, and a stricter macOS refusal. Go with `fyne.io/systray` gives a 7MB
  native launcher from one codebase, and Node still loads no native modules.
- Each platform's convention: Windows notification area with no console, macOS menu bar with
  no Dock icon (`LSUIElement`), Linux StatusNotifierItem (no tray host means no icon, and
  `start.sh` with no desktop keeps the terminal).
- **The app never outlives the launcher.** Its stdin is the launcher's pipe, which closes
  however the launcher ends.
- **The launcher restarts the app after an update on every platform.** A running `.exe` can be
  renamed but not deleted on Windows (measured), and the swap renames. The swapper still
  relaunches older releases that don't restart, by starting the launcher, never the runtime.
- `start.sh` and `Start osu! local profiles.command` keep their names: 1.14 to 1.16 unix
  launchers restart by running `./<own name>` again.
- macOS translocation: a quarantined bundle opened in place runs from a random read-only copy
  with no `data/`. The launcher finds the real path, lifts the quarantine and reopens it there.

Not run on real hardware: the macOS and Linux builds, the tray menu by hand, Gatekeeper and
translocation.

## 5.49 - Live tracking starts at the launch

**Status:** done (1.18.0)

Closing the app is how people stop tracking, so a launch that caught up on the gap would
overrule that, and there'd be no way back but picking through the profile by hand.

- **One cutoff where every live play passes.** `Tracker.liveCutoff` is
  `max(profile.trackingSince, liveSince)`, with `liveSince` set by `start()`. Replays, counted
  unfinished plays and unsubmitted attempts all ingest against it. Trusting each watcher to
  start at "now" would be the same promise made twice, in two files.
- Tracking off and on again re-arms it.
- Import past plays brings its own `since` and is unaffected. The startup banner states the
  rule.
- `TrackerOptions.liveSince` exists only for tests; nothing in the app passes it.

## 5.50 - Import best performances and pinned scores

**Status:** done (1.18.0)

For a best performance set on another PC, on a map never installed here, with a replay this
machine never held. Nothing local can find it, but osu! has it.

- `/users/{id}/scores/best` and `/scores/pinned` answer JSON with no credentials.
- **200 per ruleset, not the 100 the page shows.** Offset 100 returns a full page, offset 200
  is empty. On the test account scores 100-199 were worth 34.14pp.
- All four rulesets. Unticked by default, because these are the only part of an import that
  adds plays.
- Stored with osu!'s pp (`pp_source` `osu-web`) at first; since 5.64 each is rebuilt as a
  replay and priced here.
- No star rating unless the mods can't have changed it (`RATING_NEUTRAL_MODS`), since osu!
  sends only the unmodded rating.
- **Deduplication is the hard part.** A replay keys on its hash, an import on osu!'s id, so
  `dedupe_key` can't match across them. `findExistingScore` matches any online id against both
  columns, then falls back to beatmap, exact total, max combo and a five-minute window for a
  stable replay too old to have an id.
- **Bonus pp is borrowed.** osu! awards it for a whole history, so the import stores osu!'s
  total minus the weighted sum of the same scores, landing the profile on osu!'s figure
  exactly. `computeStats` takes the larger of earned and borrowed, so real plays take over with
  nothing to clear.

Checked against the live site: total pp 7,380.07 against osu!'s 7,380.07, and a second import
added nothing.

## 5.51 - Replays other people set are not your plays

**Status:** done (1.18.0)

osu! keeps the replays you watch in the same folders as the ones you set. Measured: 2,499
replays, 88 of them by 62 other players, and a profile that read 16,109pp because its top play
was mrekk's 1,857pp Crystalia.

- **Everything fails towards yours.** A wrongly tracked play can be seen and removed; a wrongly
  refused one is gone. `ownsPlay` refuses only on positive evidence. No name, lazer's `Guest`,
  a previous name, and an unknown identity are all yours.
- **Previous usernames matter.** A stable replay carries only the name current when it was
  set.
- **An offline name can be anything**, so the name doesn't decide it. A downloaded replay is a
  score osu! put on a leaderboard, so it carries a score id; one with none can't have been
  downloaded. Measured: all 91 replays by other players had an id; 258 of the owner's did not.
- The id is read from wherever the replay keeps it: lazer writes 0 in the legacy header and the
  real id in its own block.
- Removing ones already tracked runs once per profile, only on a linked account whose previous
  names were actually fetched (`linkedNamesKnown`). Every removal is a hide.

Who counts as "you" was later changed to whoever osu! says is signed in (1.26.0, see
architecture.md "Whose replay is it?").

## 5.52 - An import can ignore the play tracking filter

**Status:** done (1.18.0)

The filter is a rule about how you play now, and an import reaches back to evenings it wasn't
written for. The only workaround was filter off, import, filter on.

- A tick box in Import past plays, on by default. Unticked, that one import runs against
  `defaultTrackingFilter()`, which permits everything.
- Re-ticked every time the dialog opens, so it never persists into live tracking.
- `applyFilter` is absent-means-true on the API, so older pages and scripts keep filtering.
- Preview and import get the same answer, and toggling the box retires an old preview.

## 5.53 - Find osu! wherever it is installed

**Status:** done (1.19.0)

Someone's osu!stable in `D:\Games\osu!\osu!` was reported as not installed. Detection knew
three drives and three folder names, and ran a search only if it found no client at all.

`src/clients/discover.ts` works in three tiers, each only if a client is still missing:

1. **What the machine already knows**: the `.osz`/`.osr` associations and uninstall entries
   in the registry, lazer's `storage.ini`, and Start Menu, taskbar and desktop shortcuts (the
   `.lnk` target read from its bytes). About 25ms.
2. **A wider guess**: every drive letter, with `Games`, `Apps`, `SteamLibrary` and similar,
   including the `<parent>\osu!\osu!` the installer makes.
3. **A bounded walk of every drive**: breadth-first, depth 5, 30,000 folders, 25 seconds,
   skipping only folders an install is never under. It stops at an install instead of
   descending. About 585ms across three drives.

- The search runs when either client is missing, and its result, including "found nothing", is
  remembered in `config.json`.
- `installScore` picks the copy you actually play among backups and practice copies: a beatmap
  database, a per-user config, recent activity, and not "backup" in the name.
- lazer's executable is also `osu!.exe`, so `stableInstall` has to turn away lazer's own folders.
- Options -> osu! folders lists what was found, takes a folder by hand, and refuses the folder
  above an install by naming the install inside it. A folder added takes effect on the next
  start, and the dialog says so.
- "No osu! installation found" no longer exits: the page is where you fix it.

## 5.54 - Every language osu! is offered in

**Status:** in progress. The machinery is done and 15 languages are translated (1.19.0); the
rest are listed but not offered.

The scope is osu-web's `available_locales`, all forty, with the same codes (`pt-br`, `zh-tw`,
`es-419`) and native names. Nothing osu! doesn't have.

- `web/js/i18n.js` holds the list, `t(key, vars)` and `useLocale`.
- **The English stays in the HTML**, with `data-i18n` naming the key that replaces it, so the
  page reads correctly before any script runs, in a saved copy, and when the fetch fails. A
  missing key falls back to English.
- Three markers: `data-i18n` for text, `data-i18n-html` for a sentence with `<b>` or `<code>`
  inside (kept whole so a translator can reorder it), `data-i18n-attr` for `title` and
  `aria-label`.
- `scripts/build-i18n.mjs` checks the page's keys, every `t('key')` in scripts and every
  translation against each other; `--write` regenerates `en.json`.
- The list exists twice (`src/i18n.ts` for the server, `web/js/i18n.js` for the page), since
  the page can't import `.ts`. `test/i18n.test.ts` pins them together.
- The language is asked at first launch, preselected from the browser, and kept in
  `config.json` and `localStorage` (config arrives after the first paint).
- **A key is always a literal first argument to `t()`**, so the checker can see it. Families
  reached by value (judgements, statuses) are small tables of literal calls.
- **A count and its noun are one whole sentence per number**, because plurals differ in more
  than an "s" in most languages.
- `format.js` passes the page's language to every `Intl` call.
- **Listed is not offered.** All forty stay in `LOCALES`, but the picker shows only those with
  `done: true`. An untranslated language would leave someone looking at an English page
  wondering what they did wrong. `build-i18n.mjs` checks `done` against the files on disk.

Still to do:

1. The other 24 translation files: ar, be, bg, ca, cs, el, es-419, fil, he, hu, id, lt, lv,
   ms, no, pt, ro, sk, sl, sr, th, tr, uk, vi. Each is one file plus `done: true`.
2. Right-to-left. `ar` and `he` set `dir="rtl"`, but no layout has been checked that way, so
   do those two last.

## 5.55 - Beatmap metadata in its original language

**Status:** done (1.20.0)

osu!'s "prefer metadata in original language": 夜に駆ける rather than Yoru ni Kakeru.

- **Both names are sent and the page chooses** (`web/js/metadata.js`), as osu-web does.
  Choosing on the server would put a display preference in `/api/profile`'s cache key and make
  a checkbox cost a round trip. `src/calc/metadata.ts` is the one definition on the server.
- **Only when different.** `artistUnicode`/`titleUnicode` are null unless they differ from the
  romanised pair, so `??` is the whole rule on the page and nearly every row carries nothing
  extra.
- `beatmaps.artist_unicode`/`title_unicode`: `''` means looked and there's none, NULL means
  never looked. `backfillOriginalMetadata` fills old rows once after the index (a setting that
  only worked on maps you happened to open would look broken), with no transaction of its own
  because the connection is shared.
- Install-level, beside the language, in `config.json` and `localStorage`. Offered in three
  places at the user's request: the welcome, the flag menu, and This install in Other settings.

## 5.56 - Importing plays set while the app was closed

**Status:** done (1.20.0)

The same decision as 5.49, made once instead of every launch, for someone who wants tracking
whether the app is open or not. **Off by default**, and that's the important half.

- **An import, not wider live tracking.** `Tracker.catchUp` calls `Tracker.backfill`, with the
  same filter, dedupe and owner check. `liveCutoff` is untouched.
- Every source, since a gap is a gap: finished plays, unfinished ones and unsubmitted attempts.
- **From when the app last ran, never further**: `kv.lastRunAt`, written at startup, shutdown
  and on a 30-minute heartbeat (slow, since every write resets `/api/profile`'s cache). A stamp
  left by a crash is older than the real shutdown, so erring early is safe; dedupe turns away
  the overlap. Floored at the profile's `trackingSince`.
- No stamp on a first launch means no catch-up, not a catch-up from an invented date.
- **Announced**, through the `caught-up` SSE event and a toast, since nobody pressed a button.
- Per profile (`importPlaysWhileClosed`), at the user's request.
- `config.json`'s dead `backfill` key was retired here so it isn't mistaken for this.

## 5.57 - AGPL-3.0, and osu-web's own artwork

**Status:** done (1.23.0)

The user's decision: relicense from MIT to **AGPL-3.0-or-later**, osu-web's licence, so the
page can use osu-web's own files. The 70 mod glyphs were the reason.

- Releases up to v1.22.0 stay MIT. MIT lets that code, and PR #1 contributed under it, continue
  under the AGPL; `THIRD-PARTY-NOTICES.md` keeps the MIT notice.
- **Vendored by a script, never by hand.** `npm run build:osu-web` copies from one osu-web commit
  into `web/osu-web/`, byte for byte, and records the commit. `.gitattributes` stops line-ending
  conversion. The acronym-to-glyph table is parsed from osu-web's `mod.less`, so new mods get
  their glyph on the next run.
- Taken: mod glyphs and badge blanks, the customised-mod cog (inlined in `badges.js`, since
  `<use href>` wouldn't survive a saved copy), GradeSmall badges, stable's `legacy-ranking-*`
  letters, and the guest avatar. `mod.less` and `mod.tsx`'s markup are ported.
- **Never, under any licence:** `ppy/osu-resources` (CC-BY-NC, a restriction the AGPL forbids),
  Torus and Venera (licensed to osu!'s website alone), and the osu!/ppy logos (trademarks,
  outside osu-web's grant). `test/osu-web-art.test.ts` fails if a logo or font is vendored.
- Pictures go through stylesheet `url()`s, as osu-web draws them. `inlineCssUrls` in
  `share-copy.js` turns each into a data URI for a saved copy (about 450KB for every glyph,
  simpler than tracing which are used).
- Obligations: `LICENSE` and the notices in every package, the licence and source named in the
  packaged README.txt, the footer links the licence, and a saved copy's header comment names the
  licence, source and artwork.

## 5.58 - McOsu

**Status:** done (1.24.0)

Asked for by a user, measured against McOsu 33.14 (Steam) and its source.

- **What McOsu leaves:** no replays and no log, only an entry in its own `scores.db` for a play
  that was finished, passed, scored above zero, and not Autoplay or AP+RX. A fail and a quit
  were played to confirm nothing is written. So McOsu, like stable, can't have incomplete plays.
- **Each play becomes a built osu!stable replay** under `data/mcosu/`, with no cursor data.
  osu!'s decoder treats it as a stable replay (Classic, classic slider accuracy). What the
  bitmask can't hold goes in the app's own block after the replay. Keyed `mcosu:<md5>:<ms>`.
  Survives deletion in McOsu. **Never offered for download.**
- **Mods as osu! would write them** (`mcosuMods`). The speed slider sets no bit, so speed comes
  from what was played; outside 0.5x-2.0x, no pp (osu! prices 2.5x as 2.0x). CS/AR/OD/HP
  overrides become Difficulty Adjust after EZ/HR, since osu! applies mods in order. Nightmare
  (stored on Cinema's bit) and the experimental mods are one app-own mod, **MC**, never shown to
  osu!'s calculator.
- **McOsu's total score** is kept only where McOsu's mod multipliers match osu!'s for the priced
  mods (`legacyTotalComparable`), and withheld otherwise (`ignoreLegacyTotalScore`). osu! uses
  the total to estimate combo breaks, and a wrong one moved a real play from 66.7 to 81.5pp.
- Found on every launch from Steam's libraries, outside `missing()`, so not having McOsu never
  costs a drive walk.
- **Scored as stable everywhere** (`scoredAsStable`). McOsu's player name is left out of the
  owner's-name vote.

Five real plays priced 42.18, 48.53, 78.65, 39.55 and 17.02pp; McOsu's own calculator said
41.10, 43.03, 73.67, 37.52 and 14.90.

## 5.59 - Unranked mods and beatmaps count by default

**Status:** done (1.24.0)

The user's decision: a new profile counts every play toward pp. A local profile is for all of
someone's playing, and the Scores note says how to narrow it.

- **New profiles only.** `pinCountingDefaults` (`src/db/index.ts`) writes the old defaults onto
  every existing profile that had stored no choice, once (`kv countingDefaultsPinned`), so
  nobody's pp moves on an update. It runs on any database opened, a restored backup included.
- Relax and Autopilot are priced as osu! scores them on new profiles (changed in 1.25.0).

## 5.60 - A smaller pp helper, proven identical

**Status:** done (1.24.0). Checked on every build, on every platform.

The helper was over half of every download (52MB of 89MB on Windows). Rewriting the calculator
was rejected for the reasons in 5.44. Instead it's made smaller two ways, each allowed only
because a check proves no answer changed.

- **`scripts/pp-parity.mjs`** (`npm run pp:parity <old> <new>`) sends two helpers the same
  requests and compares every answer as text: values, errors and the ready line. The requests
  are the app's own, built by the app's code. Unseeded Random and Target Practice are never
  sent, since osu! prices them differently on every run.
- **Partial trimming** (`SLIM_PUBLISH_ARGS`): only .NET's own libraries are trimmed; osu!'s,
  Newtonsoft, Realm and the rest stay whole. 121MB to 69MB.
- **Never-loaded natives pruned** (`SLIM_PRUNE_NATIVES`): Realm's and SQLite's engines, HTTP/3,
  debugger libraries, the alternative garbage collectors. 69MB to 58MB. Never-loaded managed
  libraries stay: the runtime won't start without anything its manifest lists, and a missing one
  inside osu! code that catches exceptions could change a result instead of failing.
- **Checked on every build.** `buildCheckedPpHelper` builds the full and slim helpers side by
  side, runs the parity check, and ships slim only if every answer matches. Otherwise it ships the
  full helper and says why, never failing the build.
- **Generated plays, not collected ones** (`scripts/pp-parity-corpus.mjs`). The first version
  used this machine's real replays, which meant private data and a 97MB upload. Now seven
  beatmaps and their stable, lazer and McOsu replays are written from a fixed seed: about 1,820
  requests in under 30 seconds, the same everywhere, nothing private. A fully trimmed helper
  fails it on the generated lazer replays. `--live` adds this machine's replays on top.
- **The `pp helper` workflow** runs the check with `--require-slim` on all four platforms
  whenever something that could change an answer changes, so a pull request hears about a break
  before a release quietly ships the full helper.

Windows download 89MB to 61MB.

## 5.61 - Plays not tracked, and Track anyway

**Status:** done (1.27.0)

A declined play used to leave a toast, a log line and a count that reset at launch, so "why is
my play missing?" had no answer a day later.

- **`declined_plays`, which no figure reads**: plays the filter declined (with the criterion),
  replays another player set (with the name), and replays that couldn't be read, from live
  tracking, imports and the launch catch-up. Skips that are the app working as meant
  (duplicates, deleted for good, before the cutoff) aren't kept.
- One row per play, newest 1,000 per profile. A play tracked by any route leaves the list and
  never comes back to it. A reset clears it.
- Laid out like Removed scores: each replay names its player, and the red minus deletes for
  good through `deleted_scores`.
- **Track anyway**, one play at a time, is an exception to "the filter's decision stands" that
  the user approved. It skips the filter, the owner check and the cutoff and nothing else, so it
  never adds a play twice. An unfinished play is written from the `Recording` stored when it was
  declined. Someone else's play asks twice.

## 5.62 - Import past plays over a range, or everything

**Status:** done (1.27.0)

- **All** imports every play osu! has kept here (`since` 0).
- **From** and **To**, each with an open-end box (Earliest, Now). A ticked end hides its date,
  so any date on screen is one the import uses.
- `until` goes through every scan, matched against the time inside the play. A replay's mtime is
  when its play ended, so it can rule a play out of a start but never out of an end.

## 5.63 - Import replay files

**Status:** done (1.27.0)

- A multi-file picker, and the dialog is a drop target. One request per file
  (`POST /api/replays`, 64MB cap), imported through `Tracker.importReplayFile` with no range or
  cutoff (choosing the file is the decision) and every other check, the filter box included.
- **A copy is kept in `data/replays/<md5>.osr`** (`src/uploaded-replays.ts`), because the chosen
  file may be gone next week. Kept only while a score or a declined play points at it, and in
  every backup.

## 5.64 - Scores from their osu! link, and entered by hand

**Status:** done (1.27.0)

For plays with no replay anywhere. pp is calculated here, repriced here after a rework with no
internet, and never re-fetched from osu!.

- **Exact, not estimated.** pp never reads cursor data, so a replay built from the score's
  numbers prices as osu! does: 175.697 against 175.6969 for a 2015 stable score with no replay,
  338.837 against 338.8372 for a lazer one. See architecture.md, "Scores with no replay".
- **Built replays** (`src/built-replays.ts`, written by the shared `src/replay-writer.ts`),
  with an app block recording their origin. `scores.origin` drives the row tag and refuses
  Download Replay.
- A beatmap that isn't installed is downloaded once, MD5-checked, and kept in `data/beatmaps/`.
- Enter by hand checks everything on the server, including the combo against osu!'s maximum
  for the map. No calculator, no entry.
- The legacy score id only works at `/scores/<ruleset>/<id>`; the bare form is a different
  player's score.
- **Best performances from an account (5.50) are rebuilt the same way.** And a better record
  of a play always replaces a worse one in place (`RecordKind`): osu!'s figures, then a built
  replay, then a replay osu! wrote. So a real replay turning up for an imported score takes its
  place, pin and all.
- The tag reads "Manually entered by hand", the user's wording.
- Fixed a leak from 5.61/5.63: an uploaded copy kept only for a declined play was left behind
  when the listing went. `releaseUploadedReplay` only ever deletes `replays/<md5>.osr`, and each
  launch sweeps orphaned copies (`pruneUploadedReplays`).

Against osu!: 361 best performances rebuilt and priced here, 336 within 0.01pp of osu!'s list,
the largest difference 0.098pp (osu! doesn't reprocess every stored score on a minor change).

## 5.65 - Checking for updates while the app runs

**Status:** done (1.27.0)

People who never close the app stayed on old versions, because the only check was at startup.

- **Daily, by the wall clock** (`keepCheckingForUpdates`, `checkDue`): looked at every 10
  minutes, due 24h after a check or 1h after a failed one. A single 24h timer doesn't count time
  asleep. One request a day to GitHub. The no-polling rule is osu!'s API guidance and still
  applies to osu!.
- The page hears live through an `update` SSE event. The tray offers it through `/api/app`'s
  `update` (`offeredVersion`). No pop-up: it would take focus from osu! mid-play.
- Installs already running an older version can't be reached by this until they restart.

## 5.66 - Updates easier to see, and optionally automatic

**Status:** done (1.27.0). Its partial downloads were withdrawn in 5.69.

- **Auto-update is off by default**, its own switch in Options (`config.autoUpdate`). It
  downloads ahead and installs at a deliberate quit or the next start, never mid-session.
  Switched off, a build it downloaded is dropped, not installed.
- **When I quit**, in the update dialog, does the same for one update.
- **Patch notes** come from the CHANGELOG through `scripts/release-notes.mjs`: each release
  page's lines before an update, `release-notes.json` in the package after one.
  `<!-- important -->` in a version's section marks it important.
- The notice at the foot of the page shows only for an update waiting 14 days or an important
  one, and stays away 7 days once dismissed.
- Tray: a dot on the icon, Update to X and restart, and What's new.
- **Metered**: Windows and Linux (NetworkManager) are asked. macOS isn't, since its answer only
  comes from Network.framework's asynchronous monitor, which couldn't be built or checked here.
- One install attempt per build (`attempts`), so a failing swap can't stop the app starting.

## 5.67 - How much show more shows

**Status:** done (1.27.0)

One row in Other settings: a number (1 to 10,000, with 25, 50 and 100 suggested) and **All at
once**, which dims the number rather than clearing it. Per profile (`showMoreRows`,
`showMoreAll`). All asks for `MAX_PAGE_ROWS`, the server's cap, raised to 10,000 and defined once
in `src/settings.ts`. Favorite Beatmaps counts rows of two cards.

## 5.68 - osu!'s development client

**Status:** done (1.27.0)

A player running osu! from source found the app tracked release lazer instead, even with
`installRoots` set. The user chose to track it beside release lazer, automatically.

From ppy/osu, checked against a Debug build:

- Folder: `osu-development` beside lazer's `osu`, or `osu-development-<n>` with
  `--debug-client-id=<n>`.
- Realm: `client_<schema version>.realm`. The number moves, so it's matched as a pattern.
  Release builds never write one, so it also identifies the folder.
- Settings: `game.dev.ini`, signed in to the development server.
- `files/`, `logs/` and `online.db` are lazer's.

It gets its own slot in `installsFrom` and `discoverInstalls` so it never displaces release
lazer, and its folders are checked on every launch, like McOsu's. `detectLocalSessions` reads
`game.dev.ini` first for it, so its plays aren't refused as someone else's.

## 5.69 - A release is its four zips again

**Status:** done (1.28.0)

1.27.0's release page had 27 files where earlier ones had 6: 5.66's partial-update files and
manifests, several of them zips that looked like the download and wouldn't run. The user chose to
drop smaller updates rather than keep them another way (ranged reads from the full zip were
offered), and to clear the 21 files from 1.27.0.

- `scripts/package.mjs` makes the full zip only. An update downloads the full zip.
- Before an update, what's new is read from the release pages themselves: one API request for
  recent releases, once per new version (`fetchRecentReleases`, `notesFromBody`).
  `releaseNotes` writes `<!-- important -->` onto an important version's page.
- 1.27.0 installs look for the parts, find none, and fall back to the full zip as designed.

## 5.70 - pp from the player's own osu! source

**Status:** done (1.28.0)

A player running osu! from source (5.68) asked for plays to be priced by their own source, for
their own pp changes and mods. Offered with two changes the user accepted: it prices **the whole
app**, and it **never falls back**.

- **Build.** `src/calc/source-helper.ts` generates the helper's project with `ProjectReference`s
  to the clone's `osu.Game` and four rulesets in place of the NuGet packages (osu-tools'
  UseLocalOsu), and publishes this app's own `Program.cs` into `data/pp-source/<version>/`.
  Packages ship `tools/PpCalculator/Program.cs` for this. Built for this machine only and pruned
  by the shipped helper's lists (`src/calc/helper-prune.ts`): 49MB, where the first attempt left
  1.3GB. `checkOsuSource` catches the likeliest mistake, osu!'s data folder.
- **Version.** A source build reports `0.0.0`, so pp is labelled `source <commit>`, plus
  `+<hash>` of every change git sees. An uncommitted formula edit changes the label, and with it
  what recalculation picks up.
- **Switching** (`src/pp-source.ts`): `Tracker.switchCalculator` swaps between ingests and
  reprices every score with a replay, including ones the release couldn't price. Back to the
  release the same way. `config.ppSource` is written only once the new helper is pricing.
- **No fallback.** A failed build or start changes nothing. At launch, a configured source with
  no working helper means no calculator at all (`startupCalculator`).
- The counting note and the rank tooltip say pp comes from the player's source.

Checked against a real clone: 20 plays priced identically by the release and the source. A copy
with the total doubled built as `source 325c8f5+0983c51` and doubled every osu!standard play's
pp exactly.

## 5.71 - Export to a spreadsheet

**Status:** done (1.28.0)

- **.csv**: the scores alone, every mode in one file with a Mode column. One file a
  double-click opens, rather than a zip of several.
- **.xlsx**: the same scores first, a sheet per mode when more than one is played, then Summary,
  Most played, Favorite beatmaps and Medals.
- Written by hand (`src/export/`), no library. The .xlsx opened cleanly in Excel 16 and openpyxl.
- In the page's language, from its own translation files (`src/export/words.ts`).
- The JSON export had left out `visibleSql`, so removed scores were in it. Fixed.

## 5.72 - The mode switcher's icons

**Status:** done (1.28.0)

- **Allowed.** The icons are four glyphs of osu-web's own icon font (`resources/fonts/extra`,
  `fa-extra-mode-*`), not osu-resources. The same font holds the osu! logo, so **the font is not
  taken**: each mode glyph is written out as its own SVG (`MODE_GLYPHS` in
  `scripts/build-osu-web-art.mjs`).
- Drawn as osu-web does (`playmode-tabs.tsx`, `game-mode.less`): 20px, pink until active or
  hovered, as a mask.
- The name shows on hover through `web/js/tooltip.js`, a port of osu-web's `tooltip-default`,
  and is each link's `aria-label`.

## 5.73 - A name osu! changed is still yours

**Status:** done (1.28.1)

On a friend's machine every live play went to Plays not tracked as "set by another player",
under their own name. osu! remembered the name typed to sign in before a rename, while every
replay since said the new one, and nothing on the computer ties the two together.

- **A play set just now is yours** (`setJustNow`, `JUST_SET_MS`). A replay arriving while
  tracking is either just set or just downloaded to watch, and the time inside it says which: a
  downloaded one carries the time it was set on osu!. Live only (`IngestContext.arrivedAt`). A
  lazer user id that differs still outweighs it. This alone fixes the report, offline.
- **"It's me"** on a refused play asks osu! once, on the press, whether the two names are one
  account (`confirmSameAccount`). On a yes, every name the account has had goes into
  `accountNames`, which joins the profile's names while one of them is signed in.
- **What was refused is judged again, not waved through** (`Tracker.retrackOwnNames`): the
  ordinary ingest with today's identity and filter. Track anyway stays the only way past the
  filter.
- osu! unreachable is an error, never a "not you".

## 5.74 - Beatmap rules replace the filter's keywords

**Status:** done (unreleased)

The keywords box matched any comma-separated term anywhere in the artist, title, difficulty name
and `Creator` joined together. It felt like a black box, and its "mapper" was the set's host, not
whoever mapped the difficulty. A mapper (Blue Dragon) wanted a profile of only his own maps, and his
guest difficulties matched only when his name happened to be in the difficulty name.

- **Rules, OR between them, AND within**, as the user proposed: each condition is a field, a test
  (*contains*, *is*, *doesn't contain*) and values, any of which will do. Other criteria stay
  separate ANDs. Up to 20 rules of 10 conditions.
- **Mapper is osu!'s own record** (`online.db` `beatmap_owners`, by user id, so under current
  names, guest difficulties and collabs included), with a fallback to the set owner and the name in
  the difficulty name or tags where there is no record. **Beatmap set owner** is `Creator`, the
  user's name for it. Measured: of 294 guest difficulties on this machine, 114 named the guest
  nowhere the keywords could see. Real misses the old box made: "[BD's Gangsta]" in Tarrasky's set
  (Blue Dragon's, missed), Kyshiro's and OnosakiHito's difficulties in Blue Dragon's sets (wrongly
  counted as his).
- **Old filters carry over exactly**, so no one's tracking changes and no alarming notice is
  needed: keywords become one rule, *Any field contains* each term, where Any field is the old
  joined text. Checked: 11 keyword filters against this machine's 590 beatmaps, 0 answers differ.
  A friendly note says so once, in the dialog and as a toast, until the filter is saved. The
  filter never re-judges stored plays anyway, so a profile could not have been wiped.
- A sentence under the rules says what they track, so the rules can be read without the controls.
- Tags and Source are read from the `.osu` once and cached on `beatmaps`; owners are read fresh
  for each play (under a millisecond each).

Still open: two cached beatmaps on this machine (Come[Back]Home's "Nevada") hold names from before
the `[` fix of 5.45 (`Creator` "Come", no difficulty name), so every field that reads them sees the
wrong name. Beatmap rows cached before that fix should be read again once.
