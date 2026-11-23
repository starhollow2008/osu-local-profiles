using System.Diagnostics;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// Pricing with the player's own osu! source (roadmap 5.70): test/pp-source.test.ts. What can be
/// checked without building osu!: which folders are a source, how a source's version is named, the
/// project the helper is built from, and that nothing ever falls back to the release in its place.
/// The build itself is checked by hand against a real clone (docs/roadmap.md 5.70).
/// </summary>
public class PpSourceTests
{
    private static string Tmp(string prefix) => Directory.CreateTempSubdirectory(prefix).FullName;

    /// <summary>A folder laid out like a clone of ppy/osu, as far as the projects go.</summary>
    private static string FakeSource()
    {
        var dir = Tmp("olp-osu-source-");
        foreach (var p in SourceHelper.SourceProjects)
        {
            var file = NodePath.Join(dir, p);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, "<Project />\n");
        }
        return dir;
    }

    private static bool Runs(string command, params string[] args)
    {
        try
        {
            var start = new ProcessStartInfo(command) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in args) start.ArgumentList.Add(arg);
            using var process = Process.Start(start)!;
            process.WaitForExit();
            return process.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static void Git(string dir, params string[] args) => Assert.True(Runs("git", ["-C", dir, .. args]), $"git {string.Join(' ', args)}");

    /// <summary>
    /// Answers as a build from source does: ready, with osu!'s placeholder version, then the same
    /// answer to every request. Node stands in for it, as in the TypeScript test.
    /// </summary>
    private static readonly HelperCandidate FakeHelper = new("node", ["-e", """
        console.log(JSON.stringify({ ready: true, version: "0.0.0" }));
        require("readline").createInterface({ input: process.stdin })
          .on("line", () => console.log(JSON.stringify({ ok: true, ranked: true, unranked: [] })));
        """]);

    [Fact]
    public void A_clone_of_ppy_osu_is_a_source_and_its_data_folder_or_anything_else_is_not()
    {
        var source = FakeSource();
        var data = Tmp("olp-osu-data-");
        try
        {
            Assert.Null(SourceHelper.CheckOsuSource(source));
            Assert.Contains("does not exist", SourceHelper.CheckOsuSource(NodePath.Join(source, "nowhere")));
            Assert.Contains("does not exist", SourceHelper.CheckOsuSource("  "));

            // What %APPDATA%\osu-development holds: settings and replays, not code.
            Directory.CreateDirectory(NodePath.Join(data, "files"));
            File.WriteAllText(NodePath.Join(data, "game.dev.ini"), "");
            Assert.Contains("where osu! keeps its data", SourceHelper.CheckOsuSource(data));

            File.Delete(NodePath.Join(source, SourceHelper.SourceProjects[2]));
            Assert.Contains("no osu.Game.Rulesets.Taiko", SourceHelper.CheckOsuSource(source));
        }
        finally
        {
            Directory.Delete(source, true);
            Directory.Delete(data, true);
        }
    }

    [Fact]
    public void A_source_is_named_by_its_commit_and_by_its_changes_whenever_it_has_any()
    {
        // As the TypeScript test skips: git is on every machine CI runs on.
        if (!Runs("git", "--version")) return;
        var dir = Tmp("olp-osu-git-");
        try
        {
            Git(dir, "init", "-q");
            Git(dir, "config", "user.email", "test@example.com");
            Git(dir, "config", "user.name", "test");
            Git(dir, "config", "core.autocrlf", "false");
            File.WriteAllText(Path.Combine(dir, "Performance.cs"), "return pp;\n");
            File.WriteAllText(Path.Combine(dir, ".gitignore"), "bin/\n");
            Git(dir, "add", ".");
            Git(dir, "commit", "-q", "-m", "one");

            var clean = SourceHelper.SourceVersion(dir);
            Assert.Matches("^source [0-9a-f]{7}\\z", clean);

            // A build's output is ignored, so building does not change what the source is.
            Directory.CreateDirectory(Path.Combine(dir, "bin"));
            File.WriteAllText(Path.Combine(dir, "bin", "osu.Game.dll"), "binary");
            Assert.Equal(clean, SourceHelper.SourceVersion(dir));

            // An uncommitted change to the formula is a different formula, and says so.
            File.WriteAllText(Path.Combine(dir, "Performance.cs"), "return pp * 2;\n");
            var edited = SourceHelper.SourceVersion(dir);
            Assert.Matches($"^{clean}\\+[0-9a-f]{{7}}\\z", edited);
            Assert.Equal(edited, SourceHelper.SourceVersion(dir));

            File.WriteAllText(Path.Combine(dir, "Performance.cs"), "return pp * 3;\n");
            Assert.NotEqual(edited, SourceHelper.SourceVersion(dir));

            // A new file (a mod of the player's own) counts too.
            File.WriteAllText(Path.Combine(dir, "Performance.cs"), "return pp;\n");
            Assert.Equal(clean, SourceHelper.SourceVersion(dir));
            File.WriteAllText(Path.Combine(dir, "MyMod.cs"), "class MyMod {}\n");
            Assert.NotEqual(clean, SourceHelper.SourceVersion(dir));

            // What git says when it cannot read a folder, for the page to show.
            var refused = Assert.Throws<InvalidOperationException>(() => SourceHelper.SourceVersion(Path.Combine(dir, "nowhere")));
            Assert.StartsWith("git could not read that folder: ", refused.Message);
        }
        finally
        {
            // git marks its objects read-only.
            foreach (var file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void The_helper_is_this_apps_own_with_osus_packages_swapped_for_the_sources_projects()
    {
        var source = NodePath.Resolve("/somewhere/osu");
        var xml = SourceHelper.ProjectXml(source);
        foreach (var p in SourceHelper.SourceProjects)
        {
            Assert.Contains($"<ProjectReference Include=\"{NodePath.Resolve(NodePath.Join(source, p))}\" />", xml);
        }
        Assert.DoesNotContain("PackageReference", xml);
        Assert.Contains("<AssemblyName>osu-pp</AssemblyName>", xml);
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", xml);
        Assert.DoesNotContain("\r", xml);
        Assert.EndsWith("</Project>\n", xml);
        // A source that can't be read is built as current osu! is.
        Assert.DoesNotContain("DefineConstants", xml);
    }

    /// <summary>The helper code, tools/PpCalculator/Program.cs.</summary>
    private static string HelperProgram([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        File.ReadAllText(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "tools", "PpCalculator", "Program.cs"));

    [Fact]
    public void Older_osu_source_leaves_out_only_what_it_lacks()
    {
        var source = FakeSource();
        try
        {
            var ruleset = NodePath.Join(source, "osu.Game/Rulesets/Ruleset.cs");
            Directory.CreateDirectory(Path.GetDirectoryName(ruleset)!);

            File.WriteAllText(ruleset, "public virtual IEnumerable<RulesetBeatmapAttribute> GetBeatmapAttributesForDisplay(");
            Assert.Empty(SourceHelper.MissingFeatures(source));
            Assert.DoesNotContain("DefineConstants", SourceHelper.ProjectXml(source));

            File.WriteAllText(ruleset, "public abstract class Ruleset { }");
            Assert.Equal(["OSU_SOURCE_LACKS_DISPLAY_ATTRIBUTES"], SourceHelper.MissingFeatures(source));
            Assert.Contains("<DefineConstants>$(DefineConstants);OSU_SOURCE_LACKS_DISPLAY_ATTRIBUTES</DefineConstants>", SourceHelper.ProjectXml(source));

            // Every constant is one the helper's code leaves something out for.
            var program = HelperProgram();
            foreach (var feature in SourceHelper.SourceFeatures) Assert.Contains($"#if !{feature.Constant}", program);
        }
        finally
        {
            Directory.Delete(source, true);
        }
    }

    [Fact]
    public void A_source_pinned_to_an_sdk_before_net_10_is_built_by_the_newest_one()
    {
        var source = FakeSource();
        const string project = "/data/pp-source/project";
        try
        {
            Assert.Equal(source, SourceHelper.BuildDirectory(source, project));
            File.WriteAllText(NodePath.Join(source, "global.json"), """{ "sdk": { "version": "10.0.100", "rollForward": "latestFeature" } }""");
            Assert.Equal(source, SourceHelper.BuildDirectory(source, project));
            File.WriteAllText(NodePath.Join(source, "global.json"), """{ "sdk": { "version": "8.0.100", "rollForward": "latestFeature" } }""");
            Assert.Equal(project, SourceHelper.BuildDirectory(source, project));
        }
        finally
        {
            Directory.Delete(source, true);
        }
    }

    [Fact]
    public void A_build_from_source_is_pruned_as_the_shipped_helper_is()
    {
        var dir = Tmp("olp-pp-prune-");
        try
        {
            string[] kept = ["osu-pp.dll", "osu.Game.dll", "osu.Framework.dll", "ppy.ManagedBass.dll", "SDL2-CS.dll", "realm-wrappers.dll"];
            string[] dropped = ["osu.Game.Resources.dll", "bass.dll", "libbass.so", "avcodec-61.dll", "SDL3.dll", "osu.Game.pdb", "libavcodec.so.58", "libSDL2-2.0.so.0"];
            foreach (var f in kept.Concat(dropped)) File.WriteAllText(Path.Combine(dir, f), "");
            // One folder per language, beside osu!'s resources.
            Directory.CreateDirectory(Path.Combine(dir, "de"));
            File.WriteAllText(Path.Combine(dir, "de", "osu.Game.Resources.resources.dll"), "");

            SourceHelper.Prune(dir);
            Assert.Equal(kept.Order(StringComparer.Ordinal), Directory.GetFileSystemEntries(dir).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task With_a_source_chosen_and_nothing_built_from_it_a_launch_prices_nothing_never_the_release()
    {
        var data = Tmp("olp-pp-data-");
        try
        {
            Assert.Null(SourceHelper.Read(data));
            var (calculator, problem) = await PpSource.StartupCalculator("C:/somewhere/osu", data);
            Assert.Null(calculator);
            Assert.Contains("no calculator has been built", problem);

            // A record whose folder is not text names no helper at all.
            Directory.CreateDirectory(NodePath.Join(data, "pp-source", "abc"));
            File.WriteAllText(NodePath.Join(data, "pp-source", "abc", "osu-pp.dll"), "");
            File.WriteAllText(NodePath.Join(data, "pp-source", "helper.json"),
                JsonText.Stringify(new { version = "source abc", source = 5, dir = NodePath.Join(data, "pp-source", "abc"), builtAt = 1 }));
            Assert.Null(SourceHelper.Read(data));
        }
        finally
        {
            Directory.Delete(data, true);
        }
    }

    [Fact]
    public async Task A_named_helper_takes_the_name_it_is_given_and_one_that_fails_is_not_replaced_by_another()
    {
        if (!Runs("node", "--version")) return;
        using var named = await OfficialCalculator.Start(FakeHelper, "source abc1234");
        Assert.NotNull(named);
        Assert.Equal("source abc1234", named.Version);
        Assert.Equal((true, Array.Empty<string>()), await named.Ranked(0, null, 8));

        using var reported = await OfficialCalculator.Start(FakeHelper);
        Assert.Equal("0.0.0", reported!.Version);

        Assert.Null(await OfficialCalculator.Start(new HelperCandidate("node", ["-e", "process.exit(1)"]), "source abc1234"));
        Assert.Null(await OfficialCalculator.Start(new HelperCandidate("no-such-program-anywhere", []), "source abc1234"));
    }

    [Fact]
    public async Task A_helper_that_dies_says_so_rather_than_waiting()
    {
        if (!Runs("node", "--version")) return;
        // Ready, then gone at the first request.
        using var dying = await OfficialCalculator.Start(new HelperCandidate("node", ["-e", """
            console.log(JSON.stringify({ ready: true, version: "0.0.0" }));
            process.stdin.once("data", () => process.exit(3));
            """]));
        Assert.NotNull(dying);
        Assert.Null(await dying.Calculate("a.osr", "a.osu"));
        Assert.Equal("calculator exited", dying.LastError);
    }

    [Fact]
    public async Task Switching_calculators_swaps_between_plays_stops_the_old_one_and_is_recorded_as_done()
    {
        if (!Runs("node", "--version")) return;
        using var h = new TempDb();
        var tracker = new PlayTracker(h.Db, new BeatmapResolver(h.Db, []), [], h.ProfileId, Js.Now(), null);
        var release = (await OfficialCalculator.Start(FakeHelper, "2026.916.0"))!;
        await tracker.SwitchCalculator(release);
        var source = (await OfficialCalculator.Start(FakeHelper, "source abc1234"))!;
        await tracker.SwitchCalculator(source);

        Assert.Equal("source abc1234", tracker.CalculatorVersion);
        // Stopped: it answers nothing. The one in use still answers.
        Assert.Null(await release.Ranked(0, null, 8));
        Assert.NotNull(await source.Ranked(0, null, 8));
        // So the next launch does not recalculate everything again.
        Assert.Equal("source abc1234", Recompute.RecalculatedFor(h.Db));
        source.Dispose();
    }

    [Fact]
    public async Task A_switch_that_cannot_happen_changes_nothing_not_the_calculator_not_config_json()
    {
        var data = Tmp("olp-pp-data-");
        var notASource = Tmp("olp-not-osu-");
        try
        {
            string? saved = null;
            var switched = 0;
            var service = new PpSource(
                new PpSourceTracker((_, _) =>
                {
                    switched++;
                    return Task.FromResult(RecomputeResult.None);
                }, () => "2026.916.0", () => false),
                data, "Program.cs", () => "", s => saved = s);

            var use = service.Use(notASource);
            // Decided before its first wait, so the page's answer already says it.
            Assert.True(use.IsCompleted);
            var state = await use;
            Assert.Contains("not a clone of ppy/osu", state.Error);
            Assert.Equal("", state.Source);
            Assert.Null(saved);
            Assert.Equal(0, switched);
            Assert.Null(service.State().Building);
            Assert.Null(service.State().Version);
        }
        finally
        {
            Directory.Delete(data, true);
            Directory.Delete(notASource, true);
        }
    }

    [Fact]
    public void A_build_from_older_helper_code_than_this_apps_is_built_again()
    {
        var dir = Tmp("olp-pp-program-");
        try
        {
            var program = NodePath.Join(dir, "Program.cs");
            File.WriteAllText(program, "class A {}\r\n// one\r\n");
            var stamp = SourceHelper.ProgramStamp(program);
            Assert.Matches("^[0-9a-f]{12}$", stamp);
            // Line endings aside, since a checkout may have either.
            File.WriteAllText(program, "class A {}\n// one\n");
            Assert.Equal(stamp, SourceHelper.ProgramStamp(program));
            Assert.Null(SourceHelper.ProgramStamp(NodePath.Join(dir, "missing.cs")));

            var built = new BuiltHelper("source abc1234", "C:/osu", "C:/data/pp-source/abc1234", 1, stamp);
            Assert.True(SourceHelper.IsCurrent(built, "C:/osu/", "source abc1234", stamp));
            Assert.False(SourceHelper.IsCurrent(null, "C:/osu", "source abc1234", stamp));
            Assert.False(SourceHelper.IsCurrent(built, "C:/other", "source abc1234", stamp));
            Assert.False(SourceHelper.IsCurrent(built, "C:/osu", "source def5678", stamp));

            // A request added to the helper since: built again, as is one built before stamps were recorded.
            File.WriteAllText(program, "class A {}\n// two\n");
            var now = SourceHelper.ProgramStamp(program);
            Assert.True(SourceHelper.Outdated(built, now));
            Assert.False(SourceHelper.IsCurrent(built, "C:/osu", "source abc1234", now));
            Assert.True(SourceHelper.Outdated(built with { Program = null }, now));
            // This app's helper code unreadable: nothing can be told, so nothing is built for it.
            Assert.False(SourceHelper.Outdated(built with { Program = null }, null));
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void Settings_is_told_when_the_helper_in_use_was_built_by_an_earlier_version_of_the_app()
    {
        var data = Tmp("olp-pp-data-");
        var source = FakeSource();
        try
        {
            var program = NodePath.Join(data, "Program.cs");
            File.WriteAllText(program, "class A {}\n");
            var dir = NodePath.Join(data, "pp-source", "abc1234");
            Directory.CreateDirectory(dir);
            File.WriteAllText(NodePath.Join(dir, "osu-pp.dll"), "");
            void Record(string? stamp) => File.WriteAllText(NodePath.Join(data, "pp-source", "helper.json"),
                JsonText.Stringify(new { version = "source abc1234", source, dir, builtAt = 1, program = stamp }));

            PpSource Service(string inUse) => new(
                new PpSourceTracker((_, _) => Task.FromResult(RecomputeResult.None), () => "source abc1234", () => false),
                data, program, () => inUse, _ => { });

            // Recorded before stamps were.
            Record(null);
            Assert.Null(SourceHelper.Read(data)!.Program);
            Assert.True(Service(source).View().Outdated);
            // Nothing to say while the release is in use.
            Assert.False(Service("").View().Outdated);

            Record(SourceHelper.ProgramStamp(program));
            Assert.Equal(SourceHelper.ProgramStamp(program), SourceHelper.Read(data)!.Program);
            Assert.False(Service(source).View().Outdated);
        }
        finally
        {
            Directory.Delete(data, true);
            Directory.Delete(source, true);
        }
    }

    [Fact]
    public async Task Nothing_switches_while_scores_are_being_recalculated()
    {
        var data = Tmp("olp-pp-data-");
        try
        {
            var service = new PpSource(
                new PpSourceTracker((_, _) => throw new InvalidOperationException("must not switch"), () => "source abc1234", () => true),
                data, "Program.cs", () => "C:/somewhere/osu", _ => throw new InvalidOperationException("must not save"),
                release: () => throw new InvalidOperationException("must not start the release"));
            Assert.Contains("being recalculated", (await service.UseRelease()).Error);
            Assert.Equal("source abc1234", service.State().Version);
        }
        finally
        {
            Directory.Delete(data, true);
        }
    }

    [Fact]
    public void A_resolved_folder_has_no_trailing_separator_unless_it_is_a_root()
    {
        var root = OperatingSystem.IsWindows() ? @"C:\" : "/";
        Assert.Equal(NodePath.Join(root, "osu"), NodePath.Resolve(root + "osu" + Path.DirectorySeparatorChar));
        Assert.Equal(NodePath.Join(root, "a", "b"), NodePath.Resolve(root + "a/b//"));
        Assert.Equal(root, NodePath.Resolve(root));
        Assert.True(SourceHelper.SameFolder(root + "osu", root + "osu/"));
    }
}
