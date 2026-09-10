# Changelog

## 1.1.0

Phase 5: the profile becomes yours to configure, arrange and share.

Planned feature by feature in [docs/roadmap.md](docs/roadmap.md), where 5.0 to 5.9 are
done. macOS and Linux support (5.10) is deferred to a phase of its own -- it is the only
item that cannot be verified on the development machine.

### Settings

- A Settings dialog, reached from Options. Settings belong to a profile, not to the app:
  two playstyles are two profiles and should not share a country, a description, or how
  their scores are counted.
- Country and playstyle are editable from the page. They previously needed `config.json`
  edited by hand and the app restarted. `config.json` is now the fallback for a profile
  that has never set them; once a profile sets one, clearing it stays cleared.

### Counting unranked mods

- **Include pp for unranked mods**, off by default. Counts plays osu! refuses to rank
  because of their mods: Relax, Autopilot, and customised rates such as DT at 1.45x.
- Relax and Autopilot can be priced either **as if the mod were off** (the default -- relax
  counts as nomod, relax + DT counts as DT) or **as osu! scores them**. Both numbers come
  from osu!'s own calculators, and both are stored, so switching between them is instant.
  They are far apart: 111pp against 239pp on one real replay, because a relax run reaches
  accuracy and combo the player could not by hand.
- Wherever the profile is not scoring the way osu! would, it says so -- once above Best
  Performance, and on every affected row.
- **Fixed:** a mod with customised settings was stored as ranked because only its acronym
  was checked. A score set on DT at 1.45x, or HT at 0.5x, counted as if it were the default
  mod. Both exist in a real replay corpus, so this was not hypothetical.
- pp is now calculated for every score that can be calculated, not only ranked ones, and
  whether a score counts is decided when the profile is read. Changing a setting is
  instant and reversible rather than a reingest.
- **Recompute**: scores tracked before this release have no pp for anything osu! would not
  rank. The Settings dialog offers to recalculate them from their replay files. Rows are
  updated in place, and a score whose replay has been deleted is left alone.

### Counting unranked beatmaps

- **Include pp for unranked beatmaps**, none by default. Loved, Qualified, Pending, Work in
  progress, Graveyarded and Never submitted are each a separate choice, because they are not
  the same proposition -- a Loved map is played competitively, a graveyarded one may be a
  draft nobody finished, and a never-submitted one exists only on your machine.
- Independent of the mod setting: a Loved map played with Relax needs both before it counts.

### Sharing

- **Options -> Share this profile**, with three ways out:
  - **A standalone `.html` file** -- one file, opens anywhere, needs neither this app nor a
    connection. Built from the live page rather than re-rendered on the server, so it
    captures exactly what is on screen, section order included.
  - **A full-page PNG**, rendered by an already-installed Chrome or Edge. Nothing is
    bundled: a headless browser would dwarf the whole 83MB app. Without one, the button
    says so and points at the HTML export.
  - **The live page on your local network**, off by default.

### Security: the server no longer listens to the whole network by default

- **Behaviour change.** The server used to listen on every interface, so anyone on the same
  network could open the profile -- and also reset it, delete a profile, or remove scores,
  since none of those endpoints asks who is calling. Requests that are not from this
  machine are now refused, and sharing is opt-in via `"shareOnNetwork": true` in
  `data/config.json`.
- Enforced per request rather than by binding to `127.0.0.1`: a host-bound listen also cuts
  off IPv6 loopback, and `localhost` resolves to `::1` first on Windows, so binding
  "safely" would have left the app unreachable from its own browser.

### Medals

- A Medals section mirroring osu!'s: combo, plays, hits, rank, and beatmap pass and full
  combo by star rating.
- Names, descriptions, icons and thresholds are **osu!'s own**, taken from its published
  achievement list by `node scripts/build-medal-table.mjs` rather than typed out. That is
  also how it came to light that combo and play-count medals exist for osu!standard only,
  that the other modes have hit-count medals in their place, and that star tiers run to 10
  for osu!standard and to 8 elsewhere.
- Derived from the scores rather than stored, so removing a score that earned a medal takes
  the medal with it, and a reingest can never leave a stale one behind.
- Full combo requires the beatmap's own maximum combo, not merely no misses: a lazer score
  can drop slider ends without breaking combo. Scores tracked before that was recorded are
  reported as unknown rather than guessed, and the section says how many.
- osu!'s medal icons load over a drawn placeholder, so the section is complete offline.

### Rearranging the page

- Sections can be reordered, and the order is saved with the profile -- as osu! remembers
  the arrangement of your own page. Drag by the grip, or use the arrows beside it.
- The saved order is reconciled against the code's own list on every read: ids that no
  longer exist are dropped, and new ones are appended. Adding a section later can therefore
  never leave a saved order stale or make a section unreachable.

### The me! section

- osu!'s description box, at the top of the profile. Click to edit; per profile.
- **Plain text, not BBCode.** Line breaks are kept and bare URLs become links; everything
  else renders as the characters that were typed. osu!'s BBCode subset is large, and a
  local profile gains nothing from an HTML sanitiser it would have to get exactly right.
- URLs are found in the raw text and escaped individually rather than the text being
  escaped first and matched afterwards -- escaping first turns a typed quote into an entity
  the URL pattern does not stop at, so the match runs through it and swallows the rest of
  the line into the link.

### Editing the profile

- **Options -> Edit profile**, or click the avatar or the name. Sets the profile's name,
  picture and banner.
- Pictures and banners are **per profile** rather than per install, so two playstyles are
  two identities. A hand-placed `data/avatar.png` from before this still works, as the
  fallback for any profile that has not set its own.
- Upload a PNG, JPEG, WebP or GIF. Uploads are sniffed rather than trusted: the type the
  browser reports is whatever the page chose to send.
- **Borrow from an osu! account** by username, user id or profile link. It shows what it
  found before applying anything, then copies the picture and banner into `data/` so the
  page still works with no network afterwards.
- **Still no login and no API key.** The lookup reads the public profile page, which embeds
  the same user object osu!'s API returns. One request per button press, never on a timer.
- If osu! is signed in, its username is offered as a suggestion, read from the client's own
  config file with no network. It only prefills: a fresh profile is a different identity by
  definition, so it is never adopted without being asked for.

### Pinning and removing scores

- Every score row has a **⋯** menu, matching the one on osu!'s own profile.
- **Pin to profile** adds it to a new **Pinned** section above Best Performance. Pins are
  per game mode and do not have to be top-100 plays -- pinning is for a play you are proud
  of that pp does not reward, so an unranked or relax score can be pinned too.
- Pinned scores can be dragged to reorder, or moved with the menu for anyone not using a
  mouse. The order is saved.
- **Remove from profile** -- which osu! itself has no equivalent for -- takes a score out of
  every section and every total: pp, play count, ranked score, level, the charts, Most
  Played, the mode tabs.
- Removing never deletes. The score can be put back from Settings, under *Removed scores*.
  A real delete would be re-imported from the replay still on disk, and with its dedupe key
  gone it would return looking like a brand new play.

### Development

- `npm run build:pp:local` refreshes `tools/pp/`, which `src/calc/official.ts` prefers over
  the plain build output. A stale copy there does not fail loudly -- it answers the old
  protocol -- so the publish-and-prune step is now shared with `npm run package` rather
  than duplicated.

## 1.0.0

First complete release. Tracks an alternative osu! playstyle as a brand new profile,
entirely locally, with pp that matches osu! to the digit.

### Tracking

- Watches osu!lazer and osu!stable for new replays and turns them into tracked scores,
  usually within a second of finishing a play.
- Works **offline and logged out**, which is the whole reason it reads local files rather
  than the osu! API: an unsubmitted play never appears in the API, even after reconnecting.
- Reads lazer's extended replay block directly, since existing parsers get it wrong —
  one reported rank `F` for a play that actually ranked A.
- Resolves beatmaps offline from lazer's `online.db`, so ranked status needs no network.
- Never scans and imports on startup. Only live plays count, unless you explicitly ask.

### pp

- Comes from **osu!'s own difficulty and performance code**, handed the replay file so
  osu!stable scores are correctly decoded as legacy and scored with the Classic mod.
- No fallback calculator, on purpose. When the helper is unavailable the app stores no pp
  rather than a wrong one, and says so loudly.

### The profile page

- Rebuilt to match `osu.ppy.sh`'s profile design, on osu-web's own colour token system.
- Ranking panel, grade badges, level bar, Recent, Top Ranks and Historical, with mod pills,
  cover art and charts.
- Plain HTML, CSS and ES modules — no build step.

### Rank

- Global rank estimated offline from a pp-to-rank curve built from osu!'s public
  data.ppy.sh sample of the whole ladder. All four modes included.
- Country rank is deliberately not shown: there is nothing accurate to derive it from, and
  a fabricated number would be worse than a dash.

### Profiles and data

- Several playstyles side by side, each with its own scores, pp, level and start date.
- Import plays made while the app was closed, with an explicit cutoff and a preview.
- Export a profile as JSON, or back up every profile.

### Packaging

- `npm run package` produces a portable build: **83MB to download**, nothing to install.
- osu!'s dependency tree is pruned — 273MB to about 112MB — removing fonts, textures,
  audio samples and unused native libraries. Notably the native BASS binaries are excluded:
  BASS is commercially licensed and this app never plays a sound.
- The packaging step starts the built artifact from an unrelated directory and refuses to
  finish unless it reports finding its pp calculator.

### Known limits

- Only osu!standard is verified against known-correct pp values.
- A beatmap you have never downloaded cannot be scored; pp needs the local `.osu`.
- Rank is an estimate and drifts as the playerbase grows; refresh with `npm run rank:refresh`.
- Windows is the only packaged target so far.
