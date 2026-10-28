using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Calc;

/// <summary>One entry in the Recent feed. Each kind is its own record, written with its <c>type</c> first.</summary>
internal interface IActivityEvent
{
    string Type { get; }
    double At { get; }
}

internal sealed record BestEvent(double At, object? Pp, string Title, string? TitleOriginal, object? Version) : IActivityEvent
{
    public string Type => "best";
}

internal sealed record LevelEvent(double At, int Level) : IActivityEvent
{
    public string Type => "level";
}

/// <summary>Where one of the profile's plays placed on osu!'s leaderboard (src/rank-events.ts).</summary>
internal sealed record RankEvent(
    double At, long? UserId, string Username, object? Rank, object? Grade, double Mode, object? BeatmapId,
    string Title, string? TitleOriginal, object? Version) : IActivityEvent
{
    public string Type => "rank";
}

internal sealed record FirstEvent(double At) : IActivityEvent
{
    public string Type => "first";
}

internal sealed record MedalEvent(double At, string Slug, string Name, string Description, string Icon, string Family, double Threshold)
    : IActivityEvent
{
    public string Type => "medal";
}

internal sealed record PpPoint(double At, double Pp);

internal sealed record MonthlyPlaycount(double At, int Count);

/// <summary>The chart, the monthly play counts and the Recent feed, newest event first.</summary>
internal sealed record HistoryResult(List<PpPoint> Pp, List<MonthlyPlaycount> MonthlyPlaycounts, List<object> Events, int EventsTotal);

/// <summary>
/// The profile over time, replayed from its scores in one chronological pass: src/calc/history.ts.
/// There is no stored history, which would be wrong after a reingest.
/// </summary>
internal static class History
{
    private const long Day = 86_400_000;

    private static double UtcDay(double ms) => Math.Floor(ms / Day) * Day;

    private static double UtcMonth(double ms)
    {
        var d = DateTimeOffset.FromUnixTimeMilliseconds((long)ms);
        return new DateTimeOffset(d.Year, d.Month, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
    }

    /// <summary>Every month between two month-starts inclusive, so a gap renders as zero, not a jump.</summary>
    private static List<double> MonthsBetween(double from, double to)
    {
        var output = new List<double>();
        for (var d = DateTimeOffset.FromUnixTimeMilliseconds((long)from); d.ToUnixTimeMilliseconds() <= to; d = d.AddMonths(1))
        {
            output.Add(d.ToUnixTimeMilliseconds());
        }
        return output;
    }

    /// <summary>Total pp for per-beatmap bests sorted highest first, as the totals derive it.</summary>
    private static double TotalPp(List<double> bestsDescending) =>
        Pp.WeightedTotal([.. bestsDescending.Take(100)]) + Pp.BonusPp(bestsDescending.Count);

    /// <summary>Where <paramref name="value"/> belongs in a list sorted highest first: after every entry at least as large.</summary>
    private static int InsertionPoint(List<double> list, double value)
    {
        int lo = 0, hi = list.Count;
        while (lo < hi)
        {
            var mid = (lo + hi) >> 1;
            if (list[mid] >= value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /// <summary>The first position holding <paramref name="value"/> in a list sorted highest first.</summary>
    private static int PositionOf(List<double> list, double value)
    {
        int lo = 0, hi = list.Count;
        while (lo < hi)
        {
            var mid = (lo + hi) >> 1;
            if (list[mid] > value) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /// <summary>The Recent-feed entries for a mode's medals: only those with a real date.</summary>
    public static List<IActivityEvent> MedalEvents(IEnumerable<Medal> medals) =>
        [.. medals.Where(m => m.AchievedAt is not null && m.Dated).Select(m =>
            (IActivityEvent)new MedalEvent(Convert.ToDouble(m.AchievedAt), m.Slug, m.Name, m.Description, m.Icon, m.Family, m.Threshold))];

    public static HistoryResult Build(Database db, long profileId, double mode, int maxEvents, Eligibility e,
        IEnumerable<IActivityEvent> extraEvents)
    {
        // `counts` is selected rather than filtered on: level and monthly play counts are about
        // everything played, pp only about what counts.
        var rows = db.Rows($"""
            SELECT s.played_at, {Eligibility.PpColumn(e)} AS pp, {Eligibility.ScoreColumn(e)} AS total_score, s.beatmap_md5,
                   {Eligibility.CountsSql(e)} AS counts,
                   {Metadata.NameColumns}, b.version
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
             ORDER BY s.played_at ASC
            """, profileId, mode);

        // Plays that finished without a score: in the monthly play counts, as osu! counts them,
        // and nowhere else here.
        var abandoned = db.All($"""
            SELECT s.played_at
              FROM incomplete_plays s
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)}
             ORDER BY s.played_at ASC
            """, r => r.GetDouble(0), profileId, mode);

        if (rows.Count == 0 && abandoned.Count == 0) return new HistoryResult([], [], [], 0);

        var bestByMap = new Dictionary<string, double>();
        // The same bests kept sorted highest first as each improves, so a day's total reads the
        // top 100 instead of re-sorting every map played so far.
        var ranked = new List<double>();
        var pp = new List<PpPoint>();
        var monthly = new Dictionary<double, int>();
        var events = new List<IActivityEvent>();

        double runningScore = 0;
        var level = 1;
        double bestPlay = 0;
        double? pendingDay = null;

        foreach (var playedAt in abandoned)
        {
            var month = UtcMonth(playedAt);
            monthly[month] = monthly.GetValueOrDefault(month) + 1;
        }

        // The profile started when it was first played, which an abandoned attempt counts as.
        var firstAt = Math.Min(rows.Count > 0 ? rows[0].Num("played_at") ?? double.PositiveInfinity : double.PositiveInfinity,
            abandoned.Count > 0 ? abandoned[0] : double.PositiveInfinity);
        events.Add(new FirstEvent(firstAt));

        foreach (var row in rows)
        {
            var at = row.Num("played_at") ?? double.NaN;
            var day = UtcDay(at);
            // One pp point per day.
            if (pendingDay is not null && day != pendingDay) pp.Add(new PpPoint(pendingDay.Value, TotalPp(ranked)));
            pendingDay = day;

            var month = UtcMonth(at);
            monthly[month] = monthly.GetValueOrDefault(month) + 1;

            runningScore += row.Num("total_score") ?? 0;
            var nextLevel = Levels.FromScore(runningScore).Current;
            if (nextLevel > level)
            {
                level = nextLevel;
                events.Add(new LevelEvent(at, level));
            }

            if (!row.Is1("counts") || row.Num("pp") is not { } value) continue;

            var md5 = row.Text("beatmap_md5");
            var had = bestByMap.TryGetValue(md5, out var previous);
            if (!had || value > previous)
            {
                bestByMap[md5] = value;
                if (had) ranked.RemoveAt(PositionOf(ranked, previous));
                ranked.Insert(InsertionPoint(ranked, value), value);
            }

            if (value > bestPlay)
            {
                bestPlay = value;
                var names = Metadata.Names(row);
                events.Add(new BestEvent(at, row["pp"], Metadata.BeatmapNameOrNull(names) ?? Js.Slice(md5, 12),
                    Metadata.BeatmapNameOriginal(names), row["version"]));
            }
        }

        if (pendingDay is not null) pp.Add(new PpPoint(pendingDay.Value, TotalPp(ranked)));

        // Stable, so a medal earned by the same play as a new best lands after it.
        events.AddRange(extraEvents);
        var sorted = events.OrderBy(x => x.At).ToList();

        var months = monthly.Keys.Order().ToList();
        var monthlyPlaycounts = MonthsBetween(months[0], months[^1]).Select(at => new MonthlyPlaycount(at, monthly.GetValueOrDefault(at))).ToList();

        var newest = sorted.Skip(Math.Max(0, sorted.Count - maxEvents)).Reverse().Cast<object>().ToList();
        return new HistoryResult(pp, monthlyPlaycounts, newest, sorted.Count);
    }

    /// <summary>The profile's rank events for one mode, for plays still showing (rankActivityEvents).</summary>
    public static List<IActivityEvent> RankActivityEvents(Database db, long profileId, double mode)
    {
        // Only the linked account's events are ever kept, so it is whose they are.
        var settings = SettingsStore.Get(db, profileId);
        return [.. db.Rows($"""
            SELECT r.rank, r.grade, r.achieved_at, s.beatmap_id, {Metadata.NameColumns}, b.version
              FROM rank_events r
              JOIN scores s ON s.profile_id = r.profile_id AND s.dedupe_key = r.dedupe_key
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE r.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
            """, profileId, mode).Select(row =>
        {
            var names = Metadata.Names(row);
            // A beatmap whose name was never read, as the best-performance entry falls back.
            var title = Metadata.BeatmapNameOrNull(names)
                ?? (row["beatmap_id"] is null ? "?" : $"beatmap {row.Text("beatmap_id")}");
            return (IActivityEvent)new RankEvent(row.Num("achieved_at") ?? double.NaN,
                settings.LinkedUserId > 0 ? settings.LinkedUserId : null, settings.LinkedUsername,
                row["rank"], row["grade"], mode, row["beatmap_id"], title, Metadata.BeatmapNameOriginal(names), row["version"]);
        })];
    }
}
