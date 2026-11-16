using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles;

/// <summary>What the pp calculator worked out for one play.</summary>
/// <param name="Counts">The judgements it was priced with: what was typed, or a perfect play's.</param>
/// <param name="Perfect">A perfect play's judgements on this beatmap, ruleset and mods; null when the calculator cannot say.</param>
/// <param name="Ranked">Whether osu! ranks the mods; null when the calculator cannot say.</param>
internal sealed record CalculatedPlay(
    double Pp,
    double Stars,
    double Combo,
    double MaxCombo,
    double Accuracy,
    string Rank,
    List<PpPart> Breakdown,
    string? Version,
    bool? Ranked,
    Dictionary<string, double> Counts,
    Dictionary<string, double>? Perfect);

/// <summary>
/// Options -> pp calculator: a play described by its numbers on any beatmap here, priced by the
/// calculator the app prices with, osu!'s release or the player's own source (roadmap 5.70), and
/// nothing stored.
/// </summary>
/// <remarks>
/// The play is built into an osu!stable replay as a score entered by hand is
/// (<see cref="BuiltReplays.Manual"/>), and osu!'s mods with their settings go beside it, as McOsu's
/// custom speeds do, so it is scored as stable whatever the mods.
/// </remarks>
internal static partial class PpCalculation
{
    /// <summary>More than any real mod selection, and a bound all the same.</summary>
    private const int MaxMods = 32;

    private const int MaxSettings = 16;

    /// <summary>The largest .osu file taken from the page. Real ones are a few hundred KB.</summary>
    public const int MaxBeatmapBytes = 16 * 1024 * 1024;

    [GeneratedRegex(@"^[A-Z0-9]{1,4}\z")]
    private static partial Regex AcronymShape();

    [GeneratedRegex(@"^[a-z_]{1,40}\z")]
    private static partial Regex SettingShape();

    /// <summary>Mods no play can be calculated with: Autoplay and Cinema have no player, ScoreV2 is a system mod.</summary>
    private static readonly HashSet<string> Refused = ["AT", "CN", "SV2"];

    /// <summary>
    /// The mods as the page sends them, <c>[{ acronym, settings? }]</c>, each once, with settings only
    /// of numbers and switches. Classic is left out: osu! adds its own to every stable play. Null with
    /// <paramref name="error"/> when something is wrong.
    /// </summary>
    public static List<JsonElement>? ParseMods(JsonElement? raw, out string? error)
    {
        error = null;
        var output = new List<JsonElement>();
        if (raw is null or { ValueKind: JsonValueKind.Null }) return output;
        if (raw.Value.ValueKind != JsonValueKind.Array || raw.Value.GetArrayLength() > MaxMods)
        {
            error = "the mods are not a list of mods";
            return null;
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var mod in raw.Value.EnumerateArray())
        {
            if (!Js.IsString(Js.Get(mod, "acronym"), out var acronym) || !AcronymShape().IsMatch(acronym))
            {
                error = "a mod has no acronym";
                return null;
            }
            if (Refused.Contains(acronym))
            {
                error = $"{acronym} cannot be calculated";
                return null;
            }
            if (acronym == "CL" || !seen.Add(acronym)) continue;

            var settings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (Js.Get(mod, "settings") is { ValueKind: not JsonValueKind.Null } given)
            {
                if (given.ValueKind != JsonValueKind.Object)
                {
                    error = $"{acronym}'s settings are not readable";
                    return null;
                }
                foreach (var (key, value) in Js.Entries(given))
                {
                    var usable = value.ValueKind is JsonValueKind.True or JsonValueKind.False
                        || (value.ValueKind == JsonValueKind.Number && double.IsFinite(Js.NumberOf(value)));
                    if (!SettingShape().IsMatch(key) || !usable || settings.Count >= MaxSettings)
                    {
                        error = $"{acronym}'s settings are not readable";
                        return null;
                    }
                    settings[key] = value;
                }
            }
            output.Add(settings.Count == 0 ? JsonText.From(new { acronym }) : JsonText.From(new { acronym, settings }));
        }
        return output;
    }

    /// <summary>
    /// Price one play: <c>{ md5, mode, mods, counts?, combo? }</c>. With no counts it is a perfect
    /// play, and with no combo a full one. Everything is checked against the beatmap first, as a
    /// score entered by hand is.
    /// </summary>
    public static async Task<CalculatedPlay> Calculate(EntryDeps deps, JsonElement input)
    {
        if (!deps.CanPrice) throw new InvalidOperationException("the pp calculator is not available");
        var beatmap = Js.IsString(Js.Get(input, "md5"), out var md5) && ScoreEntry.Md5Shape().IsMatch(md5) ? ScoreEntry.Describe(deps, md5) : null;
        if (beatmap is null || deps.Resolver.Resolve(beatmap.Md5).OsuPath is not { } osuPath) throw new InvalidOperationException("choose a beatmap first");

        var asked = Js.ToNumber(Js.Get(input, "mode"));
        if (asked is not (0 or 1 or 2 or 3)) throw new InvalidOperationException("choose a ruleset");
        var mode = (int)asked;
        if (beatmap.Mode != 0 && mode != beatmap.Mode) throw new InvalidOperationException("this beatmap can only be played in its own ruleset");

        if (ParseMods(Js.Get(input, "mods"), out var modsError) is not { } mods) throw new InvalidOperationException(modsError);
        var perfect = await deps.PerfectJudgements(osuPath, mode, mods);

        var counts = new Dictionary<string, double>(StringComparer.Ordinal) { ["c300"] = 0, ["c100"] = 0, ["c50"] = 0, ["geki"] = 0, ["katu"] = 0, ["miss"] = 0 };
        var given = Js.Get(input, "counts");
        if (given is null or { ValueKind: JsonValueKind.Null })
        {
            if (perfect is null) throw new InvalidOperationException("enter the play’s judgements");
            foreach (var (key, n) in perfect) counts[key] = n;
        }
        else
        {
            foreach (var key in ScoreEntry.Judgements[mode])
            {
                var value = Js.Get(given, key);
                counts[key] = ScoreEntry.Whole(value is null or { ValueKind: JsonValueKind.Null } ? JsonText.From(0) : value, 65535)
                    ?? throw new InvalidOperationException("each judgement is a whole number from 0");
            }
        }
        var judged = ScoreEntry.Judgements[mode].Sum(key => counts[key]);
        if (judged == 0) throw new InvalidOperationException("enter the play’s judgements");
        // Every object is judged once. Without osu!'s count, an osu! or mania play on its own beatmap is still checked.
        double? expected = perfect is not null ? perfect.Values.Sum() : mode == beatmap.Mode && mode is 0 or 3 ? beatmap.Objects : null;
        if (expected is { } total && judged != total)
        {
            throw new InvalidOperationException($"the judgements add up to {Js.NumberToString(judged)}, and this beatmap has {Js.NumberToString(total)}");
        }

        var typedCombo = Js.Get(input, "combo");
        var combo = ScoreEntry.Blank(typedCombo) ? null : ScoreEntry.Whole(typedCombo, 65535);
        if (combo is null && !ScoreEntry.Blank(typedCombo)) throw new InvalidOperationException("the combo is a whole number");

        var legacy = new LegacyCounts(counts["c300"], counts["c100"], counts["c50"], counts["geki"], counts["katu"], counts["miss"]);
        var pricing = new PriceOptions(mods, IgnoreLegacyTotalScore: true);
        async Task<PpResult> Price(double withCombo)
        {
            var file = Path.Combine(Path.GetTempPath(), $"olp-calc-{Guid.NewGuid():N}.osr");
            File.WriteAllBytes(file, BuiltReplays.Manual(mode, beatmap.Md5, "", legacy, withCombo, 0, null, Js.Now()));
            try
            {
                return await deps.PriceReplay(file, pricing) is { MaxCombo: > 0 } priced
                    ? priced
                    : throw new InvalidOperationException("osu!’s calculator could not price this play");
            }
            finally
            {
                File.Delete(file);
            }
        }

        // The beatmap's maximum combo is osu!'s to say, so a full combo is priced once it has.
        var result = await Price(combo ?? 0);
        if (combo is null) result = await Price(result.MaxCombo);
        else if (combo > result.MaxCombo)
        {
            throw new InvalidOperationException($"a combo of {Js.NumberToString(combo.Value)} is more than this beatmap's maximum of {Js.NumberToString(result.MaxCombo)}");
        }

        return new CalculatedPlay(result.Value, result.Stars, combo ?? result.MaxCombo, result.MaxCombo, result.Accuracy, Silvered(result.Rank, mods),
            result.Breakdown, result.Version, await deps.ModsRanked(mode, JsonText.From(mods)),
            ScoreEntry.Judgements[mode].ToDictionary(key => key, key => counts[key], StringComparer.Ordinal), perfect);
    }

    /// <summary>
    /// The grade with the mods' own say in it. osu! grades the replay as decoded, before these mods
    /// replace its own, so Hidden, Flashlight and Fade In turn S and SS silver here, as their
    /// <c>AdjustRank</c> does in osu!.
    /// </summary>
    private static string Silvered(string rank, List<JsonElement> mods) =>
        rank is "X" or "S" && mods.Any(m => Js.IsString(Js.Get(m, "acronym"), out var a) && a is "HD" or "FL" or "FI") ? rank + "H" : rank;

    /// <summary>
    /// A .osu file from the page: kept in <c>data/beatmaps/</c> and indexed, as a beatmap downloaded
    /// for a score link is, so it can be priced and found again.
    /// </summary>
    public static EntryBeatmap Upload(EntryDeps deps, byte[] bytes)
    {
        var text = new UTF8Encoding(false).GetString(bytes).TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (!text.StartsWith("osu file format v", StringComparison.Ordinal)) throw new InvalidOperationException("that file is not an osu! beatmap (.osu)");
        var objects = (Clients.Beatmaps.OsuSection(text, "[HitObjects]") ?? "").Split('\n').Count(line => Js.Trim(line) != "");
        if (objects == 0) throw new InvalidOperationException("that beatmap has no objects");
        var stored = StoredBeatmaps.Store(deps.Db, deps.DataDir, bytes);
        return ScoreEntry.Describe(deps, stored.Md5) ?? throw new InvalidOperationException("that file is not an osu! beatmap (.osu)");
    }
}
