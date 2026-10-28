using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Tests;

/// <summary>test/calc.test.ts, test/rank.test.ts and test/play-time.test.ts.</summary>
public class CalcTests
{
    [Fact]
    public void Bonus_pp_tops_out_at_the_documented_413_894()
    {
        Assert.Equal(0, Pp.BonusPp(0));
        Assert.True(Math.Abs(Pp.BonusPp(1000) - 413.894) < 0.01);
        // Capped: playing more than 1000 ranked maps adds nothing.
        Assert.Equal(Pp.BonusPp(1000), Pp.BonusPp(5000));
        var half = Pp.BonusPp(138) / Pp.BonusPp(1000);
        Assert.InRange(half, 0.49, 0.51);
    }

    [Fact]
    public void Total_pp_weights_each_successive_play_by_0_95()
    {
        Assert.Equal(0, Pp.WeightedTotal([]));
        Assert.Equal(100, Pp.WeightedTotal([100]));
        Assert.True(Math.Abs(Pp.WeightedTotal([100, 100]) - 195) < 1e-9);
        Assert.True(Math.Abs(Pp.WeightedTotal([100, 100, 100]) - (100 + 95 + 90.25)) < 1e-9);
    }

    [Fact]
    public void Profile_accuracy_is_weighted_not_averaged()
    {
        Assert.Equal(0, Pp.WeightedAccuracy([]));
        Assert.True(Math.Abs(Pp.WeightedAccuracy([0.99, 0.99]) - 0.99) < 1e-9);
        Assert.InRange(Pp.WeightedAccuracy([1.0, 0.9]), 0.9500001, 0.9999999);
    }

    [Fact]
    public void The_level_formula_joins_its_two_branches_at_100()
    {
        Assert.True(Math.Abs(Levels.RequiredScore(100) - 26_931_190_827) < 5);
        Assert.True(Math.Abs(Levels.RequiredScore(101) - Levels.RequiredScore(100) - 99_999_999_999) < 5);
        Assert.True(Levels.RequiredScore(99) < Levels.RequiredScore(100));
        Assert.True(Levels.RequiredScore(100) < Levels.RequiredScore(101));
    }

    [Fact]
    public void Level_derives_from_total_score()
    {
        Assert.Equal(new Level(1, 0), Levels.FromScore(0));
        Assert.Equal(1, Levels.FromScore(-5).Current);
        var atTen = Levels.FromScore(Levels.RequiredScore(10));
        Assert.Equal(10, atTen.Current);
        Assert.True(atTen.Progress < 0.001);
        var mid = Levels.FromScore((Levels.RequiredScore(10) + Levels.RequiredScore(11)) / 2);
        Assert.Equal(10, mid.Current);
        Assert.True(Math.Abs(mid.Progress - 0.5) < 0.01);
        Assert.Equal(100, Levels.FromScore(Levels.RequiredScore(100)).Current);
    }

    private static readonly double[][] Curve =
    [
        [10, 4_000_000], [100, 1_000_000], [1000, 100_000], [5000, 10_000], [10_000, 1000], [20_000, 1],
    ];

    [Fact]
    public void Rank_interpolation_is_monotonic_and_bounded_by_the_curve()
    {
        Assert.Null(Ranks.Interpolate(Curve, 0));
        Assert.Null(Ranks.Interpolate(Curve, -5));
        Assert.Null(Ranks.Interpolate(Curve, double.NaN));
        Assert.Equal(4_000_000, Ranks.Interpolate(Curve, 1));
        Assert.Equal(1, Ranks.Interpolate(Curve, 999_999));
        Assert.Equal(100_000, Ranks.Interpolate(Curve, 1000));
        long previous = long.MaxValue;
        for (double pp = 10; pp <= 20_000; pp += 37)
        {
            var rank = Ranks.Interpolate(Curve, pp)!.Value;
            Assert.True(rank <= previous, $"rank went backwards at {pp}pp");
            previous = rank;
        }
    }

    [Fact]
    public void Interpolation_is_logarithmic_in_rank_and_a_degenerate_curve_is_refused()
    {
        Assert.InRange(Ranks.Interpolate(Curve, 550)!.Value, 250_001, 399_999);
        Assert.Null(Ranks.Interpolate([], 500));
        Assert.Null(Ranks.Interpolate([[100, 1000]], 500));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Every_modes_rank_table_is_embedded_and_well_formed(int mode)
    {
        var table = Ranks.Table(mode);
        Assert.NotNull(table);
        Assert.Matches(@"^\d{4}_\d{2}_\d{2}\z", table.Dump);
        Assert.True(table.Points.Length >= 2);
        Assert.Null(Ranks.Table(4));
        Assert.Null(Ranks.Table(1.5));
    }

    /* ------------------------------------------------------------------ play time */

    private static string OsuFile(int first, int last) => string.Join("\n",
        "osu file format v14", "", "[General]", "Mode: 0", "", "[HitObjects]",
        $"256,192,{first},1,0,0:0:0:0:",
        $"100,100,{first + 500},2,0,B|200:200,1,100",
        $"256,192,{last - 1000},12,0,{last},0:0:0:0:", "");

    [Fact]
    public void A_beatmap_runs_from_its_first_object_to_the_end_of_its_last()
    {
        Assert.Equal(90_000, PlayTime.BeatmapLengthMs(OsuFile(1000, 91_000)));
        // A mania hold note ends at the time before its colon.
        Assert.Equal(65_000, PlayTime.BeatmapLengthMs("[HitObjects]\n64,192,0,1,0,0:0:0:0:\n64,192,5000,128,0,65000:0:0:0:0:\n"));
        Assert.Equal(0, PlayTime.BeatmapLengthMs("osu file format v14\n[General]\nMode: 0\n"));
        // CRLF files read the same.
        Assert.Equal(90_000, PlayTime.BeatmapLengthMs(OsuFile(1000, 91_000).Replace("\n", "\r\n")));
    }

    [Fact]
    public void Only_osus_rate_adjust_mods_change_the_rate()
    {
        static double Rate(params object[] mods) => PlayTime.PlayRate(mods.Select(JsonText.From));
        Assert.Equal(1, Rate());
        Assert.Equal(1.5, Rate(new { acronym = "DT" }));
        Assert.Equal(0.75, Rate(new { acronym = "HT" }));
        Assert.Equal(1.2, Rate(new { acronym = "DT", settings = new { speed_change = 1.2 } }));
        Assert.Equal(1, Rate(new { acronym = "HD" }, new { acronym = "WU" }));
    }

    [Fact]
    public void Finished_scores_count_their_map_at_the_played_speed_and_abandoned_plays_the_time_in_them()
    {
        using var h = new TempDb();
        var osu = Path.Combine(h.Folder, "map.osu");
        File.WriteAllText(osu, OsuFile(0, 120_000));
        h.Db.Run("INSERT INTO beatmaps (md5, title, osu_path, cached_at) VALUES ('m', 'Map', ?, 0)", osu);
        var n = 0;
        void Score(string mods) => h.Db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               accuracy, max_combo, total_score, passed, grade, played_at)
             VALUES (?, ?, 0, 'm', 'lazer', ?, '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1)
            """, h.ProfileId, $"s{++n}", mods);
        void Incomplete(long? startedAt, long playedAt) => h.Db.Run("""
            INSERT INTO incomplete_plays (profile_id, dedupe_key, mode, beatmap_md5, played_at, started_at)
            VALUES (?, ?, 0, 'm', ?, ?)
            """, h.ProfileId, $"i{++n}", playedAt, startedAt);
        double Total() => PlayTime.Seconds(h.Db, h.ProfileId, 0, Eligibility.Vanilla);

        Score("[]");
        Assert.Equal(120, Total());
        Score("""[{"acronym":"DT"}]""");
        Assert.Equal(200, Total());
        // The length is read once and remembered.
        Assert.Equal(120_000L, h.Db.Scalar("SELECT length_ms FROM beatmaps WHERE md5 = 'm'"));

        h.Db.Run("DELETE FROM scores");
        Incomplete(0, 30_000);
        Assert.Equal(30, Total());
        Incomplete(0, 600_000);
        Assert.Equal(150, Total());
        Incomplete(null, 50_000);
        Assert.Equal(150, Total());
    }
}
