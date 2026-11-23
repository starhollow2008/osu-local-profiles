using System.Collections.Concurrent;
using System.Text.Json;

namespace OsuLocalProfiles.Calc;

/// <summary>A pp-to-rank curve built offline from data.ppy.sh's dumps (scripts/build-rank-table.mjs).</summary>
/// <param name="Sampled">How many players the curve was built from: the random sample and the top together.</param>
/// <param name="Exact">The ranks this good or better are one point per player, read as exact; 0 for none.</param>
internal sealed record RankTable(string Mode, string Dump, string Source, double Sampled, string GeneratedAt, double[][] Points,
    string? TopSource = null, double Exact = 0)
{
    /// <summary>
    /// How many players the ruleset ranks: the rank at the curve's lowest pp, which is last place.
    /// osu-web divides a rank by its own count of these for a global rank's tier (issue #30).
    /// </summary>
    public double Players => Points.Length == 0 ? 0 : Points.Max(p => p.Length > 1 ? p[1] : 0);
}

/// <summary>The global rank a pp total would sit at, and the dump the curve came from.</summary>
internal sealed record RankEstimate(long Rank, string Dump);

/// <summary>
/// Estimating the global rank a profile's pp would put it at: src/calc/rank.ts. The tables are
/// dotnet/App/Calc/rank-tables/*.json, embedded when the app is built; the weekly job refreshes them.
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
        return Interpolate(table.Points, pp, table.Exact) is { } rank ? new RankEstimate(rank, table.Dump) : null;
    }

    /// <summary>
    /// The curve lookup, linear in log(rank): rank spans six orders of magnitude where pp spans
    /// three, so interpolating rank directly would distort the long tail a new profile sits in.
    /// </summary>
    /// <remarks>
    /// Among the best <paramref name="exact"/> ranks every player is a point, so there it is a step
    /// rather than a line: the rank of the best player whose pp this matches or beats, whose place
    /// it would take, as on osu!. Interpolating there could round to the wrong neighbour.
    /// </remarks>
    public static long? Interpolate(double[][] points, double pp, double exact = 0)
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

        if (exact > 0 && points[lo][1] <= exact) return (long)points[lo][1];

        double ppLo = points[lo][0], rankLo = points[lo][1], ppHi = points[hi][0], rankHi = points[hi][1];
        var span = ppHi - ppLo;
        var t = span > 0 ? (pp - ppLo) / span : 0;
        var rank = Math.Exp(Math.Log(rankLo) + t * (Math.Log(rankHi) - Math.Log(rankLo)));
        return (long)Math.Max(1, Js.Round(rank));
    }
}
