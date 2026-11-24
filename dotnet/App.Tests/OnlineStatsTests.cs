using System.Text.Json;
using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// osu!'s Daily Challenge and Ranked Play for the linked account (Show more details): read off its
/// profile page as osu-web gives them, kept per ruleset, and handed to the page as last read.
/// </summary>
public class OnlineStatsTests
{
    private static string Page(string json) => $"<div data-initial-data=\"{json.Replace("\"", "&quot;")}\"></div>";

    private const string Payload = """
        {"user":{
          "daily_challenge_user_stats":{"daily_streak_best":12,"daily_streak_current":3,"last_update":"2026-11-20T00:00:00Z",
            "playcount":47,"top_10p_placements":5,"top_50p_placements":20,"user_id":2,"weekly_streak_best":9,"weekly_streak_current":4},
          "matchmaking_stats":[
            {"first_placements":24,"is_rating_provisional":false,"plays":25,"pool_id":38,"rank":1,"rating":2635,
             "pool":{"active":true,"id":38,"name":"RP: Season 0","ruleset_id":0,"type":"ranked_play","variant_id":0},
             "recent_history":[{"created_at":"2026-10-02T16:53:18Z","elo_after":2635,"id":1842593,"result":"win","room_id":4548127},
                               {"created_at":"nonsense","id":5,"result":"win"},
                               {"created_at":"2026-10-02T16:53:18Z","id":6,"result":"forfeit"}]},
            {"pool_id":"not an id","pool":{"name":"broken"}}]}}
        """;

    [Fact]
    public void A_profile_page_gives_the_accounts_Daily_Challenge_and_Ranked_Play()
    {
        var page = OsuWeb.ExtractOnlineStats(Page(Payload));
        Assert.Equal(new DailyChallengeStats(47, 3, 12, 4, 9, 5, 20, Js.DateParse("2026-11-20T00:00:00Z")), page.DailyChallenge);
        var pool = Assert.Single(page.RankedPlay!);
        Assert.Equal((38d, "RP: Season 0", 0, 0, true), (pool.PoolId, pool.Name, pool.RulesetId, pool.VariantId, pool.Active));
        Assert.Equal((1d, 2635d, 25d, 24d, false), (pool.Rank, pool.Rating, pool.Plays, pool.FirstPlacements, pool.Provisional));
        // Only a match with a result osu-web draws and a readable date.
        Assert.Equal([new RankedPlayMatch(1842593, "win", 4548127, Js.DateParse("2026-10-02T16:53:18Z"))], pool.RecentHistory);

        // An account that never played: osu-web's zeroes and an empty list, which is not "unknown".
        var never = OsuWeb.ExtractOnlineStats(Page("""{"user":{"daily_challenge_user_stats":{"playcount":0,"last_update":null},"matchmaking_stats":[]}}"""));
        Assert.Equal(new DailyChallengeStats(0, 0, 0, 0, 0, 0, 0, null), never.DailyChallenge);
        Assert.Empty(never.RankedPlay!);
        Assert.Equal(new OnlineStatsPage(null, null), OsuWeb.ExtractOnlineStats("<html>not the page this reads</html>"));
    }

    [Fact]
    public void A_pools_rating_chart_is_read_off_osu_webs_user_chart()
    {
        var history = OsuWeb.RatingHistoryFromJson(JsonDocument.Parse("""
            {"user_elo_history":[{"created_at":"2026-10-02T16:53:18Z","elo_after":2635,"id":1,"result":"win","room_id":2},
                                 {"created_at":"2026-08-12T20:59:27Z","elo_after":2613},{"elo_after":1}]}
            """).RootElement);
        Assert.Equal([
            new RankedPlayRating(Js.DateParse("2026-10-02T16:53:18Z"), 2635),
            new RankedPlayRating(Js.DateParse("2026-08-12T20:59:27Z"), 2613),
        ], history);
        Assert.Empty(OsuWeb.RatingHistoryFromJson(null));
    }

    [Fact]
    public void Each_ruleset_keeps_its_own_Ranked_Play_and_shares_the_newest_Daily_Challenge()
    {
        using var h = new TempDb();
        Assert.Null(OnlineStats.View(h.Db, h.ProfileId, 0));
        Assert.Equal([0], OnlineStats.Modes(h.Db, h.ProfileId));

        var page = OsuWeb.ExtractOnlineStats(Page(Payload));
        Assert.True(OnlineStats.Save(h.Db, h.ProfileId, 0, page, 1000));
        // The same read again changes nothing, so the page is not told to reload.
        Assert.False(OnlineStats.Save(h.Db, h.ProfileId, 0, page, 2000));
        var taiko = page with { DailyChallenge = page.DailyChallenge! with { Playcount = 48 }, RankedPlay = [] };
        Assert.True(OnlineStats.Save(h.Db, h.ProfileId, 1, taiko, 3000));

        var osu = JsonText.From(OnlineStats.View(h.Db, h.ProfileId, 0));
        Assert.Equal(48, osu.GetProperty("dailyChallenge").GetProperty("playcount").GetDouble());
        Assert.Equal(2635, osu.GetProperty("rankedPlay")[0].GetProperty("rating").GetDouble());
        Assert.Equal(1000, osu.GetProperty("readAt").GetDouble());
        // A ruleset never read has no Ranked Play, but the account's Daily Challenge all the same.
        var mania = JsonText.From(OnlineStats.View(h.Db, h.ProfileId, 3));
        Assert.Equal(JsonValueKind.Null, mania.GetProperty("rankedPlay").ValueKind);
        Assert.Equal(48, mania.GetProperty("dailyChallenge").GetProperty("playcount").GetDouble());

        Assert.Equal([0, 1], OnlineStats.Modes(h.Db, h.ProfileId));
        ProfileData.Reset(h.Db, h.ProfileId);
        Assert.Null(OnlineStats.View(h.Db, h.ProfileId, 0));
    }

    [Fact]
    public void The_rulesets_asked_about_are_those_the_profile_plays()
    {
        using var h = new TempDb();
        h.InsertScore(h.ProfileId, "a");
        h.Db.Run("UPDATE scores SET mode = 3");
        h.InsertScore(h.ProfileId, "b");
        Assert.Equal([0, 3], OnlineStats.Modes(h.Db, h.ProfileId));
    }
}
