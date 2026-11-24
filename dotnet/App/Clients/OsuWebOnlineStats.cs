using System.Text.Json;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// osu!'s Daily Challenge and Ranked Play for an account (Show more details): what its public
/// profile page for one ruleset gives, osu-web's <c>daily_challenge_user_stats</c> and
/// <c>matchmaking_stats</c>, and the rating chart osu-web's Ranked Play card asks for on its own.
/// </summary>
internal sealed partial class OsuWeb
{
    /// <summary>The account's Daily Challenge and its Ranked Play in one ruleset: one request.</summary>
    public async Task<OnlineStatsPage> FetchOnlineStats(double userId, double mode)
    {
        if (!IsWholePositive(userId)) throw new InvalidOperationException("not a user id");
        var response = await Fetch($"https://osu.ppy.sh/users/{Js.NumberToString(userId)}/{OsuWebMode(mode)}", "text/html", "could not reach osu.ppy.sh");
        if (!response.Ok) throw Answered(response.Status);
        return ExtractOnlineStats(await response.Text());
    }

    /// <summary>
    /// The two blocks of a profile page's payload. Either is null where the page has none in the
    /// shape expected, which is not the same as an account that has never played: osu-web gives that
    /// account zeroes and an empty list.
    /// </summary>
    public static OnlineStatsPage ExtractOnlineStats(string html)
    {
        var match = InitialData().Match(html);
        if (!match.Success || Parse(DecodeInitialData(match.Groups[1].Value)) is not { } payload) return new(null, null);
        var user = Js.Get(payload, "user");
        return new(DailyChallengeFromJson(Js.Get(user, "daily_challenge_user_stats")), RankedPlayFromJson(Js.Get(user, "matchmaking_stats")));
    }

    /// <summary>osu-web's <c>DailyChallengeUserStatsJson</c>; a missing count reads as none.</summary>
    public static DailyChallengeStats? DailyChallengeFromJson(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Object } stats) return null;
        double Count(string key) => Num(Js.Get(stats, key)) is { } n && n >= 0 ? n : 0;
        var updated = Str(Js.Get(stats, "last_update")) is { } text ? Js.DateParse(text) : double.NaN;
        return new DailyChallengeStats(
            Count("playcount"),
            Count("daily_streak_current"),
            Count("daily_streak_best"),
            Count("weekly_streak_current"),
            Count("weekly_streak_best"),
            Count("top_10p_placements"),
            Count("top_50p_placements"),
            double.IsFinite(updated) ? updated : null);
    }

    /// <summary>
    /// osu-web's <c>ProfilePageMatchmakingStatsJson</c>, one per pool (a season, or a mania key
    /// count). A pool with no id or no name is left out; a missing figure is zero, as osu-web's
    /// blank stats are.
    /// </summary>
    public static List<RankedPlayPool>? RankedPlayFromJson(JsonElement? raw)
    {
        if (raw is not { ValueKind: JsonValueKind.Array } list) return null;
        var pools = new List<RankedPlayPool>();
        foreach (var stats in list.EnumerateArray())
        {
            if (stats.ValueKind != JsonValueKind.Object) continue;
            var pool = Js.Get(stats, "pool");
            if (Num(Js.Get(stats, "pool_id")) is not { } poolId || !IsWholePositive(poolId) || Str(Js.Get(pool, "name")) is not { } name) continue;
            var history = new List<RankedPlayMatch>();
            if (Js.Get(stats, "recent_history") is { ValueKind: JsonValueKind.Array } matches)
            {
                foreach (var match in matches.EnumerateArray())
                {
                    var at = Str(Js.Get(match, "created_at")) is { } text ? Js.DateParse(text) : double.NaN;
                    if (Num(Js.Get(match, "id")) is not { } id || Str(Js.Get(match, "result")) is not ("win" or "loss" or "draw") || !double.IsFinite(at)) continue;
                    history.Add(new RankedPlayMatch(id, Str(Js.Get(match, "result"))!, Num(Js.Get(match, "room_id")), at));
                }
            }
            pools.Add(new RankedPlayPool(
                poolId,
                name,
                (int)(Num(Js.Get(pool, "ruleset_id")) ?? 0),
                (int)(Num(Js.Get(pool, "variant_id")) ?? 0),
                Js.Get(pool, "active") is not { ValueKind: JsonValueKind.False },
                Num(Js.Get(stats, "rank")) ?? -1,
                Num(Js.Get(stats, "rating")) ?? 0,
                Num(Js.Get(stats, "plays")) ?? 0,
                Num(Js.Get(stats, "first_placements")) ?? 0,
                Js.Get(stats, "is_rating_provisional") is not { ValueKind: JsonValueKind.False },
                history,
                []));
        }
        return pools;
    }

    /// <summary>
    /// A pool's rating, the last of each day for up to 90 days, newest first: osu-web's
    /// <c>matchmaking-pools.user-chart</c>, which its Ranked Play card reads for its chart.
    /// </summary>
    public async Task<List<RankedPlayRating>> FetchRatingHistory(double poolId, double userId)
    {
        if (!IsWholePositive(userId) || !IsWholePositive(poolId)) throw new InvalidOperationException("not a user or pool id");
        var response = await Fetch($"https://osu.ppy.sh/matchmaking-pools/{Js.NumberToString(poolId)}/user-chart/{Js.NumberToString(userId)}",
            "application/json", "could not reach osu.ppy.sh");
        if (!response.Ok) throw Answered(response.Status);
        return RatingHistoryFromJson(Parse(await response.Text()));
    }

    public static List<RankedPlayRating> RatingHistoryFromJson(JsonElement? raw)
    {
        var output = new List<RankedPlayRating>();
        if (Js.Get(raw, "user_elo_history") is not { ValueKind: JsonValueKind.Array } list) return output;
        foreach (var entry in list.EnumerateArray())
        {
            var at = Str(Js.Get(entry, "created_at")) is { } text ? Js.DateParse(text) : double.NaN;
            if (Num(Js.Get(entry, "elo_after")) is { } rating && double.IsFinite(at)) output.Add(new RankedPlayRating(at, rating));
        }
        return output;
    }
}

/// <summary>What one profile page says about the account's Daily Challenge and Ranked Play.</summary>
internal sealed record OnlineStatsPage(DailyChallengeStats? DailyChallenge, List<RankedPlayPool>? RankedPlay);

/// <summary>osu-web's daily challenge stats: days and weeks, and when the account last took part.</summary>
internal sealed record DailyChallengeStats(
    double Playcount,
    double DailyStreakCurrent,
    double DailyStreakBest,
    double WeeklyStreakCurrent,
    double WeeklyStreakBest,
    double Top10pPlacements,
    double Top50pPlacements,
    double? LastUpdate);

/// <summary>One Ranked Play pool's stats for the account, and its rating over time once read.</summary>
internal sealed record RankedPlayPool(
    double PoolId,
    string Name,
    int RulesetId,
    int VariantId,
    bool Active,
    double Rank,
    double Rating,
    double Plays,
    double FirstPlacements,
    bool Provisional,
    List<RankedPlayMatch> RecentHistory,
    List<RankedPlayRating> RatingHistory);

internal sealed record RankedPlayMatch(double Id, string Result, double? RoomId, double At);

internal sealed record RankedPlayRating(double At, double Rating);
