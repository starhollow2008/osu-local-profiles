using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>What a backup holds: each profile with its play count, and the files that came with it.</summary>
internal sealed record BackupSummary(List<BackupProfile> Profiles, int Images);

internal sealed record BackupProfile(string Name, double Plays);

/// <summary>What starting the app made of a backup waiting to be restored.</summary>
internal sealed record RestoreResult(bool Applied, string? Aside = null, string? Error = null);

/// <summary>
/// Backing up every profile, and restoring a backup: src/backup.ts. A backup is <c>data/</c> as far
/// as the profiles go, under the names they have there, config.json left out (it is this install's).
/// A restore is staged, then applied at the next start, never under a running app, and what it
/// replaces is moved aside, never deleted.
/// </summary>
internal static partial class Backup
{
    public const string DbFile = "profiles.db";
    private const string RestoreDir = "restore";
    private const string Staged = "files";
    private const string Ready = "ready";
    private const string AsidePrefix = "before-restore-";

    /// <summary>SQLite's own header, for a bare <c>.db</c> backup from before backups were zips.</summary>
    private static readonly byte[] SqliteMagic = "SQLite format 3\0"u8.ToArray();
    private static readonly byte[] ZipMagic = [0x50, 0x4b, 0x03, 0x04];

    [GeneratedRegex(@"^profile-[0-9]+-(avatar|cover)\.(png|jpe?g|webp|gif)\z", RegexOptions.IgnoreCase)]
    private static partial Regex ProfilePicture();

    [GeneratedRegex(@"^(avatar|cover)\.(png|jpe?g|webp)\z", RegexOptions.IgnoreCase)]
    private static partial Regex LegacyPicture();

    [GeneratedRegex(@"^about-images/[0-9]+/[A-Za-z0-9_.-]+\z")]
    private static partial Regex AboutImage();

    [GeneratedRegex(@"^beatmaps/[0-9a-f]{32}\.osu\z")]
    private static partial Regex StoredBeatmap();

    /// <summary>
    /// Whether a path relative to <c>data/</c> is profile data, and so goes into a backup and comes
    /// out of one. Anything else in an archive is ignored, so a restore can only write these names.
    /// </summary>
    public static bool IsProfileFile(string relative) =>
        relative == DbFile
        || ProfilePicture().IsMatch(relative)
        || LegacyPicture().IsMatch(relative)
        || AboutImage().IsMatch(relative)
        || UploadedReplays.IsUploadedReplay(relative)
        || StoredBeatmap().IsMatch(relative);

    /// <summary>Every file under <paramref name="dir"/>, relative to it, with forward slashes.</summary>
    private static List<string> FilesUnder(string dir, string prefix = "")
    {
        IEnumerable<FileSystemInfo> entries;
        try
        {
            entries = [.. new DirectoryInfo(prefix == "" ? dir : NodePath.Join(dir, prefix)).EnumerateFileSystemInfos()];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
        return [.. entries.SelectMany(entry =>
        {
            var relative = prefix == "" ? entry.Name : $"{prefix}/{entry.Name}";
            return entry is DirectoryInfo ? FilesUnder(dir, relative) : [relative];
        })];
    }

    /// <summary>The profile data in <c>data/</c> that is not the database: pictures, me! images, uploads, downloaded beatmaps.</summary>
    private static List<string> ProfileFiles(string dataDir)
    {
        var top = FilesUnder(dataDir).Where(f => !f.Contains('/'));
        return [.. top.Concat(FilesUnder(dataDir, "about-images")).Concat(FilesUnder(dataDir, UploadedReplays.Dir)).Concat(FilesUnder(dataDir, StoredBeatmaps.Dir))
            .Where(f => f != DbFile && IsProfileFile(f))];
    }

    private static string Pad(int n) => n.ToString("00", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>The local calendar day, <c>2026-09-23</c>: what a file saved today is named by.</summary>
    public static string LocalDay(DateTime local) => $"{local.Year}-{Pad(local.Month)}-{Pad(local.Day)}";

    public static string FileName(DateTime local) => $"osu-local-profiles-backup-{LocalDay(local)}.zip";

    /// <summary>
    /// The whole backup, as zip bytes. <c>VACUUM INTO</c> rather than reading the file: in WAL mode
    /// the .db on disk is not self-contained, and a plain copy can miss the latest writes.
    /// </summary>
    public static byte[] Create(Database db, string dataDir, DateTimeOffset at)
    {
        var snapshot = NodePath.Join(dataDir, $"backup-{Environment.ProcessId}-{at.ToUnixTimeMilliseconds()}.db");
        byte[] database;
        try
        {
            File.Delete(snapshot);
            db.Exec($"VACUUM INTO '{snapshot.Replace("'", "''")}'");
            database = File.ReadAllBytes(snapshot);
        }
        finally
        {
            File.Delete(snapshot);
        }
        var local = at.ToLocalTime().DateTime;
        return Zip.Write([(DbFile, database), .. ProfileFiles(dataDir).Select(name => (name, File.ReadAllBytes(NodePath.Join(dataDir, name))))], local);
    }

    /// <summary>SQLite's own message, as node:sqlite throws it, out of Microsoft.Data.Sqlite's wrapping of it.</summary>
    private static string SqliteMessage(SqliteException e)
    {
        var m = Regex.Match(e.Message, @"^SQLite Error [0-9]+: '(.*)'\.\z", RegexOptions.Singleline);
        return m.Success ? m.Groups[1].Value : e.Message;
    }

    /// <summary>
    /// What a staged database holds, or an error saying why it is not one of this app's. The tables
    /// are checked read-only first: opening it writable creates every table it is missing.
    /// </summary>
    private static List<BackupProfile> Summarise(string file)
    {
        Database probe;
        try
        {
            probe = Database.Open(file, writable: false);
        }
        catch (SqliteException)
        {
            throw new InvalidOperationException("the database in it could not be opened");
        }
        try
        {
            if (probe.Scalar("PRAGMA quick_check") as string != "ok") throw new InvalidOperationException("the database in it is damaged");
            var tables = probe.All("SELECT name FROM sqlite_master WHERE type = 'table'", r => r.GetString(0)).ToHashSet();
            if (!tables.Contains("profiles") || !tables.Contains("scores")) throw new InvalidOperationException("that is not an osu! local profiles backup");
        }
        catch (SqliteException e)
        {
            throw new InvalidOperationException(SqliteMessage(e));
        }
        finally
        {
            probe.Dispose();
        }
        // Brought up to this version's schema now, so a backup from an older release is known to open.
        using var db = Database.Open(file);
        var profiles = Profiles.List(db);
        if (profiles.Count == 0) throw new InvalidOperationException("that backup has no profiles in it");
        return [.. profiles.Select(p => new BackupProfile(p.Name, p.ScoreCount))];
    }

    /// <summary>
    /// Check an uploaded backup and stage it in <c>data/restore/</c>, without applying it: the zip
    /// "Back up everything" writes, or a bare <c>.db</c>. Only the latest upload can be applied.
    /// </summary>
    public static BackupSummary StageRestore(string dataDir, byte[] upload)
    {
        DiscardRestore(dataDir);
        var staged = NodePath.Join(dataDir, RestoreDir, Staged);
        Directory.CreateDirectory(staged);
        try
        {
            var images = 0;
            if (upload.AsSpan().StartsWith(ZipMagic))
            {
                List<Zip.Entry> entries;
                try
                {
                    entries = Zip.ReadEntries(upload);
                }
                catch (Exception e) when (e is InvalidOperationException or ArgumentOutOfRangeException)
                {
                    throw new InvalidOperationException($"the zip file could not be read ({e.Message})");
                }
                foreach (var entry in entries)
                {
                    if (entry.IsDirectory || !IsProfileFile(entry.Name)) continue;
                    var target = NodePath.Join([staged, .. entry.Name.Split('/')]);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    var data = Zip.EntryData(upload, entry);
                    if (data.Length != entry.Size) throw new InvalidOperationException($"the zip file is damaged ({entry.Name})");
                    File.WriteAllBytes(target, data);
                    if (entry.Name != DbFile) images++;
                }
            }
            else if (upload.AsSpan().StartsWith(SqliteMagic))
            {
                File.WriteAllBytes(NodePath.Join(staged, DbFile), upload);
            }
            else
            {
                throw new InvalidOperationException("that is not a backup: choose the .zip that Back up everything saved");
            }
            var database = NodePath.Join(staged, DbFile);
            if (!File.Exists(database)) throw new InvalidOperationException("that zip file has no profiles.db in it");
            return new BackupSummary(Summarise(database), images);
        }
        catch
        {
            DiscardRestore(dataDir);
            throw;
        }
    }

    public static bool HasStagedRestore(string dataDir) => File.Exists(NodePath.Join(dataDir, RestoreDir, Staged, DbFile));

    /// <summary>Ask for the staged backup to be applied at the next start.</summary>
    public static void MarkRestoreReady(string dataDir)
    {
        if (!HasStagedRestore(dataDir)) throw new InvalidOperationException("no backup has been uploaded to restore");
        File.WriteAllBytes(NodePath.Join(dataDir, RestoreDir, Ready), []);
    }

    public static void DiscardRestore(string dataDir)
    {
        var dir = NodePath.Join(dataDir, RestoreDir);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        else if (File.Exists(dir)) File.Delete(dir);
    }

    /// <summary>
    /// Swap a staged backup in, before the database is opened: once, at startup. Everything it
    /// replaces moves to <c>data/before-restore-&lt;time&gt;/</c>; if any move fails every one made is
    /// undone, so a restore happens whole or not at all. Either way the staging folder goes.
    /// </summary>
    public static RestoreResult ApplyPendingRestore(string dataDir, DateTime local)
    {
        var root = NodePath.Join(dataDir, RestoreDir);
        var staged = NodePath.Join(root, Staged);
        if (!File.Exists(NodePath.Join(root, Ready)) || !HasStagedRestore(dataDir))
        {
            // An upload nobody confirmed, left by a page that was closed.
            DiscardRestore(dataDir);
            return new RestoreResult(false);
        }

        var stamp = $"{LocalDay(local)}-{Pad(local.Hour)}{Pad(local.Minute)}{Pad(local.Second)}";
        var aside = NodePath.Join(dataDir, $"{AsidePrefix}{stamp}");
        var moved = new List<(string From, string To)>();
        void Move(string from, string to)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            // As renameSync: a file already there is replaced.
            File.Move(from, to, overwrite: true);
            moved.Add((from, to));
        }
        string Under(string dir, string name) => NodePath.Join([dir, .. name.Split('/')]);
        try
        {
            foreach (var name in new[] { DbFile, $"{DbFile}-wal", $"{DbFile}-shm" }.Concat(ProfileFiles(dataDir)))
            {
                var file = Under(dataDir, name);
                if (File.Exists(file)) Move(file, Under(aside, name));
            }
            foreach (var name in FilesUnder(staged)) Move(Under(staged, name), Under(dataDir, name));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            for (var i = moved.Count - 1; i >= 0; i--)
            {
                try
                {
                    File.Move(moved[i].To, moved[i].From, overwrite: true);
                }
                catch (Exception undo) when (undo is IOException or UnauthorizedAccessException)
                {
                    /* the aside folder still holds it, and the error below says where */
                }
            }
            DiscardRestore(dataDir);
            return new RestoreResult(false, Error: e.Message);
        }
        DiscardRestore(dataDir);
        return new RestoreResult(true, aside);
    }
}
