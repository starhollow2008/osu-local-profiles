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

    /// <summary>A mod with settings: <c>{ acronym, settings }</c>.</summary>
    public static JsonElement With(string acronym, IReadOnlyDictionary<string, object> settings) => JsonText.From(new { acronym, settings });

    /// <summary>
    /// osu!stable's mod bits, as osu! numbers them (<c>LegacyMods</c>), and lazer's acronym for each:
    /// all 31 of them.
    /// </summary>
    public static readonly string[] LegacyModBits =
    [
        "NF", "EZ", "TD", "HD", "HR", "SD", "DT", "RX", "HT", "NC", "FL", "AT", "SO", "AP", "PF",
        "4K", "5K", "6K", "7K", "8K", "FI", "RD", "CN", "TP", "9K", "DS", "1K", "3K", "2K", "SV2", "MR",
    ];

    /// <summary>Everything a bit can mean in every ruleset, so each one lists only what it does not have.</summary>
    private static readonly Dictionary<int, HashSet<string>> NotInRuleset = new()
    {
        [0] = ["4K", "5K", "6K", "7K", "8K", "9K", "1K", "2K", "3K", "DS", "FI", "RD", "MR"],
        [1] = ["TD", "SO", "AP", "TP", "4K", "5K", "6K", "7K", "8K", "9K", "1K", "2K", "3K", "DS", "FI", "RD", "MR"],
        [2] = ["TD", "SO", "AP", "TP", "4K", "5K", "6K", "7K", "8K", "9K", "1K", "2K", "3K", "DS", "FI", "RD", "MR"],
        [3] = ["TD", "RX", "SO", "AP", "TP"],
    };

    /// <summary>
    /// A stable bitmask as the mods osu! reads it for that ruleset (each ruleset's
    /// <c>ConvertFromLegacyMods</c>), in bit order, with only the visible one of NC/DT, PF/SD and CN/AT.
    /// </summary>
    public static List<JsonElement> DecodeLegacy(int bitmask, int ruleset)
    {
        var absent = NotInRuleset.TryGetValue(ruleset, out var a) ? a : NotInRuleset[0];
        var found = new List<string>();
        for (var i = 0; i < LegacyModBits.Length; i++)
        {
            if ((bitmask & (1 << i)) != 0 && !absent.Contains(LegacyModBits[i])) found.Add(LegacyModBits[i]);
        }
        return [.. found
            .Where(m => !(m == "DT" && found.Contains("NC")) && !(m == "SD" && found.Contains("PF")) && !(m == "AT" && found.Contains("CN")))
            .Select(Of)];
    }

    /// <summary>
    /// Mods as osu!stable's bitmask, for a replay this app builds of a stable score. Null when one of
    /// them has no bit. Classic is dropped; Nightcore, Perfect and Cinema set their parents' bits too.
    /// </summary>
    public static long? EncodeLegacy(IEnumerable<JsonElement> mods)
    {
        var implied = new Dictionary<string, string> { ["NC"] = "DT", ["PF"] = "SD", ["CN"] = "AT" };
        var bits = 0;
        foreach (var mod in mods)
        {
            var raw = Js.Get(mod, "acronym");
            if (Js.IsString(raw, out var acronym) && acronym == "CL") continue;
            if (IsCustomised(mod)) return null;
            if (raw is null) continue; // no acronym at all: nothing to set
            if (!Js.IsString(raw, out acronym)) return null;
            foreach (var each in implied.TryGetValue(acronym, out var parent) ? new[] { acronym, parent } : [acronym])
            {
                var bit = Array.IndexOf(LegacyModBits, each);
                if (bit < 0) return null;
                bits |= 1 << bit;
            }
        }
        return (uint)bits;
    }

    /// <summary>Mods whose removal leaves a play osu! can still price: the assistance, not the map.</summary>
    private static readonly string[] StrippableMods = ["RX", "AP"];

    /// <summary>Autoplay and Cinema are not plays, so they never count, however permissive the settings.</summary>
    private static readonly HashSet<string> NeverCountable = ["AT", "CN"];

    /// <summary>Could this combination count toward the profile if the user opts in? Everything but Autoplay and Cinema.</summary>
    public static bool Countable(IEnumerable<JsonElement> mods) => mods.All(m => Acronym(m) is not { } a || !NeverCountable.Contains(a));

    /// <summary>Which of the strippable mods this score carries, in the order osu! lists them.</summary>
    public static string[] Strippable(IEnumerable<JsonElement> mods)
    {
        var present = mods.Select(Acronym).ToHashSet();
        return [.. StrippableMods.Where(present.Contains)];
    }

    /// <summary><c>mods.map(m =&gt; m.acronym).join('')</c>, or <c>None</c>.</summary>
    public static string Label(IReadOnlyCollection<JsonElement> mods) =>
        mods.Count == 0
            ? "None"
            : string.Concat(mods.Select(m => Js.Get(m, "acronym") is { ValueKind: not JsonValueKind.Null } a ? Js.ToJsString(a) : ""));

    /// <summary>A lazer replay's own mod list, as written. Null when it has none.</summary>
    private static List<JsonElement>? ReplayMods(Replays.ReplayScore score) => Js.Get(score.Extras, "mods") switch
    {
        null or { ValueKind: JsonValueKind.Null } => null,
        { ValueKind: JsonValueKind.Array } list => [.. list.EnumerateArray()],
        _ => throw new InvalidDataException("a replay's mods are not a list"),
    };

    /// <summary>
    /// The mods in effect, preferring lazer's own list (which carries settings). A McOsu play's are
    /// worked out from what McOsu recorded, which takes the map to tell an override from its values.
    /// </summary>
    public static List<JsonElement> ScoreMods(Replays.ReplayScore score, string? osuPath = null)
    {
        if (score.Mcosu is not null) return McosuModsFor(score, osuPath).Mods;
        return ReplayMods(score) ?? DecodeLegacy(score.LegacyMods, score.Mode);
    }

    private static Clients.McosuMods McosuModsFor(Replays.ReplayScore score, string? osuPath) =>
        Clients.Mcosu.Mods(score.LegacyMods, score.Mcosu!, osuPath is { Length: > 0 } ? Clients.Mcosu.ReadBaseDifficulty(osuPath) : null);

    /// <summary>
    /// How osu!'s calculator is to price a replay beyond decoding it: nothing for a replay osu! set.
    /// A McOsu play's speed or override is priced from here; a score entered by hand with no total
    /// must not be priced on the 0 in its place.
    /// </summary>
    public static PriceOptions ScorePricing(Replays.ReplayScore score, string? osuPath)
    {
        if (score.Built is not null) return score.Built.LegacyTotal || score.Client != "stable" ? new PriceOptions() : new PriceOptions(IgnoreLegacyTotalScore: true);
        if (score.Mcosu is null) return new PriceOptions();
        var derived = McosuModsFor(score, osuPath);
        if (derived.Priced is null) return new PriceOptions(Unpriceable: true);
        return new PriceOptions(derived.Priced, derived.IgnoreLegacyTotalScore);
    }

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

/// <summary>
/// How osu!'s calculator is to price a replay, beyond decoding it: mods in place of the replay's,
/// pricing without the total osu!stable recorded, or not at all.
/// </summary>
internal sealed record PriceOptions(List<JsonElement>? Mods = null, bool IgnoreLegacyTotalScore = false, bool Unpriceable = false);

/// <summary>A play priced by osu!'s calculator (src/calc/pp.ts, <c>PpResult</c>).</summary>
internal sealed record PpResult(
    double Value,
    double? StandardisedScore,
    double? ClassicScore,
    double Stars,
    double MaxCombo,
    double Accuracy,
    string Rank,
    bool IsLegacy,
    bool Stripped,
    List<PpPart> Breakdown,
    string? Version);

/// <summary>pp weighting and the profile totals' arithmetic: src/calc/pp.ts.</summary>
internal static class Pp
{
    /// <summary>
    /// A play's pp from osu!'s own calculator, the only pp there is: no calculator, or a play osu!'s
    /// mods cannot describe, is no pp rather than a guess.
    /// </summary>
    public static async Task<PpResult?> CalculateScorePp(string replayPath, string osuPath, OfficialCalculator? official,
        string[]? stripMods = null, PriceOptions? pricing = null)
    {
        pricing ??= new PriceOptions();
        if (official is null || pricing.Unpriceable) return null;
        var result = await official.Calculate(replayPath, osuPath, stripMods is { Length: > 0 } ? stripMods : null,
            pricing.Mods, pricing.IgnoreLegacyTotalScore);
        if (result?.Pp is not { } pp) return null;
        return new PpResult(pp, result.StandardisedScore, result.LegacyTotalScore ?? result.ClassicScore, result.Stars,
            result.MaxCombo, result.Accuracy, result.Rank, result.IsLegacy, result.Stripped, result.Breakdown, official.Version);
    }

    /// <summary>
    /// Would osu! itself rank a score set with these mods? Asked of osu!'s own mod classes: a lazer
    /// replay's mod list, else stable's bitmask, and a McOsu play's mods as osu! would write them.
    /// Null when the calculator cannot answer, which counts as unranked until a recalculation.
    /// </summary>
    public static async Task<bool?> RankedByOsu(Replays.ReplayScore score, OfficialCalculator? official, string? osuPath = null)
    {
        if (official is null) return null;
        JsonElement? mods = score.Mcosu is not null ? JsonText.From(Mods.ScoreMods(score, osuPath)) : Js.Get(score.Extras, "mods");
        var result = Js.Truthy(mods)
            ? await official.Ranked(score.Mode, mods, null)
            : await official.Ranked(score.Mode, null, score.LegacyMods);
        return result?.Ranked;
    }

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
