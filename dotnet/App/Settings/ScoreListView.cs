using System.Text.Json;

namespace OsuLocalProfiles.Settings;

/// <summary>
/// How the Scores view is set up, per profile (roadmap 5.86): which plays it lists, in what order,
/// narrowed how, as a table or as osu!'s rows, and how many rows at a time. Kept between visits;
/// Reset puts back everything but <see cref="Layout"/> and <see cref="PageSize"/>, which are how
/// the list is looked at rather than what it lists.
/// </summary>
/// <remarks>
/// The default is Best Performance without its cap: the best score on each beatmap, among those
/// that count toward this profile's pp (so its own choice of loved, unranked and the rest), by pp.
/// </remarks>
internal sealed class ScoreListView
{
    /// <summary>What can be sorted by: each a column of the table.</summary>
    public static readonly string[] Sorts = ["pp", "score", "accuracy", "grade", "combo", "stars", "misses", "playcount", "date", "beatmap"];
    /// <summary>Best to worst: the grade filter's order, and the grade sort's.</summary>
    public static readonly string[] GradeNames = ["XH", "X", "SH", "S", "A", "B", "C", "D", "F"];
    /// <summary>How many rows a page can hold: the first shown, and each show more.</summary>
    public static readonly int[] PageSizes = [25, 50, 100, 250, 500, 1000];

    /// <summary><c>best</c>, one score per beatmap, or <c>every</c> play.</summary>
    public string Show { get; set; } = "best";
    /// <summary>Scores that do not count toward pp as well: a failed play, an unranked mod the profile leaves out.</summary>
    public bool Uncounted { get; set; }
    public string Sort { get; set; } = "pp";
    /// <summary><c>desc</c> or <c>asc</c>.</summary>
    public string Order { get; set; } = "desc";
    public string Search { get; set; } = "";
    /// <summary>Every one of these on the play; <c>NM</c> is no mod at all.</summary>
    public List<string> Mods { get; set; } = [];
    public List<string> Grades { get; set; } = [];
    public List<string> Clients { get; set; } = [];
    public double? StarsMin { get; set; }
    public double? StarsMax { get; set; }
    /// <summary>Played from and to, epoch milliseconds.</summary>
    public double? From { get; set; }
    public double? To { get; set; }
    /// <summary><c>table</c> or <c>rows</c>. Not reset.</summary>
    public string Layout { get; set; } = "rows";
    /// <summary>Rows shown at first and added by each show more: one of <see cref="PageSizes"/>. Not reset.</summary>
    public int PageSize { get; set; } = 100;

    public static ScoreListView Default() => new();

    /// <summary>Whatever was sent, made into a view: anything unrecognised is the default.</summary>
    public static ScoreListView Coerce(JsonElement? raw)
    {
        var view = Default();
        if (!Js.IsRecord(raw)) return view;
        if (Js.IsString(Js.Get(raw, "show"), out var show) && show is "best" or "every") view.Show = show;
        view.Uncounted = Js.IsTrue(Js.Get(raw, "uncounted"));
        if (Js.IsString(Js.Get(raw, "sort"), out var sort) && Sorts.Contains(sort)) view.Sort = sort;
        if (Js.IsString(Js.Get(raw, "order"), out var order) && order is "asc" or "desc") view.Order = order;
        if (Js.IsString(Js.Get(raw, "search"), out var search)) view.Search = Js.Slice(Js.Trim(search), 200);
        view.Mods = Words(Js.Get(raw, "mods"), m => m.Length is >= 2 and <= 3 && m.All(char.IsAsciiLetterOrDigit), upper: true);
        view.Grades = Words(Js.Get(raw, "grades"), GradeNames.Contains, upper: true);
        view.Clients = Words(Js.Get(raw, "clients"), c => c.Length is > 0 and <= 20 && c.All(char.IsAsciiLetterLower), upper: false);
        view.StarsMin = Number(Js.Get(raw, "starsMin"), 0, 100);
        view.StarsMax = Number(Js.Get(raw, "starsMax"), 0, 100);
        view.From = Number(Js.Get(raw, "from"), 0, 1e15);
        view.To = Number(Js.Get(raw, "to"), 0, 1e15);
        if (Js.IsString(Js.Get(raw, "layout"), out var layout) && layout is "table" or "rows") view.Layout = layout;
        if (Js.Get(raw, "pageSize") is { ValueKind: JsonValueKind.Number } size && PageSizes.Contains((int)Js.NumberOf(size)) && Js.NumberOf(size) % 1 == 0)
        {
            view.PageSize = (int)Js.NumberOf(size);
        }
        return view;
    }

    private static List<string> Words(JsonElement? raw, Func<string, bool> allowed, bool upper)
    {
        if (!Js.IsArray(raw)) return [];
        var seen = new List<string>();
        foreach (var item in raw!.Value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) continue;
            var word = Js.Trim(item.GetString()!);
            word = upper ? word.ToUpperInvariant() : word.ToLowerInvariant();
            if (allowed(word) && !seen.Contains(word)) seen.Add(word);
            if (seen.Count >= 30) break;
        }
        return seen;
    }

    private static double? Number(JsonElement? raw, double min, double max) =>
        raw is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) is var v && double.IsFinite(v) && v >= min && v <= max ? v : null;
}
