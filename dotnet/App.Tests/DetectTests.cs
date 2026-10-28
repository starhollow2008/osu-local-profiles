using System.Text;
using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Tests;

/// <summary>test/detect.test.ts and test/discover.test.ts: where osu! is, on machines this one is not.</summary>
public sealed class DetectTests : IDisposable
{
    private readonly string tmp = Directory.CreateTempSubdirectory("olp-cs-detect-").FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(tmp, recursive: true);
        }
        catch (IOException)
        {
            /* the system's to clear */
        }
    }

    private static DetectEnvironment Env(string platform, string home, params (string, string)[] vars) =>
        new(platform, home, vars.ToDictionary(v => v.Item1, v => (string?)v.Item2));

    private static readonly DetectEnvironment Windows = Env("win32", @"C:\Users\player",
        ("APPDATA", @"C:\Users\player\AppData\Roaming"), ("LOCALAPPDATA", @"C:\Users\player\AppData\Local"));

    private static readonly DetectEnvironment Linux = Env("linux", "/home/player");

    private string Folder(params string[] parts)
    {
        var p = Path.Combine([tmp, .. parts]);
        Directory.CreateDirectory(p);
        return p;
    }

    private static void Touch(string file, string text = "")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }

    private string StableAt(string root)
    {
        Directory.CreateDirectory(root);
        Touch(Path.Combine(root, "osu!.exe"));
        return root;
    }

    [Fact]
    public void Lazer_is_looked_for_where_each_platform_keeps_it_and_XDG_moves_it_unless_relative()
    {
        Assert.Contains(NodePath.Join(@"C:\Users\player\AppData\Roaming", "osu"), Detect.LazerCandidates(Windows));
        Assert.Contains(NodePath.Join("/home/player", ".local", "share", "osu"), Detect.LazerCandidates(Linux));
        Assert.Contains(NodePath.Join("/data/xdg", "osu"), Detect.LazerCandidates(Env("linux", "/home/player", ("XDG_DATA_HOME", "/data/xdg"))));
        var relative = Detect.LazerCandidates(Env("linux", "/home/player", ("XDG_DATA_HOME", "relative/path")));
        Assert.DoesNotContain(relative, p => p.Contains("relative"));
    }

    [Fact]
    public void An_install_is_recognised_by_its_marker_not_its_path()
    {
        var lazer = Folder("anywhere-at-all", "files");
        lazer = Path.GetDirectoryName(lazer)!;
        Touch(Path.Combine(lazer, "client.realm"));
        var found = Detect.LazerInstall(lazer)!;
        Assert.Equal("lazer", found.Kind);
        Assert.Equal(NodePath.Join(lazer, "files"), found.ReplayDir);
        Assert.Null(found.OnlineDb);
        Assert.False(found.Development);
        Assert.Null(Detect.StableInstall(lazer));

        var stable = StableAt(Path.Combine(tmp, "osu!"));
        Folder("osu!", "Songs");
        var s = Detect.StableInstall(stable)!;
        Assert.Equal(NodePath.Join(stable, "Data", "r"), s.ReplayDir);
        Assert.Equal([NodePath.Join(stable, "Songs")], s.BeatmapRoots);

        // `files/` alone is not lazer.
        Assert.Null(Detect.LazerInstall(Path.GetDirectoryName(Folder("decoy", "files"))!));
        // lazer's own osu!.exe, beside its runtime files or its updater, is not stable.
        var program = StableAt(Path.Combine(tmp, "osulazer", "current"));
        Touch(Path.Combine(program, "osu.Game.dll"));
        Assert.Null(Detect.StableInstall(program));
    }

    [Fact]
    public void A_moved_Songs_folder_is_read_from_stables_config_and_a_stale_one_falls_back()
    {
        var root = StableAt(Path.Combine(tmp, "stable"));
        var songs = Folder("stable", "Songs");
        Assert.Equal([songs], Detect.StableInstall(root)!.BeatmapRoots);

        var moved = Folder("stable", "Beatmaps elsewhere");
        File.WriteAllText(Path.Combine(root, "osu!.player.cfg"), "Width = 1920\r\nBeatmapDirectory = Beatmaps elsewhere\r\nVolumeUniversal = 40\r\n");
        Assert.Equal([NodePath.Join(root, "Beatmaps elsewhere")], Detect.StableInstall(root)!.BeatmapRoots);
        Assert.True(Directory.Exists(moved));

        var elsewhere = Folder("elsewhere");
        File.WriteAllText(Path.Combine(root, "osu!.player.cfg"), $"BeatmapDirectory = {elsewhere}\n");
        Assert.Equal([elsewhere], Detect.StableInstall(root)!.BeatmapRoots);

        File.WriteAllText(Path.Combine(root, "osu!.player.cfg"), "BeatmapDirectory = D:/gone\n");
        Assert.Equal([songs], Detect.StableInstall(root)!.BeatmapRoots);
    }

    [Fact]
    public void The_development_client_is_known_by_its_numbered_realm_and_looked_for_beside_lazer()
    {
        var dev = Folder("anything");
        Folder("anything", "files");
        Touch(Path.Combine(dev, "client_52.realm"));
        Assert.True(Detect.LazerInstall(dev)!.Development);
        Touch(Path.Combine(dev, "client.realm"));
        Assert.True(Detect.LazerInstall(dev)!.Development);
        Assert.True(Discover.LooksLikeInstall(["client_52.realm", "files"]));
        Assert.False(Discover.LooksLikeInstall(["client_backup.realm"]));

        foreach (var name in new[] { "osu", "osu-development-2", "osu-development", "osu-development-10", "osu-developmentx" })
        {
            Folder("home", ".local", "share", name);
        }
        var e = Env("linux", Path.Combine(tmp, "home"));
        Assert.Equal(["osu-development", "osu-development-2", "osu-development-10"], Detect.LazerDevelopmentCandidates(e).Select(NodePath.Basename));
        Assert.Empty(Detect.LazerDevelopmentCandidates(Env("linux", Path.Combine(tmp, "nope"))));
    }

    [Fact]
    public void Lazers_storage_ini_names_the_folder_it_was_moved_to()
    {
        Assert.Equal(@"D:\osu!lazer", Discover.StorageIniPath("FullPath = D:\\osu!lazer\n"));
        Assert.Equal(@"D:\lazer data", Discover.StorageIniPath("[General]\r\nFullPath = D:\\lazer data\r\n"));
        Assert.Null(Discover.StorageIniPath("Version = 1\n"));
        Assert.Null(Discover.StorageIniPath(""));
    }

    [Fact]
    public void A_path_is_pulled_out_of_whatever_shape_the_registry_stored_it_in()
    {
        var output = string.Join("\r\n",
            @"HKEY_CLASSES_ROOT\osu!\shell\open\command",
            @"    (Default)    REG_SZ    ""D:\Games\osu!\osu!\osu!.exe"" ""%1""",
            "",
            @"    (Default)    REG_SZ    D:\Games\osu!\osu!\osu!.exe,1",
            @"    InstallLocation    REG_SZ    D:\Games\osu!\osu!",
            "    DisplayName    REG_SZ    osu!");
        var paths = Discover.RegistryPaths(output);
        Assert.Contains(@"D:\Games\osu!\osu!\osu!.exe", paths);
        Assert.Contains(@"D:\Games\osu!\osu!", paths);
        Assert.DoesNotContain("osu!", paths);

        var keys = Discover.RegistryQueries();
        Assert.Contains(keys, k => k.StartsWith(@"HKCU\Software\Classes\osu!", StringComparison.Ordinal));
        Assert.Contains(keys, k => k.StartsWith(@"HKCR\osu!", StringComparison.Ordinal));
        Assert.Contains(keys, k => k.Contains(@"Uninstall\osulazer", StringComparison.Ordinal));
    }

    [Fact]
    public void A_shortcuts_target_is_read_out_of_the_bytes_in_either_encoding()
    {
        const string target = @"D:\Games\osu!\osu!\osu!.exe";
        byte[] Latin(string s) => Encoding.Latin1.GetBytes(s);
        var narrow = Latin("L\0\0\0\x01\x14\x02\0").Concat(Latin(target)).Concat(new byte[] { 0 }).Concat(Latin("\0\0padding\0\0")).ToArray();
        Assert.Equal([target], Discover.LnkTargets(narrow));
        var wide = new byte[] { 0x4c, 0 }.Concat(Encoding.Unicode.GetBytes(target)).ToArray();
        Assert.Equal([target], Discover.LnkTargets(wide));
        Assert.Empty(Discover.LnkTargets(Latin(@"C:\Windows\notepad.exe")));

        Assert.Contains(NodePath.Join(@"C:\Users\player", "Desktop"), Discover.ShortcutDirs(Windows));
        Assert.Empty(Discover.ShortcutDirs(Linux));
    }

    [Fact]
    public void The_search_stops_at_an_install_respects_its_limits_and_skips_what_it_cannot_read()
    {
        var root = StableAt(Path.Combine(tmp, "walk", "osu!"));
        StableAt(Path.Combine(root, "Data", "inner"));
        Assert.Equal([root], Discover.ScanForInstalls([Path.Combine(tmp, "walk"), Path.Combine(tmp, "does-not-exist")]));

        var deep = StableAt(Path.Combine(tmp, "deep", "a", "b", "c", "d", "e", "f", "g"));
        var start = Path.Combine(tmp, "deep");
        Assert.Empty(Discover.ScanForInstalls([start], ScanLimits.Default with { MaxDepth = 3 }));
        Assert.Equal([deep], Discover.ScanForInstalls([start], ScanLimits.Default with { MaxDepth = 8 }));
        Assert.Empty(Discover.ScanForInstalls([start], ScanLimits.Default with { TimeBudgetMs = -1 }));
        Assert.Empty(Discover.ScanForInstalls([start], ScanLimits.Default with { MaxDirs = 0 }));
    }

    [Fact]
    public void The_walk_skips_what_is_enormous_by_nature_and_recognises_an_install_from_names()
    {
        foreach (var name in new[] { "Songs", "files", "Windows", "node_modules", "$Recycle.Bin", ".git", "SONGS" }) Assert.True(Discover.SkipDir(name), name);
        foreach (var name in new[] { "Games", "Data", "Apps", "osu!", "Program Files", ".minecraft" }) Assert.False(Discover.SkipDir(name), name);
        Assert.True(Discover.LooksLikeInstall(["osu!.exe", "Songs"]));
        Assert.True(Discover.LooksLikeInstall(["OSU!.EXE"]));
        Assert.False(Discover.LooksLikeInstall(["Songs", "Skins"]));
    }

    [Fact]
    public async Task A_configured_root_wins_and_one_client_found_is_not_a_reason_to_stop()
    {
        var stable = StableAt(Path.Combine(tmp, "somewhere", "weird", "osu!"));
        var e = Env("linux", Path.Combine(tmp, "emptyhome"));
        var result = await Discover.Run([stable], [], Path.Combine(tmp, "mcosu"), env: e,
            limits: new ScanLimits(3, 1000, 5000));
        Assert.Equal([("stable", stable)], result.Installs.Select(i => (i.Kind, i.Root)));
        Assert.Equal("configured", result.Candidates[0].Source);
        // lazer is still missing, so the search ran.
        Assert.True(result.Searched);
        var quiet = await Discover.Run([stable], [], Path.Combine(tmp, "mcosu"), noSearch: true, env: e);
        Assert.False(quiet.Searched);
        // A configured root that holds nothing is ignored, not fatal.
        Assert.Empty((await Discover.Run([Path.Combine(tmp, "nothing")], [], "", noSearch: true, env: e)).Installs);
    }
}
