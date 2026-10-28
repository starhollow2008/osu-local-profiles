using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Settings;

/// <summary>
/// Per-profile settings, edited from the page: src/settings.ts. Stored one row per key in
/// <c>profile_settings</c>, as JSON, so an older database simply falls back to the default for
/// anything it has never stored. What each one means is written beside it in the TypeScript.
/// </summary>
/// <remarks>Properties are in the order of <c>DEFS</c>, which is the order the JSON is written in.</remarks>
internal sealed class ProfileSettings
{
    public string Country { get; set; } = "";
    public string Tagline { get; set; } = "";
    public bool IncludeUnrankedMods { get; set; } = true;
    public string UnrankedModPp { get; set; } = "as-played";
    public string AboutMe { get; set; } = "";
    public string ShowIncompleteInRecent { get; set; } = "collapse";
    public bool CountUnsubmittedAttempts { get; set; } = true;
    public bool ImportPlaysWhileClosed { get; set; }
    public bool ShowCountingNote { get; set; } = true;
    public int ShowMoreRows { get; set; } = 25;
    public bool ShowMoreAll { get; set; }
    public bool ShowFavoritesHint { get; set; } = true;
    public bool ShowStableNote { get; set; } = true;
    public string Scoring { get; set; } = "lazer";
    public TrackingFilter TrackingFilter { get; set; } = TrackingFilter.Default();
    public List<string> SectionOrder { get; set; } = [];
    public List<string> HiddenSections { get; set; } = [];
    public long LinkedUserId { get; set; }
    public string LinkedUsername { get; set; } = "";
    public bool LinkedNamesKnown { get; set; }
    public List<string> LinkedPreviousNames { get; set; } = [];
    public List<string> AccountNames { get; set; } = [];
    public List<string> OwnNames { get; set; } = [];
    /// <summary>Every status there is, by default, so no play is left out of pp for its beatmap until asked.</summary>
    public List<string> IncludeUnrankedMaps { get; set; } = [.. Status.UnrankedMapStatuses.Select(s => s.Name)];
}

internal static partial class SettingsStore
{
    /// <summary>
    /// The most rows one list may be asked for: the ceiling on <c>showMoreRows</c>, and what "All
    /// at once" asks for (MAX_PAGE_ROWS).
    /// </summary>
    public const int MaxPageRows = 10_000;

    /* -------------------------------------------------------------- cleaning */

    /// <summary>
    /// One line, one length. Control characters become spaces rather than being dropped, so pasted
    /// multi-line text keeps its word boundaries.
    /// </summary>
    internal static string CleanText(JsonElement? raw, int maxLength)
    {
        if (!Js.IsString(raw, out var text)) return "";
        var sb = new StringBuilder(text.Length);
        foreach (var c in text) sb.Append(c < 32 || c == 127 ? ' ' : c);
        return Js.Slice(Js.Trim(sb.ToString()), maxLength);
    }

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex BlankLines();

    /// <summary>Like <see cref="CleanText"/>, for paragraphs: newlines kept, CRLF made LF, blank runs collapsed.</summary>
    internal static string CleanMultiline(JsonElement? raw, int maxLength)
    {
        if (!Js.IsString(raw, out var text)) return "";
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            if (c == '\n') sb.Append(c);
            else if (c == '\r') continue;
            else sb.Append(c < 32 || c == 127 ? ' ' : c);
        }
        return Js.Slice(Js.Trim(BlankLines().Replace(sb.ToString(), "\n\n")), maxLength);
    }

    /// <summary>osu! usernames, each once whatever its case, at most 64 looked at.</summary>
    private static List<string> NameList(IEnumerable<JsonElement> items)
    {
        var seen = new HashSet<string>();
        var output = new List<string>();
        foreach (var value in items.Take(64))
        {
            var name = CleanText(value, 32);
            if (name.Length == 0 || !seen.Add(Js.ToLower(name))) continue;
            output.Add(name);
        }
        return output;
    }

    private static List<string> NameList(JsonElement? raw) =>
        Js.IsArray(raw) ? NameList(raw!.Value.EnumerateArray()) : [];

    [GeneratedRegex(@"^[a-z_]{1,32}\z")]
    private static partial Regex SectionId();

    /// <summary>Section ids, each once. Only shape is checked; the page reconciles against its own list.</summary>
    private static List<string> SectionIds(JsonElement? raw)
    {
        if (!Js.IsArray(raw)) return [];
        var seen = new HashSet<string>();
        var output = new List<string>();
        foreach (var value in raw!.Value.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String) continue;
            var id = value.GetString()!;
            if (SectionId().IsMatch(id) && seen.Add(id)) output.Add(id);
        }
        return output;
    }

    [GeneratedRegex(@"^[A-Z]{2}\z")]
    private static partial Regex CountryCode();

    /* ------------------------------------------------------------ definitions */

    /// <summary>A setting: how to clean any value into it, and how to read it back out.</summary>
    private sealed record Def(string Key, Action<ProfileSettings, JsonElement?> Coerce, Func<ProfileSettings, object> Read);

    private static readonly Def[] Defs =
    [
        // Cleaned to more than two characters on purpose, so "USA" is rejected rather than
        // truncated to "US": a wrong country is worse than no country.
        new("country", (s, raw) =>
        {
            var code = Js.ToUpper(CleanText(raw, 16));
            s.Country = CountryCode().IsMatch(code) ? code : "";
        }, s => s.Country),
        new("tagline", (s, raw) => s.Tagline = CleanText(raw, 120), s => s.Tagline),
        new("includeUnrankedMods", (s, raw) => s.IncludeUnrankedMods = Js.IsTrue(raw), s => s.IncludeUnrankedMods),
        new("unrankedModPp", (s, raw) =>
            s.UnrankedModPp = Js.IsString(raw, out var v) && v == "without-the-mod" ? "without-the-mod" : "as-played",
            s => s.UnrankedModPp),
        // osu!'s own me! pages run long, and an imported one should arrive whole.
        new("aboutMe", (s, raw) => s.AboutMe = CleanMultiline(raw, 60000), s => s.AboutMe),
        new("showIncompleteInRecent", (s, raw) =>
            s.ShowIncompleteInRecent = Js.IsString(raw, out var v) && v is "yes" or "no" ? v : "collapse",
            s => s.ShowIncompleteInRecent),
        new("countUnsubmittedAttempts", (s, raw) => s.CountUnsubmittedAttempts = Js.NotFalse(raw), s => s.CountUnsubmittedAttempts),
        new("importPlaysWhileClosed", (s, raw) => s.ImportPlaysWhileClosed = Js.IsTrue(raw), s => s.ImportPlaysWhileClosed),
        new("showCountingNote", (s, raw) => s.ShowCountingNote = Js.NotFalse(raw), s => s.ShowCountingNote),
        // A whole number of rows; anything else (empty, zero, text) is the default again.
        new("showMoreRows", (s, raw) =>
        {
            var n = raw is { ValueKind: JsonValueKind.Number } number
                ? Js.NumberOf(number)
                : Js.StringToNumber(Js.Trim(raw is null || raw.Value.ValueKind == JsonValueKind.Null ? "" : Js.ToJsString(raw.Value)));
            s.ShowMoreRows = double.IsFinite(n) && n >= 1 ? (int)Math.Min(Math.Floor(n), MaxPageRows) : 25;
        }, s => s.ShowMoreRows),
        new("showMoreAll", (s, raw) => s.ShowMoreAll = Js.IsTrue(raw), s => s.ShowMoreAll),
        new("showFavoritesHint", (s, raw) => s.ShowFavoritesHint = Js.NotFalse(raw), s => s.ShowFavoritesHint),
        new("showStableNote", (s, raw) => s.ShowStableNote = Js.NotFalse(raw), s => s.ShowStableNote),
        new("scoring", (s, raw) => s.Scoring = Js.IsString(raw, out var v) && v == "classic" ? "classic" : "lazer", s => s.Scoring),
        new("trackingFilter", (s, raw) => s.TrackingFilter = TrackingFilter.Coerce(raw), s => s.TrackingFilter),
        new("sectionOrder", (s, raw) => s.SectionOrder = SectionIds(raw), s => s.SectionOrder),
        new("hiddenSections", (s, raw) => s.HiddenSections = SectionIds(raw), s => s.HiddenSections),
        new("linkedUserId", (s, raw) =>
        {
            var id = Math.Floor(Js.ToNumber(raw));
            // Saturated past long's range, where JavaScript would keep an imprecise double.
            s.LinkedUserId = double.IsFinite(id) && id > 0 ? (id >= long.MaxValue ? long.MaxValue : (long)id) : 0;
        }, s => s.LinkedUserId),
        new("linkedUsername", (s, raw) => s.LinkedUsername = CleanText(raw, 32), s => s.LinkedUsername),
        new("linkedNamesKnown", (s, raw) => s.LinkedNamesKnown = raw is { ValueKind: JsonValueKind.True }, s => s.LinkedNamesKnown),
        new("linkedPreviousNames", (s, raw) => s.LinkedPreviousNames = NameList(raw), s => s.LinkedPreviousNames),
        new("accountNames", (s, raw) => s.AccountNames = NameList(raw), s => s.AccountNames),
        // A list from the page, or the box's text as typed.
        new("ownNames", (s, raw) => s.OwnNames = Js.IsString(raw, out var text)
            ? NameList(text.Split(',').Select(JsonText.From))
            : NameList(raw), s => s.OwnNames),
        // Filtered against the known set and de-duplicated, so a list written by a different
        // version cannot widen what counts.
        new("includeUnrankedMaps", (s, raw) =>
        {
            if (!Js.IsArray(raw))
            {
                s.IncludeUnrankedMaps = [];
                return;
            }
            var seen = new HashSet<string>();
            s.IncludeUnrankedMaps = [.. raw!.Value.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.String)
                .Select(e => e.GetString()!)
                .Where(name => Status.UnrankedMapStatus(name) is not null && seen.Add(name))];
        }, s => s.IncludeUnrankedMaps),
    ];

    private static readonly Dictionary<string, Def> ByKey = Defs.ToDictionary(d => d.Key);

    public static IEnumerable<string> Keys => Defs.Select(d => d.Key);

    public static ProfileSettings Defaults() => new();

    /// <summary>
    /// Every setting for a profile, defaults filling in whatever has never been stored.
    /// <paramref name="fallbacks"/> stand in for keys with no stored row: config.json's country
    /// and tagline, for a profile that has never edited them. A stored value always wins,
    /// including an empty one, so "clear my country" sticks.
    /// </summary>
    public static ProfileSettings Get(Database db, long profileId, IReadOnlyDictionary<string, JsonElement>? fallbacks = null)
    {
        var settings = Defaults();
        if (fallbacks is not null)
        {
            foreach (var def in Defs)
            {
                if (fallbacks.TryGetValue(def.Key, out var fallback)) def.Coerce(settings, fallback);
            }
        }

        var rows = db.All("SELECT key, value FROM profile_settings WHERE profile_id = ?",
            r => (Key: r.GetString(0), Value: r.GetString(1)), profileId);
        foreach (var (key, value) in rows)
        {
            if (!ByKey.TryGetValue(key, out var def)) continue; // written by a different version
            // A corrupt row falls back to the default rather than breaking the page.
            if (!JsonText.TryParse(value, out var parsed)) continue;
            def.Coerce(settings, parsed);
        }
        return settings;
    }

    /// <summary>
    /// Apply a partial update and return the whole set. Unknown keys are ignored, so a page left
    /// open across an upgrade cannot fail its save on a key that has since gone.
    /// </summary>
    public static ProfileSettings Update(Database db, long profileId, JsonElement patch,
        IReadOnlyDictionary<string, JsonElement>? fallbacks = null)
    {
        db.Transaction(() =>
        {
            foreach (var def in Defs)
            {
                var value = Js.Get(patch, def.Key);
                if (value is null) continue;
                var cleaned = new ProfileSettings();
                def.Coerce(cleaned, value);
                db.Run("""
                    INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
                      ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value
                    """, profileId, def.Key, JsonText.Stringify(def.Read(cleaned)));
            }
        });
        return Get(db, profileId, fallbacks);
    }
}
