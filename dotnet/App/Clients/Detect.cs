using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>One osu! client on this machine: src/clients/detect.ts's <c>OsuInstall</c>.</summary>
/// <param name="Kind"><c>lazer</c>, <c>stable</c> or <c>mcosu</c>.</param>
/// <param name="ReplayDir">Where new replays appear. McOsu writes none: for it, the app's folder of the replays it builds.</param>
/// <param name="OnlineDb">lazer's cached beatmap metadata database, if present.</param>
/// <param name="Development">osu!'s development client, tracked beside release lazer (roadmap 5.68).</param>
internal sealed record OsuInstall(string Kind, string Root, string ReplayDir, List<string> BeatmapRoots, string? OnlineDb, bool Development = false);

/// <summary>Everything about the machine that decides where osu! might be, passed in so every platform can be tested from one.</summary>
internal sealed record DetectEnvironment(string Platform, string Home, IReadOnlyDictionary<string, string?> Env)
{
    public static DetectEnvironment Current()
    {
        var env = new Dictionary<string, string?>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string?)e.Value;
        return new DetectEnvironment(Browser.Platform, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), env);
    }

    public string? this[string name] => Env.TryGetValue(name, out var v) ? v : null;
}

/// <summary>
/// Where osu! usually is, and what is at a given folder: src/clients/detect.ts, with McOsu's own
/// location helpers from src/clients/mcosu.ts. Every check is one existence test; nothing here walks.
/// </summary>
internal static partial class Detect
{
    private static bool Exists(string p) => File.Exists(p) || Directory.Exists(p);

    private static string[] ReadDir(string dir)
    {
        try
        {
            return [.. Directory.EnumerateFileSystemEntries(dir).Select(NodePath.Basename)];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return [];
        }
    }

    /// <summary>The drive letters this machine has, C: upwards (A: and B: are floppy letters).</summary>
    public static List<string> WindowsDrives()
    {
        var output = new List<string>();
        for (var c = 'C'; c <= 'Z'; c++)
        {
            var root = $"{c}:\\";
            if (Directory.Exists(root)) output.Add(root);
        }
        return output;
    }

    /// <summary><c>$XDG_DATA_HOME</c>, or <c>~/.local/share</c>; a relative value is invalid and ignored.</summary>
    private static string XdgDataHome(DetectEnvironment e) =>
        e["XDG_DATA_HOME"] is { Length: > 0 } configured && NodePath.IsAbsolute(configured) ? configured : NodePath.Join(e.Home, ".local", "share");

    /// <summary>The folders each platform keeps application data in. All three on every platform: they cannot collide.</summary>
    private static List<string> LazerDataHomes(DetectEnvironment e)
    {
        var output = new List<string>();
        if (e["APPDATA"] is { Length: > 0 } appData) output.Add(appData);
        output.Add(NodePath.Join(e.Home, "Library", "Application Support"));
        output.Add(XdgDataHome(e));
        return output;
    }

    public static List<string> LazerCandidates(DetectEnvironment e) => [.. LazerDataHomes(e).Select(h => NodePath.Join(h, "osu"))];

    [GeneratedRegex(@"^osu-development(?:-([0-9]+))?\z", RegexOptions.IgnoreCase)]
    public static partial Regex DevelopmentFolder();

    /// <summary>osu!'s development client's folders beside lazer's: the plain one first, then the numbered ones in order.</summary>
    public static List<string> LazerDevelopmentCandidates(DetectEnvironment e)
    {
        var output = new List<string>();
        foreach (var home in LazerDataHomes(e))
        {
            if (!Directory.Exists(home)) continue;
            var found = ReadDir(home)
                .Select(name => (Name: name, Match: DevelopmentFolder().Match(name)))
                .Where(f => f.Match.Success)
                .OrderBy(f => f.Match.Groups[1].Success ? Js.StringToNumber(f.Match.Groups[1].Value) : -1);
            output.AddRange(found.Select(f => NodePath.Join(home, f.Name)));
        }
        return output;
    }

    /// <summary>Folders people put games in, below a drive root; <c>''</c> is the root itself.</summary>
    private static readonly string[] WindowsGameDirs = ["", "Games", "Game", "games", "Program Files", "Program Files (x86)", "Apps", "Programs", "SteamLibrary"];

    /// <summary>The names an osu!stable folder is given, under one of those.</summary>
    private static readonly string[] StableFolders = ["osu!", "osu", "osu!stable", "osustable", "osu!/osu!", "osu!/osu"];

    /// <summary>Where a native Windows osu!stable install lives, on every drive there is.</summary>
    public static List<string> WindowsStableCandidates(DetectEnvironment e, IReadOnlyList<string>? drives = null)
    {
        drives ??= ["C:\\", "D:\\", "E:\\"];
        var output = new List<string>();
        if (e["LOCALAPPDATA"] is { Length: > 0 } local) output.Add(NodePath.Join(local, "osu!"));
        if (e["PROGRAMFILES"] is { Length: > 0 } programs) output.Add(NodePath.Join(programs, "osu!"));
        output.Add(NodePath.Join(e.Home, "osu!"));
        foreach (var drive in drives)
        {
            foreach (var parent in WindowsGameDirs)
            {
                foreach (var folder in StableFolders) output.Add(NodePath.Join([drive, parent, .. folder.Split('/')]));
            }
        }
        return output;
    }

    /// <summary>osu!stable under Wine: the fixed paths of the wrappers people use.</summary>
    public static List<string> WineStableCandidates(DetectEnvironment e)
    {
        var output = new List<string>();
        foreach (var apps in new[] { "/Applications", NodePath.Join(e.Home, "Applications") })
        {
            foreach (var app in new[] { "osu!.app", "osu.app" })
            {
                output.Add(NodePath.Join(apps, app, "drive_c", "osu!"));
                output.Add(NodePath.Join(apps, app, "drive_c", "Program Files", "osu!"));
                output.Add(NodePath.Join(apps, app, "Contents", "SharedSupport", "prefix", "drive_c", "osu!"));
            }
        }
        var prefixes = new List<string>();
        if (e["WINEPREFIX"] is { Length: > 0 } prefix) prefixes.Add(prefix);
        prefixes.Add(NodePath.Join(e.Home, ".wine"));
        // osu-winello's own prefix. Its D: drive is the install, handled in WineStableRoots.
        prefixes.Add(NodePath.Join(XdgDataHome(e), "wineprefixes", "osu-wineprefix"));
        foreach (var p in prefixes)
        {
            output.Add(NodePath.Join(p, "drive_c", "osu!"));
            output.Add(NodePath.Join(p, "drive_c", "Program Files", "osu!"));
            output.Add(NodePath.Join(p, "drive_c", "Program Files (x86)", "osu!"));
        }
        return output;
    }

    /// <summary>Wine locations read rather than guessed: osu-winello's record and D: drive, Wine's per-user folder, CrossOver bottles.</summary>
    public static List<string> WineStableRoots(DetectEnvironment e)
    {
        var output = new List<string>();
        var data = XdgDataHome(e);
        try
        {
            var recorded = Js.Trim(Js.ReadFileUtf8(NodePath.Join(data, "osuconfig", "osupath")));
            if (recorded.Length > 0) output.Add(recorded);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            /* not installed that way */
        }
        try
        {
            var link = new DirectoryInfo(NodePath.Join(data, "wineprefixes", "osu-wineprefix", "dosdevices", "d:"));
            if (link.Exists) output.Add(link.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? link.FullName);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            /* no prefix, or no D: drive yet */
        }
        var prefixes = new List<string>();
        if (e["WINEPREFIX"] is { Length: > 0 } prefix) prefixes.Add(prefix);
        prefixes.Add(NodePath.Join(e.Home, ".wine"));
        foreach (var p in prefixes)
        {
            var users = NodePath.Join(p, "drive_c", "users");
            if (!Directory.Exists(users)) continue;
            foreach (var name in ReadDir(users)) output.Add(NodePath.Join(users, name, "AppData", "Local", "osu!"));
        }
        var bottles = NodePath.Join(e.Home, "Library", "Application Support", "CrossOver", "Bottles");
        foreach (var name in Directory.Exists(bottles) ? ReadDir(bottles) : [])
        {
            output.Add(NodePath.Join(bottles, name, "drive_c", "osu!"));
            output.Add(NodePath.Join(bottles, name, "drive_c", "Program Files", "osu!"));
        }
        return output;
    }

    [GeneratedRegex(@"^client_[0-9]+\.realm\z", RegexOptions.IgnoreCase)]
    public static partial Regex DevelopmentRealm();

    private static double SchemaOf(string name)
    {
        var m = Regex.Match(name, "_([0-9]+)\\.");
        return m.Success ? Js.StringToNumber(m.Groups[1].Value) : 0;
    }

    /// <summary>lazer's realm in <paramref name="root"/>: <c>client.realm</c>, or a development client's <c>client_&lt;n&gt;.realm</c>.</summary>
    public static (string File, bool Development)? LazerRealm(string root)
    {
        if (!Directory.Exists(root)) return null;
        var names = ReadDir(root);
        var development = names.Where(n => DevelopmentRealm().IsMatch(n)).OrderByDescending(SchemaOf).FirstOrDefault();
        if (development is not null) return (NodePath.Join(root, development), true);
        var release = names.FirstOrDefault(n => n.Equals("client.realm", StringComparison.OrdinalIgnoreCase));
        return release is null ? null : (NodePath.Join(root, release), false);
    }

    /// <summary>A lazer install, if that is what is at <paramref name="root"/>: a <c>files/</c> store and a realm.</summary>
    public static OsuInstall? LazerInstall(string root)
    {
        var files = NodePath.Join(root, "files");
        if (!Exists(files)) return null;
        if (LazerRealm(root) is not { } realm) return null;
        var onlineDb = NodePath.Join(root, "online.db");
        // lazer writes replays into its content-addressed store, same as every other file.
        return new OsuInstall("lazer", root, files, [files], Exists(onlineDb) ? onlineDb : null, realm.Development);
    }

    [GeneratedRegex(@"^osu!\..+\.cfg\z", RegexOptions.IgnoreCase)]
    private static partial Regex StableConfig();

    [GeneratedRegex(@"^[ \t]*BeatmapDirectory[ \t]*=[ \t]*(.+?)[ \t]*\z", RegexOptions.IgnoreCase)]
    private static partial Regex BeatmapDirectory();

    /// <summary>
    /// Where a stable install keeps its beatmaps: <c>BeatmapDirectory</c> in its per-user config,
    /// which the player can move to another drive; <c>Songs</c> when it says nothing that exists.
    /// </summary>
    private static string StableSongs(string root)
    {
        var fallback = NodePath.Join(root, "Songs");
        foreach (var entry in ReadDir(root).Where(n => StableConfig().IsMatch(n)))
        {
            string contents;
            try
            {
                contents = Js.ReadFileUtf8(NodePath.Join(root, entry));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            if (NodePath.FirstMatch(contents, BeatmapDirectory()) is not { Length: > 0 } value) continue;
            var resolved = NodePath.IsAbsolute(value) ? value : NodePath.Join(root, value);
            if (Exists(resolved)) return resolved;
        }
        return fallback;
    }

    /// <summary>
    /// What says a folder with an <c>osu!.exe</c> is lazer's, not stable's: lazer's program files and
    /// its updater's stub, both of which a search can walk into.
    /// </summary>
    private static readonly string[] NotStable = ["osu.Game.dll", "osu!.deps.json", "osu!.runtimeconfig.json", "Update.exe", "sq.version"];

    public static OsuInstall? StableInstall(string root)
    {
        if (!Exists(NodePath.Join(root, "osu!.exe"))) return null;
        if (NotStable.Any(marker => Exists(NodePath.Join(root, marker)))) return null;
        var songs = StableSongs(root);
        return new OsuInstall("stable", root, NodePath.Join(root, "Data", "r"), Exists(songs) ? [songs] : [], null);
    }

    /// <summary>Where Steam itself might be; its <c>libraryfolders.vdf</c> lists every other library.</summary>
    public static List<string> SteamRoots(DetectEnvironment e, IReadOnlyList<string>? drives = null)
    {
        drives ??= ["C:\\", "D:\\", "E:\\"];
        var output = new List<string>();
        if (e.Platform == "win32")
        {
            if ((e["PROGRAMFILES(X86)"] ?? e["ProgramFiles(x86)"]) is { Length: > 0 } x86) output.Add(NodePath.Join(x86, "Steam"));
            if (e["PROGRAMFILES"] is { Length: > 0 } programs) output.Add(NodePath.Join(programs, "Steam"));
            foreach (var drive in drives) output.AddRange([NodePath.Join(drive, "Steam"), NodePath.Join(drive, "SteamLibrary")]);
        }
        output.AddRange([NodePath.Join(e.Home, ".steam", "steam"), NodePath.Join(XdgDataHome(e), "Steam")]);
        return output;
    }

    /// <summary>Steam's app id for McOsu.</summary>
    public const int McosuSteamApp = 607260;

    [GeneratedRegex(@"""path""\s+""((?:[^""\\]|\\.)*)""")]
    private static partial Regex VdfPath();

    /// <summary>Every Steam library on this machine, from Steam's own <c>libraryfolders.vdf</c>.</summary>
    public static List<string> SteamLibraries(IEnumerable<string> steamRoots)
    {
        var output = new List<string>();
        var seen = new HashSet<string>();
        void Add(string p)
        {
            if (seen.Add(Js.ToLower(NodePath.Resolve(p)))) output.Add(p);
        }
        foreach (var steam in steamRoots)
        {
            if (!Exists(steam)) continue;
            Add(steam);
            string vdf;
            try
            {
                vdf = Js.ReadFileUtf8(NodePath.Join(steam, "steamapps", "libraryfolders.vdf"));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (Match m in VdfPath().Matches(vdf)) Add(m.Groups[1].Value.Replace(@"\\", @"\"));
        }
        return output;
    }

    public static List<string> McosuCandidates(DetectEnvironment e, IReadOnlyList<string>? drives = null) =>
        [.. SteamLibraries(SteamRoots(e, drives)).Select(lib => NodePath.Join(lib, "steamapps", "common", "McOsu"))];

    private static readonly string[] McosuExecutables = ["McEngine.exe", "McOsu.exe", "McEngine", "McOsu"];

    public static bool IsMcosuRoot(string root) =>
        McosuExecutables.Any(exe => Exists(NodePath.Join(root, exe))) && (Exists(NodePath.Join(root, "cfg")) || Exists(NodePath.Join(root, "scores.db")));

    [GeneratedRegex(@"^[ \t]*osu_folder[ \t]+(.+?)[ \t]*\z")]
    private static partial Regex OsuFolder();

    [GeneratedRegex(@"[\\/]+\z")]
    private static partial Regex TrailingSeparators();

    /// <summary>The Songs folder McOsu loads beatmaps from: <c>osu_folder</c> in its <c>cfg/osu.cfg</c>, usually osu!stable's.</summary>
    public static string? McosuSongs(string root)
    {
        string cfg;
        try
        {
            cfg = Js.ReadFileUtf8(NodePath.Join(root, "cfg", "osu.cfg"));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        // McOsu on Windows writes the folder with a trailing backslash, which elsewhere is a filename character.
        var raw = NodePath.FirstMatch(cfg, OsuFolder());
        if (raw is null) return null;
        var folder = TrailingSeparators().Replace(Regex.Replace(raw, "^\"|\"$", ""), "");
        if (folder.Length == 0) return null;
        var songs = NodePath.Join(folder, "Songs");
        return Exists(songs) ? songs : null;
    }

    /// <summary>A McOsu install: its beatmaps wherever <c>osu_folder</c> points, its "replays" the ones this app builds.</summary>
    public static OsuInstall? McosuInstall(string root, string builtReplays)
    {
        if (!IsMcosuRoot(root)) return null;
        var songs = McosuSongs(root);
        return new OsuInstall("mcosu", root, builtReplays, songs is null ? [] : [songs], null);
    }

    /// <summary>Every place worth one existence test, in the order to try it: configured first.</summary>
    public static List<string> CandidateRoots(IEnumerable<string> configured, DetectEnvironment e)
    {
        var drives = e.Platform == "win32" ? WindowsDrives() : [];
        return
        [
            .. configured,
            .. LazerCandidates(e),
            .. LazerDevelopmentCandidates(e),
            .. WindowsStableCandidates(e, drives.Count > 0 ? drives : null),
            .. WineStableCandidates(e),
            .. WineStableRoots(e),
            .. McosuCandidates(e, drives.Count > 0 ? drives : null),
        ];
    }
}
