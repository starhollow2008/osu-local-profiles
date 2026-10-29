using System.Globalization;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles;

/// <summary>What src/main.ts does around the tracker: the console's account of each play, and the work after the index.</summary>
internal static class Startup
{
    private static string F(double n, int digits) => n.ToString("F" + digits, CultureInfo.InvariantCulture);

    private static string Grouped(double n) => n.ToString("N0", CultureInfo.InvariantCulture);

    private static string Time(double at) =>
        DateTimeOffset.FromUnixTimeMilliseconds((long)at).ToLocalTime().ToString("T", CultureInfo.CurrentCulture);

    /// <summary>Each play written to the console as it is tracked, as the Node app writes it.</summary>
    public static void Announce(Database db, PlayTracker tracker)
    {
        tracker.Score += s =>
        {
            var rules = Eligibility.Of(SettingsStore.Get(db, tracker.ProfileId), tracker.Beatmaps.KnowsStatus);
            var counted = s.Ranked || (rules.IncludeUnrankedMods && s.MapRanked);
            var shownPp = rules.PreferStrippedPp && s.PpNomod is not null ? s.PpNomod : s.Pp;
            var pp = shownPp is null ? (s.MapRanked ? "  --  " : " unrkd") : $"{F(shownPp.Value, 0),4}pp{(counted ? " " : "*")}";
            var stars = s.Stars is null ? "" : $" {F(s.Stars.Value, 2)}*";
            Console.WriteLine($"  [{Time(s.PlayedAt)}] {pp} {s.Grade,-2} {F(s.Accuracy * 100, 2)}%  {s.ModsLabel,-6}{stars}  {s.Title}");
            if (counted && shownPp is not null)
            {
                var totals = Stats.Compute(db, tracker.ProfileId, s.Mode, rules);
                var rank = Ranks.Estimate(totals.TotalPp, s.Mode);
                Console.WriteLine($"            -> {F(totals.TotalPp, 0)}pp{(rank is null ? "" : $"  #{Grouped(rank.Rank)}")}  {F(totals.Accuracy * 100, 2)}%  lv{totals.Level.Current}");
            }
            else if (shownPp is not null)
            {
                Console.WriteLine("            -> does not count toward this profile");
            }
        };
        tracker.IncompletePlay += play =>
        {
            var what = play.Unsubmitted ? "not submitted to osu!" : "did not finish";
            Console.WriteLine($"  [{Time(play.PlayedAt)}]   --   -- {what,-22}{play.Title}");
        };
        tracker.Filtered += play => Console.WriteLine($"  [{Time(play.At)}] not tracked -- {play.Criterion,-13} {play.Title}");
        tracker.Refused += play => Console.WriteLine(play.Reason == "another-player"
            ? $"  [{Time(play.At)}] not tracked -- set by {(string.IsNullOrEmpty(play.Player) ? "another player" : play.Player)}: {play.Title}"
            : $"  [{Time(play.At)}] not tracked -- a replay that could not be read");
        tracker.Error += e => Console.Error.WriteLine($"  watcher error: {Watch.Explain(e)}");
    }

    /// <summary>
    /// The beatmap index, then what needs it: the plays set while the app was closed, ranked statuses
    /// from lazer's newer list, scores this version can now read fully, uploaded copies nothing points
    /// at, and a recalculation when osu!'s calculator is a new release.
    /// </summary>
    public static async Task AfterIndex(Database db, PlayTracker tracker, IReadOnlyList<IndexRoot> roots, double? gapSince, string dataDir)
    {
        var lastLine = double.NegativeInfinity;
        void OnIndexing(Tracker.IndexState s)
        {
            if (!s.Active || !s.Visible || Js.Now() - lastLine < 2000) return;
            lastLine = Js.Now();
            var where = s.Phase == "counting"
                ? $"looking through osu!'s files ({Grouped(s.Total)} so far)"
                : $"{Math.Floor((double)s.Scanned / Math.Max(1, s.Total) * 100)}% of {Grouped(s.Total)} files";
            Console.WriteLine($"  indexing beatmaps: {where}{(s.Waiting > 0 ? $", {s.Waiting} play(s) waiting" : "")}");
        }
        tracker.Indexing += OnIndexing;
        await tracker.IndexBeatmaps(roots);
        tracker.Indexing -= OnIndexing;
        var state = tracker.IndexState;
        if (state.Error is not null) Console.WriteLine($"  beatmap index failed: {state.Error}");
        else if (state.Indexed > 0 || state.FirstRun)
        {
            var total = Convert.ToDouble(db.Scalar("SELECT COUNT(*) AS n FROM osu_files"));
            Console.WriteLine($"  {Grouped(total)} beatmaps indexed ({Grouped(state.Indexed)} new)\n");
        }

        try
        {
            Clients.Beatmaps.BackfillOriginalMetadata(db);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            /* best effort, as the Node app's */
        }

        BackfillResult? caught = null;
        try
        {
            caught = await tracker.RunCatchUp(gapSince);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            /* reported by the tracker */
        }
        if (caught is not null && caught.Imported + caught.Unfinished + caught.Attempts > 0)
        {
            Console.WriteLine($"\n  Brought in what was played while the app was closed: {caught.Imported} score(s), {caught.Unfinished} unfinished, {caught.Attempts} not submitted");
            if (caught.Filtered > 0) Console.WriteLine($"  ({caught.Filtered} declined by the tracking filter)");
        }

        try
        {
            if (await tracker.RefreshStatuses() is { Scores: > 0 } statuses)
            {
                Console.WriteLine($"  Ranked status updated for {statuses.Beatmaps} beatmap(s), from osu!lazer's newer beatmap list\n");
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Console.WriteLine($"  ranked status refresh failed: {e.Message}");
        }

        try
        {
            if (await tracker.RepairScores() is { Considered: > 0 } repaired)
            {
                Console.WriteLine($"  Put right {repaired.Considered} score(s) stored before this version could read them fully"
                    + $"{(repaired.GainedPp > 0 ? $" ({repaired.GainedPp} now have pp)" : "")}\n");
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Console.WriteLine($"  score repair failed: {e.Message}");
        }

        /*
         * Best performances imported from osu! and still on osu!'s own figures: each built into a replay
         * and priced here, so a pp rework reprices them with everything else. Only on installed
         * beatmaps: a launch never goes online, so the rest wait for Recalculate every score or the
         * next import.
         */
        var converted = 0;
        foreach (var profile in Profiles.List(db))
        {
            try
            {
                converted += (await ScoreEntry.ConvertImported(EntryDeps.Of(tracker, db, dataDir, profile.Id, OsuWeb.Shared), profile.Id, download: false)).Converted;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                /* as the Node app's: that profile converts nothing this launch */
            }
        }
        if (converted > 0) Console.WriteLine($"  Priced {converted} score(s) imported from osu! here, from their own numbers\n");
        // Uploaded and built replays nothing points at any more.
        UploadedReplays.Prune(db, dataDir);

        var official = tracker.Calculator;
        var outdated = official?.Version is { } release ? Recompute.Batches(db, release) : [];
        if (outdated.Count > 0 && Recompute.RecalculatedFor(db) != official?.Version)
        {
            Console.WriteLine($"\n  pp: osu! {official?.Version} is new here -- recalculating {outdated.Sum(b => b.Ids.Count)} score(s) priced by an older release");
        }
        try
        {
            if (await tracker.RecalculateAfterUpdate() is { } repriced)
            {
                Console.WriteLine($"  pp: recalculated {repriced.Result.Updated} score(s) with osu! {repriced.Release}"
                    + $"{(repriced.Result.Skipped > 0 ? $" ({repriced.Result.Skipped} left as they were: replay or beatmap no longer on disk)" : "")}\n");
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Console.WriteLine($"  pp recalculation failed: {e.Message}");
        }
    }

    /// <summary>
    /// What the console says once the app is up: the profile's standing, what is tracked and how,
    /// and, once per profile, the plays somebody else set taken out of a profile linked to its owner.
    /// </summary>
    public static async Task Banner(Database db, PlayTracker tracker, Profile active, bool fromTray)
    {
        var settings = SettingsStore.Get(db, active.Id);
        var standing = Stats.Compute(db, active.Id, 0, Eligibility.Of(settings, tracker.Beatmaps.KnowsStatus));
        var rank = Ranks.Estimate(standing.TotalPp, 0);
        Console.WriteLine($"\n  Tracking \"{active.Name}\"");
        Console.WriteLine($"  {standing.Playcount} play(s), {F(standing.TotalPp, 0)}pp{(rank is null ? ", unranked" : $", around #{Grouped(rank.Rank)}")}, level {standing.Level.Current}");
        Console.WriteLine("  Play osu! (online or offline) and scores will appear below.");
        if (settings.ImportPlaysWhileClosed)
        {
            Console.WriteLine("  Plays set while this app was closed are brought in when it opens.");
            Console.WriteLine("  Options -> Other settings turns that off.");
        }
        else
        {
            Console.WriteLine("  Plays set while this app is closed are not tracked.");
            Console.WriteLine("  Options -> Import past plays brings them in if you want them,");
            Console.WriteLine("  and Other settings can have every launch do it for you.");
        }
        if (tracker.FilterNarrowing)
        {
            Console.WriteLine("  A play tracking filter is on -- plays it declines are not tracked.");
            Console.WriteLine("  They are listed in Options -> Other settings -> Plays not tracked.");
        }
        var identity = tracker.PlayerIdentity;
        if (identity.Source == "unknown")
        {
            Console.WriteLine("  Not sure whose plays these are, so every replay found is tracked.");
            Console.WriteLine("  Signing in to osu! with 'remember username' on settles it.");
        }
        else
        {
            var earlier = identity.Names.Count - 1;
            var who = identity.DisplayName.Length > 0 ? identity.DisplayName : $"user {identity.UserId}";
            Console.WriteLine($"  Tracking plays set by {who}{(earlier > 0 ? $" (and {earlier} earlier name{(earlier == 1 ? "" : "s")})" : "")} -- replays you watched are not counted.");
        }
        Console.WriteLine(fromTray
            ? "  Quit from the tray icon, or with Quit on the page.\n"
            : "  Close this window, press Ctrl+C, or press Quit on the page to stop tracking.\n");

        // Once per profile, and only on a linked account with osu!'s complete list of names.
        var sweptKey = $"foreignScoresSwept:{active.Id}";
        if (db.Exists("SELECT 1 AS hit FROM kv WHERE key = ?", sweptKey) || identity.Source != "linked" || !identity.NamesComplete) return;
        var sweep = await Players.SweepForeignScores(db, active.Id, identity, file =>
        {
            try
            {
                return Task.FromResult<ReplayPlayer?>(Players.ReplayPlayer(Osr.Parse(File.ReadAllBytes(file))));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                return Task.FromResult<ReplayPlayer?>(null);
            }
        });
        db.Run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", sweptKey, "1");
        if (sweep.Hidden > 0)
        {
            var named = string.Join(", ", sweep.ByPlayer.Take(4).Select(p => $"{p.Name} ({p.Count})"));
            Console.WriteLine($"  Removed {sweep.Hidden} play(s) set by someone else -- replays you watched: {named}"
                + $"{(sweep.ByPlayer.Count > 4 ? $", and {sweep.ByPlayer.Count - 4} more" : "")}");
            Console.WriteLine("  They are in Options -> Other settings -> Removed scores if any are yours.\n");
        }
    }
}
