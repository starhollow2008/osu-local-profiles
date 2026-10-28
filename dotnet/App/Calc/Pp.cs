using System.Text.Json;

namespace OsuLocalProfiles.Calc;

/// <summary>
/// A score's mods as stored in <c>mods_json</c>: lazer's own objects, <c>{ acronym, settings? }</c>,
/// kept as JSON so a mod's settings reach the page exactly as osu! wrote them.
/// </summary>
internal static class Mods
{
    /// <summary>
    /// <c>JSON.parse(json)</c> as a list, or null when it is not one: unreadable, or not an array.
    /// </summary>
    public static List<JsonElement>? Parse(string? json)
    {
        if (json is null || !JsonText.TryParse(json, out var parsed) || parsed.ValueKind != JsonValueKind.Array) return null;
        return [.. parsed.EnumerateArray()];
    }

    /// <summary>A mod's acronym, or null when it has none written as text.</summary>
    public static string? Acronym(JsonElement mod) => Js.IsString(Js.Get(mod, "acronym"), out var a) ? a : null;

    /// <summary>A bare mod, as the app writes Classic: <c>{ acronym }</c>.</summary>
    public static JsonElement Of(string acronym) => JsonText.From(new { acronym });

    /// <summary>
    /// Did the player change any of this mod's settings? lazer only writes <c>settings</c> when
    /// they did (<c>isCustomised</c>).
    /// </summary>
    public static bool IsCustomised(JsonElement mod) => Js.Get(mod, "settings") switch
    {
        null => false,
        { ValueKind: JsonValueKind.Object } s => s.EnumerateObject().Any(),
        { ValueKind: JsonValueKind.Array } a => a.GetArrayLength() > 0,
        { ValueKind: JsonValueKind.String } t => t.GetString()!.Length > 0,
        _ => false,
    };

    /// <summary>Whether osu! scores a client's plays as osu!stable plays (McOsu's included).</summary>
    public static bool ScoredAsStable(string? client) => client is "stable" or "mcosu";

    /// <summary>
    /// osu! scores every stable play with Classic on, and shows it that way: for display only,
    /// as <c>withClassicMod</c>.
    /// </summary>
    public static List<JsonElement> WithClassicMod(List<JsonElement> mods, string? client)
    {
        if (!ScoredAsStable(client) || mods.Any(m => Acronym(m) == "CL")) return mods;
        return [.. mods, Of("CL")];
    }
}

/// <summary>pp weighting and the profile totals' arithmetic: src/calc/pp.ts.</summary>
internal static class Pp
{
    /// <summary>Each successive play in the top 100 is worth 5% less than the one above it.</summary>
    public const double Weight = 0.95;

    /// <summary>How many scores are weighted into pp.</summary>
    public const int TopPlayLimit = 100;

    /// <summary>Weighted sum of the top plays: <c>pp[1]*0.95^0 + pp[2]*0.95^1 + ...</c></summary>
    public static double WeightedTotal(IReadOnlyList<double> ppDescending)
    {
        double total = 0;
        for (var i = 0; i < ppDescending.Count; i++) total += ppDescending[i] * Math.Pow(Weight, i);
        return total;
    }

    /// <summary>Bonus pp for breadth of play: <c>416.6667 * (1 - 0.995^min(N, 1000))</c>.</summary>
    public static double BonusPp(int distinctRankedBeatmaps) =>
        416.6667 * (1 - Math.Pow(0.995, Math.Min(distinctRankedBeatmaps, 1000)));

    /// <summary>Profile accuracy uses the same weighting as pp, over the same top plays.</summary>
    public static double WeightedAccuracy(IReadOnlyList<double> accuraciesByPpDescending)
    {
        double weighted = 0, divisor = 0;
        for (var i = 0; i < accuraciesByPpDescending.Count; i++)
        {
            var w = Math.Pow(Weight, i);
            weighted += accuraciesByPpDescending[i] * w;
            divisor += w;
        }
        return divisor > 0 ? weighted / divisor : 0;
    }
}
