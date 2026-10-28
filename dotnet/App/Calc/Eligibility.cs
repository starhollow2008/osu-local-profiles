using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Calc;

/// <summary>
/// Which stored scores count toward this profile's pp, and which pp value to count:
/// src/calc/eligibility.ts. The one definition of "counts" (never <c>ranked = 1</c>), and of
/// the pp, score and star columns (never <c>s.total_score</c>).
/// </summary>
/// <remarks>
/// Every fragment has its values inlined. They are booleans and integers from a closed set of
/// settings, never user text, so there is nothing to parameterise.
/// </remarks>
internal sealed record Eligibility(
    bool IncludeUnrankedMods,
    bool PreferStrippedPp,
    int[] ExtraMapStatuses,
    string Scoring,
    bool CountUnresolved,
    bool CountUnsubmitted)
{
    /// <summary>osu!'s own rules: ranked and approved maps, ranked mods, nothing else.</summary>
    public static readonly Eligibility Vanilla = new(false, false, [], "lazer", false, false);

    /// <param name="statusKnown">
    /// False when nothing on the machine can say whether a beatmap is ranked (osu!stable with no
    /// lazer). Every beatmap then counts, rather than pricing the profile at zero.
    /// </param>
    public static Eligibility Of(ProfileSettings settings, bool statusKnown = true) => new(
        IncludeUnrankedMods: settings.IncludeUnrankedMods,
        // Only meaningful while unranked mods are being counted at all.
        PreferStrippedPp: settings.IncludeUnrankedMods && settings.UnrankedModPp == "without-the-mod",
        ExtraMapStatuses: MapStatuses(settings.IncludeUnrankedMaps),
        Scoring: settings.Scoring == "classic" ? "classic" : "lazer",
        CountUnresolved: !statusKnown,
        CountUnsubmitted: settings.CountUnsubmittedAttempts);

    /// <summary>
    /// The setting's status names as osu!'s numbers: unknown names dropped, duplicates collapsed,
    /// sorted, because this is where a stored setting reaches generated SQL.
    /// </summary>
    private static int[] MapStatuses(IEnumerable<string> names) =>
        [.. names.Select(Status.UnrankedMapStatus).OfType<int>().Distinct().Order()];

    /// <summary>
    /// Which rows of <c>incomplete_plays</c> count as plays: every play osu! counted, and the
    /// attempts it could not submit only when the profile asks. Includes <see cref="VisibleSql"/>.
    /// </summary>
    public static string IncompleteSql(Eligibility e, string alias = "s") =>
        e.CountUnsubmitted ? VisibleSql(alias) : $"({VisibleSql(alias)} AND {alias}.unsubmitted = 0)";

    /// <summary>Scores the user has not removed from the profile. Belongs on every query over <c>scores</c>.</summary>
    public static string VisibleSql(string alias = "s") => $"{alias}.hidden_at IS NULL";

    /// <summary>The pp column to rank and weight by.</summary>
    public static string PpColumn(Eligibility e, string alias = "s") =>
        e.PreferStrippedPp ? $"COALESCE({alias}.pp_nomod, {alias}.pp)" : $"{alias}.pp";

    /// <summary>The score column on the profile's scale, falling back to what the replay carried.</summary>
    public static string ScoreColumn(Eligibility e, string alias = "s")
    {
        var osuScale = e.Scoring == "classic" ? "score_classic" : "score_standard";
        return $"COALESCE({alias}.{osuScale}, {alias}.total_score)";
    }

    /// <summary>The matching star rating, so a stripped-pp play does not show its as-played difficulty.</summary>
    public static string StarsColumn(Eligibility e, string alias = "s") =>
        e.PreferStrippedPp ? $"COALESCE({alias}.stars_nomod, {alias}.stars)" : $"{alias}.stars";

    /// <summary>Whether the beatmap allows pp. Rows from before <c>map_status</c> fall back to <c>ranked</c>.</summary>
    private static string MapSql(Eligibility e, string alias)
    {
        var allowed = string.Join(", ", new[] { Status.Ranked, Status.Approved }
            .Concat(e.ExtraMapStatuses)
            .Concat(e.CountUnresolved ? [Status.Unresolved] : []));
        return $"""
            ({alias}.map_status IN ({allowed})
                       OR ({alias}.map_status IS NULL AND {alias}.ranked = 1))
            """;
    }

    /// <summary>Whether the mods allow pp. Autoplay and Cinema never count, however permissive.</summary>
    private static string ModsSql(Eligibility e, string alias)
    {
        var official = $"COALESCE({alias}.mods_ranked, {alias}.ranked) = 1";
        if (!e.IncludeUnrankedMods) return $"({official})";
        return $"({official} OR COALESCE({alias}.mods_countable, 1) = 1)";
    }

    /// <summary>
    /// "This score counts toward pp": visible, passed, on a map and with mods these settings
    /// allow, with a pp value. Without a leading <c>AND</c>.
    /// </summary>
    public static string CountsSql(Eligibility e, string alias = "s") => $"""
        ({VisibleSql(alias)}
                   AND {alias}.passed = 1
                   AND {MapSql(e, alias)}
                   AND {ModsSql(e, alias)}
                   AND {PpColumn(e, alias)} IS NOT NULL)
        """;
}
