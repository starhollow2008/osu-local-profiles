using OsuLocalProfiles;
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

var paths = AppPaths.Resolve(root);
var config = AppConfig.Load(paths.DataDir);
var dbFile = Path.Combine(paths.DataDir, "profiles.db");
if (!writable && !File.Exists(dbFile))
{
    Console.Error.WriteLine($"No database at {dbFile}. Start the Node app once first, or pass --writable.");
    return 1;
}

using var db = Database.Open(dbFile, writable);
if (writable) Profiles.SeedFirst(db, config.ProfileName);

var app = Server.Build(new ServerOptions { Db = db, Paths = paths, Config = config, Port = config.Port });

Console.WriteLine($"osu! local profiles {paths.Version() ?? "(unknown version)"}, C# port");
Console.WriteLine($"  data: {paths.DataDir}{(writable ? "" : " (read-only)")}");
Console.WriteLine($"  http://localhost:{config.Port}/");
await app.RunAsync();
return 0;
