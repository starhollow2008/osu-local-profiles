using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Tracker;
using Row = OsuLocalProfiles.Db.Row;
using RankEvent = OsuLocalProfiles.Clients.RankEvent;

namespace OsuLocalProfiles.Tests;

/// <summary>test/online-import.test.ts, test/score-entry.test.ts and test/rank-events.test.ts: what an import from osu! writes.</summary>
public sealed class OnlineImportTests : IDisposable
{
    private readonly TempDb h = new();
    private readonly BeatmapResolver resolver;

    public OnlineImportTests() => resolver = new BeatmapResolver(h.Db, []);

    public void Dispose() => h.Dispose();

    private const string Md5 = "d4e23a5746b9a780f9faa10189521498";

    private const string Base = """
        {"id":1716608692,"legacy_score_id":4430944113,"ruleset_id":0,"beatmap_id":2403946,"rank":"S","pp":378.504,
         "accuracy":0.993169,"max_combo":1298,"total_score":1051812,"legacy_total_score":40966260,"classic_total_score":32738070,
         "mods":[{"acronym":"HR"},{"acronym":"CL"}],"statistics":{"ok":10,"great":966},"maximum_statistics":{"great":976,"legacy_combo_increase":323},
         "ended_at":"2023-05-04T10:10:36Z","passed":true,"ranked":true,"weight":{"percentage":100,"pp":378.504},
         "beatmap":{"id":2403946,"beatmapset_id":1140099,"checksum":"d4e23a5746b9a780f9faa10189521498","version":"Kowari's Confession","status":"ranked","difficulty_rating":5.76727},
         "beatmapset":{"id":1140099,"artist":"CHiCO with HoneyWorks","title":"Heart no Shuchou","creator":"Nathan"}}
        """;

    private static OsuWebScore Parsed(params (string From, string To)[] changes)
    {
        var json = changes.Aggregate(Base, (text, c) => text.Replace(c.From, c.To));
        return OsuWeb.ScoreFromJson(JsonDocument.Parse(json).RootElement.Clone())!;
    }

    private Row Row(long id) => h.Db.FirstRow("SELECT * FROM scores WHERE id = ?", id)!;

    [Fact]
    public void An_imported_score_stores_osus_pp_and_the_total_on_the_scale_its_replay_would_have()
    {
        var outcome = OnlineImport.ImportScore(h.Db, resolver, h.ProfileId, Parsed());
        Assert.Equal("added", outcome.Status);
        var row = Row(outcome.Id);
        Assert.Equal(378.504, row["pp"]);
        Assert.Equal("osu-web", row["pp_source"]);
        Assert.Null(row["pp_parts"]);
        Assert.NotNull(row["imported_at"]);
        Assert.Equal("1716608692", row["online_score_id"]);
        Assert.Equal("4430944113", row["legacy_score_id"]);
        Assert.Equal(40966260L, row["total_score"]);
        Assert.Equal(1051812L, row["score_standard"]);
        Assert.Equal("stable", row["client"]);
        Assert.Equal(966L, row["count300"]);
        Assert.Equal("""[{"acronym":"HR"},{"acronym":"CL"}]""", row["mods_json"]);
        Assert.Equal("""{"ok":10,"great":966}""", row["statistics_json"]);
        // HR changes the rating, and osu! hands over only the unmodded one.
        Assert.Null(row["stars"]);
        var hidden = OnlineImport.ImportScore(h.Db, resolver, h.ProfileId,
            Parsed(("\"id\":1716608692", "\"id\":22"), ("\"legacy_score_id\":4430944113", "\"legacy_score_id\":null"), ("""[{"acronym":"HR"},{"acronym":"CL"}]""", """[{"acronym":"HD"}]""")));
        Assert.Equal(5.76727, Row(hidden.Id)["stars"]);

        // A beatmap this machine does not have still gets its name from osu!.
        var beatmap = h.Db.FirstRow("SELECT * FROM beatmaps WHERE md5 = ?", Md5)!;
        Assert.Null(beatmap["osu_path"]);
        Assert.Equal("CHiCO with HoneyWorks", beatmap["artist"]);
        Assert.Equal(1L, beatmap["status"]);
    }

    [Fact]
    public void Importing_the_same_list_twice_updates_and_never_duplicates_and_a_deleted_one_stays_out()
    {
        Assert.Equal("added", OnlineImport.ImportScore(h.Db, resolver, h.ProfileId, Parsed()).Status);
        var again = OnlineImport.ImportScore(h.Db, resolver, h.ProfileId, Parsed(("\"pp\":378.504", "\"pp\":401.2")));
        Assert.Equal("updated", again.Status);
        Assert.Equal([401.2], h.Db.All("SELECT pp FROM scores", r => r.GetDouble(0)));

        Scores.ApplyAction(h.Db, h.ProfileId, again.Id, "hide");
        Scores.DeleteRemoved(h.Db, h.ProfileId, [again.Id], Js.Now());
        Assert.Equal("skipped", OnlineImport.ImportScore(h.Db, resolver, h.ProfileId, Parsed()).Status);
    }

    [Fact]
    public void Pinned_scores_are_imported_whether_or_not_they_are_best_performances_in_osus_order()
    {
        var loved = Parsed(("\"id\":1716608692", "\"id\":999"), ("\"legacy_score_id\":4430944113", "\"legacy_score_id\":null"),
            ("\"pp\":378.504", "\"pp\":null"), ("\"ranked\":true", "\"ranked\":false"), (Md5, new string('b', 32)), ("\"status\":\"ranked\"", "\"status\":\"loved\""));
        var result = OnlineImport.ImportMode(h.Db, resolver, h.ProfileId, 0, [Parsed()], [Parsed(), loved], null);
        Assert.Equal(2, result.Added);
        Assert.Equal(2, result.Pinned);
        Assert.Equal([("1716608692", 0L), ("999", 1L)],
            h.Db.All("SELECT online_score_id, pin_order FROM scores WHERE pinned_at IS NOT NULL ORDER BY pin_order", r => (r.GetString(0), r.GetInt64(1))));
        Assert.Equal("""{"mode":0,"found":1,"added":2,"updated":1,"tracked":0,"skipped":0,"pinned":2,"bonusPp":null,"osuTotalPp":null,"osuGlobalRank":null}""",
            JsonText.Stringify(result));
    }

    [Fact]
    public void The_borrowed_bonus_is_what_osus_total_has_that_the_scores_cannot_account_for()
    {
        var standing = new OsuWebStanding(7380.07, 31049, 6122);
        Assert.True(Math.Abs(OnlineImport.BorrowedBonusPp([Parsed()], standing)!.Value - (7380.07 - 378.504)) < 0.001);
        Assert.Null(OnlineImport.BorrowedBonusPp([Parsed()], new OsuWebStanding(null, null, null)));
        Assert.Equal(0, OnlineImport.BorrowedBonusPp([Parsed()], new OsuWebStanding(1, null, null)));

        OnlineImport.ImportMode(h.Db, resolver, h.ProfileId, 0, [Parsed()], [], standing);
        var stats = Stats.Compute(h.Db, h.ProfileId, 0, Eligibility.Vanilla);
        Assert.True(stats.BonusPpBorrowed);
        Assert.True(Math.Abs(stats.TotalPp - 7380.07) < 0.01, $"{stats.TotalPp}");
    }

    [Fact]
    public async Task An_imported_score_waits_on_osus_figures_until_it_can_be_priced_here()
    {
        OnlineImport.ImportScore(h.Db, resolver, h.ProfileId, Parsed());
        var tracker = new PlayTracker(h.Db, resolver, [], h.ProfileId, 0, null);
        var deps = EntryDeps.Of(tracker, h.Db, h.Folder, h.ProfileId, new FakeOsu(_ => throw new HttpRequestException("offline")).Client());
        // No calculator: nothing can be priced, so nothing moves.
        Assert.Equal(new Conversion(0, 1), await ScoreEntry.ConvertImported(deps, h.ProfileId, download: true));
        // A calculator, but the beatmap is not here and a launch never goes online.
        Assert.Equal(new Conversion(0, 1), await ScoreEntry.ConvertImported(deps with { CanPrice = true }, h.ProfileId, download: false));
        Assert.Equal(1L, h.Db.Scalar("SELECT COUNT(*) FROM scores WHERE imported_at IS NOT NULL"));
    }

    [Fact]
    public void Mods_are_typed_as_osu_stable_shows_them_and_only_ones_the_ruleset_has()
    {
        (int, string)? Parse(string text, int mode) =>
            ScoreEntry.ParseMods(JsonText.From(text), mode, out var error) is { } m ? (m.Bits, string.Join(",", m.Acronyms)) : error is null ? null : (-1, error);
        Assert.Equal(((1 << 3) | (1 << 6), "HD,DT"), Parse("+HD DT", 0));
        Assert.Equal(((1 << 3) | (1 << 6) | (1 << 9), "HD,NC"), Parse("hdnc", 0));
        Assert.Equal((0, ""), Parse("", 0));
        Assert.Equal((-1, "4K is not a mod in this ruleset"), Parse("4K", 0));
        Assert.Equal((1 << 15, "4K"), Parse("4K", 3));
        Assert.Equal((-1, "EZ and HR cannot be on together"), Parse("EZHR", 0));
        Assert.Equal((-1, "a play set by Autoplay cannot be entered"), Parse("AT", 0));
        Assert.Equal((-1, "\"XX\" is not an osu!stable mod"), Parse("XX", 0));
        Assert.Equal((-1, "\"X\" is not an osu!stable mod"), Parse("hdX", 0));
    }

    [Fact]
    public void A_beatmap_is_named_by_its_difficulty_never_its_set()
    {
        Assert.Equal(4000001, ScoreEntry.BeatmapIdOf("https://osu.ppy.sh/beatmapsets/2000001#osu/4000001"));
        Assert.Equal(4000001, ScoreEntry.BeatmapIdOf("https://osu.ppy.sh/b/4000001"));
        Assert.Equal(4000001, ScoreEntry.BeatmapIdOf("4000001"));
        Assert.Null(ScoreEntry.BeatmapIdOf("https://osu.ppy.sh/beatmapsets/2000001"));
        Assert.Null(ScoreEntry.BeatmapIdOf("0"));
    }

    private string Play(double beatmapId = 2108789, int mode = 0, string client = "lazer", bool hidden = false, double playedAt = 1_791_000_000_000)
    {
        var key = $"k{beatmapId}{client}{hidden}";
        h.Db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               accuracy, max_combo, total_score, passed, grade, ranked, played_at, hidden_at, player_name)
             VALUES (?,?,?,?,?,?,'[]','None',100,0,0,0,0,0,1.0,100,500000,1,'A',1,?,?,'Tangy')
            """, h.ProfileId, key, mode, $"md5-{key}", beatmapId, client, playedAt, hidden ? 1 : null);
        return key;
    }

    private static RankEvent Event(double id = 1066553565, double at = 1_791_000_048_000, int mode = 0, double beatmapId = 2108789) =>
        new(id, at, 488, "A", mode, beatmapId);

    [Fact]
    public void A_rank_event_is_kept_only_against_one_of_this_profiles_plays_and_only_for_its_own_account()
    {
        var mine = Play();
        Play(137120, hidden: true);
        Play(555, client: "mcosu");
        var added = RankEvents.Save(h.Db, h.ProfileId, [
            Event(),
            Event(id: 2, mode: 3),
            Event(id: 3, at: 1_791_000_000_000 + RankEvents.MatchWindowMs + 60_000),
            Event(id: 4, beatmapId: 999),
            Event(id: 5, beatmapId: 137120),
            Event(id: 6, beatmapId: 555),
        ]);
        Assert.Equal(1, added);
        Assert.Equal(0, RankEvents.Save(h.Db, h.ProfileId, [Event()]));
        Assert.Equal(mine, h.Db.Scalar("SELECT dedupe_key FROM rank_events"));

        // Asked about only for an account linked to this profile, and then only when it is the player's own.
        Assert.Null(RankEvents.Account(h.Db, h.ProfileId, PlayerIdentity.Unknown));
        Settings.SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { linkedUserId = 3119700, linkedUsername = "Tangy" }));
        Assert.Equal(3119700, RankEvents.Account(h.Db, h.ProfileId, PlayerIdentity.Unknown));
        Settings.SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { linkedUsername = "someone else" }));
        Assert.Null(RankEvents.Account(h.Db, h.ProfileId, PlayerIdentity.Unknown));
    }

    [Fact]
    public async Task The_rank_watcher_asks_nothing_for_McOsu_a_fail_or_an_unlinked_profile_and_keeps_what_osu_says()
    {
        Play();
        var osu = new FakeOsu(_ => FakeOsu.Answer("""
            [{"createdAt":"2026-10-03T04:00:48+00:00","id":1066553565,"type":"rank","scoreRank":"A","rank":488,"mode":"osu","beatmap":{"url":"/beatmaps/2108789"}}]
            """));
        var told = 0;
        var watcher = new RankEventWatcher(h.Db, () => h.ProfileId, () => PlayerIdentity.Unknown, osu.Client(), n => told += n);
        Assert.Equal(0, await watcher.CatchUp());
        watcher.Played("lazer", "A");
        Assert.Empty(osu.Asked);

        Settings.SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { linkedUserId = 3119700, linkedUsername = "Tangy" }));
        watcher.Played("mcosu", "A");
        watcher.Played("lazer", "F");
        Assert.Equal(1, await watcher.CatchUp());
        Assert.Equal(["https://osu.ppy.sh/users/3119700/recent_activity?limit=100&offset=0"], osu.Asked);
        Assert.Equal(1, told);
    }
}
