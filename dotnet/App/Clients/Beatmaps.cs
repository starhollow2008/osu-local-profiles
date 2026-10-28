using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Clients;

/// <summary>A <c>.osu</c> file's <c>[Metadata]</c>, as written; deciding two names are "the same" is the reader's job.</summary>
internal sealed record OsuMetadata(
    string? Artist, string? Title, string? ArtistUnicode, string? TitleUnicode, string? Version, string? Creator,
    double? BeatmapId, double? BeatmapsetId);

/// <summary>A folder to index, and whether its beatmaps can be told apart by name (stable's <c>*.osu</c>) or must be sniffed (lazer's store).</summary>
internal sealed record IndexRoot(string Path, bool ByExtension);

/// <summary>How far the index has got: <c>counting</c> walks the folders, <c>indexing</c> does the work.</summary>
internal sealed record IndexProgress(string Phase, long Scanned, long Total, long Indexed, bool FirstRun);

/// <summary>What a status refresh changed.</summary>
internal sealed record StatusRefresh(long Beatmaps, long Scores);

/// <summary>What <c>online.db</c> knows of one beatmap.</summary>
internal sealed record OnlineBeatmap(double BeatmapId, double BeatmapsetId, double Status);

/// <summary>One difficulty of a beatmapset, as lazer's <c>online.db</c> records it.</summary>
internal sealed record OnlineSetBeatmap(object? BeatmapId, object? Md5, string? Version, object? UserId, object? Status);

/// <summary>
/// A played beatmap, resolved with no network: src/clients/beatmaps.ts's <c>ResolvedBeatmap</c>.
/// Original-language names are <c>''</c> when the file was read and carried none, so "looked and
/// found nothing" is not "never looked".
/// </summary>
internal sealed record ResolvedBeatmap(
    string Md5, string? OsuPath, object? BeatmapId, object? BeatmapsetId, object? Status,
    string? Artist, string? Title, string? ArtistUnicode, string? TitleUnicode, string? Version, string? Creator);

/// <summary>Reading <c>.osu</c> files, and the index of them: src/clients/beatmaps.ts.</summary>
internal static partial class Beatmaps
{
    private const string OsuMagic = "osu file format v";

    /// <summary>.osu files are CRLF in practice but not by rule.</summary>
    private static string[] Lines(string section) => Regex.Split(section, "\r?\n");

    /// <summary>
    /// One section of a .osu file: from its header line to the next line that begins with
    /// <c>[</c>, never the next <c>[</c> anywhere, which is ordinary inside values (<c>osuSection</c>).
    /// </summary>
    public static string? OsuSection(string text, string header)
    {
        int body;
        if (text.StartsWith(header, StringComparison.Ordinal))
        {
            body = header.Length;
        }
        else
        {
            var at = text.IndexOf("\n" + header, StringComparison.Ordinal);
            if (at < 0) return null;
            body = at + 1 + header.Length;
        }
        var next = text.IndexOf("\n[", body, StringComparison.Ordinal);
        return next < 0 ? text[body..] : text[body..next];
    }

    /// <summary>A <c>.osu</c>'s Tags and Source lines, for the filter's beatmap rules; <c>''</c> for a line it lacks.</summary>
    public static (string Tags, string Source) TagsAndSource(string text)
    {
        string tags = "", source = "";
        if (OsuSection(text, "[Metadata]") is not { } section) return (tags, source);
        foreach (var line in Lines(section))
        {
            var sep = line.IndexOf(':');
            if (sep < 0) continue;
            var key = Js.Trim(line[..sep]);
            if (key == "Tags") tags = Js.Trim(line[(sep + 1)..]);
            else if (key == "Source") source = Js.Trim(line[(sep + 1)..]);
        }
        return (tags, source);
    }

    /// <summary><c>Number(value) || null</c>.</summary>
    private static double? IdOrNull(string value)
    {
        var n = Js.StringToNumber(value);
        return double.IsNaN(n) || n == 0 ? null : n;
    }

    public static OsuMetadata ParseMetadataText(string text)
    {
        string? artist = null, title = null, artistUnicode = null, titleUnicode = null, version = null, creator = null;
        double? beatmapId = null, beatmapsetId = null;
        if (OsuSection(text, "[Metadata]") is { } section)
        {
            foreach (var line in Lines(section))
            {
                var sep = line.IndexOf(':');
                if (sep < 0) continue;
                var key = Js.Trim(line[..sep]);
                var value = Js.Trim(line[(sep + 1)..]);
                switch (key)
                {
                    case "Artist": artist = value; break;
                    case "Title": title = value; break;
                    case "ArtistUnicode": artistUnicode = value; break;
                    case "TitleUnicode": titleUnicode = value; break;
                    case "Version": version = value; break;
                    case "Creator": creator = value; break;
                    case "BeatmapID": beatmapId = IdOrNull(value); break;
                    case "BeatmapSetID": beatmapsetId = IdOrNull(value); break;
                }
            }
        }
        return new OsuMetadata(artist, title, artistUnicode, titleUnicode, version, creator, beatmapId, beatmapsetId);
    }

    public static OsuMetadata ParseMetadata(string file)
    {
        try
        {
            return ParseMetadataText(Js.ReadFileUtf8(file));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return ParseMetadataText("");
        }
    }

    /// <summary>
    /// lazer's own name for a beatmap, <c>Artist - Title (Creator) [Version]</c>, which its log writes;
    /// building the same string is an equality test. <c>''</c> when any of the four is missing.
    /// </summary>
    public static string DisplayName(string? artist, string? title, string? creator, string? version) =>
        string.IsNullOrEmpty(artist) || string.IsNullOrEmpty(title) || string.IsNullOrEmpty(creator) || string.IsNullOrEmpty(version)
            ? ""
            : $"{artist} - {title} ({creator}) [{version}]";

    /// <summary>A beatmap's mode from its <c>[General]</c> section, 0 when it cannot be read.</summary>
    public static int Mode(string file)
    {
        string text;
        try
        {
            text = Js.ReadFileUtf8(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return 0;
        }
        // [General] alone, so a `Mode:` further down the file cannot be picked up.
        if (OsuSection(text, "[General]") is not { } section) return 0;
        foreach (var line in Lines(section))
        {
            var sep = line.IndexOf(':');
            if (sep < 0) continue;
            if (Js.Trim(line[..sep]) != "Mode") continue;
            var mode = Js.StringToNumber(Js.Trim(line[(sep + 1)..]));
            return mode is 1 or 2 or 3 ? (int)mode : 0;
        }
        return 0;
    }

    /// <summary>Whether a file is a beatmap, from its first 64 bytes.</summary>
    public static bool IsBeatmapFile(string file)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var head = new byte[64];
            var read = stream.ReadAtLeast(head, 64, throwOnEndOfStream: false);
            return Encoding.Latin1.GetString(head, 0, read).Contains(OsuMagic, StringComparison.Ordinal);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>Every file under a folder, depth first; a link is yielded as a file, never followed.</summary>
    private static IEnumerable<string> Walk(string dir)
    {
        FileSystemInfo[] entries;
        try
        {
            entries = new DirectoryInfo(dir).GetFileSystemInfos();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or System.Security.SecurityException)
        {
            yield break;
        }
        foreach (var entry in entries)
        {
            var p = NodePath.Join(dir, entry.Name);
            if (entry is DirectoryInfo && !entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                foreach (var file in Walk(p)) yield return file;
            }
            else
            {
                yield return p;
            }
        }
    }

    private static bool IsOsuName(string file) => Js.ToLower(file).EndsWith(".osu", StringComparison.Ordinal);

    /// <summary>How long the indexer works before letting everything else at the database.</summary>
    private const double SliceMs = 25;

    private static string Md5Hex(byte[] contents) => Convert.ToHexStringLower(MD5.HashData(contents));

    /// <summary>
    /// Build, or top up, the MD5-to-path index of local <c>.osu</c> files. Store files are
    /// content-addressed, so anything indexed is never read again; rows from before ids and names
    /// were kept are read once more to fill them in. Worked in slices, each committed before the
    /// pause so a transaction never spans one, and files gone from disk are pruned, but only under a
    /// root that yielded something (an unplugged drive must not cost its whole index).
    /// </summary>
    public static (long Scanned, long Indexed, long Removed) IndexFiles(Database db, IReadOnlyList<IndexRoot> roots, Action<IndexProgress>? onProgress = null)
    {
        var known = new HashSet<string>(StringComparer.Ordinal);
        var backfill = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in db.Rows("SELECT path, beatmap_id, name FROM osu_files"))
        {
            var path = r.Text("path");
            known.Add(path);
            if (r["beatmap_id"] is null || r["name"] is null) backfill.Add(path);
        }
        var firstRun = known.Count == 0;
        foreach (var path in db.All("SELECT path FROM not_beatmaps", r => r.GetString(0))) known.Add(path);

        string phase = "counting";
        long scanned = 0, total = 0, indexed = 0, removed = 0;
        var yielded = new long[roots.Count];
        IEnumerable<string> Candidates()
        {
            Array.Clear(yielded);
            for (var i = 0; i < roots.Count; i++)
            {
                foreach (var file in Walk(roots[i].Path))
                {
                    if (roots[i].ByExtension && !IsOsuName(file)) continue;
                    yielded[i]++;
                    yield return file;
                }
            }
        }

        var slice = Stopwatch.StartNew();
        var inTransaction = false;
        // Held for a whole slice, so the transaction it opens has nobody else's statements in it.
        var held = db.Hold();
        void PauseIfDue()
        {
            if (slice.Elapsed.TotalMilliseconds < SliceMs) return;
            if (inTransaction)
            {
                db.Exec("COMMIT");
                inTransaction = false;
            }
            onProgress?.Invoke(new IndexProgress(phase, scanned, total, indexed, firstRun));
            // The pause: let the page and the tracker at the connection.
            held.Dispose();
            Thread.Sleep(1);
            held = db.Hold();
            slice.Restart();
        }
        void Write(string sql, params object?[] values)
        {
            if (!inTransaction)
            {
                db.Exec("BEGIN");
                inTransaction = true;
            }
            db.Run(sql, values);
        }

        try
        {
            foreach (var _ in Candidates())
            {
                total++;
                PauseIfDue();
            }

            phase = "indexing";
            foreach (var file in Candidates())
            {
                scanned++;
                var wasKnown = known.Remove(file);
                if (!wasKnown || backfill.Contains(file))
                {
                    long size = -1;
                    try
                    {
                        size = new FileInfo(file).Length;
                    }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                    {
                        /* gone since it was listed */
                    }
                    if (!File.Exists(file)) size = -1;
                    if (size >= 0 && !IsBeatmapFile(file))
                    {
                        Write("INSERT OR REPLACE INTO not_beatmaps (path, size) VALUES (?, ?)", file, size);
                    }
                    else if (size >= 0)
                    {
                        try
                        {
                            var contents = File.ReadAllBytes(file);
                            var meta = ParseMetadataText(Encoding.UTF8.GetString(contents));
                            Write("INSERT OR REPLACE INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                                file, Md5Hex(contents), meta.BeatmapId ?? 0, DisplayName(meta.Artist, meta.Title, meta.Creator, meta.Version), size, Js.Now());
                            indexed++;
                        }
                        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                        {
                            /* unreadable, skip */
                        }
                    }
                }
                PauseIfDue();
            }

            var pruned = roots.Where((_, i) => yielded[i] > 0).Select(root => NodePath.Join(root.Path, Path.DirectorySeparatorChar.ToString())).ToList();
            foreach (var gone in known)
            {
                if (!pruned.Any(prefix => gone.StartsWith(prefix, StringComparison.Ordinal))) continue;
                Write("DELETE FROM osu_files WHERE path = ?", gone);
                Write("DELETE FROM not_beatmaps WHERE path = ?", gone);
                // A played beatmap cached with this file must look again: another copy may be indexed.
                Write("UPDATE beatmaps SET osu_path = NULL WHERE osu_path = ?", gone);
                removed++;
                PauseIfDue();
            }
            if (inTransaction) db.Exec("COMMIT");
        }
        catch
        {
            if (inTransaction) db.Exec("ROLLBACK");
            throw;
        }
        finally
        {
            held.Dispose();
        }
        // A folder can change while it is walked; the bar ends full either way.
        onProgress?.Invoke(new IndexProgress(phase, scanned, scanned, indexed, firstRun));
        return (scanned, indexed, removed);
    }

    /// <summary>Add one newly seen file to the index (the watcher's).</summary>
    public static void IndexOneFile(Database db, string file)
    {
        try
        {
            if (!IsBeatmapFile(file)) return;
            var contents = File.ReadAllBytes(file);
            var meta = ParseMetadataText(Encoding.UTF8.GetString(contents));
            db.Run("INSERT OR REPLACE INTO osu_files (path, md5, beatmap_id, name, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                file, Md5Hex(contents), meta.BeatmapId ?? 0, DisplayName(meta.Artist, meta.Title, meta.Creator, meta.Version), new FileInfo(file).Length, Js.Now());
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            /* ignore */
        }
    }

    private const string OnlineStampKey = "onlineDbStamp";

    /// <summary>
    /// Bring every played beatmap's ranked status up to date with lazer's <c>online.db</c> when that
    /// snapshot has changed since the last look: status, id, set, and the scores on it, in one
    /// transaction. Imported scores are left as osu! reported them. Null with no change to make.
    /// </summary>
    public static StatusRefresh? RefreshStatuses(Database db, BeatmapResolver resolver) => db.Serialized(() =>
    {
        var stamp = resolver.OnlineStamp();
        if (stamp is null) return null;
        var seen = db.Get("SELECT value FROM kv WHERE key = ?", r => r.GetString(0), OnlineStampKey);
        if (seen == stamp) return null;

        var rows = db.Rows("SELECT md5, beatmap_id, beatmapset_id, status, ranked_at FROM beatmaps");
        var online = resolver.OnlineBeatmaps([.. rows.Select(r => r.Text("md5"))]);
        long beatmaps = 0, scores = 0;
        db.Transaction(() =>
        {
            foreach (var row in rows)
            {
                if (!online.TryGetValue(row.Text("md5"), out var now)) continue;
                var unchanged = now.Status == row.Num("status") && now.BeatmapId == row.Num("beatmap_id")
                    && now.BeatmapsetId == row.Num("beatmapset_id")
                    // 0 is "looked, and online.db could not say": worth asking again now that it has the map.
                    && !(row.Num("ranked_at") == 0);
                if (unchanged) continue;
                db.Run("UPDATE beatmaps SET status = ?, beatmap_id = ?, beatmapset_id = ?, submitted_at = NULL, ranked_at = NULL WHERE md5 = ?",
                    now.Status, now.BeatmapId, now.BeatmapsetId, row.Text("md5"));
                var ranked = Status.AwardsPp((int?)now.Status) ? 1 : 0;
                scores += db.Run("""
                    UPDATE scores SET map_status = ?, ranked = CASE WHEN ? = 1 AND mods_ranked = 1 THEN 1 ELSE 0 END
                     WHERE beatmap_md5 = ? AND imported_at IS NULL AND (map_status IS NOT ? OR ranked IS NOT
                           (CASE WHEN ? = 1 AND mods_ranked = 1 THEN 1 ELSE 0 END))
                    """, now.Status, ranked, row.Text("md5"), now.Status, ranked);
                beatmaps++;
            }
            db.Run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", OnlineStampKey, stamp);
        });
        return new StatusRefresh(beatmaps, scores);
    });

    /// <summary>
    /// Fill in the original-language artist and title for beatmaps cached before those columns
    /// existed, <c>''</c> where a file has none or cannot be read so it is never read twice.
    /// </summary>
    public static long BackfillOriginalMetadata(Database db)
    {
        var rows = db.Rows("SELECT md5, osu_path FROM beatmaps WHERE title_unicode IS NULL OR artist_unicode IS NULL");
        long filled = 0;
        foreach (var row in rows)
        {
            var meta = row.Str("osu_path") is { } path ? ParseMetadata(path) : null;
            db.Run("UPDATE beatmaps SET artist_unicode = ?, title_unicode = ? WHERE md5 = ?", meta?.ArtistUnicode ?? "", meta?.TitleUnicode ?? "", row.Text("md5"));
            filled++;
        }
        return filled;
    }
}

/// <summary>
/// Resolves a beatmap MD5 with no network: the local <c>.osu</c> index, lazer's <c>online.db</c>,
/// then the <c>.osu</c>'s own metadata (src/clients/beatmaps.ts, <c>BeatmapResolver</c>).
/// </summary>
internal sealed partial class BeatmapResolver
{
    private readonly List<string> onlineDbPaths = [];
    private readonly Database db;

    /// <summary>Whether anything here can say if a beatmap is ranked: only lazer ships <c>online.db</c>.</summary>
    public bool KnowsStatus => onlineDbPaths.Count > 0;

    public BeatmapResolver(Database db, IEnumerable<OsuInstall> installs)
    {
        this.db = db;
        foreach (var install in installs)
        {
            if (install.OnlineDb is null) continue;
            // Opened once to prove it is a database this can read, and closed again: see FromOnline.
            using var handle = Database.OpenReadOnly(install.OnlineDb);
            if (handle is null) continue;
            onlineDbPaths.Add(install.OnlineDb);
        }
    }

    /// <summary>
    /// Ask each <c>online.db</c> in turn, opened for this piece of work and closed straight after,
    /// until one answers. Never held open: lazer cannot rewrite the file while another process has it.
    /// </summary>
    private T? FromOnline<T>(Func<Database, T?> lookup) where T : class
    {
        foreach (var file in onlineDbPaths)
        {
            using var online = Database.OpenReadOnly(file);
            if (online is null) continue;
            try
            {
                if (lookup(online) is { } answer) return answer;
            }
            catch (Microsoft.Data.Sqlite.SqliteException)
            {
                /* being rewritten by lazer, or an older online.db without this table */
            }
        }
        return null;
    }

    /// <summary>When each <c>online.db</c> was last written: what says the snapshot changed.</summary>
    public string? OnlineStamp()
    {
        if (onlineDbPaths.Count == 0) return null;
        return string.Join("|", onlineDbPaths.Select(file =>
        {
            try
            {
                var info = new FileInfo(file);
                if (!info.Exists) return $"{file}@missing";
                // fs.statSync's mtimeMs: milliseconds, with the sub-millisecond part.
                var ms = (info.LastWriteTimeUtc - DateTime.UnixEpoch).Ticks / 10_000.0;
                return $"{file}@{Js.NumberToString(ms)}";
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                return $"{file}@missing";
            }
        }));
    }

    /// <summary>What <c>online.db</c> says about each of these beatmaps, from one opening of each file.</summary>
    public Dictionary<string, OnlineBeatmap> OnlineBeatmaps(IReadOnlyList<string> md5s)
    {
        var found = new Dictionary<string, OnlineBeatmap>(StringComparer.Ordinal);
        foreach (var file in onlineDbPaths)
        {
            using var online = Database.OpenReadOnly(file);
            if (online is null) continue;
            try
            {
                foreach (var md5 in md5s)
                {
                    if (found.ContainsKey(md5)) continue;
                    var row = online.FirstRow("SELECT beatmap_id, beatmapset_id, approved FROM osu_beatmaps WHERE checksum = ?", md5);
                    if (row is not null) found[md5] = new OnlineBeatmap(row.Num("beatmap_id") ?? double.NaN, row.Num("beatmapset_id") ?? double.NaN, row.Num("approved") ?? double.NaN);
                }
            }
            catch (Microsoft.Data.Sqlite.SqliteException)
            {
                /* being rewritten by lazer: whatever it found so far stands */
            }
        }
        return found;
    }

    /// <summary>
    /// The MD5 of an online beatmap id: a cached map, then <c>online.db</c>, then local files by
    /// their <c>BeatmapID</c>, refusing an ambiguous answer (an edited copy keeps its id).
    /// </summary>
    public string? Md5ForBeatmapId(double beatmapId)
    {
        if (beatmapId <= 0) return null;
        if (db.Get("SELECT md5 FROM beatmaps WHERE beatmap_id = ? LIMIT 1", r => r.GetString(0), beatmapId) is { } cached) return cached;

        var online = FromOnline(o => o.FirstRow("SELECT checksum FROM osu_beatmaps WHERE beatmap_id = ?", beatmapId)?.Str("checksum") is { Length: > 0 } c ? c : null);
        if (online is not null) return online;

        var local = db.Rows("""
            SELECT f.md5, EXISTS(SELECT 1 FROM beatmaps b WHERE b.md5 = f.md5) AS cached
              FROM osu_files f
             WHERE f.beatmap_id = ?
             GROUP BY f.md5
             ORDER BY cached DESC
            """, beatmapId);
        if (local.Count == 1 || (local.Count > 0 && local[0].Is1("cached") && !(local.Count > 1 && local[1].Is1("cached"))))
        {
            return local[0].Text("md5");
        }
        return null;
    }

    /// <summary>
    /// The MD5 of a beatmap named as lazer's log names it: a played beatmap first, then every local
    /// file by the name the index built. A name shared by two files resolves to neither.
    /// </summary>
    public string? Md5ForBeatmapName(string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        var cached = db.All("""
            SELECT DISTINCT md5 FROM beatmaps
             WHERE artist IS NOT NULL AND title IS NOT NULL
                   AND creator IS NOT NULL AND version IS NOT NULL
                   AND artist || ' - ' || title || ' (' || creator || ') [' || version || ']' = ?
             LIMIT 2
            """, r => r.GetString(0), name);
        if (cached.Count == 1) return cached[0];
        if (cached.Count > 1) return null;
        var local = db.All("SELECT DISTINCT md5 FROM osu_files WHERE name = ? LIMIT 2", r => r.GetString(0), name);
        return local.Count == 1 ? local[0] : null;
    }

    /// <summary><c>online.db</c>'s <c>2007-10-06 17:46:31+00:00</c> as epoch milliseconds, the space made a <c>T</c>.</summary>
    private static double? ParseOnlineDate(object? value)
    {
        if (value is not string { Length: > 0 } text) return null;
        var at = Js.DateParse(ReplaceFirst(text, " ", "T"));
        return double.IsFinite(at) ? at : null;
    }

    private static string ReplaceFirst(string text, string from, string to)
    {
        var i = text.IndexOf(from, StringComparison.Ordinal);
        return i < 0 ? text : text[..i] + to + text[(i + from.Length)..];
    }

    /// <summary>A set's submission and ranked dates, or null when <c>online.db</c> has no row for it.</summary>
    public (double? SubmittedAt, double? RankedAt)? BeatmapsetDates(double beatmapsetId)
    {
        var row = FromOnline(o => o.FirstRow("SELECT submit_date, approved_date FROM osu_beatmapsets WHERE beatmapset_id = ?", beatmapsetId));
        return row is null ? null : (ParseOnlineDate(row["submit_date"]), ParseOnlineDate(row["approved_date"]));
    }

    /// <summary>Who mapped a difficulty, by osu!'s record (guests and collabs included, under current names), or null.</summary>
    public List<string>? BeatmapMappers(double beatmapId) => FromOnline(o =>
    {
        var names = o.All("""
            SELECT u.username FROM beatmap_owners o
              LEFT JOIN users u ON u.user_id = o.user_id
             WHERE o.beatmap_id = ?
            """, r => r.IsDBNull(0) ? null : r.GetValue(0) as string, beatmapId)
            .Where(n => !string.IsNullOrEmpty(n)).Select(n => n!).ToList();
        return names.Count > 0 ? names : null;
    });

    [GeneratedRegex(@"\[([^\]]*)\]\.osu\z", RegexOptions.IgnoreCase)]
    private static partial Regex FilenameVersion();

    /// <summary>Every difficulty of a set <c>online.db</c> knows, for a favourite card built without a network.</summary>
    public List<OnlineSetBeatmap> BeatmapsInSet(double beatmapsetId) => FromOnline(o =>
    {
        var rows = o.Rows("SELECT beatmap_id, checksum, filename, user_id, approved FROM osu_beatmaps WHERE beatmapset_id = ?", beatmapsetId);
        if (rows.Count == 0) return null;
        return rows.Select(r =>
        {
            var m = FilenameVersion().Match(r.Str("filename") ?? "");
            return new OnlineSetBeatmap(r["beatmap_id"], r["checksum"], m.Success ? m.Groups[1].Value : null, r["user_id"], r["approved"]);
        }).ToList();
    }) ?? [];

    /// <summary>A mapper's username from <c>online.db</c>'s <c>users</c>, or null.</summary>
    public string? Username(double userId) =>
        FromOnline(o => o.FirstRow("SELECT username FROM users WHERE user_id = ?", userId)?.Str("username") is { Length: > 0 } n ? n : null);

    /// <summary>Asked before a beatmap is given up as having no local file, so whatever just arrived can be indexed first.</summary>
    public Action? OnMiss { get; set; }

    private string? LocalFile(string md5)
    {
        string? Find() => db.Get("SELECT path FROM osu_files WHERE md5 = ? LIMIT 1", r => r.GetString(0), md5);
        var found = Find();
        if (found is not null || OnMiss is null) return found;
        OnMiss();
        return Find();
    }

    /// <summary>
    /// A beatmap, from the cache or resolved and cached now. A cached miss is looked up again, so a
    /// map downloaded mid-session resolves properly the moment its file is indexed.
    /// </summary>
    public ResolvedBeatmap Resolve(string md5) => db.Serialized(() =>
    {
        var cached = db.FirstRow("SELECT * FROM beatmaps WHERE md5 = ?", md5);
        var osuPath = cached is not null && cached["osu_path"] is string p ? p : LocalFile(md5);
        if (cached is not null && (cached["osu_path"] is not null || osuPath is null))
        {
            return new ResolvedBeatmap(md5, cached.Str("osu_path"), cached["beatmap_id"], cached["beatmapset_id"], cached["status"],
                cached.Str("artist"), cached.Str("title"), cached.Str("artist_unicode"), cached.Str("title_unicode"), cached.Str("version"), cached.Str("creator"));
        }

        object? beatmapId = null, beatmapsetId = null, status = null;
        string? artist = null, title = null, artistUnicode = null, titleUnicode = null, version = null, creator = null;
        // online.db is authoritative for id and ranked status.
        if (OnlineBeatmaps([md5]).TryGetValue(md5, out var online))
        {
            beatmapId = online.BeatmapId;
            beatmapsetId = online.BeatmapsetId;
            status = online.Status;
        }
        // The .osu fills in titles, and ids for maps online.db does not know about.
        if (!string.IsNullOrEmpty(osuPath))
        {
            var meta = Beatmaps.ParseMetadata(osuPath);
            artist = meta.Artist;
            title = meta.Title;
            artistUnicode = meta.ArtistUnicode ?? "";
            titleUnicode = meta.TitleUnicode ?? "";
            version = meta.Version;
            creator = meta.Creator;
            beatmapId ??= meta.BeatmapId;
            beatmapsetId ??= meta.BeatmapsetId;
        }

        db.Run("""
            INSERT OR REPLACE INTO beatmaps
            (md5, beatmap_id, beatmapset_id, artist, title, artist_unicode, title_unicode,
             version, creator, status, osu_path, cached_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, md5, beatmapId, beatmapsetId, artist, title, artistUnicode, titleUnicode, version, creator, status, osuPath, Js.Now());

        return new ResolvedBeatmap(md5, osuPath, beatmapId, beatmapsetId, status, artist, title, artistUnicode, titleUnicode, version, creator);
    });
}
