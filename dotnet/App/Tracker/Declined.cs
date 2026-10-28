using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tracker;

/// <summary>A play the app turned away, as Settings lists it.</summary>
internal sealed record DeclinedPlay(
    long Id,
    string Kind,
    string Reason,
    string? Criterion,
    string? Player,
    string Source,
    string? Title,
    string? TitleOriginal,
    long? Mode,
    long? PlayedAt,
    long DeclinedAt,
    string? FileName);

/// <summary>
/// Plays the tracking filter or the owner check turned away: src/tracker/declined.ts, reading
/// half. Recorded in <c>declined_plays</c>, which no figure reads.
/// </summary>
/// <summary>An unfinished play as lazer's log recorded it, kept with a decline so it can be tracked anyway.</summary>
internal sealed record Recording(string DedupeKey, string Md5, string? BeatmapName, double PlayedAt, double? StartedAt,
    string? OnlineScoreId, bool Unsubmitted);

/// <summary>
/// A play turned away: <c>kind</c> score or incomplete, <c>reason</c> filtered, another-player or
/// unparseable, and <c>source</c> live, import or catch-up.
/// </summary>
internal sealed record Decline(
    string Kind,
    string DedupeKey,
    string Reason,
    string? Criterion,
    string? Player,
    string Source,
    string? Title,
    string? TitleOriginal,
    double? Mode,
    double? PlayedAt,
    string? ReplayPath,
    Recording? Recording);

internal static class Declined
{
    /// <summary>How many are kept per profile, newest first.</summary>
    public const int MaxDeclines = 1000;

    /// <summary>How a decline's play is remembered in <c>deleted_scores</c>, by the same keys ingest checks.</summary>
    private static string DeletedKey(string kind, string dedupeKey) =>
        kind == "incomplete" ? Scores.DeletedIncompleteKey(dedupeKey) : dedupeKey;

    /// <summary>A replay that could not be read is keyed by its path, which no ingest ever checks.</summary>
    private static bool Unkeyed(string dedupeKey) => dedupeKey.StartsWith("file:", StringComparison.Ordinal);

    /// <summary>
    /// Record a play turned away; the same play declined again is the same row, brought up to date
    /// and to the top. Not one already in the profile, nor one deleted for good.
    /// </summary>
    public static void Record(Database db, long profileId, Decline d, double? at = null) => db.Serialized(() =>
    {
        if (Scores.WasDeleted(db, profileId, DeletedKey(d.Kind, d.DedupeKey))) return;
        var before = PathsOf(db, "profile_id = ? AND kind = ? AND dedupe_key = ?", profileId, d.Kind, d.DedupeKey);
        var table = d.Kind == "incomplete" ? "incomplete_plays" : "scores";
        if (db.Exists($"SELECT 1 AS hit FROM {table} WHERE profile_id = ? AND dedupe_key = ?", profileId, d.DedupeKey))
        {
            Forget(db, profileId, d.Kind, d.DedupeKey);
            return;
        }
        db.Run("""
            INSERT INTO declined_plays
              (profile_id, kind, dedupe_key, reason, criterion, player, source, title, title_original,
               mode, played_at, declined_at, replay_path, recording)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (profile_id, kind, dedupe_key) DO UPDATE SET
              reason = excluded.reason, criterion = excluded.criterion, player = excluded.player,
              source = excluded.source, title = excluded.title, title_original = excluded.title_original,
              mode = excluded.mode, played_at = excluded.played_at, declined_at = excluded.declined_at,
              replay_path = excluded.replay_path, recording = excluded.recording
            """,
            profileId, d.Kind, d.DedupeKey, d.Reason, d.Criterion, d.Player, d.Source, d.Title, d.TitleOriginal,
            d.Mode, d.PlayedAt, at ?? Js.Now(), d.ReplayPath, d.Recording is null ? null : JsonText.Stringify(d.Recording));
        var pruned = PathsOf(db, """
            profile_id = ? AND id NOT IN
              (SELECT id FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC LIMIT ?)
            """, profileId, profileId, MaxDeclines);
        db.Run("""
            DELETE FROM declined_plays WHERE profile_id = ? AND id NOT IN
              (SELECT id FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC LIMIT ?)
            """, profileId, profileId, MaxDeclines);
        Release(db, [.. before, .. pruned]);
    });

    /// <summary>The replay files the rows matching <paramref name="where"/> point at.</summary>
    private static List<string> PathsOf(Database db, string where, params object?[] args) =>
        [.. db.All($"SELECT replay_path FROM declined_plays WHERE {where}", r => r.IsDBNull(0) ? null : r.GetValue(0) as string, args)
            .Where(p => p is not null).Select(p => p!)];

    /// <summary>Let go of the uploaded copies these rows pointed at, once nothing else does.</summary>
    private static void Release(Database db, IEnumerable<string> paths)
    {
        foreach (var p in paths.Distinct(StringComparer.Ordinal)) UploadedReplays.Release(db, p);
    }

    /// <summary>A play is tracked after all, so it is no longer one the app turned away.</summary>
    public static void Forget(Database db, long profileId, string kind, string dedupeKey) => db.Serialized(() =>
    {
        var paths = PathsOf(db, "profile_id = ? AND kind = ? AND dedupe_key = ?", profileId, kind, dedupeKey);
        db.Run("DELETE FROM declined_plays WHERE profile_id = ? AND kind = ? AND dedupe_key = ?", profileId, kind, dedupeKey);
        Release(db, paths);
    });

    public static void ForgetById(Database db, long profileId, long id) => db.Serialized(() =>
    {
        var paths = PathsOf(db, "profile_id = ? AND id = ?", profileId, id);
        db.Run("DELETE FROM declined_plays WHERE profile_id = ? AND id = ?", profileId, id);
        Release(db, paths);
    });

    /// <summary>Empty the list without deleting anything for good: what a profile reset does.</summary>
    public static int Clear(Database db, long profileId) => db.Serialized(() =>
    {
        var paths = PathsOf(db, "profile_id = ?", profileId);
        var cleared = db.Run("DELETE FROM declined_plays WHERE profile_id = ?", profileId);
        Release(db, paths);
        return cleared;
    });

    /// <summary>
    /// Delete plays not tracked for good, the ones listed or every one: the row goes and its key is
    /// kept in <c>deleted_scores</c>. All or nothing. Returns how many were deleted.
    /// </summary>
    public static int Delete(Database db, long profileId, IReadOnlyList<double>? ids, double? now = null) => db.Serialized(() =>
    {
        List<long>? wanted = ids is null ? null : [.. ids.Where(n => double.IsFinite(n) && n == Math.Floor(n)).Select(n => (long)n).Distinct()];
        if (wanted is { Count: 0 }) return 0;
        var rows = db.Rows(
            $"SELECT id, kind, dedupe_key, replay_path FROM declined_plays WHERE profile_id = ? {(wanted is null ? "" : $"AND id IN ({string.Join(",", wanted.Select(_ => "?"))})")}",
            [profileId, .. (wanted ?? []).Cast<object?>()]);
        if (wanted is not null && rows.Count != wanted.Count) throw new InvalidOperationException("that play is not in the list any more");
        var at = now ?? Js.Now();
        db.Transaction(() =>
        {
            foreach (var r in rows)
            {
                var key = r.Str("dedupe_key")!;
                if (!Unkeyed(key)) db.Run("INSERT OR IGNORE INTO deleted_scores (profile_id, dedupe_key, deleted_at) VALUES (?, ?, ?)", profileId, DeletedKey(r.Str("kind")!, key), at);
                db.Run("DELETE FROM declined_plays WHERE id = ?", r["id"]);
            }
        });
        Release(db, rows.Select(r => r.Str("replay_path")).Where(p => p is not null).Select(p => p!));
        return rows.Count;
    });

    public static long Count(Database db, long profileId) =>
        Convert.ToInt64(db.Scalar("SELECT COUNT(*) AS n FROM declined_plays WHERE profile_id = ?", profileId));

    /// <summary>The name in the replay one decline was for, when it was turned away as another player's.</summary>
    public static string? DeclinedPlayer(Database db, long profileId, long id) =>
        db.FirstRow("SELECT player FROM declined_plays WHERE profile_id = ? AND id = ? AND reason = 'another-player'", profileId, id)?.Str("player");

    /// <summary>Every play turned away as another player's, for judging again once more names are known.</summary>
    public static List<(long Id, string? Player, string? ReplayPath, string Source)> OtherPlayerDeclines(Database db, long profileId) =>
        db.All("""
            SELECT id, player, replay_path, source FROM declined_plays
             WHERE profile_id = ? AND kind = 'score' AND reason = 'another-player'
             ORDER BY played_at, id
            """, r => (r.Long("id"), r.TextOrNull("player"), r.TextOrNull("replay_path"), r.Text("source")), profileId);

    /// <summary>The last part of a path, by either separator, as <c>split(/[\/]/).pop()</c>.</summary>
    private static string BaseName(string file) => file.Split((char)0x5C, '/')[^1];

    public static List<DeclinedPlay> List(Database db, long profileId) => db.All(
        "SELECT * FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC",
        r =>
        {
            var title = r.TextOrNull("title");
            var replayPath = r.TextOrNull("replay_path");
            return new DeclinedPlay(
                r.Long("id"), r.Text("kind"), r.Text("reason"), r.TextOrNull("criterion"), r.TextOrNull("player"),
                r.Text("source"), title, r.TextOrNull("title_original"), r.LongOrNull("mode"), r.LongOrNull("played_at"),
                r.Long("declined_at"),
                title is null && replayPath is not null ? BaseName(replayPath) : null);
        },
        profileId);
}
