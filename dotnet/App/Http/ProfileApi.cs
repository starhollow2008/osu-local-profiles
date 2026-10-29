using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Http;

/// <summary>
/// Answers worth keeping until the database changes: <c>remember</c> in src/http/server.ts.
/// Stamped with <c>total_changes()</c>, which moves with every row this connection writes, and
/// <c>PRAGMA data_version</c>, which moves when another connection commits, so nothing has to
/// remember to clear it.
/// </summary>
internal sealed class ProfileCache(Database db)
{
    private readonly Dictionary<string, (string Version, object? Value)> cache = [];
    private readonly Lock gate = new();

    public T Remember<T>(string key, Func<T> compute)
    {
        lock (gate)
        {
            if (cache.TryGetValue(key, out var hit) && hit.Version == db.DataVersion()) return (T)hit.Value!;
            var value = compute();
            // Stamped after computing: reading a beatmap's length for the first time is a write.
            if (cache.Count > 64) cache.Clear();
            cache[key] = (db.DataVersion(), value);
            return value;
        }
    }
}

internal sealed record Aggregates(
    ProfileStats Stats, MedalSummary Medals, int MedalTotal, HistoryResult History, double RecentTotal, double MostPlayedCount);

/// <summary>The profile page's one big read: <c>/api/profile</c> in src/http/server.ts.</summary>
internal static class ProfileApi
{
    /// <summary>osu! only ever weights the top 100 plays, so Best Performance cannot be longer.</summary>
    private const int TopPlays = 100;

    /// <summary>
    /// A paged section's row count from the query: the fallback when absent or not a number,
    /// otherwise a whole number from 1 to <see cref="SettingsStore.MaxPageRows"/>.
    /// </summary>
    public static int Page(HttpRequest request, string name, int fallback)
    {
        if (!request.Query.TryGetValue(name, out var values) || values.Count == 0) return fallback;
        var raw = values[0] ?? "";
        if (Js.Trim(raw).Length == 0) return fallback;
        var asked = Js.StringToNumber(raw);
        if (!double.IsFinite(asked)) return fallback;
        return (int)Math.Min(Math.Max(Math.Floor(asked), 1), SettingsStore.MaxPageRows);
    }

    /// <summary><c>Number(mode ?? '0') || 0</c>: anything that is not a number is osu!standard.</summary>
    public static double Mode(HttpRequest request)
    {
        var raw = request.Query.TryGetValue("mode", out var values) && values.Count > 0 ? values[0] ?? "" : "0";
        var mode = Js.StringToNumber(raw);
        return double.IsNaN(mode) || mode == 0 ? 0 : mode;
    }

    public static object Answer(HttpRequest request, ServerOptions opts, ProfileCache cache, long profileId)
    {
        var db = opts.Db;
        var mode = Mode(request);
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var e = Eligibility.Of(settings, opts.StatusKnown);
        var favorites = new FavoriteScope(profileId, opts.Config["sharedFavorites"] is { ValueKind: System.Text.Json.JsonValueKind.True });

        var rulesKey = $"{profileId}:{Js.NumberToString(mode)}:{JsonText.Stringify(e)}";
        var aggregates = cache.Remember($"aggregates:{rulesKey}", () =>
        {
            var medals = Medals.Compute(db, profileId, mode, e);
            return new Aggregates(
                Stats.Compute(db, profileId, mode, e),
                medals,
                Medals.EarnedCount(db, profileId, e, (mode, medals)),
                // Every event, newest first; the request slices off the page it asked for.
                History.Build(db, profileId, mode, int.MaxValue, e,
                    [.. History.MedalEvents(medals.Medals), .. History.RankActivityEvents(db, profileId, mode)]),
                Stats.RecentPlayTotal(db, profileId, mode, e),
                Stats.MostPlayedTotal(db, profileId, mode, e));
        });
        var (stats, medalSummary, medalTotal, history, recentTotal, mostPlayedCount) = aggregates;
        var table = Ranks.Table(mode);

        return new
        {
            mode,
            stats,
            // What the profile is counting, so the page can say when it is not scoring as osu! would.
            counting = new
            {
                e.IncludeUnrankedMods,
                e.PreferStrippedPp,
                e.ExtraMapStatuses,
                e.Scoring,
                e.CountUnresolved,
                e.CountUnsubmitted,
                // Priced by the player's own osu! source rather than a release: the one departure from
                // osu! that is about the formula itself, so the note has to say it.
                ppSource = opts.PpSource is { } service && service.State().Source.Length > 0 ? opts.CalculatorVersion : null,
            },
            rank = Ranks.Estimate(stats.TotalPp, mode),
            rankSource = table is null ? null : new { table.Dump, table.Sampled },
            imported = stats.BonusPpBorrowed ? Standing.Imported(db, profileId, mode) : null,
            medals = medalSummary,
            medalTotal,
            pinned = cache.Remember($"pinned:{rulesKey}", () => Stats.PinnedPlays(db, profileId, mode, e)),
            top = cache.Remember($"top:{rulesKey}:{Page(request, "top", 100)}",
                () => Stats.TopPlays(db, profileId, mode, Page(request, "top", 100), e)),
            // Recent Plays reads only the newest rows through an index, so it is not worth keeping.
            recent = Stats.RecentPlays(db, profileId, mode, Page(request, "recent", 25), e, settings.ShowIncompleteInRecent),
            mostPlayed = cache.Remember($"mostPlayed:{rulesKey}:{Page(request, "mostPlayed", 15)}",
                () => Stats.MostPlayed(db, profileId, mode, Page(request, "mostPlayed", 15), e)),
            // Favourites are the profile's, not a mode's, as osu!'s are the account's.
            favorites = Favorites.List(db, favorites, Page(request, "favorites", 6)),
            favoriteIds = Favorites.Ids(db, favorites),
            totals = new
            {
                top = Math.Min(stats.DistinctRankedBeatmaps, TopPlays),
                recent = recentTotal,
                mostPlayed = mostPlayedCount,
                events = history.EventsTotal,
                favorites = Favorites.Count(db, favorites),
            },
            ppHistory = history.Pp,
            // osu-web charts global rank here, so do the same wherever a curve exists.
            rankHistory = history.Pp.Select(p => new { p.At, rank = Ranks.Estimate(p.Pp, mode)?.Rank }).ToList(),
            monthlyPlaycounts = history.MonthlyPlaycounts,
            // The cached history holds every event; the page asked for this many.
            events = history.Events.Take(Page(request, "events", 15)).ToList(),
        };
    }
}
