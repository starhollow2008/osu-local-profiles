using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// test/lazer-log, unsubmitted-attempts (the parser), log-watcher, songs-watcher, catch-up and
/// tracker: lazer's log, the watchers, and the queue every write goes through.
/// </summary>
public sealed class TrackerTests : IDisposable
{
    private readonly TempDb h = new("Test Profile");

    public void Dispose() => h.Dispose();

    private static List<LoggedPlay> Plays(string text) => LazerLog.ParseSessionEvents(text).Plays;
    private static List<UnsubmittedAttempt> Attempts(string text) => LazerLog.ParseSessionEvents(text).Attempts;

    /* ------------------------------------------------------------- lazer's log */

    private const string Pass = """
        2026-09-10 04:21:35 [verbose]: Game-wide working beatmap updated to Erika - I Don't Know (Nightcore & Cut Ver.) (Mita) [Insane]
        2026-09-10 04:21:35 [verbose]: Score submission token retrieved (1776174516)
        2026-09-10 04:21:36 [verbose]: 📺 OsuScreenStack#658(depth:5) suspended SoloSongSelect+PlayerLoader#139 (waiting on SoloPlayer#100)
        2026-09-10 04:21:36 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#100
        2026-09-10 04:22:07 [verbose]: Received beatmap updates 2 updates with last id 10749873
        2026-09-10 04:22:33 [verbose]: Beginning score submission (token:1776174516)...
        2026-09-10 04:22:34 [verbose]: Score submission completed! (token:1776174516 id:7446790760)
        2026-09-10 04:22:34 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#555)
        2026-09-10 04:23:23 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#100
        """;

    private const string Quit = """
        2026-09-10 01:11:55 [verbose]: Game-wide working beatmap updated to Rin Kagamine - Kokoro (Al-Azif) [Al-Azif MiX]
        2026-09-10 01:11:56 [verbose]: Score submission token retrieved (1775729216)
        2026-09-10 01:11:56 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
        2026-09-10 01:12:58 [verbose]: Beginning score submission (token:1775729216)...
        2026-09-10 01:12:59 [verbose]: Score submission completed! (token:1775729216 id:7446699999)
        2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
        2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) resume to SoloSongSelect+PlayerLoader#139
        """;

    private const string NoHits = """
        2026-09-10 04:21:11 [verbose]: Game-wide working beatmap updated to Marina and the Diamonds - How to Be a Heartbreaker (Nightcore & Cut Ver.) (Mita) [Amats' Hard]
        2026-09-10 04:21:12 [verbose]: Score submission token retrieved (1776173677)
        2026-09-10 04:21:13 [verbose]: 📺 OsuScreenStack#658(depth:6) entered SoloPlayer#414
        2026-09-10 04:21:35 [verbose]: No hits registered, skipping score submission
        2026-09-10 04:21:35 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
        """;

    [Fact]
    public void A_pass_a_quit_and_a_play_osu_never_submitted_are_told_apart()
    {
        var pass = Assert.Single(Plays(Pass));
        Assert.Equal((true, "1776174516", "7446790760", "Erika - I Don't Know (Nightcore & Cut Ver.) (Mita) [Insane]"),
            (pass.Passed, pass.Token, pass.OnlineScoreId, pass.BeatmapName));
        var quit = Assert.Single(Plays(Quit));
        Assert.False(quit.Passed);
        Assert.Equal(Js.DateUtc(2026, 8, 10, 1, 12, 59), quit.CountedAt);
        Assert.Equal(Js.DateUtc(2026, 8, 10, 1, 11, 56), quit.StartedAt);
        Assert.Empty(Plays(NoHits));
        Assert.Empty(Plays("not a log line\n\n   \nScore submission completed! (token:1 id:2)"));
    }

    [Fact]
    public void Submission_after_the_exit_is_still_a_quit_and_a_pass_after_its_results_stays_a_pass()
    {
        var afterExit = Assert.Single(Plays("""
            2026-09-10 01:11:56 [verbose]: Score submission token retrieved (1775729216)
            2026-09-10 01:12:59 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#414
            2026-09-10 01:13:00 [verbose]: Score submission completed! (token:1775729216 id:7446699999)
            """));
        Assert.False(afterExit.Passed);
        var passAfterResults = Assert.Single(Plays("""
            2026-09-10 04:21:35 [verbose]: Score submission token retrieved (1776174516)
            2026-09-10 04:22:34 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#555)
            2026-09-10 04:22:35 [verbose]: 📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#100
            2026-09-10 04:22:36 [verbose]: Score submission completed! (token:1776174516 id:7446790760)
            """));
        Assert.True(passAfterResults.Passed);
    }

    [Fact]
    public void The_same_plays_are_found_however_the_lines_arrive_and_each_once()
    {
        var lines = LazerLog.NewLine().Split($"{Pass}\n{NoHits}\n{Quit}");
        var whole = new LogSession().Feed(lines);
        Assert.Equal(2, whole.Count);
        foreach (var size in new[] { 1, 2, 3, 5, 7 })
        {
            var session = new LogSession();
            var output = new List<LoggedPlay>();
            for (var i = 0; i < lines.Length; i += size) output.AddRange(session.Feed(lines.Skip(i).Take(size)));
            Assert.Equal(whole, output);
        }
        // Joined mid-play: the token line is behind, the submission ahead.
        var joined = Assert.Single(Plays(string.Join("\n", Quit.Split('\n').Skip(3))));
        Assert.Null(joined.StartedAt);
        Assert.Single(Plays(Pass + "\n2026-09-10 04:23:24 [verbose]: 📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#100 (waiting on SoloResultsScreen#556)"));
    }

    [Fact]
    public void The_submission_request_ties_a_token_to_its_beatmap_and_multiplayer_does_not()
    {
        var ids = LazerLog.ParseSubmissionBeatmaps("""
            2026-09-10 00:56:47 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores successfully completed!
            2026-09-10 00:57:13 [verbose]: Request to https://osu.ppy.sh/api/v2/beatmaps/5438074/solo/scores/1775690726 successfully completed!
            2026-09-10 01:01:52 [verbose]: Request to https://osu.ppy.sh/api/v2/rooms/4240610/playlist/47763890/scores/1775703124 successfully completed!
            """);
        Assert.Equal(new Dictionary<string, double> { ["1775690726"] = 5438074 }, ids);
    }

    /* ------------------------------------------------------------- attempts */

    private const string Reji = "Reji - Shoujo wa Yoru to Azayaka ni (ADoorNob) [Vivid Collab]";
    private static string Line(string hms, string body) => $"2026-09-07 {hms} [verbose]: {body}";
    private static string Working(string hms) => Line(hms, $"Game-wide working beatmap updated to {Reji}");
    private static string Enter(string hms, int n) => Line(hms, $"📺 OsuScreenStack#658(depth:6) entered SoloPlayer#{n}");
    private static string Exit(string hms, int n) => Line(hms, $"📺 OsuScreenStack#658(depth:5) exit from SoloPlayer#{n}");
    private static string NoToken(string hms) => Line(hms, "No token, skipping score submission");
    private static double At(string hms) => Js.DateParse($"2026-09-07T{hms}Z");

    [Fact]
    public void An_attempt_is_a_solo_screen_osu_said_had_no_token_and_nothing_weaker()
    {
        var offline = string.Join("\n", Working("10:54:08"), Enter("10:54:10", 109), NoToken("10:54:47"), Exit("10:54:47", 109));
        Assert.Equal([new UnsubmittedAttempt("109", At("10:54:10"), At("10:54:47"), Reji)], Attempts(offline));
        // A pass is left to its replay.
        Assert.Empty(Attempts(string.Join("\n", Working("12:00:00"), Enter("12:00:02", 500), NoToken("12:01:30"),
            Line("12:01:30", "📺 OsuScreenStack#658(depth:6) suspended SoloPlayer#500 (waiting on SoloResultsScreen#501)"), Exit("12:02:10", 500))));
        // A late No token belongs to the screen that just closed, never to a retry just begun.
        Assert.Equal([new UnsubmittedAttempt("300", At("13:00:02"), At("13:00:15"), Reji)],
            Attempts(string.Join("\n", Working("13:00:00"), Enter("13:00:02", 300), Exit("13:00:15", 300), NoToken("13:00:16"))));
        Assert.Equal(
            [new UnsubmittedAttempt("100", At("14:00:02"), At("14:00:20"), Reji), new UnsubmittedAttempt("200", At("14:00:20"), At("14:00:40"), Reji)],
            Attempts(string.Join("\n", Working("14:00:00"), Enter("14:00:02", 100), Exit("14:00:20", 100), Enter("14:00:20", 200),
                NoToken("14:00:21"), NoToken("14:00:40"), Exit("14:00:40", 200))));
        // A screen with a token, a replay watched, the skin editor, one still open: none of them.
        var submitted = LazerLog.ParseSessionEvents(string.Join("\n", Working("15:00:00"), Line("15:00:00", "Score submission token retrieved (1776174516)"),
            Enter("15:00:01", 400), Line("15:00:30", "Score submission completed! (token:1776174516 id:7446790760)"), Exit("15:00:30", 400), NoToken("15:00:31")));
        Assert.Single(submitted.Plays);
        Assert.Empty(submitted.Attempts);
        Assert.Empty(Attempts(string.Join("\n", Working("17:00:00"), Line("17:00:01", "📺 OsuScreenStack#658(depth:6) entered ReplayPlayer#600"),
            NoToken("17:00:30"), Line("17:00:30", "📺 OsuScreenStack#658(depth:5) exit from ReplayPlayer#600"))));
        Assert.Empty(Attempts(string.Join("\n", Working("18:00:00"), Enter("18:00:01", 800), NoToken("18:00:40"))));
        Assert.Equal("unsubmitted:1788778412:109:1788778450000", Incomplete.AttemptKey(new UnsubmittedAttempt("109", 1788778450000, 0, null, "1788778412")));
    }

    [Fact]
    public void Dates_are_read_as_Date_UTC_reads_them()
    {
        Assert.Equal(0, Js.DateUtc(1970, 0, 1));
        Assert.Equal(1788778450000, Js.DateUtc(2026, 8, 7, 10, 54, 10));
        Assert.Equal(Js.DateUtc(2025, 0, 1), Js.DateUtc(2024, 12, 1));
        Assert.Equal(Js.DateUtc(2024, 1, 29), Js.DateUtc(2024, 2, 0));
        Assert.Equal(Js.DateUtc(1999, 0, 1), Js.DateUtc(99, 0, 1));
    }

    /* ---------------------------------------------------- recalculation, catch-up */

    [Fact]
    public void Recalculations_go_in_batches_of_one_profile_each_and_a_gap_needs_a_record_of_one()
    {
        var rows = Enumerable.Range(1, 120).Select(i => ((long)i, 1L)).Concat([(500L, 2L), (1L, 2L)]);
        var batches = Recompute.ToBatches(rows);
        Assert.Equal([50, 50, 20, 1], batches.Select(b => b.Ids.Count));
        Assert.Equal(2, batches[^1].ProfileId);

        Assert.Null(CatchUp.Since(null, 0));
        Assert.Equal(5000, CatchUp.Since(1000, 5000, 10_000));
        Assert.Null(CatchUp.Since(20_000, 0, 10_000));
        Assert.Null(CatchUp.LastRunAt(h.Db));
        CatchUp.MarkRunning(h.Db, 1234);
        Assert.Equal(1234, CatchUp.LastRunAt(h.Db));
    }

    /* ---------------------------------------------------------------- watchers */

    private static async Task<T> Within<T>(Task<T> task, int seconds = 15)
    {
        if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(seconds))) != task) throw new TimeoutException("nothing arrived");
        return await task;
    }

    private static byte[] ReplayBytes(string player, double playedAt, string beatmap = "", int mode = 0) => ReplayWriter.Encode(
        new ReplayHeader(mode, 20230504, beatmap.Length > 0 ? beatmap : new string('b', 32), player, Guid.NewGuid().ToString("N"),
            new LegacyCounts(100, 0, 0, 0, 0, 0), 1_000_000, 100, true, 0, playedAt, 0));

    [Fact]
    public async Task A_replay_written_into_a_watched_folder_is_handed_on_once_settled_and_other_files_aside()
    {
        var dir = Path.Combine(h.Folder, "store");
        Directory.CreateDirectory(Path.Combine(dir, "a", "ab"));
        var replay = new TaskCompletionSource<string>();
        var other = new TaskCompletionSource<string>();
        var watcher = new ReplayWatcher([dir, Path.Combine(h.Folder, "nowhere")], f => replay.TrySetResult(f), f => other.TrySetResult(f));
        watcher.Start();
        try
        {
            File.WriteAllBytes(Path.Combine(dir, "a", "ab", "abcdef"), ReplayBytes("Tangy", Js.Now()));
            Assert.Equal(Path.Combine(dir, "a", "ab", "abcdef"), await Within(replay.Task));
            File.WriteAllText(Path.Combine(dir, "a", "ab", "notes"), "osu file format v14");
            Assert.Equal(Path.Combine(dir, "a", "ab", "notes"), await Within(other.Task));
        }
        finally
        {
            watcher.Stop();
        }
    }

    [Fact]
    public async Task A_play_appended_to_lazers_live_log_is_picked_up_but_not_what_was_there_before()
    {
        var logs = Path.Combine(h.Folder, "logs");
        Directory.CreateDirectory(logs);
        var runtime = Path.Combine(logs, "1788000000.runtime.log");
        File.WriteAllText(runtime, Quit + "\n");
        var arrived = new TaskCompletionSource<List<LoggedPlay>>();
        var watcher = new LogWatcher([logs], p => arrived.TrySetResult(p));
        watcher.Start();
        try
        {
            await Task.Delay(500);
            // Written in two parts, the second line split across them.
            var text = NoHits.Replace("1776173677", "999") + "\n" + Quit.Replace("1775729216", "4242").Replace("7446699999", "777") + "\n";
            File.AppendAllText(runtime, text[..(text.Length / 2)]);
            await Task.Delay(100);
            File.AppendAllText(runtime, text[(text.Length / 2)..]);
            var play = Assert.Single(await Within(arrived.Task));
            Assert.Equal(("4242", "777", false), (play.Token, play.OnlineScoreId, play.Passed));
        }
        finally
        {
            watcher.Stop();
        }
        Assert.Empty(LazerLog.ListLogSessions(Path.Combine(h.Folder, "no logs here")));
        Assert.Equal("nowhere-at-all", Watch.WatchablePath("nowhere-at-all"));
    }

    [Fact]
    public async Task A_set_extracted_into_Songs_is_indexed_and_a_flush_does_not_wait()
    {
        var songs = Path.Combine(h.Folder, "Songs");
        Directory.CreateDirectory(songs);
        var watcher = new SongsWatcher(h.Db, [songs, Path.Combine(h.Folder, "missing")]);
        watcher.Start();
        try
        {
            var set = Path.Combine(songs, "1 Artist - Title");
            Directory.CreateDirectory(set);
            await Task.Delay(300);
            File.WriteAllText(Path.Combine(set, "map.osu"), "osu file format v14\r\n\r\n[Metadata]\r\nTitle:Title\r\n");
            await Task.Delay(300);
            watcher.Flush();
            Assert.Equal(1L, Convert.ToInt64(h.Db.Scalar("SELECT COUNT(*) FROM osu_files")));
        }
        finally
        {
            watcher.Stop();
        }
    }

    /* ----------------------------------------------------------------- tracker */

    private PlayTracker Tracker(IReadOnlyList<OsuInstall> installs) =>
        new(h.Db, new BeatmapResolver(h.Db, installs), installs, h.ProfileId, 0, null);

    [Fact]
    public async Task An_import_takes_what_is_in_the_folders_once_and_lists_what_it_turned_away()
    {
        var stable = Path.Combine(h.Folder, "osu!");
        var replays = Path.Combine(stable, "Data", "r");
        Directory.CreateDirectory(replays);
        File.WriteAllBytes(Path.Combine(replays, "mine.osr"), ReplayBytes("Tangy", Js.Now() - 60_000));
        File.WriteAllBytes(Path.Combine(replays, "taiko.osr"), ReplayBytes("Tangy", Js.Now() - 120_000, new string((char)99, 32), mode: 1));
        File.WriteAllText(Path.Combine(replays, "readme.txt"), "not a replay");
        var install = new OsuInstall("stable", stable, replays, [], null);
        SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { trackingFilter = new { enabled = true, modes = new[] { 0 } } }));
        var tracker = Tracker([install]);

        var (preview, log) = await tracker.PreviewBackfill(0);
        Assert.Equal((2, 1, 1, 0), (preview.Candidates.Count, preview.Importable, preview.Filtered, log.Sessions));

        var imports = new List<ImportState>();
        tracker.Importing += imports.Add;
        var result = await tracker.RunBackfill(0);
        Assert.Equal((1, 1, 0), (result.Imported, result.Filtered, result.Skipped));
        Assert.Equal("mode", Assert.Single(Declined.List(h.Db, h.ProfileId)).Criterion);
        await Task.Delay(100);
        Assert.False(imports[^1].Active);
        Assert.Equal(1, tracker.ScoresAdded);

        // Again: nothing new, and the filtered one is listed once still.
        Assert.Equal((0, 1), ((await tracker.RunBackfill(0)).Imported, (await tracker.PreviewBackfill(0)).Replays.Duplicates));

        // Tracked anyway, past the filter, then gone from the list.
        var scored = new TaskCompletionSource<IngestedScore>();
        tracker.Score += s => scored.TrySetResult(s);
        Assert.Equal(new TrackAnywayResult("tracked", "score"), await tracker.TrackAnyway(Declined.List(h.Db, h.ProfileId)[0].Id));
        Assert.Equal(1, (await Within(scored.Task)).Mode);
        Assert.Empty(Declined.List(h.Db, h.ProfileId));
        await Assert.ThrowsAsync<InvalidOperationException>(() => tracker.TrackAnyway(12345));

        // A catch-up only when the profile asked for one.
        Assert.Null(await tracker.RunCatchUp(0));
        Assert.Null(await tracker.RunCatchUp(null));
    }
}
