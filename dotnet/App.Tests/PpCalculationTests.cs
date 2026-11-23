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

    /// <summary>
    /// Twenty circles and a slider: 21 objects for osu!, droplets and drops once caught. Or
    /// <paramref name="count"/> objects, every fourth a slider, for a play long enough to break.
    /// </summary>
    private static string Beatmap(string version = "Normal", int? count = null)
    {
        var circles = count is { } n
            ? string.Join("\n", Enumerable.Range(0, n).Select(i => i % 4 == 3
                ? $"256,192,{1000 + i * 500},2,0,L|448:192,1,140"
                : $"{64 + i % 20 * 16},192,{1000 + i * 500},1,0,0:0:0:0:"))
            : string.Join("\n", Enumerable.Range(0, 20).Select(i => $"{64 + i * 16},192,{1000 + i * 250},1,0,0:0:0:0:"))
                + "\n256,192,7000,2,0,L|448:192,1,280";
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
    public async Task Stables_score_prices_the_combo_breaks_with_stables_own_mods_only()
    {
        var deps = Deps();
        // Long enough for osu!'s count of the breaks to come to more than one.
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap("Long", 400))).Md5;
        var counts = new { c300 = 390, c100 = 10 };
        var guessed = await Calculate(deps, new { md5, mode = 0, counts, combo = 150 });
        Assert.Null(guessed.StableScoreUsed);

        // A score that low leaves room for no more than what was held, and one that high for no break at all.
        var low = await Calculate(deps, new { md5, mode = 0, counts, combo = 150, score = 1 });
        var high = await Calculate(deps, new { md5, mode = 0, counts, combo = 150, score = 50_000_000 });
        Assert.True(low.StableScoreUsed);
        Assert.True(high.StableScoreUsed);
        Assert.True(high.Pp > low.Pp, $"{high.Pp} > {low.Pp}, guessed {guessed.Pp}");

        // Stable never played a changed speed, so its score cannot say anything there.
        var dt = new[] { new { acronym = "DT", settings = new { speed_change = 1.3 } } };
        var custom = await Calculate(deps, new { md5, mode = 0, mods = dt, counts, combo = 150, score = 1 });
        Assert.False(custom.StableScoreUsed);
        Assert.Equal((await Calculate(deps, new { md5, mode = 0, mods = dt, counts, combo = 150 })).Pp, custom.Pp);

        // Nor does it say anything without Classic.
        Assert.False((await Calculate(deps, new { md5, mode = 0, classic = false, counts, combo = 150, score = 1 })).StableScoreUsed);
        Assert.Equal("the score is a whole number",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(deps, new { md5, mode = 0, score = "lots" }))).Message);
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

    [Fact]
    public void A_search_comes_a_page_at_a_time_and_says_when_there_is_more()
    {
        var deps = Deps();
        var md5s = Enumerable.Range(0, 5).Select(i => PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap($"Paged {i}"))).Md5).ToHashSet();
        var first = ScoreEntry.SearchPage(deps, "paged", 0, 3);
        var second = ScoreEntry.SearchPage(deps, "paged", 3, 3);
        Assert.Equal((3, true), (first.Beatmaps.Count, first.More));
        Assert.Equal((2, false), (second.Beatmaps.Count, second.More));
        Assert.Equal(md5s, first.Beatmaps.Concat(second.Beatmaps).Select(b => b.Md5).ToHashSet());
        // Who mapped each, for its row.
        Assert.All(first.Beatmaps, b => Assert.Equal("Tester", b.Creator));
    }

    [Fact]
    public async Task Without_Classic_an_osu_play_is_scored_as_lazer_scores_it()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;

        var perfect = await Calculate(deps, new { md5, mode = 0, classic = false });
        Assert.False(perfect.Classic);
        Assert.Equal(1, perfect.SliderEnds);
        Assert.True(perfect.SliderTicks > 0, $"{perfect.SliderTicks}");
        Assert.Equal((1d, "X"), (perfect.Accuracy, perfect.Rank));
        Assert.Equal(perfect.MaxCombo, perfect.Combo);

        // A missed slider end costs lazer accuracy and a combo point, and stable has no such thing.
        var dropped = await Calculate(deps, new { md5, mode = 0, classic = false, counts = new { c300 = 21, tailMiss = 1 } });
        Assert.True(dropped.Accuracy < 1);
        Assert.Equal(perfect.MaxCombo - 1, dropped.Combo);
        Assert.Equal(1, dropped.Counts["tailMiss"]);
        var stable = await Calculate(deps, new { md5, mode = 0, counts = new { c300 = 21, tailMiss = 1 } });
        Assert.Equal((1d, true), (stable.Accuracy, stable.Classic));
        Assert.False(stable.Counts.ContainsKey("tailMiss"));

        // The same judgements are worth a different accuracy, and pp, once slider heads are judged.
        var lazer = await Calculate(deps, new { md5, mode = 0, classic = false, counts = new { c300 = 18, c100 = 3 } });
        var classic = await Calculate(deps, new { md5, mode = 0, counts = new { c300 = 18, c100 = 3 } });
        Assert.NotEqual(classic.Accuracy, lazer.Accuracy);
        Assert.NotEqual(classic.Pp, lazer.Pp);

        Assert.Equal("this beatmap has 1 slider ends",
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(deps, new { md5, mode = 0, classic = false, counts = new { c300 = 21, tailMiss = 2 } }))).Message);
    }

    [Fact]
    public async Task A_source_build_from_an_earlier_app_prices_typed_judgements_and_says_to_rebuild_for_the_rest()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;

        // Before the judgements request: no perfect play, so the judgements are typed, and Classic only.
        var old = deps with { PerfectJudgements = (_, _, _) => Task.FromResult<PerfectPlay?>(null) };
        var typed = await Calculate(old, new { md5, mode = 0, counts = new { c300 = 20, c100 = 1 } });
        Assert.Null(typed.Perfect);
        Assert.True(typed.Pp > 0);
        Assert.Equal(PpCalculation.NeedsRebuild,
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(old, new { md5, mode = 0, classic = false, counts = new { c300 = 21 } }))).Message);

        // Before its slider ends and ticks: a perfect play with Classic, and still not without it.
        var real = await deps.PerfectJudgements(deps.Resolver.Resolve(md5).OsuPath!, 0, []);
        var noEnds = deps with { PerfectJudgements = (_, _, _) => Task.FromResult<PerfectPlay?>(real! with { Lazer = null }) };
        Assert.Equal(21, (await Calculate(noEnds, new { md5, mode = 0 })).Perfect!["c300"]);
        Assert.Equal(PpCalculation.NeedsRebuild,
            (await Assert.ThrowsAsync<InvalidOperationException>(() => Calculate(noEnds, new { md5, mode = 0, classic = false }))).Message);
    }

    [Fact]
    public async Task Without_Classic_a_taiko_play_has_Hiddens_lazer_bonus()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;
        var hidden = new[] { new { acronym = "HD" } };
        var lazer = await Calculate(deps, new { md5, mode = 1, classic = false, mods = hidden });
        var stable = await Calculate(deps, new { md5, mode = 1, mods = hidden });
        Assert.False(lazer.Classic);
        Assert.True(lazer.Pp < stable.Pp, $"{lazer.Pp} {stable.Pp}");
        Assert.Equal(1, lazer.Accuracy);

        // Catch and mania are the same either way, and so are always as stable scores them.
        Assert.True((await Calculate(deps, new { md5, mode = 2, classic = false })).Classic);
    }

    /// <summary>The page's mod table, which says which rulesets have each mod.</summary>
    private static Dictionary<string, int[]> ModRulesets([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        var table = File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "web", "js", "mod-definitions.js"));
        return System.Text.RegularExpressions.Regex.Matches(table, @"^\s*""(\w+)"": \{.*?""modes"":\[([\d,]*)\]", System.Text.RegularExpressions.RegexOptions.Multiline)
            .ToDictionary(m => m.Groups[1].Value, m => m.Groups[2].Value.Split(',').Select(int.Parse).ToArray());
    }

    /// <summary>
    /// Every mod the calculator shows dimmed still leaves the pp and stars as they are, on a play with
    /// every kind of mistake. A new osu! release that makes one of them count fails here.
    /// </summary>
    [Fact]
    public async Task The_mods_shown_as_not_changing_pp_do_not_change_it()
    {
        var deps = Deps();
        var md5 = PpCalculation.Upload(deps, Encoding.UTF8.GetBytes(Beatmap())).Md5;
        var rulesets = ModRulesets();
        foreach (var (mode, acronyms) in PpCalculation.NoPp)
        {
            var perfect = (await Calculate(deps, new { md5, mode })).Perfect!;
            var counts = new Dictionary<string, double>(perfect);
            var best = mode == 3 ? "geki" : "c300";
            var worse = mode switch { 0 => new[] { "c100", "c50", "miss" }, 1 => ["c100", "miss"], 2 => ["miss"], _ => ["c300", "katu", "c100", "c50", "miss"] };
            foreach (var key in worse)
            {
                counts[best]--;
                counts[key] = counts.GetValueOrDefault(key) + 1;
            }
            if (mode == 2 && counts.GetValueOrDefault("c50") > 0)
            {
                counts["c50"]--;
                counts["katu"] = 1;
            }
            foreach (var classic in mode is 0 or 1 ? new[] { true, false } : [true])
            {
                var play = new { md5, mode, classic, counts, combo = 5 };
                var plain = await Calculate(deps, play);
                foreach (var acronym in acronyms.Where(a => a != "CL"))
                {
                    Assert.True(rulesets.TryGetValue(acronym, out var modes) && modes.Contains(mode), $"{acronym} is not one of ruleset {mode}'s mods");
                    var with = await Calculate(deps, new { play.md5, play.mode, play.classic, play.counts, play.combo, mods = new[] { new { acronym } } });
                    Assert.True(with.Pp == plain.Pp && with.Stars == plain.Stars,
                        $"{acronym} changes ruleset {mode}'s pp{(classic ? "" : " without Classic")}: {with.Pp} and {with.Stars}* against {plain.Pp} and {plain.Stars}*");
                }
            }
        }
    }
}
