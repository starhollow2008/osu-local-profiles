# Easier installs: plan

A plan to think over, not started (2026-11-08).

## Why

The goal is to make getting and opening the app easier without making the release page or README
harder to follow.

Today a player downloads one of four zips, extracts it, keeps the folder somewhere sensible, and
opens it from that folder or makes their own shortcut. It's simple and portable, but the
folder-and-shortcut part is left to them.

The worry is the opposite failure: a release page with dozens of links and an install guide in the
README. Any change here should keep the page to a handful of clearly named downloads.

## Constraints from how the app works

Any install method has to fit four things the app already does or promises.

| Constraint | What it rules out or requires |
| --- | --- |
| `data/` lives beside the app | A folder the user can write to. Program Files would mean moving data to `%APPDATA%`, with a migration for every existing install. |
| The updater swaps the whole install folder in place | The install folder must stay writable without admin, or every update needs a UAC prompt. |
| "A release is its four zips and nothing else" (roadmap 5.69) | An installer is a fifth file per release, so this rule is relaxed on purpose. The in-app updater keeps using the zips. |
| SmartScreen and antivirus | Unsigned installers and unsigned zipped `.exe` files both get "Windows protected your PC". Installers are flagged by heuristics a little more often. Code signing is the real fix. |

The per-user folder `%LOCALAPPDATA%\Programs\osu! local profiles` meets the first two without any
change to the app. That's where osu!lazer, Discord and VS Code install.

## Option 1: shortcuts from inside the app

An option that adds the app to the Start menu and desktop, offered once on first launch, fixes the
shortcut chore with no new downloads.

- **What it does:** a setting, and a one-time question on first launch: "Add osu! local profiles to
  the Start menu and desktop?". Each shortcut points at the tray launcher in the folder the app runs
  from.
- **Why it fits:** the app already registers itself to start with the computer (Options → Launch on
  startup), so writing shortcuts is the same kind of change.
- **What it doesn't fix:** the folder still lives wherever the player extracted it. Moving the folder
  breaks the shortcuts, so the app should notice and offer to remake them.
- **macOS and Linux:** the macOS `.app` can be dragged to Applications as it is. Linux would get a
  `.desktop` entry in `~/.local/share/applications`.
- **Release page and README:** no change.

## Option 2: package manager listings

Listings in package managers let people install with one command, using the same four zips, so the
release page doesn't change.

| Listing | Platform | Where it lives | Notes |
| --- | --- | --- | --- |
| winget | Windows | a manifest in `microsoft/winget-pkgs` | `winget install osu-local-profiles`. Each release needs its manifest updated, which a GitHub Action can do. |
| Scoop | Windows | a bucket (a small repo of our own, or the `extras` bucket) | Made for portable apps like this one. Scoop keeps `data/` between updates if the manifest lists it as persistent. |
| AUR | Linux (Arch) | an `osu-local-profiles-bin` package | Many osu! players on Linux use Arch, and osu!lazer is already in the AUR. Often maintained by the community. |
| Homebrew cask | macOS | `homebrew/cask`, or a tap of our own | Homebrew's own rules for unsigned apps need checking before submitting. |

The app's own updater and the package manager would both try to update it. A listed install should
leave updating to the package manager, which needs a way to switch the app's updater off for those
installs.

## Option 3: a per-user Windows installer

A signed setup file that installs for the current user only, with no admin prompt, would sit next to
the Windows zip as one extra download.

- **Where it installs:** `%LOCALAPPDATA%\Programs\osu! local profiles`, with `data/` beside the app
  as now, so the updater works unchanged.
- **What it adds:** Start menu and desktop shortcuts, and an entry in Windows' installed apps list
  with an uninstaller.
- **The uninstaller and scores:** it asks before deleting `data/`, and keeps it by default.
- **Tool:** Inno Setup is free, widely trusted, and builds in GitHub Actions on the Windows runner.
  Velopack (what osu!lazer uses) is heavier, because it would replace the app's own updater.
- **Signing:** Azure Trusted Signing costs about $10 a month, and free signing for open-source
  projects exists (SignPath). Without signing, SmartScreen warns as it does for the zip today.
- **Updates after installing:** the app keeps updating itself from the zips, so the installer is
  only ever used once.

## Option 4: the app moves itself on first launch

When the zip is opened from a temporary place like Downloads, the app could offer to move itself into
a proper folder and add shortcuts: most of an installer, with no extra download.

- **What the player sees:** "Move osu! local profiles to its own folder and add shortcuts?" on first
  launch from Downloads, the desktop or a temporary folder.
- **How it could work:** the same swap machinery the updater uses (copy the build to the new folder,
  start the launcher there, remove the old copy) is already written and tested.
- **Cost:** more work than options 1 to 3. The app is moving its own running files, and a mistake
  there could lose an install. Moving a folder that already holds scores needs particular care.
- **Release page and README:** no change.

## macOS and Linux

On both, a package manager listing helps more than a new download format.

| Format | Platform | Worth it? | Why |
| --- | --- | --- | --- |
| `.dmg` (drag to Applications) | macOS | Not yet | The app inside is the same `.app` as in the zip, so it adds a link without fixing much. |
| Notarization | macOS | Later, if Mac users ask | Removes the "Open Anyway" step from Gatekeeper. Needs Apple's developer account, $99 a year. |
| Homebrew cask | macOS | Yes | The macOS equivalent of winget; no new download (option 2). |
| AUR package | Linux | Yes | Best value on Linux, since many osu! players there use Arch (option 2). |
| AppImage | Linux | Not yet | One runnable file, close to the current zip; another link for little gain. |
| Flatpak (Flathub) | Linux | No | Its sandbox makes reading osu! folders and Wine prefixes awkward for this app. |

## Release page and README

Only the installer adds a download link; everything else keeps the page at four zips. GitHub also
always adds its own two "Source code" links, so a page shows six links today.

| Option | Release page | README |
| --- | --- | --- |
| 1. Shortcuts from the app | No change | No change |
| 2. Package manager listings | No change | Optional: one line per platform, e.g. "Or: `winget install osu-local-profiles`", at the bottom |
| 3. Windows installer | One more link: 5 downloads | The Windows step says "run the setup", with the zip as the portable choice |
| 4. App moves itself | No change | No change |

With the installer, the release notes' "which download is which" lines would read:

- **Windows:** `osu-local-profiles-setup.exe` (recommended), or the `.zip` to keep it portable
- **macOS and Linux:** unchanged

## Community trust

People wary of AI-written apps mostly ask what the app does to their computer and whether they can
check. How invasive the install looks matters more than its format.

- **Raises suspicion:** an installer that asks for admin (a UAC prompt) and writes to Program Files.
- **Reads as normal:** a per-user install with no admin prompt, as osu!lazer, Discord and VS Code do.
- **Keeping the zip** shows there's nothing hidden, and suits players who prefer portable tools.
- **What earns trust:** builds made by GitHub Actions from the public code (already the case), a
  code-signed `.exe`, a plain list of what the installer does, and an uninstaller that says clearly
  what happens to your scores.

## Recommended order

Start with the changes that add no download links, and add the installer only if players still ask
for it.

1. **Shortcuts from the app** (option 1). Small: a setting, a first-launch question, and shortcut
   writing on Windows, macOS and Linux.
2. **winget and Scoop listings** (option 2), then AUR and Homebrew. Small each, plus a way to switch
   the app's updater off for listed installs.
3. **A signed per-user installer** (option 3), if players still ask. Medium: an Inno Setup script, a
   release workflow step, signing, and relaxing the four-zips rule.
4. **The app moving itself** (option 4), only if the first three leave a gap. Large, for the risk to
   existing installs.

## Open questions

- [ ] Is a fifth download acceptable for the installer, or should Windows keep a single zip?
- [ ] Code signing: pay for Azure Trusted Signing, apply for free open-source signing, or stay
      unsigned?
- [ ] Should installs from a package manager update through it only, with the app's updater off?
- [ ] Offer shortcuts once on first launch, or only as a setting?
- [ ] Should the uninstaller keep scores by default, or ask with deleting as the default?
