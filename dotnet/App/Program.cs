using System.Runtime.InteropServices;
using OsuLocalProfiles;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Http;

/*
 * The C# port of osu! local profiles (docs/csharp-port.md). Not shipped: until the switch-over the
 * Node app is the product. It opens data/ as the Node app does, writing to it, so it never runs on
 * the same folder as a Node app that is running.
 *
 *   osu-local-profiles-app [--root <install dir>] [--check-only]
 */

// Checks run by scripts/ against the Node app's own answers; never part of running the app.
if (args.Length > 0 && args[0] == "--dev") return OsuLocalProfiles.DevCommands.Run(args[1..]);

// UTF-8 wherever it goes, as Node writes: the tray launcher keeps it as data/logs/app.log, and a
// beatmap title in Japanese must not reach it in the console's code page.
Console.OutputEncoding = new System.Text.UTF8Encoding(false);

string? root = null;
// Verify the install and exit, rather than starting to track: does it find osu!, and does it find
// the pp calculator? What a package proves itself with before it ships (scripts/package.mjs).
var checkOnly = false;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--root" when i + 1 < args.Length:
            root = args[++i];
            break;
        case "--check-only":
            checkOnly = true;
            break;
        default:
            Console.Error.WriteLine($"unknown argument: {args[i]}");
            Console.Error.WriteLine("usage: osu-local-profiles-app [--root <install dir>] [--check-only]");
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
 * fail on the port. Starting the app again is how to find it again. --check-only never serves, so
 * it has nothing to collide with.
 */
var running = checkOnly ? default : await Instance.RunningInstance(config.Port);
if (running.Running)
{
    Console.WriteLine($"\n  Already running{(running.Version is null ? "" : $" ({running.Version})")} -> {url}");
    if (withComputer) return 0;
    Console.WriteLine("  Opened its page instead of starting a second copy.\n");
    Browser.Open(url);
    return 0;
}

/*
 * The update check and the update itself, reading config.json's switches on every use so a
 * change applies at once.
 */
var updater = new OsuLocalProfiles.Update.Updater(paths.InstallDir, paths.DataDir, paths.Version,
    () => config["autoUpdate"] is { ValueKind: System.Text.Json.JsonValueKind.True },
    () => config["checkForUpdates"] is not { ValueKind: System.Text.Json.JsonValueKind.False });

/*
 * A newer build downloaded ahead of time, by Auto-update or "When I quit", that the last run did
 * not get to install at its quit: install it now, before anything is tracked, and come back as
 * the new version.
 */
if (!checkOnly && updater.InstallAtStart() is { } pending)
{
    Console.WriteLine($"\n  Installing update {pending.Version}...");
    Console.WriteLine("  It was downloaded earlier; the app starts again once it is in place.\n");
    return pending.ExitCode;
}

var dbFile = Path.Combine(paths.DataDir, "profiles.db");

/*
 * Find osu!: what the profile pointed at, then where it was found before, then everywhere it is
 * normally installed, and only once ever a search of the whole machine. Remembered in
 * config.json.
 */
var discovery = await OsuLocalProfiles.Clients.Discover.Run(
    config.Strings("installRoots"), config.Strings("discoveredRoots"), NodePath.Join(paths.DataDir, "mcosu"),
    noSearch: Js.Truthy(config["searchedForInstalls"]),
    onProgress: (dirs, _, _) => Console.Write($"\r  searching for osu!... {dirs} folders"));
var installs = discovery.Installs;
config.Save(paths.DataDir);
config.RememberDiscovery(discovery, paths.DataDir);
if (installs.Count == 0)
{
    Console.WriteLine("\n  No osu! installation found.");
    Console.WriteLine("  The page opens anyway: use Options -> osu! folders to point at it.");
    /*
     * "osu! is not where I looked" and "the pp calculator will not load" are separate faults, so
     * --check-only reports both from one run, which also lets CI, where there is never an osu!
     * install, check the calculator on each platform. A normal run carries on with nothing to
     * watch, so the page is there to say where osu! is.
     */
    if (checkOnly)
    {
        ReportPpCalculator();
        return 1;
    }
}
foreach (var install in installs)
{
    var kind = install.Development ? "lazer (development)" : install.Kind;
    Console.WriteLine($"  found {kind,-6} {install.Root}{(install.OnlineDb is null ? "" : "  (+ online.db)")}");
}
var extra = discovery.Candidates.Count - installs.Count;
if (extra > 0) Console.WriteLine($"  ({extra} other osu! folder(s) found -- Options -> osu! folders to switch)");

/*
 * A backup restored from the page is swapped in here, before anything opens the database it
 * replaces. What it replaced is moved aside, never deleted.
 */
var restored = Backup.ApplyPendingRestore(paths.DataDir, DateTime.Now);
if (restored.Applied) Console.WriteLine($"\n  Restored a backup. What was here before is in {restored.Aside}\n");
else if (restored.Error is not null) Console.WriteLine($"\n  The backup could not be restored, and nothing was changed: {restored.Error}\n");

// Decided before the database is created: only a brand-new install is welcomed, never one upgraded
// from a version that had no welcome.
var firstRun = !File.Exists(dbFile);
using var db = Database.Open(dbFile);
OsuLocalProfiles.Update.Notes.SeedSeenVersion(db, paths.Version(), paths.DataDir);
// A restored database remembers the app last running when the backup was made: without this,
// importPlaysWhileClosed would read everything since as a gap the app was closed for.
if (restored.Applied) OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db);
// config.json's profileName only names the very first profile; after that they are the page's.
Profiles.SeedFirst(db, config.ProfileName);
if (firstRun) ProfileData.OfferWelcome(db);
// Before any request is answered: the favourite lists must agree with the setting as it stands.
Favorites.SyncSharing(db, config["sharedFavorites"] is not { ValueKind: System.Text.Json.JsonValueKind.False });
var active = Profiles.Get(db, Profiles.ActiveId(db))!;
// The gap the app was closed for, read before this run stamps itself.
var gapSince = OsuLocalProfiles.Tracker.CatchUp.Since(OsuLocalProfiles.Tracker.CatchUp.LastRunAt(db), active.TrackingSince);

// --check-only stops here, before the beatmap index, which is slow and beside the question.
if (checkOnly)
{
    var ok = ReportPpCalculator();
    Console.WriteLine($"  data: {paths.DataDir}");
    return ok ? 0 : 1;
}

/*
 * osu!'s calculators, in-process. There is no fallback calculator on purpose: a second
 * implementation would disagree by a few percent and leave one profile holding scores computed two
 * different ways. The same goes for one built from the player's osu! source (roadmap 5.70): when it
 * will not start, nothing prices in its place.
 */
var ppSource = Js.IsString(config["ppSource"], out var source) ? source : "";
var (calculator, calculatorProblem) = await PpSource.StartupCalculator(ppSource, paths.DataDir);
if (calculator is not null && ppSource.Length > 0)
{
    Console.WriteLine($"\n  pp: osu!'s calculator from your osu! source at {ppSource} ({calculator.Version})");
}
else if (calculator is not null)
{
    Console.WriteLine($"\n  pp: osu!'s official calculator ({calculator.Version})");
}
else if (ppSource.Length > 0)
{
    Console.WriteLine($"\n  WARNING: {calculatorProblem}.");
    Console.WriteLine("  Scores will still be tracked, but with no pp or star rating.");
    Console.WriteLine("  Build it again from Settings -> pp calculator, or switch back to the release there.");
}
else
{
    Console.WriteLine($"\n  pp: NOT AVAILABLE -- scores would be tracked with no pp or star rating ({calculatorProblem})");
}

/*
 * Reachable four ways, and two can arrive together, so only the first one counts. `deliberate`
 * is Quit from the page or the tray, or Ctrl+C: not the launcher dying or the system stopping the
 * app. Only a deliberate stop installs an update waiting for the quit.
 */
var stopped = new TaskCompletionSource<(int Code, bool Deliberate)>(TaskCreationOptions.RunContinuationsAsynchronously);
void Shutdown(int code, bool deliberate) => stopped.TrySetResult((code, deliberate));
// Set when an update was handed to its swapper, which the launcher then waits for by its pid.
var handedOff = false;

var resolver = new OsuLocalProfiles.Clients.BeatmapResolver(db, installs);
var tracker = new OsuLocalProfiles.Tracker.PlayTracker(db, resolver, installs, active.Id, active.TrackingSince, calculator);
Startup.Announce(db, tracker);

/*
 * Settings -> pp calculator: the player's osu! source, or the release. Written through the same
 * re-read-then-save as the page's other switches, so a hand edit made while the app runs survives.
 */
var ppSources = new PpSource(PpSourceTracker.Of(tracker), paths.DataDir,
    NodePath.Join(paths.InstallDir, "tools", "PpCalculator", "Program.cs"),
    () => Js.IsString(config["ppSource"], out var current) ? current : "",
    chosen =>
    {
        var current = AppConfig.Load(paths.DataDir);
        current["ppSource"] = config["ppSource"] = JsonText.From(chosen);
        current.Save(paths.DataDir);
    },
    // Said on the page too, not only in the console: pp has stopped, and Settings is the fix.
    startupProblem: ppSource.Length > 0 ? calculatorProblem : null);

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
    PpSource = ppSources,
    StatusKnown = resolver.KnowsStatus,
    Installs = installs,
    Tracker = tracker,
    Updater = updater,
    OnUpdateExit = code =>
    {
        handedOff = true;
        Shutdown(code, false);
    },
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
    // The launcher's other message is whether the connection is metered, which Auto-update heeds.
    _ = Instance.StopWhenLauncherCloses(Console.OpenStandardInput(), deliberate => Shutdown(0, deliberate), message =>
    {
        if (message.ValueKind == System.Text.Json.JsonValueKind.Object && message.TryGetProperty("metered", out var metered))
        {
            updater.SetMetered(metered.ValueKind switch
            {
                System.Text.Json.JsonValueKind.True => true,
                System.Text.Json.JsonValueKind.False => false,
                _ => null,
            });
        }
    });
}

// The index first, then what needs it, in the order the Node app runs them.
var roots = installs
    .SelectMany(i => i.BeatmapRoots.Select(p => new OsuLocalProfiles.Clients.IndexRoot(p, i.Kind != "lazer")))
    .ToList();
roots = [.. roots.Where((r, n) => roots.FindIndex(o => OsuLocalProfiles.Tracker.PlayTracker.SamePath(o.Path, r.Path)) == n)];
_ = Startup.AfterIndex(db, tracker, roots, gapSince, paths.DataDir);
tracker.Start();

await app.StartAsync();
Console.WriteLine($"\n  osu! local profiles {paths.Version() ?? "(unknown version)"}, C# port");
Console.WriteLine($"  data: {paths.DataDir}");
Console.WriteLine($"  {url}");
await Startup.Banner(db, tracker, active, fromTray);
// When the app last ran, so the next launch knows the gap it was closed for. Stamped as it runs
// too, so a crash loses at most the heartbeat's worth.
OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db);
using var heartbeat = new Timer(_ => OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db), null,
    TimeSpan.FromMilliseconds(OsuLocalProfiles.Tracker.CatchUp.HeartbeatMs), TimeSpan.FromMilliseconds(OsuLocalProfiles.Tracker.CatchUp.HeartbeatMs));
if (Js.Truthy(config["openBrowser"]) && !withComputer) Browser.Open(url);

// What the last update left behind: a rollback copy, the unpacked release it ran from.
var leftovers = updater.PruneLeftovers();
if (leftovers.Removed.Count > 0)
{
    Console.WriteLine($"  Cleaned up after the last update: {string.Join(", ", leftovers.Removed)} ({leftovers.Bytes / 1024 / 1024:F0}MB)\n");
}
// Once a day, and an hour after a failed check; nothing while checkForUpdates is off.
using var updateChecks = updater.KeepChecking();

var (exitCode, deliberate) = await stopped.Task;
Console.WriteLine("\n  stopping...");
if (deliberate && exitCode == 0 && updater.InstallAtQuit() is { } installing)
{
    Console.WriteLine($"  installing update {installing}; it is there the next time the app starts");
}
heartbeat.Dispose();
tracker.Stop();
OsuLocalProfiles.Tracker.CatchUp.MarkRunning(db);
await app.StopAsync();
await app.DisposeAsync();
if (exitCode == RestartExitCode && !handedOff)
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
    /// <summary>Load osu!'s calculator and say whether it worked, as --check-only reports it.</summary>
    private static bool ReportPpCalculator()
    {
        var (calculator, problem) = OfficialCalculator.Create();
        if (calculator is not null)
        {
            Console.WriteLine("\n  pp: osu!'s official calculator");
            return true;
        }
        Console.WriteLine($"\n  pp: NOT AVAILABLE -- scores would be tracked with no pp or star rating ({problem})");
        return false;
    }

    /// <summary>What tells the tray launcher to start the app again (src/update/index.ts).</summary>
    private const int RestartExitCode = 75;
}
