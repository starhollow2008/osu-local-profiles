using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Export;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tests;

/// <summary>The Scores view (roadmap 5.86): what it lists, in what order, and how its filters narrow it.</summary>
public sealed class ScoreListTests : IDisposable
{
    private readonly TempDb h = new();
    private readonly Eligibility e;
    private long nextKey;

    public ScoreListTests()
    {
        e = Eligibility.Of(SettingsStore.Get(h.Db, h.ProfileId));
        Beatmap("aaa", "Blue Sky", "Some Artist", "Insane", "Blue Dragon", tags: "anime");
        Beatmap("bbb", "Red Moon", "Other Band", "Hard", "Someone");
        Beatmap("ccc", "Green Field", "Some Artist", "Expert", "Mapper Three");
    }

    public void Dispose() => h.Dispose();

    private void Beatmap(string md5, string title, string artist, string version, string creator, string? tags = null) =>
        h.Db.Run("INSERT INTO beatmaps (md5, title, artist, version, creator, tags, status, cached_at) VALUES (?,?,?,?,?,?,1,0)",
            md5, title, artist, version, creator, tags);

    /// <summary>A ranked, passed score unless told otherwise.</summary>
    private long Score(string md5, double pp, string mods = "[]", string grade = "S", string client = "lazer", double accuracy = 0.98,
        double stars = 5, double at = 1000, bool passed = true, int misses = 0, double combo = 500)
    {
        h.Db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               accuracy, max_combo, total_score, passed, grade, pp, stars, ranked, map_status, played_at)
             VALUES (?,?,0,?,?,?,'',100,0,0,0,0,?,?,?,?,?,?,?,?,1,1,?)
            """, h.ProfileId, $"k{nextKey++}", md5, client, mods, misses, accuracy, combo, pp * 1000, passed ? 1 : 0, grade,
            passed ? pp : null, stars, at);
        return Convert.ToInt64(h.Db.Scalar("SELECT last_insert_rowid()"));
    }

    private void Attempt(string md5, bool unsubmitted = false) =>
        h.Db.Run("INSERT INTO incomplete_plays (profile_id, dedupe_key, mode, beatmap_md5, played_at, unsubmitted) VALUES (?,?,0,?,1,?)",
            h.ProfileId, $"i{nextKey++}", md5, unsubmitted ? 1 : 0);

    private static ScoreListView View(object raw) => ScoreListView.Coerce(JsonText.From(raw));

    private List<Play> List(ScoreListView view, Func<string, List<double>>? mappedBy = null) =>
        Stats.ScoreList(h.Db, h.ProfileId, 0, view, e, 0, 100, mappedBy).Rows;

    private static List<object?> Ids(List<Play> plays) => [.. plays.Select(p => p.Id)];

    [Fact]
    public void By_default_it_is_Best_Performance_without_its_cap()
    {
        Score("aaa", 100);
        var best = Score("aaa", 300);
        var b = Score("bbb", 200);
        var c = Score("ccc", 150);
        Score("ccc", 0, passed: false);

        var listed = List(ScoreListView.Default());
        Assert.Equal([best, b, c], Ids(listed));
        // Exactly the plays Best Performance lists, in its order.
        Assert.Equal(Ids(Stats.TopPlays(h.Db, h.ProfileId, 0, 100, e)), Ids(listed));
        Assert.Equal(3, Stats.ScoreList(h.Db, h.ProfileId, 0, ScoreListView.Default(), e, 0, 100).Total);
    }

    [Fact]
    public void Every_play_lists_each_score_and_uncounted_ones_only_when_asked()
    {
        Score("aaa", 100);
        Score("aaa", 300);
        Score("bbb", 200);
        var failed = Score("ccc", 0, passed: false);
        var hidden = Score("bbb", 50);
        h.Db.Run("UPDATE scores SET hidden_at = 1 WHERE id = ?", hidden);

        Assert.Equal(3, List(View(new { show = "every" })).Count);
        var all = List(View(new { show = "every", uncounted = true }));
        Assert.Equal(4, all.Count);
        Assert.Contains(failed, Ids(all));
        // A removed score is not one of the profile's, here as anywhere.
        Assert.DoesNotContain(hidden, Ids(all));
    }

    [Fact]
    public void Playcount_is_every_attempt_on_the_beatmap_as_Most_Played_counts_it()
    {
        Score("aaa", 300);
        Score("aaa", 100);
        Attempt("aaa");
        Attempt("aaa", unsubmitted: true);
        Score("bbb", 200);

        var listed = List(ScoreListView.Default());
        Assert.Equal([4L, 1L], listed.Select(p => p.Playcount));
        var mostPlayed = Stats.MostPlayed(h.Db, h.ProfileId, 0, 10, e);
        Assert.Equal(mostPlayed.First(m => (string?)m.BeatmapMd5 == "aaa").Count, listed[0].Playcount);

        // A profile not counting the attempts osu! could not submit leaves them out here too.
        SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { countUnsubmittedAttempts = false }));
        var strict = Eligibility.Of(SettingsStore.Get(h.Db, h.ProfileId));
        Assert.Equal(3L, Stats.ScoreList(h.Db, h.ProfileId, 0, ScoreListView.Default(), strict, 0, 10).Rows[0].Playcount);
    }

    [Fact]
    public void Filters_narrow_the_list_before_the_best_on_each_beatmap_is_picked()
    {
        var dt = Score("aaa", 300, mods: """[{"acronym":"DT"},{"acronym":"HD"}]""", grade: "SH", client: "stable");
        var nm = Score("aaa", 250, grade: "A");
        var hr = Score("bbb", 200, mods: """[{"acronym":"HR"}]""", stars: 6.5, at: 5000);
        var nmB = Score("ccc", 150, stars: 4, at: 9000);

        Assert.Equal([dt], Ids(List(View(new { mods = new[] { "DT" } }))));
        Assert.Equal([dt], Ids(List(View(new { mods = new[] { "dt", "HD" } }))));
        Assert.Empty(List(View(new { mods = new[] { "DT", "HR" } })));
        // No mod: the best no-mod play on each map, not the map's best.
        Assert.Equal([nm, nmB], Ids(List(View(new { mods = new[] { "NM" } }))));
        Assert.Equal([nm], Ids(List(View(new { grades = new[] { "A" } }))));
        Assert.Equal([dt], Ids(List(View(new { clients = new[] { "stable" } }))));
        Assert.Equal([hr], Ids(List(View(new { starsMin = 6 }))));
        Assert.Equal([hr, nmB], Ids(List(View(new { from = 4000 }))));
        Assert.Equal([dt], Ids(List(View(new { to = 2000 }))));
    }

    [Fact]
    public void Search_finds_every_word_in_the_names_tags_or_mapper()
    {
        var a = Score("aaa", 300);
        var b = Score("bbb", 200);
        var c = Score("ccc", 100);

        Assert.Equal([a, c], Ids(List(View(new { search = "some artist" }))));
        Assert.Equal([a], Ids(List(View(new { search = "BLUE insane" }))));
        Assert.Equal([a], Ids(List(View(new { search = "anime" }))));
        Assert.Equal([b], Ids(List(View(new { search = "Someone" }))));
        Assert.Empty(List(View(new { search = "100%" })));
        // A guest mapper, by osu!'s record of who mapped the difficulty.
        h.Db.Run("UPDATE scores SET beatmap_id = 77 WHERE id = ?", c);
        Assert.Equal([c], Ids(List(View(new { search = "guesty" }), word => word == "guesty" ? [77] : [])));
    }

    [Fact]
    public void Each_column_sorts_both_ways_and_rows_with_nothing_to_sort_by_go_last()
    {
        var a = Score("aaa", 300, accuracy: 0.95, misses: 3, combo: 100);
        var b = Score("bbb", 200, accuracy: 0.99, misses: 0, combo: 900);
        var c = Score("ccc", 100, accuracy: 0.97, misses: 1, combo: 500);
        Attempt("ccc");

        Assert.Equal([b, c, a], Ids(List(View(new { sort = "accuracy" }))));
        Assert.Equal([a, c, b], Ids(List(View(new { sort = "accuracy", order = "asc" }))));
        Assert.Equal([a, c, b], Ids(List(View(new { sort = "misses" }))));
        Assert.Equal([b, c, a], Ids(List(View(new { sort = "combo" }))));
        // Blue Sky, Green Field, Red Moon.
        Assert.Equal([a, c, b], Ids(List(View(new { sort = "beatmap", order = "asc" }))));
        Assert.Equal(c, List(View(new { sort = "playcount" }))[0].Id);

        // Silver SS to D, and by accuracy within a grade.
        h.Db.Run("UPDATE scores SET grade = 'A' WHERE id IN (?, ?)", a, c);
        h.Db.Run("UPDATE scores SET grade = 'XH' WHERE id = ?", b);
        Assert.Equal([b, c, a], Ids(List(View(new { sort = "grade" }))));
        Assert.Equal([a, c, b], Ids(List(View(new { sort = "grade", order = "asc" }))));
        h.Db.Run("UPDATE scores SET grade = 'SH' WHERE id = ?", a);
        Assert.Equal([b, a, c], Ids(List(View(new { sort = "grade" }))));

        // Uncounted scores have no pp: last, whichever way pp runs.
        var failed = Score("bbb", 0, passed: false);
        Assert.Equal(failed, List(View(new { show = "every", uncounted = true, order = "asc" })).Last().Id);
    }

    [Fact]
    public void A_page_is_a_slice_of_the_whole_list_and_says_how_long_it_is()
    {
        for (var i = 0; i < 7; i++) Score(i % 2 == 0 ? "aaa" : "bbb", 100 + i);
        var every = View(new { show = "every" });
        var first = Stats.ScoreList(h.Db, h.ProfileId, 0, every, e, 0, 3);
        var next = Stats.ScoreList(h.Db, h.ProfileId, 0, every, e, 3, 3);
        Assert.Equal(7, first.Total);
        Assert.Equal(3, first.Rows.Count);
        Assert.Empty(Ids(first.Rows).Intersect(Ids(next.Rows)));
        Assert.Equal(Ids(Stats.ScoreListAll(h.Db, h.ProfileId, 0, every, e)).Take(6), Ids([.. first.Rows, .. next.Rows]));
    }

    [Fact]
    public void A_view_is_cleaned_and_anything_unrecognised_is_the_default()
    {
        var junk = View(new { show = "most", sort = "DROP TABLE", order = "sideways", mods = new object[] { "hd", "toolong", 3, "HD" }, grades = new[] { "s", "Z" },
            clients = new[] { "Lazer", "bad client" }, starsMin = -1, starsMax = 7.5, layout = "table", uncounted = "yes", pageSize = 37 });
        Assert.Equal(("best", "pp", "desc", false), (junk.Show, junk.Sort, junk.Order, junk.Uncounted));
        Assert.Equal(["HD"], junk.Mods);
        Assert.Equal(["S"], junk.Grades);
        Assert.Equal(["lazer"], junk.Clients);
        Assert.Equal((null, 7.5), (junk.StarsMin, junk.StarsMax));
        Assert.Equal("table", junk.Layout);
        // osu!'s rows unless the table was picked.
        Assert.Equal("rows", ScoreListView.Coerce(null).Layout);
        // 100 at a time unless one of the offered sizes was picked.
        Assert.Equal(100, junk.PageSize);
        Assert.Equal(250, View(new { pageSize = 250 }).PageSize);

        // Saved with the profile, as the page last set it up.
        SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { scoreList = new { sort = "date", layout = "table" } }));
        var saved = SettingsStore.Get(h.Db, h.ProfileId).ScoreList;
        Assert.Equal(("date", "table"), (saved.Sort, saved.Layout));
    }

    [Fact]
    public void The_filters_offer_only_what_this_modes_scores_have()
    {
        Score("aaa", 300, mods: """[{"acronym":"HD"},{"acronym":"DT"}]""", grade: "SH", client: "stable");
        Score("bbb", 200, mods: "not json", grade: "A");
        var choices = Stats.ScoreListChoices(h.Db, h.ProfileId, 0);
        Assert.Equal(["DT", "HD"], choices.Mods);
        Assert.Equal(["SH", "A"], choices.Grades);
        Assert.Equal(["lazer", "stable"], choices.Clients);
    }

    [Fact]
    public void Its_export_is_the_listed_scores_in_their_order_with_the_playcount_beside_the_pp()
    {
        Score("aaa", 300);
        var b = Score("bbb", 200);
        var c = Score("ccc", 100);
        Attempt("bbb");
        // b's two plays first, then the newest of the single plays.
        var listed = List(View(new { sort = "playcount" }))[..2];
        var t = new Translator(h.Folder, "en");
        var table = Tables.Scores(h.Db, h.ProfileId, e, 0, t, listed: listed);

        var pp = table.Columns.FindIndex(c => c.Header == "pp");
        Assert.Equal("scoreList.playcount", table.Columns[pp + 1].Header);
        Assert.Equal(2, table.Rows.Count);
        Assert.Equal([2.0, 1.0], table.Rows.Select(r => r[pp + 1]));
        Assert.Equal([200.0, 100.0], table.Rows.Select(r => r[pp]));
        Assert.Equal([b, c], listed.Select(p => p.Id));
        // Without a list, every score, and no playcount column.
        Assert.DoesNotContain(Tables.Scores(h.Db, h.ProfileId, e, 0, t).Columns, c => c.Header == "scoreList.playcount");
    }
}
