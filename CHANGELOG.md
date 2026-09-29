# Changelog

## 1.29.0

- **The page is set in Nunito, the closest free font to osu!'s own.** It's drawn a little heavier
  than usual, so small text looks as solid as on osu!'s site. **Options -> Other settings -> Font**
  switches back to your computer's own font.

- **Beatmap rules replace keywords in the play tracking filter.** Each rule looks at a field you
  choose (title, artist, difficulty name, mapper, beatmap set owner, source or tags) and can have
  several conditions that must all hold. A play is tracked if its beatmap matches any rule, and a
  sentence under the rules says what they track.
  - **Mapper** uses osu!'s own record of who mapped each difficulty, so guest difficulties count,
    and so do maps made under an old name.
  - Your keywords were kept as a rule that tracks exactly the same plays as before.

- **Hide profile sections you don't want.** **Options -> Other settings -> Profile sections**
  has a box for each one. A hidden section leaves the page and its saved copies, and comes back
  where it was.

- **A profile with no banner shows osu!'s default banner**, instead of its best play's cover art.

- **Only scores you entered by hand are tagged.** Scores imported from osu! no longer say
  "No replay file"; "Manually entered by hand" stays.

- **Option descriptions and notes are shorter and plainer**, in Options, the play tracking
  filter, Share and Import past plays, and on the profile.

- **Import from osu! and Import past plays point to each other**, so it's clear which one brings
  in scores from your osu! profile and which from this computer.

- **Everything new in this release is translated** into all 15 languages.

## 1.28.1

<!-- important -->

- **Plays set after an osu! name change are tracked again.** If osu! still remembered the name
  you had before a rename, every play you set went to **Plays not tracked** as "set by another
  player", under your own new name. A play that arrives while the app is tracking and was set
  moments before is now always yours, whatever name is in it. A replay you download to watch
  carries the time it was first set, so those are still told apart.

- **"It's me" for a play set by another player.** The new button beside **Track anyway** asks
  osu! whether that name is yours under another name. If it is, every name your account has had
  counts as yours from then on, and the plays turned away under them are tracked (the play
  tracking filter still applies).

- **Everything new in this release is translated** into all 15 languages.

## 1.28.0

- **Export your scores to a spreadsheet.** **Share & back up -> Export** has **.csv** and **.xlsx**
  buttons. The .csv is every score in the profile, highest pp first, with over 40 columns; delete
  the ones you don't want. The .xlsx has the same scores, then a sheet for each game mode, the
  profile's totals, most played beatmaps, favorite beatmaps and medals, each with filters ready.
  Headers are in the page's language.

- **Import your medals from osu!.** Tick **Medals** in **Import from osu!** to copy the medals your
  account already has, with their dates. Only the medals this app has are copied.

- **Star medals follow osu!'s own rules.** Passing a 5-star map earns the 5-star medal alone, not
  every medal below it, and a star medal needs a ranked map (not loved or qualified) with no mod
  that makes it easier. Medals the old rule gave out are taken back the first time this version
  starts.

- **Imported scores find their replays on this computer.** After **Import from osu!** or a score
  link, every osu! install is searched for the replays of those plays, and each one found takes its
  score's place, so it can be watched and downloaded. Importing from osu! again does this for
  scores imported before.

- **Choose which osu! installs Import past plays looks in.** With more than one found, **Look in**
  lists them all, ticked; untick any this import should skip.

- **The mode switcher shows osu!'s mode icons**, as osu!'s own profile page does, with each mode's
  name on hover.

- **Run osu! from source? Price every score with your own code.** **Options -> Other settings -> pp
  calculator** can build the app's calculator from your clone of ppy/osu, so your own pp changes
  and mods are priced. It applies to every profile and recalculates every score, and so does
  switching back. Needs git and the .NET 10 SDK.

- **View osu! score link** is the new name for **View on osu!** in a score's **···** menu.

- The JSON export no longer includes scores you removed from the profile.

- **Everything new in this release is translated** into all 15 languages.

## 1.27.0

- **Updates are easier to notice, and can install themselves if you want.**
  - **The app checks for updates once a day while it's open**, not just at start, and a new
    version appears on the page without reloading.
  - **See what's new before you update**, and what changed after: the update dialog lists each
    version's changes, and the first start after an update shows what it brought.
  - **The button says which version**: **Update to 1.28.0**.
  - **Auto-update**, a new switch in **Options**, downloads new versions in the background and
    installs them when you quit or next start. Off unless you turn it on, and never on a
    connection Windows or Linux says is metered.
  - **When I quit**, in the update dialog: download now, install when you're done playing.
  - *Withdrawn after release:* this version also shipped downloading only the changed parts of
    the app, but those parts crowded every release page with files that looked like downloads.
    Updates download the whole app, as before.
  - **The tray icon shows a dot** when an update is waiting, and its menu can **Update to ... and
    restart** or show **What's new**.
  - **An update that has waited two weeks, or one that fixes something important, says so** at the
    foot of the page. Dismiss it and it stays away for a week.
  - `"checkForUpdates": false` in `config.json` still turns every check off.

- **osu!'s development client is tracked too.** A Debug build of osu! run from source is found
  beside osu!lazer and tracked alongside it, so plays with your own mods land on your profile.
  Thanks to Crafterdark2 on Reddit for tracking down what was missing.

- **Choose how much show more shows.** **Options -> Other settings -> Show more** sets how many rows
  each press adds (25, 50, 100 or any number), or **All at once**.

- **See every play the app didn't track, and bring one back.** **Options -> Other settings -> Plays
  not tracked** lists each play turned away (by your filter, set by another player, or a replay it
  couldn't read) with whose it was and why. **Track anyway** brings one in, and the red minus
  deletes one for good. Removed scores and Plays not tracked now show even when empty.

- **Import past plays over any time range, or everything.** Pick **From** and **To**, or press
  **All** to import every play osu! has kept on this computer.

- **Import replay files.** **Import past plays -> Import replay files...** takes `.osr` files you
  have, such as ones downloaded from osu!'s website. Choose several, or drag them onto the window.
  The app keeps its own copy.

- **Import a score from its link on osu.ppy.sh**, for a play whose replay you no longer have. Its pp
  is calculated here from the score's own numbers, exactly as osu! calculates it, and recalculated
  here after a pp rework. A beatmap you don't have is downloaded once and kept.

- **Enter a score by hand, as a last resort.** Pick the beatmap, type the judgements, combo and
  mods, and the pp is calculated from what you entered. It's checked against the beatmap and
  marked "Manually entered by hand" everywhere.

- **Best performances imported from your osu! account are calculated here too**, so a pp rework
  updates them with everything else. If the real replay of one turns up later, it takes that
  score's place, keeping its pin.

- **Scores with no replay say so.** "No replay file" marks a score imported from osu!, and "Manually
  entered by hand" one you typed. Any score osu! has now has **View on osu!** in its **···** menu.

- **Remove from profile is red** in a score's **···** menu, so it isn't pressed by mistake.

- **Everything new in this release is translated** into all 15 languages, and a score's **···**
  button is labelled for screen readers.

## 1.26.0

- **Your finished plays are tracked even if you imported someone else's osu! account.** Importing
  an alt's or a friend's avatar and name used to make the app treat that account as the profile's
  owner, so your own finished plays were turned away. Whose plays count is now decided by who osu!
  says is signed in on this computer. **Import past plays** brings back plays refused this way.

- **Newly ranked maps get their ranked status.** A map ranked after osu!lazer last downloaded its
  beatmap list stayed "never submitted". Plays on it are now updated once lazer has a newer list,
  and lazer can update that list while this app is open, which it couldn't before.

- **Recalculating pp no longer erases it for maps you've deleted.** Those scores keep the pp they
  had.

- **A smaller beatmap index.** About a third smaller for a large osu!lazer library (365MB -> 221MB
  for 250,000 beatmaps), and beatmaps you delete now leave it too.

- **Less work each time the page updates.** The app no longer searches your PATH for a browser on
  every check-in, which took about 40ms each time on Windows.

- Counts of 2-4 read correctly in Polish.

## 1.25.0

- **Beatmaps downloaded while the app is open are found** (osu!stable and McOsu). A play on a map
  you'd just downloaded, including every multiplayer pick you didn't have, showed as "Unknown
  beatmap" with no pp. Plays stored like that are fixed at the next start.

- **ScoreV2 and the rest of osu!stable's mods are shown.** ScoreV2, mania's key counts, Fade In,
  Random and Mirror were missing from stable plays. osu! doesn't rank ScoreV2, so those plays count
  toward pp only while unranked mods are counted.

- **Relax and Autopilot are priced by osu!'s own pp calculator by default** on new profiles. "As if
  the mod were off" is still in **Options -> Other settings**, and existing profiles keep what they
  had.

- **A replay that isn't tracked says so.** When a replay is turned away because someone else set it
  or it can't be read, the page says who set it and on which map.

- **Finding your beatmaps is a small note** in the top right corner instead of a banner across the
  page.

## 1.24.0

- **McOsu support.** McOsu plays are tracked like osu!stable and osu!lazer plays, and priced with
  osu!'s current pp system, so the pp can differ from what McOsu shows.
  - Found automatically in any Steam library, or added under **Options -> osu! folders**.
  - Tracked live, and **Import past plays** brings in older ones.
  - The speed slider shows as Double Time or Half Time at that rate, and CS/AR/OD/HP overrides as
    Difficulty Adjust.
  - Nightmare and McOsu's experimental mods appear as one mod, **MC**.
  - McOsu only saves finished, passed plays, so fails, quits and retries aren't counted, and McOsu
    plays have no replay to download.

- **Unranked mods and beatmaps count toward pp by default** on new profiles. Existing profiles keep
  counting what they counted before. Turn them off in **Options -> Other settings**.

- **A smaller download.** The bundled pp calculator is about half its old size (Windows download 89MB
  -> 61MB). Every release checks on every platform that it calculates exactly the same pp.

- The **Don't show again** buttons on the Scores note and the empty Favorite Beatmaps hint are now
  translated.

## 1.23.0

- **Mod badges show osu!'s own icon for every mod**, using osu-web's own markup and styling.

- **Grades are osu!'s own badges**, and an osu!stable score's card shows stable's own grade letters.

- **A profile with no picture shows osu!'s guest avatar**, as osu! does.

- **osu! local profiles is now licensed under the AGPL-3.0-or-later**, osu-web's licence, which is
  what lets the page use osu-web's artwork. Releases up to 1.22.0 stay MIT. Every download carries
  `LICENSE` and `THIRD-PARTY-NOTICES.md`, and the footer links the licence.

## 1.22.0

- **Back up everything is now a complete backup, and it can be restored.**
  - **Back up everything** saves a zip of every profile with its scores, pictures and me! images.
    The old download was the database alone, so pictures were lost.
  - **Restore from backup** takes that zip, or a `.db` from an earlier version, says which profiles
    it holds, and asks first. What it replaces is moved aside, not deleted.
  - **The data folder** is shown with an **Open folder** button.
  - The JSON export moves under a new **Export** heading.

- **A pp rework reaches every score you already have, by itself.** The first launch after an update
  with a new osu! calculator recalculates every score the old one priced, in the background.
  **Recalculate every score** does the same on demand.

- **pp is calculated by osu! 2026.916.0**, up from 2026.730.0. Not a rework: same numbers, plus one
  fix for a stable score whose recorded total is 0. The pp helper now targets .NET 10.

- **A shared copy reads properly away from the app.** Saved web pages showed `stats.rankedScore`
  and the like in place of labels when opened anywhere but the running app.

## 1.21.0

- **An Intel Mac build.** Releases now include `osx-x64` beside `osx-arm64`.

- Every em dash in the app's text is now a plain hyphen.

## 1.20.0

- **Beatmap names in their original language**, the way osu!'s own setting does it: 夜に駆ける
  instead of Yoru ni Kakeru, everywhere the page names a beatmap. Off by default; switch it on at
  first launch, in the language menu, or in Other settings.

- **Optionally, import the plays you set while the app was closed.** Off by default, since closing
  the app is how you stop tracking. **Other settings -> Import plays set while the app was closed**
  imports, per profile, everything played since the app last ran, through the same checks as
  **Import past plays**.

## 1.19.0

- **osu! is found wherever you installed it.** The app now asks Windows (file associations, the
  uninstall entry, your shortcuts) and reads osu!lazer's `storage.ini`. If a client is still
  missing, it searches every drive in the background, and remembers what it finds. With several
  osu! folders side by side, it picks the one you actually play.

- **Options -> osu! folders** shows what was found, lets you add a folder by hand, and searches again
  on demand.

- **"No osu! installation found" no longer closes the app.** The page opens so you can point it at
  your osu! folder.

- **The page can be read in your own language**, picked from a flag in the top right and asked at
  first launch. 15 so far: Dansk, Deutsch, Español, Suomi, Français, Italiano, 日本語, 한국어,
  Nederlands, Polski, Português (Brasil), Русский, Svenska, 简体中文 and 繁體中文. Numbers and dates
  follow the language too.

## 1.18.0

- **Import past plays can ignore your play tracking filter.** A new tick box, on by default and
  reset each time the dialog opens. Untick it to import everything found.

- **Replays you watched are no longer counted as your own plays.** osu! saves replays you watch in
  the same folders as your own, so Import past plays could fill a profile with other people's
  scores.
  - Plays set by someone else aren't tracked, and the import dialog lists them.
  - Plays already tracked that were someone else's are removed once, automatically. They're
    removed, not deleted, and can be put back from Removed scores.
  - Plays set before you renamed, plays made signed out, and offline plays are kept, whatever name
    they carry.

- **Import your best performances and pinned scores from osu!.** Up to 200 best performances per
  mode, with osu!'s own pp, so the profile matches your osu! profile, including plays set on another
  PC. Unticked by default. Import past plays won't add any of them twice. Bonus pp is taken from your
  osu! profile until your own tracked plays catch up.

- **Plays set while the app is closed are no longer tracked.** Closing the app is how tracking is
  stopped, so it picks up from the moment it opens. Use **Import past plays** for anything else.

## 1.17.0

- **No more console window.** The app lives in the system tray on Windows and Linux, and the menu
  bar on macOS. Open it with **osu! local profiles.exe** on Windows, **osu! local profiles** on
  macOS, or **./osu-local-profiles** on Linux.
  - The icon's menu has **Open profile**, **Open log** and **Quit**.
  - The app's output is in `data/logs/app.log`.
  - Windows 11 may hide the icon behind the **^** arrow; drag it onto the taskbar to keep it in
    view.
- **Quit from the page.** **Quit** at the top right stops the app, after asking once.
- **Starting it again opens the page** instead of failing on the port.
- **Remove an unfinished play.** Didn't finish and Not submitted rows have **Remove from profile**,
  which takes them out of the play count too.
- **Updating from 1.16.0 or earlier.** Update from the app as usual. On Windows,
  `Start osu! local profiles.bat` is replaced by `osu! local profiles.exe`, so move any shortcut you
  made. Windows may ask once whether to run it: press **More info**, then **Run anyway**.

## 1.16.0

- **The Options menu is down to six entries.** Import past plays and Play tracking filter sit under
  **Tracking**, **Share & back up** is one dialog, **Reset** moved into Profiles, and **Open in
  browser on start** moved into Other settings.

## 1.15.0

- **Options is shorter, and Profiles holds everything about a profile.** Edit profile, Import from
  osu! and shared Favorite Beatmaps are now in **Profiles**. Settings is now **Other settings**.
- **A score's menu stays with its score** when the page scrolls.
- **macOS asks for one approval instead of many.** Only the launcher needs **Open Anyway**; it lifts
  the quarantine from the rest of its folder.
- **A welcome on first launch offers to bring in an osu! account**, marked optional and shown once.
- **Which mods are ranked now comes from osu! itself.** A hand-kept list missed lazer's newer ranked
  mods and counted some that osu! doesn't rank. Older scores can be rechecked from Other settings.

## 1.14.0

- **Plays osu! could not submit can count.** Quits, fails and retries while offline or signed out
  are read from osu!lazer's log and count by default, labelled "Not submitted". osu! never received
  them, so this takes nothing from your osu! profile; turn it off to match that profile exactly.
- **Import past plays reads osu!lazer's logs too**, so a past session comes back whole. Each kind of
  play has its own tick box.
- **Beatmaps with a `[` in their details are read correctly.** A mapper like `cRyo[iceeicee]` used to
  cut a beatmap's details short; on one real library that lost 327 beatmap names and put 23 beatmaps
  under the wrong mode.
- **Updating no longer leaves the app running where it can't be stopped.** On macOS and Linux the
  app came back from an update with no terminal. It now comes back in the terminal it was started
  from. On Windows, the window it came back in now closes with it.
- **Unfinished plays are tracked without osu!lazer's online beatmap database**, which is often
  missing on Linux. Contributed in #1.
- **A pass whose submission finishes after the results screen stays a pass**, instead of also
  counting as an unfinished play.
- **Hidden tabs let go of the live feed**, so several open tabs no longer stall the page.

## 1.13.2

- **The launcher says when the folder is incomplete**, instead of a message that looks like a missing
  prerequisite. Nothing needs installing, so it names the missing file and links to the downloads.
  On macOS and Linux it also spots a runtime that lost its executable bit, and gives the fix.

## 1.13.1

- **The accuracy is centred in its cell again** in Pinned Scores and Recent Plays. It sat 9px above
  the pp beside it.

## 1.13.0

- **Play tracking filter** (Options): choose which plays this profile records at all, by keyword,
  mode, star rating, mods, category, length and the beatmap's dates. Off by default, and switching
  it on changes nothing until you narrow something.
  - **Mods have three states**: may be used, must be used, or must not be used.
  - **A play the filter turns away is not recorded at all**, so the app says so every time.
  - **Import past plays applies it too.**
  - Plays you quit, failed or retried are judged on the criteria that apply to them, since
    osu!lazer records no mods or star rating for them.

## 1.12.0

- **Two scoring scales, as osu! has them**: Options -> Lazer scoring, on by default. Off shows the
  uncapped classic scale. Switching is instant.
- **osu!stable scores are listed with the Classic mod**, as on osu!.
- **An osu!stable-only install now counts pp.** Without osu!lazer's database, every beatmap counted
  as unranked and the profile scored zero. Every beatmap now counts, with a note saying why.
- **A moved osu!stable Songs folder is found**, from stable's own setting.
- **A note wherever osu!stable is found**: a stable score arrives when you leave the results screen,
  and quit, failed or retried plays aren't counted, because stable keeps no record of them.

## 1.11.0

- **me! is written the way osu!'s is**: BBCode with osu!'s toolbar, Preview, and images pasted or
  dropped into the box.
- **Import from osu!** (Options): look an account up and copy what you tick.
- **Favorite Beatmaps is one list for every profile** by default, with an Import button while it's
  empty.
- **Removed scores can be deleted for good**, and their replays are never imported again.
- **The web page export works like the page**: show more, the mode tabs, View Details, medal cards and
  previews all respond, from one file with nothing about your computer in it.

## 1.10.0

- **Recent Plays is a section of its own**, near the top under me!. The Recent feed is now
  **Milestones**, under Historical.
- **View Details shows the pp breakdown**: how much of a score's pp came from aim, speed, accuracy and
  flashlight, as osu!'s calculator splits it.
- **You can see which osu! release priced your pp**, in the footer, Settings and each score's card.
- **Mod Introduction medals**, judged by osu!'s own rules.
- **macOS and Linux downloads.** Every release now has builds for Windows, macOS (Apple silicon) and
  Linux.
- **Updates on macOS and Linux keep their files executable.**

## 1.9.0

- **The page opens straight away on a first launch.** Reading your osu! folder now happens in the
  background with a progress bar, and scores you set meanwhile are added, with pp, when it's done.
- **osu!stable: indexing opens only beatmap files**, not every audio file and background in `Songs`.

## 1.8.1

- **The Windows launcher always starts the app's own Node runtime.** With a certain Windows security
  setting on, it could start whatever Node was installed on the computer instead, or fail.

## 1.8.0

- **The profile page is much faster on a big profile.** On 20,000 scores, a page load or "show more"
  took about a second. Now the first load takes half that, and later ones a few milliseconds.
- **The download is 2.6MB smaller.**
- **View Details**, from the **...** menu on any score: the score as osu!'s score page shows it, in a
  card over the profile.
- **Download Replay** saves the exact replay file osu! wrote, named as osu!lazer names one.
- **Every score has its own page**, at `localhost:7272/scores/<number>`, with **Copy link**.
- **Save screenshot** and **Copy screenshot** of the score card.
- **osu!'s audio player bar** while a Favorite Beatmaps preview plays.
- **Pausing a preview now pauses it**, and pressing again carries on from where it stopped.

## 1.7.0

- **Beatmaps: Favorite Beatmaps**, the section from osu!'s profile page. Favourite any beatmap from a
  score's **...** menu and it appears as osu!'s card, with a difficulty popup, a song preview, and
  video and storyboard icons.
- **Sections are ordered me!, Recent, Scores, Historical, Beatmaps, Medals by default.** A new section
  now joins a rearranged page after the section it follows by default.
- **The rank graph and stats band is darker, as on osu!.**
- **Renaming your first profile no longer brings an empty copy back** at the next launch.
- `scripts/reingest.mjs` with no argument works on the active profile.

## 1.6.0

- **Starting the app opens the page in your default browser.** It never did on Windows, because the
  command reached Windows garbled. Fixed.
- **Options -> Open in browser on start** turns that off or on.

## 1.5.0

- **A new name: osu! local profiles.** Nothing about your data changes. Updating from 1.3.0 or 1.4.0
  means downloading this version once by hand and copying your `data/` folder into it; from 1.5.0 on,
  the update button works as before.
- **Medals, pp and Total Play Time** under the rank graph, as on osu!. Play time is counted with
  osu!'s own rule.
- **Top Ranks is now Scores**, and **Pinned is now Pinned Scores**.
- **The Medals section is laid out as osu!'s**, with osu!'s hover card.
- **New medals appear in Recent**, and the page announces them.
- **Grade, mod and level lettering is larger and a little darker.**
- **A new tab icon**: a house on osu!'s pink.
- **Removed: sharing the live page on your network.** The page can reset and delete profiles without
  asking who's calling, so it now only answers the computer it runs on.

## 1.4.0

- **An update no longer leaves 400MB behind.** Updating to 1.3.0 left two whole copies of the app on
  disk. The rollback copy is now deleted once the new version is in place, and the staged copy is
  cleared at the next start, including what 1.3.0 left.

## 1.3.0

- **Country flags**, with the country's name beside them, as on osu!. Bundled, so they work offline.
- **SS and S are gold again.** Only the silver letter gradient had been implemented.
- **Mod badges are osu!'s shape and colours**, generated from osu!'s own mod definitions, with rate
  and customisation shown.
- **One-click updates.** An **Update available** button downloads, installs and restarts the app.
  Your `data/` folder is never touched, and the replaced files are kept until the new version is
  verified.
- **Dialogs taller than the window now scroll.**
- **The warning in Top Ranks can be dismissed**, per profile.
- **A footer**, with the version and a link to the source.
- For contributors: `docs/osu-web-fidelity.md` maps each part of the page to the osu-web file behind
  it.

## 1.2.0

- **Plays that were never finished are counted.** osu! counts a play you quit, retried or failed,
  but lazer only saves a replay for a map played to the end. On one real session: 54 plays started,
  45 counted by osu!, 19 replays written. These plays are now read from lazer's own session log and
  count toward the play count, monthly play counts and Most Played. They appear in Recent Plays as
  dimmed "Didn't finish" rows, grouped by default.
- **Sections start at five rows**, with a **show more** button, as on osu!.
- **The rank graph is osu!'s yellow** and shows values on hover.
- **Monthly Playcounts is now Play History**, a hoverable yellow line, as on osu!.
- **The file watcher could crash the app on Windows** when given a non-canonical path (a junction or
  8.3 short name). Paths are resolved first now.
- **macOS and Linux are written and tested on CI**, but not yet run against a real osu! install. That
  includes osu!stable under Wine, a working `installRoots` setting, and launchers for both.

## 1.1.0

- **Settings**, per profile, including country and playstyle.
- **pp for unranked mods and beatmaps, if you want it.** Relax, Autopilot and custom rates are one
  setting, and each unranked beatmap status is its own choice, all off by default. Both pp values come from osu!'s calculators and
  are stored, so switching is instant.
- **Fixed:** a mod with custom settings, like DT at 1.45x, counted as ranked.
- **Share this profile** as a standalone `.html` file or a full-page PNG.
- **The server only answers this computer by default.** It used to listen on the whole network, and
  anyone there could reset or delete a profile.
- **Medals**, derived from your scores, with osu!'s own names, icons and thresholds.
- **Rearrange the page** by dragging sections or using the arrows.
- **A me! section**, per profile.
- **Edit the profile**: name, picture and banner, per profile, or borrowed from an osu! account with
  no login.
- **Pin and remove scores** from a **⋯** menu. Removing never deletes, and can be undone.

## 1.0.0

First complete release. Tracks another osu! playstyle as a brand new profile, entirely locally, with
pp that matches osu! to the digit.

- **Tracks osu!lazer and osu!stable** replays, usually within a second of finishing a play, offline
  and logged out.
- **pp comes from osu!'s own difficulty and performance code**, with no fallback calculator.
- **The profile page matches osu.ppy.sh's design**, as plain HTML, CSS and ES modules.
- **Global rank is estimated offline** from data.ppy.sh's sample of the whole ladder. Country rank is
  deliberately not shown.
- **Several playstyles side by side**, each with its own scores, pp, level and start date, and an
  explicit import of past plays.
- **A portable build**: nothing to install.
