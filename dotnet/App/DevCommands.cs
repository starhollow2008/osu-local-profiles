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
            case "mcosu" when args.Length == 3:
                // Each McOsu scores.db in the list read, its plays answered, and their replays built into the folder named.
                foreach (var file in File.ReadAllLines(args[1]).Where(l => l.Length > 0))
                {
                    object answer;
                    try
                    {
                        var scores = Clients.Mcosu.ParseScores(File.ReadAllBytes(file));
                        foreach (var score in scores)
                        {
                            var path = Clients.Mcosu.BuiltReplayPath(args[2], score.BeatmapMD5, score.PlayedAt);
                            Directory.CreateDirectory(args[2]);
                            File.WriteAllBytes(path, Clients.Mcosu.BuildReplay(score));
                        }
                        answer = new { file, scores };
                    }
                    catch (Exception e)
                    {
                        answer = new { file, error = e is Clients.McosuVersionException ? "version" : "short" };
                    }
                    Console.WriteLine(JsonText.Stringify(answer));
                }
                return 0;
            case "backfill" when args.Length == 3:
                return BackfillAll(args[1], args[2]).GetAwaiter().GetResult();
            case "ingest" when args.Length == 5 && args[4] is "plain" or "judged":
                return IngestAll(args[1], args[2], args[3], judged: args[4] == "judged").GetAwaiter().GetResult();
            default:
                Console.Error.WriteLine("usage: --dev parse-replays <list> | discover <data folder> [force] | index-beatmaps <db> <roots.json> | resolve <db> <installs.json> <md5 list> | ingest <db> <installs.json> <list> plain|judged");
                return 2;
        }
    }

    /// <summary>
    /// Each replay in the list ingested into the database's first profile, one outcome per line.
    /// <c>plain</c> is a re-ingest (no filter, everyone's plays, nothing recorded); <c>judged</c> is an
    /// import: the profile's own filter and owner, and every play turned away recorded.
    /// </summary>
    private static async Task<int> IngestAll(string dbFile, string installsFile, string listFile, bool judged)
    {
        using var db = Db.Database.Open(dbFile);
        var installs = System.Text.Json.JsonSerializer.Deserialize<List<Clients.OsuInstall>>(File.ReadAllText(installsFile), JsonText.Options)!;
        var profile = db.FirstRow("SELECT id, tracking_since FROM profiles ORDER BY id LIMIT 1")!;
        var profileId = (long)profile.Num("id")!;
        var (calculator, problem) = Calc.OfficialCalculator.Create();
        if (calculator is null)
        {
            Console.Error.WriteLine(problem);
            return 1;
        }
        var ctx = new Tracker.IngestContext(db, new Clients.BeatmapResolver(db, installs), profileId, profile.Num("tracking_since") ?? 0, calculator);
        if (judged)
        {
            ctx = ctx with
            {
                Filter = Settings.SettingsStore.Get(db, profileId).TrackingFilter,
                Identity = Players.Resolve(db, profileId, installs),
                Declines = "import",
            };
        }
        foreach (var file in File.ReadAllLines(listFile).Where(l => l.Length > 0))
        {
            Console.WriteLine(JsonText.Stringify(await Tracker.Ingest.ReplayFile(file, ctx)));
        }
        return 0;
    }

    /// <summary>
    /// Import past plays from the beginning into the database's first profile, everything it takes,
    /// as its filter and owner decide: what Check previews, then what the import brings in.
    /// </summary>
    private static async Task<int> BackfillAll(string dbFile, string installsFile)
    {
        using var db = Db.Database.Open(dbFile);
        var installs = System.Text.Json.JsonSerializer.Deserialize<List<Clients.OsuInstall>>(File.ReadAllText(installsFile), JsonText.Options)!;
        var profileId = (long)db.FirstRow("SELECT id FROM profiles ORDER BY id LIMIT 1")!.Num("id")!;
        var (calculator, problem) = Calc.OfficialCalculator.Create();
        if (calculator is null)
        {
            Console.Error.WriteLine(problem);
            return 1;
        }
        var tracker = new Tracker.PlayTracker(db, new Clients.BeatmapResolver(db, installs), installs, profileId, 0, calculator);
        var (replays, log) = await tracker.PreviewBackfill(0);
        Console.WriteLine(JsonText.Stringify(new { replays, log }));
        Console.WriteLine(JsonText.Stringify(await tracker.RunBackfill(0, Tracker.BackfillSources.Everything)));
        return 0;
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
