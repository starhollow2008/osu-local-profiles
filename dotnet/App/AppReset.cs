using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>
/// Settings -> System -> Reset (issue #48): settings, profiles, the beatmap index, or the whole app.
/// Asked for from the page, then applied at the next start, before anything opens what it clears,
/// as a restored backup is (<see cref="Backup"/>). Nothing is set aside: a reset is meant.
/// </summary>
internal static partial class AppReset
{
    public const string Settings = "settings";
    public const string Profiles = "profiles";
    public const string Index = "index";

    /// <summary>Everything in <c>data/</c>, as a new install has it.</summary>
    public const string App = "app";

    public static readonly string[] Parts = [Settings, Profiles, Index, App];

    private const string PendingFile = "reset.json";

    /// <summary>The launcher writes its log here while the app runs, so even a whole reset leaves it.</summary>
    private const string LogsDir = "logs";

    [GeneratedRegex(@"^profile-[0-9]+-(avatar|cover)\.(png|jpe?g|webp|gif)\z", RegexOptions.IgnoreCase)]
    private static partial Regex ProfilePicture();

    private static string PendingPath(string dataDir) => NodePath.Join(dataDir, PendingFile);

    /// <summary>The resets waiting for the next start, each once. Empty when there are none.</summary>
    public static HashSet<string> Pending(string dataDir)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(PendingPath(dataDir)));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return [];
            return [.. doc.RootElement.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.String && Parts.Contains(e.GetString()))
                .Select(e => e.GetString()!)];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    /// <summary>Ask for <paramref name="parts"/> at the next start, with any already asked for and not yet applied.</summary>
    public static void Stage(string dataDir, IEnumerable<string> parts)
    {
        var wanted = Pending(dataDir);
        foreach (var part in parts)
        {
            if (!Parts.Contains(part)) throw new ArgumentException($"no reset called \"{part}\"");
            wanted.Add(part);
        }
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(PendingPath(dataDir), JsonText.Stringify(Parts.Where(wanted.Contains)));
    }

    /// <summary>
    /// The files half, before config.json is read or the database opened: once, at startup. The
    /// request is taken first, so a reset that fails part way is never tried again at every start.
    /// Answers which resets the database still needs (<see cref="ApplyToDatabase"/>).
    /// </summary>
    public static HashSet<string> ApplyToFiles(string dataDir)
    {
        var parts = Pending(dataDir);
        DeleteFile(PendingPath(dataDir));
        if (parts.Contains(App))
        {
            // Only ever set by hand, and the page waiting for the app to come back is on it.
            var port = AppConfig.Load(dataDir).Port;
            DeleteAllBut(dataDir, LogsDir);
            if (port != AppConfig.DefaultPort) File.WriteAllText(NodePath.Join(dataDir, "config.json"), $"{{\n  \"port\": {port}\n}}\n");
            // A new install's database has nothing in it to reset.
            return [App];
        }
        if (parts.Contains(Settings)) AppConfig.ResetToDefaults(dataDir);
        if (parts.Contains(Profiles))
        {
            foreach (var file in TopFiles(dataDir).Where(name => ProfilePicture().IsMatch(name))) DeleteFile(NodePath.Join(dataDir, file));
            DeleteDir(NodePath.Join(dataDir, "about-images"));
            // Uploaded replays and the ones built for scores entered by hand: every one is a profile's.
            DeleteDir(NodePath.Join(dataDir, UploadedReplays.Dir));
        }
        return parts;
    }

    /// <summary>
    /// The database half, once it is open and before anything reads it. Beatmaps downloaded for
    /// scores and what is known about each beatmap stay with the index, which only Reset beatmap
    /// index and Reset app clear.
    /// </summary>
    public static void ApplyToDatabase(Database db, IReadOnlySet<string> parts, string firstProfileName)
    {
        if (parts.Contains(App)) return;
        db.Transaction(() =>
        {
            if (parts.Contains(Settings))
            {
                db.Run($"DELETE FROM profile_settings WHERE key NOT IN ({string.Join(",", OsuLocalProfiles.Settings.SettingsStore.IdentityKeys.Select(_ => "?"))})",
                    [.. OsuLocalProfiles.Settings.SettingsStore.IdentityKeys]);
            }
            if (parts.Contains(Profiles))
            {
                OsuLocalProfiles.Profiles.DeleteAll(db);
                db.Run("DELETE FROM shared_favorite_beatmapsets");
                // Start over as a new install does: welcomed, with the favourites decided afresh.
                db.Run("DELETE FROM kv WHERE key = 'favoritesShared'");
                ProfileData.OfferWelcome(db);
            }
            if (parts.Contains(Index))
            {
                db.Run("DELETE FROM osu_files");
                db.Run("DELETE FROM not_beatmaps");
                // Found again by the scan that rebuilds the index.
                db.Run("UPDATE beatmaps SET osu_path = NULL");
            }
        });
        if (!parts.Contains(Profiles)) return;
        // Through Create, never SeedFirst: SQLite would give the new profile a deleted one's id.
        try
        {
            OsuLocalProfiles.Profiles.Create(db, firstProfileName);
        }
        catch (UserError)
        {
            // A hand-edited profileName that is no name at all.
            OsuLocalProfiles.Profiles.Create(db, "Local Profile");
        }
    }

    private static IEnumerable<string> TopFiles(string dir)
    {
        try
        {
            return [.. new DirectoryInfo(dir).EnumerateFiles().Select(f => f.Name)];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static void DeleteAllBut(string dataDir, string kept)
    {
        IEnumerable<FileSystemInfo> entries;
        try
        {
            entries = [.. new DirectoryInfo(dataDir).EnumerateFileSystemInfos()];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }
        foreach (var entry in entries)
        {
            if (entry.Name == kept) continue;
            if (entry is DirectoryInfo) DeleteDir(entry.FullName);
            else DeleteFile(entry.FullName);
        }
    }

    private static void DeleteFile(string file)
    {
        try
        {
            if (File.Exists(file)) File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"  could not delete {file}: {e.Message}");
        }
    }

    private static void DeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"  could not delete {dir}: {e.Message}");
        }
    }
}
