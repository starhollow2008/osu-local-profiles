using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tracker;

/// <summary>
/// What pricing a replay puts on its score, defined once for the two places that do it: a play
/// being tracked (<see cref="Ingest"/>) and a stored one recalculated. src/tracker/pricing.ts.
/// </summary>
internal static class Pricing
{
    /// <summary>A replay priced as it was played. Null with no beatmap file.</summary>
    public static async Task<PpResult?> PriceAsPlayed(string replayPath, ResolvedBeatmap beatmap, OfficialCalculator? official, PriceOptions pricing) =>
        beatmap.OsuPath is { Length: > 0 } osuPath ? await Pp.CalculateScorePp(replayPath, osuPath, official, null, pricing) : null;

    /// <summary>
    /// The pp with Relax or Autopilot taken off, when the play carries one, and whether osu! ranks its
    /// mods. Asked only once the play tracking filter has let the play through.
    /// </summary>
    public static async Task<(PpResult? Stripped, bool? ModsRanked)> PriceTheRest(ReplayScore score, string replayPath,
        ResolvedBeatmap beatmap, IReadOnlyList<JsonElement> mods, OfficialCalculator? official, PriceOptions pricing)
    {
        var strippable = Mods.Strippable(mods);
        var stripped = strippable.Length > 0 && beatmap.OsuPath is { Length: > 0 } osuPath
            ? await Pp.CalculateScorePp(replayPath, osuPath, official, strippable, pricing)
            : null;
        return (stripped, await Pp.RankedByOsu(score, official, beatmap.OsuPath));
    }

    /// <summary>A status as JavaScript compares it: a number, or nothing.</summary>
    public static int? StatusOf(object? status) => status switch
    {
        long l when l is >= int.MinValue and <= int.MaxValue => (int)l,
        double d when d == Math.Floor(d) && d is >= int.MinValue and <= int.MaxValue => (int)d,
        _ => null,
    };

    /// <summary>The columns only a beatmap file can produce, kept as they were when a recalculation has none.</summary>
    public static readonly HashSet<string> BeatmapPriced =
    [
        "stars", "pp", "pp_source", "score_standard", "score_classic", "pp_nomod", "stars_nomod",
        "beatmap_max_combo", "pp_parts", "pp_nomod_parts", "pp_version",
    ];

    /// <summary>The columns of <c>scores</c> that pricing a replay decides, in the order the TypeScript lists them.</summary>
    public static List<KeyValuePair<string, object?>> PricedColumns(IReadOnlyList<JsonElement> mods, ResolvedBeatmap beatmap,
        PpResult? computed, PpResult? stripped, bool? modsRanked, string? calculatorVersion)
    {
        var status = StatusOf(beatmap.Status);
        return
        [
            new("mods_json", JsonText.Stringify(mods)),
            new("mods_label", Mods.Label([.. mods])),
            new("stars", computed?.Stars),
            new("pp", computed?.Value),
            new("pp_source", computed is null ? null : "official"),
            // osu!'s own two scales, so the profile can be read on either without a recalculation.
            new("score_standard", computed?.StandardisedScore),
            new("score_classic", computed?.ClassicScore),
            new("pp_nomod", stripped?.Value),
            new("stars_nomod", stripped?.Stars),
            new("beatmap_max_combo", computed?.MaxCombo),
            new("map_status", beatmap.Status ?? (object)Status.Unresolved),
            new("mods_ranked", modsRanked is null ? null : modsRanked.Value ? 1L : 0L),
            new("mods_ranked_by", modsRanked is null ? null : calculatorVersion ?? "unknown"),
            new("mods_countable", Mods.Countable(mods) ? 1L : 0L),
            // What osu! itself would say: the map and the mods both allow pp.
            new("ranked", Status.AwardsPp(status) && modsRanked == true ? 1L : 0L),
            new("beatmap_id", beatmap.BeatmapId),
            new("pp_parts", computed is null ? null : JsonText.Stringify(computed.Breakdown)),
            new("pp_nomod_parts", stripped is null ? null : JsonText.Stringify(stripped.Breakdown)),
            new("pp_version", computed?.Version),
        ];
    }
}
