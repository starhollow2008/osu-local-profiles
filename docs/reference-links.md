# Reference links

What this project is built against, and where some of the rules in `CLAUDE.md` come from.

## Inspiration

- [Sheppsu/osu-score-tracker](https://github.com/Sheppsu/osu-score-tracker/tree/kariyu-left-hand):
  the original idea, a locally hosted page that tracks another playstyle as if it were a new
  account. Running at [kariyu.sheppsu.me](https://kariyu.sheppsu.me/).

## osu!

- [ppy/osu](https://github.com/ppy/osu): the game. Its difficulty and performance calculators are
  what `tools/PpCalculator` uses, and its `LegacyScoreDecoder` reads a `.osr` correctly for both
  clients.
- [ppy/osu-web](https://github.com/ppy/osu-web): the website, and the source of the page's
  tokens, layout and artwork (see [osu-web-fidelity.md](osu-web-fidelity.md)).
- [osu.ppy.sh/users/3119700](https://osu.ppy.sh/users/3119700): the profile the page is matched
  against.
- [osu! API docs](https://osu.ppy.sh/docs/). The app never needs the API.

## Scores and osu!stable

- osu-web's rule for which score a page shows, in
  [score-helper.ts](https://github.com/ppy/osu-web/blob/master/resources/js/utils/score-helper.ts):
  `legacy_total_score`, then `classic_total_score`, then `total_score`. The app never reimplements
  the conversions; it asks the pp helper (`GetDisplayScore(Standardised)`,
  `GetDisplayScore(Classic)`, `LegacyTotalScore`).
- The wiki's [db file format](https://osu.ppy.sh/wiki/en/Client/File_formats/Db_(file_format))
  page describes `osu!.db` and `scores.db`, but it's out of date: a parser written to it failed on
  build `b20260711.1`. Roadmap 5.12 records what a real install holds.
- ["Option to save failed replays"](https://github.com/ppy/osu-stable-issues/issues/254) is still
  open against stable, which is why a failed play leaves no replay.

## data.ppy.sh

The pp-to-rank curves in `src/calc/rank-tables/` are built from the public
`performance_<mode>_random_10000` sample by `scripts/build-rank-table.mjs`. osu!'s rankings API
only goes to the top 10,000, which never covers a new profile.

## Why nothing polls osu!

From osu!'s API usage guidance:

> Use the API for good. Don't overdo it. If in doubt, ask before serious long term use.
>
> Examples of incorrect / abusive usage:
>
> - Polling for new data every minute for every user.
> - Using the API as if it is your database, re-requesting the same data every time it is
>   needed.
> - Harvesting mass score/user/beatmap data (consider using data.ppy.sh instead if looking
>   for seed or sample data).
>
> Please limit your usage to no more than 60 requests per minute (generally 1 request per
> second).

So detection is local, and anything that talks to osu! (the account link, imports, medal art) is
one request per button press, cached to disk, never on a timer. This is about osu! only: the daily
update check (roadmap 5.65) asks GitHub.
