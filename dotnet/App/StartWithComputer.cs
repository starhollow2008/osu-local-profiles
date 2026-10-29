using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles;

/// <summary>Whether this copy can start with the computer (it has a tray launcher), and whether it does.</summary>
internal sealed record StartupState(bool Available, bool Enabled);

/// <summary>
/// Start with the computer (roadmap 5.77): src/startup.ts. Off by default. On, the computer starts
/// this copy's <b>tray launcher</b> as the user signs in, never the runtime, with
/// <c>--startup</c>, so the app opens no page.
/// </summary>
/// <remarks>
/// The entry the computer keeps is the only record of the answer, so the switch never disagrees
/// with the next sign-in: a value under <c>HKCU\...\Run</c> on Windows (Task Manager turning it off
/// marks it in <c>StartupApproved\Run</c>), a LaunchAgent on macOS, an XDG autostart entry on
/// Linux. It counts as on only when the entry starts <i>this</i> copy. Only a package has a launcher,
/// so a source checkout is never offered it.
/// </remarks>
internal static partial class StartWithComputer
{
    public const string StartupArg = "--startup";

    private const string WindowsName = "osu! local profiles";
    private const string RunKey = @"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedKey = @"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    private const string MacLabel = "io.github.jonathant09.osu-local-profiles";
    private const string LinuxFile = "osu-local-profiles.desktop";

    /// <summary>The tray launcher a package opens (scripts/package-files.mjs, <c>trayLauncherFor</c>).</summary>
    public static string LauncherPath(string dir, string platform) => platform switch
    {
        "win32" => JoinFor(platform, dir, "osu! local profiles.exe"),
        "darwin" => JoinFor(platform, dir, "osu! local profiles.app"),
        _ => JoinFor(platform, dir, "osu-local-profiles"),
    };

    /// <summary>The command Windows runs: the launcher, quoted for its spaces, then <c>--startup</c>.</summary>
    public static string WindowsCommand(string launcher) => $"\"{launcher}\" {StartupArg}";

    private static string Xml(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static string Unxml(string s) => s.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&amp;", "&");

    /// <summary>A LaunchAgent that opens the bundle with <c>open</c>, as Finder would.</summary>
    public static string MacAgent(string bundle)
    {
        string[] args = ["/usr/bin/open", "-a", bundle, "--args", StartupArg];
        return string.Join("\n", [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
            "<plist version=\"1.0\">",
            "<dict>",
            "  <key>Label</key>",
            $"  <string>{MacLabel}</string>",
            "  <key>ProgramArguments</key>",
            "  <array>",
            .. args.Select(arg => $"    <string>{Xml(arg)}</string>"),
            "  </array>",
            "  <key>RunAtLoad</key>",
            "  <true/>",
            "</dict>",
            "</plist>",
            "",
        ]);
    }

    /// <summary>An Exec argument, quoted as the desktop entry spec asks.</summary>
    private static string DesktopQuote(string s) => $"\"{DesktopSpecial().Replace(s, m => $"\\{m.Value}")}\"";

    [GeneratedRegex("[\\\\\"`$]")]
    private static partial Regex DesktopSpecial();

    public static string LinuxEntry(string launcher) => string.Join("\n", [
        "[Desktop Entry]",
        "Type=Application",
        "Name=osu! local profiles",
        $"Exec={DesktopQuote(launcher)} {StartupArg}",
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ]);

    [GeneratedRegex("^\"([^\"]+)\"")]
    private static partial Regex QuotedStart();

    [GeneratedRegex("<string>([^<]*)</string>")]
    private static partial Regex PlistString();

    [GeneratedRegex("^Exec=(\"(?:[^\"\\\\]|\\\\.)*\")", RegexOptions.Multiline)]
    private static partial Regex ExecLine();

    [GeneratedRegex(@"\\(.)")]
    private static partial Regex Escaped();

    /*
     * The launcher's path on the system named. The Node app wrote path.win32 or path.posix; this
     * app only ever names its own system, so the native join and resolve are the same thing,
     * and another system's path is compared as written.
     */
    private static string JoinFor(string platform, string dir, string name) =>
        platform == Browser.Platform ? NodePath.Join(dir, name) : $"{dir.TrimEnd('/', '\\')}{(platform == "win32" ? '\\' : '/')}{name}";

    private static string ResolveFor(string platform, string p) => platform == Browser.Platform ? NodePath.Resolve(p) : p;

    /// <summary>
    /// The launcher an entry starts, read back out of what <see cref="WindowsCommand"/>,
    /// <see cref="MacAgent"/> or <see cref="LinuxEntry"/> wrote; null for an entry this did not write.
    /// </summary>
    public static string? EntryTarget(string entry, string platform)
    {
        if (platform == "win32")
        {
            var m = QuotedStart().Match(Js.Trim(entry));
            return m.Success ? m.Groups[1].Value : null;
        }
        if (platform == "darwin")
        {
            var strings = PlistString().Matches(entry).Select(m => Unxml(m.Groups[1].Value)).ToList();
            var at = strings.IndexOf("-a");
            return at == -1 || at + 1 >= strings.Count ? null : strings[at + 1];
        }
        var exec = ExecLine().Match(entry);
        return exec.Success ? Escaped().Replace(exec.Groups[1].Value[1..^1], "$1") : null;
    }

    /// <summary>Whether an entry starts the launcher at <paramref name="launcher"/>.</summary>
    public static bool StartsLauncher(string? entry, string launcher, string platform)
    {
        var target = entry is null ? null : EntryTarget(entry, platform);
        if (target is null) return false;
        if (platform == "win32") return Js.ToLower(ResolveFor(platform, target)) == Js.ToLower(ResolveFor(platform, launcher));
        return ResolveFor(platform, target) == ResolveFor(platform, launcher);
    }

    /* ------------------------------------------------------------------ Windows */

    /// <summary>
    /// One value from a <c>reg export</c> file, unescaped; null when the key does not hold it.
    /// Exported rather than queried: <c>reg query</c> prints in the console's code page, which
    /// mangles a non-ASCII path, while an export is UTF-16.
    /// </summary>
    public static string? RegFileValue(string text, string name)
    {
        var quoted = $"\"{name.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"=";
        foreach (var line in text.Split('\n').Select(l => l.EndsWith('\r') ? l[..^1] : l))
        {
            if (!line.StartsWith(quoted, StringComparison.Ordinal)) continue;
            var raw = line[quoted.Length..];
            // raw.slice(1, raw.lastIndexOf('"')): empty when the only quote is the first.
            if (raw.StartsWith('"')) return Escaped().Replace(raw[1..Math.Max(1, raw.LastIndexOf('"'))], "$1");
            return raw;
        }
        return null;
    }

    [GeneratedRegex("^hex:([0-9a-f]{2})", RegexOptions.IgnoreCase)]
    private static partial Regex HexStart();

    /// <summary>Whether Task Manager turned the entry off: an odd first byte (03, 07) in <c>StartupApproved\Run</c>.</summary>
    public static bool ApprovedOff(string? value)
    {
        var m = value is null ? null : HexStart().Match(value);
        return m is { Success: true } && (Convert.ToInt32(m.Groups[1].Value, 16) & 1) == 1;
    }

    /// <summary>reg.exe by its own path, never whichever one PATH finds first.</summary>
    private static async Task Reg(params string[] args)
    {
        var exe = NodePath.Join(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows", "System32", "reg.exe");
        var start = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("reg.exe did not start");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await Task.WhenAll(stdout, stderr);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Command failed: {exe} {string.Join(" ", args)}\n{stderr.Result}");
        }
    }

    private static async Task<string> ExportKey(string key)
    {
        var dir = Directory.CreateTempSubdirectory("olp-startup-").FullName;
        var file = Path.Combine(dir, "key.reg");
        try
        {
            await Reg("export", key, file, "/y");
            var text = Encoding.Unicode.GetString(File.ReadAllBytes(file));
            return text.StartsWith('\uFEFF') ? text[1..] : text;
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            // A key that does not exist yet: nobody has ever had an entry there.
            return "";
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* left in the temporary folder */
            }
        }
    }

    /* --------------------------------------------------------------- per system */

    private static string MacAgentFile(string home) => NodePath.Join(home, "Library", "LaunchAgents", $"{MacLabel}.plist");

    private static string LinuxEntryFile(string home, Func<string, string?> env)
    {
        var config = env("XDG_CONFIG_HOME") is { Length: > 0 } c ? c : NodePath.Join(home, ".config");
        return NodePath.Join(config, "autostart", LinuxFile);
    }

    private static string? ReadText(string file)
    {
        try
        {
            return Js.ReadFileUtf8(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Where to look: the install, the system, the home folder and the environment, all replaceable in tests.</summary>
    internal sealed record Where(string Dir, string Platform, string Home, Func<string, string?> Env)
    {
        public static Where Of(string dir) => new(dir, Browser.Platform,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetEnvironmentVariable);

        public string Launcher => LauncherPath(Dir, Platform);
    }

    /// <summary>Whether the computer starts this copy as the user signs in.</summary>
    public static async Task<StartupState> State(Where at)
    {
        if (!File.Exists(at.Launcher) && !Directory.Exists(at.Launcher)) return new StartupState(false, false);
        if (at.Platform == "win32")
        {
            var entry = RegFileValue(await ExportKey(RunKey), WindowsName);
            if (!StartsLauncher(entry, at.Launcher, at.Platform)) return new StartupState(true, false);
            var approved = RegFileValue(await ExportKey(ApprovedKey), WindowsName);
            return new StartupState(true, !ApprovedOff(approved));
        }
        var file = at.Platform == "darwin" ? MacAgentFile(at.Home) : LinuxEntryFile(at.Home, at.Env);
        return new StartupState(true, StartsLauncher(ReadText(file), at.Launcher, at.Platform));
    }

    /// <summary>
    /// Turn it on or off for this copy. On points the entry here, taking it from any other copy; off
    /// removes it only when it is this copy's, so another copy's survives.
    /// </summary>
    public static async Task<StartupState> Set(bool enabled, Where at)
    {
        if (!File.Exists(at.Launcher) && !Directory.Exists(at.Launcher))
        {
            throw new InvalidOperationException("starting with the computer needs the downloaded app, which this copy is not");
        }
        if (at.Platform == "win32")
        {
            if (enabled)
            {
                await Reg("add", RunKey, "/v", WindowsName, "/t", "REG_SZ", "/d", WindowsCommand(at.Launcher), "/f");
                // Turned off in Task Manager once, it would stay off; turning it on here means on.
                await Ignored(Reg("delete", ApprovedKey, "/v", WindowsName, "/f"));
            }
            else if (StartsLauncher(RegFileValue(await ExportKey(RunKey), WindowsName), at.Launcher, at.Platform))
            {
                await Reg("delete", RunKey, "/v", WindowsName, "/f");
                await Ignored(Reg("delete", ApprovedKey, "/v", WindowsName, "/f"));
            }
            return await State(at);
        }

        var file = at.Platform == "darwin" ? MacAgentFile(at.Home) : LinuxEntryFile(at.Home, at.Env);
        if (enabled)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, at.Platform == "darwin" ? MacAgent(at.Launcher) : LinuxEntry(at.Launcher));
        }
        else if (StartsLauncher(ReadText(file), at.Launcher, at.Platform))
        {
            File.Delete(file);
        }
        return await State(at);
    }

    private static async Task Ignored(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            /* nothing there to delete */
        }
    }
}
