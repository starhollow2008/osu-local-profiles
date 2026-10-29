using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Calc;

/// <summary>A helper built from source, as <c>data/pp-source/helper.json</c> records it.</summary>
/// <param name="Version">What its pp is labelled: see <see cref="SourceHelper.SourceVersion"/>.</param>
/// <param name="Source">The osu! source folder it was built from.</param>
/// <param name="Dir">Where it was published to.</param>
internal sealed record BuiltHelper(string Version, string Source, string Dir, double BuiltAt);

/// <summary>
/// The pp helper, built against the player's own osu! source rather than osu!'s released packages
/// (roadmap 5.70; src/calc/source-helper.ts).
/// </summary>
/// <remarks>
/// Someone running osu! from source may have changed how pp is calculated, or written a mod of their
/// own. The release knows neither: it prices with the last osu! release, and a mod it has never heard
/// of is osu!'s UnknownMod. So this builds the same helper (this app's own
/// <c>tools/PpCalculator/Program.cs</c>, unchanged) with its osu! packages swapped for the projects in
/// the player's clone, which is what ppy's osu-tools does with its UseLocalOsu script.
///
/// It replaces the release for the whole app, never beside it and never as a fallback for it. Built
/// into <c>data/pp-source/</c>, which an update never touches, each build named by the source's
/// version so a rebuild never overwrites a helper the app is running. Pruned as the shipped helper is,
/// and for this machine's platform alone: unpruned, a build is 649MB where about 60 will do.
/// </remarks>
internal static partial class SourceHelper
{
    /// <summary>The osu! projects the helper is built against, by where a clone of ppy/osu keeps them.</summary>
    public static readonly string[] SourceProjects =
    [
        "osu.Game/osu.Game.csproj",
        "osu.Game.Rulesets.Osu/osu.Game.Rulesets.Osu.csproj",
        "osu.Game.Rulesets.Taiko/osu.Game.Rulesets.Taiko.csproj",
        "osu.Game.Rulesets.Catch/osu.Game.Rulesets.Catch.csproj",
        "osu.Game.Rulesets.Mania/osu.Game.Rulesets.Mania.csproj",
    ];

    /// <summary>Long enough for a first build of osu.Game on a slow machine, which restores packages too.</summary>
    private static readonly TimeSpan BuildTimeout = TimeSpan.FromMinutes(30);

    /// <summary>
    /// Why a folder is not an osu! source this can build from, or null when it is. The data folder a
    /// development build writes to (<c>%APPDATA%\osu-development</c>) is the likeliest mistake, and is
    /// named as such: it holds settings and replays, not code.
    /// </summary>
    public static string? CheckOsuSource(string dir)
    {
        if (Js.Trim(dir).Length == 0 || !Exists(dir)) return "that folder does not exist";
        var missing = SourceProjects.Where(p => !Exists(NodePath.Join(dir, p))).ToList();
        if (missing.Count == 0) return null;
        if (Exists(NodePath.Join(dir, "files")) || Exists(NodePath.Join(dir, "game.dev.ini")))
        {
            return "that is where osu! keeps its data, not its source: choose the folder you cloned ppy/osu into, the one with osu.Game in it";
        }
        return $"that is not a clone of ppy/osu: it has no {missing[0]}";
    }

    /// <summary><c>fs.existsSync</c>: a file or a folder.</summary>
    private static bool Exists(string p) => File.Exists(p) || Directory.Exists(p);

    /// <summary>The same folder, however it was written. Windows paths are case-insensitive.</summary>
    public static bool SameFolder(string a, string b)
    {
        static string Norm(string p) => OperatingSystem.IsWindows() ? Js.ToLower(NodePath.Resolve(p)) : NodePath.Resolve(p);
        return Norm(a) == Norm(b);
    }

    private static byte[] Git(string dir, params string[] args)
    {
        var start = new ProcessStartInfo("git")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add("-C");
        start.ArgumentList.Add(dir);
        foreach (var arg in args) start.ArgumentList.Add(arg);
        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InvalidOperationException();
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new InvalidOperationException("git is needed to tell one version of your osu! source from another, and it was not found");
        }
        using (process)
        {
            using var output = new MemoryStream();
            var stderr = process.StandardError.ReadToEndAsync();
            process.StandardOutput.BaseStream.CopyTo(output);
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                var first = Js.Trim(stderr.Result).Split((char)10)[0];
                throw new InvalidOperationException($"git could not read that folder: {first}");
            }
            return output.ToArray();
        }
    }

    private static string Text(byte[] bytes) => new UTF8Encoding(false).GetString(bytes);

    /// <summary>
    /// What the source is, as every pp it prices will be labelled: <c>source &lt;commit&gt;</c>, and
    /// <c>+&lt;hash of the local changes&gt;</c> when the working tree differs from that commit.
    /// </summary>
    /// <remarks>
    /// The hash is what makes an edit count. A player changing the pp formula without committing still
    /// has the same commit, and the label has to change with the formula, or scores priced by the old
    /// one would look current. So it covers every change git can see (staged, unstaged, and new files
    /// it is not told to ignore), and two builds of the same edit get the same label.
    /// </remarks>
    public static string SourceVersion(string dir)
    {
        var commit = Js.Trim(Text(Git(dir, "rev-parse", "--short=7", "HEAD")));
        var status = Js.Trim(Text(Git(dir, "status", "--porcelain", "--untracked-files=all")));
        if (status.Length == 0) return $"source {commit}";

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Git(dir, "diff", "HEAD", "--binary"));
        var untracked = Text(Git(dir, "ls-files", "--others", "--exclude-standard", "-z"))
            .Split((char)0)
            .Where(f => f.Length > 0)
            .OrderBy(f => f, StringComparer.Ordinal);
        foreach (var file in untracked)
        {
            hash.AppendData(Encoding.UTF8.GetBytes($"{(char)0}{file}{(char)0}"));
            try
            {
                hash.AppendData(File.ReadAllBytes(NodePath.Join(dir, file)));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* gone since git listed it */
            }
        }
        return $"source {commit}+{Convert.ToHexStringLower(hash.GetHashAndReset())[..7]}";
    }

    /// <summary>The project file: the release helper's, with osu!'s packages swapped for the clone's projects.</summary>
    public static string ProjectXml(string source)
    {
        var refs = string.Join((char)10, SourceProjects.Select(p =>
            $"    <ProjectReference Include=\"{EscapeXml(NodePath.Resolve(NodePath.Join(source, p)))}\" />"));
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <!-- Generated by osu! local profiles (src/calc/source-helper.ts). Rebuilt on every build. -->
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <ImplicitUsings>enable</ImplicitUsings>
                <AssemblyName>osu-pp</AssemblyName>
                <RootNamespace>OsuLocalProfiles.PpCalculator</RootNamespace>
                <InvariantGlobalization>true</InvariantGlobalization>
                <NuGetAudit>false</NuGetAudit>
              </PropertyGroup>
              <ItemGroup>
            {refs}
              </ItemGroup>
            </Project>

            """.Replace("\r\n", "\n");
    }

    private static string EscapeXml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");

    private static string RootOf(string dataDir) => NodePath.Join(dataDir, "pp-source");

    /// <summary>The helper last built, or null when there is none, or its files have gone.</summary>
    public static BuiltHelper? Read(string dataDir)
    {
        try
        {
            if (!JsonText.TryParse(File.ReadAllText(NodePath.Join(RootOf(dataDir), "helper.json")), out var helper)) return null;
            if (!Js.IsString(Js.Get(helper, "version"), out var version) || !Js.IsString(Js.Get(helper, "dir"), out var dir)) return null;
            // A folder that is not text names no folder at all.
            if (!Js.IsString(Js.Get(helper, "source"), out var source)) return null;
            var builtAt = Js.Get(helper, "builtAt") is { ValueKind: JsonValueKind.Number } n ? n.GetDouble() : 0;
            return File.Exists(NodePath.Join(dir, "osu-pp.dll")) ? new BuiltHelper(version, source, dir, builtAt) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>How to start it. Framework-dependent: whoever builds osu! from source has .NET installed.</summary>
    public static HelperCandidate Candidate(BuiltHelper helper) => new("dotnet", [NodePath.Join(helper.Dir, "osu-pp.dll")]);

    /// <summary>
    /// Build the helper from <paramref name="source"/> and record it as the one to use. Throws with a
    /// message worth showing: the end of the compiler's own output when the build itself failed, since
    /// that is where a player who broke their own source will want to look.
    /// </summary>
    /// <param name="program">This app's <c>tools/PpCalculator/Program.cs</c>: the helper is the same code either way.</param>
    /// <param name="onOutput">Each line <c>dotnet</c> prints, for the page to show how far it has got.</param>
    public static async Task<BuiltHelper> Build(string source, string dataDir, string program, Action<string>? onOutput = null)
    {
        if (CheckOsuSource(source) is { } problem) throw new InvalidOperationException(problem);
        var version = SourceVersion(source);

        var root = RootOf(dataDir);
        var project = NodePath.Join(root, "project");
        Directory.CreateDirectory(project);
        File.WriteAllText(NodePath.Join(project, "PpCalculator.csproj"), ProjectXml(source));
        File.Copy(program, NodePath.Join(project, "Program.cs"), true);

        var name = UnsafeNameChars().Replace(version.StartsWith("source ", StringComparison.Ordinal) ? version[7..] : version, "-");
        var staging = NodePath.Join(root, $"building-{Js.Now()}");
        var tail = new List<string>();
        var gate = new object();

        var start = new ProcessStartInfo("dotnet")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // From the clone, so the SDK its global.json asks for is the one that builds it.
            WorkingDirectory = source,
        };
        foreach (var arg in new[]
        {
            "publish", NodePath.Join(project, "PpCalculator.csproj"), "-c", "Release",
            // This machine's natives only, and no runtime: whoever builds osu! has .NET.
            "-r", Rid(), "--self-contained", "false",
            "-o", staging, "--nologo", "-v", "minimal",
        })
        {
            start.ArgumentList.Add(arg);
        }
        start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        start.Environment["DOTNET_NOLOGO"] = "1";

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InvalidOperationException();
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new InvalidOperationException("building needs the .NET 10 SDK, and `dotnet` was not found");
        }
        int code;
        using (process)
        {
            void Read(string? line)
            {
                if (line is null || Js.Trim(line).Length == 0) return;
                lock (gate)
                {
                    tail.Add(line);
                    if (tail.Count > 40) tail.RemoveAt(0);
                    onOutput?.Invoke(line);
                }
            }
            process.OutputDataReceived += (_, e) => Read(e.Data);
            process.ErrorDataReceived += (_, e) => Read(e.Data);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            using var timeout = new CancellationTokenSource(BuildTimeout);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try
                {
                    process.Kill(true);
                }
                catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    /* gone */
                }
                throw new InvalidOperationException("the build took more than 30 minutes, and was stopped");
            }
            code = process.ExitCode;
        }

        // The intermediate copy `dotnet` builds before publishing: the whole helper again, unpruned.
        // `obj` stays, small, so the next build restores and builds only what changed.
        DeleteFolder(NodePath.Join(project, "bin"));

        if (code != 0 || !File.Exists(NodePath.Join(staging, "osu-pp.dll")))
        {
            DeleteFolder(staging);
            List<string> lines;
            lock (gate) lines = [.. tail];
            var errors = lines.Where(l => l.Contains("error", StringComparison.OrdinalIgnoreCase)).ToList();
            var shown = errors.Count > 0 ? errors : lines;
            throw new InvalidOperationException($"the build failed:{(char)10}{string.Join((char)10, shown.Skip(Math.Max(0, shown.Count - 8)))}");
        }

        Prune(staging);

        // Named by version. A helper of the same name is only rebuilt when it is not the one running
        // (PpSource.Use), so it can be replaced; one that cannot be is left, and this is kept under its
        // staging name instead.
        var dir = NodePath.Join(root, name);
        try
        {
            DeleteFolder(dir, quiet: false);
            Directory.Move(staging, dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            dir = staging;
        }
        var helper = new BuiltHelper(version, NodePath.Resolve(source), dir, Js.Now());
        File.WriteAllText(NodePath.Join(root, "helper.json"), JsonSerializer.Serialize(new
        {
            version = helper.Version,
            source = helper.Source,
            dir = helper.Dir,
            builtAt = helper.BuiltAt,
        }, new JsonSerializerOptions(JsonText.Options) { WriteIndented = true, IndentSize = 2, NewLine = "\n" }) + "\n");
        Sweep(root, [dir]);
        return helper;
    }

    /// <summary><c>fs.rmSync(dir, { recursive: true, force: true })</c>; a failure is thrown only when asked.</summary>
    private static void DeleteFolder(string dir, bool quiet = true)
    {
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            else if (File.Exists(dir)) File.Delete(dir);
        }
        catch (Exception e) when (quiet && e is IOException or UnauthorizedAccessException)
        {
            /* left for the next sweep */
        }
    }

    /// <summary>Managed assemblies safe to drop (src/calc/helper-prune.ts): fonts, textures and audio samples, 125MB.</summary>
    private static readonly string[] PruneAssemblies = ["osu.Game.Resources.dll"];

    /// <summary>
    /// Native libraries the calculator never calls, by base name (src/calc/helper-prune.ts). BASS is
    /// un4seen's commercial library, not freely redistributable, and this app never plays a sound, so
    /// the pattern has to catch it on every platform. The managed wrapper <c>ppy.ManagedBass.dll</c>
    /// must stay, which is why these match a whole filename and never a substring.
    /// </summary>
    private static readonly string[] PruneNatives =
    [
        // Audio.
        "bass", "bass_fx", "bassmix", "basswasapi",
        // Video decoding: nothing here ever plays a beatmap background.
        "avcodec", "avformat", "avutil", "swscale", "swresample",
        // Windowing, image loading and shader compilation: no window is ever opened.
        "SDL2", "SDL3", "veldrid-spirv", "stbi",
        // Debug symbol reader.
        "Microsoft.DiaSymReader.Native.amd64", "Microsoft.DiaSymReader.Native.x86",
    ];

    /// <summary>
    /// <c>[lib]&lt;name&gt;[-1.2][.dll|.dylib|.so][.3]</c>, anchored at both ends: the two version slots
    /// cover where each platform puts it (<c>avcodec-58.dll</c>, <c>libavcodec.so.58</c>).
    /// </summary>
    private static readonly Regex[] NativePatterns = [.. PruneNatives.Select(name => new Regex(
        $@"^(lib)?{Regex.Escape(name)}([-.][0-9][0-9.]*)?\.(dll|dylib|so)(\.[0-9][0-9.]*)?\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))];

    /// <summary>Whether the full helper can do without this published file.</summary>
    public static bool PrunedFromFullHelper(string filename) =>
        PruneAssemblies.Contains(filename) || NativePatterns.Any(p => p.IsMatch(filename));

    /// <summary>The .NET runtime identifier for the machine this is running on.</summary>
    public static string Rid()
    {
        var arch = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        if (OperatingSystem.IsWindows()) return $"win-{arch}";
        if (OperatingSystem.IsMacOS()) return $"osx-{arch}";
        return $"linux-{arch}";
    }

    /// <summary>
    /// Remove what the helper never uses: what the shipped helper does without, debug symbols, and the
    /// localisation folders (one per language) that come with osu!'s resources. Walked rather than
    /// listed, so a name this has never seen on a platform is simply kept.
    /// </summary>
    public static void Prune(string dir)
    {
        foreach (var folder in Directory.GetDirectories(dir)) DeleteFolder(folder, quiet: false);
        foreach (var file in Directory.GetFiles(dir))
        {
            var name = Path.GetFileName(file);
            if (PrunedFromFullHelper(name) || name.EndsWith(".pdb", StringComparison.Ordinal)) File.Delete(file);
        }
    }

    /// <summary>
    /// Remove the builds nothing points at any more. Best effort: one still running (the helper this
    /// build is about to replace) is locked on Windows and simply stays until next time.
    /// </summary>
    public static void Sweep(string root, IReadOnlyList<string> keep)
    {
        string[] folders;
        try
        {
            folders = Directory.GetDirectories(root);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }
        foreach (var dir in folders)
        {
            if (Path.GetFileName(dir) == "project") continue;
            if (keep.Any(k => SameFolder(k, dir))) continue;
            DeleteFolder(dir);
        }
    }

    // JavaScript's \w is ASCII alone.
    [GeneratedRegex("[^A-Za-z0-9_.-]")]
    private static partial Regex UnsafeNameChars();
}
