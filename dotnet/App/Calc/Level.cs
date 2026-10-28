namespace OsuLocalProfiles.Calc;

/// <summary>osu! level: how far into it, 0..1 of the way to the next.</summary>
internal sealed record Level(int Current, double Progress);

/// <summary>
/// osu! level, derived purely from total score: src/calc/level.ts.
/// <c>score(n) = 5000/3 * (4n^3 - 3n^2 - n) + 1.25 * 1.8^(n-60)</c> up to 100, then
/// <c>26,931,190,827 + 99,999,999,999 * (n - 100)</c>.
/// </summary>
internal static class Levels
{
    private const int MaxTableLevel = 200;

    /// <summary>Total score required to reach <paramref name="level"/>.</summary>
    public static double RequiredScore(int level)
    {
        if (level <= 1) return 0;
        if (level <= 100)
        {
            double n = level;
            return 5000.0 / 3 * (4 * n * n * n - 3 * n * n - n) + 1.25 * Math.Pow(1.8, n - 60);
        }
        return 26_931_190_827 + 99_999_999_999.0 * (level - 100);
    }

    private static readonly double[] Table = [.. Enumerable.Range(0, MaxTableLevel + 2).Select(RequiredScore)];

    public static Level FromScore(double totalScore)
    {
        if (totalScore <= 0) return new Level(1, 0);

        // The largest level whose requirement has been met.
        int lo = 1, hi = MaxTableLevel;
        while (lo < hi)
        {
            var mid = (lo + hi + 1) / 2;
            if (Table[mid] <= totalScore) lo = mid;
            else hi = mid - 1;
        }

        var span = Table[lo + 1] - Table[lo];
        return new Level(lo, span > 0 ? Math.Min(1, Math.Max(0, (totalScore - Table[lo]) / span)) : 0);
    }
}
