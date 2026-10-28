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
        Converters = { new FiniteOrNull() },
    };

    /// <summary>
    /// <c>JSON.stringify</c> writes NaN and Infinity as <c>null</c>; .NET would throw. A figure the
    /// arithmetic could not produce reaches the page as nothing, as it always did.
    /// </summary>
    private sealed class FiniteOrNull : JsonConverter<double>
    {
        public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.GetDouble();

        public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options)
        {
            if (double.IsFinite(value)) writer.WriteNumberValue(value);
            else writer.WriteNullValue();
        }
    }

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
