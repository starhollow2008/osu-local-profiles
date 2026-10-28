using System.Collections.Concurrent;
using System.Text.Json;

namespace OsuLocalProfiles.Calc;

/// <summary>A pp-to-rank curve built offline from a data.ppy.sh sample (scripts/build-rank-table.mjs).</summary>
internal sealed record RankTable(string Mode, string Dump, string Source, double Sampled, string GeneratedAt, double[][] Points);

/// <summary>The global rank a pp total would sit at, and the dump the curve came from.</summary>
internal sealed record RankEstimate(long Rank, string Dump);

/// <summary>
/// Estimating the global rank a profile's pp would put it at: src/calc/rank.ts. The tables are
/// src/calc/rank-tables/*.json, embedded when the app is built; the weekly job refreshes them.
/// </summary>
internal static class Ranks
{
    private static readonly string[] ModeFiles = ["osu", "taiko", "catch", "mania"];
    private static readonly ConcurrentDictionary<int, RankTable?> Cache = new();

    /// <summary>The curve for a mode, or null when there is none (an unknown mode included).</summary>
    public static RankTable? Table(double mode)
    {
        if (mode is not (0 or 1 or 2 or 3)) return null;
        return Cache.GetOrAdd((int)mode, static m =>
        {
            using var stream = typeof(Ranks).Assembly.GetManifestResourceStream($"rank-tables/{ModeFiles[m]}.json");
            if (stream is null) return null;
            try
            {
                var table = JsonSerializer.Deserialize<RankTable>(stream, JsonText.Options);
                return table is { Points.Length: >= 2 } ? table : null;
            }
            catch (JsonException)
            {
                return null;
            }
        });
    }

    public static RankEstimate? Estimate(double pp, double mode)
    {
        if (Table(mode) is not { } table) return null;
        return Interpolate(table.Points, pp) is { } rank ? new RankEstimate(rank, table.Dump) : null;
    }

    /// <summary>
    /// The curve lookup, linear in log(rank): rank spans six orders of magnitude where pp spans
    /// three, so interpolating rank directly would distort the long tail a new profile sits in.
    /// </summary>
    public static long? Interpolate(double[][] points, double pp)
    {
        // A profile with no pp is not on the ladder at all, which is what osu! shows too.
        if (!double.IsFinite(pp) || pp <= 0) return null;
        if (points.Length < 2) return null;

        var first = points[0];
        var last = points[^1];
        if (pp <= first[0]) return (long)first[1];
        if (pp >= last[0]) return (long)last[1];

        int lo = 0, hi = points.Length - 1;
        while (hi - lo > 1)
        {
            var mid = (lo + hi) >> 1;
            if (points[mid][0] <= pp) lo = mid;
            else hi = mid;
        }

        double ppLo = points[lo][0], rankLo = points[lo][1], ppHi = points[hi][0], rankHi = points[hi][1];
        var span = ppHi - ppLo;
        var t = span > 0 ? (pp - ppLo) / span : 0;
        var rank = Math.Exp(Math.Log(rankLo) + t * (Math.Log(rankHi) - Math.Log(rankLo)));
        return (long)Math.Max(1, Js.Round(rank));
    }
}
