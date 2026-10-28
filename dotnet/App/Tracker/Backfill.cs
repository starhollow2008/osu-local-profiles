using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tracker;

/// <summary>One replay an import would take: when it was set, in which mode, and whether it is already here or filtered.</summary>
internal sealed record BackfillCandidate(string File, double PlayedAt, int Mode, bool Duplicate, bool Filtered);

/// <summary>What a scan of osu!'s folders found, as Import past plays previews it.</summary>
internal sealed record BackfillScan(
    List<BackfillCandidate> Candidates,
    long Scanned,
    int Importable,
    int Duplicates,
    int Filtered,
    bool StarsUnchecked,
    List<OtherPlayer> OtherPlayers,
    double? Earliest,
    double? Latest);

/// <summary>Someone else's replays found by a scan, and how many.</summary>
internal sealed record OtherPlayer(string Name, int Count);

/// <summary>
/// Importing past plays: finding the replays in osu!'s folders an import would take
/// (src/tracker/backfill.ts) and the replays for scores held only as osu!'s figures
/// (src/tracker/replay-search.ts).
/// </summary>
internal static class Backfill
{
    /// <summary>The first <paramref name="n"/> bytes of a file, or null when it cannot be read.</summary>
    public static byte[]? ReadHead(string file, int n)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buf = new byte[n];
            var read = stream.ReadAtLeast(buf, n, throwOnEndOfStream: false);
            return buf[..read];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>
    /// A folder's entries in the order the system lists them, as <c>readdirSync(dir, { withFileTypes: true })</c>:
    /// a directory reached through a link is not one to descend into.
    /// </summary>
    private static List<(string Path, bool IsDirectory)> Entries(string dir)
    {
        try
        {
            return [.. new DirectoryInfo(dir).EnumerateFileSystemInfos()
                .Select(e => (NodePath.Join(dir, e.Name), e.Attributes.HasFlag(FileAttributes.Directory) && !e.Attributes.HasFlag(FileAttributes.ReparsePoint)))];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or System.Security.SecurityException)
        {
            return [];
        }
    }

    /// <summary>How many files are under a folder, for the progress bar.</summary>
    public static long CountFiles(string dir) => Entries(dir).Sum(e => e.IsDirectory ? CountFiles(e.Path) : 1);

    /// <summary>Every file under a folder with when it last changed, depth first in listing order.</summary>
    public static IEnumerable<(string Path, double MtimeMs)> Walk(string dir)
    {
        foreach (var (path, isDirectory) in Entries(dir))
        {
            if (isDirectory)
            {
                foreach (var inner in Walk(path)) yield return inner;
                continue;
            }
            double? mtime = null;
            try
            {
                FileSystemInfo info = File.Exists(path) ? new FileInfo(path) : new DirectoryInfo(path);
                if (info.Exists) mtime = (info.LastWriteTimeUtc - DateTime.UnixEpoch).TotalMilliseconds;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* vanished mid-walk */
            }
            if (mtime is { } at) yield return (path, at);
        }
    }

    /// <summary>
    /// The replays an import from <paramref name="since"/> would take, oldest first: someone else's
    /// turned away (and reported), each play once, and what is already here or filtered marked.
    /// </summary>
    public static BackfillScan ScanForReplays(Database db, long profileId, IReadOnlyList<string> dirs, double since,
        double? until = null, (BeatmapResolver Resolver, TrackingFilter Filter)? filtering = null, PlayerIdentity? owner = null,
        Action<string, ReplayScore, string>? onOtherPlayer = null, Action<long, long>? onScanned = null)
    {
        owner ??= PlayerIdentity.Unknown;
        var candidates = new List<BackfillCandidate>();
        var others = new Dictionary<string, int>(StringComparer.Ordinal);
        var otherOrder = new List<string>();
        long scanned = 0;
        var filter = filtering?.Filter;
        var applyFilter = filter is { Enabled: true };
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        var files = onScanned is not null ? dirs.Sum(CountFiles) : 0;
        onScanned?.Invoke(0, files);

        foreach (var dir in dirs)
        {
            if (!File.Exists(dir) && !Directory.Exists(dir)) continue;
            foreach (var entry in Walk(dir))
            {
                scanned++;
                onScanned?.Invoke(scanned, files);
                if (entry.MtimeMs < since) continue;

                var head = ReadHead(entry.Path, 8);
                if (head is null || !Osr.LooksLikeReplay(head)) continue;

                ReplayScore score;
                try
                {
                    score = Osr.Parse(File.ReadAllBytes(entry.Path));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    continue;
                }

                double playedAt = score.PlayedAtMs;
                if (playedAt < since || (until is { } u && playedAt > u)) continue;

                // Someone else's replay, by the name inside it and when its file was written.
                var player = Players.ReplayPlayer(score);
                if (Players.OwnsPlay(owner, player, writtenLater: Players.WasWrittenLater(score, entry.MtimeMs)) == false)
                {
                    var name = Js.Trim(player.Name) is { Length: > 0 } n ? n : "(no name)";
                    if (!others.ContainsKey(name)) otherOrder.Add(name);
                    others[name] = others.GetValueOrDefault(name) + 1;
                    onOtherPlayer?.Invoke(entry.Path, score, Js.Trim(player.Name));
                    continue;
                }

                var key = Ingest.DedupeKey(score);
                if (!seenKeys.Add(key)) continue;

                if (Scores.WasDeleted(db, profileId, key)) continue;
                var found = Existing.Find(db, profileId, Existing.ReplayIdentity(score));
                var already = db.Exists("SELECT 1 AS hit FROM scores WHERE profile_id = ? AND dedupe_key = ?", profileId, key)
                    || (found is not null && !Existing.Replaces(found, score.Built is not null ? "built" : "replay"));

                var filtered = false;
                if (applyFilter && filtering is { } f && !already)
                {
                    var beatmap = f.Resolver.Resolve(score.BeatmapMD5);
                    var facts = TrackingFilter.BeatmapFacts(db, f.Resolver, beatmap);
                    filtered = filter!.Rejects(TrackingFilter.PlayFactsOf(facts, score.Mode, Mods.ScoreMods(score, beatmap.OsuPath), score.Client)) is not null;
                }

                candidates.Add(new BackfillCandidate(entry.Path, playedAt, score.Mode, already, filtered));
            }
        }

        var sorted = candidates.OrderBy(c => c.PlayedAt).ToList();
        var importable = sorted.Where(c => !c.Duplicate && !c.Filtered).ToList();
        var byCount = otherOrder.Select(n => new OtherPlayer(n, others[n]))
            .OrderByDescending(p => p.Count)
            .ThenBy(p => p.Name, Comparer<string>.Create(Players.CompareNames))
            .ToList();
        return new BackfillScan(
            sorted,
            scanned,
            importable.Count,
            sorted.Count(c => c.Duplicate),
            sorted.Count(c => !c.Duplicate && c.Filtered),
            applyFilter && (filter!.Stars.Min > 0 || filter.Stars.Max is not null),
            byCount,
            importable.Count > 0 ? importable[0].PlayedAt : null,
            importable.Count > 0 ? importable[^1].PlayedAt : null);
    }

    /// <summary>A score held only as osu!'s figures, and the replay on this machine found for it.</summary>
    internal sealed record ReplayMatch(long RowId, string File, ReplayScore Score);

    /// <summary>How much of a replay holds its beatmap's MD5, read before the rest is.</summary>
    private const int HeadBytes = 512;

    /// <summary>
    /// The replays on this machine for scores held as osu!'s figures or built from a link, so each can
    /// take the better record's place: by the same matching an import uses, never a built replay.
    /// </summary>
    public static List<ReplayMatch> FindLocalReplays(Database db, long profileId, IReadOnlyList<string> dirs, IReadOnlyCollection<long>? only = null)
    {
        var wanted = db.Rows("""
            SELECT id, beatmap_md5, played_at FROM scores
             WHERE profile_id = ? AND (imported_at IS NOT NULL OR origin = 'link')
            """, profileId);
        if (only is not null) wanted = [.. wanted.Where(r => only.Contains((long)r.Num("id")!))];
        if (wanted.Count == 0) return [];

        var ids = wanted.Select(r => (long)r.Num("id")!).ToHashSet();
        var beatmaps = wanted.Select(r => r.Str("beatmap_md5")).ToHashSet();
        var since = wanted.Min(r => r.Num("played_at") ?? 0) - Existing.TimeToleranceMs;

        var matches = new Dictionary<long, ReplayMatch>();
        var order = new List<long>();
        foreach (var dir in dirs)
        {
            if (!File.Exists(dir) && !Directory.Exists(dir)) continue;
            foreach (var entry in Walk(dir))
            {
                if (entry.MtimeMs < since) continue;
                var head = ReadHead(entry.Path, HeadBytes);
                if (head is null || !Osr.LooksLikeReplay(head)) continue;
                try
                {
                    if (!beatmaps.Contains(Osr.ParseHeader(head).BeatmapMD5)) continue;
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    continue;
                }

                ReplayScore score;
                try
                {
                    score = Osr.Parse(File.ReadAllBytes(entry.Path));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    continue;
                }
                if (score.Built is not null) continue;
                var found = Existing.Find(db, profileId, Existing.ReplayIdentity(score));
                if (found is null || !ids.Contains(found.Id) || matches.ContainsKey(found.Id)) continue;
                if (!Existing.Replaces(found, "replay")) continue;
                matches[found.Id] = new ReplayMatch(found.Id, entry.Path, score);
                order.Add(found.Id);
                if (matches.Count == ids.Count) return [.. order.Select(id => matches[id])];
            }
        }
        return [.. order.Select(id => matches[id])];
    }
}
