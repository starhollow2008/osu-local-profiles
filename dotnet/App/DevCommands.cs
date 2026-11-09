using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles;

/// <summary>
/// The app's own code, run by the checking scripts (scripts/dev-app.mjs), one JSON answer per line
/// on stdout: <c>osu-local-profiles-app --dev &lt;command&gt; ...</c>. Never used by the running app.
/// </summary>
internal static class DevCommands
{
    public static int Run(string[] args)
    {
        // Read by a script through a pipe, where the console's code page would mangle any title in Japanese.
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        switch (args.FirstOrDefault())
        {
            case "pp-helper" when args.Length == 1:
                /*
                 * The pp helper's protocol answered by this app's own copy of osu!'s code: a ready
                 * line, then one answer per request line. scripts/pp-parity.mjs compares a packaged
                 * app with the full helper this way, which is what proves the app, with its own
                 * dependencies and its pruning, prices every play exactly as the helper does.
                 */
                Console.Out.WriteLine(OsuLocalProfiles.PpCalculator.Program.ReadyLine());
                Console.Out.Flush();
                while (Console.In.ReadLine() is { } line)
                {
                    if (line.Length == 0) continue;
                    Console.Out.WriteLine(OsuLocalProfiles.PpCalculator.Program.Respond(line));
                    Console.Out.Flush();
                }
                return 0;
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
            case "mcosu-replays" when args.Length == 2:
                // Each play in the list (one JSON object a line: `file`, and the `score` as scores.db holds it) built into its replay at `file`.
                foreach (var line in File.ReadAllLines(args[1]).Where(l => l.Length > 0))
                {
                    var play = System.Text.Json.JsonSerializer.Deserialize<McosuPlay>(line, JsonText.Options)!;
                    File.WriteAllBytes(play.File, Clients.Mcosu.BuildReplay(play.Score));
                }
                return 0;
            case "pp-requests" when args.Length == 2:
                /*
                 * What the app asks osu!'s calculator about each replay in the list (one JSON object a
                 * line: `file` and its `beatmap`): the play's price, its price without the assistance
                 * mods, and whether osu! ranks its mods. scripts/pp-parity.mjs asks two helpers each.
                 */
                foreach (var line in File.ReadAllLines(args[1]).Where(l => l.Length > 0))
                {
                    var replay = System.Text.Json.JsonSerializer.Deserialize<ReplayOnBeatmap>(line, JsonText.Options)!;
                    ReplayScore score;
                    try
                    {
                        score = Osr.Parse(File.ReadAllBytes(replay.File));
                    }
                    catch (Exception e)
                    {
                        // Not a replay this app can read: the check leaves it out.
                        Console.WriteLine(JsonText.Stringify(new { replay.File, error = e.GetType().Name }));
                        continue;
                    }
                    Console.WriteLine(JsonText.Stringify(new { replay.File, requests = PpRequests(replay.File, replay.Beatmap, score) }));
                }
                return 0;
            case "release-notes" when args.Length == 2:
            {
                // A package's release-notes.json, read as the app reads it (scripts/release-notes.mjs writes it).
                JsonText.TryParse(File.ReadAllText(args[1]), out var notes);
                Console.WriteLine(JsonText.Stringify(Update.Notes.ParseNotes(notes)));
                return 0;
            }
            case "release-page" when args.Length is 3 or 4:
                // A release page's text, read as an install reads it before updating: the file, the version, and when it was published.
                Console.WriteLine(JsonText.Stringify(Update.Notes.FromBody(File.ReadAllText(args[1]), args[2], args.Length == 4 ? args[3] : null)));
                return 0;
            case "backfill" when args.Length == 3:
                return BackfillAll(args[1], args[2]).GetAwaiter().GetResult();
            case "ingest" when args.Length == 5 && args[4] is "plain" or "judged":
                return IngestAll(args[1], args[2], args[3], judged: args[4] == "judged").GetAwaiter().GetResult();
            default:
                Console.Error.WriteLine("usage: --dev pp-helper | pp-requests <list> | parse-replays <list> | discover <data folder> [force] | mcosu <list> <folder> | mcosu-replays <list> | release-notes <file> | release-page <file> <version> [<published>] | index-beatmaps <db> <roots.json> | resolve <db> <installs.json> <md5 list> | backfill <db> <installs.json> | ingest <db> <installs.json> <list> plain|judged");
                return 2;
        }
    }

    private sealed record McosuPlay(string File, Clients.McosuScore Score);

    private sealed record ReplayOnBeatmap(string File, string Beatmap);

    /// <summary>
    /// The requests the tracker makes for a replay, labelled: priced as ingest prices it, priced again
    /// with Relax or Autopilot stripped when it has either, and osu!'s ranked-mods question.
    /// </summary>
    private static List<object> PpRequests(string file, string beatmap, ReplayScore score)
    {
        var requests = new List<object>();
        var pricing = Calc.Mods.ScorePricing(score, beatmap);
        var priced = new Dictionary<string, object?> { ["replayPath"] = file, ["beatmapPath"] = beatmap };
        if (pricing.Mods is not null) priced["mods"] = pricing.Mods;
        if (pricing.IgnoreLegacyTotalScore) priced["ignoreLegacyTotalScore"] = true;
        if (!pricing.Unpriceable) requests.Add(new { label = "priced", request = priced });
        var strip = Calc.Mods.Strippable(Calc.Mods.ScoreMods(score, beatmap));
        if (strip.Length > 0 && !pricing.Unpriceable)
        {
            requests.Add(new { label = "stripped", request = new Dictionary<string, object?>(priced) { ["stripMods"] = strip } });
        }
        // A McOsu play's mods are worked out from the map; a lazer replay carries its own; a stable one has bits.
        var mods = score.Mcosu is not null
            ? Calc.Mods.ScoreMods(score, beatmap)
            : Js.Get(score.Extras, "mods") is { ValueKind: System.Text.Json.JsonValueKind.Array } list ? [.. list.EnumerateArray()] : null;
        requests.Add(new
        {
            label = "ranked",
            request = mods is not null
                ? new Dictionary<string, object?> { ["type"] = "ranked", ["ruleset"] = score.Mode, ["mods"] = mods }
                : new Dictionary<string, object?> { ["type"] = "ranked", ["ruleset"] = score.Mode, ["legacyMods"] = score.LegacyMods },
        });
        return requests;
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

    /// <summary>A parsed replay, as the Node parser's was written to be compared: dates as ms, ids as text.</summary>
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
