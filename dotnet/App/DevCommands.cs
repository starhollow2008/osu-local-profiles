using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles;

/// <summary>
/// Checks the parity scripts run against the Node app's own code, one JSON answer per line on
/// stdout: <c>osu-local-profiles-app --dev &lt;command&gt; ...</c>. Never used by the running app.
/// </summary>
internal static class DevCommands
{
    public static int Run(string[] args)
    {
        // Read by a script through a pipe, where the console's code page would mangle any title in Japanese.
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        switch (args.FirstOrDefault())
        {
            case "parse-replays" when args.Length == 2:
                // One path per line of the file named; each answered with what the parser read, or why not.
                foreach (var path in File.ReadAllLines(args[1]).Where(l => l.Length > 0))
                {
                    object answer;
                    try
                    {
                        answer = new { path, score = ReplayJson(Osr.Parse(File.ReadAllBytes(path))) };
                    }
                    catch (Exception e)
                    {
                        answer = new { path, error = e.GetType().Name };
                    }
                    Console.WriteLine(JsonText.Stringify(answer));
                }
                return 0;
            case "discover" when args.Length is 2 or 3:
            {
                // What startup would find, from config.json in the data folder named; nothing is written.
                var config = AppConfig.Load(args[1]);
                // `force` is the Rescan button: nothing remembered, and the walk allowed.
                var force = args.Length == 3 && args[2] == "force";
                var result = Clients.Discover.Run(
                    StringList(config["installRoots"]), force ? [] : StringList(config["discoveredRoots"]), NodePath.Join(args[1], "mcosu"),
                    force: force,
                    noSearch: !force && config["searchedForInstalls"] is { ValueKind: System.Text.Json.JsonValueKind.True }).GetAwaiter().GetResult();
                Console.WriteLine(JsonText.Stringify(result));
                return 0;
            }
            case "index-beatmaps" when args.Length == 3:
            {
                // The beatmap index, built into the database named from the roots in the JSON file named.
                using var db = Db.Database.Open(args[1]);
                var roots = System.Text.Json.JsonSerializer.Deserialize<List<Clients.IndexRoot>>(File.ReadAllText(args[2]), JsonText.Options)!;
                var (scanned, indexed, removed) = Clients.Beatmaps.IndexFiles(db, roots);
                Console.WriteLine(JsonText.Stringify(new { scanned, indexed, removed }));
                return 0;
            }
            case "resolve" when args.Length == 4:
            {
                // Each MD5 in the file named, resolved against the database and installs named.
                using var db = Db.Database.Open(args[1]);
                var installs = System.Text.Json.JsonSerializer.Deserialize<List<Clients.OsuInstall>>(File.ReadAllText(args[2]), JsonText.Options)!;
                var resolver = new Clients.BeatmapResolver(db, installs);
                foreach (var md5 in File.ReadAllLines(args[3]).Where(l => l.Length > 0))
                {
                    Console.WriteLine(JsonText.Stringify(resolver.Resolve(md5)));
                }
                return 0;
            }
            default:
                Console.Error.WriteLine("usage: --dev parse-replays <list> | discover <data folder> [force] | index-beatmaps <db> <roots.json> | resolve <db> <installs.json> <md5 list>");
                return 2;
        }
    }

    /// <summary>A config list of text, as the Node app reads one: an array's strings.</summary>
    private static List<string> StringList(System.Text.Json.JsonElement? value) =>
        value is { ValueKind: System.Text.Json.JsonValueKind.Array } list
            ? [.. list.EnumerateArray().Where(e => e.ValueKind == System.Text.Json.JsonValueKind.String).Select(e => e.GetString()!)]
            : [];

    /// <summary>A parsed replay as scripts/port-checks.mjs writes the Node parser's: dates as ms, ids as text.</summary>
    private static object ReplayJson(ReplayScore s) => new
    {
        s.Client, s.Mode, s.Version, s.BeatmapMD5, s.Username, s.ReplayMD5,
        s.Count300, s.Count100, s.Count50, s.CountGeki, s.CountKatu, s.CountMiss,
        s.TotalScore, s.MaxCombo, s.PerfectCombo, s.LegacyMods,
        playedAt = s.PlayedAtMs,
        onlineScoreId = s.OnlineScoreId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
        s.Extras, s.Mcosu, s.Built,
    };
}
