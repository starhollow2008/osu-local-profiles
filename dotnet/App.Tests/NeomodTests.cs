using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>neomod (roadmap 5.85): its folder, its replays and mods record, and how its plays are priced and filed.</summary>
public sealed class NeomodTests : IDisposable
{
    private readonly TempDb h = new("Test Profile");

    public void Dispose() => h.Dispose();

    private const string Map = "8317fc5aaee2196ce12b3b7cada74beb";
    private static readonly double PlayedAt = DateTimeOffset.Parse("2026-11-10T10:38:24Z").ToUnixTimeMilliseconds();

    /// <summary>neomod's flags, by bit (ModFlags.h).</summary>
    private static ulong Bits(params int[] bits) => bits.Aggregate(0UL, (a, b) => a | (1UL << b));

    private const int NF = 0, EZ = 1, AP = 2, RX = 3, HD = 4, HR = 5, FL = 6, SD = 7, PF = 8, NoPitch = 10, TD = 11, SO = 12, SV2 = 13,
        FPoSu = 14, Target = 15, ArLock = 16, OdLock = 17, Timewarp = 18, Wobble = 23, FullAlternate = 26, HalfWindow = 29,
        HalfWindowAllow300s = 30, FlipUpDown = 34, FlipLeftRight = 35, StrictTracking = 41, ApproachDifferent = 42, Singletap = 43,
        Traceable = 49, FreezeFrame = 50;

    private static NeomodFacts Facts(ulong flags = 0, double speed = 1, double ar = -1, double arNegative = 0, double cs = -1,
        double csNegative = 0, double hp = -1, double od = -1, int noteLock = 2) => new(flags, speed, noteLock, ar, arNegative, cs, csNegative, hp, od);

    /// <summary>neomod's mods record as <c>Replay::Mods::pack_and_write</c> writes it, its settings text after.</summary>
    private static byte[] Packed(NeomodFacts f, bool withSettings = true)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(f.Flags);
        w.Write((float)f.Speed);
        w.Write(f.NoteLock);
        foreach (var v in new[] { f.ArOverride, f.ArNegative, f.CsOverride, f.CsNegative, f.HpOverride, f.OdOverride }) w.Write((float)v);
        bool Has(int bit) => (f.Flags & (1UL << bit)) != 0;
        if (Has(AP)) w.Write(0.75f);
        if (Has(Timewarp)) w.Write(1.5f);
        if (Has(Wobble)) w.Write(new byte[12]);
        if (withSettings)
        {
            w.Write(2u);
            foreach (var s in new[] { "mod_hidden", "1" })
            {
                w.Write((byte)0x0b);
                w.Write7BitEncodedInt(s.Length);
                w.Write(Encoding.UTF8.GetBytes(s));
            }
        }
        return ms.ToArray();
    }

    /// <summary>A replay as neomod writes one: stable's layout under 40000000, its mods record after the online id.</summary>
    private static byte[] NeomodReplay(NeomodFacts facts, string player = "Guest", string replayMd5 = "5d3e", double? playedAt = null, int legacyMods = 0) =>
        ReplayWriter.Encode(new ReplayHeader(0, 40000000, Map, player, replayMd5, new LegacyCounts(37, 7, 0, 3, 6, 0), 54612, 79, false,
            legacyMods, playedAt ?? PlayedAt, 0), [Packed(facts)]);

    private static string Label(NeomodFacts facts) => Mods.Label(Neomod.Mods(facts).Mods);

    private static string Json(object value) => JsonText.Stringify(value);

    /* ---------------------------------------------------------------- folder */

    [Fact]
    public void An_install_is_its_folder_with_stables_Songs_from_its_config_and_the_maps_it_downloaded()
    {
        var stable = Path.Combine(h.Folder, "osu!");
        Directory.CreateDirectory(Path.Combine(stable, "Songs"));
        var root = Path.Combine(h.Folder, "neomod");
        Directory.CreateDirectory(Path.Combine(root, "cfg"));
        Directory.CreateDirectory(Path.Combine(root, "maps"));
        File.WriteAllText(Path.Combine(root, "neomod.exe"), "");
        File.WriteAllText(Path.Combine(root, "cfg", "osu.cfg"), $"osu_folder {stable}\\\nname Tangy\n");

        var install = Neomod.Install(root)!;
        Assert.Equal(("neomod", Path.Combine(root, "replays")), (install.Kind, install.ReplayDir));
        Assert.Equal([Path.Combine(stable, "Songs"), Path.Combine(root, "maps")], install.BeatmapRoots);

        // songs_folder, copied from stable's BeatmapDirectory: under osu_folder, or anywhere.
        Directory.CreateDirectory(Path.Combine(stable, "Beatmaps"));
        File.WriteAllText(Path.Combine(root, "cfg", "osu.cfg"), $"osu_folder {stable.Replace('\\', '/')}/\nsongs_folder Beatmaps/\n");
        Assert.Equal(Path.Combine(stable, "Beatmaps"), Neomod.Install(root)!.BeatmapRoots[0]);
        var elsewhere = Path.Combine(h.Folder, "Songs elsewhere");
        Directory.CreateDirectory(elsewhere);
        File.WriteAllText(Path.Combine(root, "cfg", "osu.cfg"), $"osu_folder {stable}\\\nsongs_folder {elsewhere}\\\n");
        Assert.Equal(elsewhere, Neomod.Install(root)!.BeatmapRoots[0]);
        Assert.Equal("neomod", Discover.Classify(root, Path.Combine(h.Folder, "mcosu"))!.Kind);
        Assert.True(Discover.LooksLikeInstall(["neomod.exe", "bass.dll"]));
        File.Delete(Path.Combine(root, "neomod.exe"));
        Assert.Null(Neomod.Install(root));

        var windows = new DetectEnvironment("win32", @"C:\Users\player", new Dictionary<string, string?> { ["LOCALAPPDATA"] = @"C:\Users\player\AppData\Local" });
        var candidates = Neomod.Candidates(windows, ["D:\\"]);
        Assert.Contains(NodePath.Join(@"C:\Users\player", "Downloads", "neomod-win64", "neomod"), candidates);
        Assert.Contains(NodePath.Join("D:\\", "Games", "neomod"), candidates);
        Assert.Equal(["C:\\Games\\neomod\\neomod.exe"], Discover.LnkTargets(Encoding.Latin1.GetBytes("junk C:\\Games\\neomod\\neomod.exe junk")));
    }

    /* --------------------------------------------------------------- replays */

    [Fact]
    public void A_neomod_replay_is_read_as_neomods_with_its_mods_record_and_never_as_lazers()
    {
        var bytes = NeomodReplay(Facts(Bits(HD, Timewarp), speed: 1.2, ar: 9.5), legacyMods: 8 | 64);
        Assert.True(Osr.LooksLikeReplay(bytes));
        var score = Osr.Parse(bytes);
        Assert.Equal(("neomod", 40000000, "Guest", 8 | 64), (score.Client, score.Version, score.Username, score.LegacyMods));
        Assert.Null(score.Extras);
        Assert.Equal(Bits(HD, Timewarp), score.Neomod!.Flags);
        Assert.Equal((1.2, 9.5, -1.0), (Math.Round(score.Neomod.Speed, 4), score.Neomod.ArOverride, score.Neomod.CsOverride));
        Assert.Equal(PlayedAt, score.PlayedAtMs);

        var bad = bytes.ToArray();
        BitConverter.GetBytes(50000000).CopyTo(bad, 1);
        Assert.False(Osr.LooksLikeReplay(bad));
        // A speed neomod could not play is 1, as neomod reads it.
        Assert.Equal(1, Neomod.ReadFacts(Packed(Facts(speed: 80)))!.Speed);
        Assert.Null(Neomod.ReadFacts([1, 2, 3]));
        // The record with nothing after it, as a replay neomod saved without its settings ends.
        Assert.Equal(40, Packed(Facts(), withSettings: false).Length);
        Assert.NotNull(Neomod.ReadFacts(Packed(Facts(), withSettings: false)));

        // Priced from a stable copy: stable's version, the frames kept, neomod's record gone.
        var copy = Osr.StableCopy(bytes)!;
        var stable = Osr.Parse(copy);
        Assert.Equal(("stable", Mcosu.BuiltReplayVersion, (NeomodFacts?)null), (stable.Client, stable.Version, stable.Neomod));
        Assert.Equal((score.ReplayMD5, score.TotalScore, score.LegacyMods), (stable.ReplayMD5, stable.TotalScore, stable.LegacyMods));
    }

    /* ------------------------------------------------------------------ mods */

    [Fact]
    public void Speed_is_a_rate_mod_at_its_rate_and_one_osu_cannot_hold_gets_no_pp()
    {
        Assert.Equal("DT", Label(Facts(speed: 1.5)));
        Assert.Equal("""[{"acronym":"DT","settings":{"speed_change":1.2}}]""", Json(Neomod.Mods(Facts(speed: 1.2)).Mods));
        Assert.Equal("NC", Label(Facts(Bits(NoPitch), speed: 1.5)));
        Assert.Equal("HT", Label(Facts(speed: 0.75)));
        Assert.Equal("""[{"acronym":"DC","settings":{"speed_change":0.8}}]""", Json(Neomod.Mods(Facts(Bits(NoPitch), speed: 0.8)).Mods));
        Assert.Equal("None", Label(Facts(Bits(NoPitch))));
        Assert.Null(Neomod.Mods(Facts(speed: 2.5)).Priced);
        Assert.Null(Neomod.Mods(Facts(speed: 0.4)).Priced);
    }

    [Fact]
    public void Overrides_are_Difficulty_Adjust_after_the_mods_that_change_the_same_values()
    {
        Assert.Equal("""[{"acronym":"HR"},{"acronym":"DA","settings":{"approach_rate":9.5,"overall_difficulty":8}}]""",
            Json(Neomod.Mods(Facts(Bits(HR), ar: 9.5, od: 8)).Mods));
        Assert.Equal("""[{"acronym":"DA","settings":{"circle_size":4,"approach_rate":-5,"extended_limits":true}}]""",
            Json(Neomod.Mods(Facts(cs: 4, arNegative: -5)).Mods));
        Assert.NotNull(Neomod.Mods(Facts(arNegative: -5)).Priced);
        // neomod allows up to 12.5, and CS below 0; DA does not.
        Assert.Null(Neomod.Mods(Facts(ar: 12.5)).Priced);
        Assert.Null(Neomod.Mods(Facts(csNegative: -2)).Priced);
        Assert.Equal("""[{"acronym":"DA","settings":{"drain_rate":11,"extended_limits":true}}]""", Json(Neomod.Mods(Facts(hp: 11)).Priced!));
    }

    [Fact]
    public void Stables_mods_and_lazers_experimental_ones_are_osus_and_the_rest_one_NEO_never_priced()
    {
        Assert.Equal("NFEZTDHDHRPFRXFLSOAPTPSV2", Label(Facts(Bits(NF, EZ, TD, HD, HR, SD, PF, RX, FL, SO, AP, Target, SV2))));
        Assert.Equal("SD", Label(Facts(Bits(SD))));
        // Flip Left/Right is lazer's horizontal reflection, its default; Flip Up/Down the vertical one.
        Assert.Equal("""[{"acronym":"MR"}]""", Json(Neomod.Mods(Facts(Bits(FlipLeftRight))).Mods));
        Assert.Equal("""[{"acronym":"MR","settings":{"reflection":1}}]""", Json(Neomod.Mods(Facts(Bits(FlipUpDown))).Mods));
        Assert.Equal("""[{"acronym":"MR","settings":{"reflection":2}}]""", Json(Neomod.Mods(Facts(Bits(FlipUpDown, FlipLeftRight))).Mods));
        Assert.Equal("ALSGTCSTFRAD", Label(Facts(Bits(FullAlternate, Singletap, Traceable, StrictTracking, FreezeFrame, ApproachDifferent))));

        var own = Neomod.Mods(Facts(Bits(HD, Timewarp, Wobble, FPoSu)));
        Assert.Equal("""[{"acronym":"HD"},{"acronym":"NEO","settings":{"fposu":true,"timewarp":true,"wobble":true}}]""", Json(own.Mods));
        Assert.Equal("HD", Mods.Label(own.Priced!));

        // Late 300s under Half Timing Window is on in every play neomod saves, and nothing alone.
        Assert.Equal("None", Label(Facts(Bits(HalfWindowAllow300s))));
        Assert.Equal("""[{"acronym":"NEO","settings":{"half_timing_window":true}}]""", Json(Neomod.Mods(Facts(Bits(HalfWindow, HalfWindowAllow300s))).Mods));

        // Note lock: stable's is the default; any other is neomod's own.
        Assert.Equal("None", Label(Facts(noteLock: 2)));
        var noLock = Neomod.Mods(Facts(noteLock: 0));
        Assert.Equal("""[{"acronym":"NEO","settings":{"no_note_lock":true}}]""", Json(noLock.Mods));
        Assert.Equal("[]", Json(noLock.Priced!));
    }

    [Fact]
    public void AR_or_OD_locked_to_the_speed_is_DAs_value_before_it_and_unpriced_without_an_override()
    {
        Assert.Equal("None", Label(Facts(Bits(ArLock))));
        // AR 9 held at 1.5x is 600 ms of real time, 900 ms of the map's: AR 7. As played: AR 9 at 1.6x is DA 6.6.
        Assert.Equal("""[{"acronym":"DT"},{"acronym":"DA","settings":{"approach_rate":7}}]""", Json(Neomod.Mods(Facts(Bits(ArLock), speed: 1.5, ar: 9)).Priced!));
        Assert.Equal(6.6, Math.Round(Neomod.UnlockedAr(9, 1.6), 6));
        Assert.Equal(11, Math.Round(Neomod.UnlockedAr(9, 0.5), 6));
        Assert.Equal(2, Math.Round(Neomod.UnlockedAr(5, 1.3), 6));
        // OD 8 held at 1.5x: a 32 ms window, 48 ms of the map's.
        Assert.Equal("""[{"acronym":"DT"},{"acronym":"DA","settings":{"overall_difficulty":5.33}}]""", Json(Neomod.Mods(Facts(Bits(OdLock), speed: 1.5, od: 8)).Priced!));

        // Locking the map's own value would need the map.
        var mapAr = Neomod.Mods(Facts(Bits(ArLock), speed: 1.5));
        Assert.Equal("""[{"acronym":"DT"},{"acronym":"NEO","settings":{"ar_lock":true}}]""", Json(mapAr.Mods));
        Assert.Null(mapAr.Priced);
    }

    [Fact]
    public void Stables_total_is_kept_only_where_neomods_multiplier_is_stables_for_stables_own_mods()
    {
        Assert.False(Neomod.Mods(Facts(Bits(HD, HR), speed: 1.5)).IgnoreLegacyTotalScore);
        Assert.False(Neomod.Mods(Facts(Bits(EZ, FL, SO))).IgnoreLegacyTotalScore);
        // neomod's 0.75x is 0.296, stable's 0.3; its DT under ScoreV2 1.12, stable's 1.2.
        Assert.True(Neomod.Mods(Facts(speed: 0.75)).IgnoreLegacyTotalScore);
        Assert.True(Neomod.Mods(Facts(Bits(SV2), speed: 1.5)).IgnoreLegacyTotalScore);
        // A custom rate, an override or a lazer mod: not stable's at all.
        Assert.True(Neomod.Mods(Facts(speed: 1.2)).IgnoreLegacyTotalScore);
        Assert.True(Neomod.Mods(Facts(ar: 9)).IgnoreLegacyTotalScore);
        Assert.True(Neomod.Mods(Facts(Bits(Singletap))).IgnoreLegacyTotalScore);
    }

    [Fact]
    public void A_neomod_play_is_priced_from_a_stable_copy_with_its_mods_and_scored_as_stable()
    {
        var score = Osr.Parse(NeomodReplay(Facts(Bits(HD, Timewarp), speed: 1.5)));
        var pricing = Mods.ScorePricing(score, null);
        Assert.Equal((true, "HDDT", false), (pricing.AsStable, Mods.Label(pricing.Mods!), pricing.IgnoreLegacyTotalScore));
        Assert.Equal("HDDTNEO", Mods.Label(Mods.ScoreMods(score)));
        Assert.True(Mods.ScoredAsStable("neomod"));
        Assert.Equal("HDDTNEOCL", Mods.Label(Mods.WithClassicMod(Mods.ScoreMods(score), "neomod")));
        Assert.True(Mods.ScorePricing(Osr.Parse(NeomodReplay(Facts(speed: 3))), null).Unpriceable);
        Assert.Contains("neomod", TrackingFilter.AllClients);
    }

    /* ---------------------------------------------------------------- ingest */

    /// <summary>A <c>neomod_scores.db</c> holding one score, as <c>Database::saveScores</c> writes it.</summary>
    private static byte[] ScoresDb(NeomodFacts facts, string name, long unixSeconds, byte grade)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        void Text(string s)
        {
            if (s.Length == 0)
            {
                w.Write((byte)0);
                return;
            }
            w.Write((byte)0x0b);
            w.Write7BitEncodedInt(Encoding.UTF8.GetByteCount(s));
            w.Write(Encoding.UTF8.GetBytes(s));
        }
        w.Write(Encoding.ASCII.GetBytes("NEOSC"));
        w.Write(20260101u);
        w.Write(1u);
        w.Write(1u);
        Text(Map);
        w.Write(1u);
        w.Write(Packed(facts, withSettings: false));
        w.Write(54612UL);
        w.Write(0UL);
        w.Write(unixSeconds);
        w.Write(0);
        Text(name);
        w.Write(grade);
        Text("neomod-44.04");
        Text("");
        w.Write(0L);
        w.Write(0L);
        foreach (short n in new short[] { 37, 7, 0, 3, 6, 0, 79 }) w.Write(n);
        w.Write(0u);
        w.Write(new byte[4 * 4]);
        w.Write((short)0);
        w.Write(new byte[4 * 3]);
        w.Write(80u);
        w.Write(44u);
        w.Write(20u);
        return ms.ToArray();
    }

    [Fact]
    public async Task A_neomod_pass_is_tracked_as_neomod_and_a_fail_it_kept_is_not_a_score()
    {
        var root = Path.Combine(h.Folder, "neomod");
        var replays = Path.Combine(root, "replays");
        Directory.CreateDirectory(replays);
        var facts = Facts(Bits(Timewarp, HD), speed: 1.5);
        var ctx = new IngestContext(h.Db, new BeatmapResolver(h.Db, []), h.ProfileId, 0, null);

        var passed = Path.Combine(replays, $"0-{PlayedAt / 1000}.osr");
        File.WriteAllBytes(passed, NeomodReplay(facts));
        var tracked = await Ingest.ReplayFile(passed, ctx);
        Assert.Equal(("added", "neomod", "HDDTNEO"), (tracked.Status, tracked.Score!.Client, tracked.Score.ModsLabel));

        // neomod kept a fail too (save_failed_scores): grade F in its database, never a pass here.
        var failedAt = PlayedAt + 600_000;
        Directory.CreateDirectory(Path.Combine(replays, "neomod.net"));
        var failed = Path.Combine(replays, "neomod.net", $"5-{failedAt / 1000}.osr");
        File.WriteAllBytes(failed, NeomodReplay(facts, player: "Tangy", replayMd5: "f411", playedAt: failedAt));
        File.WriteAllBytes(Neomod.ScoresFile(root), ScoresDb(facts, "Tangy", (long)(failedAt / 1000), 8));
        Assert.True(Neomod.Failed(Osr.Parse(File.ReadAllBytes(failed)), failed));
        Assert.Equal(("skipped", "not-passed"), ((await Ingest.ReplayFile(failed, ctx)).Status, (await Ingest.ReplayFile(failed, ctx)).Reason));
        Assert.Single(Neomod.FailedScores(File.ReadAllBytes(Neomod.ScoresFile(root))));

        // The same entry as a pass is a pass.
        File.WriteAllBytes(Neomod.ScoresFile(root), ScoresDb(facts, "Tangy", (long)(failedAt / 1000), 3));
        Assert.Equal("added", (await Ingest.ReplayFile(failed, ctx)).Status);
        Assert.Empty(Neomod.FailedScores([1, 2, 3]));
    }

    /* ------------------------------------------------------------ saved filters */

    [Fact]
    public void A_filter_saved_before_neomod_tracks_it_only_if_it_tracked_every_client()
    {
        var every = h.ProfileId;
        var some = h.Db.GetOrCreateProfile("Stable only");
        SettingsStore.Update(h.Db, every, JsonDocument.Parse("""{"trackingFilter":{"enabled":true,"clients":["stable","lazer","mcosu","neki"]}}""").RootElement);
        SettingsStore.Update(h.Db, some, JsonDocument.Parse("""{"trackingFilter":{"enabled":true,"clients":["stable","neki"]}}""").RootElement);
        h.Db.Run("DELETE FROM kv WHERE key = 'neomodClientPinned'");

        var db = h.Reopen();
        Assert.Equal(["stable", "lazer", "mcosu", "neki", "neomod"], SettingsStore.Get(db, every).TrackingFilter.Clients);
        Assert.Equal(["stable", "neki"], SettingsStore.Get(db, some).TrackingFilter.Clients);
    }
}
