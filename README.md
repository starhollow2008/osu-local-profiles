# osu! local profiles

Track an alternative osu! playstyle as if it were a brand new account.

osu! allows one account per person, so there is no way to find out what your rank and pp
*would* be if you switched from tablet to mouse, or from your right hand to your left. This
runs locally, watches your plays while it is open, and builds a separate profile from
scratch — starting at 0pp, unranked, level 1.

Inspired by [Sheppsu's osu-score-tracker](https://github.com/Sheppsu/osu-score-tracker).

## Status

**All four phases are done** and released as v1.0.0. Scores are tracked live, the page
matches `osu.ppy.sh`'s profile design, global rank is estimated offline, past plays can be
imported deliberately, several playstyles can be tracked side by side, and
`npm run package` produces a portable build that needs nothing installed.

**Phase 5 is released as v1.1.0**: settings, pp for unranked mods and beatmaps, pinned and
removable scores, an editable name/picture/banner, the `me!` section, rearrangeable
sections, medals, and sharing. It is planned feature by feature in
[docs/roadmap.md](docs/roadmap.md).

**v1.2.0** adds the plays osu! counts and this app could not see -- a quit, a retry or a
failed run leaves no replay, and that was over half the play count -- along with macOS and
Linux support, and a profile page that pages and charts the way osu!'s own does.

**v1.3.0** makes the page look like osu!'s rather than nearly like it -- country flags, the
gold on an SS, and mod badges drawn the way osu! draws them -- and adds a one-click update
that installs the newest release and restarts, keeping your `data/` folder untouched and the
files it replaces in a rollback copy.

**v1.4.0** stops an update from leaving copies of the app behind. 1.3.0 left two -- the
rollback folder and the unpacked download, around 400MB between them. The rollback now
lasts only as long as the update itself, and the app clears anything left over when it
starts, including what 1.3.0 left.

**v1.5.0** gives the app its name, **osu! local profiles**, and brings the page closer to
osu!'s own: Medals, pp and Total Play Time under the rank graph, a Scores section, and a
Medals section laid out as osu!'s with its hover card. Installs of 1.3.0 or 1.4.0 need to
download a newer version once by hand; from 1.5.0 the update button works as usual.

**v1.6.0** makes starting the app open the page in your browser, which it was meant to do
all along and on Windows never did, and adds **Options -> Open in browser on start** to turn
that off.

**v1.7.0** adds the **Beatmaps** section with **Favorite Beatmaps**: osu!'s own beatmap cards,
favourited from the menu on any score, with the difficulty popup, audio preview, and the
Explicit / Featured Artist / Spotlight badges. The rank graph band is osu!'s darker hue, and
Medals moves to the bottom of the page by default.

**v1.8.0** adds osu!'s score page: **View Details** on any score opens it as a card, with the
accuracy dial, grade tower and every judgement, and every score gets its own page at
`localhost:7272/scores/<number>` with **Copy link**, **Save screenshot** and **Copy
screenshot**. **Download Replay** saves a score's replay file. Favourite previews get osu!'s
audio player bar and pause where they left off, and a big profile's page is far faster.

**v1.8.1** makes the Windows launcher always start the app's own Node runtime, even on a
machine where Windows is set not to look in the app's folder for it.

**v1.9.0** opens the page straight away on a first launch: the one-time read of your osu!
folder now happens in the background, with a progress bar on the page, and anything you play
meanwhile is added, with pp, as soon as it finishes.

**v1.10.0** makes **Recent Plays** a section of its own under me!, and renames the Recent
feed **Milestones**. View Details shows a score's **pp breakdown** -- aim, speed, accuracy,
flashlight -- and which osu! release priced it; **Mod Introduction** medals arrive; and every
release now has **macOS and Linux** downloads alongside Windows.

[docs/osu-web-reference.md](docs/osu-web-reference.md) records the design system it is
built on -- osu-web's colour tokens, metrics and layout --
[docs/phase-2-handoff.md](docs/phase-2-handoff.md) covers what the page does, the gaps it
handles deliberately, and what to know before changing it, and
[docs/reference-links.md](docs/reference-links.md) lists the upstream sources all of it is
built against.

Country rank still shows `-`, on purpose; see Known gaps.

Under the rank graph sit osu!'s own three figures: **Medals** (every medal the profile
holds, across all modes), **pp**, and **Total Play Time** -- see below for how that is
counted.

The long sections -- Recent Plays, Scores, Milestones and Most Played Beatmaps -- start at
five rows with a **show more** button, expanding to 25 and then 25 at a time, as on osu!.
Both charts are hoverable: the rank graph reads out `Global Ranking #120,000` / `40 days
ago` by day, and Play History reads `Plays 430` / `March 2020` by month.

## Platform support

| Platform | State |
| -------- | ----- |
| **Windows** | Verified. Developed and used on it daily. |
| **Linux** | Green on CI (`ubuntu-latest`): typecheck, the full test suite, and a real start-up. Each release has a `linux-x64` build, packaged and started on Linux. Nobody has yet run it against an actual osu! install. |
| **macOS** | The same, on `macos-latest`, with an `osx-arm64` (Apple silicon) build. |

The honest summary is that Linux and macOS are *supported but unproven*. What can be
checked without one of those machines has been: every path the app looks for osu! in is
pinned by tests that run on all three platforms, and CI builds osu!'s pp calculator and
starts the app on each. What cannot is everything that needs a real osu! installation --
that detection finds it, that the file watcher fires, and that a packaged build runs after
being unzipped.

If you run it on one of them, the interesting output is `node src/main.ts --check-only`.
It reports whether osu! was found and whether the pp calculator starts, as two separate
answers. If osu! is not found, point `installRoots` in `data/config.json` at it, and please
open an issue with the path -- that is exactly the kind of layout that cannot be guessed
from here.

**osu!stable on macOS and Linux** runs under Wine, and there is no single layout for it.
The Wineskin bundles, plain `~/.wine` prefixes, CrossOver bottles and osu-winello are all
looked in; osu-winello's own record of where it installed osu! is read rather than guessed
at. Anything else needs `installRoots`.

## Running it

**If you have a packaged build**, unzip it anywhere and start it. Nothing needs installing.

| Platform | Start it with |
| -------- | ------------- |
| Windows | double-click `Start osu! local profiles.bat` |
| macOS | double-click `Start osu! local profiles.command` |
| Linux | run `./start.sh` |

On macOS the first launch is refused, because the build is not signed by a paid Apple
developer account and macOS quarantines downloaded programs that are not. Right-click the
file and choose Open, or run `xattr -dr com.apple.quarantine .` in the folder once. The
packaged `README.txt` says so too.

**From source:**

```
npm install
npm run build:pp     # builds the osu! pp helper (needs the .NET 8 SDK)
npm run dev          # or double-click start.bat
npm run check:app    # verify the install without starting to track
```

`build:pp` is required for pp. Without it the app still tracks scores, but records no pp or
star rating rather than guessing -- see below.

Then open <http://localhost:7272>. Play osu! and scores appear as you set them.

Closing the window stops tracking. The page also has a pause button if you want to keep it
open without recording.

**The page opens straight away, even on the first run.** The first time, the app reads your
osu! folder once to match each score to its beatmap -- seconds on some machines, longer on a
big library. A bar at the top of the page shows how far it has got, and anything you play
meanwhile is held and added, with pp, as soon as it finishes. Later runs only look for new
beatmaps, which normally takes under a second.

## How it works

Everything happens locally. There is no polling loop and no account login.

```
  lazer:  %APPDATA%/osu/files/**        ─┐
  stable: <osu!>/Data/r/*.osr           ─┴─→ new file detected (recursive fs.watch)
                                                     │
                            first bytes look like a replay?
                                                     ▼
                   parse .osr  →  mods, hits, combo, score, timestamp
                                                     ▼
                  beatmap MD5  →  beatmap id + ranked status   (offline)
                                                     ▼
         local .osu  →  osu!'s own difficulty/pp calculator  →  pp   (offline)
                                                     ▼
                          store → recompute profile → live update
```

Three things make the offline path possible:

- **osu!lazer writes a legacy `.osr` for every play it keeps** into its content-addressed
  file store, so replays can be watched for without touching its Realm database.
- **lazer ships `online.db`**, a SQLite database of ~234k beatmaps keyed by MD5 with ranked
  status, so a score can be matched to its beatmap with no network access.
- **pp is computed locally**, so it works for plays that were never submitted.

### Plays that were never finished

osu! counts a play you quit, retried or failed. lazer does not *keep* one: it saves a score
only for a map played to the end, so a fail or a quit leaves no replay behind. On one real
session that was 26 of 45 counted plays -- more than half a play count, invisible.

So those are read from lazer's own session log instead, which records the moment osu!
accepted each submission:

```
  lazer:  %APPDATA%/osu/logs/<session>.runtime.log  ──→ osu! accepted a submission
                             <session>.network.log  ──→ ...for this beatmap
                                        │
                    did it reach a results screen?  ──yes──→ it is a pass; its replay
                                        │                    is already being tracked
                                        no
                                        ▼
                   an unfinished play: counted, with no score attached
```

This needs osu! to be signed in, which is also exactly when osu! counts the play -- so the
two agree, and both go quiet together when you play offline. There is no accuracy, combo,
mod list or pp for these: lazer never writes any of it down for a play it discards. They
count toward your play count, monthly play counts and Most Played, and appear in Recent
Plays as dimmed rows according to the **Unfinished plays in Recent** setting. It is a lazer
feature only; osu!stable keeps no comparable log.

### pp comes from osu!'s own calculator

`tools/PpCalculator` is a small .NET helper referencing the official
`ppy.osu.Game.Rulesets.*` NuGet packages -- osu!'s actual difficulty and performance code.
It stays resident and speaks one JSON object per line, so the cost is a single process
start rather than one per score.

It is handed the replay file and decodes it with osu!'s own `LegacyScoreDecoder`, which is
what makes **osu!stable** replays correct: the decoder sets `IsLegacyScore` from the replay
version, applies the Classic mod (switching the calculator onto classic slider accuracy and
legacy miss estimation), and populates `MaximumStatistics` from the beatmap. Building a
score by hand instead would silently score stable plays as though they were lazer.

This is needed because every *reimplementation* of osu!'s algorithm lags its reworks.
`rosu-pp` 4.0.1 (its newest release) implements the 2025-10-29 algorithm, but osu! reworked
difficulty again on 2026-07-03. On a real play:

| | rosu-pp | osu! official | osu! website |
|---|---|---|---|
| stars | 7.030 | **6.933** | 6.93 |
| pp | 142.43 | **151.23** | 151 |

Keeping current with a future rework is a version bump in
`tools/PpCalculator/PpCalculator.csproj`, then `node scripts/reingest.mjs`.

**There is deliberately no fallback calculator.** A second implementation disagreeing by a
few percent would leave one profile holding scores computed two different ways, ranked
against each other and weighted together, with nothing on screen saying which was which.
A missing pp value is recoverable; a silently wrong one is not.

### Why local rather than the osu! API

An offline or logged-out play is never submitted, so it never appears in the osu! API — not
even after you reconnect. In lazer you can only play offline as a guest, so those scores
exist solely on disk. Reading local files is the only approach that covers them, and it is
also instant and costs the API nothing.

**No osu! API credentials are needed, and none are used.** There is no OAuth application,
no client id, no secret and no login anywhere in this project. Nothing polls the API.

Two hosts are contacted, both public and unauthenticated, and both optional:

| host | what for | if it fails |
|---|---|---|
| `assets.ppy.sh` | beatmap cover art, and medal icons | a drawn placeholder shows instead |
| `data.ppy.sh` | the rank-curve dumps, only when you run `npm run rank:refresh` by hand | nothing; the checked-in curves keep working |
| `osu.ppy.sh` | one page fetch when you press **Look up** in Edit profile, to find a name, picture and banner | it says so; type a name and upload an image instead |

The profile lookup reads the public profile page -- the same user object osu!'s API returns
for `/users/{user}`, which the page embeds in order to render itself. One request per press
of the button, never on a timer, and what it finds is copied into `data/` so it is never
fetched twice.

Rank estimation was the one feature that looked like it would need the API, and it does not:
the rankings endpoint only exposes the top 10,000 anyway, which never covers a new
profile, so the curve comes from the public dumps instead.

## Configuration

`data/config.json`, created on first run:

| key | default | meaning |
|---|---|---|
| `profileName` | `Local Profile` | name of the *first* profile only; after that, manage profiles from the page |
| `port` | `7272` | local web server port |
| `openBrowser` | `true` | open the page in your default browser on start -- also **Options -> Open in browser on start** |
| `checkForUpdates` | `true` | ask GitHub once at startup whether a newer release exists |
| `installRoots` | `[]` | explicit osu! paths if auto-detection fails |
| `country` | `""` | two-letter ISO code shown beside the profile name, as osu! shows one |
| `tagline` | `""` | what to call the playstyle, e.g. `left hand, mouse only` |

`country` and `tagline` are only the starting point. Both are editable from **Options ->
Settings** and are stored per profile from then on, so two playstyles can carry different
descriptions and clearing one stays cleared.

Drop an image at `data/avatar.png` or `data/cover.jpg` (`.jpg`/`.jpeg`/`.png`/`.webp` all
work) to use it on the profile. Neither is required.

Scores set before the profile was created are never imported — otherwise switching the app
on would pull in the plays you set with your normal playstyle earlier that day.

## Development

```
npm run typecheck
npm test
npm run check        # both
npm run ui           # drives the real page in headless Chrome (app must be running)
```

After changing `tools/PpCalculator/Program.cs`, run **`npm run build:pp:local`** rather than
`npm run build:pp`. `tools/pp/` holds a self-contained build that the app prefers over the
plain output, and a stale copy there does not fail loudly -- it answers the old protocol and
quietly returns values calculated the old way.

The page is plain HTML, CSS and ES modules with **no build step** -- edit `web/` and
reload. `npm run ui` covers both the dialog behaviour below and the design tokens actually
resolving, since a mistyped custom property fails silently as a slightly-off shade.

`npm run ui` exists because some bugs only show up in computed style. The reset dialog once
set `display: grid` on the element it also toggled with the `hidden` attribute; `hidden`
loses that specificity fight, so the dialog was visible on load and Cancel appeared dead --
leaving the destructive button as the only one that worked. No unit test would catch that.

## Known gaps

- **Building the pp helper needs the .NET 8 SDK.** End users of a packaged build will not,
  since the helper can be published self-contained -- but that adds roughly 70MB to the
  download, which is a real tension with the single-.exe goal and is unresolved.
- **Only osu!standard has been checked against known-correct values.** taiko, catch and
  mania go through the same osu! code and should be right, but nothing verifies them yet.
- **Global rank is an estimate, and ages.** It is interpolated from a pp->rank curve built
  from a monthly data.ppy.sh sample of the whole ladder, so it drifts as the playerbase
  grows. Refresh it with `node scripts/build-rank-table.mjs osu --dump YYYY_MM_DD`.
- **Country rank is not shown at all.** A 10,000-user sample spread over ~200 countries is
  far too thin to estimate one, and a fabricated number would be worse than a dash.
- **The rank curves cover all four modes**, but only osu!standard's pp is verified against
  known-correct values, so the other three inherit that caveat.
- Only the local `.osu` files you already have can be used for pp; a map you have never
  downloaded cannot be calculated offline.
- **Unfinished plays carry no score, and are lazer-only.** osu!lazer keeps no record of a
  play it discards, so a quit, a retry or a fail can be counted but never scored -- there is
  no accuracy, combo, mod list or pp to recover. They also need osu! signed in, since the
  play is only visible once osu! has accepted the submission. A converted beatmap files
  under the beatmap's own ruleset, because the log never names the one it was played in.
- **osu!stable's unfinished plays are not counted yet.** stable has the same gap -- osu!
  counts its fails and quits, and stable saves no replay for them either -- but where a
  stable install records them, if it records them at all, has not been established, because
  there is none on the development machine. A stable install contributes its passes exactly
  as before. [docs/roadmap.md](docs/roadmap.md) **5.12** has the leads and the measurement
  to run first.

## Editing the profile

**Options -> Edit profile**, or click the avatar or the name.

- **Name** -- renames the profile. Nothing it has tracked changes.
- **Picture** and **Banner** -- upload a PNG, JPEG, WebP or GIF, or borrow them from an
  osu! account. Both are stored per profile, so two playstyles are two identities.
- **Borrow from an osu! account** -- type a username, a user id, or a link to a profile.
  Pressing **Look up** shows what it found; pressing **Use this** copies the picture and
  banner in.

If osu! is signed in, its username is offered as a suggestion, read from the client's own
config file with no network at all. It only ever prefills: a local profile is a different
identity by definition, so it is never adopted without being asked for.

Nothing here is required. With no picture the page draws an avatar from the profile's name,
and the banner falls back to the cover art of the profile's best play.

## Sharing the profile

**Options -> Share this profile.**

- **Save as a web page** -- one `.html` file holding everything on the page. It opens
  anywhere, needs neither this app nor a connection, and keeps working indefinitely. It is
  built from the live page rather than re-rendered, so it captures exactly what is on
  screen, section order included. This is the one that survives.
- **Save as an image** -- a full-page PNG, rendered by the Chrome or Edge already on your
  machine. Nothing is bundled: a headless browser would be several times the size of this
  whole app. Without one installed the button says so and points at the HTML export.

### The live page is never shared

The page can reset a profile, delete one and remove scores, and none of those endpoints
asks who is calling. So the server refuses anything that is not coming from this machine,
and there is no setting that changes that. *(Earlier versions had an opt-in
`shareOnNetwork` setting; it was removed in 1.5.0, and an old `config.json` that still has
it is simply ignored.)*

The check is on the request rather than the listening socket, because binding to
`127.0.0.1` also cuts off IPv6 loopback -- and `localhost` resolves to `::1` first on
Windows, so binding "safely" would leave the app unreachable from its own browser.

## Medals

A Medals section laid out as osu!'s is, restricted to the medals a local profile can
actually decide for itself. The names, descriptions, icons and thresholds are osu!'s own,
taken from its published achievement list by `node scripts/build-medal-table.mjs`.

They are shown in osu!'s own groups -- **Mod Introduction**, then **Skill & Dedication** --
with a row of icons per family and nothing written beside them. Hover (or tab to) a medal for
osu!'s card -- the group, the medal's name and description, and the date it was achieved,
or *Locked*. A newly earned medal also appears in **Milestones**, and the page announces it
when it happens.

What exists is **not the same in every mode**, and that is osu!'s doing rather than a gap
here:

| family | osu!standard | taiko, catch, mania |
|---|---|---|
| Combo | 500 / 750 / 1,000 / 2,000 | none in osu! |
| Plays | 5,000 / 15,000 / 25,000 / 50,000 | none in osu! |
| Hits | none in osu! | four tiers, per mode |
| Beatmap pass | 1★ to 10★ | 1★ to 8★ |
| Beatmap full combo | 1★ to 10★ | 1★ to 8★ |
| Rank | top 50,000 / 10,000 / 5,000 / 1,000 | the same four |

**Mod Introduction** is one set shared by every mode, as on osu!: your first pass with a mod
on its own at its default settings -- Easy, No Fail, Half Time, Hard Rock, Sudden Death,
Perfect, Double Time, Nightcore, Hidden, Flashlight, and Spun Out (osu!standard only). Two more
go to lazer's **Conversion** and **Fun** mods, which osu!stable does not have. These are
osu!'s rules, taken from the code that awards them: Classic does not count as a second mod,
Nightcore is not Double Time, and a failed play earns nothing.

Medals are **derived from the scores, never stored**: removing a score that earned one takes
the medal with it. Two families are only as good as their inputs, and say so:

- **Rank** medals use the estimated pp-to-rank curve, so they inherit its approximation.
- **Full combo** needs the beatmap's own maximum combo. A lazer score can drop slider ends
  without breaking combo, so "no misses" alone is not enough. Scores tracked before that
  was recorded are reported as unknown rather than guessed either way; the section says how
  many, and Settings can recalculate them.

## Total Play Time

Counted the way osu! counts it. osu!'s score processor adds, for every play,
**the beatmap's length divided by the play's rate, or the time from starting the play to
submitting it, whichever is less** -- so DT counts two-thirds of the map, and quitting after
thirty seconds counts thirty seconds rather than the whole map.

- A **finished score** counts its beatmap's length at the speed it was played. The replay
  does not record when the play began, but for a map played to the end the length is the
  smaller of the two anyway.
- An **unfinished play** (quit, retry, fail) counts the time between osu! starting it and
  osu! accepting its submission, both read from lazer's log, capped at the map's length.
  Unfinished plays tracked before 1.5.0 have no start time recorded and count nothing
  rather than a guess.
- A beatmap's length runs from its first object to the end of its last, read once from the
  `.osu` file. A slider's tail at the very end of a map is not included.

## Favorite Beatmaps

The **Beatmaps** section, as osu! has it. Open the **...** menu on any row in **Scores** or
**Recent Plays** and choose **Favorite this beatmap**; it appears as osu!'s beatmap card,
with its cover, status, a coloured dot per difficulty, and the Explicit / Featured Artist /
Spotlight badges, and a video or storyboard icon when the set has one. Hover the dots for
every difficulty's name and star rating, and the card for the heart (unfavourite) and the
download link. The play button on the cover plays osu!'s own short preview of the song --
streamed from osu.ppy.sh only when pressed, about 100KB, and never stored. Press it again to
pause, and again to carry on from where it stopped.

While a preview plays, osu!'s audio bar comes up in the bottom-right corner: previous / next
through your favourites, play / pause, the position (drag to seek), a volume slider with mute,
and a button to play the next favourite automatically when one ends. It goes away a few
seconds after the music stops. The volume, mute and autoplay choices are remembered by your
browser.

Favourites belong to the profile, as osu!'s belong to an account, and are never sent to
osu!. Favouriting makes **one request** to `osu.ppy.sh` for that beatmap's details, which
are then kept, so the card works offline. With no connection the favourite is still saved,
and the card shows what your machine knows -- every difficulty from lazer's `online.db`,
with a star rating only where one of your own scores gives it -- until a later favourite,
made online, fills it in.

## View Details and Download Replay

Two more entries in a score's **⋯** menu, in the order osu! has them.

**View Details** opens the score as osu!'s score page does, in a card over the profile: the
beatmap and its difficulty, the cover, the grade tower, osu!'s accuracy dial (or, for a
score set on osu!stable, the big grade letter osu! shows instead), the mods and total score,
who played it and when and on which client, and accuracy, max combo, pp and every judgement
-- great / ok / meh / miss, plus slider ticks, slider ends and spinners against what the map
had.

Under those is the **pp breakdown**: how much came from aim, speed, accuracy and flashlight
(taiko: difficulty and accuracy; mania: difficulty; catch has none), as osu!'s own calculator
splits it, with the osu! release that priced the score. It is on the card only, not the
profile page. A score tracked before this existed gets its breakdown the first time it is
opened, recalculated from its replay so the parts always add up to the pp shown. Close it with the X, Escape, or a click beside it; the page underneath is exactly as you
left it. Its own **⋯** has Pin and the rest, as the one on osu!'s score page does.

Two things from osu!'s page are not there, because they are facts about osu!'s leaderboards
and a local profile has none: the score's **Global Rank**, and how many times the replay was
**watched**.

**Every score has its own page**, as on osu!: `http://localhost:7272/scores/<number>`, this
app's version of `osu.ppy.sh/scores/<number>`. The card's **⋯** menu -- in the pop-up and on
that page -- has **Copy link** for the address, and **Save screenshot** / **Copy screenshot**
for the card as a picture, to your downloads or straight to the clipboard. The picture is
made by the Chrome or Edge already on your computer, the same way the profile's screenshot
is, which is what lets it include the beatmap's cover art. A link keeps working after you
switch profiles; it shows the score as the profile it belongs to.

**Download Replay** saves the score's replay to your Downloads folder like any download --
the exact file osu! wrote, so it can be dragged back into osu! to watch. It is named the way
osu!lazer names a replay it exports, e.g. `Tangy playing Taylor Swift - Cruel Summer (funny)
[Seolv's Hard] (2026-09-10_20-36).osr`. It is offered for any finished score whose replay
osu! recorded; an unfinished play never has one. If osu! has since deleted the file, the page
says so rather than starting a download that fails.

## Rearranging the page

Hover a section and use the arrows in its top-right corner, or drag it by the grip beside
them. The order is saved with the profile, the way osu! remembers the arrangement of your
own page.

The arrows are the real interface, not a fallback: they work from the keyboard and on a
touchscreen, and they cannot half-succeed the way a drag can.

## The me! section

The description box from osu!'s own profile, at the top of the page. Click it to write
something; it belongs to the profile, so each playstyle gets its own.

It is **plain text**, not BBCode. Line breaks are kept and bare URLs become links; anything
else you type appears as the characters you typed. That is deliberate: osu!'s BBCode subset
is large, and a local profile gains nothing from an HTML sanitiser it would have to get
exactly right -- and everything to lose by getting it wrong.

## Pinning and removing scores

Every score row has a **⋯** menu.

- **Pin to profile** puts it under **Pinned Scores**, above Best Performance, as on osu!.
  Pins are per game mode, and a pinned score does not have to be in your top 100 -- pinning
  is how you show a play you are proud of that pp does not reward.
- Drag pinned scores to reorder them, or use **Move up** / **Move down** in the same menu.
- **Remove from profile** takes the score out of every section *and* out of the totals:
  pp, play count, ranked score, level, the charts and Most Played.

Removing never deletes anything. The score is marked hidden and can be put back from
**Options -> Settings**, under *Removed scores*. That is not only a convenience: the replay
file is still in osu!'s store, so a genuinely deleted row would be re-imported the next
time it was noticed -- and with nothing left to recognise it by, it would come back looking
like a brand new play.

## Settings

**Options -> Settings**, and everything there belongs to the profile you are on -- two
playstyles are two profiles and should not share a description or how their scores count.

### Include pp for unranked mods

Off by default. On, it counts plays osu! refuses to rank because of their mods:

- **Relax and Autopilot.**
- **Customised rates** -- DT at 1.45x, HT at 0.5x, and so on.

Autoplay and Cinema are never counted whatever this is set to: they are not plays.

Relax and Autopilot can be priced two ways, and they are far apart:

| | one real RX replay | one real AP replay |
|---|---|---|
| **As if the mod were off** (default) | 7.83 stars, 239pp | 4.45 stars, 101pp |
| **As osu! scores them** | 6.26 stars, 111pp | 3.14 stars, 57pp |

Both numbers come from osu!'s own difficulty and performance calculators -- osu!'s
difficulty calculation is relax-aware, which is why the two disagree by more than 2x. The
default is the first, because "relax counts as nomod, relax + DT counts as DT" is usually
what people mean. It does flatter the score: a relax run reaches accuracy and combo the
same player could not reach by hand.

Both values are stored for every score, so switching between them is instant.

Whenever a profile is counting something osu! would not, the page says so above Best
Performance, and every affected row is marked.

### Include pp for unranked beatmaps

None by default. Six states, each its own choice, because they are not one proposition:

| state | what it is |
|---|---|
| Loved | community-voted, played competitively, no pp in osu! |
| Qualified | ranked-pending, will usually become ranked |
| Pending | submitted, awaiting nomination |
| Work in progress | submitted, explicitly unfinished |
| Graveyarded | submitted, then abandoned |
| Never submitted | not in lazer's `online.db` at all -- it exists only on your machine |

pp still comes from osu!'s own calculator, which will price any beatmap it is handed. The
two settings are independent: a Loved map played with Relax needs both before it counts.

### Unfinished plays in Recent Plays

Plays that were started and never finished -- quit, retried, or failed. They **always**
count toward your play count, monthly play counts and Most Played, because osu! counts them
and a profile that disagreed with the website about how much you had played would simply be
wrong. This setting only decides whether they are listed in Recent Plays.

| Setting | What Recent Plays shows |
| ------- | ----------------------- |
| Group retries on one map | *(default)* a run of attempts on one beatmap becomes one row, with the count |
| Show every attempt | one row per attempt |
| Hide them | scores only |

The default is grouping because of how much of a session these can be: on the session this
was built from there were 26 abandoned attempts against 19 finished ones, and listing each
one turns the feed into a list of retries. A run is only grouped while it is *consecutive*,
so a finished play in the middle still breaks it up the way it happened.

These rows carry no accuracy, mods or pp, and are shown dimmed with a "Didn't finish" note
rather than with zeroes standing in for numbers nobody recorded. See
[Plays that were never finished](#plays-that-were-never-finished) for why.

### pp calculator

Says which osu! release's calculator prices your scores -- the footer says so too. After osu!
reworks pp, a new version of this app ships the new calculator; when some of this profile's
scores were priced by an older one, this says how many and **Recalculate them** brings them
up to date from their replays, so every score is ranked against the others by one algorithm.

### Recalculating older scores

Scores tracked before this existed have no pp for anything osu! would not rank -- there was
no reason to calculate one at the time. Turning the setting on offers to recalculate them
from their replay files. Nothing is deleted, and a score whose replay is no longer on disk
is left exactly as it is.

## Profiles

**Options -> Profiles** manages several playstyles side by side -- "left hand", "mouse
only", "tablet again" -- each with its own scores, pp, level and start date. Only the
selected one records plays. A new profile starts empty and tracks from the moment you
create it, never from earlier plays.

Deleting a profile takes its tracked scores with it and needs an explicit confirmation.
The last remaining profile cannot be deleted; reset it instead.

## Backing up and exporting

- **Options -> Export this profile** downloads the active profile as JSON: every score with
  its beatmap, plus the computed totals and rank.
- **Options -> Back up everything** downloads a copy of the whole database, all profiles
  included. It is written with `VACUUM INTO` rather than copied, because the database runs
  in WAL mode and a plain file copy can miss recent writes.

Replays on disk remain the real source of truth -- `node scripts/reingest.mjs` rebuilds
everything from them -- but these are portable and outlive the app.

## Importing plays you set while it was closed

Scores are only tracked while the app is running, so a session played with it closed is
missed. **Options -> Import past plays** covers that: pick how far back to look, check what
would be imported, then confirm.

It never runs by itself, and the warning in the dialog is the important part -- reach back
further than the session you actually played with this playstyle and you will pull in plays
set with your normal one, which is the one thing a separate profile must not contain.

## Rank estimation

osu!'s rankings API only exposes the top 10,000, which never covers a new profile. Rank
is instead interpolated from a small curve built from data.ppy.sh's random sample of the
whole ladder, in which every sampled user carries their own real rank:

```
npm run rank:refresh                                # all four modes, newest dump
node scripts/build-rank-table.mjs osu --latest      # one mode
node scripts/build-rank-table.mjs osu --dump 2026_09_01
```

The script streams each ~1GB archive through `bzip2` and `tar` and keeps only the
user-stats table inside it, so nothing large is written to disk. That table is deleted as
soon as the curve is written, and the script says so; the checked-in result is ~3KB per
mode. All four modes ship with a curve built from the 2026_09_01 dump.

### When to refresh

**Never automatically.** Nothing in the app triggers this, on a timer or otherwise -- it is
a multi-gigabyte download and it is the owner's call. Run it by hand when:

- **osu! reworks pp.** The curve maps pp to rank, so a rework moves both sides at once and
  the old curve becomes wrong immediately. Do this in the same pass as bumping
  `PpCalculator.csproj` and running `reingest.mjs`.
- **Every few months otherwise.** Ranks drift as the playerbase plays on: the same pp buys
  a slightly worse rank over time. It degrades gradually, so this is not urgent.

data.ppy.sh publishes monthly. `--latest` picks the newest automatically, and re-running
against a dump you already built from just rewrites the same curve, so it is safe to run
whenever you are unsure.

Budget roughly 15-30 minutes per mode, depending on your connection -- the bottleneck is
the download, not the decompression.

## Building a release

```
npm run package
```

Produces `dist/osu-local-profiles-<version>-<rid>/` and a zip beside it: **203MB on disk,
83MB to download** for `win-x64`, containing Node, osu!'s pp calculator and the app. The
user extracts it and runs the launcher; there is nothing to install and no admin rights
needed, and because `data/` lives beside the app the whole folder can be moved or carried
on a stick.

**A package has to be built on the system it is for.** The runtime identifier defaults to
the machine's own (`win-x64`, `osx-arm64`, `linux-x64`, ...) and `--rid` can only narrow
that to a different architecture, not a different OS: `dotnet publish` would happily
cross-compile the pp helper, but the bundled Node runtime is a copy of the one running the
script, and there is no cross-platform equivalent of that. Building for another OS is
refused rather than producing an archive that starts on nothing.

So releases are built by **GitHub Actions** (`.github/workflows/release.yml`): pushing a
`v<version>` tag packages the app on a Windows, a macOS and a Linux runner and attaches the
three zips to that version's release, with notes from this CHANGELOG. Running the workflow by
hand with no tag is a dry run that builds all three and publishes nothing.

Most of that script is *removal*. osu!'s NuGet packages carry the entire game -- fonts,
textures, audio samples, ffmpeg, SDL, a shader compiler -- and a self-contained publish is
273MB, of which 125MB is `osu.Game.Resources.dll` alone.

Less can go than you would think. osu.Framework's `Logger` static constructor pulls in
nearly the whole managed assembly graph, so what is safe to delete is only what loads
lazily: the resources assembly, localisation satellites, and native libraries reached by
P/Invoke. One of those is worth calling out -- the native BASS audio binaries are
commercially licensed and this app never plays a sound, so they are excluded (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

The script also starts the packaged app from an unrelated directory and **refuses to finish
unless it reports finding its pp calculator**. An early build looked perfectly fine and
silently recorded no pp, because the helper's path was resolved from the working directory
-- which, for a double-clicked process, is whatever Explorer decides.

## Recalculating

Replays on disk are the source of truth, so any calculation fix can be applied
retroactively. Stop the app and run:

```
node scripts/reingest.mjs
```

This rebuilds every tracked score from its replay file.

To fill in values on existing scores *without* replacing them -- keeping their ids, which
is what you want in normal use -- the page's **Options -> Settings** offers a recalculation
instead, and the app can stay running.

## Licence

MIT — see [LICENSE](LICENSE).

The visual design is reimplemented from osu-web's *published design tokens* rather than
copied from its stylesheets, which are AGPL-3.0. No osu-web CSS or image asset is included;
the token table it was rebuilt from is recorded in
[docs/osu-web-reference.md](docs/osu-web-reference.md).

A packaged build bundles other people's software — osu!'s own pp code, the .NET runtime,
Node.js and their dependencies. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists
what, and what is deliberately excluded — notably the commercially-licensed BASS audio
library, which this app has no use for.

**What this does not do:** it never contacts osu!'s game servers, never logs in, uses no
API credentials, and only reads replay and beatmap files already on your disk. It does not
automate or assist play in any way.
