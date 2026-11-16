using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>Options -> pp calculator (dotnet/App/PpCalculation.cs), priced by osu!'s own calculator.</summary>
public sealed class PpCalculationTests : IDisposable
{
    private readonly TempDb h = new();

    public void Dispose() => h.Dispose();

    /// <summary>Twenty circles and a slider: 21 objects for osu!, droplets and drops once caught.</summary>
    private static string Beatmap(string version = "Normal")
    {
        var circles = string.Join("\n", Enumerable.Range(0, 20).Select(i => $"{64 + i * 16},192,{1000 + i * 250},1,0,0:0:0:0:"));
        return $"""
            osu file format v14

            [General]
            AudioFilename: audio.mp3
            Mode: 0

            [Metadata]
            Title:Calc
            Artist:Test
            Creator:Tester
            Version:{version}
            BeatmapID:0
            BeatmapSetID:-1

            [Difficulty]
            HPDrainRate:5
            CircleSize:4
            OverallDifficulty:8
            ApproachRate:9
            SliderMultiplier:1.4
            SliderTickRate:1

            [TimingPoints]
            0,250,4,2,0,100,1,0

            [HitObjects]
            {circles}
            256,192,7000,2,0,L|448:192,1,280
            """.Replace("\r\n", "\n");
    }

    private EntryDeps Deps()
    {
        var (calculator, problem) = OfficialCalculator.Create();
        Assert.True(calculator is not null, problem);
        var tracker = new PlayTracker(h.Db, new BeatmapResolver(h.Db, []), [], h.ProfileId, 0, calculator);
        return EntryDeps.Of(tracker, h.Db, h.Folder, h.ProfileId, new FakeOsu(_ => throw new HttpRequestException("offline")).Client());
    }

    private static Task<CalculatedPlay> Calculate(EntryDeps deps, object input) => PpCalculation.Calculate(deps, JsonText.From(input));

    [Fact]
    public void Mods_are_taken_as_osu_writes_them_with_Classic_left_to_osu()
    {
        string? Parse(object? mods) =>
            PpCalculation.ParseMods(mods is null ? null : JsonText.From(mods), out var error) is { } list ? JsonText.Stringify(list) : error;
        Assert.Equal("""[{"acronym":"HD"},{"acronym":"DT","settings":{"speed_change":1.3}}]""",
            Parse(new object[] { new { acronym = "HD" }, new { acronym = "CL" }, new { acronym = "DT", settings = new { speed_change = 1.3 } }, new { acronym = "HD" } }));
        Assert.Equal("[]", Parse(null));
        Assert.Equal("AT cannot be calculated", Parse(new[] { new { acronym = "AT" } }));
        Assert.Equal("DA's settings are not readable", Parse(new[] { new { acronym = "DA", settings = new { approach_rate = "ten" } } }));
        Assert.Equal("a mod has no acronym", Parse(new[] { new { acronym = "<b>" } }));
        Assert.Equal("the mods are not a list of mods", Parse("HDDT"));
    }

    [Fact]
    public async Task With_no_judgements_it_is_a_perfect_full_combo_from_osus_own_count()
    {
        var deps = Deps();
        var beatmap = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap()));
        var play = await Calculate(deps, new { md5 = beatmap.Md5, mode = 0, mods = new[] { new { acronym = "HD" } } });

        Assert.Equal(21, play.Counts["c300"]);
        Assert.Equal(21, play.Perfect!["c300"]);
        Assert.Equal(play.MaxCombo, play.Combo);
        Assert.Equal(1, play.Accuracy);
        Assert.Equal("XH", play.Rank);
        Assert.True(play.Pp > 0);
        Assert.Contains(play.Breakdown, p => p.Name == "Aim");
        Assert.Equal(OfficialCalculator.Create().Calculator!.Version, play.Version);
        Assert.True(play.Ranked);
    }

    [Fact]
    public async Task Judgements_combo_and_a_custom_speed_move_the_pp()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;
        var perfect = await Calculate(deps, new { md5, mode = 0 });
        var broken = await Calculate(deps, new { md5, mode = 0, counts = new { c300 = 19, c100 = 1, miss = 1 }, combo = 10 });
        Assert.True(broken.Pp < perfect.Pp);
        Assert.Equal(10, broken.Combo);
        Assert.True(broken.Accuracy < 1);

        var faster = await Calculate(deps, new { md5, mode = 0, mods = new[] { new { acronym = "DT", settings = new { speed_change = 1.3 } } } });
        Assert.True(faster.Stars > perfect.Stars);
        // osu! does not rank a changed speed.
        Assert.False(faster.Ranked);
    }

    [Fact]
    public async Task Every_object_is_judged_once_and_the_combo_cannot_pass_the_beatmaps()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;
        Assert.Equal("the judgements add up to 20, and this beatmap has 21",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(deps, new { md5, mode = 0, counts = new { c300 = 20 } }))).Message);
        var max = (await Calculate(deps, new { md5, mode = 0 })).MaxCombo;
        Assert.Equal($"a combo of {max + 1} is more than this beatmap's maximum of {max}",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(deps, new { md5, mode = 0, combo = max + 1 }))).Message);
        Assert.Equal("choose a beatmap first",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(deps, new { md5 = new string('0', 32), mode = 0 }))).Message);
    }

    [Fact]
    public async Task A_converted_play_starts_from_osus_count_of_its_judgements()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;

        // catch: the slider's fruits, drops and droplets, as stable's 300s, 100s and 50s.
        var fruits = await Calculate(deps, new { md5, mode = 2 });
        Assert.True(fruits.Perfect!["c300"] > 20, $"{fruits.Perfect["c300"]}");
        Assert.True(fruits.Perfect["c100"] > 0 && fruits.Perfect["c50"] > 0, JsonText.Stringify(fruits.Perfect));
        Assert.True(fruits.Pp > 0);

        // mania: one judgement per note as osu! converts them (a chord is several), all MAX.
        var keys = await Calculate(deps, new { md5, mode = 3, mods = new[] { new { acronym = "4K" } } });
        Assert.Equal(["geki"], keys.Perfect!.Keys);
        Assert.True(keys.Perfect["geki"] >= 21, JsonText.Stringify(keys.Perfect));
        Assert.Equal(keys.Perfect["geki"], keys.Counts["geki"]);
    }

    [Fact]
    public void Only_a_beatmap_file_is_taken_and_it_is_kept_to_be_found_again()
    {
        var deps = Deps();
        Assert.Equal("that file is not an osu! beatmap (.osu)",
            Assert.Throws<InvalidOperationException>(() => PpCalculation.Upload(deps, Encoding.UTF8.GetBytes("not a beatmap"))).Message);
        Assert.Equal("that beatmap has no objects",
            Assert.Throws<InvalidOperationException>(() => PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap().Split("[HitObjects]")[0] + "[HitObjects]\n"))).Message);

        var kept = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap("Kept")));
        Assert.Equal((21, 0), (kept.Objects, kept.Mode));
        Assert.Contains(ScoreEntry.Search(deps, "tester kept"), b => b.Md5 == kept.Md5);
    }
}
