# User guide

What every part of the app does, from a user's side. The README covers installing and the
short version; `docs/architecture.md` covers how it works inside. Carried over from the
README as it stood at 1.21.0.

## Running it

| Platform | Start it with | Where it lives while it runs |
| -------- | ------------- | ---------------------------- |
| Windows | double-click `osu! local profiles.exe` | the system tray |
| macOS | double-click `osu! local profiles` | the menu bar |
| Linux | run `./osu-local-profiles` (or `./start.sh`) | the system tray |

There is no console window. The icon's menu has **Open profile**, **Open log** and **Quit**. On
Windows and Linux, clicking the icon opens the page. The page has **Quit** too, at the top right.
Starting the app again while it runs opens the page, so the launcher is also how to find it.
What it prints goes to `data/logs/app.log`. The page also has a pause button, to keep it open
without recording.

On Linux, a desktop without a tray (GNOME without the AppIndicator extension) gets no icon, and
the app runs anyway; start it again for the page. With no desktop at all, `./start.sh` runs it
in the terminal.

Windows may say it protected your PC from an unrecognised app, because the build is not signed:
press **More info**, then **Run anyway**. It asks once.

On macOS the first launch is refused, because the build is not signed by a paid Apple
developer account and macOS blocks downloaded programs that are not. It takes one approval:
double-click `osu! local profiles`, close the message, then in **System Settings -> Privacy &
Security** press **Open Anyway** beside it and confirm. (On macOS 14 and earlier,
right-clicking it and choosing Open does the same.) The launcher then lifts the quarantine from
the rest of its own folder, so the pp calculator and its libraries are not refused one at a time
- there is no need to allow apps from anywhere, and it is better not to. Running
`xattr -dr com.apple.quarantine .` in the folder from Terminal does the same without any
approval. The packaged `README.txt` says so too.

**The page opens straight away, even on the first run.** The first time, the app reads your
osu! folder once to match each score to its beatmap - seconds on some machines, longer on a
big library. A bar at the top of the page shows how far it has got, and anything you play
meanwhile is held and added, with pp, as soon as it finishes. Later runs only look for new
beatmaps, which normally takes under a second.

Scores set before the profile was created are never imported unless you ask - otherwise
switching the app on would pull in the plays you set with your normal playstyle earlier that
day. See [Importing plays you set while it was closed](#importing-plays-you-set-while-it-was-closed).

## Platform support

| Platform | State |
| -------- | ----- |
| **Windows** | Verified, on both clients. osu!stable was installed and played against as of 1.12.0 (detection, the beatmap index, the replay watcher, pp and the Classic mod all checked on a real install). |
| **Linux** | Green on CI (`ubuntu-latest`): typecheck, the full test suite, and a real start-up. Each release has a `linux-x64` build, packaged and started on Linux. Nobody has yet run it against an actual osu! install. |
| **macOS** | The same, on `macos-latest`, with an `osx-arm64` (Apple silicon) build and an `osx-x64` (Intel) one built on an Intel runner. Each is built and started by CI on its own architecture; neither has been run against a real osu! install. |

Linux and macOS are *supported but unproven*. What can be checked without one of those
machines has been: every path the app looks for osu! in is pinned by tests that run on all
three platforms, and CI builds osu!'s pp calculator and starts the app on each. What cannot is
everything that needs a real osu! installation - that detection finds it, that the file watcher
fires, and that a packaged build runs after being unzipped.

On one of them, the interesting output is `node src/main.ts --check-only`. It reports whether
osu! was found and whether the pp calculator starts, as two separate answers. If osu! is not
found, point `installRoots` in `data/config.json` at it, and please open an issue with the
path - that is exactly the kind of layout that cannot be guessed.

**osu!stable on macOS and Linux** runs under Wine, and there is no single layout for it. The
Wineskin bundles, plain `~/.wine` prefixes, CrossOver bottles and osu-winello are all looked
in; osu-winello's own record of where it installed osu! is read rather than guessed at.
Anything else needs `installRoots`.

**Options -> osu! folders** shows what was found and takes a folder by hand. "No osu!
installation found" does not close the app - the page opens so you can point at one.

## Plays that were never finished

osu! counts a play you quit, retried or failed. lazer does not *keep* one: it saves a score
only for a map played to the end, so a fail or a quit leaves no replay behind. On one real
session that was 26 of 45 counted plays - more than half a play count, invisible. So those are
read from lazer's own session log instead, which records the moment osu! accepted each
submission.

This needs osu! to be signed in, which is also exactly when osu! counts the play - so the two
agree. There is no accuracy, combo, mod list or pp for these: lazer never writes any of it down
for a play it discards. They count toward your play count, monthly play counts and Most Played,
and appear in Recent Plays as dimmed rows according to the
[Unfinished plays in Recent Plays](#unfinished-plays-in-recent-plays) setting. They can be
removed from Recent Plays and the play count.

### Offline or signed out

osu! counts nothing it cannot submit, so a quit, fail or retry while offline is not a play on
osu!. lazer still writes one line about it - `No token, skipping score submission` - and that
is what this reads: only a solo play the game said it had no token for, that did not reach a
results screen (a pass is already tracked from its replay). The beatmap is matched by the name
the log gives it, against every beatmap installed, so this works without osu!lazer's online
beatmap database.

They count by default, toward the play count, monthly play counts, Most Played, Recent Plays
(as **Not submitted**) and Total Play Time together: osu! never received them, so counting them
takes nothing away from what your osu! profile shows - it only covers play osu! had no chance
to see. Turn off **Other settings -> Count plays osu! could not submit** to match your osu!
profile exactly; they are recorded either way, so turning it back on loses nothing. The one
thing the log cannot say is whether osu! would have counted the attempt had it been online -
osu! ignores a play with no hits at all - so an attempt quit before hitting anything counts
here.

Attempts from before the app was running are still in osu!lazer's logs, and **Import past
plays** can bring them in.

## osu!stable is different

Measured on a real stable install (`b20260711.1`), and not something this app can work around:

- **A score arrives when you leave the results screen**, not when the play ends. That is the
  moment stable writes the replay file: on one session the scores were set at 3:39:25, 3:41:04
  and 3:42:12, and the replays appeared 8 to 23 seconds later, as each results screen was
  closed. Until then there is nothing on disk to notice.
- **Plays you quit, failed or retried are not counted at all.** stable writes no replay for
  them and no log of them. The only trace is a single "last played" time per beatmap in
  `osu!.db`: a quit, a fail and a retry on one difficulty left *one* timestamp between them,
  flushed minutes later, and a pass updates the same field. That cannot count retries, cannot
  tell a fail from a pass, and comes too late - so this app does not guess.
- **With osu!stable and no osu!lazer, every beatmap counts toward pp.** Only lazer ships the
  database that records whether a beatmap is ranked, so a stable-only install cannot tell a
  ranked map from a loved, graveyarded or never-submitted one. pp is still calculated for every
  play - that needs only the beatmap file, which is in your Songs folder - so rather than
  counting nothing, the profile counts everything and says so in **Scores**. The *Include pp
  for unranked beatmaps* settings are dimmed there, because there is no status to filter on.
  Install osu!lazer alongside and the statuses resolve for stable's plays too.

The page says the first two once, wherever a stable install is found - in Recent Plays and in
Scores, with a **Don't show again**. On osu!lazer neither applies: a play is counted the moment
osu! accepts it, quits and retries included. The full evidence is in
[roadmap.md](roadmap.md) under 5.12.

## The profile page

Under the rank graph sit osu!'s own three figures: **Medals** (every medal the profile holds,
across all modes), **pp**, and [**Total Play Time**](#total-play-time).

The long sections - Recent Plays, Scores, Milestones and Most Played Beatmaps - start at five
rows with a **show more** button, expanding to 25 and then 25 at a time, as on osu!. Both
charts are hoverable: the rank graph reads out `Global Ranking #120,000` / `40 days ago` by
day, and Play History reads `Plays 430` / `March 2020` by month.

Global rank is an estimate (see [Known limitations](#known-limitations)). Country rank shows
`-`, on purpose.

The page can be read **in your own language**: the flag in the top right switches language,
and the first launch asks.

### Rearranging the page

Hover a section and use the arrows in its top-right corner, or drag it by the grip beside them.
The order is saved with the profile, the way osu! remembers the arrangement of your own page.

The arrows are the real interface, not a fallback: they work from the keyboard and on a
touchscreen, and they cannot half-succeed the way a drag can.

## Profiles

**Options -> Profiles** manages several playstyles side by side - "left hand", "mouse only",
"tablet again" - each with its own scores, pp, level and start date. Only the selected one
records plays. A new profile starts empty and tracks from the moment you create it, never from
earlier plays. The same dialog edits and resets the profile being tracked, imports from an osu!
account, and holds **Keep Favorite Beatmaps the same on every profile**.

Deleting a profile takes its tracked scores with it and needs an explicit confirmation. The
last remaining profile cannot be deleted; reset it instead, with **Reset this profile** at the
end of Edit profile.

### Editing the profile

**Options -> Profiles**, under *Edit profile* - or click the avatar or the name, which open
Profiles there.

- **Name** - renames the profile. Nothing it has tracked changes.
- **Country** - a two-letter code, shown beside the name the way osu! shows a flag.
- **Playstyle** - what this profile is tracking, shown under the name.
- **Picture** and **Banner** - upload a PNG, JPEG, WebP or GIF, or import them from an osu!
  account (below). Both are stored per profile, so two playstyles are two identities.

Nothing here is required. With no picture the page draws an avatar from the profile's name, and
the banner falls back to the cover art of the profile's best play.

`country` and `tagline` in `data/config.json` are only the starting point; once edited here
they are stored per profile, so two playstyles can carry different descriptions and clearing
one stays cleared. An image dropped at `data/avatar.png` or `data/cover.jpg`
(`.jpg`/`.jpeg`/`.png`/`.webp` all work) is used too.

### Importing from an osu! profile

**Options -> Profiles**, under *Import from osu!*. Type a username, a user id or a link to a
profile, press **Look up**, tick what to copy, and press **Import**.

| What | Ticked to begin with |
| ---- | -------------------- |
| Avatar | yes |
| Banner | yes |
| Flag | yes |
| me! | yes - it replaces this profile's me! |
| Favorite beatmaps | no - they are added to the list |

It can also copy the account's **best performances and pinned scores**, so a profile's pp and
accuracy match the website even for plays set on another PC.

Importing also links the profile to that account. It is never automatic. A brand-new install
offers this once, as a welcome marked optional; Skip, the close button, Escape or clicking
outside it dismisses it for good, and an install updated from an earlier version is never
asked. Either way nothing is sent to `osu.ppy.sh` until you press a button - one request to find
the account, one per picture, and one per hundred favorites. No login and no API key. If osu! is
signed in on this machine, its username is offered, read from the client's own config file with
no network at all.

## The me! section

The description box from osu!'s own profile, at the top of the page. Click it to write
something; it belongs to the profile, so each playstyle gets its own.

It is written the way osu!'s is: in **BBCode**, with osu!'s own toolbar - Bold, Italic, Strike
Out, Header, Link, Spoiler Box, Numbered List, List, Image, Image Map and Font Size, each
wrapping whatever is selected - and **Preview** to see it before saving. **Paste or drop an
image** straight into the box, or press Image with nothing selected, and it is stored with the
profile. A me! page can be up to 60,000 characters, so one imported from osu! arrives whole.

The page is drawn by this app's own renderer rather than by trusting the text: everything is
escaped first, and only the tags it knows become formatting. A tag it does not know, or one
left open, shows as the characters you typed - so a page imported from anyone's osu! profile is
exactly as safe as one you wrote.

## Scores

### Pinning and removing scores

Every score row has a **⋯** menu.

- **Pin to profile** puts it under **Pinned Scores**, above Best Performance, as on osu!. Pins
  are per game mode, and a pinned score does not have to be in your top 100 - pinning is how
  you show a play you are proud of that pp does not reward.
- Drag pinned scores to reorder them, or use **Move up** / **Move down** in the same menu.
- **Remove from profile** takes the score out of every section *and* out of the totals: pp,
  play count, ranked score, level, the charts and Most Played.

Removing never deletes anything. The score is marked hidden and can be put back from
**Options -> Other settings**, under *Removed scores*. That is not only a convenience: the
replay file is still in osu!'s store, so a genuinely deleted row would be re-imported the next
time it was noticed - and with nothing left to recognise it by, it would come back looking like
a brand new play.

To get rid of one for good, press the **red minus** beside it in *Removed scores* (it asks once
more), or **Delete all permanently**. The score is deleted; what is kept is only the replay's
fingerprint, so the replay still in osu!'s store is never imported again. A reset clears those
along with everything else.

Replays you *watched* are not counted as your own - osu! keeps them in the same folders as the
ones you set.

### View Details

**View Details** opens the score as osu!'s score page does, in a card over the profile: the
beatmap and its difficulty, the cover, the grade tower, osu!'s accuracy dial (or, for a score
set on osu!stable, the big grade letter osu! shows instead), the mods and total score, who
played it and when and on which client, and accuracy, max combo, pp and every judgement -
great / ok / meh / miss, plus slider ticks, slider ends and spinners against what the map had.

Under those is the **pp breakdown**: how much came from aim, speed, accuracy and flashlight
(taiko: difficulty and accuracy; mania: difficulty; catch has none), as osu!'s own calculator
splits it, with the osu! release that priced the score. It is on the card only, not the profile
page. A score tracked before this existed gets its breakdown the first time it is opened,
recalculated from its replay so the parts always add up to the pp shown. Close it with the X,
Escape, or a click beside it; the page underneath is exactly as you left it. Its own **⋯** has
Pin and the rest, as the one on osu!'s score page does.

Two things from osu!'s page are not there, because they are facts about osu!'s leaderboards and
a local profile has none: the score's **Global Rank**, and how many times the replay was
**watched**.

**Every score has its own page**, as on osu!: `http://localhost:7272/scores/<number>`, this
app's version of `osu.ppy.sh/scores/<number>`. The card's **⋯** menu - in the pop-up and on that
page - has **Copy link** for the address, and **Save screenshot** / **Copy screenshot** for the
card as a picture, to your downloads or straight to the clipboard. The picture is made by the
Chrome or Edge already on your computer, the same way the profile's screenshot is, which is
what lets it include the beatmap's cover art. A link keeps working after you switch profiles;
it shows the score as the profile it belongs to.

### Download Replay

Saves the score's replay to your Downloads folder like any download - the exact file osu!
wrote, so it can be dragged back into osu! to watch. It is named the way osu!lazer names a
replay it exports, e.g. `Tangy playing Taylor Swift - Cruel Summer (funny) [Seolv's Hard]
(2026-09-10_20-36).osr`. It is offered for any finished score whose replay osu! recorded; an
unfinished play never has one. If osu! has since deleted the file, the page says so rather than
starting a download that fails.

### Two scoring scales, as osu! has

osu! keeps every play on two scales, and its own profile page switches between them. So does
this: **Options -> Lazer scoring**, on by default, exactly as osu! defaults it.

- **Lazer scoring** (on) is osu!'s standardised scale, where a nomod SS is 1,000,000.
- **Classic scoring** (off) is the uncapped older scale. A play set on osu!stable shows the
  number stable itself recorded; a play set on lazer shows osu!'s own classic conversion of it,
  which runs into the millions.

Both numbers come from osu!'s own code - the pp helper returns them beside the pp - and both are
stored per score, so switching is instant and never needs a recalculation. It moves every
score-shaped number together: the score on each row and card, Total Score, Ranked Score, and
the level, which is a function of total score. A score tracked before this existed shows the
single number its replay carried, until **Other settings** recalculates it.

osu!stable plays are also listed **with the Classic mod**, as osu! lists them. osu! adds CL to
every stable score before scoring it - it is what selects classic slider accuracy and legacy
miss estimation - so a stable play reads `DTCL` here just as it does on osu!. That is display
only: medals, play time and pp eligibility all read the mods you actually chose.

## Medals

A Medals section laid out as osu!'s is, restricted to the medals a local profile can actually
decide for itself. The names, descriptions, icons and thresholds are osu!'s own.

They are shown in osu!'s own groups - **Mod Introduction**, then **Skill & Dedication** - with a
row of icons per family and nothing written beside them. Hover (or tab to) a medal for osu!'s
card - the group, the medal's name and description, and the date it was achieved, or *Locked*.
A newly earned medal also appears in **Milestones**, and the page announces it when it happens.

What exists is **not the same in every mode**, and that is osu!'s doing:

| family | osu!standard | taiko, catch, mania |
|---|---|---|
| Combo | 500 / 750 / 1,000 / 2,000 | none in osu! |
| Plays | 5,000 / 15,000 / 25,000 / 50,000 | none in osu! |
| Hits | none in osu! | four tiers, per mode |
| Beatmap pass | 1★ to 10★ | 1★ to 8★ |
| Beatmap full combo | 1★ to 10★ | 1★ to 8★ |
| Rank | top 50,000 / 10,000 / 5,000 / 1,000 | the same four |

**Mod Introduction** is one set shared by every mode, as on osu!: your first pass with a mod on
its own at its default settings - Easy, No Fail, Half Time, Hard Rock, Sudden Death, Perfect,
Double Time, Nightcore, Hidden, Flashlight, and Spun Out (osu!standard only). Two more go to
lazer's **Conversion** and **Fun** mods, which osu!stable does not have. Classic does not count
as a second mod, Nightcore is not Double Time, and a failed play earns nothing.

Medals are **derived from the scores, never stored**: removing a score that earned one takes the
medal with it. Two families are only as good as their inputs, and say so:

- **Rank** medals use the estimated pp-to-rank curve, so they inherit its approximation.
- **Full combo** needs the beatmap's own maximum combo. A lazer score can drop slider ends
  without breaking combo, so "no misses" alone is not enough. Scores tracked before that was
  recorded are reported as unknown rather than guessed either way; the section says how many,
  and **Other settings** can recalculate them.

## Total Play Time

Counted the way osu! counts it. osu!'s score processor adds, for every play, **the beatmap's
length divided by the play's rate, or the time from starting the play to submitting it,
whichever is less** - so DT counts two-thirds of the map, and quitting after thirty seconds
counts thirty seconds rather than the whole map.

- A **finished score** counts its beatmap's length at the speed it was played. The replay does
  not record when the play began, but for a map played to the end the length is the smaller of
  the two anyway.
- An **unfinished play** (quit, retry, fail) counts the time between osu! starting it and osu!
  accepting its submission, both read from lazer's log, capped at the map's length. Unfinished
  plays tracked before 1.5.0 have no start time recorded and count nothing rather than a guess.
- A beatmap's length runs from its first object to the end of its last, read once from the
  `.osu` file. A slider's tail at the very end of a map is not included.

## Favorite Beatmaps

The **Beatmaps** section, as osu! has it. Open the **⋯** menu on any row in **Scores** or
**Recent Plays** and choose **Favorite this beatmap**; it appears as osu!'s beatmap card, with
its cover, status, a coloured dot per difficulty, and the Explicit / Featured Artist /
Spotlight badges, and a video or storyboard icon when the set has one. Hover the dots for every
difficulty's name and star rating, and the card for the heart (unfavourite) and the download
link. The play button on the cover plays osu!'s own short preview of the song - streamed from
osu.ppy.sh only when pressed, about 100KB, and never stored. Press it again to pause, and again
to carry on from where it stopped.

While a preview plays, osu!'s audio bar comes up in the bottom-right corner: previous / next
through your favourites, play / pause, the position (drag to seek), a volume slider with mute,
and a button to play the next favourite automatically when one ends. It goes away a few seconds
after the music stops. The volume, mute and autoplay choices are remembered by your browser.

**Every profile shares one list** by default, since what you like to play does not change with
how you play it. Turn that off under **Options -> Profiles -> Every profile** and each profile
keeps its own copy of the list as it stands; turning it back on merges them. **Import** the
favorites of any osu! account from **Options -> Profiles** - one request per hundred, which
carries every card's details. While the list is empty it says how to fill it, with **Don't show
again** for anyone who would rather not.

Favorites are never sent to osu!. Favouriting makes **one request** to `osu.ppy.sh` for that
beatmap's details, which are then kept, so the card works offline. With no connection the
favourite is still saved, and the card shows what your machine knows - every difficulty from
lazer's `online.db`, with a star rating only where one of your own scores gives it - until a
later favourite, made online, fills it in.

## Play tracking filter

**Options -> Play tracking filter.** Which plays this profile records *at all*.

It is **off by default**, and switching it on changes nothing on its own: every criterion starts
wide open, so the filter only ever narrows on purpose. There are nine:

| | |
|---|---|
| **Keywords** | Matched against the song title, the artist, the difficulty name and the mapper. Separate several with commas - a play counts if any one appears. |
| **Mode** | osu!, osu!taiko, osu!catch, osu!mania. |
| **Difficulty** | The star rating **as played**, mods included, so a 5.50&#9733; beatmap under Double Time is judged at its Double Time rating. |
| **Mods** | Every mod in all four modes, each *may*, *must* or *must not* be used, plus a nomod badge. |
| **Categories** | Ranked, Qualified, Loved, Pending, Work in progress, Graveyarded, Never submitted. |
| **Length** | How long the beatmap runs at the speed it was played. |
| **Date added** | When the beatmap arrived on this machine. |
| **Date submitted** | When it was first uploaded to osu!. |
| **Date ranked** | When it was ranked, approved or loved. |

**A play the filter turns away is not recorded at all** - no score, no pp, no play count - and
it cannot be brought back afterwards. So the app says so every time: a line in the log, a
message on the page naming the criterion that declined it, a count in the Options menu, and a
mark on the menu entry for as long as a filter is narrowing anything. **Import past plays
applies the filter too**, and says how many it would leave out; it can be told to ignore the
filter for that one import.

### The mods section

A mod is in one of three states, and a click moves it to the next:

- **may be used** (the starting state) - the mod has no say in whether the play is tracked.
- **must be used** - every play tracked has to have it on.
- **must not be used** - no play with it on is tracked.

So Hidden left alone with everything else marked out tracks nomod and HD plays; Double Time set
to *must* with Hidden left alone tracks DT and DTHD. The **nomod** badge says what the grid
cannot: *must* means only plays with no mods at all, *must not* means never a nomod play. Under
the grid is a sentence saying what the current selection means, because sixty-seven badges
cannot be read as a rule.

Only *which* mods were on is compared, never how they were configured, and an osu!stable play is
matched on what you actually chose - osu! adds Classic to stable scores afterwards, which is not
a choice anyone made. Autoplay and Cinema are not listed at all: nothing in this app can ever
count them.

### What it cannot judge

- **Plays you quit, failed or retried** are matched on the other seven criteria. osu!lazer
  records no mods and no star rating for a play it discards, and those two simply do not judge
  it - the alternative, dropping what cannot be fully judged, would make this profile's play
  count disagree with osu!'s the moment the filter came on.
- **With osu!stable and no osu!lazer**, a beatmap's category and both of its submission dates
  have no source on the machine. Those three sections say so and stay out of the way; the other
  six work normally.
- **Beatmaps osu! has never ranked, approved or loved have no submission or ranked date at
  all** - osu! only records them for those three. Both date criteria therefore carry an
  *include beatmaps with no date on record* box, on by default, so narrowing a year does not
  silently stop tracking every graveyarded map.

## Importing plays you set while it was closed

Scores are only tracked while the app is running, so a session played with it closed is missed.
**Options -> Import past plays** covers that: pick how far back to look, check what would be
imported, then confirm.

It reads osu!lazer's own logs as well as your replays, so a past session comes back whole: the
finished plays from their replays, the quits, fails and retries osu! counted, and the ones made
offline or signed out that osu! could not submit. The check lists each kind with its count, all
ticked, and you untick what you do not want - bringing in last week's offline attempts does not
have to bring in last week's replays. A play on a beatmap you no longer have installed is
skipped, and the check says how many.

It never runs by itself unless you ask it to, and the warning in the dialog is the important
part - reach back further than the session you actually played with this playstyle and you will
pull in plays set with your normal one, which is the one thing a separate profile must not
contain.

Asking it to is **Options -> Other settings -> Import plays set while the app was closed**, off
by default. That runs this same import at every launch, over the gap the app was closed for and
no further, so you do not have to remember to. Everything above still applies to it: the play
tracking filter, the duplicate check, and plays on beatmaps you no longer have.

## Other settings

**Options -> Other settings**, and everything there belongs to the profile you are on - two
playstyles are two profiles and should not share how their scores count. The exceptions are
under *This install* - **Open in browser on start** and **Show beatmap metadata in original
language** - which are about the install rather than any one profile, and are saved to
`data/config.json`.

### Include pp for unranked mods

Off by default. On, it counts plays osu! refuses to rank because of their mods:

- **Relax and Autopilot.**
- **Customised rates** - DT at 1.45x, HT at 0.5x, and so on.

Autoplay and Cinema are never counted whatever this is set to: they are not plays.

Relax and Autopilot can be priced two ways, and they are far apart:

| | one real RX replay | one real AP replay |
|---|---|---|
| **As if the mod were off** (default) | 7.83 stars, 239pp | 4.45 stars, 101pp |
| **As osu! scores them** | 6.26 stars, 111pp | 3.14 stars, 57pp |

Both numbers come from osu!'s own difficulty and performance calculators - osu!'s difficulty
calculation is relax-aware, which is why the two disagree by more than 2x. The default is the
first, because "relax counts as nomod, relax + DT counts as DT" is usually what people mean. It
does flatter the score: a relax run reaches accuracy and combo the same player could not reach
by hand.

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
| Never submitted | not in lazer's `online.db` at all - it exists only on your machine |

pp still comes from osu!'s own calculator, which will price any beatmap it is handed. The two
settings are independent: a Loved map played with Relax needs both before it counts.

### Unfinished plays in Recent Plays

Plays that were started and never finished - quit, retried, or failed. They **always** count
toward your play count, monthly play counts and Most Played, because osu! counts them and a
profile that disagreed with the website about how much you had played would simply be wrong.
This setting only decides whether they are listed in Recent Plays.

| Setting | What Recent Plays shows |
| ------- | ----------------------- |
| Group retries on one map | *(default)* a run of attempts on one beatmap becomes one row, with the count |
| Show every attempt | one row per attempt |
| Hide them | scores only |

The default is grouping because of how much of a session these can be: on the session this was
built from there were 26 abandoned attempts against 19 finished ones, and listing each one turns
the feed into a list of retries. A run is only grouped while it is *consecutive*, so a finished
play in the middle still breaks it up the way it happened.

These rows carry no accuracy, mods or pp, and are shown dimmed with a "Didn't finish" note
rather than with zeroes standing in for numbers nobody recorded.

### Count plays osu! could not submit

On by default. See [Offline or signed out](#offline-or-signed-out).

### Import plays set while the app was closed

Off by default, and the default is the point: closing the app is how you stop tracking - a
different playstyle, a warm-up, someone else on your keyboard - so a launch normally brings in
nothing from the time it was shut.

Turn it on and every launch does [the import](#importing-plays-you-set-while-it-was-closed) for
you, over the gap and no more: back to when the app last ran, never further, and never past this
profile's own start. It is the same import as the manual one - your play tracking filter still
applies, plays already tracked are not doubled, replays someone else set are not taken - and it
says what it brought in. Per profile, so a profile tracking one playstyle can stay out of it
while another catches up on everything.

### Show beatmap metadata in original language

Off by default, and the same setting osu! has. On, each beatmap's artist and title read the way
the song writes them - 夜に駆ける rather than Yoru ni Kakeru - everywhere the page names one:
Recent Plays, Scores, Most Played, the score page, Favorite Beatmaps, Milestones and the live
notifications. A beatmap that has no separate original-language name is unaffected.

It belongs to the install rather than a profile, the way the language does, and sits in three
places: the first launch asks, the flag in the top right has a switch above the language list,
and it is here under *This install*. Switching it redraws what is already on screen - both names
are sent with every beatmap, so nothing is re-fetched.

Beatmaps you had already played are read for their original-language names once, in the
background on the next launch, so this works on a profile that has been running for years and
not only on what you play next.

### pp calculator

Says which osu! release's calculator prices your scores - the footer says so too. After osu!
reworks pp, a new version of this app ships the new calculator; when some of this profile's
scores were priced by an older one, this says how many and **Recalculate them** brings them up
to date from their replays, so every score is ranked against the others by one algorithm.

### Recalculating older scores

Scores tracked before a setting existed have no pp for anything osu! would not rank - there was
no reason to calculate one at the time. Turning the setting on offers to recalculate them from
their replay files. Nothing is deleted, and a score whose replay is no longer on disk is left
exactly as it is.

## Sharing and backing up

**Options -> Share & back up.**

- **Save as a web page** - this page as one `.html` file that **works like it**: show more, the
  mode tabs, View Details, the medal cards, the charts and the song previews all respond. It
  opens anywhere, with no app and no connection (osu!'s cover art and previews appear when
  there is one). Nothing in it can change the profile - those controls are gone, and the page
  answers itself from a snapshot taken when it was saved - and it holds nothing about your
  computer: no install paths, no other profiles.
- **Save as an image** - a full-page PNG, rendered by the Chrome or Edge already on your
  machine. Nothing is bundled: a headless browser would be several times the size of this whole
  app. Without one installed the button says so and points at the HTML export.
- **Export this profile** downloads the active profile as JSON: every score with its beatmap,
  plus the computed totals and rank.
- **Back up everything** downloads a copy of the whole database, all profiles included. It is
  written with `VACUUM INTO` rather than copied, because the database runs in WAL mode and a
  plain file copy can miss recent writes.

Replays on disk remain the real source of truth - `node scripts/reingest.mjs` rebuilds
everything from them - but these are portable and outlive the app.

### Putting it online, as a sample profile

The saved page is a plain file with everything inside it, so any static web host can serve it
as it is - there is nothing to install and nothing to configure. The simplest free one is
**GitHub Pages**:

1. Create a public repository (or use one you have), and add the saved file to it as
   `index.html`.
2. In the repository's **Settings -> Pages**, choose **Deploy from a branch**, pick the branch
   and `/ (root)`, and save.
3. A minute later it is at `https://<your-name>.github.io/<repository>/`.

To update it, save a new copy and replace `index.html`. Netlify Drop, Cloudflare Pages and any
ordinary web space work the same way: upload the one file.

### The live page is never shared

The page can reset a profile, delete one and remove scores, and none of those endpoints asks
who is calling. So the server refuses anything that is not coming from this machine, and there
is no setting that changes that. (Versions before 1.5.0 had an opt-in `shareOnNetwork`
setting; an old `config.json` that still has it is simply ignored.)

## What it contacts

No osu! API credentials are needed, and none are used. There is no OAuth application, no
client id, no secret and no login anywhere in this project. Nothing polls the API. An offline or
logged-out play is never submitted, so it never appears in the osu! API - not even after you
reconnect - which is why the app reads local files instead.

Every host it contacts is public, unauthenticated and optional:

| host | what for | if it fails |
|---|---|---|
| `assets.ppy.sh` | beatmap cover art, and medal icons | a drawn placeholder shows instead |
| `b.ppy.sh` | a favourite's audio preview, only when you press play | no preview |
| `osu.ppy.sh` | **Look up** in Profiles, importing favorites, and one request per new favourite | it says so; type a name and upload an image instead |
| GitHub | one check at startup for a newer release (`checkForUpdates`), and the download when you press update | no update notice |
| `data.ppy.sh` | the rank-curve dumps, only when `npm run rank:refresh` is run by hand | nothing; the checked-in curves keep working |

The profile lookup reads the public profile page - the same user object osu!'s API returns for
`/users/{user}`, which the page embeds in order to render itself. One request per press of the
button, never on a timer, and what it finds is copied into `data/` so it is never fetched
twice.

## Known limitations

- **Only osu!standard has been checked against known-correct pp.** taiko, catch and mania go
  through the same osu! code and should be right, but nothing verifies them yet. The rank
  curves cover all four modes and inherit that caveat.
- **Global rank is an estimate, and ages.** It is interpolated from a pp->rank curve built from
  a monthly data.ppy.sh sample of the whole ladder, so it drifts as the playerbase grows. See
  [maintaining.md](maintaining.md#refreshing-the-rank-curves).
- **Country rank is not shown at all.** A 10,000-user sample spread over ~200 countries is far
  too thin to estimate one, and a fabricated number would be worse than a dash.
- **Only the `.osu` files you already have can be used for pp**; a map you have never
  downloaded cannot be calculated offline.
- **Unfinished plays carry no score, and are lazer-only.** osu!lazer keeps no record of a play
  it discards, so a quit, a retry or a fail can be counted but never scored. Signed-in ones need
  osu! signed in, since the play is only visible once osu! has accepted the submission. A
  converted beatmap files under the beatmap's own ruleset, because the log never names the one
  it was played in.
- **osu!stable's unfinished plays are not counted.** stable writes no replay and no log for
  them; see [osu!stable is different](#osustable-is-different).
