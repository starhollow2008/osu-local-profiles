using System.Net;
using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// osu!'s website, read: test/request-gate.test.ts, and the readers in test/identity.test.ts,
/// test/favorites.test.ts, test/online-import.test.ts, test/rank-events.test.ts,
/// test/medals.test.ts and test/score-entry.test.ts. Nothing here reaches osu!.
/// </summary>
public class OsuWebTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    /// <summary>A clock that moves only when something sleeps, so nothing here waits.</summary>
    private sealed class FakeClock
    {
        public double Time { get; set; } = 1_000_000;
        public double Now() => Time;

        public Task Sleep(double ms)
        {
            Time += ms;
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task Requests_start_a_second_apart_in_the_order_asked()
    {
        var clock = new FakeClock();
        var gate = new RequestGate(1000, clock.Now, clock.Sleep);
        var started = new List<(string Name, double At)>();
        Task<int> Ask(string name) => gate.Run(() =>
        {
            started.Add((name, clock.Now()));
            return Task.FromResult(0);
        });
        await Task.WhenAll(Ask("a"), Ask("b"), Ask("c"));
        Assert.Equal([("a", 0.0), ("b", 1000.0), ("c", 2000.0)], started.Select(s => (s.Name, s.At - started[0].At)));

        // A request after a quiet spell does not wait at all.
        clock.Time += 10_000;
        var before = clock.Now();
        await Ask("d");
        Assert.Equal(before, started[^1].At);
    }

    [Fact]
    public async Task A_failed_request_does_not_stop_the_ones_after_it_and_a_pause_holds_them_all()
    {
        var clock = new FakeClock();
        var gate = new RequestGate(1000, clock.Now, clock.Sleep);
        await Assert.ThrowsAsync<InvalidOperationException>(() => gate.Run<int>(() => throw new InvalidOperationException("offline")));
        Assert.Equal("next", await gate.Run(() => Task.FromResult("next")));

        gate.PauseFor(30_000);
        var asked = clock.Now();
        var at = 0.0;
        await gate.Run(() =>
        {
            at = clock.Now();
            return Task.FromResult(0);
        });
        Assert.Equal(30_000, at - asked);
    }

    [Fact]
    public void Retry_After_is_read_in_seconds_or_as_a_date_and_held_to_sensible_bounds()
    {
        var now = Js.DateParse("2026-10-19T12:00:00Z");
        Assert.Equal(20_000, RequestGate.RetryAfterMs("20", now));
        Assert.Equal(45_000, RequestGate.RetryAfterMs("Mon, 19 Oct 2026 12:00:45 GMT", now));
        Assert.Equal(1000, RequestGate.RetryAfterMs("0", now));
        Assert.Equal(RequestGate.MaxPauseMs, RequestGate.RetryAfterMs("86400", now));
        Assert.Equal(RequestGate.DefaultPauseMs, RequestGate.RetryAfterMs(null, now));
        Assert.Equal(RequestGate.DefaultPauseMs, RequestGate.RetryAfterMs("soon", now));
    }

    [Fact]
    public async Task The_favourites_import_has_no_cap_ends_on_a_page_with_nothing_new_and_waits_out_a_429()
    {
        static string Set(int id) => $$"""{"id":{{id}},"title":"t{{id}}","artist":"a","status":"ranked","beatmaps":[]}""";
        var slowedDown = false;
        var osu = new FakeOsu(url =>
        {
            var offset = int.Parse(System.Web.HttpUtility.ParseQueryString(new Uri(url).Query)["offset"]!);
            if (offset == 100 && !slowedDown)
            {
                slowedDown = true;
                var tooMany = new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Content = new StringContent("") };
                tooMany.Headers.TryAddWithoutValidation("retry-after", "1");
                return tooMany;
            }
            // Two pages of a hundred, then osu! repeating the last one rather than ending.
            var page = offset >= 200 ? 100 : offset;
            return FakeOsu.Answer($"[{string.Join(",", Enumerable.Range(page + 1, 100).Select(Set))}]");
        });
        var progress = new List<int>();
        var sets = await osu.Client().FetchFavouriteBeatmapsets(42, progress.Add);
        Assert.Equal(200, sets.Count);
        Assert.Equal([100, 200, 200], progress);
        Assert.Equal(4, osu.Asked.Count);
    }

    [Fact]
    public async Task A_lookup_says_what_went_wrong_in_words_worth_showing()
    {
        var html = """<div data-initial-data="{&quot;user&quot;:{&quot;id&quot;:3119700,&quot;username&quot;:&quot;Tangy&quot;,&quot;country&quot;:{&quot;code&quot;:&quot;NZ&quot;},&quot;page&quot;:{&quot;raw&quot;:&quot;  &quot;},&quot;previous_usernames&quot;:[&quot;old&quot;,&quot;&quot;,5]}}"></div>""";
        var osu = new FakeOsu(url => url.EndsWith("/Tangy", StringComparison.Ordinal) ? FakeOsu.Answer(html)
            : url.EndsWith("/broken", StringComparison.Ordinal) ? FakeOsu.Answer("<html></html>")
            : FakeOsu.Answer("", HttpStatusCode.NotFound));
        var user = await osu.Client().LookupUser("https://osu.ppy.sh/users/Tangy/mania");
        Assert.Equal(3119700, user.Id);
        Assert.Equal("NZ", user.CountryCode);
        Assert.Null(user.PageRaw);
        Assert.Equal(["old"], user.PreviousUsernames);
        Assert.Equal("https://osu.ppy.sh/users/Tangy", osu.Asked[0]);

        Assert.Equal("osu! has no user called \"nobody\"", (await Assert.ThrowsAsync<NoSuchUser>(() => osu.Client().LookupUser("nobody"))).Message);
        Assert.StartsWith("osu.ppy.sh answered, but", (await Assert.ThrowsAsync<InvalidOperationException>(() => osu.Client().LookupUser("broken"))).Message);
        Assert.Equal("that does not look like an osu! username, user id or profile link",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => osu.Client().LookupUser("me@example.com"))).Message);
        Assert.Equal("URI malformed", (await Assert.ThrowsAsync<Js.UriMalformed>(() => osu.Client().LookupUser("%E0%A4%A"))).Message);

        var offline = new FakeOsu(_ => throw new HttpRequestException("no route")).Client();
        Assert.Equal("could not reach osu.ppy.sh -- check your connection, or type a name instead",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => offline.LookupUser("Tangy"))).Message);
    }

    [Fact]
    public async Task An_image_is_taken_only_as_a_type_this_app_can_use()
    {
        HttpResponseMessage Image(string type)
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([1, 2, 3]) };
            response.Content.Headers.TryAddWithoutValidation("content-type", type);
            return response;
        }
        var osu = new FakeOsu(url => Image(url.EndsWith("png", StringComparison.Ordinal) ? "image/PNG; charset=x" : "constructor"));
        Assert.Equal(".png", (await osu.Client().DownloadImage("https://a.ppy.sh/1.png")).Extension);
        Assert.Equal("that is not an image this can use (constructor)",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => osu.Client().DownloadImage("https://a.ppy.sh/1"))).Message);
        Assert.Equal("could not download that image",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => osu.Client().DownloadImage("not a url"))).Message);
    }

    [Fact]
    public void A_username_an_id_or_any_profile_link_all_resolve_to_the_same_thing_and_nonsense_to_nothing()
    {
        Assert.Equal("Tangy", OsuWeb.ParseUserQuery("Tangy"));
        Assert.Equal("Tangy", OsuWeb.ParseUserQuery("  Tangy  "));
        Assert.Equal("3119700", OsuWeb.ParseUserQuery("https://osu.ppy.sh/users/3119700"));
        Assert.Equal("Tangy", OsuWeb.ParseUserQuery("https://osu.ppy.sh/users/Tangy/mania"));
        Assert.Equal("Tangy", OsuWeb.ParseUserQuery("osu.ppy.sh/u/Tangy"));
        Assert.Equal("[ Cookiezi ]", OsuWeb.ParseUserQuery("[ Cookiezi ]"));
        Assert.Equal("a b", OsuWeb.ParseUserQuery("osu.ppy.sh/users/a%20b"));
        foreach (var bad in new[] { "", "   ", null, "me@example.com", "https://example.com/x", new string('x', 40), "ünïcode" })
        {
            Assert.Null(OsuWeb.ParseUserQuery(bad));
        }
    }

    private static string BeatmapsetPage(string json) => $"<html><script id=\"json-beatmapset\" type=\"application/json\">\n  {json}\n</script></html>";

    [Fact]
    public void The_beatmapset_pages_JSON_is_reduced_to_what_the_card_draws_in_the_order_it_is_stored()
    {
        var set = OsuWeb.ExtractBeatmapset(BeatmapsetPage("""
            {"id":8495,"title":"So We Can Smile Tomorrow","artist":"Yumi Matsuzawa","creator":"ztrot","user_id":6347,
             "status":"ranked","nsfw":false,"spotlight":true,"track_id":123,"video":true,"storyboard":false,
             "favourite_count":19,"play_count":22968,"ranked_date":"2009-08-11T06:51:17Z","last_updated":"2009-08-11T06:13:25Z",
             "beatmaps":[{"id":34843,"mode":"osu","difficulty_rating":3.92933,"version":"GATE OPEN!!!!"},
                         {"id":1,"mode":"not-a-mode","difficulty_rating":1,"version":"dropped"}]}
            """))!;
        Assert.Equal(
            """{"id":8495,"title":"So We Can Smile Tomorrow","artist":"Yumi Matsuzawa","titleUnicode":null,"artistUnicode":null,"creator":"ztrot","userId":6347,"status":"ranked","nsfw":false,"spotlight":true,"featuredArtist":true,"video":true,"storyboard":false,"favouriteCount":19,"playCount":22968,"date":"2009-08-11T06:51:17Z","difficulties":[{"id":34843,"mode":"osu","stars":3.92933,"version":"GATE OPEN!!!!"}]}""",
            JsonText.Stringify(set));
        Assert.Equal("2015-01-01T00:00:00Z", OsuWeb.ExtractBeatmapset(BeatmapsetPage(
            """{"id":1,"title":"t","artist":"a","status":"graveyard","last_updated":"2015-01-01T00:00:00Z","beatmaps":[]}"""))!.Date);
        Assert.Null(OsuWeb.ExtractBeatmapset("<html>nothing here</html>"));
        Assert.Null(OsuWeb.ExtractBeatmapset(BeatmapsetPage("""{"title":"no id"}""")));
    }

    private const string ScoreJson = """
        {"id":1716608692,"legacy_score_id":4430944113,"ruleset_id":0,"beatmap_id":2403946,"rank":"S","pp":378.504,
         "accuracy":0.993169,"max_combo":1298,"total_score":1051812,"legacy_total_score":40966260,"classic_total_score":32738070,
         "mods":[{"acronym":"HR"},{"acronym":"CL","settings":{"b":1,"2":true,"a":null}},{"no":"acronym"}],
         "statistics":{"ok":10,"great":966,"bad":"x"},"maximum_statistics":{"great":976,"legacy_combo_increase":323},
         "ended_at":"2023-05-04T10:10:36Z","passed":true,"ranked":true,"weight":{"percentage":100,"pp":378.504},
         "beatmap":{"id":2403946,"beatmapset_id":1140099,"checksum":"d4e23a5746b9a780f9faa10189521498","version":"Kowari's Confession","status":"ranked","difficulty_rating":5.76727},
         "beatmapset":{"id":1140099,"artist":"CHiCO with HoneyWorks","title":"Heart no Shuchou","creator":"Nathan"}}
        """;

    [Fact]
    public void A_score_is_read_from_the_shape_osu_web_answers_with()
    {
        var score = OsuWeb.ScoreFromJson(Json(ScoreJson))!;
        Assert.Equal("1716608692", score.Id);
        Assert.Equal("4430944113", score.LegacyScoreId);
        Assert.Equal(1, score.MapStatus);
        Assert.Equal(378.504, score.Pp);
        Assert.Equal(Js.DateParse("2023-05-04T10:10:36Z"), score.PlayedAt);
        Assert.Equal(100, score.WeightPercentage);
        // Mods as JSON.stringify stores them: settings kept, integer keys first.
        Assert.Equal("""[{"acronym":"HR"},{"acronym":"CL","settings":{"2":true,"b":1,"a":null}}]""", JsonText.Stringify(score.Mods));
        Assert.Equal("""{"ok":10,"great":966}""", JsonText.Stringify(score.Statistics));

        string With(string from, string to) => ScoreJson.Replace(from, to);
        foreach (var status in new[] { "tentative", "constructor", "toString" })
        {
            Assert.Equal(Calc.Status.Unresolved, OsuWeb.ScoreFromJson(Json(With("\"status\":\"ranked\"", $"\"status\":\"{status}\"")))!.MapStatus);
        }
        // An id JSON.parse would have had to round is not that id.
        Assert.Null(OsuWeb.ScoreFromJson(Json(With("\"id\":1716608692", "\"id\":9007199254740993"))));
        Assert.Null(OsuWeb.ScoreFromJson(Json(With("\"id\":1716608692", "\"id\":\"x\""))));
        Assert.Null(OsuWeb.ScoreFromJson(Json(With("\"legacy_score_id\":4430944113", "\"legacy_score_id\":null")))!.LegacyScoreId);
        Assert.Null(OsuWeb.ScoreFromJson(Json(With("\"ruleset_id\":0", "\"ruleset_id\":4"))));
        Assert.Null(OsuWeb.ScoreFromJson(Json(With("2023-05-04T10:10:36Z", "whenever"))));
    }

    [Fact]
    public void A_score_pages_own_JSON_is_what_is_read_with_who_set_it()
    {
        var page = $"<html><script id=\"json-show\" type=\"application/json\">{ScoreJson.Replace("\"rank\":\"S\"", "\"rank\":\"S\",\"user_id\":3119700,\"user\":{\"username\":\"Tangy\"}")}</script></html>";
        var linked = OsuWeb.ExtractScorePage(page)!;
        Assert.Equal(new LinkedPlayer(3119700, "Tangy"), linked.Player);
        Assert.Null(OsuWeb.ExtractScorePage("<html>no score here</html>"));

        Assert.Equal("scores/308368918", OsuWeb.ParseScoreLink("https://osu.ppy.sh/scores/308368918"));
        Assert.Equal("scores/5542633708", OsuWeb.ParseScoreLink("osu.ppy.sh/scores/5542633708?foo#bar"));
        Assert.Equal("scores/osu/2019594028", OsuWeb.ParseScoreLink("https://osu.ppy.sh/scores/OSU/2019594028"));
        Assert.Equal("scores/308368918", OsuWeb.ParseScoreLink("308368918"));
        Assert.Null(OsuWeb.ParseScoreLink("https://example.com/scores/1"));
        Assert.Null(OsuWeb.ParseScoreLink("https://osu.ppy.sh/users/3119700"));
    }

    [Fact]
    public void Medals_standing_and_rank_events_are_read_off_osus_pages()
    {
        var medals = OsuWeb.EarnedMedals(Json("""
            {"achievements":[{"id":55,"slug":"osu-skill-pass-1"},{"id":201,"slug":"all-skill-dc-1"}],
             "user":{"user_achievements":[{"achievement_id":55,"achieved_at":"2014-02-01T10:00:00Z"},
               {"achievement_id":201,"achieved_at":"2026-06-22T23:27:37Z"},{"achievement_id":999,"achieved_at":"2020-01-01T00:00:00Z"},
               {"achievement_id":55,"achieved_at":"whenever"}]}}
            """));
        Assert.Equal([new EarnedMedal("osu-skill-pass-1", Js.DateParse("2014-02-01T10:00:00Z")), new EarnedMedal("all-skill-dc-1", Js.DateParse("2026-06-22T23:27:37Z"))], medals);
        Assert.Empty(OsuWeb.EarnedMedals(Json("{}")));

        static string Page(string json) => $"<div data-initial-data=\"{json.Replace("\"", "&quot;")}\"></div>";
        Assert.Equal(new OsuWebStanding(7380.07, 31049, 6122), OsuWeb.ExtractStanding(Page("""{"user":{"statistics":{"pp":7380.07,"global_rank":31049,"country_rank":6122}}}""")));
        Assert.Equal(new OsuWebStanding(null, null, null), OsuWeb.ExtractStanding(Page("""{"user":{"statistics":{}}}""")));
        Assert.Equal(new OsuWebStanding(null, null, null), OsuWeb.ExtractStanding("<html>not the page this reads</html>"));

        var events = OsuWeb.RankEventsFromJson(Json("""
            [{"createdAt":"2026-10-07T00:21:18+00:00","id":1066553565,"type":"rank","scoreRank":"A","rank":488,"mode":"osu","beatmap":{"url":"/beatmaps/2108789?ruleset=osu"}},
             {"createdAt":"2026-10-07T00:00:00+00:00","id":2,"type":"achievement","achievement":{}},
             {"createdAt":"2026-10-07T00:00:00+00:00","id":3,"type":"rank","scoreRank":"S","rank":5,"mode":"fruits","beatmap":{"url":"/beatmaps/77"}},
             {"id":4,"type":"rank","rank":1,"mode":"osu","beatmap":{"url":"nowhere"}},
             {"createdAt":"2026-10-07T00:00:00+00:00","id":5,"type":"rank","scoreRank":"S","rank":5,"mode":"constructor","beatmap":{"url":"/beatmaps/77"}}]
            """));
        Assert.Equal([
            new RankEvent(1066553565, Js.DateParse("2026-10-07T00:21:18Z"), 488, "A", 0, 2108789),
            new RankEvent(3, Js.DateParse("2026-10-07T00:00:00Z"), 5, "S", 2, 77),
        ], events);
        Assert.Empty(OsuWeb.RankEventsFromJson(Json("\"nonsense\"")));
    }

    [Fact]
    public void A_malformed_escape_is_refused_as_JavaScript_refuses_it()
    {
        Assert.Equal("a b€%", Js.DecodeUriComponent("a%20b%E2%82%AC%25"));
        Assert.Throws<Js.UriMalformed>(() => Js.DecodeUriComponent("%E0%A4%A"));
        Assert.Throws<Js.UriMalformed>(() => Js.DecodeUriComponent("%zz"));
        Assert.Throws<Js.UriMalformed>(() => Js.DecodeUriComponent("%C3%41"));
    }
}
