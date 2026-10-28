using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Settings;

/// <summary>A closed interval; a <c>Max</c> of null is no upper bound, which is the default on both ranges.</summary>
internal sealed class NumberRange
{
    public double Min { get; set; }
    public double? Max { get; set; }
}

/// <summary>A date interval in epoch milliseconds. Null at either end is no bound there.</summary>
internal sealed class DateRange
{
    public double? From { get; set; }
    public double? To { get; set; }
}

/// <summary>
/// A date interval over a date osu! does not always have. <c>IncludeUnknown</c> is on by default,
/// so beatmaps with no such date keep being tracked unless the user says otherwise.
/// </summary>
internal sealed class UnknownableDateRange
{
    public double? From { get; set; }
    public double? To { get; set; }
    public bool IncludeUnknown { get; set; } = true;
}

/// <summary>One condition: <c>Values</c> are alternatives, so "Mapper is Blue Dragon, Mismagius" is one.</summary>
internal sealed class RuleCondition
{
    public string Field { get; set; } = "any";
    public string Test { get; set; } = "contains";
    public List<string> Values { get; set; } = [];
}

/// <summary>A rule matches a beatmap when every one of its conditions does.</summary>
internal sealed class BeatmapRule
{
    public List<RuleCondition> Conditions { get; set; } = [];
}

/// <summary>
/// Which plays are tracked at all: src/tracking-filter.ts, the shape, its cleaning and
/// <c>filterNarrows</c>. Matching a play against it comes with the tracker (phase 4).
/// </summary>
/// <remarks>
/// The filter decides what is written, so it is off by default and widest when on, a fact it
/// lacks never rejects a play, and a filter saved with the old <c>keywords</c> reads as the same
/// rule (roadmap 5.74). The reasons are in the TypeScript.
/// </remarks>
internal sealed partial class TrackingFilter
{
    public bool Enabled { get; set; }
    public List<BeatmapRule> Rules { get; set; } = [];
    /// <summary>Read only: carried over from the old keywords box and not saved since. Saving clears it.</summary>
    public bool FromKeywords { get; set; }
    public List<int> Modes { get; set; } = [.. AllModes];
    public List<string> Clients { get; set; } = [.. AllClients];
    public NumberRange Stars { get; set; } = new();
    public NumberRange Length { get; set; } = new();
    /// <summary>Only the mods that are not <c>allowed</c>, so a mod osu! adds later is allowed too.</summary>
    public Dictionary<string, string> Mods { get; set; } = [];
    public string NoMod { get; set; } = "allowed";
    public List<string> Categories { get; set; } = [.. CategoryNames];
    public DateRange Added { get; set; } = new();
    public UnknownableDateRange Submitted { get; set; } = new();
    public UnknownableDateRange Ranked { get; set; } = new();

    public static readonly string[] RuleFields = ["any", "title", "artist", "difficulty", "mapper", "setOwner", "source", "tags"];
    public static readonly string[] RuleTests = ["contains", "is", "notContains"];
    public const int MaxRules = 20;
    public const int MaxConditions = 10;
    private const int MaxValues = 100;
    private const int MaxValueLength = 200;

    /// <summary>The states the filter offers, each as osu!'s own <c>approved</c> values (FILTER_CATEGORIES).</summary>
    public static readonly (string Name, int[] Statuses)[] FilterCategories =
    [
        ("ranked", [Status.Ranked, Status.Approved]),
        ("qualified", [Status.Qualified]),
        ("loved", [Status.Loved]),
        ("pending", [Status.Pending]),
        ("wip", [Status.Wip]),
        ("graveyard", [Status.Graveyard]),
        ("unsubmitted", [Status.Unresolved]),
    ];

    public static readonly string[] CategoryNames = [.. FilterCategories.Select(c => c.Name)];
    private static readonly int[] AllModes = [0, 1, 2, 3];
    public static readonly string[] AllClients = ["stable", "lazer", "mcosu"];

    /// <summary>The day osu!'s beatmap listing begins: <c>Date.UTC(2007, 9, 6)</c>.</summary>
    public const double OsuEpoch = 1191628800000;

    public const double MaxStars = 15;
    public const double MaxLengthSeconds = 3600;

    public static TrackingFilter Default() => new();

    /* ---------------------------------------------------------------- coercion */

    /// <summary><c>Math.min(max, Math.max(min, Number(raw)))</c>, or null for nothing or not a number.</summary>
    private static double? OptionalNumber(JsonElement? raw, double min, double max)
    {
        if (raw is null || raw.Value.ValueKind == JsonValueKind.Null) return null;
        if (Js.IsString(raw, out var text) && text.Length == 0) return null;
        var value = Js.ToNumber(raw);
        if (!double.IsFinite(value)) return null;
        return Math.Min(max, Math.Max(min, value));
    }

    /// <summary>A range typed back to front is read as the range it describes.</summary>
    private static NumberRange CoerceRange(JsonElement? raw, double limit, Func<double, double> round)
    {
        JsonElement? source = Js.IsRecord(raw) ? raw : null;
        var min = round(OptionalNumber(Js.Get(source, "min"), 0, limit) ?? 0);
        var max = OptionalNumber(Js.Get(source, "max"), 0, limit);
        if (max is null) return new NumberRange { Min = min, Max = null };
        var top = round(max.Value);
        return new NumberRange { Min = Math.Min(min, top), Max = Math.Max(min, top) };
    }

    private static double RoundStars(double n) => Js.Round(n * 100) / 100;

    private static double RoundSeconds(double n) => Js.Round(n);

    private static double? DateBound(JsonElement? value)
    {
        if (value is null || value.Value.ValueKind == JsonValueKind.Null) return null;
        double at;
        if (Js.IsString(value, out var text))
        {
            if (text.Length == 0) return null;
            at = Js.DateParse(text);
        }
        else
        {
            at = Js.ToNumber(value);
        }
        if (!double.IsFinite(at)) return null;
        // No upper limit: a beatmap ranked tomorrow is a real beatmap.
        return Math.Max(OsuEpoch, Math.Floor(at));
    }

    private static DateRange CoerceDateRange(JsonElement? raw)
    {
        JsonElement? source = Js.IsRecord(raw) ? raw : null;
        var from = DateBound(Js.Get(source, "from"));
        var to = DateBound(Js.Get(source, "to"));
        if (from is not null && to is not null && from > to) return new DateRange { From = to, To = from };
        return new DateRange { From = from, To = to };
    }

    private static UnknownableDateRange CoerceUnknownableDateRange(JsonElement? raw)
    {
        var range = CoerceDateRange(raw);
        JsonElement? source = Js.IsRecord(raw) ? raw : null;
        return new UnknownableDateRange
        {
            From = range.From,
            To = range.To,
            IncludeUnknown = Js.NotFalse(Js.Get(source, "includeUnknown")),
        };
    }

    private static readonly string[] ModStates = ["allowed", "required", "excluded"];

    private static string CoerceModState(JsonElement? raw) =>
        Js.IsString(raw, out var text) && ModStates.Contains(text) ? text : "allowed";

    [GeneratedRegex(@"[\r\n\t]+")]
    private static partial Regex LineBreaks();

    /// <summary>
    /// A condition's values: an array from the page, or one comma-separated string from a
    /// script. Each is one line and trimmed; one differing only in case from an earlier one goes.
    /// </summary>
    private static List<string> CoerceValues(JsonElement? raw)
    {
        IEnumerable<string?> items =
            Js.IsArray(raw) ? raw!.Value.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() : null)
            : Js.IsString(raw, out var text) ? text.Split(',')
            : [];
        var output = new List<string>();
        foreach (var item in items)
        {
            if (item is null) continue;
            var value = Js.Slice(Js.Trim(LineBreaks().Replace(item, " ")), MaxValueLength);
            if (value.Length > 0 && !output.Any(kept => Js.ToLower(kept) == Js.ToLower(value))) output.Add(value);
            if (output.Count >= MaxValues) break;
        }
        return output;
    }

    /// <summary>
    /// The rules, cleaned. A condition with no values says nothing, and a rule with no conditions
    /// would match every beatmap, so both are dropped.
    /// </summary>
    private static List<BeatmapRule> CoerceRules(JsonElement raw)
    {
        var rules = new List<BeatmapRule>();
        foreach (var rule in raw.EnumerateArray())
        {
            var list = Js.Get(rule, "conditions");
            if (!Js.IsRecord(rule) || !Js.IsArray(list)) continue;
            var conditions = new List<RuleCondition>();
            foreach (var c in list!.Value.EnumerateArray())
            {
                if (!Js.IsRecord(c)) continue;
                var values = CoerceValues(Js.Get(c, "values"));
                if (values.Count == 0) continue;
                var field = Js.IsString(Js.Get(c, "field"), out var f) && RuleFields.Contains(f) ? f : "any";
                var test = Js.IsString(Js.Get(c, "test"), out var t) && RuleTests.Contains(t) ? t : "contains";
                conditions.Add(new RuleCondition { Field = field, Test = test, Values = values });
                if (conditions.Count >= MaxConditions) break;
            }
            if (conditions.Count > 0) rules.Add(new BeatmapRule { Conditions = conditions });
            if (rules.Count >= MaxRules) break;
        }
        return rules;
    }

    [GeneratedRegex(@"^[0-9A-Z]{2,3}\z")]
    private static partial Regex Acronym();

    /// <summary>
    /// Clean whatever arrived from the page, or was read back from a database written by
    /// another version. The only validation there is, so it accepts anything at all.
    /// </summary>
    public static TrackingFilter Coerce(JsonElement? raw)
    {
        var output = Default();
        if (!Js.IsRecord(raw)) return output;

        output.Enabled = Js.IsTrue(Js.Get(raw, "enabled"));
        var rules = Js.Get(raw, "rules");
        if (Js.IsArray(rules))
        {
            output.Rules = CoerceRules(rules!.Value);
        }
        else if (Js.IsString(Js.Get(raw, "keywords"), out var keywords))
        {
            // A filter saved before beatmap rules existed: its keywords become one rule, "Any
            // field contains" one of them, which is exactly the old test.
            var terms = CoerceValues(JsonText.From(Js.Slice(LineBreaks().Replace(keywords, " "), 200)));
            if (terms.Count > 0)
            {
                output.Rules = [new BeatmapRule { Conditions = [new RuleCondition { Field = "any", Test = "contains", Values = terms }] }];
                output.FromKeywords = true;
            }
        }

        var modes = Js.Get(raw, "modes");
        if (Js.IsArray(modes))
        {
            var seen = new HashSet<int>();
            foreach (var value in modes!.Value.EnumerateArray())
            {
                var mode = Js.ToNumber(value);
                if (mode is 0 or 1 or 2 or 3) seen.Add((int)mode);
            }
            // An empty list is kept: it means "no mode", a filter that tracks nothing.
            output.Modes = [.. AllModes.Where(seen.Contains)];
        }
        var clients = Js.Get(raw, "clients");
        if (Js.IsArray(clients))
        {
            var seen = clients!.Value.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToHashSet();
            output.Clients = [.. AllClients.Where(seen.Contains)];
        }

        output.Stars = CoerceRange(Js.Get(raw, "stars"), MaxStars, RoundStars);
        output.Length = CoerceRange(Js.Get(raw, "length"), MaxLengthSeconds, RoundSeconds);

        var mods = Js.Get(raw, "mods");
        if (Js.IsRecord(mods))
        {
            // Object.entries over what JSON.parse kept: a key written twice has its last value.
            var entries = new Dictionary<string, JsonElement>();
            foreach (var property in mods!.Value.EnumerateObject()) entries[property.Name] = property.Value;
            foreach (var (acronym, state) in entries)
            {
                // osu!'s acronyms are two or three characters; mania's key counts start with a digit.
                if (!Acronym().IsMatch(acronym)) continue;
                var coerced = CoerceModState(state);
                if (coerced != "allowed") output.Mods[acronym] = coerced;
            }
        }
        output.NoMod = CoerceModState(Js.Get(raw, "noMod"));

        var categories = Js.Get(raw, "categories");
        if (Js.IsArray(categories))
        {
            var seen = categories!.Value.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToHashSet();
            output.Categories = [.. CategoryNames.Where(seen.Contains)];
        }

        output.Added = CoerceDateRange(Js.Get(raw, "added"));
        output.Submitted = CoerceUnknownableDateRange(Js.Get(raw, "submitted"));
        output.Ranked = CoerceUnknownableDateRange(Js.Get(raw, "ranked"));

        return output;
    }

    /// <summary>Whether this filter can turn any play away at all; off narrows nothing.</summary>
    public static bool Narrows(TrackingFilter filter)
    {
        if (!filter.Enabled) return false;
        if (filter.Modes.Count < AllModes.Length) return true;
        if (filter.Clients.Count < AllClients.Length) return true;
        if (filter.Rules.Count > 0) return true;
        if (filter.Stars.Min > 0 || filter.Stars.Max is not null) return true;
        if (filter.Length.Min > 0 || filter.Length.Max is not null) return true;
        if (filter.NoMod != "allowed") return true;
        if (filter.Mods.Count > 0) return true;
        if (filter.Categories.Count < CategoryNames.Length) return true;
        if (filter.Added.From is not null || filter.Added.To is not null) return true;
        if (filter.Submitted.From is not null || filter.Submitted.To is not null) return true;
        if (filter.Ranked.From is not null || filter.Ranked.To is not null) return true;
        if (!filter.Submitted.IncludeUnknown || !filter.Ranked.IncludeUnknown) return true;
        return false;
    }
}
