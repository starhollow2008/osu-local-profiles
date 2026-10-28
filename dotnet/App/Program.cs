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

using var db = Database.Open(dbFile, writable);
if (writable) Profiles.SeedFirst(db, config.ProfileName);

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

var app = Server.Build(new ServerOptions
{
    Db = db,
    Paths = paths,
    Config = config,
    Port = config.Port,
    OnQuit = () => Shutdown(0, true),
    FromTray = fromTray,
    Calculator = calculator,
    PpSource = ppSource,
    CalculatorProblem = calculatorProblem,
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

await app.StartAsync();
Console.WriteLine($"\n  osu! local profiles {paths.Version() ?? "(unknown version)"}, C# port");
Console.WriteLine($"  data: {paths.DataDir}{(writable ? "" : " (read-only)")}");
Console.WriteLine($"  {url}");
if (Js.Truthy(config["openBrowser"]) && !withComputer) Browser.Open(url);

var (exitCode, _) = await stopped.Task;
Console.WriteLine("\n  stopping...");
await app.StopAsync();
await app.DisposeAsync();
return exitCode;
