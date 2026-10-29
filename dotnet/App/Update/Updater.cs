using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Update;

internal sealed record ReleaseAsset(string Name, string Url, double Size);

/// <summary>A GitHub release: its version (the tag without a leading <c>v</c>), page, archives and notes.</summary>
internal sealed record Release(string Version, string ReleaseUrl, List<ReleaseAsset> Assets, string Body, string? PublishedAt);

/// <summary>What the updater knows, as the page reads it: src/update/index.ts's <c>UpdateState</c>, in its order.</summary>
internal sealed record UpdateState(
    string? CurrentVersion, string? LatestVersion, bool Available, string? ReleaseUrl, string? Blocked, string? Error, string? CheckedAt,
    bool Applying, List<VersionNotes> Notes, string ChangelogUrl, string? Nudge, string? Ready, bool InstallOnQuit, bool Preparing,
    string? PrepareError, double? DownloadedBytes, bool? Metered, bool AutoUpdate);

/// <summary>A staged build handed to its swapper, and what this process exits with so the swap can begin.</summary>
internal sealed record ApplyResult(string Version, string StagedDir, int ExitCode);

/// <summary>
/// The one-click update: src/update/index.ts and src/update/github.ts. Three things keep it safe:
/// <c>data/</c> is never touched, nothing is deleted while it could still be needed (the swap moves
/// what it replaces aside), and nothing is swapped until the new build is verified on disk. It
/// refuses to run in a source checkout. A build can also be downloaded ahead of time and wait,
/// checked, in <c>data/update/&lt;version&gt;</c>, to be installed when the app is quit or next starts.
/// </summary>
internal sealed partial class Updater
{
    public const int RestartExitCode = 75;
    public const string SwapperPidFile = "swapper.pid";
    private const string ReadyFile = "ready.json";

    /// <summary>How often a running app asks GitHub again, and an hour after a check that failed.</summary>
    public const double CheckEveryMs = 24 * 60 * 60_000;
    public const double RetryFailedMs = 60 * 60_000;
    private static readonly TimeSpan LookEvery = TimeSpan.FromMinutes(10);

    private readonly object gate = new();
    private readonly string installDir;
    private readonly string dataDir;
    private readonly Func<string?> version;
    private readonly Func<bool> autoUpdate;
    private readonly Func<bool> checking;
    private readonly Func<string, string?> env;
    private readonly HttpClient http;
    private readonly string platform;
    private readonly string arch;

    // The state, as UpdateState lists it.
    private string? latestVersion, releaseUrl, blocked, error, checkedAt, nudge, ready, prepareError;
    private bool available, applying, installOnQuit, preparingNow;
    private bool? metered;
    private double? downloadedBytes;
    private List<VersionNotes> notes = [];
    private string changelogUrl = Notes.ChangelogUrl;

    private string? announced;
    private (string Version, List<VersionNotes> Notes)? notesCache;
    private Task? preparing;
    private (string? Version, double At)? failedPrepare;

    /// <summary>Who hears when anything changes: the live feed. <c>found</c> is set once per version.</summary>
    public event Action<UpdateState, bool>? Changed;

    public Updater(string installDir, string dataDir, Func<string?> version, Func<bool> autoUpdate, Func<bool> checking,
        Func<string, string?>? env = null, HttpMessageHandler? handler = null, string? platform = null, string? arch = null)
    {
        this.installDir = installDir;
        this.dataDir = dataDir;
        this.version = version;
        this.autoUpdate = autoUpdate;
        this.checking = checking;
        this.env = env ?? Environment.GetEnvironmentVariable;
        http = new HttpClient(handler ?? new SocketsHttpHandler { AllowAutoRedirect = true }) { Timeout = Timeout.InfiniteTimeSpan };
        this.platform = platform ?? Browser.Platform;
        this.arch = arch ?? (RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64");
        RefreshReady();
    }

    public UpdateState State()
    {
        lock (gate)
        {
            return new UpdateState(version(), latestVersion, available, releaseUrl, blocked, error, checkedAt, applying, [.. notes], changelogUrl,
                nudge, ready, installOnQuit, preparingNow, prepareError, downloadedBytes, metered, autoUpdate());
        }
    }

    /// <summary>The version to offer, or null: newer, built for this platform, and an install that can take it.</summary>
    public string? OfferedVersion()
    {
        lock (gate) return available && blocked is null ? latestVersion : null;
    }

    private void Announce()
    {
        var offered = OfferedVersion();
        bool found;
        lock (gate)
        {
            found = offered is not null && offered != announced;
            if (found) announced = offered;
        }
        Changed?.Invoke(State(), found);
    }

    /* --------------------------------------------------------------- the install */

    /// <summary>The repository to check, from package.json.</summary>
    public string? RepoFromPackage()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(installDir, "package.json")));
            var repository = Js.Get(doc.RootElement, "repository");
            var url = Js.IsString(repository, out var text) ? text : Js.IsString(Js.Get(repository, "url"), out var inner) ? inner : null;
            return ParseRepo(url);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?\z")]
    private static partial Regex GithubRemote();

    /// <summary><c>https://github.com/owner/repo.git</c> to <c>owner/repo</c>; null when it is not a GitHub URL.</summary>
    public static string? ParseRepo(string? url)
    {
        if (url is null) return null;
        var m = GithubRemote().Match(Js.Trim(url));
        return m.Success ? $"{m.Groups[1].Value}/{m.Groups[2].Value}" : null;
    }

    /// <summary>
    /// Why this install cannot take an update, or null. A source checkout has <c>.git</c>; a package
    /// carries its own runtime, which for this app is <see cref="NativeAppFor"/>. Either alone would be fooled.
    /// </summary>
    public string? BlockedReason()
    {
        if (Directory.Exists(Path.Combine(installDir, ".git")) || File.Exists(Path.Combine(installDir, ".git")))
        {
            return "this copy is running from a source checkout; update it with git instead";
        }
        if (!File.Exists(Path.Combine(installDir, NativeAppFor(platform)))) return "this copy is not a packaged build, so there is nothing to replace";
        return null;
    }

    /// <summary>The archive this platform would install, named as scripts/package.mjs names it.</summary>
    public static string AssetNameFor(string releaseVersion, string platform, string arch)
    {
        var cpu = arch == "arm64" ? "arm64" : "x64";
        var os = platform == "win32" ? "win" : platform == "darwin" ? "osx" : "linux";
        return $"osu-local-profiles-{releaseVersion}-{os}-{cpu}.zip";
    }

    public static ReleaseAsset? AssetFor(Release release, string platform, string arch)
    {
        var wanted = Js.ToLower(AssetNameFor(release.Version, platform, arch));
        return release.Assets.FirstOrDefault(a => Js.ToLower(a.Name) == wanted);
    }

    /// <summary>What each platform's package opens (scripts/package-files.mjs, <c>trayLauncherFor</c>).</summary>
    public static string LauncherNameFor(string platform) => platform switch
    {
        "win32" => "osu! local profiles.exe",
        "darwin" => "osu! local profiles.app",
        _ => "osu-local-profiles",
    };

    /// <summary>The launcher's own executable: inside the bundle on macOS.</summary>
    public static string LauncherExecutableFor(string platform) =>
        platform == "darwin" ? Path.Combine("osu! local profiles.app", "Contents", "MacOS", "osu-local-profiles") : LauncherNameFor(platform);

    /// <summary>The app a release without Node carries, whose presence is what marks such a build.</summary>
    public static string NativeAppFor(string platform) => Path.Combine("app", platform == "win32" ? "osu-local-profiles-app.exe" : "osu-local-profiles-app");

    /// <summary>Whether a staged tree is a whole release of either kind, at the version expected.</summary>
    public static void VerifyStaged(string dir, string expectedVersion, string platform)
    {
        var native = File.Exists(Path.Combine(dir, NativeAppFor(platform)));
        foreach (var entry in native ? new[] { "package.json", "web" } : ["package.json", "src", "web"])
        {
            if (!File.Exists(Path.Combine(dir, entry)) && !Directory.Exists(Path.Combine(dir, entry)))
            {
                throw new InvalidOperationException($"the downloaded build has no {entry}");
            }
        }
        var runtime = platform == "win32" ? "node.exe" : "node";
        if (!native && !File.Exists(Path.Combine(dir, runtime))) throw new InvalidOperationException($"the downloaded build has no {runtime}");
        var launcher = LauncherNameFor(platform);
        bool Exists(string p) => File.Exists(p) || Directory.Exists(p);
        if (!Exists(Path.Combine(dir, launcher)) || (native && !Exists(Path.Combine(dir, LauncherExecutableFor(platform)))))
        {
            throw new InvalidOperationException($"the downloaded build has no {launcher}");
        }
        string claimed;
        using (var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "package.json"))))
        {
            var v = Js.Get(doc.RootElement, "version");
            if (Js.IsString(v, out var text) && text == expectedVersion) return;
            claimed = v is { } value ? Js.ToJsString(value) : "undefined";
        }
        throw new InvalidOperationException($"the downloaded build says it is {claimed}, not {expectedVersion}");
    }

    /* ------------------------------------------------------------------- GitHub */

    /// <summary>One request to GitHub's releases API, its failures named for what they mean here.</summary>
    private async Task<JsonElement> GithubApi(string repo, string pathname, TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repo}{pathname}");
        request.Headers.TryAddWithoutValidation("accept", "application/vnd.github+json");
        // GitHub rejects an API request with no user agent.
        request.Headers.TryAddWithoutValidation("user-agent", "osu-local-profiles");
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, cancel.Token);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new InvalidOperationException(e is TaskCanceledException ? "The operation was aborted due to timeout" : "fetch failed");
        }
        var status = (int)response.StatusCode;
        if (status == 404) throw new InvalidOperationException($"{repo} has no published releases, or is private");
        if (status is 403 or 429) throw new InvalidOperationException("GitHub rate limit reached; try again later");
        if (status is < 200 or > 299) throw new InvalidOperationException($"GitHub answered {status}");
        var text = await response.Content.ReadAsStringAsync(cancel.Token);
        return JsonText.TryParse(text, out var parsed) ? parsed : throw new InvalidOperationException("GitHub answered with something that is not JSON");
    }

    /// <summary>A release as the API describes it, or null for a draft, a pre-release or one with no tag.</summary>
    private static Release? ReleaseFrom(JsonElement raw, string repo)
    {
        if (!Js.IsString(Js.Get(raw, "tag_name"), out var tag) || Js.Get(raw, "draft") is { ValueKind: JsonValueKind.True }
            || Js.Get(raw, "prerelease") is { ValueKind: JsonValueKind.True })
        {
            return null;
        }
        var assets = new List<ReleaseAsset>();
        if (Js.Get(raw, "assets") is { ValueKind: JsonValueKind.Array } list)
        {
            foreach (var a in list.EnumerateArray())
            {
                if (!Js.IsString(Js.Get(a, "name"), out var name) || !Js.IsString(Js.Get(a, "browser_download_url"), out var url)) continue;
                assets.Add(new ReleaseAsset(name, url, Js.Get(a, "size") is { ValueKind: JsonValueKind.Number } n ? Js.NumberOf(n) : 0));
            }
        }
        return new Release(
            tag.StartsWith('v') ? tag[1..] : tag,
            Js.IsString(Js.Get(raw, "html_url"), out var page) ? page : $"https://github.com/{repo}/releases",
            assets,
            Js.IsString(Js.Get(raw, "body"), out var body) ? body : "",
            Js.IsString(Js.Get(raw, "published_at"), out var published) ? published : null);
    }

    public async Task<Release> FetchLatestRelease(string repo) =>
        ReleaseFrom(await GithubApi(repo, "/releases/latest", TimeSpan.FromSeconds(10)), repo) ?? throw new InvalidOperationException("the release has no tag");

    public async Task<List<Release>> FetchRecentReleases(string repo, int count = 30)
    {
        var list = await GithubApi(repo, $"/releases?per_page={count}", TimeSpan.FromSeconds(15));
        if (list.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("GitHub did not answer with a list of releases");
        return [.. list.EnumerateArray().Select(raw => ReleaseFrom(raw, repo)).Where(r => r is not null).Select(r => r!)];
    }

    /// <summary>Each newest version's notes, from the recent releases' own pages, fetched once per version.</summary>
    private async Task<List<VersionNotes>> ReleaseNotesFor(string repo, Release release)
    {
        if (notesCache is { } cached && cached.Version == release.Version) return cached.Notes;
        List<Release> releases = [release];
        try
        {
            releases = await FetchRecentReleases(repo);
        }
        catch (InvalidOperationException)
        {
            /* the newest alone */
        }
        var all = releases.SelectMany(r => Notes.FromBody(r.Body, r.Version, r.PublishedAt)).ToList();
        notesCache = (release.Version, all);
        return all;
    }

    /* -------------------------------------------------------------------- check */

    /// <summary>Ask GitHub what the newest release is. Failure is recorded, never thrown: no network is ordinary here.</summary>
    public async Task<UpdateState> CheckForUpdate()
    {
        lock (gate)
        {
            blocked = BlockedReason();
            error = null;
        }
        var repo = RepoFromPackage();
        if (repo is null)
        {
            lock (gate)
            {
                error = "no GitHub repository is recorded in package.json";
                checkedAt = IsoNow();
            }
            Announce();
            return State();
        }
        lock (gate) changelogUrl = $"https://github.com/{repo}/blob/main/CHANGELOG.md";
        try
        {
            var release = await FetchLatestRelease(repo);
            var current = version();
            var newer = current is not null && Notes.CompareVersions(current, release.Version) < 0;
            var asset = AssetFor(release, platform, arch);
            var found = newer && asset is not null
                ? Notes.Between(await ReleaseNotesFor(repo, release), current, release.Version)
                : [];
            lock (gate)
            {
                latestVersion = release.Version;
                releaseUrl = release.ReleaseUrl;
                // A newer release with no build for this platform is not an update here.
                if (newer && asset is null)
                {
                    available = false;
                    error = $"{release.Version} has no build for {platform}-{arch}";
                }
                else
                {
                    available = newer;
                }
                notes = found;
                nudge = Notes.NudgeFor(notes, Js.Now());
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            lock (gate)
            {
                error = e.Message;
                available = false;
            }
        }
        lock (gate) checkedAt = IsoNow();
        RefreshReady();
        Announce();
        MaybePrepare();
        return State();
    }

    private static string IsoNow() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A check is due once a day, an hour after one that failed, and at once after a clock set backwards.</summary>
    public static bool CheckDue(string? checkedAt, string? error, double now)
    {
        if (checkedAt is null) return true;
        var last = Js.DateParse(checkedAt);
        if (!double.IsFinite(last) || last > now) return true;
        return now - last >= (error is null ? CheckEveryMs : RetryFailedMs);
    }

    /// <summary>
    /// Check now, and whenever one is due, for as long as the app runs, by the wall clock: a timer
    /// does not count time asleep. Nothing is asked while checking is off. Disposing stops it.
    /// </summary>
    public IDisposable KeepChecking(Func<Task>? check = null)
    {
        var inFlight = 0;
        void Look()
        {
            string? at, failed;
            lock (gate) (at, failed) = (checkedAt, error);
            if (applying || !checking() || !CheckDue(at, failed, Js.Now())) return;
            if (Interlocked.Exchange(ref inFlight, 1) == 1) return;
            _ = (check ?? (() => CheckForUpdate()))().ContinueWith(_ => Interlocked.Exchange(ref inFlight, 0), TaskScheduler.Default);
        }
        Look();
        return new Timer(_ => Look(), null, LookEvery, LookEvery);
    }

    /* ---------------------------------------------------------------- downloads */

    /// <summary>One file from a release, whole, in memory, its size checked before anything is unpacked.</summary>
    private async Task<byte[]> Download(string url, double size, TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("user-agent", "osu-local-profiles");
        var response = await http.SendAsync(request, cancel.Token);
        if ((int)response.StatusCode is < 200 or > 299)
        {
            throw new InvalidOperationException($"downloading {Path.GetFileName(new Uri(url).AbsolutePath)} failed ({(int)response.StatusCode})");
        }
        var bytes = await response.Content.ReadAsByteArrayAsync(cancel.Token);
        if (size > 0 && bytes.Length != size) throw new InvalidOperationException($"the download was {bytes.Length} bytes, expected {Js.NumberToString(size)}");
        return bytes;
    }

    /// <summary>Download, unpack and check a release into <c>data/update/&lt;version&gt;</c>.</summary>
    private async Task<string> Stage(Release release)
    {
        var work = Path.Combine(dataDir, "update");
        var staged = Path.Combine(work, release.Version);
        Directory.CreateDirectory(work);
        if (Directory.Exists(staged)) Directory.Delete(staged, recursive: true);
        var asset = AssetFor(release, platform, arch) ?? throw new InvalidOperationException($"{release.Version} has no build for {platform}-{arch}");
        var bytes = await Download(asset.Url, asset.Size, TimeSpan.FromMinutes(30));
        var archive = Path.Combine(work, asset.Name);
        File.WriteAllBytes(archive, bytes);
        try
        {
            var written = Zip.Extract(archive, staged, 1);
            if (written < 10) throw new InvalidOperationException($"the archive held only {written} files");
        }
        finally
        {
            File.Delete(archive);
        }
        VerifyStaged(staged, release.Version, platform);
        lock (gate) downloadedBytes = bytes.Length;
        Console.WriteLine($"  update: {release.Version} downloaded ({bytes.Length / 1024.0 / 1024.0:F1}MB) and checked");
        return staged;
    }

    /* ---------------------------------------------------- a build waiting to install */

    /// <summary>A downloaded build: which, why (Auto-update or "When I quit"), and installs started from it.</summary>
    private sealed record ReadyRecord(string Version, string Requested, double Attempts);

    private ReadyRecord? ReadReady()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dataDir, "update", ReadyFile)));
            var r = doc.RootElement;
            if (!Js.IsString(Js.Get(r, "version"), out var v)) return null;
            return new ReadyRecord(v, Js.IsString(Js.Get(r, "requested"), out var q) && q == "user" ? "user" : "auto",
                Js.Get(r, "attempts") is { ValueKind: JsonValueKind.Number } n ? Js.NumberOf(n) : 0);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private void WriteReady(ReadyRecord record) =>
        File.WriteAllText(Path.Combine(dataDir, "update", ReadyFile), JsonText.Stringify(new { version = record.Version, requested = record.Requested, attempts = record.Attempts }) + "\n");

    private void DropReady()
    {
        var waiting = ReadReady();
        // As rmSync's force: data/update itself may be gone, which File.Delete throws for.
        var file = Path.Combine(dataDir, "update", ReadyFile);
        if (File.Exists(file)) File.Delete(file);
        var staged = waiting is null ? null : Path.Combine(dataDir, "update", waiting.Version);
        if (staged is not null && Directory.Exists(staged)) Directory.Delete(staged, recursive: true);
    }

    /// <summary>The waiting build, if it is newer than this one and still on disk.</summary>
    private ReadyRecord? UsableReady()
    {
        var waiting = ReadReady();
        var current = version();
        if (waiting is null || current is null || Notes.CompareVersions(current, waiting.Version) >= 0) return null;
        return File.Exists(Path.Combine(dataDir, "update", waiting.Version, "package.json")) ? waiting : null;
    }

    private void RefreshReady()
    {
        var waiting = UsableReady();
        lock (gate)
        {
            ready = waiting?.Version;
            installOnQuit = waiting is not null && (waiting.Requested == "user" || autoUpdate());
        }
    }

    /// <summary>
    /// Download the newest release ahead of time, to install at quit or the next start: <c>user</c> is
    /// "When I quit", <c>auto</c> is Auto-update. Errors are kept for the page, and thrown to a caller that waits.
    /// </summary>
    public Task PrepareUpdate(string requested)
    {
        lock (gate)
        {
            if (preparing is { } running)
            {
                // Already downloading: someone asking outranks Auto-update having started it.
                return running.ContinueWith(_ =>
                {
                    var waiting = ReadReady();
                    if (requested == "user" && waiting is not null && waiting.Requested != "user")
                    {
                        WriteReady(waiting with { Requested = "user" });
                        RefreshReady();
                        Announce();
                    }
                }, TaskScheduler.Default);
            }
            preparing = Prepare(requested);
            return preparing;
        }
    }

    private async Task Prepare(string requested)
    {
        await Task.Yield();
        lock (gate)
        {
            preparingNow = true;
            prepareError = null;
        }
        Announce();
        try
        {
            if (BlockedReason() is { } why) throw new InvalidOperationException(why);
            var repo = RepoFromPackage() ?? throw new InvalidOperationException("no GitHub repository is recorded in package.json");
            var release = await FetchLatestRelease(repo);
            var current = version();
            if (current is null || Notes.CompareVersions(current, release.Version) >= 0) throw new InvalidOperationException($"already on {current ?? "an unknown version"}");
            var waiting = UsableReady();
            if (waiting?.Version != release.Version)
            {
                DropReady();
                await Stage(release);
            }
            WriteReady(new ReadyRecord(release.Version, requested == "user" || waiting?.Requested == "user" ? "user" : "auto", 0));
            failedPrepare = null;
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or HttpRequestException or TaskCanceledException or UnauthorizedAccessException)
        {
            lock (gate)
            {
                prepareError = e.Message;
                failedPrepare = (latestVersion, Js.Now());
            }
            throw;
        }
        finally
        {
            lock (gate)
            {
                preparingNow = false;
                preparing = null;
            }
            RefreshReady();
            Announce();
        }
    }

    /// <summary>Auto-update's half: a newer release downloaded ahead of time, unless metered, waiting already, or failed within the hour.</summary>
    private void MaybePrepare()
    {
        lock (gate)
        {
            if (!autoUpdate() || !available || blocked is not null) return;
            if (metered == true || applying || preparing is not null) return;
            if (ready == latestVersion) return;
            if (failedPrepare is { } failed && failed.Version == latestVersion && Js.Now() - failed.At < RetryFailedMs) return;
        }
        _ = PrepareUpdate("auto").ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
    }

    /// <summary>Options -> Auto-update changed. Turned off, a build it downloaded is not installed.</summary>
    public void AutoUpdateChanged()
    {
        if (!autoUpdate() && ReadReady()?.Requested == "auto") DropReady();
        RefreshReady();
        Announce();
        MaybePrepare();
    }

    /// <summary>What the tray launcher says about the connection, as it changes.</summary>
    public void SetMetered(bool? isMetered)
    {
        lock (gate)
        {
            if (metered == isMetered) return;
            metered = isMetered;
        }
        Announce();
        MaybePrepare();
    }

    /* ------------------------------------------------------------------ the swap */

    /// <summary>
    /// What installs a staged build, from inside it: a release without Node its own tray launcher
    /// with <c>--apply-update</c>, a Node release its own runtime running its updater script.
    /// </summary>
    public static (string Command, List<string> Args)? SwapperFor(string stagedDir, string platform)
    {
        if (File.Exists(Path.Combine(stagedDir, NativeAppFor(platform)))) return (Path.Combine(stagedDir, LauncherExecutableFor(platform)), ["--apply-update"]);
        var script = Path.Combine(stagedDir, "scripts", "apply-update.mjs");
        if (!File.Exists(script)) return null;
        return (Path.Combine(stagedDir, platform == "win32" ? "node.exe" : "node"), [script]);
    }

    /// <summary>
    /// Hand a staged build to a detached swapper, which waits for this process to exit and does the
    /// swap: a running app's files are locked by the process that would replace them. Without
    /// <paramref name="relaunch"/> (an install at quit) the swapper starts nothing afterwards.
    /// </summary>
    private ApplyResult HandOff(string stagedDir, string newVersion, bool relaunch)
    {
        VerifyStaged(stagedDir, newVersion, platform);
        var swapper = SwapperFor(stagedDir, platform) ?? throw new InvalidOperationException($"{newVersion} does not know how to install itself (no updater script)");
        var restarts = relaunch && Instance.LauncherRestarts(env);
        var start = new ProcessStartInfo(swapper.Command) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in swapper.Args) start.ArgumentList.Add(arg);
        foreach (var arg in new[] { "--install", installDir, "--staged", stagedDir, "--pid", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture) })
        {
            start.ArgumentList.Add(arg);
        }
        // The swapper then leaves the relaunch to the launcher, rather than starting a copy of its own.
        if (restarts) start.ArgumentList.Add("--launcher-restarts");
        if (!relaunch) start.ArgumentList.Add("--no-relaunch");
        using var child = Process.Start(start);
        // What the launcher waits on. data/ is the one place the swap does not move.
        if (child is not null) File.WriteAllText(Path.Combine(Path.GetDirectoryName(stagedDir)!, SwapperPidFile), $"{child.Id}\n");
        return new ApplyResult(newVersion, stagedDir, restarts ? RestartExitCode : 0);
    }

    /// <summary>Update now: install the newest release and restart, using a build already waiting for it if there is one.</summary>
    public async Task<ApplyResult> ApplyUpdate()
    {
        lock (gate)
        {
            if (applying) throw new InvalidOperationException("an update is already in progress");
        }
        if (BlockedReason() is { } why) throw new InvalidOperationException(why);
        var repo = RepoFromPackage() ?? throw new InvalidOperationException("no GitHub repository is recorded in package.json");
        lock (gate) applying = true;
        Announce();
        try
        {
            Task? running;
            lock (gate) running = preparing;
            if (running is not null)
            {
                try
                {
                    await running;
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    /* its error is kept for the page */
                }
            }
            var waiting = UsableReady();
            string? latest;
            lock (gate) latest = latestVersion;
            if (waiting is not null && (latest is null || waiting.Version == latest))
            {
                WriteReady(waiting with { Attempts = waiting.Attempts + 1 });
                return HandOff(Path.Combine(dataDir, "update", waiting.Version), waiting.Version, true);
            }
            var release = await FetchLatestRelease(repo);
            var current = version();
            if (current is null || Notes.CompareVersions(current, release.Version) >= 0) throw new InvalidOperationException($"already on {current ?? "an unknown version"}");
            DropReady();
            return HandOff(await Stage(release), release.Version, true);
        }
        finally
        {
            lock (gate) applying = false;
            RefreshReady();
            Announce();
        }
    }

    /// <summary>
    /// The waiting build to install now, or null: only when asked for ("When I quit", or Auto-update),
    /// and only once. One whose install did not take is dropped at the start rather than retried forever.
    /// </summary>
    private ReadyRecord? Installable(string when)
    {
        if (BlockedReason() is not null) return null;
        var waiting = UsableReady();
        if (waiting is null || !(waiting.Requested == "user" || autoUpdate())) return null;
        if (waiting.Attempts > 0)
        {
            if (when == "start")
            {
                lock (gate) prepareError = $"the update to {waiting.Version} did not install; data/update.log says why";
                DropReady();
                RefreshReady();
            }
            return null;
        }
        return waiting;
    }

    /// <summary>At startup: install a waiting build and restart into it, or null to start as usual.</summary>
    public ApplyResult? InstallAtStart()
    {
        if (Installable("start") is not { } waiting) return null;
        try
        {
            WriteReady(waiting with { Attempts = waiting.Attempts + 1 });
            return HandOff(Path.Combine(dataDir, "update", waiting.Version), waiting.Version, true);
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or System.ComponentModel.Win32Exception or JsonException)
        {
            Console.WriteLine($"  update: could not install {waiting.Version} ({e.Message})");
            return null;
        }
    }

    /// <summary>At a deliberate quit: install a waiting build, and start nothing afterwards.</summary>
    public string? InstallAtQuit()
    {
        if (Installable("quit") is not { } waiting) return null;
        try
        {
            WriteReady(waiting with { Attempts = waiting.Attempts + 1 });
            HandOff(Path.Combine(dataDir, "update", waiting.Version), waiting.Version, false);
            return waiting.Version;
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or System.ComponentModel.Win32Exception or JsonException)
        {
            Console.WriteLine($"  update: could not install {waiting.Version} ({e.Message})");
            return null;
        }
    }

    /// <summary>
    /// Delete what an update leaves behind, at startup: <c>.rollback-*</c> beside the app (a swap
    /// that died before finishing), and <c>data/update/</c>, which the swap ran from and so could not
    /// delete. A build still waiting to install is kept, with its <c>ready.json</c>; data/update.log
    /// is a file, and stays. Failures are ignored: the next launch tries again.
    /// </summary>
    public (List<string> Removed, double Bytes) PruneLeftovers()
    {
        var removed = new List<string>();
        double bytes = 0;
        static double SizeOf(string target)
        {
            double total = 0;
            try
            {
                foreach (var entry in new DirectoryInfo(target).EnumerateFileSystemInfos())
                {
                    total += entry is DirectoryInfo ? SizeOf(entry.FullName) : ((FileInfo)entry).Length;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* only for the log line */
            }
            return total;
        }
        void Drop(string target, string label)
        {
            try
            {
                if (!Directory.Exists(target) && !File.Exists(target)) return;
                bytes += SizeOf(target);
                if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
                else File.Delete(target);
                removed.Add(label);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* locked: the next launch tries again */
            }
        }
        try
        {
            foreach (var entry in new DirectoryInfo(installDir).EnumerateDirectories())
            {
                if (entry.Name.StartsWith(".rollback-", StringComparison.Ordinal)) Drop(entry.FullName, entry.Name);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            /* no install directory to read is not a startup failure */
        }
        var keep = UsableReady()?.Version;
        var update = Path.Combine(dataDir, "update");
        if (keep is null)
        {
            Drop(update, "data/update");
        }
        else
        {
            try
            {
                foreach (var entry in new DirectoryInfo(update).EnumerateFileSystemInfos())
                {
                    if (entry.Name != keep && entry.Name != ReadyFile) Drop(entry.FullName, $"data/update/{entry.Name}");
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* see above */
            }
        }
        return (removed, bytes);
    }
}
