using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Settings;

/// <summary>
/// A beatmap's text, field by field, as the beatmap rules read it; a field the file does not have
/// is empty. <c>Mappers</c> is osu!'s record of who mapped this difficulty, or null where
/// <c>online.db</c> has none.
/// </summary>
internal sealed record BeatmapText(
    string Title, string TitleUnicode, string Artist, string ArtistUnicode, string Difficulty,
    string SetOwner, string Source, string Tags, List<string>? Mappers);

/// <summary>
/// The facts a play is judged on, supplied in stages: anything null is not knowable and never
/// rejects. <c>Mode</c> and <c>Client</c> null mean not supplied; <c>HasDates</c> false means the
/// dates were not supplied, where a supplied null is an unknown date.
/// </summary>
internal sealed record PlayFacts(
    int? Mode = null,
    string? Client = null,
    List<JsonElement>? Mods = null,
    double? Stars = null,
    double? LengthSeconds = null,
    int? Status = null,
    BeatmapText? Beatmap = null,
    bool HasDates = false,
    double? AddedAt = null,
    double? SubmittedAt = null,
    double? RankedAt = null);

/// <summary>The beatmap's half of the facts, each looked up once and remembered on its <c>beatmaps</c> row.</summary>
internal sealed record BeatmapFilterFacts(int Status, BeatmapText? Beatmap, double? LengthMs, double? AddedAt, double? SubmittedAt, double? RankedAt);

/// <summary>Matching a play against the filter: src/tracking-filter.ts, the matching half.</summary>
internal sealed partial class TrackingFilter
{
    /* ---------------------------------------------------------- beatmap rules */

    /// <summary>A letter or number of any script, as <c>[\p{L}\p{N}]</c> with the <c>u</c> flag reads one.</summary>
    private static bool IsWordRune(Rune r) => Rune.GetUnicodeCategory(r) switch
    {
        UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber => true,
        _ => false,
    };

    private static bool WordBefore(string text, int at) =>
        at > 0 && Rune.DecodeLastFromUtf16(text.AsSpan(0, at), out var r, out _) == OperationStatus.Done && IsWordRune(r);

    private static bool WordAfter(string text, int at) =>
        at < text.Length && Rune.DecodeFromUtf16(text.AsSpan(at), out var r, out _) == OperationStatus.Done && IsWordRune(r);

    /// <summary>
    /// <paramref name="value"/> as a whole word or phrase of <paramref name="text"/>: "mismagius" in
    /// "mismagius' hard", not in "mismagiusfan".
    /// </summary>
    private static bool ContainsWhole(string text, string value)
    {
        for (var start = 0; start <= text.Length;)
        {
            var at = text.IndexOf(value, start, StringComparison.Ordinal);
            if (at < 0) return false;
            if (!WordBefore(text, at) && !WordAfter(text, at + value.Length)) return true;
            start = at + 1;
        }
        return false;
    }

    private static string Lower(string text) => Js.ToLower(text);

    /// <summary>Tags written <c>blue_dragon</c> read as <c>blue dragon</c> too.</summary>
    private static string SpacedTags(string tags) => Lower(tags).Replace('_', ' ');

    /// <summary><c>text.split(/\s+/).filter(Boolean)</c>.</summary>
    private static List<string> Words(string text)
    {
        var words = new List<string>();
        var current = new StringBuilder();
        foreach (var c in text)
        {
            if (Js.IsSpace(c))
            {
                if (current.Length > 0) words.Add(current.ToString());
                current.Clear();
            }
            else
            {
                current.Append(c);
            }
        }
        if (current.Length > 0) words.Add(current.ToString());
        return words;
    }

    /// <summary>One of the beatmap's tags, written with <c>_</c> for a space or not; a name may also be two tags in a row.</summary>
    private static bool HasTag(string tags, string value)
    {
        var words = Words(Lower(tags));
        if (words.Contains(value) || words.Contains(value.Replace(' ', '_'))) return true;
        return value.Contains(' ') && ContainsWhole(SpacedTags(tags), value);
    }

    private static List<string> FieldTexts(BeatmapText b, string field)
    {
        string[] texts = field switch
        {
            "title" => [b.Title, b.TitleUnicode],
            "artist" => [b.Artist, b.ArtistUnicode],
            "difficulty" => [b.Difficulty],
            "setOwner" => [b.SetOwner],
            _ => [b.Source],
        };
        return [.. texts.Where(t => t != "").Select(Lower)];
    }

    /// <summary>
    /// Whether the difficulty was mapped by <paramref name="value"/>: by osu!'s record when there is
    /// one, else the set owner or the name written into the difficulty name or tags.
    /// </summary>
    private static bool MapperMatches(BeatmapText b, string test, string value)
    {
        if (b.Mappers is not null)
        {
            return b.Mappers.Any(name => test == "is" ? Lower(name) == value : Lower(name).Contains(value, StringComparison.Ordinal));
        }
        var owner = Lower(b.SetOwner);
        var difficulty = Lower(b.Difficulty);
        if (test == "is") return owner == value || ContainsWhole(difficulty, value) || HasTag(b.Tags, value);
        return owner.Contains(value, StringComparison.Ordinal) || difficulty.Contains(value, StringComparison.Ordinal)
            || SpacedTags(b.Tags).Contains(value, StringComparison.Ordinal) || Lower(b.Tags).Contains(value, StringComparison.Ordinal);
    }

    private static bool ValueMatches(BeatmapText b, string field, string test, string value)
    {
        if (field == "mapper") return MapperMatches(b, test, value);
        if (field == "any")
        {
            // The four fields the old keywords box read, joined as it joined them.
            var romanised = new[] { b.Artist, b.Title, b.Difficulty, b.SetOwner }.Where(t => t != "").Select(Lower).ToList();
            return test == "is" ? romanised.Contains(value) : string.Join(" ", romanised).Contains(value, StringComparison.Ordinal);
        }
        if (field == "tags")
        {
            if (test == "contains") return Lower(b.Tags).Contains(value, StringComparison.Ordinal) || SpacedTags(b.Tags).Contains(value, StringComparison.Ordinal);
            return HasTag(b.Tags, value);
        }
        var texts = FieldTexts(b, field);
        return test == "is" ? texts.Contains(value) : texts.Any(t => t.Contains(value, StringComparison.Ordinal));
    }

    private static bool ConditionMatches(BeatmapText b, RuleCondition c)
    {
        var test = c.Test == "is" ? "is" : "contains";
        var hit = c.Values.Any(value => ValueMatches(b, c.Field, test, Lower(value)));
        return c.Test == "notContains" ? !hit : hit;
    }

    /// <summary>Whether a beatmap matches the rules: any rule, with every one of its conditions.</summary>
    public static bool RulesMatch(IEnumerable<BeatmapRule> rules, BeatmapText b) =>
        rules.Any(rule => rule.Conditions.All(c => ConditionMatches(b, c)));

    /* ---------------------------------------------------------------- criteria */

    private static bool OutsideRange(double value, NumberRange range) =>
        value < range.Min || (range.Max is { } max && value > max);

    private static bool OutsideDates(double? at, double? from, double? to, bool includeUnknown)
    {
        if (at is null) return !includeUnknown;
        if (from is { } f && at < f) return true;
        return to is { } t && at > t;
    }

    /// <summary>Mods the filter has nothing to say about: ScoreV2 is a scoring system, not a mod it offers.</summary>
    private static readonly HashSet<string> UnfilteredMods = ["SV2"];

    /// <summary>A mod's acronym as a <c>Set</c> holds it: a string, or anything else kept apart from every string.</summary>
    private static string AcronymKey(JsonElement mod) => Js.Get(mod, "acronym") switch
    {
        null => "\0undefined",
        { ValueKind: JsonValueKind.String } s => s.GetString()!,
        { } other => "\0" + other.GetRawText(),
    };

    private bool ModsRejected(IEnumerable<JsonElement> mods)
    {
        var present = mods.Select(AcronymKey).Where(a => !UnfilteredMods.Contains(a)).ToHashSet(StringComparer.Ordinal);
        if (NoMod == "required" && present.Count > 0) return true;
        if (NoMod == "excluded" && present.Count == 0) return true;
        foreach (var (acronym, state) in Mods)
        {
            if (state == "required" && !present.Contains(acronym)) return true;
            if (state == "excluded" && present.Contains(acronym)) return true;
        }
        return false;
    }

    private bool CategoryAllowed(int status) =>
        Categories.Any(name => FilterCategories.FirstOrDefault(c => c.Name == name).Statuses?.Contains(status) == true);

    /// <summary>
    /// Which criterion rejects this play, or null if the filter tracks it. A missing fact never
    /// rejects, which is what lets the star rating be asked only of a play that survived the rest.
    /// </summary>
    public string? Rejects(PlayFacts facts)
    {
        if (!Enabled) return null;

        if (facts.Mode is { } mode && !Modes.Contains(mode)) return "mode";
        if (facts.Client is { } client && !Clients.Contains(client)) return "client";

        // A beatmap whose metadata could not be read is not judged on it.
        if (Rules.Count > 0 && facts.Beatmap is not null && !RulesMatch(Rules, facts.Beatmap)) return "beatmap rules";

        if (facts.Status is { } status && !CategoryAllowed(status)) return "category";

        if (facts.HasDates)
        {
            if (OutsideDates(facts.AddedAt, Added.From, Added.To, true)) return "date added";
            if (OutsideDates(facts.SubmittedAt, Submitted.From, Submitted.To, Submitted.IncludeUnknown)) return "date submitted";
            if (OutsideDates(facts.RankedAt, Ranked.From, Ranked.To, Ranked.IncludeUnknown)) return "date ranked";
        }

        if (facts.LengthSeconds is { } length && OutsideRange(length, Length)) return "length";

        if (facts.Mods is not null && ModsRejected(facts.Mods)) return "mods";

        // Rounded to what the page shows, so "up to 6.9" does not reject a play osu! made 6.9000001.
        if (facts.Stars is { } stars && OutsideRange(RoundStars(stars), Stars)) return "star rating";

        return null;
    }

    /* ------------------------------------------------------------------- facts */

    /// <summary>When osu! put this file on the machine: its creation time, else its mtime; 0 when it cannot be read.</summary>
    private static double FileCreatedAt(string file)
    {
        FileSystemInfo info = File.Exists(file) ? new FileInfo(file) : new DirectoryInfo(file);
        if (!info.Exists) return 0;
        try
        {
            var born = Js.Round(Js.MtimeMs(info.CreationTimeUtc));
            return born > 0 ? born : Js.Round(Js.MtimeMs(info.LastWriteTimeUtc));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static double? OrNull(double value) => value > 0 ? value : null;

    private static double? NumberOf(object? value) => value switch
    {
        long l => l,
        double d => d,
        _ => null,
    };

    /// <summary>
    /// The beatmap's half of the facts, each looked up once and remembered on the <c>beatmaps</c> row:
    /// NULL there is never looked up, 0 looked up and not knowable.
    /// </summary>
    public static BeatmapFilterFacts BeatmapFacts(Database db, BeatmapResolver resolver, ResolvedBeatmap beatmap) => db.Serialized(() =>
    {
        var row = db.FirstRow("SELECT length_ms, added_at, submitted_at, ranked_at, tags, source FROM beatmaps WHERE md5 = ?", beatmap.Md5);
        var lengthMs = row?.Num("length_ms");
        var addedAt = row?.Num("added_at");
        var submittedAt = row?.Num("submitted_at");
        var rankedAt = row?.Num("ranked_at");
        var tags = row?.Str("tags");
        var source = row?.Str("source");

        // The file, read at most once however many of its facts are missing.
        string? text = null;
        var read = false;
        string? OsuText()
        {
            if (read) return text;
            read = true;
            try
            {
                text = beatmap.OsuPath is { Length: > 0 } p ? Js.ReadFileUtf8(p) : null;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                text = null;
            }
            return text;
        }

        lengthMs ??= OsuText() is { } forLength ? PlayTime.BeatmapLengthMs(forLength) : 0;
        if (tags is null || source is null)
        {
            (tags, source) = OsuText() is { } forTags ? Beatmaps.TagsAndSource(forTags) : ("", "");
        }
        addedAt ??= beatmap.OsuPath is { Length: > 0 } osuPath ? FileCreatedAt(osuPath) : 0;
        if (submittedAt is null || rankedAt is null)
        {
            var dates = NumberOf(beatmap.BeatmapsetId) is { } setId ? resolver.BeatmapsetDates(setId) : null;
            submittedAt = dates?.SubmittedAt ?? 0;
            rankedAt = dates?.RankedAt ?? 0;
        }

        if (row is not null)
        {
            db.Run("UPDATE beatmaps SET length_ms = ?, added_at = ?, submitted_at = ?, ranked_at = ?, tags = ?, source = ? WHERE md5 = ?",
                lengthMs, addedAt, submittedAt, rankedAt, tags, source, beatmap.Md5);
        }

        // No name at all is a beatmap whose metadata could not be read, which the rules do not judge.
        var named = new[] { beatmap.Artist, beatmap.Title, beatmap.Version, beatmap.Creator }.Any(s => !string.IsNullOrEmpty(s));
        return new BeatmapFilterFacts(
            Tracker.Pricing.StatusOf(beatmap.Status) ?? Status.Unresolved,
            named
                ? new BeatmapText(
                    beatmap.Title ?? "", beatmap.TitleUnicode ?? "", beatmap.Artist ?? "", beatmap.ArtistUnicode ?? "",
                    beatmap.Version ?? "", beatmap.Creator ?? "", source ?? "", tags ?? "",
                    NumberOf(beatmap.BeatmapId) is { } id ? resolver.BeatmapMappers(id) : null)
                : null,
            OrNull(lengthMs.Value), OrNull(addedAt.Value), OrNull(submittedAt.Value), OrNull(rankedAt.Value));
    });

    /// <summary>
    /// The beatmap facts as the filter reads them, with the length at the speed it was played. No
    /// mods (a play with no replay) leaves it at the beatmap's own speed.
    /// </summary>
    public static PlayFacts PlayFactsOf(BeatmapFilterFacts facts, int mode, List<JsonElement>? mods, string client)
    {
        var rate = mods is null ? 1 : PlayTime.PlayRate(mods);
        return new PlayFacts(
            Mode: mode,
            Client: client,
            Mods: mods,
            LengthSeconds: facts.LengthMs is { } ms ? Js.Round(ms / rate / 1000) : null,
            Status: facts.Status,
            Beatmap: facts.Beatmap,
            HasDates: true,
            AddedAt: facts.AddedAt,
            SubmittedAt: facts.SubmittedAt,
            RankedAt: facts.RankedAt);
    }
}
