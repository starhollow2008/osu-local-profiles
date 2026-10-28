using System.Text.Json;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Calc;

/// <summary>Accuracy, grades and passing: src/calc/grade.ts.</summary>
internal static class Grade
{
    /// <summary>
    /// What each judgement is worth, from osu!lazer's <c>Judgement.ToNumericResult</c>. Judgements
    /// worth nothing are listed so an unrecognised key is absent rather than silently zero.
    /// </summary>
    private static readonly Dictionary<string, double> HitValues = new(StringComparer.Ordinal)
    {
        ["perfect"] = 350,
        ["great"] = 300,
        ["good"] = 200,
        ["ok"] = 100,
        ["meh"] = 50,
        ["miss"] = 0,
        ["slider_tail_hit"] = 150,
        ["slider_tail_miss"] = 0,
        ["large_tick_hit"] = 30,
        ["large_tick_miss"] = 0,
        ["small_tick_hit"] = 10,
        ["small_tick_miss"] = 0,
        ["ignore_hit"] = 0,
        ["ignore_miss"] = 0,
        ["combo_break"] = 0,
        ["large_bonus"] = 0,
        ["small_bonus"] = 0,
    };

    private static readonly HashSet<string> Grades = ["XH", "X", "SH", "S", "A", "B", "C", "D", "F"];

    private static (double Total, bool Unknown) Weigh(JsonElement stats)
    {
        double total = 0;
        var unknown = false;
        foreach (var (key, count) in Js.Entries(stats))
        {
            if (HitValues.TryGetValue(key, out var value)) total += value * Js.ToNumber(count);
            else unknown = true;
        }
        return (total, unknown);
    }

    /// <summary>
    /// lazer's accuracy: the judgements earned over the best that could have been. Null with no
    /// extended block, or a judgement this does not recognise.
    /// </summary>
    public static double? LazerAccuracy(ReplayScore score)
    {
        var stats = Js.Get(score.Extras, "statistics");
        var max = Js.Get(score.Extras, "maximum_statistics");
        if (!Js.Truthy(stats) || !Js.Truthy(max)) return null;
        var achieved = Weigh(stats!.Value);
        var possible = Weigh(max!.Value);
        if (achieved.Unknown || possible.Unknown) return null;
        if (possible.Total <= 0) return null;
        return Math.Min(1, achieved.Total / possible.Total);
    }

    /// <summary>Accuracy as a 0..1 fraction, lazer's own weighting when the score has it.</summary>
    public static double Accuracy(ReplayScore score, int mode) => LazerAccuracy(score) ?? LegacyAccuracy(score, mode);

    /// <summary>The osu!stable formula, for stable replays and as a fallback.</summary>
    public static double LegacyAccuracy(ReplayScore score, int mode)
    {
        double c300 = score.Count300, c100 = score.Count100, c50 = score.Count50;
        double geki = score.CountGeki, katu = score.CountKatu, miss = score.CountMiss;
        switch (mode)
        {
            case 0:
            {
                var total = c300 + c100 + c50 + miss;
                return total == 0 ? 0 : (300 * c300 + 100 * c100 + 50 * c50) / (300 * total);
            }
            case 1:
            {
                var total = c300 + c100 + miss;
                return total == 0 ? 0 : (c300 + 0.5 * c100) / total;
            }
            case 2:
            {
                var caught = c300 + c100 + c50;
                var total = caught + miss + katu;
                return total == 0 ? 0 : caught / total;
            }
            case 3:
            {
                var total = geki + c300 + katu + c100 + c50 + miss;
                return total == 0 ? 0 : (300 * (geki + c300) + 200 * katu + 100 * c100 + 50 * c50) / (300 * total);
            }
            default:
                throw new ArgumentOutOfRangeException(nameof(mode), mode, "not a ruleset");
        }
    }

    private static bool Silver(IEnumerable<JsonElement> mods) => mods.Any(m => Mods.Acronym(m) is "HD" or "FL");

    /// <summary>The letter grade, worked out: lazer reports its own, so this is for osu!stable replays.</summary>
    public static string ComputeGrade(ReplayScore score, int mode, IReadOnlyList<JsonElement> mods)
    {
        if (!Passed(score)) return "F";
        var acc = Accuracy(score, mode);
        var hi = Silver(mods);

        if (mode == 0)
        {
            double total = (double)score.Count300 + score.Count100 + score.Count50 + score.CountMiss;
            if (total == 0) return "D";
            var r300 = score.Count300 / total;
            var r50 = score.Count50 / total;
            if (r300 == 1) return hi ? "XH" : "X";
            if (r300 > 0.9 && r50 < 0.01 && score.CountMiss == 0) return hi ? "SH" : "S";
            if ((r300 > 0.8 && score.CountMiss == 0) || r300 > 0.9) return "A";
            if ((r300 > 0.7 && score.CountMiss == 0) || r300 > 0.8) return "B";
            if (r300 > 0.6) return "C";
            return "D";
        }

        // taiko, catch and mania are graded on accuracy alone.
        if (acc == 1) return hi ? "XH" : "X";
        if (acc > 0.95) return hi ? "SH" : "S";
        if (acc > 0.9) return "A";
        if (acc > 0.8) return "B";
        if (acc > 0.7) return "C";
        return "D";
    }

    /// <summary>
    /// Whether the play was completed. lazer's block is authoritative: its legacy header says F even
    /// for plays that ranked A. osu!stable only ever writes a replay for a completed play.
    /// </summary>
    public static bool Passed(ReplayScore score)
    {
        var rank = Js.Get(score.Extras, "rank");
        if (Js.Truthy(rank)) return !(Js.IsString(rank, out var r) && r == "F");
        return true;
    }

    public static string GradeOf(ReplayScore score, int mode, IReadOnlyList<JsonElement> mods) =>
        Js.IsString(Js.Get(score.Extras, "rank"), out var reported) && Grades.Contains(reported)
            ? reported
            : ComputeGrade(score, mode, mods);
}
