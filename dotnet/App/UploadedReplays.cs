using System.Security.Cryptography;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles;

/// <summary>
/// Replay files the user chose or dropped into Import past plays, kept in <c>data/replays/</c> by
/// the MD5 of their bytes, so a score can point at the copy for good: src/uploaded-replays.ts.
/// </summary>
internal static partial class UploadedReplays
{
    public const string Dir = "replays";

    /// <summary>Far above any real replay, and a bound all the same.</summary>
    public const int MaxReplayBytes = 64 * 1024 * 1024;

    [GeneratedRegex(@"\Areplays/[0-9a-f]{32}\.osr\z")]
    private static partial Regex UploadedRelative();

    [GeneratedRegex(@"[\\/]replays[\\/][0-9a-f]{32}\.osr\z")]
    private static partial Regex UploadedPath();

    [GeneratedRegex(@"\A[0-9a-f]{32}\.osr\z")]
    private static partial Regex UploadedName();

    /// <summary>A stored replay's path relative to <c>data/</c>, as a backup lists it.</summary>
    public static bool IsUploadedReplay(string relative) => UploadedRelative().IsMatch(relative);

    /// <summary>Keep a copy of an uploaded replay, or null when the bytes are not one.</summary>
    public static string? Store(string dataDir, byte[] bytes)
    {
        if (!Osr.LooksLikeReplay(bytes.AsSpan(0, Math.Min(8, bytes.Length)))) return null;
        var dir = NodePath.Join(dataDir, Dir);
        Directory.CreateDirectory(dir);
        var file = NodePath.Join(dir, $"{Convert.ToHexStringLower(MD5.HashData(bytes))}.osr");
        if (!File.Exists(file)) File.WriteAllBytes(file, bytes);
        return file;
    }

    /// <summary>
    /// Remove a stored copy nothing points at any more. Only ever one of this app's own copies:
    /// osu!stable's and lazer's file names cannot match, whatever a caller hands in.
    /// </summary>
    public static void Release(Database db, string? file)
    {
        if (file is null || !UploadedPath().IsMatch(file)) return;
        var used = db.Exists("""
            SELECT 1 AS hit FROM scores WHERE replay_path = ?
            UNION ALL SELECT 1 FROM declined_plays WHERE replay_path = ? LIMIT 1
            """, file, file);
        if (used) return;
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            /* in use elsewhere; harmless to leave */
        }
    }

    /// <summary>Every stored copy nothing points at any more, removed: at launch, when nothing is mid-import.</summary>
    public static int Prune(Database db, string dataDir)
    {
        var dir = NodePath.Join(dataDir, Dir);
        string[] names;
        try
        {
            names = [.. Directory.EnumerateFileSystemEntries(dir).Select(p => Path.GetFileName(p))];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
        var removed = 0;
        foreach (var name in names)
        {
            if (!UploadedName().IsMatch(name)) continue;
            var file = NodePath.Join(dir, name);
            Release(db, file);
            if (!File.Exists(file) && !Directory.Exists(file)) removed++;
        }
        return removed;
    }
}
