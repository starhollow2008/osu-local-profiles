using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tests;

/// <summary>Torii's and Ritsu's own mods, on the lazer replays they write.</summary>
public sealed class ToriiTests
{
    private static ReplayScore LazerPlay(params object[] mods) =>
        Osr.Parse(ReplayWriter.Encode(
            new ReplayHeader(0, 30000016, "8317fc5aaee2196ce12b3b7cada74beb", "Tangy", "d0ebef9dc1589c1c616153c855b01abb",
                new LegacyCounts(37, 7, 0, 3, 6, 0), 54612, 79, false, 0, 1_763_000_000_000, 0),
            [ReplayWriter.LazerBlock(new
            {
                online_id = -1,
                mods,
                statistics = new { great = 37, ok = 7 },
                maximum_statistics = new { great = 44 },
                client_version = "2026.1026.0-torii",
                rank = "A",
                user_id = 1,
                pauses = Array.Empty<object>(),
            })]));

    [Fact]
    public void A_mod_that_changes_the_beatmap_leaves_the_play_without_pp()
    {
        var spaced = LazerPlay(new { acronym = "SA", settings = new { object_spacing = 1.5 } }, new { acronym = "HD" });
        Assert.Equal("lazer", spaced.Client);
        Assert.True(Mods.ScorePricing(spaced, null).Unpriceable);
        foreach (var acronym in Torii.Unpriced) Assert.True(Mods.ScorePricing(LazerPlay(new { acronym }), null).Unpriceable, acronym);
    }

    [Fact]
    public void A_mod_that_leaves_the_beatmap_alone_is_priced_as_osu_prices_the_rest()
    {
        foreach (var acronym in Torii.Priced) Assert.Equal(new PriceOptions(), Mods.ScorePricing(LazerPlay(new { acronym }, new { acronym = "DT" }), null));
        Assert.Equal(new PriceOptions(), Mods.ScorePricing(LazerPlay(new { acronym = "DT" }), null));
        Assert.Empty(Torii.Priced.Intersect(Torii.Unpriced));
    }

    [Fact]
    public void The_tracking_filter_keeps_a_four_letter_acronym()
    {
        var filter = TrackingFilter.Coerce(JsonText.From(new { enabled = true, mods = new Dictionary<string, string> { ["RDV2"] = "excluded", ["ABCDE"] = "excluded" } }));
        Assert.Equal("excluded", filter.Mods["RDV2"]);
        Assert.False(filter.Mods.ContainsKey("ABCDE"));
    }

    [Fact]
    public void A_client_with_mods_of_its_own_is_found_by_its_folder()
    {
        // McOsu and neomod by a folder of theirs, tracked or only found; stable, lazer and neki have none.
        Assert.Equal(["mcosu", "neomod"], Torii.ClientsWithOwnMods(
            [("stable", "/games/osu!"), ("lazer", "/home/p/.local/share/osu"), ("neki", "/games/neki"), ("neomod", "/games/neomod"), ("mcosu", "/games/McOsu")], null));
        Assert.Empty(Torii.ClientsWithOwnMods([], null));

        // Torii and Ritsu write lazer folders: a lazer folder that is theirs, by its name.
        Assert.Equal(["ritsu", "torii"], Torii.ClientsWithOwnMods([("lazer", "/home/p/.local/share/osu-torii"), ("lazer", "/home/p/.local/share/ritsu/")], null));
        // Not a folder somewhere below one of that name.
        Assert.Empty(Torii.ClientsWithOwnMods([("lazer", "/home/Ritsu/.local/share/osu")], null));

        // Or their own folder beside lazer's, wherever their files went.
        using var temp = new TempDb();
        Directory.CreateDirectory(Path.Combine(temp.Folder, "osu-torii"));
        var machine = new DetectEnvironment("win32", Path.Combine(temp.Folder, "home"), new Dictionary<string, string?> { ["APPDATA"] = temp.Folder });
        Assert.Equal(["torii"], Torii.ClientsWithOwnMods([], machine));
        Directory.CreateDirectory(Path.Combine(temp.Folder, "Ritsu"));
        Assert.Equal(["ritsu", "torii"], Torii.ClientsWithOwnMods([], machine));
    }
}
