using System.Diagnostics;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tracker;

/// <summary>A play the filter turned away, as the page is told of it.</summary>
internal sealed record FilteredPlay(string Title, string? TitleOriginal, string Criterion, string Kind, double At);

/// <summary>A replay turned away as another player's, or one that could not be read.</summary>
internal sealed record RefusedPlay(string Reason, double At, string? Player = null, string? Title = null, string? TitleOriginal = null);

/// <summary>The beatmap index as the page shows it: whether it is working, whether to say so, and plays waiting on it.</summary>
internal sealed record IndexState(bool Active, bool Visible, string Phase, long Scanned, long Total, long Indexed, bool FirstRun, int Waiting, string? Error);

/// <summary>An import in progress: walking the folders, then importing what it found.</summary>
internal sealed record ImportState(bool Active, string Phase, long Scanned, long Files, long Done, long Total, string Origin);

/// <summary>What an import brought in.</summary>
internal sealed record BackfillResult(int Imported, int Unfinished, int Attempts, int Skipped, int Filtered, int OtherPlayers, long Scanned, double Since, double? Until);

/// <summary>What an import takes: replays, plays lazer's log saw but osu! kept no replay of, and attempts osu! could not submit.</summary>
internal sealed record BackfillSources(bool Replays, bool Unfinished, bool Attempts)
{
    public static readonly BackfillSources ReplaysOnly = new(true, false, false);
    public static readonly BackfillSources Everything = new(true, true, true);
}

/// <summary>What Track anyway did: tracked, already there, the replay gone, or unreadable.</summary>
internal sealed record TrackAnywayResult(string Status, string? Kind = null);

/// <summary>What an import of lazer's log would bring in, as Check previews it.</summary>
internal sealed record LogBackfillPreview(int Unfinished, int Attempts, int AlreadyTracked, int Unresolved, int Filtered, int Sessions, double? Earliest, double? Latest);

/// <summary>
/// Watches osu! and writes what it plays: src/tracker/index.ts. Every write goes through one queue,
/// so two plays can never be ingested at once, and imports, recalculations and live plays take turns.
/// </summary>
internal sealed class PlayTracker(Database db, BeatmapResolver resolver, IReadOnlyList<OsuInstall> installs, long profileId,
    double trackingSince, OfficialCalculator? official, double? liveSince = null)
{
    /// <summary>Marks the one-off repair of stable mods read from part of their bitmask as done.</summary>
    private const string RedecodedKey = "legacyModsRedecoded";

    /// <summary>An index this quick is not worth a progress bar.</summary>
    private const double QuietIndexMs = 1500;

    private readonly object gate = new();
    private Task queue = Task.CompletedTask;
    private ReplayWatcher? watcher;
    private LogWatcher? logWatcher;
    private List<McosuWatcher> mcosuWatchers = [];
    private SongsWatcher? songsWatcher;
    private bool enabled;
    private double liveFrom;
    private long profile = profileId;
    private double since = trackingSince;
    private OfficialCalculator? calculator = official;
    private int added, filtered, refused;
    private IndexState index = new(false, false, "indexing", 0, 0, 0, false, 0, null);
    private ImportState importing = new(false, "scanning", 0, 0, 0, 0, "import");
    private int importsPending;
    private long importEmittedAt = long.MinValue;
    private Task<RecomputeResult>? recalculation;

    public event Action<IngestedScore>? Score;
    public event Action<IngestedIncomplete>? IncompletePlay;
    public event Action<string>? Skip;
    public event Action<FilteredPlay>? Filtered;
    public event Action<RefusedPlay>? Refused;
    public event Action<Exception>? Error;
    public event Action<IndexState>? Indexing;
    public event Action<BackfillResult>? CaughtUp;
    public event Action<ImportState>? Importing;
    public event Action<int, int>? Recalculating;
    public event Action<RecomputeResult>? Recalculated;

    public BeatmapResolver Beatmaps => resolver;
    public bool IsTracking => enabled;

    /// <summary>Plays from before this are not live tracking's: the later of the tracking start and the launch.</summary>
    public double LiveCutoff => Math.Max(since, liveFrom);

    public int ScoresAdded => added;
    public int PlaysFiltered => filtered;
    public int PlaysRefused => refused;
    public long ProfileId => profile;

    private TrackingFilter CurrentFilter() => SettingsStore.Get(db, profile).TrackingFilter;

    public bool FilterNarrowing => TrackingFilter.Narrows(CurrentFilter());

    public PlayerIdentity PlayerIdentity => Players.Resolve(db, profile, installs);

    public IndexState IndexState
    {
        get
        {
            lock (gate) return index;
        }
    }

    public ImportState ImportState
    {
        get
        {
            lock (gate) return importing;
        }
    }

    public string? CalculatorVersion => calculator?.Version;
    public OfficialCalculator? Calculator => calculator;
    public long StaleScores => Recompute.CountStale(db, profile);
    public bool IsRecalculating => recalculation is not null;

    private void ReportImport(bool now = false)
    {
        ImportState state;
        lock (gate)
        {
            var at = Stopwatch.GetTimestamp();
            if (!now && Stopwatch.GetElapsedTime(importEmittedAt, at).TotalMilliseconds < 250) return;
            importEmittedAt = at;
            state = importing;
        }
        Importing?.Invoke(state);
    }

    /// <summary>
    /// Build the beatmap index, reporting as it goes. Started at once, beside the queue: plays that
    /// arrive meanwhile wait behind it, since resolving them needs it.
    /// </summary>
    public Task IndexBeatmaps(IReadOnlyList<IndexRoot> roots)
    {
        var started = Stopwatch.GetTimestamp();
        var lastEmit = long.MinValue;
        lock (gate) index = index with { Active = true, Visible = false, Error = null };
        void Report(bool final = false)
        {
            IndexState state;
            lock (gate)
            {
                index = index with { Visible = index.Active && (index.FirstRun || Stopwatch.GetElapsedTime(started).TotalMilliseconds > QuietIndexMs) };
                var now = Stopwatch.GetTimestamp();
                if (!final && lastEmit != long.MinValue && Stopwatch.GetElapsedTime(lastEmit, now).TotalMilliseconds < 250) return;
                lastEmit = now;
                state = index;
            }
            Indexing?.Invoke(state);
        }

        var run = Task.Run(() =>
        {
            try
            {
                Clients.Beatmaps.IndexFiles(db, roots, p =>
                {
                    lock (gate) index = index with { Phase = p.Phase, Scanned = p.Scanned, Total = p.Total, Indexed = p.Indexed, FirstRun = p.FirstRun };
                    Report();
                });
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                lock (gate) index = index with { Error = e.Message };
                Error?.Invoke(e);
            }
            finally
            {
                lock (gate) index = index with { Active = false, Waiting = 0 };
                Report(true);
            }
        });
        lock (gate) queue = queue.ContinueWith(_ => run, TaskScheduler.Default).Unwrap().ContinueWith(_ => { }, TaskScheduler.Default);
        return run;
    }

    /// <summary>A play arrived while the index is still being built: it waits, and the page says so.</summary>
    private void Arrived()
    {
        IndexState state;
        lock (gate)
        {
            if (!index.Active) return;
            index = index with { Waiting = index.Waiting + 1 };
            state = index;
        }
        Indexing?.Invoke(state);
    }

    public void SetTrackingSince(double at)
    {
        since = at;
        added = filtered = refused = 0;
    }

    public Task SwitchProfile(long id, double trackingSince) => Enqueue(() =>
    {
        profile = id;
        since = trackingSince;
        added = filtered = refused = 0;
        return Task.FromResult(0);
    });

    /// <summary>
    /// Start watching: replays (lazer's store and stable's Data/r), lazer's logs, McOsu's scores files,
    /// and stable's Songs folders, so a map downloaded mid-session resolves at once.
    /// </summary>
    public void Start()
    {
        if (watcher is not null) return;
        liveFrom = liveSince ?? Js.Now();
        watcher = new ReplayWatcher(
            [.. installs.Where(i => i.Kind != "mcosu").Select(i => i.ReplayDir)],
            HandleReplay,
            file => Clients.Beatmaps.IndexOneFile(db, file),
            e => Error?.Invoke(e));
        watcher.Start();

        var logDirs = installs.Select(LazerLog.LogDirOf).Where(d => d is not null).Select(d => d!).ToList();
        if (logDirs.Count > 0)
        {
            logWatcher = new LogWatcher(logDirs, HandleLoggedPlays, HandleUnsubmittedAttempts, e => Error?.Invoke(e));
            logWatcher.Start();
        }

        foreach (var install in installs.Where(i => i.Kind == "mcosu"))
        {
            var w = new McosuWatcher(install.Root, install.ReplayDir, HandleReplay, e => Error?.Invoke(e));
            mcosuWatchers.Add(w);
            _ = w.Start();
        }

        var songs = installs.Where(i => i.Kind != "lazer").SelectMany(i => i.BeatmapRoots).ToList();
        songs = [.. songs.Where((p, n) => songs.FindIndex(o => SamePath(o, p)) == n)];
        if (songs.Count > 0)
        {
            var w = new SongsWatcher(db, songs, e => Error?.Invoke(e));
            w.Start();
            songsWatcher = w;
            resolver.OnMiss = w.Flush;
        }
        enabled = true;
    }

    /// <summary><c>path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()</c>.</summary>
    internal static bool SamePath(string a, string b) => Js.ToLower(NodePath.Resolve(a)) == Js.ToLower(NodePath.Resolve(b));

    public void Stop()
    {
        watcher?.Stop();
        watcher = null;
        logWatcher?.Stop();
        logWatcher = null;
        foreach (var w in mcosuWatchers) w.Stop();
        mcosuWatchers = [];
        songsWatcher?.Stop();
        songsWatcher = null;
        resolver.OnMiss = null;
        enabled = false;
    }

    public void SetTracking(bool on)
    {
        if (on) Start();
        else Stop();
    }

    private TrackingFilter ImportFilter(bool applyFilter) => applyFilter ? CurrentFilter() : TrackingFilter.Default();

    /// <summary>What an import would bring in, without importing: Check.</summary>
    public Task<(BackfillScan Replays, LogBackfillPreview Log)> PreviewBackfill(double from, bool applyFilter = true, double? until = null,
        IReadOnlyCollection<string>? chosen = null) => Enqueue(async () =>
    {
        var filter = ImportFilter(applyFilter);
        await BuildMcosuReplays(from, chosen);
        var replays = Backfill.ScanForReplays(db, profile, ReplayDirs(chosen), from, until, (resolver, filter), Players.Resolve(db, profile, installs));
        return (replays, PreviewLogs(from, until, filter, chosen));
    });

    private LogBackfillPreview PreviewLogs(double from, double? until, TrackingFilter filter, IReadOnlyCollection<string>? chosen)
    {
        var scan = Incomplete.ScanLogs(db, profile, LogDirs(chosen), from, until);
        var ctx = ImportContext(from, filter);
        int unfinished = 0, attempts = 0, alreadyTracked = scan.AlreadyTracked, unresolved = 0, filteredCount = 0;
        double? earliest = null, latest = null;
        void Tally(IncompleteResult checkedPlay, bool attempt, double at)
        {
            if (checkedPlay.Status == "ready")
            {
                if (attempt) attempts++;
                else unfinished++;
                earliest = earliest is null ? at : Math.Min(earliest.Value, at);
                latest = latest is null ? at : Math.Max(latest.Value, at);
            }
            else if (checkedPlay.Status == "filtered") filteredCount++;
            else if (checkedPlay.Reason == "unresolved") unresolved++;
            else if (checkedPlay.Reason == "duplicate") alreadyTracked++;
        }
        foreach (var play in scan.Unfinished) Tally(Incomplete.CheckPlay(play, ctx), false, play.CountedAt);
        foreach (var attempt in scan.Attempts) Tally(Incomplete.CheckAttempt(attempt, ctx), true, attempt.EndedAt);
        return new LogBackfillPreview(unfinished, attempts, alreadyTracked, unresolved, filteredCount, scan.Sessions, earliest, latest);
    }

    private IncompleteContext ImportContext(double from, TrackingFilter filter, string? declines = null) =>
        new(db, resolver, profile, from, filter, declines);

    /// <summary>
    /// Import past plays: the replays in osu!'s folders, and what lazer's logs saw but kept no replay
    /// of, from <paramref name="from"/>, as the profile's filter and owner decide.
    /// </summary>
    public Task<BackfillResult> RunBackfill(double from, BackfillSources? sources = null, bool applyFilter = true, string origin = "import",
        double? until = null, IReadOnlyCollection<string>? chosen = null)
    {
        sources ??= BackfillSources.ReplaysOnly;
        var first = false;
        lock (gate)
        {
            importsPending++;
            if (!importing.Active)
            {
                importing = new ImportState(true, "scanning", 0, 0, 0, 0, origin);
                first = true;
            }
        }
        if (first) ReportImport(true);

        var run = Enqueue(async () =>
        {
            lock (gate) importing = new ImportState(true, "scanning", 0, 0, 0, 0, origin);
            ReportImport(true);
            int imported = 0, unfinished = 0, attempts = 0, skipped = 0, filteredCount = 0, otherPlayers = 0;
            long scanned = 0;
            var filter = ImportFilter(applyFilter);
            var owner = Players.Resolve(db, profile, installs);

            if (sources.Replays)
            {
                await BuildMcosuReplays(from, chosen);
                var scan = Backfill.ScanForReplays(db, profile, ReplayDirs(chosen), from, until, owner: owner,
                    onOtherPlayer: RecordOtherPlayer(origin),
                    onScanned: (n, files) =>
                    {
                        lock (gate) importing = importing with { Scanned = n, Files = files };
                        ReportImport();
                    });
                scanned = scan.Scanned;
                otherPlayers = scan.OtherPlayers.Sum(p => p.Count);
                lock (gate) importing = importing with { Phase = "importing", Total = scan.Candidates.Count(c => !c.Duplicate) };
                ReportImport(true);
                foreach (var candidate in scan.Candidates)
                {
                    if (candidate.Duplicate)
                    {
                        skipped++;
                        continue;
                    }
                    lock (gate) importing = importing with { Done = importing.Done + 1 };
                    ReportImport();
                    var result = await Ingest.ReplayFile(candidate.File,
                        new IngestContext(db, resolver, profile, from, calculator, filter, owner, origin));
                    if (result.Status == "added")
                    {
                        imported++;
                        Interlocked.Increment(ref added);
                    }
                    else if (result.Status == "filtered")
                    {
                        filteredCount++;
                        Interlocked.Increment(ref filtered);
                    }
                    else skipped++;
                }
            }

            if (sources.Unfinished || sources.Attempts)
            {
                var scan = Incomplete.ScanLogs(db, profile, LogDirs(chosen), from, until);
                var ctx = ImportContext(from, filter, origin);
                bool Tally(string status)
                {
                    if (status == "filtered")
                    {
                        filteredCount++;
                        Interlocked.Increment(ref filtered);
                    }
                    else if (status == "skipped") skipped++;
                    return status == "added";
                }
                if (sources.Unfinished)
                {
                    foreach (var play in scan.Unfinished)
                    {
                        if (Tally(Incomplete.IngestPlay(play, ctx).Status)) unfinished++;
                    }
                }
                if (sources.Attempts)
                {
                    foreach (var attempt in scan.Attempts)
                    {
                        if (Tally(Incomplete.IngestAttempt(attempt, ctx).Status)) attempts++;
                    }
                }
            }
            return new BackfillResult(imported, unfinished, attempts, skipped, filteredCount, otherPlayers, scanned, from, until);
        });
        void Finish()
        {
            lock (gate)
            {
                importsPending--;
                if (importsPending > 0) return;
                importing = importing with { Active = false };
            }
            ReportImport(true);
        }
        run.ContinueWith(_ => Finish(), TaskScheduler.Default);
        return run;
    }

    /// <summary>One replay file, dropped into Import past plays.</summary>
    public Task<IngestOutcome> ImportReplayFile(string file, bool applyFilter = true) => Enqueue(async () =>
    {
        var result = await Ingest.ReplayFile(file, new IngestContext(db, resolver, profile, 0, calculator, ImportFilter(applyFilter),
            Players.Resolve(db, profile, installs), "import"));
        if (result.Status == "added") Interlocked.Increment(ref added);
        else if (result.Status == "filtered") Interlocked.Increment(ref filtered);
        return result;
    });

    /// <summary>A replay this app built for a score from its osu! link or entered by hand: nothing to filter or refuse.</summary>
    public Task<IngestOutcome> ImportBuiltReplay(string file, long? forProfile = null) => Enqueue(async () =>
    {
        var target = forProfile ?? profile;
        var result = await Ingest.ReplayFile(file, new IngestContext(db, resolver, target, 0, calculator, TrackingFilter.Default(), PlayerIdentity.Unknown));
        if (result.Status == "added" && target == profile)
        {
            Interlocked.Increment(ref added);
            Score?.Invoke(result.Score!);
        }
        return result;
    });

    /// <summary>The replays on this machine for scores held as osu!'s figures, each taking its score's place.</summary>
    public Task<int> AttachLocalReplays(long forProfile, IReadOnlyCollection<long>? only = null) => Enqueue(async () =>
    {
        var attached = 0;
        foreach (var match in Backfill.FindLocalReplays(db, forProfile, ReplayDirs(null), only))
        {
            var result = await Ingest.Score(match.Score, match.File,
                new IngestContext(db, resolver, forProfile, 0, calculator, TrackingFilter.Default(), PlayerIdentity.Unknown));
            if (result.Status == "added") attached++;
        }
        return attached;
    });

    /// <summary>A replay priced as played, without storing anything.</summary>
    public Task<PpResult?> PriceReplay(string file) => Enqueue(async () =>
    {
        if (calculator is null) return null;
        var score = Osr.Parse(File.ReadAllBytes(file));
        var beatmap = resolver.Resolve(score.BeatmapMD5);
        return await Pricing.PriceAsPlayed(file, beatmap, calculator, Mods.ScorePricing(score, beatmap.OsuPath));
    });

    /// <summary>
    /// Import what was played while the app was closed, when the profile asked for it and there is a
    /// gap: everything, through the same import as Import past plays.
    /// </summary>
    public async Task<BackfillResult?> RunCatchUp(double? gap)
    {
        if (gap is not { } from) return null;
        if (!SettingsStore.Get(db, profile).ImportPlaysWhileClosed) return null;
        var result = await RunBackfill(from, BackfillSources.Everything, true, "catch-up");
        CaughtUp?.Invoke(result);
        return result;
    }

    private Action<string, ReplayScore, string> RecordOtherPlayer(string origin) => (file, score, player) =>
    {
        var (title, titleOriginal) = Ingest.Describe(resolver.Resolve(score.BeatmapMD5), score.BeatmapMD5);
        Declined.Record(db, profile, new Decline("score", Ingest.DedupeKey(score), "another-player", null, player, origin,
            title, titleOriginal, score.Mode, score.PlayedAtMs, file, null));
    };

    /// <summary>Track a play the app turned away, one at a time: past the filter and the owner check.</summary>
    public Task<TrackAnywayResult> TrackAnyway(long id) => Enqueue(async () =>
    {
        var target = profile;
        var row = db.FirstRow("SELECT kind, replay_path, recording FROM declined_plays WHERE profile_id = ? AND id = ?", target, id)
            ?? throw new InvalidOperationException("that play is not in the list any more");

        if (row.Str("kind") == "incomplete")
        {
            if (row.Str("recording") is not { } json || System.Text.Json.JsonSerializer.Deserialize<Recording>(json, JsonText.Options) is not { } recording)
            {
                throw new InvalidOperationException("nothing was recorded to track that play from");
            }
            var played = Incomplete.IngestRecording(recording, new IncompleteContext(db, resolver, target, 0, TrackingFilter.Default()));
            Declined.ForgetById(db, target, id);
            if (played.Status != "added") return new TrackAnywayResult("already");
            IncompletePlay?.Invoke(played.Play!);
            return new TrackAnywayResult("tracked", "incomplete");
        }

        if (row.Str("replay_path") is not { } replayPath || !(File.Exists(replayPath) || Directory.Exists(replayPath))) return new TrackAnywayResult("missing");
        var result = await Ingest.ReplayFile(replayPath, new IngestContext(db, resolver, target, 0, calculator, TrackingFilter.Default(), PlayerIdentity.Unknown));
        if (result is { Status: "skipped", Reason: "unparseable" }) return new TrackAnywayResult("unparseable");
        Declined.ForgetById(db, target, id);
        if (result.Status != "added") return new TrackAnywayResult("already");
        Interlocked.Increment(ref added);
        Score?.Invoke(result.Score!);
        return new TrackAnywayResult("tracked", "score");
    });

    /// <summary>Plays turned away under a name since confirmed as the player's own, tracked now.</summary>
    public Task<int> RetrackOwnNames() => Enqueue(async () =>
    {
        var target = profile;
        var identity = Players.Resolve(db, target, installs);
        var tracked = 0;
        foreach (var row in Declined.OtherPlayerDeclines(db, target))
        {
            if (row.Player is null || !identity.Names.Contains(Js.ToLower(Js.Trim(row.Player)))) continue;
            if (row.ReplayPath is null || !(File.Exists(row.ReplayPath) || Directory.Exists(row.ReplayPath))) continue;
            var result = await Ingest.ReplayFile(row.ReplayPath, new IngestContext(db, resolver, target, 0, calculator, CurrentFilter(), identity, row.Source));
            if (result.Status == "added")
            {
                tracked++;
                Interlocked.Increment(ref added);
                Score?.Invoke(result.Score!);
            }
            else if (result.Status == "skipped" && result.Reason is not ("another-player" or "unparseable"))
            {
                Declined.ForgetById(db, target, row.Id);
            }
        }
        return tracked;
    });

    public Task<RecomputeResult> RecomputeAll(bool onlyMissing, Action<int, int>? onProgress = null) => Enqueue(async () =>
    {
        var current = calculator ?? throw new InvalidOperationException("the pp calculator is not available -- run: npm run build:pp");
        return await Recompute.Scores(db, resolver, profile, current, onlyMissing, null, onProgress);
    });

    public Task<RecomputeResult?> RecomputeScore(long id, long forProfile) => Enqueue(async () =>
        calculator is null ? null : await Recompute.Scores(db, resolver, forProfile, calculator, ids: [id]));

    /// <summary>
    /// Reprice every score from its replay, or only those another osu! release priced, in batches that
    /// take their turn in the queue, so live plays are not held up behind thousands.
    /// </summary>
    public Task<RecomputeResult> Recalculate(bool outdatedOnly)
    {
        var current = calculator;
        if (current is null) return Task.FromException<RecomputeResult>(new InvalidOperationException("the pp calculator is not available -- run: npm run build:pp"));
        lock (gate)
        {
            if (recalculation is not null) return Task.FromException<RecomputeResult>(new InvalidOperationException("scores are already being recalculated"));
            var batches = outdatedOnly
                ? current.Version is null ? [] : Recompute.Batches(db, current.Version)
                : Recompute.Batches(db, null);
            var total = batches.Sum(b => b.Ids.Count);
            async Task<RecomputeResult> Run()
            {
                await Task.Yield();
                var sum = RecomputeResult.None;
                var done = 0;
                Recalculating?.Invoke(done, total);
                foreach (var batch in batches)
                {
                    var step = await Enqueue(() => Recompute.Scores(db, resolver, batch.ProfileId, current, ids: batch.Ids));
                    sum += step;
                    done += batch.Ids.Count;
                    Recalculating?.Invoke(done, total);
                }
                Recalculated?.Invoke(sum);
                return sum;
            }
            var task = Run();
            recalculation = task;
            task.ContinueWith(_ =>
            {
                lock (gate) recalculation = null;
            }, TaskScheduler.Default);
            return task;
        }
    }

    /// <summary>A new osu! release: reprice what an older one priced, once per release.</summary>
    public async Task<(string Release, RecomputeResult Result)?> RecalculateAfterUpdate()
    {
        if (calculator?.Version is not { } release || Recompute.RecalculatedFor(db) == release) return null;
        if (Recompute.Batches(db, release).Count == 0)
        {
            Recompute.MarkRecalculatedFor(db, release);
            return null;
        }
        var result = await Recalculate(true);
        Recompute.MarkRecalculatedFor(db, release);
        return (release, result);
    }

    /// <summary>
    /// Scores stored before this version could read them fully: priced while their beatmap was not
    /// found, or (once) stable plays whose mods were read from part of their bitmask.
    /// </summary>
    public async Task<RecomputeResult?> RepairScores()
    {
        if (calculator is not { } current) return null;
        var redecode = !db.Exists("SELECT 1 AS hit FROM kv WHERE key = ?", RedecodedKey);
        var rows = Recompute.FoundBeatmapIds(db).Concat(redecode ? Recompute.MisdecodedIds(db) : []).OrderBy(r => r.ProfileId).ToList();
        var sum = RecomputeResult.None;
        foreach (var batch in Recompute.ToBatches(rows))
        {
            sum += await Enqueue(() => Recompute.Scores(db, resolver, batch.ProfileId, current, ids: batch.Ids));
        }
        if (redecode) db.Run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", RedecodedKey, Js.NumberToString(Js.Now()));
        return sum;
    }

    public Task<StatusRefresh?> RefreshStatuses() => Enqueue(() => Task.FromResult(Clients.Beatmaps.RefreshStatuses(db, resolver)));

    /// <summary>Switch to another osu! calculator, then reprice every score with it.</summary>
    public async Task<RecomputeResult> SwitchCalculator(OfficialCalculator next, Action? onSwapped = null)
    {
        if (recalculation is not null) throw new InvalidOperationException("scores are already being recalculated");
        await Enqueue(() =>
        {
            calculator = next;
            return Task.FromResult(0);
        });
        onSwapped?.Invoke();
        var result = await Recalculate(false);
        if (next.Version is { } version) Recompute.MarkRecalculatedFor(db, version);
        return result;
    }

    private async Task BuildMcosuReplays(double from, IReadOnlyCollection<string>? chosen)
    {
        foreach (var install in Chosen(chosen).Where(i => i.Kind == "mcosu"))
        {
            try
            {
                await McosuWatcher.BuildReplays(install.Root, install.ReplayDir, from);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                Error?.Invoke(e);
            }
        }
    }

    private IEnumerable<OsuInstall> Chosen(IReadOnlyCollection<string>? chosen) =>
        chosen is null ? installs : installs.Where(i => chosen.Contains(i.Root));

    private List<string> LogDirs(IReadOnlyCollection<string>? chosen) =>
        [.. Chosen(chosen).Select(LazerLog.LogDirOf).Where(d => d is not null).Select(d => d!)];

    private List<string> ReplayDirs(IReadOnlyCollection<string>? chosen) => [.. Chosen(chosen).Select(i => i.ReplayDir)];

    /// <summary>One task after everything already queued, whether or not those failed.</summary>
    private Task<T> Enqueue<T>(Func<Task<T>> task)
    {
        lock (gate)
        {
            var run = queue.ContinueWith(_ => task(), TaskScheduler.Default).Unwrap();
            queue = run.ContinueWith(_ => { }, TaskScheduler.Default);
            return run;
        }
    }

    /// <summary>Queued work whose failure is reported rather than returned.</summary>
    private void Queue(Func<Task> work)
    {
        lock (gate)
        {
            queue = queue.ContinueWith(_ => work(), TaskScheduler.Default).Unwrap().ContinueWith(t =>
            {
                if (t.Exception?.GetBaseException() is { } e) Error?.Invoke(e);
            }, TaskScheduler.Default);
        }
    }

    private void HandleLoggedPlays(List<LoggedPlay> plays)
    {
        Arrived();
        Queue(() =>
        {
            foreach (var play in plays)
            {
                var result = Incomplete.IngestPlay(play, new IncompleteContext(db, resolver, profile, LiveCutoff, CurrentFilter(), "live"));
                if (result.Status == "added") IncompletePlay?.Invoke(result.Play!);
                else if (result.Status == "filtered") ReportFiltered(result.Title!, result.TitleOriginal, result.Criterion!, "incomplete");
                else if (result.Reason != "passed") Skip?.Invoke(result.Reason!);
            }
            return Task.CompletedTask;
        });
    }

    private void HandleUnsubmittedAttempts(List<UnsubmittedAttempt> attempts)
    {
        Arrived();
        Queue(() =>
        {
            foreach (var attempt in attempts)
            {
                var result = Incomplete.IngestAttempt(attempt, new IncompleteContext(db, resolver, profile, LiveCutoff, CurrentFilter(), "live"));
                if (result.Status == "added") IncompletePlay?.Invoke(result.Play!);
                else if (result.Status == "filtered") ReportFiltered(result.Title!, result.TitleOriginal, result.Criterion!, "incomplete");
                else Skip?.Invoke(result.Reason!);
            }
            return Task.CompletedTask;
        });
    }

    private void ReportFiltered(string title, string? titleOriginal, string criterion, string kind)
    {
        Interlocked.Increment(ref filtered);
        Filtered?.Invoke(new FilteredPlay(title, titleOriginal, criterion, kind, Js.Now()));
    }

    private void HandleReplay(string file)
    {
        Arrived();
        double arrivedAt = Js.Now();
        Queue(async () =>
        {
            var result = await Ingest.ReplayFile(file, new IngestContext(db, resolver, profile, LiveCutoff, calculator, CurrentFilter(),
                Players.Resolve(db, profile, installs), "live", arrivedAt));
            if (result.Status == "added")
            {
                Interlocked.Increment(ref added);
                Score?.Invoke(result.Score!);
            }
            else if (result.Status == "filtered")
            {
                ReportFiltered(result.Title!, result.TitleOriginal, result.Criterion!, "score");
            }
            else if (result.Reason == "another-player")
            {
                Interlocked.Increment(ref refused);
                Refused?.Invoke(new RefusedPlay("another-player", Js.Now(), result.Player, result.Title, result.TitleOriginal));
            }
            else if (result.Reason == "unparseable")
            {
                Interlocked.Increment(ref refused);
                Refused?.Invoke(new RefusedPlay("unparseable", Js.Now()));
            }
            else
            {
                Skip?.Invoke(result.Reason!);
            }
        });
    }
}
