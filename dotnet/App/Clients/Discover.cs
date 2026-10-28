using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>A folder holding an osu! install, with enough about it to choose between several.</summary>
/// <param name="Source"><c>configured</c>, <c>remembered</c>, <c>detected</c> or <c>searched</c>.</param>
internal sealed record InstallCandidate(string Root, string Kind, bool Development, double Score, string Source);

internal sealed record DiscoveryResult(List<OsuInstall> Installs, List<InstallCandidate> Candidates, bool Searched);

internal sealed record ScanLimits(int MaxDepth, int MaxDirs, int TimeBudgetMs)
{
    public static readonly ScanLimits Default = new(5, 30_000, 25_000);
}

/// <summary>
/// Finding osu! when it is not where anyone would have guessed: src/clients/discover.ts. What the
/// machine already knows (lazer's <c>storage.ini</c>, the registry), then shortcuts, then a bounded
/// walk of every drive, each only when the one before left a client unaccounted for.
/// </summary>
internal static partial class Discover
{
    [GeneratedRegex(@"^[ \t]*FullPath[ \t]*=[ \t]*(.+?)[ \t]*\z", RegexOptions.IgnoreCase)]
    private static partial Regex FullPath();

    /// <summary>lazer's data directory when the player has moved it, from the default folder's <c>storage.ini</c>.</summary>
    public static string? StorageIniPath(string contents) => NodePath.FirstMatch(contents, FullPath()) is { Length: > 0 } v ? v : null;

    public static List<string> LazerRedirects(DetectEnvironment e)
    {
        var output = new List<string>();
        foreach (var root in Detect.LazerCandidates(e).Concat(Detect.LazerDevelopmentCandidates(e)))
        {
            string contents;
            try
            {
                contents = Js.ReadFileUtf8(NodePath.Join(root, "storage.ini"));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            if (StorageIniPath(contents) is { } target) output.Add(target);
        }
        return output;
    }

    /// <summary>The registry keys that name an osu! executable or install directory: file associations and uninstall entries.</summary>
    public static List<string> RegistryQueries()
    {
        var output = new List<string>();
        foreach (var progId in new[] { "osu!", "osu", "osustable.File.osz", "osustable.File.osr", "osu!osz" })
        {
            output.Add($"HKCU\\Software\\Classes\\{progId}");
            output.Add($"HKCR\\{progId}");
        }
        foreach (var hive in new[] { "HKCU", "HKLM" })
        {
            output.Add($"{hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osu!");
            output.Add($"{hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osulazer");
            output.Add($"{hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App {Detect.McosuSteamApp}");
        }
        return output;
    }

    [GeneratedRegex(@"\s(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)\z")]
    private static partial Regex RegistryValue();

    [GeneratedRegex(@"[A-Za-z]:\\[^""*?<>|\r\n]*?\.exe")]
    private static partial Regex RegistryExe();

    [GeneratedRegex(@"^[A-Za-z]:\\")]
    private static partial Regex DriveRooted();

    /// <summary>Windows paths out of <c>reg query</c> output: an executable in a command line, or a bare directory.</summary>
    public static List<string> RegistryPaths(string output)
    {
        var paths = new List<string>();
        foreach (var line in Regex.Split(output, "\r?\n"))
        {
            var m = RegistryValue().Match(line);
            if (!m.Success) continue;
            var value = m.Groups[1].Value;
            var matched = false;
            foreach (Match exe in RegistryExe().Matches(value))
            {
                paths.Add(exe.Value);
                matched = true;
            }
            if (matched) continue;
            var bare = Regex.Replace(Js.Trim(value), "^\"(.*)\"\\z", "$1");
            if (DriveRooted().IsMatch(bare)) paths.Add(bare);
        }
        return paths;
    }

    /// <summary>Ask the registry where osu! is. Windows only; anything unexpected means "no answer".</summary>
    public static async Task<List<string>> RegistryRoots(DetectEnvironment e)
    {
        if (e.Platform != "win32") return [];
        var outputs = await Task.WhenAll(RegistryQueries().Select(async key =>
        {
            try
            {
                using var process = Process.Start(new ProcessStartInfo("reg") { ArgumentList = { "query", key, "/s" }, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
                if (process is null) return "";
                var read = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(5000))
                {
                    process.Kill();
                    return "";
                }
                await Task.WhenAll(read, errors);
                // A key that does not exist exits non-zero. That is the normal case here.
                return process.ExitCode == 0 ? await read : "";
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                return "";
            }
        }));
        return [.. outputs.SelectMany(RegistryPaths)];
    }

    [GeneratedRegex(@"[A-Za-z]:\\[^\x00-\x1f""*?<>|]{0,240}?osu!\.exe", RegexOptions.IgnoreCase)]
    private static partial Regex LnkTarget();

    /// <summary>The osu! executables a <c>.lnk</c> points at, read from both of its string encodings.</summary>
    public static List<string> LnkTargets(byte[] buf)
    {
        var output = new List<string>();
        foreach (var text in new[] { Encoding.Latin1.GetString(buf), Encoding.Unicode.GetString(buf, 0, buf.Length & ~1) })
        {
            foreach (Match m in LnkTarget().Matches(text)) if (!output.Contains(m.Value)) output.Add(m.Value);
        }
        return output;
    }

    /// <summary>Where Windows keeps shortcuts a player might have to osu!.</summary>
    public static List<string> ShortcutDirs(DetectEnvironment e)
    {
        if (e.Platform != "win32") return [];
        var output = new List<string>();
        if (e["APPDATA"] is { Length: > 0 } appData)
        {
            var ie = NodePath.Join(appData, "Microsoft", "Internet Explorer", "Quick Launch");
            output.Add(NodePath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs"));
            output.Add(ie);
            output.Add(NodePath.Join(ie, "User Pinned", "TaskBar"));
        }
        if (e["ProgramData"] is { Length: > 0 } programData) output.Add(NodePath.Join(programData, "Microsoft", "Windows", "Start Menu", "Programs"));
        output.Add(NodePath.Join(e.Home, "Desktop"));
        output.Add(NodePath.Join(e.Home, "OneDrive", "Desktop"));
        return output;
    }

    private static List<(string Name, bool IsDirectory, bool IsFile)> Entries(string dir)
    {
        try
        {
            return [.. new DirectoryInfo(dir).EnumerateFileSystemInfos().Select(i =>
            {
                // A link is neither, as a Dirent says of one: the walk never follows it.
                var link = i.Attributes.HasFlag(FileAttributes.ReparsePoint);
                return (i.Name, !link && i is DirectoryInfo, !link && i is FileInfo);
            })];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or System.Security.SecurityException)
        {
            return [];
        }
    }

    [GeneratedRegex("osu|game", RegexOptions.IgnoreCase)]
    private static partial Regex OsuOrGame();

    [GeneratedRegex("osu", RegexOptions.IgnoreCase)]
    private static partial Regex OsuName();

    /// <summary>Install directories named by a shortcut, one level of subfolder deep, as the Start Menu keeps them.</summary>
    public static List<string> ShortcutRoots(DetectEnvironment e)
    {
        var output = new List<string>();
        foreach (var dir in ShortcutDirs(e))
        {
            var dirs = new List<string> { dir };
            foreach (var entry in Entries(dir)) if (entry.IsDirectory && OsuOrGame().IsMatch(entry.Name)) dirs.Add(NodePath.Join(dir, entry.Name));
            foreach (var sub in dirs)
            {
                foreach (var entry in Entries(sub))
                {
                    if (!entry.IsFile || !Js.ToLower(entry.Name).EndsWith(".lnk", StringComparison.Ordinal) || !OsuName().IsMatch(entry.Name)) continue;
                    byte[] buf;
                    try
                    {
                        buf = File.ReadAllBytes(NodePath.Join(sub, entry.Name));
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        continue;
                    }
                    output.AddRange(LnkTargets(buf).Select(NodePath.Dirname));
                }
            }
        }
        return output;
    }

    /// <summary>Directories the walk never enters: nothing is installed there, or they are enormous by nature.</summary>
    private static readonly HashSet<string> SkipDirs = new[]
    {
        "Songs", "files", "Windows", "WindowsApps", "WinSxS", "$Recycle.Bin", "$RECYCLE.BIN", "System Volume Information", "Recovery",
        "PerfLogs", "Package Cache", "node_modules", ".git", ".svn", ".hg", "__pycache__", "site-packages", "Temp", "Cache", "Caches",
        "CrashDumps", "OneDrive", "Microsoft", "NVIDIA Corporation", "proc", "sys", "dev", "snap", ".cache",
    }.Select(Js.ToLower).ToHashSet();

    public static bool SkipDir(string name) =>
        SkipDirs.Contains(Js.ToLower(name)) || name.StartsWith('$') || (name.StartsWith('.') && name != ".minecraft");

    /// <summary>Whether a directory's entries say an osu! install is here, from names the walk already has.</summary>
    public static bool LooksLikeInstall(IReadOnlyCollection<string> names)
    {
        var lower = names.Select(Js.ToLower).ToHashSet();
        return lower.Contains("osu!.exe") || lower.Contains("client.realm") || names.Any(n => Detect.DevelopmentRealm().IsMatch(n))
            || lower.Contains("mcengine.exe") || lower.Contains("mcosu.exe");
    }

    /// <summary>Everywhere the fallback search starts: every drive on Windows, the home folder and mounts elsewhere.</summary>
    public static List<string> ScanRoots(DetectEnvironment e)
    {
        if (e.Platform == "win32") return Detect.WindowsDrives();
        var output = new List<string> { e.Home };
        foreach (var mount in new[] { "/Volumes", "/mnt", "/media", "/run/media", "/opt", "/games", "/srv" }) if (Directory.Exists(mount)) output.Add(mount);
        return output;
    }

    /// <summary>
    /// Walk for osu! installs, breadth first so the shallow answer arrives long before the budget
    /// runs out. Stops at an install, never follows a link, and swallows every error.
    /// </summary>
    public static List<string> ScanForInstalls(IEnumerable<string> roots, ScanLimits? limits = null, Action<int, string, List<string>>? onProgress = null)
    {
        limits ??= ScanLimits.Default;
        var deadline = DateTime.UtcNow.AddMilliseconds(limits.TimeBudgetMs);
        var found = new List<string>();
        var seen = new HashSet<string>();
        var dirs = 0;
        var queue = roots.Select(r => (Dir: r, Depth: 0)).ToList();
        while (queue.Count > 0)
        {
            var next = new List<(string, int)>();
            foreach (var (dir, depth) in queue)
            {
                if (dirs >= limits.MaxDirs || DateTime.UtcNow > deadline) return found;
                if (!seen.Add(Js.ToLower(dir))) continue;
                if (!Directory.Exists(dir)) continue;
                var entries = Entries(dir);
                dirs++;
                if (onProgress is not null && dirs % 200 == 0) onProgress(dirs, dir, [.. found]);
                if (LooksLikeInstall([.. entries.Select(x => x.Name)]))
                {
                    found.Add(dir);
                    continue;
                }
                if (depth >= limits.MaxDepth) continue;
                foreach (var entry in entries) if (entry.IsDirectory && !SkipDir(entry.Name)) next.Add((NodePath.Join(dir, entry.Name), depth + 1));
            }
            queue = next;
        }
        onProgress?.Invoke(dirs, "", [.. found]);
        return found;
    }

    /// <summary>How promising a candidate root is: a database, a config, beatmaps and recent activity; a backup says so in its name.</summary>
    public static double InstallScore(string root)
    {
        double score = 0;
        FileSystemInfo? Stat(string name)
        {
            var full = NodePath.Join(root, name);
            if (File.Exists(full)) return new FileInfo(full);
            return Directory.Exists(full) ? new DirectoryInfo(full) : null;
        }
        if (Stat("osu!.db") is not null) score += 40;
        if (Stat("scores.db") is not null) score += 20;
        var realm = Detect.LazerRealm(root);
        if (realm is not null) score += 40;
        if (Stat("Songs") is not null) score += 10;
        if (Stat("Data") is not null) score += 10;
        try
        {
            if (Directory.EnumerateFileSystemEntries(root).Select(NodePath.Basename).Any(n => Regex.IsMatch(n, @"^osu!\..+\.cfg\z", RegexOptions.IgnoreCase))) score += 20;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            /* unreadable: it scores what it scores */
        }
        var marker = Stat("osu!.db") ?? (realm is { } r ? Stat(NodePath.Basename(r.File)) : null) ?? Stat("osu!.exe") ?? Stat("scores.db");
        if (marker is not null)
        {
            var days = (DateTime.UtcNow - marker.LastWriteTimeUtc).TotalMilliseconds / 86_400_000;
            score += Math.Max(0, 30 - days);
        }
        if (Regex.IsMatch(NodePath.Basename(root), "backup|old|copy|versions?\\z", RegexOptions.IgnoreCase)) score -= 25;
        return score;
    }

    /// <summary>Classify a directory, without saying which client was expected.</summary>
    public static OsuInstall? Classify(string root, string builtReplays) =>
        Detect.LazerInstall(root) ?? Detect.StableInstall(root) ?? Detect.McosuInstall(root, builtReplays);

    /// <summary>
    /// Find osu!, properly: configured and remembered roots, McOsu and the development client every
    /// time, the cheap tiers when a client is missing, and the walk only then and only once.
    /// </summary>
    public static async Task<DiscoveryResult> Run(IEnumerable<string>? configured, IEnumerable<string>? remembered, string builtReplays,
        bool force = false, bool noSearch = false, DetectEnvironment? env = null, ScanLimits? limits = null, Action<int, string, List<string>>? onProgress = null)
    {
        var e = env ?? DetectEnvironment.Current();
        var candidates = new List<InstallCandidate>();
        var known = new HashSet<string>();
        void Add(IEnumerable<string> roots, string source)
        {
            foreach (var root in roots)
            {
                if (!known.Add(Js.ToLower(root))) continue;
                if (Classify(root, builtReplays) is { } install)
                {
                    candidates.Add(new InstallCandidate(install.Root, install.Kind, install.Development, InstallScore(root), source));
                }
            }
        }
        bool Missing() => !candidates.Any(c => c.Kind == "lazer") || !candidates.Any(c => c.Kind == "stable");

        Add(configured ?? [], "configured");
        Add(remembered ?? [], "remembered");
        Add(Detect.McosuCandidates(e), "detected");
        Add(Detect.LazerDevelopmentCandidates(e), "detected");
        if (force || Missing()) Add(Detect.CandidateRoots([], e), "detected");
        if (force || Missing())
        {
            Add(LazerRedirects(e), "detected");
            Add(await RegistryRoots(e), "detected");
            Add(ShortcutRoots(e), "detected");
        }

        var searched = !noSearch && (force || Missing());
        if (searched) Add(await Task.Run(() => ScanForInstalls(ScanRoots(e), limits, onProgress)), "searched");

        // What the user chose, then what scored best.
        var bySource = new Dictionary<string, int> { ["configured"] = 0, ["remembered"] = 1, ["detected"] = 2, ["searched"] = 2 };
        var sorted = candidates.OrderBy(c => bySource[c.Source]).ThenByDescending(c => c.Score).ToList();

        // One of each, and the development client in a slot of its own beside release lazer.
        var installs = new List<OsuInstall>();
        foreach (var (kind, development) in new[] { ("lazer", false), ("lazer", true), ("stable", false), ("mcosu", false) })
        {
            var best = sorted.FirstOrDefault(c => c.Kind == kind && c.Development == development);
            if (best is not null && Classify(best.Root, builtReplays) is { } install) installs.Add(install);
        }
        return new DiscoveryResult(installs, sorted, searched);
    }
}
