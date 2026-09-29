# User guide

What each part of the app does. The README covers installing; `docs/architecture.md` covers how it
works inside.

## Running it

| Platform | Start it with | Where it lives while it runs |
| -------- | ------------- | ---------------------------- |
| Windows | double-click `osu! local profiles.exe` | the system tray |
| macOS | double-click `osu! local profiles` | the menu bar |
| Linux | run `./osu-local-profiles` (or `./start.sh`) | the system tray |

There's no console window. The icon's menu has **Open profile**, **Open log** and **Quit**, and on
Windows and Linux clicking the icon opens the page. The page has **Quit** at the top right, and a
pause button to stop recording without closing. Starting the app again while it runs just opens the
page. Output goes to `data/logs/app.log`.

On Linux, a desktop with no tray (GNOME without the AppIndicator extension) gets no icon, but the
app still runs; start it again to open the page. With no desktop, `./start.sh` runs it in the
terminal.

Windows may say it protected your PC from an unrecognised app, because the build isn't signed:
press **More info**, then **Run anyway**. It asks once.

macOS refuses the first launch for the same reason. Double-click `osu! local profiles`, close the
message, then in **System Settings -> Privacy & Security** press **Open Anyway** and confirm. (On
macOS 14 and earlier, right-click it and choose Open.) The launcher then lifts the quarantine from
the rest of its folder, so you don't need to allow apps from anywhere. Running
`xattr -dr com.apple.quarantine .` in the folder from Terminal does the same.

**The page opens straight away, even the first time.** On a first run the app reads your osu!
folder to match scores to beatmaps, which takes seconds to a few minutes depending on your library.
A bar at the top shows progress, and anything you play meanwhile is added, with pp, when it
finishes.

Plays set before a profile was created are never imported unless you ask, so switching the app on
doesn't pull in plays from your normal playstyle. See
[Importing plays you set while it was closed](#importing-plays-you-set-while-it-was-closed).

## Platform support

| Platform | State |
| -------- | ----- |
| **Windows** | Verified on both osu!lazer and osu!stable. |
| **Linux** | Tested and packaged on CI, but nobody has run it against a real osu! install yet. |
| **macOS** | The same, with Apple silicon and Intel builds. |

On Linux or macOS, `node src/main.ts --check-only` reports whether osu! was found and whether the
pp calculator starts. If osu! isn't found, point `installRoots` in `data/config.json` at it, and
please open an issue with the path.

**osu!stable on macOS and Linux** runs under Wine, with no single layout. Wineskin bundles, plain
`~/.wine` prefixes, CrossOver bottles and osu-winello are all checked. Anything else needs
`installRoots`.

**Options -> osu! folders** shows what was found and lets you add a folder by hand. If no osu!
install is found, the page still opens so you can point at one.

**osu!'s development client** (a Debug build of [ppy/osu](https://github.com/ppy/osu) run from
source) is found too, and tracked beside osu!lazer. It keeps its own folder next to lazer's
(`osu-development`, or `osu-development-2` and so on with `--debug-client-id`). Its plays count
toward the same profile, including mods you made yourself. It signs in to osu!'s development
server, so the account in its `game.dev.ini` counts as you.

## Plays that were never finished

osu! counts a play you quit, retried or failed, but osu!lazer only saves a replay for a map played
to the end. On one real session that was 26 of 45 counted plays with no replay. So the app reads
them from lazer's own session log, which records when osu! accepted each play.

That needs osu! to be signed in, which is also when osu! counts the play, so the two agree. These
plays have no accuracy, combo, mods or pp, because lazer never records any. They count toward your
play count, monthly play counts and Most Played, and show in Recent Plays as dimmed rows (see
[Unfinished plays in Recent Plays](#unfinished-plays-in-recent-plays)). You can remove them like a
score.

### Offline or signed out

Offline, osu! counts nothing, but lazer still logs `No token, skipping score submission`. The app
reads that line for solo plays that didn't reach a results screen, and matches the beatmap by the
name in the log, so this works without lazer's online beatmap database.

These count by default toward the play count, monthly play counts, Most Played, Recent Plays (as
**Not submitted**) and Total Play Time. osu! never received them, so counting them doesn't
contradict your osu! profile. To match your osu! profile exactly, turn off **Other settings ->
Count plays osu! could not submit**; they're still recorded, so turning it back on loses nothing.
The log can't say whether osu! would have counted an attempt (it ignores a play with no hits), so
an attempt quit before hitting anything counts here.

**Import past plays** can bring in attempts from before the app was running.

## osu!stable is different

Measured on a real stable install, and not something the app can work around:

- **A score arrives when you leave the results screen**, not when the play ends, because that's when
  stable writes the replay.
- **Plays you quit, failed or retried aren't counted.** Stable writes no replay or log for them. Its
  only trace is one "last played" time per beatmap, which can't count retries or tell a fail from a
  pass.
- **With osu!stable and no osu!lazer, every beatmap counts toward pp.** Only lazer ships the database
  that says whether a beatmap is ranked. pp is still calculated for every play from the beatmap in
  your Songs folder, so the profile counts everything and says so in **Scores**, and the *Include pp
  for unranked beatmaps* settings are dimmed. Install osu!lazer alongside and statuses resolve for
  stable's plays too.

The page says the first two once, wherever a stable install is found, with **Don't show again**.
The evidence is in [roadmap.md](roadmap.md) under 5.12.

## The profile page

Under the rank graph are osu!'s three figures: **Medals** (every medal across all modes), **pp**,
and [**Total Play Time**](#total-play-time).

Long sections start at five rows with a **show more** button (see [Show more](#show-more)). Both
charts show values on hover, by day on the rank graph and by month on Play History.

Global rank is an estimate (see [Known limitations](#known-limitations)). Country rank shows `-` on
purpose.

The flag in the top right switches the page's language, and the first launch asks.

### Rearranging the page

Hover a section and use the arrows in its top right corner, or drag it by the grip. The order is
saved with the profile. The arrows also work from the keyboard and on a touchscreen.

To hide a section, untick it under **Options -> Other settings -> Profile sections**. It disappears
from the page, its tab and saved web pages, and comes back where it was when ticked again.

## Profiles

**Options -> Profiles** manages several playstyles side by side ("left hand", "mouse only"), each
with its own scores, pp, level and start date. Only the selected one records plays. A new profile
starts empty and tracks from the moment you create it. The same dialog edits and resets the current
profile, imports from an osu! account, and has **Keep Favorite Beatmaps the same on every profile**.

Deleting a profile deletes its scores and asks for confirmation. The last profile can't be deleted;
use **Reset this profile** at the end of Edit profile instead.

### Editing the profile

Under *Edit profile*, or click the avatar or the name:

- **Name** renames the profile.
- **Country** is a two-letter code, shown as a flag.
- **Playstyle** shows under the name.
- **Picture** and **Banner** take a PNG, JPEG, WebP or GIF, or come from an osu! account (below).
  Both are per profile.

All optional. With no picture the page shows osu!'s guest avatar, and with no banner osu!'s default
one.

### Importing from an osu! profile

Under *Import from osu!*: type a username, user id or profile link, press **Look up**, tick what to
copy, and press **Import**.

| What | Ticked to begin with |
| ---- | -------------------- |
| Avatar | yes |
| Banner | yes |
| Flag | yes |
| me! | yes (replaces this profile's me!) |
| Favorite beatmaps | no (added to the list) |
| Medals | no |
| Best performances and pinned scores | no |

**Best performances and pinned scores** bring in up to 200 plays per mode, so a profile's pp and
accuracy match the website even for plays set on another PC. See
[Scores without a replay](#scores-without-a-replay).

**Medals** copies the medals the account already has, with their dates, but only the ones this app
has (see [Medals](#medals)). They join the medals your plays here earn, and a medal shows whichever
came first. Importing again replaces what the last import copied; resetting clears them.

Importing links the profile to that account, and is never automatic. A brand-new install offers it
once as an optional welcome; any way of closing it dismisses it for good. Nothing is sent to
`osu.ppy.sh` until you press a button, and there's no login or API key. If osu! is signed in on this
machine, its username is suggested, read from osu!'s own config file.

You can import someone else's account (an alt, a friend, a banner you like). It never decides which
plays are yours: that's whoever osu! says is signed in here, and replays other players set (ones you
watched) are left out on that basis. Plays with no name, lazer's `Guest`, and plays osu! never
received are always yours.

## The me! section

osu!'s description box, at the top of the page. Click it to write something; each profile has its
own.

It's written in **BBCode** with osu!'s toolbar (Bold, Italic, Strike Out, Header, Link, Spoiler Box,
lists, Image, Image Map and Font Size) and **Preview**. Paste or drop an image into the box, or press
Image with nothing selected, and it's stored with the profile. Up to 60,000 characters, so a page
imported from osu! arrives whole.

The app draws it with its own renderer: everything is escaped first, and only known tags become
formatting. An unknown or unclosed tag shows as typed, so a page imported from anyone's profile is
as safe as one you wrote.

## Scores

### Pinning and removing scores

Every score row has a **⋯** menu.

- **Pin to profile** puts it under **Pinned Scores**, above Best Performance. Pins are per mode and
  don't have to be in your top 100. Reorder by dragging, or with **Move up** / **Move down**.
- **Remove from profile** takes the score out of every section and every total: pp, play count,
  ranked score, level, the charts and Most Played.

Removing never deletes anything. Removed scores can be put back from **Options -> Other settings ->
Removed scores**. (If the row were deleted, the replay still in osu!'s folder would be imported again
next time, as a new play.)

To delete one for good, press the **red minus** beside it in Removed scores, or **Delete all
permanently**. Only the replay's fingerprint is kept, so it's never imported again. A reset clears
those too.

### View Details

**View Details** opens the score like osu!'s score page, in a card over the profile: the beatmap,
cover, grade, osu!'s accuracy dial (or the big grade letter for an osu!stable score), mods, total
score, who played it, when and on which client, and every judgement.

Below that is the **pp breakdown**: how much came from aim, speed, accuracy and flashlight (taiko:
difficulty and accuracy; mania: difficulty; catch has none), with the osu! release that priced it.
Close the card with the X, Escape, or a click beside it. Its own **⋯** has Pin and the rest.

The score's **Global Rank** and **watch count** aren't shown, since a local profile has no
leaderboard.

**Every score has its own page** at `http://localhost:7272/scores/<number>`. The card's **⋯** menu
has **Copy link**, and **Save screenshot** / **Copy screenshot** for the card as a picture, made by
the Chrome or Edge already on your computer. A link keeps working after you switch profiles.

### Download Replay

Saves the score's replay to your Downloads folder, the exact file osu! wrote, named the way
osu!lazer names an exported replay (for example `Tangy playing Taylor Swift - Cruel Summer (funny)
[Seolv's Hard] (2026-09-10_20-36).osr`). Offered for any finished score with a replay. If osu! has
since deleted the file, the page says so.

### Two scoring scales

**Options -> Lazer scoring**, on by default as on osu!:

- **Lazer scoring** (on) is osu!'s standardised scale, where a nomod SS is 1,000,000.
- **Classic scoring** (off) is the older uncapped scale: stable's own number for a stable play, and
  osu!'s classic conversion for a lazer play.

Both come from osu!'s own code and are stored per score, so switching is instant. It changes every
row and card, Total Score, Ranked Score and the level together.

osu!stable plays are listed **with the Classic mod**, as on osu!, which adds CL to every stable score
before scoring it. That's display only: medals, play time and pp eligibility use the mods you chose.

## Medals

A Medals section like osu!'s, limited to medals a local profile can decide. Names, descriptions,
icons and thresholds are osu!'s own. They're grouped as on osu! (**Mod Introduction**, then **Skill
& Dedication**). Hover a medal for its card. A newly earned one appears in **Milestones**, and the
page announces it.

What exists differs by mode, as on osu!:

| family | osu!standard | taiko, catch, mania |
|---|---|---|
| Combo | 500 / 750 / 1,000 / 2,000 | none |
| Plays | 5,000 / 15,000 / 25,000 / 50,000 | none |
| Hits | none | four tiers, per mode |
| Beatmap pass | 1★ to 10★ | 1★ to 8★ |
| Beatmap full combo | 1★ to 10★ | 1★ to 8★ |
| Rank | top 50,000 / 10,000 / 5,000 / 1,000 | the same |

A star medal is for its own star rating only: a 5.4★ pass earns the 5★ medal alone. The rating
includes your mods, and as on osu!, only a ranked or approved map counts (not qualified or loved),
with no mod that makes it easier or plays it for you, and on osu!mania no key mod or Dual Stages.

**Mod Introduction** is shared by every mode: your first pass with a mod on its own at default
settings (Easy, No Fail, Half Time, Hard Rock, Sudden Death, Perfect, Double Time, Nightcore,
Hidden, Flashlight, and Spun Out in osu!standard), plus lazer's **Conversion** and **Fun** mods.
Classic doesn't count as a second mod, Nightcore isn't Double Time, and a failed play earns nothing.

Medals are worked out from your scores, so removing a score removes a medal it earned. Medals
imported from osu! are the exception. **Rank** medals use the estimated rank. **Full combo** needs
the beatmap's maximum combo; scores tracked before that was recorded show as unknown, and **Other
settings** can recalculate them.

## Total Play Time

Counted as osu! counts it: for each play, the beatmap's length divided by the play's speed, or the
time from starting to submitting it, whichever is less. So DT counts two-thirds of the map, and
quitting after thirty seconds counts thirty seconds.

- A **finished score** counts the beatmap's length at the speed played.
- An **unfinished play** counts the time between osu! starting it and accepting it, from lazer's
  log, capped at the map's length. Unfinished plays tracked before 1.5.0 count nothing.

## Favorite Beatmaps

The **Beatmaps** section, as on osu!. In the **⋯** menu of any row in **Scores** or **Recent
Plays**, choose **Favorite this beatmap**. It appears as osu!'s beatmap card. Hover the difficulty
dots for each difficulty's name and star rating. The play button on the cover plays osu!'s short
preview of the song, streamed only when pressed.

While a preview plays, osu!'s audio bar appears in the bottom right corner: previous and next,
play/pause, seeking, volume, and autoplay of the next favourite. Your browser remembers the volume,
mute and autoplay.

**Every profile shares one list** by default. Turn that off under **Options -> Profiles -> Every
profile** and each profile keeps its own copy; turning it back on merges them. You can **Import**
any account's favorites from **Options -> Profiles**.

Favorites are never sent to osu!. Favouriting makes one request to `osu.ppy.sh` for the beatmap's
details, which are kept so the card works offline. With no connection the favourite is still saved,
and the card shows what your machine knows until it can be filled in.

## Play tracking filter

**Options -> Play tracking filter** decides which plays this profile records at all.

It's **off by default**, and switching it on changes nothing by itself, since every criterion starts
wide open. There are nine:

| | |
|---|---|
| **Keywords** | Song title, artist, difficulty name and mapper. Separate several with commas; a play counts if any one appears. |
| **Mode** | osu!, osu!taiko, osu!catch, osu!mania. |
| **Difficulty** | The star rating as played, mods included. |
| **Mods** | Every mod in all four modes, each *may*, *must* or *must not* be used, plus a nomod badge. |
| **Categories** | Ranked, Qualified, Loved, Pending, Work in progress, Graveyarded, Never submitted. |
| **Length** | How long the beatmap runs at the speed played. |
| **Date added** | When the beatmap arrived on this machine. |
| **Date submitted** | When it was first uploaded to osu!. |
| **Date ranked** | When it was ranked, approved or loved. |

**A play the filter turns away isn't tracked**: no score, no pp, no play count. So the app tells you
each time: a line in the log, a message naming the criterion, a count in the Options menu, and a mark
on the menu entry while a filter is narrowing anything. It's also listed under [Plays not
tracked](#plays-not-tracked). **Import past plays** applies the filter too, and can be told to
ignore it for one import.

### The mods section

Click a mod to cycle it through three states:

- **may be used** (the starting state): the mod doesn't affect whether a play is tracked.
- **must be used**: every tracked play needs it.
- **must not be used**: no play with it is tracked.

So Hidden left alone with everything else set to *must not* tracks nomod and HD plays. The **nomod**
badge covers what the grid can't: *must* means only plays with no mods, *must not* means never a
nomod play. A sentence under the grid spells out the current selection.

Only which mods were on is compared, not their settings, and an osu!stable play is matched on the
mods you chose (not the Classic mod osu! adds). Autoplay and Cinema aren't listed, since they never
count.

### What it can't judge

- **Plays you quit, failed or retried** have no mods or star rating, so those two criteria don't
  judge them. Dropping them instead would make your play count disagree with osu!'s.
- **With osu!stable and no osu!lazer**, category and both submission dates have no source, so those
  sections say so and stay out of the way.
- **Beatmaps osu! has never ranked, approved or loved have no submitted or ranked date.** Both date
  criteria have an *include beatmaps with no date on record* box, on by default, so narrowing a year
  doesn't quietly stop tracking every graveyarded map.

### Plays not tracked

**Options -> Other settings -> Plays not tracked** lists every play this profile turned away and
why: declined by the filter (naming the criterion), set by another player, or a replay that couldn't
be read. Each shows who set it and whether it was turned away while tracking, by Import past plays,
or by the import at launch. It's the first place to look when a play never appeared.

**Track anyway** brings one play in regardless, as if you had just played it. It never adds a play
twice, and can't bring back a replay osu! has deleted. Tracking another player's replay asks twice.
The red minus deletes a play for good, as in Removed scores. The list keeps the newest 1,000, and a
reset empties it.

**It's me** appears beside Track anyway on a play set by another player. It asks osu! whether that
name is yours under another name; if it is, every name your account has had counts as yours, and the
plays turned away under them are tracked (the filter still applies).

## Importing plays you set while it was closed

Plays are only tracked while the app runs. **Options -> Import past plays** covers the rest: pick
when you played, check what would be imported, then confirm.

- **A preset** (1 hour up to 1 day) imports from that long ago up to now.
- **All** imports every play osu! has kept on this computer. Checking reads every replay, so it can
  take a minute or two.
- **From** and **To** pick your own range. Tick **Earliest** to start from the oldest play, and
  **Now** (ticked by default) to run up to the present.
- **Look in**, when more than one osu! install was found, lets you untick installs this import
  shouldn't read.
- It reads osu!lazer's logs as well as replays, so a past session comes back whole: finished plays,
  counted quits and retries, and offline attempts. Each kind is its own tick box with its count.
- A play on a beatmap you no longer have is skipped, and the check says how many.

Only reach back as far as the session you actually played with this playstyle, or you'll pull in
plays from your normal one. It never runs by itself unless you turn on [Import plays set while the
app was closed](#import-plays-set-while-the-app-was-closed).

### Scores without a replay

The same dialog has three ways to add plays osu! no longer has a replay for:

- **Import replay files...** takes `.osr` files you have, for example downloaded from osu!'s website.
  Choose several, or drag them onto the dialog. The app keeps its own copy, so deleting yours loses
  nothing.
- **Import from a score link...** takes a score's link on osu.ppy.sh. **Check** shows the score and
  who set it, and **Import** brings it in.
- **Enter a score by hand...** is the last resort: pick the beatmap, then type the judgements, max
  combo, mods and date. Everything is checked against the beatmap.

For all of these, and for best performances imported from your osu! account, pp is calculated here
from the score's numbers exactly as osu! calculates it, and recalculated here after a pp rework with
no internet needed. A beatmap you don't have is downloaded once and kept. If the real replay of one
of these plays turns up (on your computer, from Import past plays, or a file you add), it takes that
score's place, keeping its pin.

These scores are marked on every row, card and shared page: **No replay file** for one from osu!, and
**Manually entered by hand** for one you typed. Neither can be downloaded as a replay. Any score osu!
has gets **View osu! score link** in its ⋯ menu.

## Other settings

Everything in **Options -> Other settings** belongs to the current profile, except the settings under
*This install* (**Open in browser on start**, **Show beatmap metadata in original language** and
**Font**), which are saved to `data/config.json`.

### Include pp for unranked mods

On by default for profiles made from 1.24.0; older profiles keep osu!'s rule (off) until you change
it. On, it counts plays osu! won't rank because of their mods: **Relax and Autopilot**, and **custom
rates** such as DT at 1.45x. Autoplay and Cinema never count.

Relax and Autopilot can be priced two ways:

| | one real RX replay | one real AP replay |
|---|---|---|
| **As osu! scores them** (default) | 6.26 stars, 111pp | 3.14 stars, 57pp |
| **As if the mod were off** | 7.83 stars, 239pp | 4.45 stars, 101pp |

Both are osu!'s own numbers; they differ because osu!'s difficulty calculation accounts for Relax.
The second makes "relax counts as nomod" true, but flatters the play, since relax reaches accuracy
and combo you couldn't by hand. Profiles made before 1.25.0 keep the second until you change it.
Both are stored, so switching is instant.

When a profile counts something osu! wouldn't, the page says so above Best Performance and marks the
affected rows.

### Include pp for unranked beatmaps

Six separate choices: Loved, Qualified, Pending, Work in progress, Graveyarded, and Never submitted
(a map that exists only on your machine). On for profiles made from 1.24.0, off for older ones. pp
still comes from osu!'s calculator. This and the mod setting are independent: a Loved map played
with Relax needs both.

### Unfinished plays in Recent Plays

Quit, retried and failed plays always count toward your play count, monthly play counts and Most
Played, as on osu!. This only decides how Recent Plays lists them:

| Setting | What Recent Plays shows |
| ------- | ----------------------- |
| Group retries on one map | *(default)* consecutive attempts on one beatmap as one row, with the count |
| Show every attempt | one row per attempt |
| Hide them | scores only |

These rows have no accuracy, mods or pp, and show dimmed with a "Didn't finish" note.

### Show more

How many rows each **show more** adds to Best Performance, Most Played Beatmaps, Recent Plays,
Milestones and Favorite Beatmaps. 25 by default, as on osu!; type any number from 1 to 10,000.
Favorite Beatmaps counts rows of two cards. **All at once** shows the whole list in one press.

### Count plays osu! could not submit

On by default. See [Offline or signed out](#offline-or-signed-out).

### Import plays set while the app was closed

Off by default, because closing the app is how you stop tracking. Turn it on and every launch runs
[the import](#importing-plays-you-set-while-it-was-closed) over the time the app was closed, never
further back than when it last ran or before this profile started. The filter and duplicate checks
still apply, and it says what it brought in. Per profile.

### Show beatmap metadata in original language

Off by default, the same setting osu! has. On, artist and title read as the song writes them
(夜に駆ける rather than Yoru ni Kakeru) everywhere the page names a beatmap. It's also offered at
first launch and in the language menu.

### Font

**Nunito** by default, which comes with the app and is the closest free font to the one osu! uses.
It's drawn a little heavier than normal so small text looks as solid as on osu!'s site. **System
font** uses your computer's own font (Segoe UI on Windows) instead. If you have osu!'s own font,
Torus, installed, the page uses that either way.

### pp calculator

Says which osu! release's calculator prices your scores. After osu! reworks pp, a new version of this
app ships the new calculator, and **the first launch after updating recalculates every score** the old
one priced, in every profile, in the background. A score whose replay has been deleted keeps its old
pp. **Recalculate every score** does the whole thing on demand.

#### pp from your own osu! source

If you run osu! from source (a clone of [ppy/osu](https://github.com/ppy/osu), perhaps with your own
pp changes or mods), the app can price every score with your code instead. Type the folder you cloned
ppy/osu into (the one with `osu.Game` in it, not osu!'s data folder) and press **Build and use**. It
needs git and the .NET 10 SDK.

- The app builds its own calculator from your clone into `data/pp-source/` (about 50MB). The first
  build takes a minute or so. It writes osu!'s usual `bin/` and `obj/` in your clone, which git
  ignores.
- **Every score in every profile is then recalculated with it**, including plays on mods only your
  source has.
- Each score says what priced it, for example **osu! source 325c8f5**, with `+` and a short code when
  your clone had uncommitted changes. After you change your source, **Rebuild** appears.
- **Use the release calculator again** switches back and recalculates everything.
- It's all or nothing: a profile never mixes pp from two formulas. If your source won't build or
  start, nothing changes. If it won't start at a launch, no pp is stored until it does.

## Sharing and backing up

**Options -> Share & back up.**

- **Save as a web page** saves the page as one `.html` file that works like it: show more, the mode
  tabs, View Details, medals, charts and previews all respond. It opens anywhere with no app. Nothing
  in it can change the profile, and it holds nothing about your computer.
- **Save as an image** makes a full-page PNG with the Chrome or Edge already on your machine.
- **Back up everything** downloads `osu-local-profiles-backup-<date>.zip`: every profile, with its
  scores, pictures and me! images, laid out like the `data` folder.
- **Restore from backup** takes that zip (or a `.db` from before 1.22.0), says which profiles it holds,
  and asks before doing anything. The app restarts to swap it in. The profiles it replaces are moved
  to `data/before-restore-<date and time>/`. Plays set between the backup and now aren't imported;
  use **Import past plays** for those.
- **The data folder** is shown with an **Open folder** button. With the app closed, copying the folder
  is a complete backup too. (While it runs, recent writes can sit in `profiles.db-wal`.) `config.json`
  in that folder holds this install's settings, which is why backups leave it out.
- **Export** has **.csv** and **.xlsx** buttons. The .csv is every score in the profile, all modes,
  highest pp first, with over 40 columns; delete what you don't want. The .xlsx has the same scores,
  then a sheet per mode, **Summary**, **Most played**, **Favorite beatmaps** and **Medals**, each with
  filters ready. Both follow this profile's settings, leave out removed scores, and use the page's
  language.
- **Export this profile's scores (JSON)** is for other tools. It isn't a backup and can't be
  restored from.

Replays on disk are the real source of truth (`node scripts/reingest.mjs` rebuilds everything from
them), but these exports outlive the app.

### Putting it online

A saved page is one file, so any static host can serve it. With **GitHub Pages**:

1. Add the saved file to a public repository as `index.html`.
2. In the repository's **Settings -> Pages**, choose **Deploy from a branch**, pick the branch and
   `/ (root)`, and save.
3. A minute later it's at `https://<your-name>.github.io/<repository>/`.

To update it, save a new copy and replace `index.html`.

### The live page is never shared

The page can reset and delete profiles without asking who's calling, so the app only answers
requests from this computer, with no setting to change that.

## Updating

The app checks GitHub for a newer version when it starts and once a day while it runs. When there is
one:

- **Update to 1.x.x** appears at the top of the page and the tray icon gets a dot. The dialog lists
  what each new version changes.
- **Update and restart** installs it now. **When I quit** downloads it now and installs it when you
  quit. The tray menu has both too.
- After an update, the first start shows what it brought, once.
- An update waiting two weeks, or one marked important, is also mentioned at the foot of the page.

**Options -> Auto-update** downloads new versions in the background and installs them when you quit
or next start, never mid-session. It's off until you turn it on, and never downloads on a
connection Windows or Linux reports as metered (macOS isn't asked).

An update downloads the whole app, about 65MB, and never touches `data/`.
`"checkForUpdates": false` in `config.json` turns off every check.

## What it contacts

No osu! API credentials, no login, and nothing polls osu!. An offline play never reaches osu!'s API,
even after you reconnect, which is why the app reads local files.

| host | what for | if it fails |
|---|---|---|
| `assets.ppy.sh` | cover art and medal icons | a drawn placeholder |
| `b.ppy.sh` | a favourite's audio preview, when you press play | no preview |
| `osu.ppy.sh` | Look up, imports, score links, a new favourite's details, and downloading a beatmap a score needs | it says so |
| GitHub | the update check, patch notes and the update download | no update notice |
| `data.ppy.sh` | the rank curves, only when `npm run rank:refresh` is run by hand | the included curves keep working |

## Known limitations

- **Only osu!standard has been checked against known-correct pp.** taiko, catch and mania use the
  same osu! code and should be right, but nothing verifies them yet.
- **Global rank is an estimate, and ages.** It comes from a pp-to-rank curve built from a data.ppy.sh
  sample, so it drifts as the playerbase grows. See
  [maintaining.md](maintaining.md#refreshing-the-rank-curves).
- **Country rank isn't shown.** A 10,000-player sample over about 200 countries is far too thin.
- **pp needs the beatmap.** A map you've never downloaded can't be priced offline, though a score
  imported from osu! downloads the one it needs.
- **Unfinished plays have no score, and are lazer-only.** They need osu! signed in, since the play only
  shows once osu! accepts it. A converted beatmap files under the beatmap's own mode, because the log
  never names the one it was played in.
- **osu!stable's unfinished plays aren't counted.** See [osu!stable is
  different](#osustable-is-different).
