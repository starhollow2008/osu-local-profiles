using System.Runtime.InteropServices;
using OsuLocalProfiles;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Http;

/*
 * The C# port of osu! local profiles (docs/csharp-port.md). Not shipped: until the switch-over the
 * Node app is the product, and this opens the database read-only unless asked otherwise.
 *
 *   osu-local-profiles-app [--root <install dir>] [--writable]
 */

// Checks run by scripts/ against the Node app's own answers; never part of running the app.
if (args.Length > 0 && args[0] == "--dev") return OsuLocalProfiles.DevCommands.Run(args[1..]);

// UTF-8 wherever it goes, as Node writes: the tray launcher keeps it as data/logs/app.log, and a
// beatmap title in Japanese must not reach it in the console's code page.
Console.OutputEncoding = new System.Text.UTF8Encoding(false);

string? root = null;
var writable = false;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--root" when i + 1 < args.Length:
            root = args[++i];
            break;
        case "--writable":
            writable = true;
            break;
        default:
            Console.Error.WriteLine($"unknown argument: {args[i]}");
            Console.Error.WriteLine("usage: osu-local-profiles-app [--root <install dir>] [--writable]");
            return 2;
    }
}

string? Env(string name) => Environment.GetEnvironmentVariable(name);
var fromTray = Instance.LaunchedFromTray(Env);
var withComputer = Instance.StartedWithComputer(Env);

Console.WriteLine("\n  osu! local profiles");
Console.WriteLine("  -------------------");

var paths = AppPaths.Resolve(root);
var config = AppConfig.Load(paths.DataDir);
var url = $"http://localhost:{config.Port}";

/*
 * Already running: open that copy's page rather than starting a second one, which would only
 * fail on the port. Starting the app again is how to find it again.
 */
var running = await Instance.RunningInstance(config.Port);
if (running.Running)
{
    Console.WriteLine($"\n  Already running{(running.Version is null ? "" : $" ({running.Version})")} -> {url}");
    if (withComputer) return 0;
    Console.WriteLine("  Opened its page instead of starting a second copy.\n");
    Browser.Open(url);
    return 0;
}

var dbFile = Path.Combine(paths.DataDir, "profiles.db");
if (!writable && !File.Exists(dbFile))
{
    Console.Error.WriteLine($"  No database at {dbFile}. Start the Node app once first, or pass --writable.");
    return 1;
}

/*
 * Find osu!: what the profile pointed at, then where it was found before, then everywhere it is
 * normally installed, and only once ever a search of the whole machine. Remembered in
 * config.json, which a read-only copy leaves alone.
 */
var discovery = await OsuLocalProfiles.Clients.Discover.Run(
    config.Strings("installRoots"), config.Strings("discoveredRoots"), NodePath.Join(paths.DataDir, "mcosu"),
    noSearch: Js.Truthy(config["searchedForInstalls"]),
    onProgress: (dirs, _, _) => Console.Write($"\r  searching for osu!... {dirs} folders"));
var installs = discovery.Installs;
if (writable)
{
    config.Save(paths.DataDir);
    config.RememberDiscovery(discovery, paths.DataDir);
}
if (installs.Count == 0)
{
    Console.WriteLine("\n  No osu! installation found.");
    Console.WriteLine("  The page opens anyway: use Options -> osu! folders to point at it.");
}
foreach (var install in installs)
{
    var kind = install.Development ? "lazer (development)" : install.Kind;
    Console.WriteLine($"  found {kind,-6} {install.Root}{(install.OnlineDb is null ? "" : "  (+ online.db)")}");
}
var extra = discovery.Candidates.Count - installs.Count;
if (extra > 0) Console.WriteLine($"  ({extra} other osu! folder(s) found -- Options -> osu! folders to switch)");

// Decided before the database is created: only a brand-new install is welcomed, never one upgraded
// from a version that had no welcome.
var firstRun = !File.Exists(dbFile);
using var db = Database.Open(dbFile, writable);
if (writable)
{
    OsuLocalProfiles.Update.Notes.SeedSeenVersion(db, paths.Version(), paths.DataDir);
    // config.json's profileName only names the very first profile; after that they are the page's.
    Profiles.SeedFirst(db, config.ProfileName);
    if (firstRun) ProfileData.OfferWelcome(db);
    // Before any request is answered: the favourite lists must agree with the setting as it stands.
    Favorites.SyncSharing(db, config["sharedFavorites"] is not { ValueKind: System.Text.Json.JsonValueKind.False });
}
var active = Profiles.Get(db, Profiles.ActiveId(db))!;
// The gap the app was closed for, read before this run stamps itself.
var gapSince = OsuLocalProfiles.Tracker.CatchUp.Since(OsuLocalProfiles.Tracker.CatchUp.LastRunAt(db), active.TrackingSince);

/*
 * osu!'s calculators, in-process. With an osu! source configured (roadmap 5.70), only the
 * calculator built from it, never the release in its place: building and running that one is
 * not ported yet, so there is none, and Settings says why.
 */
var ppSource = Js.IsString(config["ppSource"], out var source) ? source : "";
OfficialCalculator? calculator = null;
string? calculatorProblem = null;
if (ppSource.Length == 0)
{
    var (loaded, problem) = OfficialCalculator.Create();
    calculator = loaded;
    if (loaded is null) Console.WriteLine($"\n  pp: NOT AVAILABLE -- scores would be tracked with no pp or star rating ({problem})");
    else Console.WriteLine($"\n  pp: osu!'s official calculator ({loaded.Version})");
}
else
{
    calculatorProblem = $"the calculator built from your osu! source at {ppSource} is not in the C# port yet";
    Console.WriteLine($"\n  WARNING: {calculatorProblem}.");
}

/*
 * Reachable four ways, and two can arrive together, so only the first one counts. `deliberate`
 * is Quit from the page or the tray, or Ctrl+C: not the launcher dying or the system stopping the
 * app. Only a deliberate stop will install an update waiting for the quit (phase 5).
 */
var stopped = new TaskCompletionSource<(int Code, bool Deliberate)>(TaskCreationOptions.RunContinuationsAsynchronously);
void Shutdown(int code, bool deliberate) => stopped.TrySetResult((code, deliberate));

var resolver = new OsuLocalProfiles.Clients.BeatmapResolver(db, installs);
// A read-only copy watches nothing: tracking is writing.
var tracker = writable
    ? new OsuLocalProfiles.Tracker.PlayTracker(db, resolver, installs, active.Id, active.TrackingSince, calculator)
    : null;
if (tracker is not null) Startup.Announce(db, tracker);

var app = Server.Build(new ServerOptions
{
    Db = db,
    Paths = paths,
    Config = config,
    Port = config.Port,
    OnQuit = () => Shutdown(0, true),
    /*
     * Only the tray launcher: it starts the app again on this exit code, and with no update in
     * progress there is no swap to wait for. A restored backup is applied that way.
     */
    OnRestart = fromTray ? () => Shutdown(RestartExitCode, false) : null,
    Folders = new OsuLocalProfiles.Clients.OsuFolders(config, OsuLocalProfiles.Clients.OsuFolders.SaveInto(paths.DataDir), installs,
        discovery, NodePath.Join(paths.DataDir, "mcosu")),
    FromTray = fromTray,
    Calculator = calculator,
    PpSource = ppSource,
    CalculatorProblem = calculatorProblem,
    StatusKnown = resolver.KnowsStatus,
    Installs = installs,
    Tracker = tracker,
});

Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    Shutdown(0, true);
};
using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context =>
{
    context.Cancel = true;
    Shutdown(0, false);
});
if (fromTray)
{
    // The launcher's other message, whether the connection is metered, is for Auto-update and is
    // read once the updater is ported (phase 5).
    _ = Instance.StopWhenLauncherCloses(Console.OpenStandardInput(), deliberate => Shutdown(0, deliberate));
}

Timer? heartbeat = null;
if (tracker is not null)
{
    // The index first, then what needs it, in the order the Node app runs them.
    var roots = installs
        .SelectMany(i => i.BeatmapRoots.Select(p => new OsuLocalProfiles.Clients.IndexRoot(p, i.Kind != "lazer")))
        .ToList();
    roots = [.. roots.Where((r, n) => roots.FindIndex(o => OsuLocalProfiles.Tracker.PlayTracker.SamePath(o.Path, r.Path)) == n)];
    _ = Startup.AfterIndex(db, tracker, roots, gapSince, paths.DataDir);
    tracker.Start();
}

await app.StartAsync();
Console.WriteLine($"\n  osu! local profiles {paths.Version() ?? "(unknown version)"}, C# port");
Console.WriteLine($"  data: {paths.DataDir}{(writable ? "" : " (read-only)")}");
Console.WriteLine($"  {url}");
if (tracker is not null)
{
    await Startup.Banner(db, tracker, active, fromTray);
    // When the app last ran, so the next launch knows the gap it was closed for. Stamped as it
    // runs too, so a crash loses at most the heartbeat's worth.
    OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db);
    heartbeat = new Timer(_ => OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db), null,
        TimeSpan.FromMilliseconds(OsuLocalProfiles.Tracker.CatchUp.HeartbeatMs), TimeSpan.FromMilliseconds(OsuLocalProfiles.Tracker.CatchUp.HeartbeatMs));
}
if (Js.Truthy(config["openBrowser"]) && !withComputer) Browser.Open(url);

var (exitCode, _) = await stopped.Task;
Console.WriteLine("\n  stopping...");
heartbeat?.Dispose();
if (tracker is not null)
{
    tracker.Stop();
    OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db);
}
await app.StopAsync();
await app.DisposeAsync();
if (exitCode == RestartExitCode)
{
    // Left by an update long finished, a swapper pid would have the launcher wait on whatever
    // process has that number now.
    try
    {
        File.Delete(Path.Combine(paths.DataDir, "update", "swapper.pid"));
    }
    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
    {
        /* the launcher waits a moment longer */
    }
}
return exitCode;

partial class Program
{
    /// <summary>What tells the tray launcher to start the app again (src/update/index.ts).</summary>
    private const int RestartExitCode = 75;
}
