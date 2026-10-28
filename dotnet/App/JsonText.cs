using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OsuLocalProfiles;

/// <summary><c>JSON.stringify</c> and <c>JSON.parse</c>, as the Node app used them.</summary>
internal static class JsonText
{
    /// <summary>
    /// camelCase names, nulls written out, and text left unescaped as <c>JSON.stringify</c> leaves
    /// it. Only ever sent as <c>application/json</c>, so nothing reads it as HTML.
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DictionaryKeyPolicy = null,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static string Stringify<T>(T value) => JsonSerializer.Serialize(value, Options);

    /// <summary><c>JSON.parse</c>, false where it would throw.</summary>
    public static bool TryParse(string text, out JsonElement value)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            value = doc.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            value = default;
            return false;
        }
    }

    /// <summary>A value built in C#, as the element the coercers read: what the page would have posted.</summary>
    public static JsonElement From<T>(T value) => JsonSerializer.SerializeToElement(value, Options);
}
