using System.Text.RegularExpressions;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Calc;

/// <summary>One page of the Scores view, and how many rows the whole list has.</summary>
internal sealed record ScoreListPage(List<Play> Rows, int Total);

/// <summary>What a mode's scores offer the Scores view's filters: the mods, grades and clients present.</summary>
internal sealed record ScoreListChoices(List<string> Mods, List<string> Grades, List<string> Clients);

/// <summary>
/// The Scores view (roadmap 5.86): every score of a mode, or the best on each beatmap, sorted and
/// narrowed as the profile set it up. Built on the same definitions as Best Performance, so its
/// default is exactly Best Performance without the cap of 100.
/// </summary>
internal static partial class Stats
{
    /// <summary>
    /// The mods in the order osu!lazer's mod select lists them (difficulty reduction, difficulty
    /// increase, conversion, automation, fun, system), every ruleset's together, with Torii's and
    /// Ritsu's after osu!'s in each, then McOsu's and neomod's own; anything else after,
    /// alphabetically. The filter's order, and the mods sort's.
    /// </summary>
    private static readonly string[] ModOrder =
    [
        "EZ", "NF", "HT", "DC", "NR", "HST",
        "HR", "SD", "PF", "DT", "NC", "HD", "FI", "CO", "FL", "BL", "ST", "AC", "NL", "HFR", "DFK", "DCY", "RSL",
        "TP", "DA", "CL", "RD", "MR", "AL", "SG", "SW", "SR", "CS", "HO", "IN", "DS",
        "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K", "CG", "RDV2", "SA", "SOT",
        "AT", "CN", "RX", "AP", "SO",
        "TR", "WG", "SI", "GR", "DF", "WU", "WD", "TC", "BR", "AD", "MU", "NS", "MG", "RP", "AS", "FR", "BU", "SY",
        "DP", "BM", "FF", "MF", "ME", "HS", "PA",
        "TD", "SV2", "PMR", "ECH", "SWG",
        "MC", "NEO",
    ];

    /// <summary>The most search words that are each looked for.</summary>
    private const int SearchWords = 10;

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    /// <summary>A row's mods as JSON SQLite can read, a malformed one as none.</summary>
    private const string ModsJson = "CASE WHEN json_valid(s.mods_json) THEN s.mods_json ELSE '[]' END";

    /// <summary>The ORDER BY expression for each sort, over the listed columns.</summary>
    private static string SortExpression(string sort) => sort switch
    {
        "score" => "total_score",
        "accuracy" => "accuracy",
        "combo" => "max_combo",
        "stars" => "stars",
        "misses" => "count_miss",
        "playcount" => "playcount",
        "date" => "played_at",
        "beatmap" => "COALESCE(title, '') COLLATE NOCASE",
        "grade" => GradeRank,
        "mods" => ModsKey,
        _ => "pp",
    };

    /// <summary>A grade's place, silver SS highest and F lowest; anything else has none and goes last.</summary>
    private static readonly string GradeRank =
        $"CASE grade {string.Join(" ", ScoreListView.GradeNames.Select((g, i) => $"WHEN '{g}' THEN {ScoreListView.GradeNames.Length - i}"))} END";

    /// <summary>
    /// A play's mods as text that sorts them into groups: how many there are, then each one's place
    /// in <see cref="ModOrder"/>, so no mod comes first, then single mods, then combinations, and the
    /// same combination in any order or with any settings is one group. McOsu's and neomod's own
    /// mods are one each (MC, NEO), as the filter has them. Classic counts wherever a play shows it,
    /// so on every play osu! scores as stable (<see cref="Mods.WithClassicMod"/>).
    /// </summary>
    private static readonly string ModsKey = $"""
        (SELECT printf('%03d', COUNT(*)) || COALESCE(group_concat(k, '' ORDER BY k), '')
           FROM (SELECT printf('%03d%-4s',
                        CASE a {string.Join(" ", ModOrder.Select((m, i) => $"WHEN '{m}' THEN {i}"))} ELSE 999 END, a) AS k
                   FROM (SELECT json_extract(j.value, '$.acronym') AS a
                           FROM json_each(CASE WHEN json_valid(mods_json) THEN mods_json ELSE '[]' END) j
                          WHERE a IS NOT NULL
                          UNION
                         SELECT 'CL' WHERE client IN ({string.Join(", ", Mods.StableScoredClients.Select(c => $"'{c}'"))}))))
        """;

    /// <summary>
    /// The listed rows, unordered: each visible score that counts toward pp (or any, when the view
    /// says so) and passes the view's filters, with its beatmap's playcount and its place among the
    /// listed scores on that beatmap. The best on a beatmap is its highest pp, as on osu!.
    /// </summary>
    private static (string Sql, List<object?> Args) ListedSql(long profileId, double mode, ScoreListView view, Eligibility e,
        Func<string, List<double>>? mappedBy)
    {
        var args = new List<object?> { profileId, mode, profileId, mode, profileId, mode };
        var where = new List<string> { view.Uncounted ? Eligibility.VisibleSql() : Eligibility.CountsSql(e) };

        // Each word somewhere in the beatmap's names, its tags, or the name of whoever mapped it.
        foreach (var word in Whitespace().Split(view.Search).Where(w => w.Length > 0).Take(SearchWords))
        {
            var like = $"%{OsuLocalProfiles.Clients.BeatmapResolver.LikeEscaped(word)}%";
            var fields = new[] { "b.artist", "b.title", "b.artist_unicode", "b.title_unicode", "b.version", "b.creator", "b.tags" };
            where.Add($"({string.Join(" OR ", fields.Select(f => $"{f} LIKE ? ESCAPE '\\'"))} OR s.beatmap_id IN (SELECT value FROM json_each(?)))");
            args.AddRange(fields.Select(_ => (object?)like));
            args.Add(JsonText.Stringify(mappedBy?.Invoke(word) ?? []));
        }
        foreach (var mod in view.Mods)
        {
            if (mod == "NM")
            {
                where.Add($"NOT EXISTS (SELECT 1 FROM json_each({ModsJson}) j WHERE json_extract(j.value, '$.acronym') IS NOT NULL)");
                continue;
            }
            where.Add($"EXISTS (SELECT 1 FROM json_each({ModsJson}) j WHERE json_extract(j.value, '$.acronym') = ?)");
            args.Add(mod);
        }
        if (view.Grades.Count > 0)
        {
            where.Add($"s.grade IN ({string.Join(", ", view.Grades.Select(_ => "?"))})");
            args.AddRange(view.Grades);
        }
        if (view.Clients.Count > 0)
        {
            where.Add($"s.client IN ({string.Join(", ", view.Clients.Select(_ => "?"))})");
            args.AddRange(view.Clients);
        }
        if (view.StarsMin is { } min) { where.Add($"{Eligibility.StarsColumn(e)} >= ?"); args.Add(min); }
        if (view.StarsMax is { } max) { where.Add($"{Eligibility.StarsColumn(e)} <= ?"); args.Add(max); }
        if (view.From is { } from) { where.Add("s.played_at >= ?"); args.Add(from); }
        if (view.To is { } to) { where.Add("s.played_at <= ?"); args.Add(to); }

        var pp = Eligibility.PpColumn(e);
        var sql = $"""
            WITH playcounts AS (
              SELECT p.beatmap_md5, COUNT(*) AS n FROM (
                SELECT s.beatmap_md5 FROM scores s
                 WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
                 UNION ALL
                SELECT s.beatmap_md5 FROM incomplete_plays s
                 WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)} AND s.beatmap_md5 IS NOT NULL) p
               GROUP BY p.beatmap_md5),
            listed AS (
              SELECT {PlayColumns(e)}, {pp} AS pp, s.count_miss, COALESCE(pc.n, 1) AS playcount,
                     ROW_NUMBER() OVER (PARTITION BY s.beatmap_md5
                                        ORDER BY {pp} IS NULL, {pp} DESC, {Eligibility.ScoreColumn(e)} DESC, s.played_at DESC) AS place_on_map
                FROM scores s
                LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
                LEFT JOIN playcounts pc ON pc.beatmap_md5 = s.beatmap_md5
               WHERE s.profile_id = ? AND s.mode = ? AND {string.Join("\n AND ", where)})
            SELECT * FROM listed{(view.Show == "every" ? "" : " WHERE place_on_map = 1")}
            """;
        return (sql, args);
    }

    /// <summary>
    /// The sort, then each further level of a custom one, then what the first level breaks ties
    /// with on its own, then the newest first. Within a level, rows with nothing to sort by go last
    /// either way round.
    /// </summary>
    private static string ListOrder(ScoreListView view)
    {
        var terms = new List<string>();
        foreach (var (sort, order) in new[] { (view.Sort, view.Order) }.Concat(view.Then.Select(l => (l.Sort, l.Order))))
        {
            var by = SortExpression(sort);
            terms.Add($"{by} IS NULL, {by} {(order == "asc" ? "ASC" : "DESC")}");
        }
        // Many scores share a grade, or a set of mods: within one, by accuracy the same way round,
        // or by pp, best first.
        if (view.Sort == "grade") terms.Add($"accuracy {(view.Order == "asc" ? "ASC" : "DESC")}");
        if (view.Sort == "mods") terms.Add("pp IS NULL, pp DESC");
        return $"ORDER BY {string.Join(", ", terms)}, played_at DESC, id DESC";
    }

    /// <summary>One page of the Scores view.</summary>
    public static ScoreListPage ScoreList(Database db, long profileId, double mode, ScoreListView view, Eligibility e,
        int offset, int limit, Func<string, List<double>>? mappedBy = null)
    {
        var (sql, args) = ListedSql(profileId, mode, view, e, mappedBy);
        var total = Convert.ToInt32(db.Scalar($"SELECT COUNT(*) AS n FROM ({sql})", [.. args]));
        var rows = db.Rows($"{sql}\n{ListOrder(view)}\nLIMIT ? OFFSET ?", [.. args, limit, offset]);
        return new ScoreListPage([.. rows.Select(ListedPlay(e))], total);
    }

    /// <summary>Every row of the Scores view, in its order: what its export writes.</summary>
    public static List<Play> ScoreListAll(Database db, long profileId, double mode, ScoreListView view, Eligibility e,
        Func<string, List<double>>? mappedBy = null)
    {
        var (sql, args) = ListedSql(profileId, mode, view, e, mappedBy);
        return [.. db.Rows($"{sql}\n{ListOrder(view)}", [.. args]).Select(ListedPlay(e))];
    }

    private static Func<Row, Play> ListedPlay(Eligibility e) => r =>
    {
        var play = ToPlay(r, e);
        play.Playcount = r["playcount"];
        play.Misses = r["count_miss"];
        return play;
    };

    /// <summary>
    /// The mods (Classic aside, which no row stores), grades and clients among a mode's visible
    /// scores: what the filters offer, so none of them can only ever find nothing.
    /// </summary>
    public static ScoreListChoices ScoreListChoices(Database db, long profileId, double mode)
    {
        var mods = db.All($"""
            SELECT DISTINCT json_extract(j.value, '$.acronym') AS acronym
              FROM scores s, json_each({ModsJson}) j
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()} AND acronym IS NOT NULL
            """, r => r.GetValue(0) as string, profileId, mode).OfType<string>().ToList();
        mods = [.. mods.OrderBy(m => Array.IndexOf(ModOrder, m) is var i && i >= 0 ? i : ModOrder.Length).ThenBy(m => m, StringComparer.Ordinal)];
        var grades = db.All($"SELECT DISTINCT s.grade FROM scores s WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}",
            r => r.GetValue(0) as string, profileId, mode).OfType<string>().ToList();
        var clients = db.All($"SELECT DISTINCT s.client FROM scores s WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()} ORDER BY s.client",
            r => r.GetValue(0) as string, profileId, mode).OfType<string>().ToList();
        return new ScoreListChoices(mods,
            [.. ScoreListView.GradeNames.Where(grades.Contains)],
            clients);
    }
}
