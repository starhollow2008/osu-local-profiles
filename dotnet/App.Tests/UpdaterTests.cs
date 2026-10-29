using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Text;
using OsuLocalProfiles.Update;

namespace OsuLocalProfiles.Tests;

/// <summary>test/update.test.ts and test/update-notes.test.ts: the update check, a release's checks, and the startup sweep.</summary>
public sealed class UpdaterTests : IDisposable
{
    private readonly List<string> made = [];

    public void Dispose()
    {
        foreach (var dir in made) Directory.Delete(dir, recursive: true);
    }

    private string Tmp()
    {
        var dir = Directory.CreateTempSubdirectory("olp-cs-update-").FullName;
        made.Add(dir);
        return dir;
    }

    private static Updater For(string dir, string version = "1.26.0", Func<string, HttpResponseMessage>? github = null, string platform = "win32") =>
        new(dir, Path.Combine(dir, "data"), () => version, () => false, () => true,
            handler: github is null ? null : new FakeOsu(github), platform: platform, arch: "x64");

    [Fact]
    public void A_GitHub_remote_is_recognised_in_either_form_and_nothing_else_is()
    {
        Assert.Equal("jonathant09/osu-local-profiles", Updater.ParseRepo("git+https://github.com/jonathant09/osu-local-profiles.git"));
        Assert.Equal("jonathant09/osu-local-profiles", Updater.ParseRepo("git@github.com:jonathant09/osu-local-profiles.git"));
        Assert.Null(Updater.ParseRepo("https://gitlab.com/someone/thing.git"));
        Assert.Null(Updater.ParseRepo(null));
    }

    [Fact]
    public void Each_platform_looks_for_the_archive_the_packager_would_have_named()
    {
        Assert.Equal("osu-local-profiles-1.5.0-win-x64.zip", Updater.AssetNameFor("1.5.0", "win32", "x64"));
        Assert.Equal("osu-local-profiles-1.5.0-osx-arm64.zip", Updater.AssetNameFor("1.5.0", "darwin", "arm64"));
        Assert.Equal("osu-local-profiles-1.5.0-linux-x64.zip", Updater.AssetNameFor("1.5.0", "linux", "x64"));
        var release = new Release("1.5.0", "https://example.invalid", [new ReleaseAsset("osu-local-profiles-1.5.0-win-x64.zip", "https://example.invalid", 1)], "", null);
        Assert.Equal("osu-local-profiles-1.5.0-win-x64.zip", Updater.AssetFor(release, "win32", "x64")?.Name);
        Assert.Null(Updater.AssetFor(release, "darwin", "arm64"));
    }

    /// <summary>A zip as a Unix <c>zip</c> writes one, mode in the top bits of the external attributes, or with backslashes.</summary>
    private static byte[] MakeZip(params (string Name, byte[] Data, int? Mode)[] files)
    {
        using var locals = new MemoryStream();
        using var central = new MemoryStream();
        foreach (var (fileName, data, mode) in files)
        {
            var name = Encoding.UTF8.GetBytes(fileName);
            using var deflated = new MemoryStream();
            using (var d = new DeflateStream(deflated, CompressionLevel.Optimal, leaveOpen: true)) d.Write(data);
            var body = deflated.ToArray();
            var offset = (uint)locals.Length;
            var local = new byte[30];
            BinaryPrimitives.WriteUInt32LittleEndian(local, 0x04034b50);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(8), 8);
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(18), (uint)body.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(22), (uint)data.Length);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(26), (ushort)name.Length);
            locals.Write(local);
            locals.Write(name);
            locals.Write(body);
            var entry = new byte[46];
            BinaryPrimitives.WriteUInt32LittleEndian(entry, 0x02014b50);
            if (mode is { } m)
            {
                BinaryPrimitives.WriteUInt16LittleEndian(entry.AsSpan(4), (3 << 8) | 30);
                BinaryPrimitives.WriteUInt32LittleEndian(entry.AsSpan(38), (uint)((0x8000 | m) << 16));
            }
            BinaryPrimitives.WriteUInt16LittleEndian(entry.AsSpan(10), 8);
            BinaryPrimitives.WriteUInt32LittleEndian(entry.AsSpan(20), (uint)body.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(entry.AsSpan(24), (uint)data.Length);
            BinaryPrimitives.WriteUInt16LittleEndian(entry.AsSpan(28), (ushort)name.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(entry.AsSpan(42), offset);
            central.Write(entry);
            central.Write(name);
        }
        var eocd = new byte[22];
        BinaryPrimitives.WriteUInt32LittleEndian(eocd, 0x06054b50);
        BinaryPrimitives.WriteUInt16LittleEndian(eocd.AsSpan(8), (ushort)files.Length);
        BinaryPrimitives.WriteUInt16LittleEndian(eocd.AsSpan(10), (ushort)files.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(eocd.AsSpan(12), (uint)central.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(eocd.AsSpan(16), (uint)locals.Length);
        return [.. locals.ToArray(), .. central.ToArray(), .. eocd];
    }

    [Fact]
    public void A_release_unpacks_with_its_folder_stripped_its_separators_read_and_its_execute_bits_kept()
    {
        var dir = Tmp();
        var archive = Path.Combine(dir, "release.zip");
        File.WriteAllBytes(archive, MakeZip(
            ("osu-local-profiles-2.0.0-linux-x64\\package.json", "{}"u8.ToArray(), null),
            ("osu-local-profiles-2.0.0-linux-x64/app/osu-local-profiles-app", "binary"u8.ToArray(), 0x1ed)));
        var entries = Zip.ReadEntries(File.ReadAllBytes(archive));
        Assert.Equal("osu-local-profiles-2.0.0-linux-x64/package.json", entries[0].Name);
        Assert.Equal(0x1ed, entries[1].Mode);
        Assert.Null(entries[0].Mode);
        Assert.Equal(2, Zip.Extract(archive, Path.Combine(dir, "out"), 1));
        Assert.Equal("binary", File.ReadAllText(Path.Combine(dir, "out", "app", "osu-local-profiles-app")));

        File.WriteAllBytes(archive, MakeZip(("../../escape.txt", "no"u8.ToArray(), null)));
        Assert.StartsWith("refusing entry with an unsafe path", Assert.Throws<InvalidOperationException>(() => Zip.Extract(archive, Path.Combine(dir, "out"))).Message);
        Assert.StartsWith("not a zip file", Assert.Throws<InvalidOperationException>(() => Zip.ReadEntries("not a zip at all, honestly"u8.ToArray())).Message);
    }

    [Fact]
    public void Only_a_packaged_build_can_be_updated_never_a_source_checkout()
    {
        var dir = Tmp();
        Assert.Contains("not a packaged build", For(dir).BlockedReason());
        Directory.CreateDirectory(Path.Combine(dir, "app"));
        File.WriteAllText(Path.Combine(dir, "app", "osu-local-profiles-app.exe"), "");
        Assert.Null(For(dir).BlockedReason());
        // The same layout elsewhere looks for the app with no extension.
        Assert.Contains("not a packaged build", For(dir, platform: "linux").BlockedReason());
        Directory.CreateDirectory(Path.Combine(dir, ".git"));
        Assert.Contains("source checkout", For(dir).BlockedReason());
    }

    [Fact]
    public void Startup_clears_both_things_an_update_leaves_behind_and_keeps_a_build_still_waiting()
    {
        var dir = Tmp();
        var data = Path.Combine(dir, "data");
        Directory.CreateDirectory(Path.Combine(dir, ".rollback-2026-01-01T00-00-00"));
        File.WriteAllText(Path.Combine(dir, ".rollback-2026-01-01T00-00-00", "node.exe"), "old runtime");
        Directory.CreateDirectory(Path.Combine(data, "update", "1.4.0"));
        File.WriteAllText(Path.Combine(data, "update", "1.4.0", "node.exe"), "staged runtime");
        File.WriteAllText(Path.Combine(data, "profiles.db"), "PRECIOUS");
        File.WriteAllText(Path.Combine(data, "update.log"), "OK: updated to 1.4.0");
        var (removed, bytes) = For(dir).PruneLeftovers();
        Assert.Equal(2, removed.Count);
        Assert.True(bytes > 0);
        Assert.False(Directory.Exists(Path.Combine(data, "update")));
        Assert.Equal("PRECIOUS", File.ReadAllText(Path.Combine(data, "profiles.db")));
        Assert.Equal("OK: updated to 1.4.0", File.ReadAllText(Path.Combine(data, "update.log")));
        Assert.Empty(For(dir).PruneLeftovers().Removed);
        Assert.Empty(For(Path.Combine(dir, "gone")).PruneLeftovers().Removed);

        // A build downloaded ahead of time is kept while it is newer.
        Directory.CreateDirectory(Path.Combine(data, "update", "999.0.0"));
        File.WriteAllText(Path.Combine(data, "update", "999.0.0", "package.json"), """{"version":"999.0.0"}""");
        File.WriteAllText(Path.Combine(data, "update", "ready.json"), """{"version":"999.0.0","requested":"auto","attempts":0}""");
        Directory.CreateDirectory(Path.Combine(data, "update", "1.0.0"));
        File.WriteAllText(Path.Combine(data, "update", "osu-local-profiles-1.0.0-win-x64.zip"), "an old download");
        Assert.Equal(2, For(dir).PruneLeftovers().Removed.Count);
        Assert.True(File.Exists(Path.Combine(data, "update", "999.0.0", "package.json")));
        Assert.True(File.Exists(Path.Combine(data, "update", "ready.json")));
        // Once what waits is this version or older, it is a leftover like any other.
        For(dir, version: "999.0.0").PruneLeftovers();
        Assert.False(Directory.Exists(Path.Combine(data, "update")));
    }

    [Fact]
    public void An_update_check_is_due_once_a_day_or_an_hour_after_one_that_failed()
    {
        var now = Js.DateParse("2026-09-26T12:00:00Z");
        string Ago(double ms) => DateTimeOffset.FromUnixTimeMilliseconds((long)(now - ms)).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        Assert.True(Updater.CheckDue(null, null, now));
        Assert.False(Updater.CheckDue(Ago(Updater.CheckEveryMs - 60_000), null, now));
        Assert.True(Updater.CheckDue(Ago(Updater.CheckEveryMs), null, now));
        Assert.False(Updater.CheckDue(Ago(Updater.RetryFailedMs - 60_000), "offline", now));
        Assert.True(Updater.CheckDue(Ago(Updater.RetryFailedMs), "offline", now));
        Assert.True(Updater.CheckDue(Ago(-Updater.CheckEveryMs), null, now));
    }

    private static string ReleaseJson(string tag, params string[] assets) =>
        $$"""{"tag_name":"{{tag}}","html_url":"https://github.com/x/y/releases/{{tag}}","body":"- One thing\n- Another\n\nEverything in this release\n- not this","published_at":"2026-01-01T00:00:00Z","assets":[{{string.Join(",", assets.Select(a => $$"""{"name":"{{a}}","browser_download_url":"https://example.invalid/{{a}}","size":5}"""))}}]}""";

    [Fact]
    public async Task A_check_finds_a_newer_release_built_for_this_platform_and_offers_it_only_where_it_can_be_installed()
    {
        var dir = Tmp();
        File.WriteAllText(Path.Combine(dir, "package.json"), """{"version":"1.26.0","repository":{"url":"git+https://github.com/x/y.git"}}""");
        var github = (string url) => url.EndsWith("/releases/latest", StringComparison.Ordinal)
            ? FakeOsu.Answer(ReleaseJson("v1.27.0", "osu-local-profiles-1.27.0-win-x64.zip"))
            : FakeOsu.Answer($"[{ReleaseJson("v1.27.0", "osu-local-profiles-1.27.0-win-x64.zip")},{ReleaseJson("v1.26.0")}]");
        var updater = For(dir, github: github);
        var found = new List<bool>();
        updater.Changed += (_, f) => found.Add(f);
        var state = await updater.CheckForUpdate();
        Assert.True(state.Available);
        Assert.Equal("1.27.0", state.LatestVersion);
        Assert.Equal(["One thing", "Another"], Assert.Single(state.Notes).Highlights);
        Assert.Equal("https://github.com/x/y/blob/main/CHANGELOG.md", state.ChangelogUrl);
        // Not a packaged build, so nothing is offered to the tray, and found once only.
        Assert.Null(updater.OfferedVersion());
        Directory.CreateDirectory(Path.Combine(dir, "app"));
        File.WriteAllText(Path.Combine(dir, "app", "osu-local-profiles-app.exe"), "");
        await updater.CheckForUpdate();
        Assert.Equal("1.27.0", updater.OfferedVersion());
        await updater.CheckForUpdate();
        Assert.Equal([false, true, false], found);

        // A newer release with no build here is not an update here.
        var mac = For(dir, platform: "darwin", github: github);
        var macState = await mac.CheckForUpdate();
        Assert.False(macState.Available);
        Assert.Equal("1.27.0 has no build for darwin-x64", macState.Error);

        var limited = For(dir, github: _ => FakeOsu.Answer("", HttpStatusCode.Forbidden));
        Assert.Equal("GitHub rate limit reached; try again later", (await limited.CheckForUpdate()).Error);
    }

    private string StagedBuild(string kind, string platform, string version = "2.0.0")
    {
        var dir = Tmp();
        void Put(string rel)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(dir, rel))!);
            File.WriteAllText(Path.Combine(dir, rel), "");
        }
        File.WriteAllText(Path.Combine(dir, "package.json"), $$"""{"version":"{{version}}"}""");
        Put(Path.Combine("web", "index.html"));
        Put(Updater.LauncherExecutableFor(platform));
        if (kind == "native")
        {
            Put(Updater.NativeAppFor(platform));
        }
        else
        {
            Put(Path.Combine("src", "main.ts"));
            Put(Path.Combine("scripts", "apply-update.mjs"));
            if (kind == "node") Put(platform == "win32" ? "node.exe" : "node");
        }
        return dir;
    }

    [Fact]
    public void A_release_of_either_kind_is_checked_and_installed_by_its_own_swapper_on_every_platform()
    {
        foreach (var platform in new[] { "win32", "darwin", "linux" })
        {
            var native = StagedBuild("native", platform);
            Updater.VerifyStaged(native, "2.0.0", platform);
            Assert.Equal((Path.Combine(native, Updater.LauncherExecutableFor(platform)), "--apply-update"),
                Updater.SwapperFor(native, platform) is { } s ? (s.Command, string.Join(" ", s.Args)) : default);
            Assert.Contains("says it is 2.0.0", Assert.Throws<InvalidOperationException>(() => Updater.VerifyStaged(native, "2.0.1", platform)).Message);
            File.Delete(Path.Combine(native, Updater.LauncherExecutableFor(platform)));
            Assert.Contains("has no osu", Assert.Throws<InvalidOperationException>(() => Updater.VerifyStaged(native, "2.0.0", platform)).Message);

            var node = StagedBuild("node", platform);
            Updater.VerifyStaged(node, "2.0.0", platform);
            var runtime = platform == "win32" ? "node.exe" : "node";
            Assert.Equal(Path.Combine(node, runtime), Updater.SwapperFor(node, platform)?.Command);
            var broken = StagedBuild("broken-node", platform);
            Assert.Contains($"has no {runtime}", Assert.Throws<InvalidOperationException>(() => Updater.VerifyStaged(broken, "2.0.0", platform)).Message);
        }
    }

    [Fact]
    public async Task A_release_downloads_ahead_of_time_when_data_update_does_not_exist_yet()
    {
        // As every C# install is after its first start: the startup sweep took data/update away.
        var dir = Tmp();
        File.WriteAllText(Path.Combine(dir, "package.json"), """{"version":"1.26.0","repository":{"url":"git+https://github.com/x/y.git"}}""");
        Directory.CreateDirectory(Path.Combine(dir, "app"));
        File.WriteAllText(Path.Combine(dir, "app", "osu-local-profiles-app.exe"), "");
        const string folder = "osu-local-profiles-1.27.0-win-x64/";
        var zip = MakeZip([
            (folder + "package.json", """{"version":"1.27.0"}"""u8.ToArray(), null),
            (folder + "web/index.html", "<p></p>"u8.ToArray(), null),
            (folder + Updater.LauncherExecutableFor("win32"), "launcher"u8.ToArray(), null),
            (folder + Updater.NativeAppFor("win32"), "app"u8.ToArray(), null),
            .. Enumerable.Range(0, 8).Select(i => (folder + $"web/{i}.js", "x"u8.ToArray(), (int?)null)),
        ]);
        const string asset = "osu-local-profiles-1.27.0-win-x64.zip";
        var updater = For(dir, github: url =>
            url.EndsWith("/releases/latest", StringComparison.Ordinal)
                ? FakeOsu.Answer(ReleaseJson("v1.27.0", asset).Replace("\"size\":5", $"\"size\":{zip.Length}"))
                : url.EndsWith(asset, StringComparison.Ordinal)
                    ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(zip) }
                    : FakeOsu.Answer("[]"));
        Assert.False(Directory.Exists(Path.Combine(dir, "data", "update")));
        await updater.CheckForUpdate();
        await updater.PrepareUpdate("user");
        Assert.True(File.Exists(Path.Combine(dir, "data", "update", "1.27.0", Updater.NativeAppFor("win32"))));
        Assert.Contains("\"version\":\"1.27.0\"", File.ReadAllText(Path.Combine(dir, "data", "update", "ready.json")));
    }

    [Fact]
    public void Notes_come_from_a_release_page_and_an_update_is_said_above_the_page_only_when_it_matters()
    {
        var notes = Notes.FromBody($"- One\r\n- Two\r\n{Notes.ImportantMark}\r\nEverything in this release\r\n- Not this", "1.2.3", "2026-03-04T05:06:07Z");
        var one = Assert.Single(notes);
        Assert.Equal(["One", "Two"], one.Highlights);
        Assert.True(one.Important);
        Assert.Equal("2026-03-04", one.Date);
        var now = Js.DateParse("2026-03-30T00:00:00Z");
        Assert.Equal("important", Notes.NudgeFor(notes, now));
        Assert.Equal("behind", Notes.NudgeFor([one with { Important = false }], now));
        Assert.Null(Notes.NudgeFor([one with { Important = false, Date = "2026-03-20" }], now));
        Assert.Null(Notes.NudgeFor([], now));
    }
}
