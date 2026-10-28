using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Clients;

/// <summary>A beatmap's own CS, AR, OD and HP, before any mod.</summary>
internal sealed record BaseDifficulty(double Cs, double Ar, double Od, double Hp);

/// <summary>
/// What <see cref="Mcosu.Mods"/> makes of a play: its mods as osu! would list them (what is stored),
/// what osu!'s calculator is given (null when osu!'s mods cannot say what was played), and whether
/// the total McOsu recorded is on the footing osu! assumes.
/// </summary>
internal sealed record McosuMods(List<JsonElement> Mods, List<JsonElement>? Priced, bool IgnoreLegacyTotalScore);

/// <summary>McOsu: src/clients/mcosu.ts. Its plays are built osu!stable replays, scored as stable.</summary>
internal static partial class Mcosu
{
    public const int NightmareBit = 1 << 22;

    /// <summary>The acronym everything McOsu has and osu! does not is filed under.</summary>
    public const string McosuMod = "MC";

    private const int DT = 1 << 6, HT = 1 << 8, NC = 1 << 9, HR = 1 << 4, EZ = 1 << 1;

    /// <summary>The rates osu!'s rate mods accept, and their defaults.</summary>
    private const double FasterMin = 1.01, FasterMax = 2, FasterDefault = 1.5;
    private const double SlowerMin = 0.5, SlowerMax = 0.99, SlowerDefault = 0.75;

    /// <summary>Difficulty Adjust's limits with <c>extended_limits</c> on.</summary>
    private const double DaMax = 11, DaMinAr = -10;

    /// <summary>Experimental mods that move a value while the map plays, so the stored one is no override.</summary>
    private static readonly string[] MovesCs = ["osu_mod_minimize"];
    private static readonly string[] MovesAr = ["osu_mod_artimewarp", "osu_mod_arwobble"];

    /// <summary>McOsu stores floats; two decimals is finer than any slider it offers.</summary>
    private static double Round2(double n) => Js.Round(n * 100) / 100;

    [GeneratedRegex(@"(?<=\A|[\n\r\u2028\u2029])[ \t]*(CircleSize|ApproachRate|OverallDifficulty|HPDrainRate)[ \t]*:[ \t]*([-0-9.]+)")]
    private static partial Regex DifficultyValue();

    /// <summary>
    /// The <c>[Difficulty]</c> of a <c>.osu</c>, or null when it cannot be read. A map with no
    /// <c>ApproachRate</c> uses its OD for it, as every osu! client does.
    /// </summary>
    public static BaseDifficulty? ReadBaseDifficulty(string osuPath)
    {
        string text;
        try
        {
            text = Js.ReadFileUtf8(osuPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        if (Beatmaps.OsuSection(text, "[Difficulty]") is not { } section) return null;
        double? Value(string key)
        {
            // The first line naming the key, as the regex without `g` finds it.
            var m = DifficultyValue().Matches(section).FirstOrDefault(m => m.Groups[1].Value == key);
            var n = m is null ? double.NaN : Js.StringToNumber(m.Groups[2].Value);
            return double.IsFinite(n) ? n : null;
        }
        var cs = Value("CircleSize");
        var od = Value("OverallDifficulty");
        var hp = Value("HPDrainRate");
        if (cs is null || od is null || hp is null) return null;
        return new BaseDifficulty(cs.Value, Value("ApproachRate") ?? od.Value, od.Value, hp.Value);
    }

    /// <summary>
    /// A McOsu play's mods, as osu! would write them if it could have set the play: speed as
    /// Double Time or Half Time with its rate, overrides as Difficulty Adjust after Easy or Hard
    /// Rock, and Nightmare and McOsu's experimental mods as one mod, MC. The reasons are in
    /// src/clients/mcosu.ts.
    /// </summary>
    public static McosuMods Mods(int legacyMods, McosuFacts facts, BaseDifficulty? @base)
    {
        var priceable = true;

        var speed = Round2(facts.Speed);
        var rateBit = 0;
        double? rate = null;
        if (speed > 1)
        {
            rateBit = (legacyMods & NC) != 0 ? NC | DT : DT;
            if (speed < FasterMin || speed > FasterMax) priceable = false;
            if (speed != FasterDefault) rate = speed;
        }
        else if (speed < 1)
        {
            rateBit = HT;
            if (speed < SlowerMin || speed > SlowerMax) priceable = false;
            if (speed != SlowerDefault) rate = speed;
        }
        var bits = (legacyMods & ~(DT | NC | HT | NightmareBit)) | rateBit;
        // McOsu is osu!standard only.
        var mods = Calc.Mods.DecodeLegacy(bits, 0)
            .Select(m => rate is { } r && Calc.Mods.Acronym(m) is "DT" or "NC" or "HT"
                ? Calc.Mods.With(Calc.Mods.Acronym(m)!, new Dictionary<string, object> { ["speed_change"] = r })
                : m)
            .ToList();

        if (@base is not null)
        {
            var hr = (legacyMods & HR) != 0;
            var ez = (legacyMods & EZ) != 0;
            // McOsu's getDifficultyMultiplier and getCSDifficultyMultiplier: Easy wins over Hard Rock.
            var mult = ez ? 0.5 : hr ? 1.4 : 1;
            var csMult = ez ? 0.5 : hr ? 1.3 : 1;
            (string Key, double Stored, double Expected, bool Moving, double Min)[] stats =
            [
                ("circle_size", facts.Cs, Math.Min(@base.Cs * csMult, 10), MovesCs.Any(facts.Experimental.Contains), 0),
                ("approach_rate", facts.Ar, Math.Min(@base.Ar * mult, 10), MovesAr.Any(facts.Experimental.Contains), DaMinAr),
                ("overall_difficulty", facts.Od, Math.Min(@base.Od * mult, 10), false, 0),
                ("drain_rate", facts.Hp, Math.Min(@base.Hp * mult, 10), false, 0),
            ];
            var settings = new Dictionary<string, object>();
            foreach (var (key, stored, expected, moving, min) in stats)
            {
                if (!double.IsFinite(stored) || moving) continue;
                // McOsu stores float32: compare at that precision, or every 3.3 would be an override.
                if (Math.Abs(stored - (double)(float)expected) < 0.001) continue;
                var value = Round2(stored);
                settings[key] = value;
                if (value > DaMax || value < min) priceable = false;
            }
            if (settings.Count > 0)
            {
                if (settings.Values.Any(v => v is double d && (d > 10 || d < 0))) settings["extended_limits"] = true;
                mods.Add(Calc.Mods.With("DA", settings));
            }
        }

        List<JsonElement>? priced = priceable ? [.. mods] : null;

        List<string> own = [.. facts.Nightmare ? ["nightmare"] : Array.Empty<string>(), .. facts.Experimental];
        if (own.Count > 0)
        {
            var settings = new Dictionary<string, object>();
            foreach (var name in own) settings[name] = true;
            mods.Add(Calc.Mods.With(McosuMod, settings));
        }

        return new McosuMods(mods, priced, priced is not null && !LegacyTotalComparable(legacyMods, priced));
    }

    /// <summary>
    /// Whether osu! can read McOsu's recorded total as the stable total it assumes: McOsu's
    /// multipliers for its bits against stable's for the mods being priced.
    /// </summary>
    public static bool LegacyTotalComparable(int legacyMods, IReadOnlyList<JsonElement> priced)
    {
        bool Has(int bit) => (legacyMods & bit) != 0;
        var v2 = Has(1 << 29);
        double mcosu = 1;
        if (Has(EZ) || (Has(1 << 0) && !v2)) mcosu *= 0.5;
        if (Has(HT)) mcosu *= 0.3;
        if (Has(HR)) mcosu *= v2 ? 1.1 : 1.06;
        if (Has(DT) || Has(NC)) mcosu *= v2 ? 1.2 : 1.12;
        if (Has(1 << 3)) mcosu *= 1.06;
        if (Has(1 << 12)) mcosu *= 0.9;

        var acronyms = priced.Select(Calc.Mods.Acronym).ToHashSet();
        double osu = 1;
        if (acronyms.Contains("NF") && !v2) osu *= 0.5;
        if (acronyms.Contains("EZ")) osu *= 0.5;
        if (acronyms.Contains("HT") || acronyms.Contains("DC")) osu *= 0.3;
        if (acronyms.Contains("HD")) osu *= 1.06;
        if (acronyms.Contains("HR")) osu *= v2 ? 1.1 : 1.06;
        if (acronyms.Contains("DT") || acronyms.Contains("NC")) osu *= v2 ? 1.2 : 1.12;
        if (acronyms.Contains("FL")) osu *= 1.12;
        if (acronyms.Contains("SO")) osu *= 0.9;

        return Math.Abs(mcosu - osu) < 1e-9;
    }
}
