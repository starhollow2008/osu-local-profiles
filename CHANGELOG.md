# Changelog

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
