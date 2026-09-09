# Reference links

The sources this project is built against. Kept here because several of the design
constraints in `CLAUDE.md` only make sense next to the thing they were derived from.

## The project this one is inspired by

- [Sheppsu/osu-score-tracker](https://github.com/Sheppsu/osu-score-tracker/tree/kariyu-left-hand)
  — the original idea: a locally hosted page that tracks an alternative playstyle as if it
  were a new account.
- [kariyu.sheppsu.me](https://kariyu.sheppsu.me/) — it running.

## osu! itself

- [ppy/osu](https://github.com/ppy/osu) — the game. The difficulty and performance
  calculators referenced by `tools/PpCalculator`, and `LegacyScoreDecoder`, which is what
  reads a `.osr` correctly for both clients.
- [ppy/osu-web](https://github.com/ppy/osu-web) — the website. The source of the colour
  tokens, metrics and layout recorded in [osu-web-reference.md](osu-web-reference.md).
- [osu.ppy.sh/users/3119700](https://osu.ppy.sh/users/3119700) — the reference profile the
  page is matched against.
- [osu! API docs](https://osu.ppy.sh/docs/) — used only for optional enrichment; the app
  never needs it.

## data.ppy.sh

The pp-to-rank curves in `src/calc/rank-tables/` are built from the public
`performance_<mode>_random_10000` sample by `scripts/build-rank-table.mjs`. osu!'s own
rankings API only exposes the top 10,000, which never covers a fresh profile.

## Why there is no polling loop

From osu!'s API usage guidance — this is the reason detection is local and the API is
optional rather than the mechanism:

> Use the API for good. Don't overdo it. If in doubt, ask before serious long term use.
>
> Examples of good practices:
>
> - Gathering initial information on a user after they login to your site.
> - Tracking data of users registered on your site on an irregular polling interval.
> - Implementing exponential backoff to reduce request rate during low activity periods.
> - Caching retrieved data and reusing as often as possible.
>
> Examples of incorrect / abusive usage:
>
> - Polling for new data every minute for every user.
> - Polling more than once a minute for the same user/beatmap.
> - Using the API to try to gain a competitive advantage.
> - Using the API as if it is your database, re-requesting the same data every time it is
>   needed.
> - Harvesting mass score/user/beatmap data (consider using data.ppy.sh instead if looking
>   for seed or sample data).
>
> Please limit your usage to no more than 60 requests per minute (generally 1 request per
> second). The internal rate limits are higher than this and allow some degree of bursting,
> but exceeding this specified limit may lead to your API tokens being revoked, or in
> serious abuse cases your access to the API being restricted.
>
> Providing this API is done for free, but it's a substantial infrastructure cost in recent
> times. Please consume respectfully.

Anything added later that talks to osu! — the optional account link in `docs/roadmap.md`
§5.5, the medal artwork in §5.8 — is one request, cached to disk, never on a timer.
