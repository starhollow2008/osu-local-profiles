using System.Collections.Concurrent;
using System.Text.Json;

namespace OsuLocalProfiles;

/// <summary>The languages osu! offers: src/i18n.ts.</summary>
internal static class I18n
{
    public const string DefaultLocale = "en";

    /// <summary>Every locale osu! offers, translated here or not; the page decides what it offers.</summary>
    public static readonly string[] LocaleCodes =
    [
        "en", "ar", "be", "bg", "ca", "cs", "da", "de", "el", "es", "es-419", "fi", "fil", "fr", "he", "hu", "id", "it",
        "ja", "ko", "lt", "lv", "ms", "nl", "no", "pl", "pt", "pt-br", "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr",
        "uk", "vi", "zh", "zh-tw",
    ];

    private static readonly HashSet<string> Known = [.. LocaleCodes];

    /// <summary>Whether the page may be told to use this language: osu!'s whole list, translated or not.</summary>
    public static bool IsLocale(string? value) => value is not null && Known.Contains(value);

    public static bool IsLocale(JsonElement? value) => Js.IsString(value, out var text) && Known.Contains(text);
}

/// <summary>
/// The words an export is written in: the page's own translations (<c>web/i18n/&lt;locale&gt;.json</c>),
/// with English standing in for whatever a language lacks, exactly as on the page (src/export/words.ts).
/// </summary>
internal sealed class Translator
{
    private static readonly ConcurrentDictionary<string, Dictionary<string, JsonElement>> Cache = new();

    private readonly Dictionary<string, JsonElement> own;
    private readonly Dictionary<string, JsonElement> english;

    public Translator(string webRoot, string locale)
    {
        var dir = Path.Combine(webRoot, "i18n");
        own = I18n.IsLocale(locale) ? Load(dir, locale) : [];
        english = Load(dir, I18n.DefaultLocale);
    }

    private static Dictionary<string, JsonElement> Load(string dir, string locale) =>
        Cache.GetOrAdd(Path.Combine(dir, $"{locale}.json"), static file =>
        {
            var strings = new Dictionary<string, JsonElement>();
            try
            {
                if (JsonText.TryParse(Js.ReadFileUtf8(file), out var parsed) && parsed.ValueKind == JsonValueKind.Object)
                {
                    foreach (var p in parsed.EnumerateObject()) strings[p.Name] = p.Value;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* no such language here: English stands in, as on the page */
            }
            return strings;
        });

    /// <summary><c>t(key, vars)</c>: the language's words, else English's, else the key; <c>{name}</c> filled in.</summary>
    public string T(string key, params (string Name, string Value)[] vars)
    {
        var text = own.TryGetValue(key, out var found) && found.ValueKind != JsonValueKind.Null
            ? Js.ToJsString(found)
            : english.TryGetValue(key, out var en) && en.ValueKind != JsonValueKind.Null ? Js.ToJsString(en) : key;
        foreach (var (name, value) in vars) text = text.Replace("{" + name + "}", value, StringComparison.Ordinal);
        return text;
    }
}
