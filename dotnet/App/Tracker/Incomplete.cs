using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tracker;

/// <summary>
/// What tracking a play from lazer's log needs. <c>Filter</c> omitted is no filtering; <c>Declines</c>
/// omitted records nothing, which is what a preview must do.
/// </summary>
internal sealed record IncompleteContext(
    Database Db,
    BeatmapResolver Resolver,
    long ProfileId,
    double TrackingSince,
    TrackingFilter? Filter = null,
    string? Declines = null);

/// <summary>An unfinished play just tracked.</summary>
internal sealed record IngestedIncomplete(long Id, int Mode, string Title, string? TitleOriginal, double PlayedAt, bool Unsubmitted);

/// <summary>
/// What became of a play from the log, or what it would come to: <c>ready</c> to write (checks only),
/// <c>added</c>, <c>skipped</c> (passed, too-old, duplicate, unresolved) or <c>filtered</c>, with
/// what tracking it anyway would write.
/// </summary>
internal sealed record IncompleteResult(
    string Status,
    string? Reason = null,
    IngestedIncomplete? Play = null,
    string? Criterion = null,
    string? Title = null,
    string? TitleOriginal = null,
    Recording? Recording = null,
    int? Mode = null,
    object? BeatmapId = null);

/// <summary>
/// Turning a play read out of lazer's log into a tracked one: src/tracker/incomplete.ts. Stored in
/// <c>incomplete_plays</c>, never in <c>scores</c>, with nothing invented for the numbers lazer
/// never wrote down. Each kind has a check, which writes nothing, and an ingest that is the check
/// followed by the write, so a preview never promises a play the import then refuses.
/// </summary>
internal static class Incomplete
{
    /// <summary>A counted play's beatmap, by the submission's beatmap id, else the log's exact name for it.</summary>
    private static string? FindBeatmap(LoggedPlay play, IncompleteContext ctx)
    {
        if (play.BeatmapId is { } id && ctx.Resolver.Md5ForBeatmapId(id) is { Length: > 0 } md5) return md5;
        return string.IsNullOrEmpty(play.BeatmapName) ? null : ctx.Resolver.Md5ForBeatmapName(play.BeatmapName);
    }

    /// <summary>Already stored, or deleted for good from Settings.</summary>
    private static bool IsRecorded(IncompleteContext ctx, string key) =>
        ctx.Db.Exists("SELECT 1 AS hit FROM incomplete_plays WHERE profile_id = ? AND dedupe_key = ?", ctx.ProfileId, key)
        || Scores.WasDeleted(ctx.Db, ctx.ProfileId, Scores.DeletedIncompleteKey(key));

    /// <summary>File and filter a play whose beatmap is known, by the same rules for both kinds.</summary>
    private static IncompleteResult Assess(Recording entry, IncompleteContext ctx)
    {
        var beatmap = ctx.Resolver.Resolve(entry.Md5);
        var mode = beatmap.OsuPath is { Length: > 0 } osuPath ? Beatmaps.Mode(osuPath) : 0;
        var (title, titleOriginal) = Ingest.Describe(beatmap, entry.Md5);

        // No mod list and no star rating: lazer records neither, and a missing fact never rejects.
        var filter = ctx.Filter ?? TrackingFilter.Default();
        if (filter.Enabled)
        {
            var facts = TrackingFilter.BeatmapFacts(ctx.Db, ctx.Resolver, beatmap);
            if (filter.Rejects(TrackingFilter.PlayFactsOf(facts, mode, null, "lazer")) is { } rejected)
            {
                return new IncompleteResult("filtered", Criterion: rejected, Title: title, TitleOriginal: titleOriginal, Recording: entry, Mode: mode);
            }
        }
        return new IncompleteResult("ready", Recording: entry, Mode: mode, Title: title, TitleOriginal: titleOriginal, BeatmapId: beatmap.BeatmapId);
    }

    private static IncompleteResult Write(IncompleteResult ready, IncompleteContext ctx)
    {
        var entry = ready.Recording!;
        var id = ctx.Db.Serialized(() =>
        {
            ctx.Db.Run("""
                INSERT INTO incomplete_plays
                  (profile_id, dedupe_key, mode, beatmap_md5, beatmap_id, beatmap_name,
                   played_at, started_at, online_score_id, unsubmitted)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """, ctx.ProfileId, entry.DedupeKey, ready.Mode, entry.Md5, ready.BeatmapId, entry.BeatmapName,
                entry.PlayedAt, entry.StartedAt, entry.OnlineScoreId, entry.Unsubmitted ? 1 : 0);
            return Convert.ToInt64(ctx.Db.Scalar("SELECT last_insert_rowid() AS id"));
        });
        Declined.Forget(ctx.Db, ctx.ProfileId, "incomplete", entry.DedupeKey);
        return new IncompleteResult("added", Play: new IngestedIncomplete(id, ready.Mode!.Value, ready.Title!, ready.TitleOriginal, entry.PlayedAt, entry.Unsubmitted));
    }

    /// <summary>Everything <see cref="IngestPlay"/> decides, without writing anything.</summary>
    public static IncompleteResult CheckPlay(LoggedPlay play, IncompleteContext ctx)
    {
        // A passed play was imported by lazer and reaches this app as a replay.
        if (play.Passed) return new IncompleteResult("skipped", "passed");
        if (play.CountedAt < ctx.TrackingSince) return new IncompleteResult("skipped", "too-old");
        if (IsRecorded(ctx, play.Token)) return new IncompleteResult("skipped", "duplicate");
        // Without a beatmap there is no mode to file the play under: dropped, and said so.
        if (FindBeatmap(play, ctx) is not { } md5) return new IncompleteResult("skipped", "unresolved");
        return Assess(new Recording(play.Token, md5, play.BeatmapName, play.CountedAt, play.StartedAt, play.OnlineScoreId, false), ctx);
    }

    public static IncompleteResult IngestPlay(LoggedPlay play, IncompleteContext ctx) => Settle(CheckPlay(play, ctx), ctx);

    /// <summary>Write a play that is ready, and record one the filter turned away.</summary>
    private static IncompleteResult Settle(IncompleteResult checkedPlay, IncompleteContext ctx)
    {
        if (checkedPlay.Status == "ready") return Write(checkedPlay, ctx);
        if (checkedPlay.Status == "filtered" && ctx.Declines is not null)
        {
            var recording = checkedPlay.Recording!;
            Declined.Record(ctx.Db, ctx.ProfileId, new Decline("incomplete", recording.DedupeKey, "filtered", checkedPlay.Criterion, null,
                ctx.Declines, checkedPlay.Title, checkedPlay.TitleOriginal, checkedPlay.Mode, recording.PlayedAt, null, recording));
        }
        return checkedPlay;
    }

    /// <summary>Write a play the filter once turned away, from what was recorded then: Track anyway.</summary>
    public static IncompleteResult IngestRecording(Recording entry, IncompleteContext ctx)
    {
        if (IsRecorded(ctx, entry.DedupeKey)) return new IncompleteResult("skipped", "duplicate");
        return Settle(Assess(entry, ctx), ctx);
    }

    /// <summary>An attempt's dedupe key: its session log, its gameplay screen, and the moment it was entered.</summary>
    public static string AttemptKey(UnsubmittedAttempt attempt) =>
        $"unsubmitted:{attempt.Session}:{attempt.Player}:{Js.NumberToString(attempt.StartedAt)}";

    /// <summary>Everything <see cref="IngestAttempt"/> decides, without writing anything.</summary>
    public static IncompleteResult CheckAttempt(UnsubmittedAttempt attempt, IncompleteContext ctx)
    {
        if (attempt.EndedAt < ctx.TrackingSince) return new IncompleteResult("skipped", "too-old");
        var key = AttemptKey(attempt);
        if (IsRecorded(ctx, key)) return new IncompleteResult("skipped", "duplicate");
        // No submission, so no beatmap id: the log's name for the map is the only handle.
        if ((string.IsNullOrEmpty(attempt.BeatmapName) ? null : ctx.Resolver.Md5ForBeatmapName(attempt.BeatmapName)) is not { } md5)
        {
            return new IncompleteResult("skipped", "unresolved");
        }
        return Assess(new Recording(key, md5, attempt.BeatmapName, attempt.EndedAt, attempt.StartedAt, null, true), ctx);
    }

    /// <summary>Record an attempt osu! logged it had no token for: always, whatever the setting that decides whether it counts.</summary>
    public static IncompleteResult IngestAttempt(UnsubmittedAttempt attempt, IncompleteContext ctx) => Settle(CheckAttempt(attempt, ctx), ctx);

    /// <summary>
    /// What lazer's logs hold that a profile has not tracked: plays osu! counted but never wrote a
    /// replay for, and attempts it could not submit, from every session that changed since
    /// <paramref name="since"/>, oldest first, each once.
    /// </summary>
    public static (List<LoggedPlay> Unfinished, List<UnsubmittedAttempt> Attempts, int AlreadyTracked, int Sessions) ScanLogs(
        Database db, long profileId, IEnumerable<string> dirs, double since, double? until = null)
    {
        bool After(double at) => until is { } u && at > u;
        bool Recorded(string key) =>
            db.Exists("SELECT 1 AS hit FROM incomplete_plays WHERE profile_id = ? AND dedupe_key = ?", profileId, key)
            || Scores.WasDeleted(db, profileId, Scores.DeletedIncompleteKey(key));
        static string ReadText(string file)
        {
            try
            {
                return Js.ReadFileUtf8(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return "";
            }
        }

        var unfinished = new List<LoggedPlay>();
        var attempts = new List<UnsubmittedAttempt>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int alreadyTracked = 0, sessions = 0;

        foreach (var dir in dirs)
        {
            foreach (var files in LazerLog.ListLogSessions(dir))
            {
                if (files.ModifiedAt < since) continue;
                sessions++;
                var events = LazerLog.ParseSessionEvents(ReadText(files.Runtime));
                var ids = files.Network is not null ? LazerLog.ParseSubmissionBeatmaps(ReadText(files.Network)) : [];

                foreach (var play in events.Plays)
                {
                    if (play.Passed || play.CountedAt < since || After(play.CountedAt) || seen.Contains(play.Token)) continue;
                    seen.Add(play.Token);
                    if (Recorded(play.Token))
                    {
                        alreadyTracked++;
                        continue;
                    }
                    unfinished.Add(play with { BeatmapId = ids.TryGetValue(play.Token, out var id) ? id : null });
                }

                foreach (var found in events.Attempts)
                {
                    var attempt = found with { Session = files.Id };
                    var key = AttemptKey(attempt);
                    if (attempt.EndedAt < since || After(attempt.EndedAt) || seen.Contains(key)) continue;
                    seen.Add(key);
                    if (Recorded(key))
                    {
                        alreadyTracked++;
                        continue;
                    }
                    attempts.Add(attempt);
                }
            }
        }

        return ([.. unfinished.OrderBy(p => p.CountedAt)], [.. attempts.OrderBy(a => a.EndedAt)], alreadyTracked, sessions);
    }
}
