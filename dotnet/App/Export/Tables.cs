using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Export;

/// <summary>A cell that is a moment, written as a spreadsheet's date and time.</summary>
internal sealed record DateCell(double Ms);

internal sealed record Column(string Header, double? Width = null);

/// <summary>A sheet: its name, columns and rows. A cell is text, a number (<c>double</c>), a <see cref="DateCell"/> or null.</summary>
internal sealed record Table(string Name, List<Column> Columns, List<object?[]> Rows);

/// <summary>
/// A profile as tables for a spreadsheet: src/export/tables.ts. Every query goes through the same
/// definitions as the page, so what is exported is exactly what the profile shows.
/// </summary>
internal static class Tables
{
    private static readonly Dictionary<double, string> ModeNames = new() { [0] = "osu!", [1] = "osu!taiko", [2] = "osu!catch", [3] = "osu!mania" };

    private static string? ModeName(object? mode) => mode is long or double && ModeNames.TryGetValue(Convert.ToDouble(mode), out var n) ? n : null;

    /// <summary>A grade as osu! names it, the two silver ones said as such.</summary>
    private static string GradeName(string grade, Translator t) => grade switch
    {
        "XH" => t.T("export.silver", ("grade", "SS")),
        "SH" => t.T("export.silver", ("grade", "S")),
        "X" => "SS",
        _ => grade,
    };

    /// <summary>A beatmap status in the page's words, keyed by osu!'s number (as text) and by its name.</summary>
    private static Dictionary<string, string> StatusNames(Translator t) => new()
    {
        [Js.NumberToString(Status.Ranked)] = t.T("status.ranked"), ["ranked"] = t.T("status.ranked"),
        [Js.NumberToString(Status.Approved)] = t.T("status.approved"), ["approved"] = t.T("status.approved"),
        [Js.NumberToString(Status.Qualified)] = t.T("status.qualified"), ["qualified"] = t.T("status.qualified"),
        [Js.NumberToString(Status.Loved)] = t.T("status.loved"), ["loved"] = t.T("status.loved"),
        [Js.NumberToString(Status.Pending)] = t.T("status.pending"), ["pending"] = t.T("status.pending"),
        [Js.NumberToString(Status.Wip)] = t.T("status.wip"), ["wip"] = t.T("status.wip"),
        [Js.NumberToString(Status.Graveyard)] = t.T("status.graveyard"), ["graveyard"] = t.T("status.graveyard"),
        [Js.NumberToString(Status.Unresolved)] = t.T("export.notSubmitted"),
    };

    private static readonly Dictionary<string, string> ClientNames = new() { ["lazer"] = "osu!lazer", ["stable"] = "osu!stable", ["mcosu"] = "McOsu" };

    private static string SourceName(string source, Translator t) => source switch
    {
        "osu" => t.T("export.fromOsu"),
        "link" => t.T("export.fromLink"),
        "manual" => t.T("export.byHand"),
        _ => t.T("export.replay"),
    };

    private static string Yes(bool b, Translator t) => b ? t.T("export.yes") : t.T("export.no");

    /// <summary><c>Math.round(n * 10^places) / 10^places</c>, null for nothing or not a number.</summary>
    private static double? Round(double? n, int places)
    {
        if (n is not { } value || !double.IsFinite(value)) return null;
        var scale = Math.Pow(10, places);
        return Js.Round(value * scale) / scale;
    }

    private static string? BeatmapLink(object? id) =>
        id is long or double && Convert.ToDouble(id) != 0 ? $"https://osu.ppy.sh/b/{Text(id)}" : id is string { Length: > 0 } s ? $"https://osu.ppy.sh/b/{s}" : null;

    /// <summary><c>String(value)</c> for a value as SQLite or a JSON file gave it.</summary>
    private static string Text(object? value) => value switch
    {
        null => "null",
        string s => s,
        long l => Js.NumberToString(l),
        double d => Js.NumberToString(d),
        JsonElement e => Js.ToJsString(e),
        _ => value.ToString()!,
    };

    /// <summary>A stored value as a cell: a number stays a number, text stays text.</summary>
    private static object? Cell(object? value) => value switch
    {
        null => null,
        long l => (double)l,
        double d => d,
        string s => s,
        JsonElement { ValueKind: JsonValueKind.Null } => null,
        JsonElement { ValueKind: JsonValueKind.Number } n => Js.NumberOf(n),
        JsonElement { ValueKind: JsonValueKind.String } s => s.GetString(),
        JsonElement e => Js.ToJsString(e),
        _ => value.ToString(),
    };

    /// <summary>Artist, title, and each in the song's own script where it reads differently.</summary>
    private static Column[] NameHeaders(Translator t) =>
    [
        new(t.T("export.artist"), 22), new(t.T("export.title"), 30), new(t.T("export.artistOriginal"), 16), new(t.T("export.titleOriginal"), 20),
    ];

    private static object?[] NameCells(BeatmapNames n) => [n.Artist, n.Title, n.ArtistUnicode, n.TitleUnicode];

    /// <summary>A mod's changed settings, as lazer records them: <c>DT speed_change 1.3; DA approach_rate 9</c>.</summary>
    private static string? ModSettings(List<JsonElement> mods)
    {
        var parts = new List<string>();
        foreach (var mod in mods)
        {
            if (Js.Get(mod, "settings") is not { ValueKind: JsonValueKind.Object } settings) continue;
            var acronym = Js.Get(mod, "acronym") is { } a ? Js.ToJsString(a) : "undefined";
            foreach (var p in settings.EnumerateObject()) parts.Add($"{acronym} {p.Name} {Js.ToJsString(p.Value)}");
        }
        return parts.Count > 0 ? string.Join("; ", parts) : null;
    }

    /// <summary>
    /// Every score this profile holds, in every mode or in <paramref name="mode"/>, by pp from
    /// highest to lowest, then those with no pp newest first.
    /// </summary>
    public static Table Scores(Database db, long profileId, Eligibility e, double? mode, Translator t, string? name = null)
    {
        var rows = db.Rows($"""
            SELECT s.*, {Eligibility.PpColumn(e)} AS shown_pp, {Eligibility.StarsColumn(e)} AS shown_stars, {Eligibility.ScoreColumn(e)} AS shown_score,
                   {Eligibility.CountsSql(e)} AS counts, COALESCE(s.map_status, b.status) AS status,
                   {Metadata.NameColumns}, b.version, b.creator, b.beatmapset_id, b.length_ms,
                   COALESCE(s.beatmap_id, b.beatmap_id) AS map_id
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND {Eligibility.VisibleSql()} {(mode is null ? "" : "AND s.mode = ?")}
             ORDER BY shown_pp IS NULL, shown_pp DESC, s.played_at DESC
            """, mode is null ? [profileId] : [profileId, mode.Value]);

        // Where each counted score stands among the profile's best performances, as the page lists them.
        var best = new Dictionary<string, (int Place, double? Weighted)>();
        foreach (var m in mode is null ? [0, 1, 2, 3] : new[] { mode.Value })
        {
            var top = Stats.TopPlays(db, profileId, m, Pp.TopPlayLimit, e);
            for (var i = 0; i < top.Count; i++) best[Text(top[i].Id)] = (i + 1, top[i].WeightedPp);
        }

        // The pp's own parts, under osu!'s names, a column each: whichever any score has.
        var partNames = new List<string>();
        var partsOf = rows.Select(r =>
        {
            var parts = new Dictionary<string, double?>();
            if (Mods.Parse(r["pp_parts"] is null ? "[]" : r.Text("pp_parts")) is { } list)
            {
                foreach (var part in list)
                {
                    // `part.name` on null throws, which ends the loop in JavaScript.
                    if (part.ValueKind == JsonValueKind.Null) break;
                    var partName = Js.Get(part, "name") is { } n ? Js.ToJsString(n) : "undefined";
                    if (!partNames.Contains(partName)) partNames.Add(partName);
                    parts[partName] = Js.Get(part, "pp") is { ValueKind: JsonValueKind.Number } pp ? Js.NumberOf(pp) : null;
                }
            }
            return parts;
        }).ToList();

        var columns = new List<Column>
        {
            new(t.T("export.dateSet"), 18), new(t.T("filter.mode"), 10),
        };
        columns.AddRange(NameHeaders(t));
        columns.AddRange([
            new(t.T("filter.difficulty"), 22), new(t.T("export.mapper"), 14), new(t.T("export.stars"), 7), new("pp", 9),
            new(t.T("export.counts"), 9), new(t.T("export.bestPlace"), 9), new(t.T("export.weightedPp"), 9),
            new($"{t.T("score.accuracy")} %", 9), new(t.T("export.grade"), 10), new(t.T("filter.mods"), 10),
            new(t.T("export.modSettings"), 18), new(t.T("export.score"), 12), new(t.T("export.scoreStandardised"), 12),
            new(t.T("export.scoreClassic"), 12), new(t.T("manualModal.maxCombo"), 8), new(t.T("export.beatmapMaxCombo"), 8),
            new(t.T("export.fullCombo"), 7), new("300 / Great", 7), new("100 / Ok", 7), new("50 / Meh", 7),
            new(t.T("export.geki"), 7), new(t.T("export.katu"), 7), new(t.T("export.miss"), 6), new(t.T("export.passed"), 7),
            new(t.T("export.beatmapStatus"), 11), new(t.T("export.length"), 8),
        ]);
        columns.AddRange(partNames.Select(p => new Column($"pp: {p}", 9)));
        columns.AddRange([
            new(t.T("export.ppNomod"), 9), new(t.T("export.ppVersion"), 14), new(t.T("export.client"), 10),
            new(t.T("export.source"), 16), new(t.T("export.player"), 12), new(t.T("export.beatmapId"), 10),
            new(t.T("export.beatmapsetId"), 10), new(t.T("export.beatmapLink"), 28), new(t.T("export.scoreLink"), 34),
            new(t.T("export.beatmapMd5"), 20),
        ]);

        var statuses = StatusNames(t);
        var table = rows.Select((r, i) =>
        {
            var client = r.Text("client");
            // As osu! lists a stable play: with Classic, which osu! itself scored it with.
            var mods = Mods.WithClassicMod(
                (Mods.Parse(r["mods_json"] is null ? "[]" : r.Text("mods_json")) ?? [])
                    .Where(m => m.ValueKind == JsonValueKind.Object && Js.Truthy(Js.Get(m, "acronym"))).ToList(),
                client);
            var miss = r.Num("count_miss") ?? (r["count_miss"] is null ? 0 : double.NaN);
            var mapCombo = r.Num("beatmap_max_combo");
            best.TryGetValue(Text(r["id"]), out var place);
            var hasPlace = best.ContainsKey(Text(r["id"]));
            var status = r["status"];
            var cells = new List<object?>
            {
                new DateCell(r.Num("played_at") ?? double.NaN),
                ModeName(r["mode"]),
            };
            cells.AddRange(NameCells(Metadata.Names(r)));
            cells.AddRange([
                Cell(r["version"]),
                Cell(r["creator"]),
                Round(r.Num("shown_stars"), 2),
                Round(r.Num("shown_pp"), 3),
                Yes(r.Is1("counts"), t),
                hasPlace ? (double)place.Place : null,
                Round(hasPlace ? place.Weighted : null, 3),
                Round((r.Num("accuracy") ?? 0) * 100, 2),
                GradeName(r.Text("grade"), t),
                mods.Count == 0 ? t.T("export.noMods") : string.Concat(mods.Select(m => Js.ToJsString(Js.Get(m, "acronym")!.Value))),
                ModSettings(mods),
                Cell(r["shown_score"]),
                Cell(r["score_standard"]),
                Cell(r["score_classic"]),
                Cell(r["max_combo"]),
                Cell(mapCombo),
                miss > 0 ? t.T("export.no") : mapCombo is null or <= 0 ? null : Yes((r.Num("max_combo") ?? 0) >= mapCombo, t),
                Cell(r["count300"]),
                Cell(r["count100"]),
                Cell(r["count50"]),
                Cell(r["count_geki"]),
                Cell(r["count_katu"]),
                miss,
                Yes(r.Is1("passed"), t),
                status is null ? null : statuses.GetValueOrDefault(Text(status)),
                r["length_ms"] is null ? null : Js.Round((r.Num("length_ms") ?? double.NaN) / 1000),
            ]);
            cells.AddRange(partNames.Select(p => (object?)Round(partsOf[i].GetValueOrDefault(p), 3)));
            cells.AddRange([
                Round(r.Num("pp_nomod"), 3),
                Cell(r["pp_version"]),
                ClientNames.GetValueOrDefault(client, client),
                SourceName(Stats.PlaySource(r["origin"], r["imported_at"] is not null), t),
                r["player_name"] is string { Length: > 0 } player ? player : r["player_name"] is null or "" ? null : Cell(r["player_name"]),
                Cell(r["map_id"]),
                Cell(r["beatmapset_id"]),
                BeatmapLink(r["map_id"]),
                Stats.ScoreUrl(r.Num("mode") ?? double.NaN, client, r["online_score_id"], r["legacy_score_id"]),
                Cell(r["beatmap_md5"]),
            ]);
            return cells.ToArray();
        }).ToList();

        return new Table(name ?? t.T("export.sheetScores"), columns, table);
    }

    /// <summary>The figures at the top of the profile page, one row per mode this profile has played.</summary>
    public static Table Summary(Database db, long profileId, string profileName, Eligibility e, Translator t)
    {
        var medals = Medals.EarnedCount(db, profileId, e);
        var rows = Stats.ModesWithPlays(db, profileId, e).Select(modeValue =>
        {
            var mode = Convert.ToDouble(modeValue);
            var s = Stats.Compute(db, profileId, mode, e);
            return new object?[]
            {
                profileName, ModeName(modeValue), Round(s.TotalPp, 3), Round(s.BonusPp, 3),
                Ranks.Estimate(s.TotalPp, mode) is { } rank ? (double)rank.Rank : null,
                Round(s.Accuracy * 100, 2), s.Playcount, Round(s.PlayTime / 3600, 1), s.RankedScore, s.TotalScore,
                s.TotalHits, s.HitsPerPlay, s.MaxCombo, Round(s.Level.Current + s.Level.Progress, 2),
                (double)s.Grades["XH"], (double)s.Grades["X"], (double)s.Grades["SH"], (double)s.Grades["S"], (double)s.Grades["A"],
                (double)medals,
            };
        }).ToList();
        return new Table(t.T("export.sheetSummary"),
        [
            new(t.T("export.profile"), 16), new(t.T("filter.mode"), 10), new("pp", 10), new(t.T("export.bonusPp"), 9),
            new(t.T("export.globalRank"), 12), new($"{t.T("score.accuracy")} %", 9), new(t.T("stats.playCount"), 9),
            new(t.T("export.playTime"), 9), new(t.T("stats.rankedScore"), 14), new(t.T("stats.totalScore"), 14),
            new(t.T("stats.totalHits"), 11), new(t.T("stats.hitsPerPlay"), 8), new(t.T("stats.maximumCombo"), 9),
            new(t.T("export.level"), 7), new(GradeName("XH", t), 7), new("SS", 6), new(GradeName("SH", t), 7), new("S", 6),
            new("A", 6), new(t.T("page.medals"), 7),
        ], rows);
    }

    /// <summary>Most Played Beatmaps, whole: every beatmap played in every mode, most plays first.</summary>
    public static Table MostPlayed(Database db, long profileId, Eligibility e, Translator t)
    {
        var rows = new List<object?[]>();
        foreach (var modeValue in Stats.ModesWithPlays(db, profileId, e))
        {
            foreach (var m in Stats.MostPlayed(db, profileId, Convert.ToDouble(modeValue), 9007199254740991, e))
            {
                var row = new List<object?> { ModeName(modeValue) };
                row.AddRange(NameCells(Metadata.Names(m.Artist, m.Title, m.ArtistUnicode, m.TitleUnicode)));
                row.AddRange([Cell(m.Version), Cell(m.Creator), Cell(m.Count), Cell(m.BeatmapId), Cell(m.BeatmapsetId), BeatmapLink(m.BeatmapId)]);
                rows.Add([.. row]);
            }
        }
        var columns = new List<Column> { new(t.T("filter.mode"), 10) };
        columns.AddRange(NameHeaders(t));
        columns.AddRange([
            new(t.T("filter.difficulty"), 22), new(t.T("export.mapper"), 14), new(t.T("export.plays"), 7),
            new(t.T("export.beatmapId"), 10), new(t.T("export.beatmapsetId"), 10), new(t.T("export.beatmapLink"), 28),
        ]);
        return new Table(t.T("heading.mostPlayed"), columns, rows);
    }

    /// <summary>Favorite Beatmaps, most recently favourited first, as the section lists them.</summary>
    public static Table Favorites(Database db, FavoriteScope scope, Translator t)
    {
        var statuses = StatusNames(t);
        var rows = OsuLocalProfiles.Favorites.List(db, scope, 9007199254740991).Select(f =>
        {
            object? Get(string key) => f.TryGetValue(key, out var v) ? v : null;
            var row = new List<object?>();
            row.AddRange(NameCells(Metadata.Names(Cell(Get("artist")), Cell(Get("title")), Cell(Get("artistUnicode")), Cell(Get("titleUnicode")))));
            var status = Get("status");
            var difficulties = (Get("difficulties") as System.Collections.IEnumerable)?.Cast<Dictionary<string, object?>>().ToList() ?? [];
            var versions = string.Join("; ", difficulties.Select(d => d.TryGetValue("version", out var v) && v is not null && v is not JsonElement { ValueKind: JsonValueKind.Null } ? Text(v) : ""));
            row.AddRange([
                Cell(Get("creator")),
                status is null or JsonElement { ValueKind: JsonValueKind.Null } ? null : statuses.TryGetValue(Text(status), out var said) ? said : Cell(status),
                (double)difficulties.Count,
                versions.Length > 0 ? versions : null,
                new DateCell(Get("favoritedAt") is { } at ? Convert.ToDouble(Cell(at)) : double.NaN),
                Cell(Get("id")),
                $"https://osu.ppy.sh/beatmapsets/{Text(Get("id"))}",
            ]);
            return row.ToArray();
        }).ToList();
        var columns = new List<Column>(NameHeaders(t))
        {
            new(t.T("export.mapper"), 14), new(t.T("export.status"), 10), new(t.T("export.difficulties"), 8),
            new(t.T("export.difficultyNames"), 30), new(t.T("export.favorited"), 18), new(t.T("export.beatmapsetId"), 10),
            new(t.T("export.link"), 34),
        };
        return new Table(t.T("heading.favoriteBeatmaps"), columns, rows);
    }

    /// <summary>Which mode a medal belongs to, from osu!'s own slug; the rest are every mode's.</summary>
    private static string MedalMode(string slug, Translator t) => slug.Split('-')[0] switch
    {
        "osu" => "osu!",
        "taiko" => "osu!taiko",
        "fruits" => "osu!catch",
        "mania" => "osu!mania",
        _ => t.T("export.allModes"),
    };

    /// <summary>Every medal this app awards, earned first and in the order they were earned.</summary>
    public static Table MedalsTable(Database db, long profileId, Eligibility e, Translator t)
    {
        var seen = new Dictionary<string, object?[]>();
        var order = new List<(string Slug, bool Earned, double At)>();
        foreach (var mode in new double[] { 0, 1, 2, 3 })
        {
            var medals = Medals.Compute(db, profileId, mode, e).Medals;
            for (var i = 0; i < medals.Count; i++)
            {
                var m = medals[i];
                if (seen.ContainsKey(m.Slug)) continue;
                var earned = m.AchievedAt is not null;
                var at = earned ? Convert.ToDouble(m.AchievedAt) : double.NaN;
                seen[m.Slug] =
                [
                    m.Name,
                    m.Grouping == "Mod Introduction" ? t.T("medals.modIntroduction") : t.T("medals.skillDedication"),
                    MedalMode(m.Slug, t),
                    m.Description,
                    Yes(earned, t),
                    // A rank medal is decided from the estimated rank, and has no date of its own.
                    earned && m.Dated ? new DateCell(at) : null,
                    earned ? Yes(m.FromOsu, t) : null,
                ];
                order.Add((m.Slug, earned, earned && m.Dated ? at : 9007199254740991.0 - 1000 + i));
            }
        }
        var sorted = order.OrderByDescending(o => o.Earned).ThenBy(o => o.At).ToList();
        return new Table(t.T("page.medals"),
        [
            new(t.T("export.medal"), 24), new(t.T("export.group"), 16), new(t.T("filter.mode"), 10),
            new(t.T("export.description"), 50), new(t.T("export.earned"), 7), new(t.T("export.achieved"), 18),
            new(t.T("export.fromOsu"), 9),
        ], [.. sorted.Select(o => seen[o.Slug])]);
    }

    /// <summary>The whole workbook: every score, each mode's alone when there is more than one, then the rest.</summary>
    public static List<Table> Workbook(Database db, long profileId, string profileName, Eligibility e, FavoriteScope favorites, Translator t)
    {
        var modes = Stats.ModesWithPlays(db, profileId, e);
        var tables = new List<Table> { Scores(db, profileId, e, null, t) };
        if (modes.Count > 1)
        {
            tables.AddRange(modes.Select(m => Scores(db, profileId, e, Convert.ToDouble(m), t,
                t.T("export.sheetScoresMode", ("mode", ModeName(m) ?? "")))));
        }
        tables.Add(Summary(db, profileId, profileName, e, t));
        tables.Add(MostPlayed(db, profileId, e, t));
        tables.Add(Favorites(db, favorites, t));
        tables.Add(MedalsTable(db, profileId, e, t));
        return tables;
    }
}
