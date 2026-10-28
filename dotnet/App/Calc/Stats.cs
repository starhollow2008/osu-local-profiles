using System.Text.Json;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Calc;

/// <summary>
/// One score as the profile page renders it: Top Ranks, Recent Plays, pinned. Values read
/// straight from a column are kept as SQLite gave them (<see cref="Row"/>).
/// </summary>
internal sealed class Play
{
    public string Kind => "score";
    public object? Id { get; init; }
    public object? BeatmapMd5 { get; init; }
    public object? BeatmapId { get; init; }
    public object? BeatmapsetId { get; init; }
    public string? Artist { get; init; }
    public string? Title { get; init; }
    public string? ArtistUnicode { get; init; }
    public string? TitleUnicode { get; init; }
    public object? Version { get; init; }
    public object? Creator { get; init; }
    /// <summary>Full mod objects: lazer carries settings such as DT at 1.3x.</summary>
    public List<JsonElement> Mods { get; init; } = [];
    public object? Accuracy { get; init; }
    public object? MaxCombo { get; init; }
    public object? TotalScore { get; init; }
    public object? Grade { get; init; }
    public object? Stars { get; init; }
    public object? Pp { get; init; }
    public bool Ranked { get; init; }
    public bool Passed { get; init; }
    public object? PlayedAt { get; init; }
    /// <summary>0.95^index, only for Top Ranks, where the play's pp is weighted.</summary>
    public double? Weight { get; set; }
    public double? WeightedPp { get; set; }
    /// <summary>Counts toward this profile's pp, which is not the same as <c>Ranked</c>.</summary>
    public bool Counted { get; init; }
    public bool Pinned { get; init; }
    public bool HasReplay { get; init; }
    /// <summary><c>replay</c>, or one of the sources with no replay: <c>osu</c>, <c>link</c>, <c>manual</c>.</summary>
    public string Source { get; init; } = "replay";
    public string? OsuUrl { get; init; }
    /// <summary><c>without-unranked-mods</c> when priced with Relax or Autopilot removed.</summary>
    public string? PpBasis { get; init; }

    /// <summary>For sorting by time: <c>playedAt</c> as a number.</summary>
    internal double At => PlayedAt switch { long l => l, double d => d, _ => double.NaN };
}

/// <summary>A play osu! counted that has no score attached: a quit, a retry, an HP fail.</summary>
internal sealed class IncompletePlay
{
    public string Kind => "incomplete";
    public object? Id { get; init; }
    /// <summary>Every attempt this row stands for, <c>Id</c> included: what removing the row removes.</summary>
    public List<object?> Ids { get; init; } = [];
    public object? BeatmapMd5 { get; init; }
    public object? BeatmapId { get; init; }
    public object? BeatmapsetId { get; init; }
    public string? Artist { get; init; }
    public string? Title { get; init; }
    public string? ArtistUnicode { get; init; }
    public string? TitleUnicode { get; init; }
    public object? Version { get; init; }
    public object? Creator { get; init; }
    public object? PlayedAt { get; init; }
    /// <summary>Consecutive attempts on this beatmap folded into this row; 1 unless collapsed.</summary>
    public int Attempts { get; set; } = 1;
    public bool Unsubmitted { get; init; }

    internal double At => PlayedAt switch { long l => l, double d => d, _ => double.NaN };

    internal IncompletePlay Copy() => new()
    {
        Id = Id, Ids = [.. Ids], BeatmapMd5 = BeatmapMd5, BeatmapId = BeatmapId, BeatmapsetId = BeatmapsetId,
        Artist = Artist, Title = Title, ArtistUnicode = ArtistUnicode, TitleUnicode = TitleUnicode,
        Version = Version, Creator = Creator, PlayedAt = PlayedAt, Attempts = Attempts, Unsubmitted = Unsubmitted,
    };
}

internal sealed record MostPlayedEntry(
    object? BeatmapMd5, object? BeatmapId, object? BeatmapsetId,
    string? Artist, string? Title, string? ArtistUnicode, string? TitleUnicode,
    object? Version, object? Creator, object? Count);

internal sealed record ProfileStats(
    double Mode,
    double TotalPp,
    double WeightedPp,
    double BonusPp,
    bool BonusPpBorrowed,
    double Accuracy,
    double Playcount,
    double TotalScore,
    double RankedScore,
    double TotalHits,
    double HitsPerPlay,
    double MaxCombo,
    double PlayTime,
    Level Level,
    Dictionary<string, int> Grades,
    int DistinctRankedBeatmaps);

/// <summary>The profile's totals and lists: src/calc/stats.ts.</summary>
internal static class Stats
{
    private static readonly string[] GradeNames = ["XH", "X", "SH", "S", "A", "B", "C", "D", "F"];

    private static readonly string[] ModeForRuleset = ["osu", "taiko", "fruits", "mania"];

    /// <summary>A score's page on osu!, from what a row stores. Null for a play osu! never had (<c>scoreUrl</c>).</summary>
    public static string? ScoreUrl(double mode, string client, object? onlineScoreId, object? legacyScoreId)
    {
        var ruleset = mode is 0 or 1 or 2 or 3 ? ModeForRuleset[(int)mode] : "osu";
        string Text(object value) => value switch
        {
            string s => s,
            long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
            double d => Js.NumberToString(d),
            _ => value.ToString()!,
        };
        // A stable play's legacy id, where one is kept, finds it however the row came to be.
        if (legacyScoreId is not null) return $"https://osu.ppy.sh/scores/{ruleset}/{Text(legacyScoreId)}";
        if (onlineScoreId is null || onlineScoreId is "0" || client == "mcosu") return null;
        // A stable replay's id is a legacy one, which only the ruleset form finds.
        return client == "stable"
            ? $"https://osu.ppy.sh/scores/{ruleset}/{Text(onlineScoreId)}"
            : $"https://osu.ppy.sh/scores/{Text(onlineScoreId)}";
    }

    /// <summary>A row's source, from its <c>origin</c> and <c>imported_at</c> (<c>playSource</c>).</summary>
    public static string PlaySource(object? origin, bool imported) =>
        origin is "link" or "manual" ? (string)origin : imported ? "osu" : "replay";

    /// <summary>The columns every play row needs, joined to its beatmap (<c>playColumns</c>).</summary>
    private static string PlayColumns(Eligibility e) => $"""
        s.id, s.beatmap_md5, s.beatmap_id, s.mods_json, s.client, s.accuracy, s.max_combo,
                {Eligibility.ScoreColumn(e)} AS total_score, s.grade, s.ranked, s.passed, s.played_at,
                {Eligibility.StarsColumn(e)} AS stars,
                {Eligibility.CountsSql(e)} AS counts,
                s.pp_nomod IS NOT NULL AS has_nomod,
                s.pinned_at IS NOT NULL AS pinned,
                -- A McOsu play's replay is one this app built, with no cursor data: nothing to offer.
                -- Nor is one built for a score from its link or entered by hand.
                (s.replay_path IS NOT NULL AND s.client <> 'mcosu' AND s.origin IS NULL) AS has_replay,
                s.mode, s.origin, s.imported_at IS NOT NULL AS imported, s.online_score_id, s.legacy_score_id,
                b.beatmapset_id, {Metadata.NameColumns}, b.version, b.creator
        """;

    /// <summary><c>JSON.parse(...).filter((m) =&gt; m?.acronym)</c>, or none when it is not a list.</summary>
    private static List<JsonElement> RowMods(Row r)
    {
        var json = r["mods_json"] is null ? "[]" : r.Text("mods_json");
        // A malformed row should not take the whole page down.
        return (Mods.Parse(json) ?? []).Where(m => m.ValueKind == JsonValueKind.Object && Js.Truthy(Js.Get(m, "acronym"))).ToList();
    }

    private static Play ToPlay(Row r, Eligibility e)
    {
        var names = Metadata.Names(r);
        var client = r.Text("client");
        return new Play
        {
            Id = r["id"],
            BeatmapMd5 = r["beatmap_md5"],
            BeatmapId = r["beatmap_id"],
            BeatmapsetId = r["beatmapset_id"],
            Artist = names.Artist,
            Title = names.Title,
            ArtistUnicode = names.ArtistUnicode,
            TitleUnicode = names.TitleUnicode,
            Version = r["version"],
            Creator = r["creator"],
            // As osu! lists a stable play: with Classic, which osu! itself scored it with.
            Mods = Mods.WithClassicMod(RowMods(r), client),
            Accuracy = r["accuracy"],
            MaxCombo = r["max_combo"],
            TotalScore = r["total_score"],
            Grade = r["grade"],
            Stars = r["stars"],
            Pp = r["pp"],
            Ranked = r.Is1("ranked"),
            Passed = r.Is1("passed"),
            PlayedAt = r["played_at"],
            Counted = r.Is1("counts"),
            Pinned = r.Is1("pinned"),
            HasReplay = r.Is1("has_replay"),
            Source = PlaySource(r["origin"], r.Is1("imported")),
            OsuUrl = ScoreUrl(r.Num("mode") ?? double.NaN, client, r["online_score_id"], r["legacy_score_id"]),
            PpBasis = r["pp"] is null ? null : e.PreferStrippedPp && r.Is1("has_nomod") ? "without-unranked-mods" : "as-played",
        };
    }

    /// <summary>The best pp score on each distinct beatmap: osu! counts one per map toward pp.</summary>
    private static List<Row> BestPerBeatmap(Database db, long profileId, double mode, Eligibility e) => db.Rows($"""
        SELECT s.beatmap_md5, MAX({Eligibility.PpColumn(e)}) AS pp, s.accuracy, s.grade
          FROM scores s
         WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.CountsSql(e)}
         GROUP BY s.beatmap_md5
         ORDER BY pp DESC
        """, profileId, mode);

    public static ProfileStats Compute(Database db, long profileId, double mode, Eligibility e)
    {
        var best = BestPerBeatmap(db, profileId, mode, e);
        var top = best.Take(Pp.TopPlayLimit).ToList();
        var weighted = Pp.WeightedTotal([.. top.Select(r => r.Num("pp") ?? 0)]);

        // From this profile's own breadth of play, or osu!'s figure for the account it was
        // imported from, whichever is larger: self-correcting as real plays are tracked.
        var earned = Pp.BonusPp(best.Count);
        var borrowed = Standing.ImportedBonusPp(db, profileId, mode) ?? 0;
        var bonus = Math.Max(earned, borrowed);

        var totals = db.FirstRow($"""
            SELECT COUNT(*)                                            AS playcount,
                   COALESCE(SUM({Eligibility.ScoreColumn(e)}), 0)       AS total_score,
                   COALESCE(SUM(count300 + count100 + count50
                                + count_geki + count_katu), 0)         AS total_hits,
                   COALESCE(MAX(max_combo), 0)                         AS max_combo
              FROM scores s
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
            """, profileId, mode)!;

        // Plays that finished without a score: osu! counts these, so this does too.
        var incomplete = Convert.ToDouble(db.Scalar($"""
            SELECT COUNT(*) AS n FROM incomplete_plays s
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}
            """, profileId, mode));

        // Ranked score counts the best score on each ranked map, not every attempt.
        var rankedScore = Convert.ToDouble(db.Scalar($"""
            SELECT COALESCE(SUM(best), 0) AS ranked_score FROM (
              SELECT MAX({Eligibility.ScoreColumn(e)}) AS best
                FROM scores s
               WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.CountsSql(e)}
               GROUP BY s.beatmap_md5)
            """, profileId, mode));

        var grades = GradeNames.ToDictionary(g => g, _ => 0);
        foreach (var row in best)
        {
            if (row["grade"] is string grade && grades.ContainsKey(grade)) grades[grade]++;
        }

        var playcount = totals.Num("playcount") ?? 0;
        var totalScore = totals.Num("total_score") ?? 0;
        var totalHits = totals.Num("total_hits") ?? 0;
        return new ProfileStats(
            Mode: mode,
            TotalPp: weighted + bonus,
            WeightedPp: weighted,
            BonusPp: bonus,
            BonusPpBorrowed: bonus > earned,
            Accuracy: Pp.WeightedAccuracy([.. top.Select(r => r.Num("accuracy") ?? double.NaN)]),
            Playcount: playcount + incomplete,
            TotalScore: totalScore,
            RankedScore: rankedScore,
            TotalHits: totalHits,
            // Over the scored plays only, where both halves are known; osu-web floors it.
            HitsPerPlay: playcount > 0 ? Math.Floor(totalHits / playcount) : 0,
            MaxCombo: totals.Num("max_combo") ?? 0,
            PlayTime: PlayTime.Seconds(db, profileId, mode, e),
            Level: Levels.FromScore(totalScore),
            Grades: grades,
            DistinctRankedBeatmaps: best.Count);
    }

    public static List<Play> TopPlays(Database db, long profileId, double mode, int limit, Eligibility e)
    {
        var rows = db.Rows($"""
            SELECT {PlayColumns(e)}, MAX({Eligibility.PpColumn(e)}) AS pp
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.CountsSql(e)}
             GROUP BY s.beatmap_md5
             ORDER BY pp DESC
             LIMIT ?
            """, profileId, mode, limit);
        return [.. rows.Select((r, i) =>
        {
            var play = ToPlay(r, e);
            play.Weight = Math.Pow(Pp.Weight, i);
            play.WeightedPp = (r.Num("pp") ?? 0) * play.Weight;
            return play;
        })];
    }

    /// <summary>
    /// Scores the user pinned, in their order. Not filtered by eligibility: pinning is how to show a
    /// play pp does not reward. Each still says whether it counts.
    /// </summary>
    public static List<Play> PinnedPlays(Database db, long profileId, double mode, Eligibility e) =>
        [.. db.Rows($"""
            SELECT {PlayColumns(e)}, {Eligibility.PpColumn(e)} AS pp
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()} AND s.pinned_at IS NOT NULL
             ORDER BY s.pin_order ASC, s.pinned_at ASC
            """, profileId, mode).Select(r => ToPlay(r, e))];

    /// <summary>One visible score as a row would show it, or null when it is not this profile's.</summary>
    public static Play? PlayById(Database db, long profileId, long id, Eligibility e)
    {
        var row = db.FirstRow($"""
            SELECT {PlayColumns(e)}, {Eligibility.PpColumn(e)} AS pp
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.id = ? AND s.profile_id = ? AND {Eligibility.VisibleSql()}
            """, id, profileId);
        return row is null ? null : ToPlay(row, e);
    }

    /// <summary>How many rows to pull from each side before merging, as collapsing shrinks the list.</summary>
    private const int RecentSourceRows = 200;

    /// <summary>
    /// Every recent play, counting or not, with abandoned attempts merged in by time according to
    /// <paramref name="incomplete"/>: <c>yes</c>, <c>collapse</c> (consecutive runs on one map
    /// folded into one row) or <c>no</c>.
    /// </summary>
    public static List<object> RecentPlays(Database db, long profileId, double mode, int limit, Eligibility e, string incomplete)
    {
        var want = incomplete == "no" ? limit : Math.Min(RecentSourceRows, Math.Max(limit * 8, limit));

        var scores = db.Rows($"""
            SELECT {PlayColumns(e)}, {Eligibility.PpColumn(e)} AS pp
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
             ORDER BY s.played_at DESC
             LIMIT ?
            """, profileId, mode, want).Select(r => ToPlay(r, e)).ToList();
        if (incomplete == "no") return [.. scores.Take(limit)];

        var abandoned = db.Rows($"""
            SELECT s.id, s.beatmap_md5, s.beatmap_id, s.beatmap_name, s.played_at, s.unsubmitted,
                   b.beatmapset_id, {Metadata.NameColumns}, b.version, b.creator
              FROM incomplete_plays s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}
             ORDER BY s.played_at DESC
             LIMIT ?
            """, profileId, mode, want).Select(ToIncomplete);

        // Stable, newest first, as JavaScript's sort.
        var merged = scores.Select(p => (Entry: (object)p, At: p.At))
            .Concat(abandoned.Select(p => (Entry: (object)p, At: p.At)))
            .OrderByDescending(x => x.At)
            .Select(x => x.Entry)
            .ToList();
        return [.. (incomplete == "collapse" ? CollapseRuns(merged) : merged).Take(limit)];
    }

    private static IncompletePlay ToIncomplete(Row r)
    {
        var names = Metadata.WithFallbackTitle(Metadata.Names(r), r["beatmap_name"] as string);
        return new IncompletePlay
        {
            Id = r["id"],
            Ids = [r["id"]],
            BeatmapMd5 = r["beatmap_md5"],
            BeatmapId = r["beatmap_id"],
            BeatmapsetId = r["beatmapset_id"],
            Artist = names.Artist,
            Title = names.Title,
            ArtistUnicode = names.ArtistUnicode,
            TitleUnicode = names.TitleUnicode,
            Version = r["version"],
            Creator = r["creator"],
            PlayedAt = r["played_at"],
            Unsubmitted = r.Is1("unsubmitted"),
        };
    }

    /// <summary>
    /// Fold each run of consecutive abandoned attempts on one beatmap, of one kind, into a single
    /// row carrying the count, keeping the time of the most recent.
    /// </summary>
    private static List<object> CollapseRuns(List<object> entries)
    {
        var output = new List<object>();
        foreach (var entry in entries)
        {
            if (entry is IncompletePlay attempt && output.Count > 0 && output[^1] is IncompletePlay previous
                && previous.BeatmapMd5 is not null && Equals(previous.BeatmapMd5, attempt.BeatmapMd5)
                && previous.Unsubmitted == attempt.Unsubmitted)
            {
                previous.Attempts++;
                previous.Ids.Add(attempt.Id);
                continue;
            }
            output.Add(entry is IncompletePlay own ? own.Copy() : entry);
        }
        return output;
    }

    /// <summary>How many rows Recent Plays has in full.</summary>
    public static double RecentPlayTotal(Database db, long profileId, double mode, Eligibility e) =>
        Convert.ToDouble(db.Scalar($"""
            SELECT (SELECT COUNT(*) FROM scores s
                     WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()})
                 + (SELECT COUNT(*) FROM incomplete_plays s
                     WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}) AS n
            """, profileId, mode, profileId, mode));

    /// <summary>Distinct beatmaps played, which is how many rows Most Played can ever show.</summary>
    public static double MostPlayedTotal(Database db, long profileId, double mode, Eligibility e) =>
        Convert.ToDouble(db.Scalar($"""
            SELECT COUNT(*) AS n FROM (
              SELECT s.beatmap_md5 FROM scores s
               WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
               UNION
              SELECT s.beatmap_md5 FROM incomplete_plays s
               WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}
                     AND s.beatmap_md5 IS NOT NULL)
            """, profileId, mode, profileId, mode));

    /// <summary>osu-web's Most Played Beatmaps: every attempt counts, abandoned ones included.</summary>
    public static List<MostPlayedEntry> MostPlayed(Database db, long profileId, double mode, int limit, Eligibility e) =>
        [.. db.Rows($"""
            SELECT p.beatmap_md5, MAX(p.beatmap_id) AS beatmap_id,
                   COUNT(*) AS count, MAX(p.played_at) AS last_played,
                   b.beatmapset_id, {Metadata.NameColumns}, b.version, b.creator
              FROM (SELECT s.beatmap_md5, s.beatmap_id, s.played_at
                      FROM scores s
                     WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
                     UNION ALL
                    SELECT s.beatmap_md5, s.beatmap_id, s.played_at
                      FROM incomplete_plays s
                     WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}
                           AND s.beatmap_md5 IS NOT NULL) p
              LEFT JOIN beatmaps b ON b.md5 = p.beatmap_md5
             GROUP BY p.beatmap_md5
             ORDER BY count DESC, last_played DESC
             LIMIT ?
            """, profileId, mode, profileId, mode, limit).Select(r =>
        {
            var names = Metadata.Names(r);
            return new MostPlayedEntry(r["beatmap_md5"], r["beatmap_id"], r["beatmapset_id"],
                names.Artist, names.Title, names.ArtistUnicode, names.TitleUnicode, r["version"], r["creator"], r["count"]);
        })];

    /// <summary>The mode the most recent tracked score was set on, to open the page on. Scores only.</summary>
    public static object MostRecentMode(Database db, long profileId) =>
        db.FirstRow($"SELECT mode FROM scores s WHERE s.profile_id = ? AND {Eligibility.VisibleSql()} ORDER BY s.played_at DESC LIMIT 1",
            profileId)?["mode"] ?? 0L;

    /// <summary>Modes with at least one tracked play, a quit included, so each is reachable.</summary>
    public static List<object?> ModesWithPlays(Database db, long profileId, Eligibility e) =>
        [.. db.Rows($"""
            SELECT DISTINCT mode FROM (
              SELECT s.mode FROM scores s WHERE s.profile_id = ? AND {Eligibility.VisibleSql()}
              UNION ALL
              SELECT s.mode FROM incomplete_plays s WHERE s.profile_id = ? AND {Eligibility.IncompleteSql(e)})
            ORDER BY mode
            """, profileId, profileId).Select(r => r["mode"])];

    /// <summary>Attempts osu! could not submit, in every mode, whether or not they count.</summary>
    public static double UnsubmittedAttemptCount(Database db, long profileId) =>
        Convert.ToDouble(db.Scalar($"""
            SELECT COUNT(*) AS n FROM incomplete_plays s
             WHERE s.profile_id = ? AND {Eligibility.VisibleSql()} AND s.unsubmitted = 1
            """, profileId));
}

/// <summary>
/// What osu! said a linked account stood at, from which a profile borrows the bonus pp imported
/// scores cannot account for: src/standing.ts (reading half).
/// </summary>
internal sealed record ImportedStanding(object? BonusPp, object? OsuTotalPp, object? OsuGlobalRank, object? ImportedAt);

internal static class Standing
{
    public static double? ImportedBonusPp(Database db, long profileId, double mode) =>
        db.FirstRow("SELECT bonus_pp FROM imported_standing WHERE profile_id = ? AND mode = ?", profileId, mode)?.Num("bonus_pp");

    public static ImportedStanding? Imported(Database db, long profileId, double mode)
    {
        var row = db.FirstRow("""
            SELECT bonus_pp, osu_total_pp, osu_global_rank, imported_at
              FROM imported_standing WHERE profile_id = ? AND mode = ?
            """, profileId, mode);
        return row is null ? null : new ImportedStanding(row["bonus_pp"], row["osu_total_pp"], row["osu_global_rank"], row["imported_at"]);
    }
}
