using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Tests;

/// <summary>test/medals.test.ts, the families' rules.</summary>
public class MedalsTests
{
    private sealed class Harness : IDisposable
    {
        public TempDb H { get; } = new();
        private int n;

        public void Add(int combo = 100, int? beatmapMaxCombo = null, int miss = 0, double? stars = 5.0, int hits = 100,
            bool passed = true, int mode = 0, double? pp = 100, string? md5 = null, long? at = null, string mods = "[]",
            string client = "lazer", int status = Status.Ranked, bool modsRanked = true, long? beatmapId = null)
        {
            n++;
            H.Db.Run("""
                INSERT INTO scores
                  (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
                   count300, count100, count50, count_geki, count_katu, count_miss,
                   accuracy, max_combo, total_score, passed, grade, stars, pp,
                   beatmap_max_combo, map_status, mods_ranked, mods_countable, ranked, beatmap_id, played_at)
                 VALUES (?,?,?,?,?,?,'',?,0,0,0,0,?,0.99,?,500000,?,'S',?,?,?,?,?,1,1,?,?)
                """,
                H.ProfileId, $"key-{n}", mode, md5 ?? $"md5-{n}", client, mods, hits, miss, combo, passed ? 1 : 0,
                stars, pp, beatmapMaxCombo, status, modsRanked ? 1 : 0, beatmapId, at ?? 1_700_000_000_000 + n * 60_000);
        }

        public MedalSummary Medals(int mode = 0) => OsuLocalProfiles.Calc.Medals.Compute(H.Db, H.ProfileId, mode, Eligibility.Vanilla);

        public List<string> Earned(int mode = 0, string? containing = null) =>
            [.. Medals(mode).Medals.Where(m => m.AchievedAt is not null).Select(m => m.Slug)
                .Where(s => containing is null || s.Contains(containing)).Order(StringComparer.Ordinal)];

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public void An_empty_profile_has_every_medal_locked_and_none_missing()
    {
        using var h = new Harness();
        var summary = h.Medals();
        Assert.Equal(0, summary.Earned);
        // osu!standard: 13 Mod Introduction, then 4 combo + 4 plays + 10 pass + 10 fc + 4 rank.
        Assert.Equal(45, summary.Total);
    }

    [Fact]
    public void Combo_medals_unlock_at_their_thresholds_and_are_dated_by_the_first_play_to_reach_them()
    {
        using var h = new Harness();
        h.Add(combo: 499, at: 1000);
        Assert.Empty(h.Earned(containing: "osu-combo"));
        h.Add(combo: 600, at: 2000);
        h.Add(combo: 2000, at: 3000);
        Assert.Equal(["osu-combo-1000", "osu-combo-2000", "osu-combo-500", "osu-combo-750"], h.Earned(containing: "osu-combo"));
        Assert.Equal(2000L, h.Medals().Medals.Single(m => m.Slug == "osu-combo-500").AchievedAt);
    }

    [Fact]
    public void Families_come_in_osus_own_ordering()
    {
        using var h = new Harness();
        h.Add(combo: 250);
        Assert.Equal(["intro", "combo", "plays", "rank", "pass", "fc"], h.Medals().Medals.Select(m => m.Family).Distinct());
    }

    [Fact]
    public void Each_star_medal_is_its_own_band()
    {
        using var h = new Harness();
        h.Add(stars: 5.9, combo: 1);
        Assert.Equal(["osu-skill-pass-5"], h.Earned(containing: "skill-pass"));
        h.Add(stars: 2.0, combo: 1);
        Assert.Equal(["osu-skill-pass-2", "osu-skill-pass-5"], h.Earned(containing: "skill-pass"));
    }

    [Fact]
    public void Below_one_star_beyond_the_last_failed_or_unrated_earns_no_star_medal()
    {
        using var h = new Harness();
        h.Add(stars: 0.8, combo: 1);
        h.Add(stars: 11.2, combo: 1);
        h.Add(stars: 9.5, passed: false, combo: 1);
        h.Add(stars: null, combo: 1);
        Assert.Empty(h.Earned(containing: "skill"));
    }

    [Fact]
    public void Star_medals_are_for_ranked_and_approved_maps_only()
    {
        using var h = new Harness();
        h.Add(stars: 1.5, status: Status.Loved);
        h.Add(stars: 2.5, status: Status.Qualified);
        h.Add(stars: 3.5, status: Status.Graveyard);
        h.Add(stars: 4.5, status: Status.Approved);
        Assert.Equal(["osu-skill-pass-4"], h.Earned(containing: "skill"));
    }

    [Fact]
    public void Difficulty_reduction_automation_and_unranked_mods_earn_no_star_medal()
    {
        using var h = new Harness();
        foreach (var acronym in new[] { "EZ", "NF", "HT", "DC", "SO", "RX", "AP", "AT", "CN" })
        {
            h.Add(stars: 7.5, mods: $"[{{\"acronym\":\"{acronym}\"}}]", combo: 500, beatmapMaxCombo: 500);
        }
        h.Add(stars: 8.5, mods: """[{"acronym":"DT","settings":{"speed_change":1.3}}]""", modsRanked: false);
        Assert.Empty(h.Earned(containing: "skill"));
        // A play that could never earn a star FC is not counted as an unknown one.
        Assert.Equal(0, h.Medals().FcUnknown);

        h.Add(stars: 7.5, mods: """[{"acronym":"HD"},{"acronym":"DT"}]""", combo: 500, beatmapMaxCombo: 500);
        Assert.Equal(["osu-skill-fc-7", "osu-skill-pass-7"], h.Earned(containing: "skill"));
    }

    [Fact]
    public void Mania_key_mods_and_taikos_exempt_beatmap_earn_no_star_medal()
    {
        using var h = new Harness();
        foreach (var acronym in new[] { "4K", "7K", "10K", "DS" }) h.Add(mode: 3, stars: 3.5, mods: $"[{{\"acronym\":\"{acronym}\"}}]");
        Assert.Empty(h.Earned(3, "skill"));
        h.Add(mode: 3, stars: 3.5, mods: """[{"acronym":"MR"}]""");
        Assert.Equal(["mania-skill-pass-3"], h.Earned(3, "skill"));

        h.Add(mode: 1, stars: 2.5, beatmapId: 19990);
        Assert.Empty(h.Earned(1, "skill"));
        h.Add(mode: 0, stars: 2.5, beatmapId: 19990);
        Assert.Equal(["osu-skill-pass-2"], h.Earned(0, "skill"));
    }

    [Fact]
    public void A_full_combo_needs_the_whole_combo_and_no_miss_and_an_unknown_maximum_is_reported()
    {
        using var h = new Harness();
        h.Add(stars: 3.2, combo: 400, beatmapMaxCombo: 500);
        h.Add(stars: 3.2, miss: 1, combo: 500, beatmapMaxCombo: 500);
        Assert.Empty(h.Earned(containing: "-fc-"));
        Assert.Equal(0, h.Medals().FcUnknown);
        h.Add(stars: 3.2, combo: 500, beatmapMaxCombo: 500);
        Assert.Equal(["osu-skill-fc-3"], h.Earned(containing: "-fc-"));
        h.Add(stars: 6.5, combo: 900);
        Assert.Equal(1, h.Medals().FcUnknown);
        Assert.Contains("osu-skill-pass-6", h.Earned());
    }

    [Fact]
    public void A_Mod_Introduction_medal_needs_that_mod_alone_at_its_defaults()
    {
        static bool Earns(object rule, int ruleset, string client, params object[] mods) =>
            Medals.EarnsIntroMedal(JsonText.From(rule), [.. mods.Select(JsonText.From)], ruleset, client);
        var hr = new { mod = "HR" };
        Assert.True(Earns(hr, 0, "lazer", new { acronym = "HR" }));
        Assert.False(Earns(hr, 0, "lazer", new { acronym = "HR" }, new { acronym = "HD" }));
        Assert.False(Earns(hr, 0, "lazer"));
        Assert.True(Earns(hr, 0, "stable", new { acronym = "HR" }, new { acronym = "CL" }));
        Assert.True(Earns(hr, 0, "lazer", new { acronym = "HR" }, new { acronym = "TD" }));
        Assert.False(Earns(new { mod = "DT" }, 0, "lazer", new { acronym = "DT", settings = new { speed_change = 1.2 } }));
        Assert.False(Earns(new { mod = "DT" }, 0, "lazer", new { acronym = "NC" }));
        Assert.True(Earns(new { mod = "SO", ruleset = 0 }, 0, "lazer", new { acronym = "SO" }));
        Assert.False(Earns(new { mod = "SO", ruleset = 0 }, 1, "lazer", new { acronym = "SO" }));
        // Conversion and Fun are lazer's, and take the ruleset's own mod types.
        Assert.True(Earns(new { type = "Conversion" }, 0, "lazer", new { acronym = "MR" }, new { acronym = "HD" }));
        Assert.True(Earns(new { type = "Conversion" }, 3, "lazer", new { acronym = "4K" }));
        Assert.False(Earns(new { type = "Conversion" }, 0, "stable", new { acronym = "MR" }));
    }

    [Fact]
    public void Mod_Introduction_medals_come_from_any_mode_and_only_passes()
    {
        using var h = new Harness();
        h.Add(mods: """[{"acronym":"HD"}]""", passed: false);
        Assert.Null(h.Medals().Medals.Single(m => m.Slug == "all-intro-hidden").AchievedAt);
        h.Add(mods: """[{"acronym":"HD"}]""", mode: 1, at: 1_700_000_500_000);
        foreach (var mode in new[] { 0, 1, 3 })
        {
            var medal = h.Medals(mode).Medals.Single(m => m.Slug == "all-intro-hidden");
            Assert.Equal(1_700_000_500_000L, medal.AchievedAt);
            Assert.Equal("Mod Introduction", medal.Grouping);
        }
    }

    [Fact]
    public void A_medal_imported_from_osu_is_earned_on_its_date_unless_a_play_here_was_first()
    {
        using var h = new Harness();
        h.Add(combo: 600, at: 5000);
        h.H.Db.Run("INSERT INTO imported_medals (profile_id, slug, achieved_at, imported_at) VALUES (?, 'osu-combo-500', 9000, 1), (?, 'osu-combo-750', 7000, 1)",
            h.H.ProfileId, h.H.ProfileId);
        var medals = h.Medals().Medals;
        var kept = medals.Single(m => m.Slug == "osu-combo-500");
        Assert.Equal(5000L, kept.AchievedAt);
        Assert.False(kept.FromOsu);
        var borrowed = medals.Single(m => m.Slug == "osu-combo-750");
        Assert.Equal(7000L, borrowed.AchievedAt);
        Assert.True(borrowed.FromOsu);
        Assert.Null(borrowed.EarnedOn);
    }
}
