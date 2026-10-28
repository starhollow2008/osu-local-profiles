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
        Converters = { new FiniteOrNull(), new AsJavaScript() },
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
            if (double.IsFinite(value)) writer.WriteRawValue(Js.NumberToString(value), skipInputValidation: true);
            else writer.WriteNullValue();
        }
    }

    /// <summary>
    /// Parsed JSON written back out as <c>JSON.stringify(JSON.parse(text))</c> would: numbers in
    /// JavaScript's shortest form (lazer writes <c>4.0</c>, JavaScript <c>4</c>), a repeated key
    /// once with its last value, and integer keys first, as a JavaScript object orders them.
    /// </summary>
    private sealed class AsJavaScript : JsonConverter<JsonElement>
    {
        public override JsonElement Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            using var doc = JsonDocument.ParseValue(ref reader);
            return doc.RootElement.Clone();
        }

        public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Object:
                    writer.WriteStartObject();
                    foreach (var (key, item) in Js.Entries(value))
                    {
                        writer.WritePropertyName(key);
                        Write(writer, item, options);
                    }
                    writer.WriteEndObject();
                    break;
                case JsonValueKind.Array:
                    writer.WriteStartArray();
                    foreach (var item in value.EnumerateArray()) Write(writer, item, options);
                    writer.WriteEndArray();
                    break;
                case JsonValueKind.Number:
                    var n = Js.NumberOf(value);
                    if (double.IsFinite(n)) writer.WriteRawValue(Js.NumberToString(n), skipInputValidation: true);
                    else writer.WriteNullValue();
                    break;
                case JsonValueKind.String:
                    writer.WriteStringValue(value.GetString());
                    break;
                case JsonValueKind.True or JsonValueKind.False:
                    writer.WriteBooleanValue(value.ValueKind == JsonValueKind.True);
                    break;
                default:
                    writer.WriteNullValue();
                    break;
            }
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
