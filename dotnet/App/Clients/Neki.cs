using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// One play in neki's <c>neki.recent.json</c>: every play it ended, passes, fails and quits alike,
/// as neki wrote it. <c>PlayedAt</c> is the same moment its replay records, to the millisecond.
/// </summary>
internal sealed record NekiRecentPlay(
    string BeatmapMD5,
    double PlayedAt,
    int Mode,
    bool Passed,
    bool Quit,
    double EndTime,
    double Rate,
    string? Name);

/// <summary>
/// neki, a closed-source client that plays like osu!stable (roadmap 5.83). It plays from a stable
/// folder and writes its replays into that folder's <c>Data\r</c>; what says a replay there is
/// neki's is its own files, read here.
/// </summary>
internal static partial class Neki
{
    /// <summary>What neki writes as <c>client_version</c> in the lazer block of a replay with its extra mods.</summary>
    public const string ClientVersion = "neki";

    private static bool Exists(string p) => File.Exists(p) || Directory.Exists(p);

    /// <summary>Where neki's installer puts it.</summary>
    public static List<string> Candidates(DetectEnvironment e) =>
        e["LOCALAPPDATA"] is { Length: > 0 } local ? [NodePath.Join(local, "Programs", "neki")] : [];

    public static bool IsNekiRoot(string root) =>
        Exists(NodePath.Join(root, "neki.exe")) && Exists(NodePath.Join(root, "neki.ini"));

    [GeneratedRegex(@"^[ \t﻿]*OsuFolder[ \t]*=[ \t]*(.+?)[ \t]*\z", RegexOptions.IgnoreCase)]
    private static partial Regex OsuFolderLine();

    /// <summary>The osu!stable folder neki plays from: <c>OsuFolder</c> in its <c>neki.ini</c>.</summary>
    public static string? OsuFolder(string root)
    {
        if (ReadShared(NodePath.Join(root, "neki.ini")) is not { } ini) return null;
        return NodePath.FirstMatch(System.Text.Encoding.UTF8.GetString(ini), OsuFolderLine()) is { Length: > 0 } folder ? folder : null;
    }

    /// <summary>
    /// A neki install: its replays and beatmaps are the stable folder's it plays from. That folder
    /// need not hold osu!stable itself, only what neki reads and writes there.
    /// </summary>
    public static OsuInstall? Install(string root)
    {
        if (!IsNekiRoot(root)) return null;
        var folder = OsuFolder(root);
        if (folder is null) return new OsuInstall("neki", root, NodePath.Join(root, "Data", "r"), [], null);
        if (Detect.StableInstall(folder) is { } stable) return stable with { Kind = "neki", Root = root };
        var songs = NodePath.Join(folder, "Songs");
        return new OsuInstall("neki", root, NodePath.Join(folder, "Data", "r"), Exists(songs) ? [songs] : [], null);
    }

    public static string RecentFile(string root) => NodePath.Join(root, "data", "stats", "neki.recent.json");

    public static string ScoresFile(string root) => NodePath.Join(root, "data", "databases", "scores.neki.db");

    /// <summary>A file neki may be writing at that moment: read, never locked, or null.</summary>
    private static byte[]? ReadShared(string file)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream();
            stream.CopyTo(copy);
            return copy.ToArray();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// <c>neki.recent.json</c>, every entry that says what it needs to. A file caught mid-write, or
    /// anything else that is not a list, is nothing.
    /// </summary>
    public static List<NekiRecentPlay> ParseRecent(string json)
    {
        if (!JsonText.TryParse(json, out var parsed) || parsed.ValueKind != JsonValueKind.Array) return [];
        var output = new List<NekiRecentPlay>();
        foreach (var entry in parsed.EnumerateArray())
        {
            if (!Js.IsString(Js.Get(entry, "hash"), out var hash) || hash.Length != 32) continue;
            if (!Js.IsString(Js.Get(entry, "time"), out var time) || TimeMs(time) is not { } at) continue;
            double Number(string key, double fallback) =>
                Js.Get(entry, key) is { ValueKind: JsonValueKind.Number } n ? Js.NumberOf(n) : fallback;
            var mods = (int)Number("mods", 0);
            // A rate is written only when neki's own rate setting was used; DT and HT alone are osu!'s.
            var rate = Number("rate", (mods & (1 << 6 | 1 << 9)) != 0 ? 1.5 : (mods & (1 << 8)) != 0 ? 0.75 : 1);
            output.Add(new NekiRecentPlay(
                Js.ToLower(hash), at, (int)Number("mode", 0),
                Js.Get(entry, "passed") is { ValueKind: JsonValueKind.True },
                Js.Get(entry, "quit") is { ValueKind: JsonValueKind.True },
                Number("end_time", 0), rate > 0 ? rate : 1,
                Js.IsString(Js.Get(entry, "profile"), out var name) && name.Length > 0 ? name : null));
        }
        return output;
    }

    /// <summary>
    /// neki's time for a play, to the millisecond as a replay counts it: .NET ticks, truncated.
    /// </summary>
    private static double? TimeMs(string text)
    {
        if (!DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal, out var at)) return null;
        return (at.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10_000;
    }

    /// <summary>
    /// The replay hashes in a <c>scores.db</c> in osu!stable's format: stable's own, or neki's
    /// <c>scores.neki.db</c>, where a play with extra mods carries lazer's block after its entry.
    /// A file cut short gives what was read before it.
    /// </summary>
    public static HashSet<string> ScoreReplayHashes(byte[] buf)
    {
        var output = new HashSet<string>(StringComparer.Ordinal);
        var o = 0;
        bool Take(int n)
        {
            if (n < 0 || o + n > buf.Length) return false;
            o += n;
            return true;
        }
        int? Int()
        {
            if (o + 4 > buf.Length) return null;
            var v = BitConverter.ToInt32(buf, o);
            o += 4;
            return v;
        }
        // osu!'s strings: 0x0b, a ULEB128 length, then UTF-8. 0x00 is no string.
        bool String(out string? s)
        {
            s = null;
            if (o >= buf.Length) return false;
            if (buf[o++] != 0x0b) return true;
            int len = 0, shift = 0;
            while (true)
            {
                if (o >= buf.Length || shift > 28) return false;
                var octet = buf[o++];
                len |= (octet & 0x7f) << shift;
                shift += 7;
                if ((octet & 0x80) == 0) break;
            }
            if (len < 0 || o + len > buf.Length) return false;
            s = System.Text.Encoding.UTF8.GetString(buf, o, len);
            o += len;
            return true;
        }

        if (Int() is null || Int() is not { } beatmaps) return output;
        for (var m = 0; m < beatmaps; m++)
        {
            if (!String(out _) || Int() is not { } scores) return output;
            for (var s = 0; s < scores; s++)
            {
                if (!Take(1) || Int() is not { } version) return output;
                if (!String(out _) || !String(out _) || !String(out var replay)) return output;
                // Six counters, the total, the combo and whether it was perfect.
                if (!Take(2 * 6 + 4 + 2 + 1) || Int() is not { } mods) return output;
                // The life bar, the date, a -1, and the online id.
                if (!String(out _) || !Take(8 + 4 + 8)) return output;
                // Target Practice's extra accuracy.
                if ((mods & (1 << 23)) != 0 && !Take(8)) return output;
                if (version >= Osr.LazerExtMinVersion && (Int() is not { } block || !Take(block))) return output;
                if (replay is { Length: > 0 }) output.Add(Js.ToLower(replay));
            }
        }
        return output;
    }

    /// <summary>Whether a replay's lazer block says neki wrote it.</summary>
    public static bool WroteBlock(JsonElement? extras) =>
        Js.IsString(Js.Get(extras, "client_version"), out var client) && client == ClientVersion;
}

/// <summary>
/// Which plays in a stable folder's <c>Data\r</c> are neki's, from neki's own files: a play it lists
/// in <c>neki.recent.json</c> at that moment, or one its <c>scores.neki.db</c> holds and stable's own
/// <c>scores.db</c> does not (neki copies stable's in). Each file is read again only when it changes.
/// </summary>
internal sealed class NekiPlays(IReadOnlyList<OsuInstall> installs)
{
    private readonly object gate = new();
    private readonly Dictionary<string, (DateTime Written, long Length, object Value)> cache = new(StringComparer.Ordinal);

    public static readonly NekiPlays None = new([]);

    private T Read<T>(string file, Func<byte[], T> parse, T missing) where T : class
    {
        FileInfo info;
        try
        {
            info = new FileInfo(file);
            if (!info.Exists) return missing;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return missing;
        }
        lock (gate)
        {
            if (cache.TryGetValue(file, out var hit) && hit.Written == info.LastWriteTimeUtc && hit.Length == info.Length) return (T)hit.Value;
        }
        byte[] bytes;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream();
            stream.CopyTo(copy);
            bytes = copy.ToArray();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return missing;
        }
        var value = parse(bytes);
        lock (gate) cache[file] = (info.LastWriteTimeUtc, info.Length, value);
        return value;
    }

    public List<NekiRecentPlay> Recent(OsuInstall neki) =>
        Read(Neki.RecentFile(neki.Root), b => Neki.ParseRecent(System.Text.Encoding.UTF8.GetString(b)), new List<NekiRecentPlay>());

    private HashSet<string> Hashes(string file) => Read(file, Neki.ScoreReplayHashes, new HashSet<string>());

    /// <summary>Is this replay, found in a stable folder, one neki wrote?</summary>
    public bool Claims(ReplayScore score)
    {
        if (score.Client == "neki") return true;
        if (score.Client != "stable") return false;
        foreach (var neki in installs.Where(i => i.Kind == "neki"))
        {
            if (Recent(neki).Any(p => p.BeatmapMD5 == Js.ToLower(score.BeatmapMD5) && Math.Abs(p.PlayedAt - score.PlayedAtMs) <= 1)) return true;
            if (score.ReplayMD5 is not { Length: > 0 } replay) continue;
            var hash = Js.ToLower(replay);
            if (!Hashes(Neki.ScoresFile(neki.Root)).Contains(hash)) continue;
            // neki copies stable's own scores in: those are stable's.
            var stableScores = NodePath.Join(NodePath.Dirname(NodePath.Dirname(neki.ReplayDir)), "scores.db");
            if (!Hashes(stableScores).Contains(hash)) return true;
        }
        return false;
    }
}
