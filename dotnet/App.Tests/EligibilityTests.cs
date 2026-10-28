using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// test/eligibility.test.ts: the rules, and the SQL run against a real database. The figures built
/// on it (top plays, stats, history) are ported in phase 2.
/// </summary>
public class EligibilityTests
{
    private static string Json(object value) => JsonText.Stringify(value);

    private static Eligibility Rules(Action<ProfileSettings> change)
    {
        var settings = SettingsStore.Defaults();
        change(settings);
        return Eligibility.Of(settings);
    }

    /// <summary>The profile as osu! would score it: unranked mods and beatmaps off.</summary>
    private static Eligibility Official(Action<ProfileSettings> change) => Rules(s =>
    {
        s.IncludeUnrankedMods = false;
        s.IncludeUnrankedMaps = [];
        change(s);
    });

    [Fact]
    public void A_new_profile_counts_every_unranked_mod_and_beatmap_by_default()
    {
        Assert.Equal(Json(Eligibility.Vanilla with
        {
            IncludeUnrankedMods = true,
            PreferStrippedPp = false,
            ExtraMapStatuses = [Status.Unresolved, Status.Graveyard, Status.Wip, Status.Pending, Status.Qualified, Status.Loved],
            CountUnsubmitted = true,
        }), Json(Rules(_ => { })));
    }

    [Fact]
    public void The_pp_basis_only_applies_while_unranked_mods_are_counted_at_all()
    {
        Assert.Equal(Json(Eligibility.Vanilla with { CountUnsubmitted = true }), Json(Official(_ => { })));
        Assert.False(Rules(s => s.IncludeUnrankedMods = true).PreferStrippedPp);
        Assert.True(Rules(s => { s.IncludeUnrankedMods = true; s.UnrankedModPp = "without-the-mod"; }).PreferStrippedPp);
        Assert.False(Official(s => s.UnrankedModPp = "without-the-mod").PreferStrippedPp);
    }

    [Fact]
    public void An_unrecognised_beatmap_state_in_stored_settings_is_dropped_not_trusted()
    {
        Assert.Equal([Status.Loved], Rules(s => s.IncludeUnrankedMaps = ["loved", "nonsense", "loved"]).ExtraMapStatuses);
    }

    [Fact]
    public void The_scoring_scale_picks_which_score_column_every_query_reads()
    {
        Assert.Equal("COALESCE(s.score_standard, s.total_score)", Eligibility.ScoreColumn(Eligibility.Vanilla));
        Assert.Equal("COALESCE(s.score_classic, s.total_score)", Eligibility.ScoreColumn(Eligibility.Vanilla with { Scoring = "classic" }));
        Assert.Equal("COALESCE(x.score_classic, x.total_score)", Eligibility.ScoreColumn(Eligibility.Vanilla with { Scoring = "classic" }, "x"));
    }

    [Fact]
    public void Lazer_scoring_is_the_default_exactly_as_it_is_on_osu()
    {
        Assert.Equal("lazer", Eligibility.Of(SettingsStore.Defaults()).Scoring);
        Assert.Equal("classic", Rules(s => s.Scoring = "classic").Scoring);
    }

    [Fact]
    public void The_unresolved_flag_follows_whether_a_status_source_exists()
    {
        Assert.False(Eligibility.Of(SettingsStore.Defaults()).CountUnresolved);
        Assert.False(Eligibility.Of(SettingsStore.Defaults(), statusKnown: true).CountUnresolved);
        Assert.True(Eligibility.Of(SettingsStore.Defaults(), statusKnown: false).CountUnresolved);
    }

    [Fact]
    public void Unsubmitted_attempts_count_only_when_asked()
    {
        Assert.Equal("s.hidden_at IS NULL", Eligibility.IncompleteSql(Eligibility.Vanilla with { CountUnsubmitted = true }));
        Assert.Equal("(i.hidden_at IS NULL AND i.unsubmitted = 0)", Eligibility.IncompleteSql(Eligibility.Vanilla, "i"));
    }

    /* ------------------------------------------------------------- the SQL */

    private sealed class Scores : IDisposable
    {
        public TempDb H { get; } = new();
        private int n;

        public void Add(string md5, double? pp, double? ppNomod = null, int mapStatus = Status.Ranked,
            bool modsRanked = true, bool modsCountable = true, bool passed = true)
        {
            var ranked = modsRanked && mapStatus is Status.Ranked or Status.Approved;
            H.Db.Run("""
                INSERT INTO scores
                  (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
                   count300, count100, count50, count_geki, count_katu, count_miss,
                   accuracy, max_combo, total_score, passed, grade, stars, pp,
                   pp_nomod, stars_nomod, map_status, mods_ranked, mods_countable, ranked, played_at)
                 VALUES (?,?,0,?,'lazer','[]','None',100,0,0,0,0,0,0.99,100,500000,?,'S',5.0,?,?,?,?,?,?,?,?)
                """,
                H.ProfileId, $"key-{++n}", md5, passed ? 1 : 0, pp, ppNomod, ppNomod is null ? null : 6.0,
                mapStatus, modsRanked ? 1 : 0, modsCountable ? 1 : 0, ranked ? 1 : 0, Js.Now() + n * 1000);
        }

        /// <summary>The beatmaps that count, and the pp each counts at.</summary>
        public List<(string Md5, double Pp)> Counted(Eligibility e) => H.Db.All(
            $"SELECT s.beatmap_md5, {Eligibility.PpColumn(e)} AS pp FROM scores s WHERE s.profile_id = ? AND {Eligibility.CountsSql(e)} ORDER BY s.beatmap_md5",
            r => (r.GetString(0), r.GetDouble(1)), H.ProfileId);

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public void By_default_only_what_osu_would_rank_counts()
    {
        using var s = new Scores();
        s.Add("ranked", 100);
        s.Add("relax", 300, ppNomod: 150, modsRanked: false);
        s.Add("loved", 200, mapStatus: Status.Loved);
        Assert.Equal([("ranked", 100.0)], s.Counted(Official(_ => { })));
    }

    [Fact]
    public void Including_unranked_mods_priced_without_them_brings_relax_in_at_its_stripped_pp()
    {
        using var s = new Scores();
        s.Add("ranked", 100);
        s.Add("relax", 300, ppNomod: 150, modsRanked: false);
        Assert.Equal([("ranked", 100.0), ("relax", 150.0)],
            s.Counted(Official(x => { x.IncludeUnrankedMods = true; x.UnrankedModPp = "without-the-mod"; })));
        // And by osu!'s own relax-aware price by default.
        Assert.Equal([("ranked", 100.0), ("relax", 300.0)], s.Counted(Official(x => x.IncludeUnrankedMods = true)));
    }

    [Fact]
    public void Autoplay_and_a_failed_play_never_count_however_permissive_the_settings()
    {
        using var s = new Scores();
        s.Add("auto", 999, modsRanked: false, modsCountable: false);
        s.Add("failed", 999, passed: false);
        Assert.Empty(s.Counted(Rules(_ => { })));
    }

    [Fact]
    public void An_unranked_map_counts_once_its_state_is_included_and_unresolved_ones_once_nothing_can_say()
    {
        using var s = new Scores();
        s.Add("loved", 200, mapStatus: Status.Loved);
        s.Add("unknown", 50, mapStatus: Status.Unresolved);
        Assert.Empty(s.Counted(Official(_ => { })));
        Assert.Equal([("loved", 200.0)], s.Counted(Official(x => x.IncludeUnrankedMaps = ["loved"])));
        Assert.Equal([("unknown", 50.0)], s.Counted(Eligibility.Of(OfficialSettings(), statusKnown: false)));
    }

    private static ProfileSettings OfficialSettings()
    {
        var settings = SettingsStore.Defaults();
        settings.IncludeUnrankedMods = false;
        settings.IncludeUnrankedMaps = [];
        return settings;
    }

    [Fact]
    public void A_removed_score_never_counts()
    {
        using var s = new Scores();
        s.Add("ranked", 100);
        s.H.Db.Run("UPDATE scores SET hidden_at = ?", Js.Now());
        Assert.Empty(s.Counted(Rules(_ => { })));
    }

    [Fact]
    public void Scores_predating_the_eligibility_columns_still_count()
    {
        using var s = new Scores();
        s.Add("old", 100);
        s.H.Db.Run("UPDATE scores SET map_status = NULL, mods_ranked = NULL, mods_countable = NULL");
        Assert.Equal([("old", 100.0)], s.Counted(Official(_ => { })));
    }
}
