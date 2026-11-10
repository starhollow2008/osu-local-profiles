using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>neki (roadmap 5.83): its files, which plays are its, and how they are priced and filed.</summary>
public sealed class NekiTests : IDisposable
{
    private readonly TempDb h = new("Test Profile");

    public void Dispose() => h.Dispose();

    private const string Map = "8317fc5aaee2196ce12b3b7cada74beb";

    /// <summary>A play's moment as neki writes it, and as its replay records it.</summary>
    private const string NekiTime = "2026-11-10T10:38:24.0559177Z";
    private static readonly double PlayedAt = DateTimeOffset.Parse("2026-11-10T10:38:24.055Z").ToUnixTimeMilliseconds();

    /// <summary>The stable folder neki plays from, and neki beside it, laid out as neki's installer leaves them.</summary>
    private (string Stable, string Neki) Installed()
    {
        var stable = Path.Combine(h.Folder, "osu!");
        Directory.CreateDirectory(Path.Combine(stable, "Data", "r"));
        Directory.CreateDirectory(Path.Combine(stable, "Songs"));
        File.WriteAllText(Path.Combine(stable, "osu!.exe"), "");
        var neki = Path.Combine(h.Folder, "Programs", "neki");
        Directory.CreateDirectory(Path.Combine(neki, "data", "stats"));
        Directory.CreateDirectory(Path.Combine(neki, "data", "databases"));
        File.WriteAllText(Path.Combine(neki, "neki.exe"), "");
        File.WriteAllText(Path.Combine(neki, "neki.ini"), $"﻿OsuFolder = {stable}\r\nFullyOffline = true\r\nSkipLauncher = false\r\n");
        return (stable, neki);
    }

    private static string Recent(params (string Hash, string Time, bool Passed, bool Quit)[] plays) =>
        "[" + string.Join(",", plays.Select(p =>
            $$"""{"time":"{{p.Time}}","profile":"","hash":"{{p.Hash}}","mode":0,"mods":64,"n300":37,"passed":{{(p.Passed ? "true" : "false")}},"quit":{{(p.Quit ? "true" : "false")}},"end_time":20416,"extra":["NL","MR"],"rate":1.6}""")) + "]";

    /// <summary>A <c>scores.db</c> in osu!stable's format; a lazer-version entry carries lazer's block after it, as neki writes one.</summary>
    private static byte[] ScoresDb(params (string Map, string Replay, int Version, int Mods)[] scores)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        void Text(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            w.Write((byte)0x0b);
            w.Write7BitEncodedInt(bytes.Length);
            w.Write(bytes);
        }
        w.Write(20260924);
        var maps = scores.GroupBy(s => s.Map).ToList();
        w.Write(maps.Count);
        foreach (var map in maps)
        {
            Text(map.Key);
            w.Write(map.Count());
            foreach (var s in map)
            {
                w.Write((byte)0);
                w.Write(s.Version);
                Text(s.Map);
                Text("Tangy");
                Text(s.Replay);
                foreach (short count in new short[] { 37, 7, 0, 3, 6, 0 }) w.Write(count);
                w.Write(54612);
                w.Write((short)79);
                w.Write((byte)0);
                w.Write(s.Mods);
                w.Write((byte)0); // no life bar
                w.Write(639299039040549131L);
                w.Write(-1);
                w.Write(0L);
                if ((s.Mods & (1 << 23)) != 0) w.Write(0.5);
                if (s.Version >= Osr.LazerExtMinVersion)
                {
                    w.Write(3);
                    w.Write(new byte[] { 1, 2, 3 });
                }
            }
        }
        return ms.ToArray();
    }

    private static readonly object[] ExtraMods =
    [
        new { acronym = "DT", settings = new { speed_change = 1.6 } },
        new { acronym = "DA", settings = new { approach_rate = 9 } },
        new { acronym = "MR" },
        new { acronym = "RD", settings = new { seed = 100, angle_sharpness = 7.5 } },
        new { acronym = "AL" },
        new { acronym = "CL", settings = new { classic_note_lock = false } },
    ];

    /// <summary>A replay as neki writes one: stable's format, or lazer's with its mods in the block.</summary>
    private static byte[] NekiReplay(object[]? lazerMods = null, string player = "", string replayMd5 = "d0ebef9dc1589c1c616153c855b01abb")
    {
        var header = new ReplayHeader(0, lazerMods is null ? 20260924 : 30000001, Map, player, replayMd5,
            new LegacyCounts(37, 7, 0, 3, 6, 0), 54612, 79, false, 64, PlayedAt, 0);
        if (lazerMods is null) return ReplayWriter.Encode(header);
        return ReplayWriter.Encode(header, [ReplayWriter.LazerBlock(new
        {
            online_id = -1,
            mods = lazerMods,
            statistics = new { great = 37, ok = 7 },
            maximum_statistics = new { great = 44, legacy_combo_increase = 36 },
            client_version = "neki",
            rank = "A",
            user_id = 1,
            pauses = Array.Empty<object>(),
        })]);
    }

    private string Write(string dir, string name, byte[] bytes)
    {
        var file = Path.Combine(dir, name);
        File.WriteAllBytes(file, bytes);
        return file;
    }

    /* ---------------------------------------------------------------- files */

    [Fact]
    public void An_install_plays_from_the_stable_folder_its_ini_names()
    {
        var (stable, neki) = Installed();
        var install = Neki.Install(neki)!;
        Assert.Equal(("neki", neki), (install.Kind, install.Root));
        Assert.Equal(Path.Combine(stable, "Data", "r"), install.ReplayDir);
        Assert.Equal([Path.Combine(stable, "Songs")], install.BeatmapRoots);
        Assert.Equal("neki", Discover.Classify(neki, Path.Combine(h.Folder, "mcosu"))!.Kind);
        Assert.Equal("stable", Discover.Classify(stable, Path.Combine(h.Folder, "mcosu"))!.Kind);
        File.Delete(Path.Combine(neki, "neki.exe"));
        Assert.Null(Neki.Install(neki));
        Assert.True(Discover.LooksLikeInstall(["neki.exe", "neki.ini", "data"]));
    }

    [Fact]
    public void Recent_plays_are_read_to_the_millisecond_a_replay_counts_with_a_rate_for_DT_alone()
    {
        var plays = Neki.ParseRecent($$"""
            [{"time":"{{NekiTime}}","profile":"Tangy","hash":"{{Map.ToUpperInvariant()}}","mode":0,"mods":64,"passed":true,"quit":false,"end_time":0},
             {"time":"{{NekiTime}}","hash":"{{Map}}","mode":1,"mods":0,"passed":false,"quit":true,"end_time":10646,"rate":1.6},
             {"time":"not a time","hash":"{{Map}}"},
             {"time":"{{NekiTime}}","hash":"short"}]
            """);
        Assert.Equal(2, plays.Count);
        Assert.Equal(new NekiRecentPlay(Map, PlayedAt, 0, true, false, 0, 1.5, "Tangy"), plays[0]);
        Assert.Equal(new NekiRecentPlay(Map, PlayedAt, 1, false, true, 10646, 1.6, null), plays[1]);
        Assert.Empty(Neki.ParseRecent("[{\"time\":"));
        Assert.Empty(Neki.ParseRecent("{}"));
        // The replay neki wrote for it says the same moment.
        Assert.Equal(PlayedAt, Osr.Parse(NekiReplay()).PlayedAtMs);
    }

    [Fact]
    public void A_scores_db_gives_its_replay_hashes_past_a_lazer_block_and_up_to_where_it_was_cut()
    {
        var db = ScoresDb((Map, "AAAA", 20260924, 1 << 23), (Map, "bbbb", 30000001, 64), ("c".PadRight(32, 'c'), "cccc", 20260924, 0));
        Assert.Equal(["aaaa", "bbbb", "cccc"], Neki.ScoreReplayHashes(db).Order());
        Assert.Equal(["aaaa"], Neki.ScoreReplayHashes(db[..200]).Order());
        Assert.Empty(Neki.ScoreReplayHashes([1, 2]));
    }

    /* ------------------------------------------------------------- whose play */

    [Fact]
    public void A_replay_in_Data_r_is_nekis_when_neki_lists_it_and_stables_own_otherwise()
    {
        var (stable, neki) = Installed();
        var plays = new NekiPlays([Neki.Install(neki)!]);
        var replay = Osr.Parse(NekiReplay());
        Assert.Equal("stable", replay.Client);
        Assert.False(plays.Claims(replay));

        // Listed in neki.recent.json at that moment: neki's. A moment later is another play.
        File.WriteAllText(Neki.RecentFile(neki), Recent((Map, NekiTime, true, false)));
        Assert.True(plays.Claims(replay));
        Assert.False(plays.Claims(replay with { PlayedAtMs = replay.PlayedAtMs + 1000 }));

        // Gone from the recent list, but in scores.neki.db and not in stable's own scores.db.
        File.WriteAllText(Neki.RecentFile(neki), "[]");
        File.WriteAllBytes(Neki.ScoresFile(neki), ScoresDb((Map, replay.ReplayMD5!, 20260924, 64), (Map, "5d3e", 20260924, 0)));
        Assert.True(plays.Claims(replay));
        // neki copies stable's scores in: one stable holds is stable's.
        File.WriteAllBytes(Path.Combine(stable, "scores.db"), ScoresDb((Map, replay.ReplayMD5!.ToUpperInvariant(), 20260924, 64)));
        Assert.False(plays.Claims(replay));

        Assert.False(NekiPlays.None.Claims(replay));
        Assert.Equal("neki", Ingest.WithClient(replay with { ReplayMD5 = "5d3e" }, plays).Client);
    }

    [Fact]
    public void A_replay_neki_wrote_in_lazers_format_says_so_and_its_user_id_is_not_an_account()
    {
        var replay = Osr.Parse(NekiReplay(ExtraMods, "Tangy"));
        Assert.Equal("neki", replay.Client);
        Assert.True(NekiPlays.None.Claims(replay));
        Assert.Null(Players.ReplayPlayer(replay).UserId);
        var lazer = Osr.Parse(ReplayWriter.Encode(new ReplayHeader(0, 30000001, Map, "Tangy", null, new LegacyCounts(1, 0, 0, 0, 0, 0), 1, 1, true, 0, PlayedAt, 0),
            [ReplayWriter.LazerBlock(new { user_id = 2, client_version = "2026.1012.0-lazer" })]));
        Assert.Equal(("lazer", 2.0), (lazer.Client, Players.ReplayPlayer(lazer).UserId));
    }

    /* ---------------------------------------------------------------- pricing */

    [Fact]
    public void An_extra_mods_play_is_priced_from_a_stable_copy_with_its_mods_and_classic_left_to_osu()
    {
        var bytes = NekiReplay(ExtraMods);
        var copy = Osr.StableCopy(bytes)!;
        var stable = Osr.Parse(copy);
        var original = Osr.Parse(bytes);
        Assert.Equal(("stable", Mcosu.BuiltReplayVersion, null), (stable.Client, stable.Version, stable.Extras));
        Assert.Equal((original.TotalScore, original.Count100, original.PlayedAtMs, original.ReplayMD5), (stable.TotalScore, stable.Count100, stable.PlayedAtMs, stable.ReplayMD5));
        Assert.Null(Osr.StableCopy(NekiReplay()));

        var pricing = Mods.ScorePricing(original, null);
        Assert.True(pricing.AsStable);
        Assert.Equal("DTDAMRRDAL", Mods.Label(pricing.Mods!));
        // DA, Random and a custom rate are not stable's, so neither is the total's footing.
        Assert.True(pricing.IgnoreLegacyTotalScore);
        Assert.False(Mods.ScorePricing(Osr.Parse(NekiReplay([new { acronym = "HD" }, new { acronym = "CL" }])), null).IgnoreLegacyTotalScore);
        // What is stored and shown is neki's own list, Classic and its note lock included.
        Assert.Equal("DTDAMRRDALCL", Mods.Label(Mods.ScoreMods(original)));
        Assert.Equal("DTDAMRRDALCL", Mods.Label(Mods.WithClassicMod(Mods.ScoreMods(original), "neki")));
        Assert.True(Mods.ScoredAsStable("neki"));
        Assert.Equal(new PriceOptions(), Mods.ScorePricing(Osr.Parse(NekiReplay()) with { Client = "neki" }, null));
    }

    [Fact]
    public void The_filter_judges_a_neki_play_on_the_mods_chosen_and_offers_neki_as_a_client()
    {
        var facts = new BeatmapFilterFacts(Status.Ranked, null, null, null, null, null);
        var mods = Mods.ScoreMods(Osr.Parse(NekiReplay(ExtraMods)));
        var noClassic = new TrackingFilter { Enabled = true, Mods = { ["CL"] = "excluded" } };
        Assert.Null(noClassic.Rejects(TrackingFilter.PlayFactsOf(facts, 0, mods, "neki")));
        Assert.Equal("mods", noClassic.Rejects(TrackingFilter.PlayFactsOf(facts, 0, mods, "lazer")));
        Assert.Contains("neki", TrackingFilter.AllClients);
        Assert.Equal("client", new TrackingFilter { Enabled = true, Clients = ["stable"] }.Rejects(new PlayFacts(Client: "neki")));
    }

    /* ----------------------------------------------------------------- ingest */

    [Fact]
    public async Task A_stable_replay_neki_lists_is_tracked_as_neki()
    {
        var (stable, neki) = Installed();
        File.WriteAllText(Neki.RecentFile(neki), Recent((Map, NekiTime, true, false)));
        var dir = Path.Combine(stable, "Data", "r");
        var ctx = new IngestContext(h.Db, new BeatmapResolver(h.Db, []), h.ProfileId, 0, null, Neki: new NekiPlays([Neki.Install(neki)!]));
        var tracked = await Ingest.ReplayFile(Write(dir, "neki.osr", NekiReplay()), ctx);
        Assert.Equal(("added", "neki"), (tracked.Status, tracked.Score!.Client));
        var other = await Ingest.ReplayFile(Write(dir, "stable.osr", Shifted(NekiReplay(replayMd5: "ffff"))), ctx);
        Assert.Equal("stable", other.Score!.Client);
        Assert.Equal("neki,stable", string.Join(",", h.Db.Rows("SELECT client FROM scores ORDER BY played_at").Select(r => r.Str("client"))));

        // Without neki's files to go by, a stable replay is stable's.
        h.Db.Run("DELETE FROM scores");
        var unknown = await Ingest.ReplayFile(Path.Combine(dir, "neki.osr"), ctx with { Neki = null });
        Assert.Equal("stable", unknown.Score!.Client);
    }

    /// <summary>The same replay ten minutes later, past the app's match on the play itself: another play neki never listed.</summary>
    private static byte[] Shifted(byte[] replay)
    {
        var score = Osr.Parse(replay);
        return ReplayWriter.Encode(new ReplayHeader(0, score.Version, score.BeatmapMD5, "", score.ReplayMD5,
            new LegacyCounts(37, 7, 0, 3, 6, 0), 54612, 79, false, 64, PlayedAt + 600_000, 0));
    }

    [Fact]
    public void Plays_neki_wrote_before_it_was_a_client_are_filed_under_it_once_and_its_lazer_format_ones_repriced()
    {
        var (stable, neki) = Installed();
        File.WriteAllText(Neki.RecentFile(neki), Recent((Map, NekiTime, true, false)));
        var dir = Path.Combine(stable, "Data", "r");
        var listed = Write(dir, "listed.osr", NekiReplay());
        var extra = Write(dir, "extra.osr", NekiReplay(ExtraMods, replayMd5: "eeee"));
        var stables = Write(dir, "stable.osr", Shifted(NekiReplay(replayMd5: "ffff")));
        var elsewhere = Write(h.Folder, "elsewhere.osr", NekiReplay());
        long Row(string key, string client, string file, long? playerId = null)
        {
            h.InsertScore(h.ProfileId, key);
            h.Db.Run("UPDATE scores SET client = ?, replay_path = ?, player_id = ? WHERE dedupe_key = ?", client, file, playerId, key);
            return Convert.ToInt64(h.Db.Scalar("SELECT id FROM scores WHERE dedupe_key = ?", key));
        }
        var a = Row("listed", "stable", listed);
        var b = Row("extra", "lazer", extra, 1);
        Row("stable", "stable", stables);
        Row("elsewhere", "stable", elsewhere);

        var installs = new List<OsuInstall> { Detect.StableInstall(stable)!, Neki.Install(neki)! };
        var tracker = new PlayTracker(h.Db, new BeatmapResolver(h.Db, installs), installs, h.ProfileId, 0, null);
        Assert.Equal([(b, h.ProfileId)], tracker.RelabelNekiPlays());
        string Clients() => string.Join(",", h.Db.Rows("SELECT dedupe_key, client, player_id FROM scores ORDER BY dedupe_key")
            .Select(r => $"{r.Str("dedupe_key")}:{r.Str("client")}:{r.Num("player_id")}"));
        Assert.Equal("elsewhere:stable:,extra:neki:,listed:neki:,stable:stable:", Clients());
        Assert.Equal(a, Convert.ToInt64(h.Db.Scalar("SELECT id FROM scores WHERE dedupe_key = 'listed'")));

        // Once.
        h.Db.Run("UPDATE scores SET client = 'stable' WHERE dedupe_key = 'listed'");
        Assert.Empty(tracker.RelabelNekiPlays());
        Assert.Equal("stable", h.Db.FirstRow("SELECT client FROM scores WHERE dedupe_key = 'listed'")!.Str("client"));
        // And never without neki.
        h.Db.Run("DELETE FROM kv WHERE key = 'nekiPlaysRelabelled'");
        Assert.Empty(new PlayTracker(h.Db, new BeatmapResolver(h.Db, []), [Detect.StableInstall(stable)!], h.ProfileId, 0, null).RelabelNekiPlays());
    }

    /* ------------------------------------------------------- fails and quits */

    [Fact]
    public void A_fail_or_quit_is_an_attempt_osu_never_received_filed_under_the_mode_neki_played()
    {
        var ctx = new IncompleteContext(h.Db, new BeatmapResolver(h.Db, []), h.ProfileId, 0);
        var quit = new NekiRecentPlay(Map, PlayedAt, 1, false, true, 20416, 1.6, null);
        Assert.Equal("passed", Incomplete.CheckNekiPlay(quit with { Passed = true, Quit = false }, ctx).Reason);
        Assert.Equal("too-old", Incomplete.CheckNekiPlay(quit, ctx with { TrackingSince = PlayedAt + 1 }).Reason);
        // Checking writes nothing.
        Assert.Equal("ready", Incomplete.CheckNekiPlay(quit, ctx).Status);
        Assert.Equal(0, Convert.ToInt64(h.Db.Scalar("SELECT COUNT(*) FROM incomplete_plays")));

        var added = Incomplete.IngestNekiPlay(quit, ctx);
        Assert.Equal(("added", true, 1), (added.Status, added.Play!.Unsubmitted, added.Play.Mode));
        var row = h.Db.FirstRow("SELECT * FROM incomplete_plays")!;
        Assert.Equal(($"neki:{Map}:{PlayedAt}", PlayedAt, PlayedAt - 12760, 1L),
            (row.Str("dedupe_key"), row.Num("played_at"), row.Num("started_at"), (long)row.Num("unsubmitted")!));
        Assert.Equal("duplicate", Incomplete.IngestNekiPlay(quit, ctx).Reason);
        // A fail at the very start says nothing of when it began.
        Incomplete.IngestNekiPlay(quit with { PlayedAt = PlayedAt + 5000, EndTime = 0 }, ctx);
        Assert.Null(h.Db.FirstRow("SELECT started_at FROM incomplete_plays WHERE played_at = ?", PlayedAt + 5000)!.Num("started_at"));

        // The filter judges it as neki's, and Track anyway brings it back as it was.
        var filtered = Incomplete.IngestNekiPlay(quit with { PlayedAt = PlayedAt + 9000 },
            ctx with { Filter = new TrackingFilter { Enabled = true, Clients = ["lazer"] }, Declines = "live" });
        Assert.Equal(("filtered", "client"), (filtered.Status, filtered.Criterion));
        var declined = Assert.Single(Tracker.Declined.List(h.Db, h.ProfileId));
        var json = h.Db.FirstRow("SELECT recording FROM declined_plays WHERE id = ?", declined.Id)!.Str("recording")!;
        var recording = JsonSerializer.Deserialize<Recording>(json, JsonText.Options)!;
        Assert.Equal((1, "neki"), (recording.Mode, recording.Client));
        Assert.Equal(1, Incomplete.IngestRecording(recording, ctx).Play!.Mode);
    }

    [Fact]
    public async Task Neki_ending_a_play_without_a_replay_is_picked_up_but_not_what_it_listed_before()
    {
        var (_, nekiRoot) = Installed();
        var recent = Neki.RecentFile(nekiRoot);
        File.WriteAllText(recent, Recent((Map, "2026-11-10T10:30:00.0000000Z", false, true)));
        var arrived = new TaskCompletionSource<List<NekiRecentPlay>>();
        var watcher = new NekiWatcher(Neki.Install(nekiRoot)!, new NekiPlays([]), p => arrived.TrySetResult(p));
        watcher.Start();
        try
        {
            await Task.Delay(500);
            File.WriteAllText(recent, Recent(
                (Map, NekiTime, true, false),
                (Map, "2026-11-10T10:39:03.0073926Z", false, false),
                (Map, "2026-11-10T10:30:00.0000000Z", false, true)));
            var play = Assert.Single(await Within(arrived.Task));
            Assert.Equal((false, false), (play.Passed, play.Quit));
        }
        finally
        {
            watcher.Stop();
        }
    }

    private static async Task<T> Within<T>(Task<T> task, int seconds = 15)
    {
        if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(seconds))) != task) throw new TimeoutException("nothing arrived");
        return await task;
    }

    [Fact]
    public void A_folder_both_installs_name_is_watched_once()
    {
        var (stable, neki) = Installed();
        var dirs = PlayTracker.Distinct([Detect.StableInstall(stable)!.ReplayDir, Neki.Install(neki)!.ReplayDir, Path.Combine(h.Folder, "lazer", "files")]);
        Assert.Equal([Path.Combine(stable, "Data", "r"), Path.Combine(h.Folder, "lazer", "files")], dirs);
    }

    /* ------------------------------------------------------------ saved filters */

    [Fact]
    public void A_filter_saved_before_neki_tracks_neki_wherever_it_tracked_stable_once()
    {
        var withStable = h.ProfileId;
        var withoutStable = h.Db.GetOrCreateProfile("Lazer only");
        SettingsStore.Update(h.Db, withStable, JsonDocument.Parse("""{"trackingFilter":{"enabled":true,"clients":["stable","lazer"],"rules":[{"conditions":[{"field":"title","test":"contains","values":["<Ünïcode>"]}]}]}}""").RootElement);
        SettingsStore.Update(h.Db, withoutStable, JsonDocument.Parse("""{"trackingFilter":{"enabled":true,"clients":["lazer"]}}""").RootElement);
        // Saved with the clients an older version offered, then opened by this one.
        h.Db.Run("DELETE FROM kv WHERE key = 'nekiClientPinned'");
        Assert.Equal(["stable", "lazer"], SettingsStore.Get(h.Db, withStable).TrackingFilter.Clients);

        var db = h.Reopen();
        var kept = SettingsStore.Get(db, withStable).TrackingFilter;
        Assert.Equal(["stable", "lazer", "neki"], kept.Clients);
        Assert.Equal("<Ünïcode>", kept.Rules[0].Conditions[0].Values[0]);
        Assert.Equal(["lazer"], SettingsStore.Get(db, withoutStable).TrackingFilter.Clients);

        // Once: neki unticked afterwards stays unticked.
        SettingsStore.Update(db, withStable, JsonDocument.Parse("""{"trackingFilter":{"enabled":true,"clients":["stable"]}}""").RootElement);
        db = h.Reopen();
        Assert.Equal(["stable"], SettingsStore.Get(db, withStable).TrackingFilter.Clients);
    }
}
