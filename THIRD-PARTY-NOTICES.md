# Third-party notices

The source in this repository is MIT licensed (see `LICENSE`). A **packaged build**
additionally bundles other people's software, listed here.

This is a good-faith notice, not legal advice. If you redistribute a build — especially
commercially — verify each component's terms yourself against the actual contents of
`dist/<build>/tools/pp/`.

## What a release contains

| component | why it is there | licence |
|---|---|---|
| [Node.js](https://nodejs.org) (`node.exe`) | runs the app | MIT, plus its own third-party notices |
| [ppy/osu](https://github.com/ppy/osu) — `osu.Game*`, `osu.Framework`, `osuTK` | the real difficulty and pp code; the entire reason this project can be accurate | MIT |
| [.NET 8 runtime](https://github.com/dotnet/runtime) | runs the pp helper self-contained | MIT |
| [Realm](https://github.com/realm/realm-dotnet) | osu!'s model types are Realm objects, so it cannot be removed | Apache-2.0 |
| [SixLabors.ImageSharp](https://github.com/SixLabors/ImageSharp) | pulled in by osu!'s beatmap handling | Six Labors Split License (Apache-2.0 for open-source use) |
| [SharpCompress](https://github.com/adamhathcock/sharpcompress) | archive handling in osu!'s IO layer | MIT |
| [lzma-js-simple-v2](https://www.npmjs.com/package/lzma-js-simple-v2) | decompresses the replay block lazer appends | MIT |
| various osu! transitive dependencies | AutoMapper, MessagePack, Newtonsoft.Json, SQLitePCLRaw, Remotion.Linq and similar | individually permissive; see each package on NuGet |

The rank curves in `src/calc/rank-tables/` are derived from osu!'s public
[data.ppy.sh](https://data.ppy.sh) dumps. They contain no personal data — only a
pp-to-rank curve computed from an anonymous sample.

## What is deliberately removed

`scripts/package.mjs` deletes part of osu!'s dependency tree before packaging, taking the
helper from 273MB to about 112MB. One exclusion matters for licensing rather than size:

- **The native BASS binaries** (`bass.dll`, `bass_fx.dll`, `bassmix.dll`, `basswasapi.dll`).
  BASS is [un4seen](https://www.un4seen.com/)'s commercial audio library — free for
  non-commercial use but **not freely redistributable**. This app never plays a sound, and
  the native libraries are only loaded on demand, so they are removed. The *managed*
  wrapper `ppy.ManagedBass` (MIT, by ppy) has to stay: osu.Framework references it
  directly and the helper will not start without it.

The rest of what goes is dead weight: `osu.Game.Resources.dll` (125MB of fonts, textures
and audio samples), the localisation satellite assemblies, and the native ffmpeg, SDL,
shader-compiler, image-loader and debug-symbol libraries.

**Less can be removed than you would expect.** osu.Framework's `Logger` static constructor
pulls in nearly the whole managed assembly graph — NUnit, Sentry, OpenTabletDriver and
others are all loaded before any of this project's code runs, however irrelevant they are
to computing pp. Removing any of them kills the helper at startup, so they ship. Sentry in
particular is present but **inert**: nothing here calls `SentrySdk.Init`, so no telemetry
is collected or sent.

Every exclusion was verified against a build with no fallback helper available, and the
packaged helper is then run through a real pp calculation. That detail matters: an earlier
attempt at this list passed the pp tests while shipping a helper that could not start at
all, because the tests had quietly fallen back to the unpruned development build.

## What this project does not do

Worth stating plainly, since it reads another game's files:

- It never contacts osu!'s game servers, never logs in, and uses **no API credentials**.
- It never submits, modifies or interferes with anything in your osu! account.
- It only **reads** replay files and beatmaps already on your disk, and never writes to
  osu!'s own files or databases (`online.db` is opened read-only).
- It does not automate, assist or alter play in any way.

It is a local read-only viewer of your own replays. The two hosts it may contact are
`assets.ppy.sh` for cover art and `data.ppy.sh` for rank dumps — both public,
unauthenticated, and optional.
