using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles;

/// <summary>
/// JavaScript's semantics, where the app's answers depend on them (docs/csharp-port.md,
/// "JavaScript in C#"). The Node app cleaned whatever arrived from the page or a stored row
/// with JavaScript's own conversions, so the port has to convert exactly the same way.
/// </summary>
/// <remarks>
/// A value from the page or a stored setting is a <see cref="JsonElement"/>; a null
/// <c>JsonElement?</c> stands for <c>undefined</c> (a key that is not there), which JavaScript
/// keeps apart from JSON's <c>null</c>.
/// </remarks>
internal static partial class Js
{
    /* ------------------------------------------------------------------ values */

    /// <summary>A property of an object, or undefined when it has none or is not an object.</summary>
    /// <remarks>A key written twice reads as its last value, as <c>JSON.parse</c> keeps it.</remarks>
    public static JsonElement? Get(JsonElement? value, string key) =>
        value is { ValueKind: JsonValueKind.Object } obj && obj.TryGetProperty(key, out var found) ? found : null;

    /// <summary><c>typeof raw === 'object' &amp;&amp; raw !== null &amp;&amp; !Array.isArray(raw)</c>.</summary>
    public static bool IsRecord(JsonElement? value) => value is { ValueKind: JsonValueKind.Object };

    public static bool IsArray(JsonElement? value) => value is { ValueKind: JsonValueKind.Array };

    /// <summary><c>typeof raw === 'string'</c>.</summary>
    public static bool IsString(JsonElement? value, out string text)
    {
        if (value is { ValueKind: JsonValueKind.String } s)
        {
            text = s.GetString()!;
            return true;
        }
        text = "";
        return false;
    }

    /// <summary>A JSON number, as JavaScript reads it: too large is Infinity, never an error.</summary>
    public static double NumberOf(JsonElement number) =>
        number.TryGetDouble(out var d) ? d : double.Parse(number.GetRawText(), NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary><c>raw === true || raw === 'true' || raw === 1 || raw === '1'</c>: checkboxes post strings.</summary>
    public static bool IsTrue(JsonElement? value) => value switch
    {
        { ValueKind: JsonValueKind.True } => true,
        { ValueKind: JsonValueKind.String } s => s.GetString() is "true" or "1",
        { ValueKind: JsonValueKind.Number } n => NumberOf(n) == 1,
        _ => false,
    };

    /// <summary><c>!(raw === false || raw === 'false' || raw === 0 || raw === '0')</c>: on unless explicitly off.</summary>
    public static bool NotFalse(JsonElement? value) => !(value switch
    {
        { ValueKind: JsonValueKind.False } => true,
        { ValueKind: JsonValueKind.String } s => s.GetString() is "false" or "0",
        { ValueKind: JsonValueKind.Number } n => NumberOf(n) == 0,
        _ => false,
    });

    /// <summary>
    /// <c>if (raw)</c>: false for undefined, null, false, 0, NaN and the empty string; true for
    /// everything else, every object and array included.
    /// </summary>
    public static bool Truthy(JsonElement? value) => value switch
    {
        null => false,
        { ValueKind: JsonValueKind.Null or JsonValueKind.False or JsonValueKind.Undefined } => false,
        { ValueKind: JsonValueKind.Number } n => NumberOf(n) is var d && d != 0 && !double.IsNaN(d),
        { ValueKind: JsonValueKind.String } s => s.GetString()!.Length > 0,
        _ => true,
    };

    /// <summary><c>Number(raw)</c>. Undefined is NaN, null is 0, an object NaN, an array its joined text.</summary>
    public static double ToNumber(JsonElement? value) => value switch
    {
        null => double.NaN,
        { ValueKind: JsonValueKind.Null } => 0,
        { ValueKind: JsonValueKind.True } => 1,
        { ValueKind: JsonValueKind.False } => 0,
        { ValueKind: JsonValueKind.Number } n => NumberOf(n),
        { ValueKind: JsonValueKind.String } s => StringToNumber(s.GetString()!),
        { ValueKind: JsonValueKind.Array } a => StringToNumber(ArrayToString(a)),
        _ => double.NaN,
    };

    /// <summary><c>String(raw)</c> for the shapes the port needs it for.</summary>
    public static string ToJsString(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString()!,
        JsonValueKind.Number => NumberToString(NumberOf(value)),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => "null",
        JsonValueKind.Array => ArrayToString(value),
        _ => "[object Object]",
    };

    /// <summary><c>Array.prototype.join(',')</c>, which is what an array becomes as text.</summary>
    private static string ArrayToString(JsonElement array) =>
        string.Join(",", array.EnumerateArray().Select(item =>
            item.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? "" : ToJsString(item)));

    /// <summary>
    /// Text for a number that reads back as the same number. Not JavaScript's exact format past
    /// 1e15, where .NET switches to an exponent sooner; it is only ever parsed again here.
    /// </summary>
    public static string NumberToString(double n) =>
        double.IsNaN(n) ? "NaN"
        : double.IsPositiveInfinity(n) ? "Infinity"
        : double.IsNegativeInfinity(n) ? "-Infinity"
        : n.ToString("R", CultureInfo.InvariantCulture);

    [GeneratedRegex(@"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\z")]
    private static partial Regex DecimalLiteral();

    /// <summary>StringToNumber from the spec: trimmed, empty is 0, hex/octal/binary unsigned, Infinity spelled out.</summary>
    public static double StringToNumber(string raw)
    {
        var s = Trim(raw);
        if (s.Length == 0) return 0;
        switch (s)
        {
            case "Infinity" or "+Infinity": return double.PositiveInfinity;
            case "-Infinity": return double.NegativeInfinity;
        }
        if (s.Length > 2 && s[0] == '0' && char.ToLowerInvariant(s[1]) is 'x' or 'o' or 'b')
        {
            var radix = char.ToLowerInvariant(s[1]) switch { 'x' => 16, 'o' => 8, _ => 2 };
            double total = 0;
            foreach (var c in s.AsSpan(2))
            {
                var digit = c switch
                {
                    >= '0' and <= '9' => c - '0',
                    >= 'a' and <= 'f' => c - 'a' + 10,
                    >= 'A' and <= 'F' => c - 'A' + 10,
                    _ => 99,
                };
                if (digit >= radix) return double.NaN;
                total = total * radix + digit;
            }
            return total;
        }
        if (!DecimalLiteral().IsMatch(s)) return double.NaN;
        return double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    /// <summary><c>Number.isFinite</c>.</summary>
    public static bool IsFinite(double n) => double.IsFinite(n);

    /* ------------------------------------------------------------------- maths */

    /// <summary><c>Math.round</c>: halves go up, toward +Infinity. <see cref="Math.Round(double)"/> rounds them to even.</summary>
    public static double Round(double x)
    {
        if (!double.IsFinite(x)) return x;
        var floor = Math.Floor(x);
        return x - floor >= 0.5 ? floor + 1 : floor;
    }

    /* ------------------------------------------------------------------- text */

    /// <summary>The characters <c>String.prototype.trim</c> removes: the spec's WhiteSpace and LineTerminator.</summary>
    public static bool IsSpace(char c) => c switch
    {
        (char)0x09 or (char)0x0A or (char)0x0B or (char)0x0C or (char)0x0D or (char)0x20 or (char)0x00A0 or (char)0x1680 or (char)0x2028 or (char)0x2029
            or (char)0x202F or (char)0x205F or (char)0x3000 or (char)0xFEFF => true,
        >= (char)0x2000 and <= (char)0x200A => true,
        _ => false,
    };

    /// <summary><c>String.prototype.trim</c>. .NET's <c>Trim()</c> strips a different set (it keeps U+FEFF).</summary>
    public static string Trim(string s)
    {
        int start = 0, end = s.Length;
        while (start < end && IsSpace(s[start])) start++;
        while (end > start && IsSpace(s[end - 1])) end--;
        return s[start..end];
    }

    /// <summary><c>s.slice(0, n)</c>, in UTF-16 units as JavaScript counts them.</summary>
    public static string Slice(string s, int length) => s.Length <= length ? s : s[..length];

    /// <summary>
    /// <c>toUpperCase()</c>. JavaScript applies Unicode's full mapping, so one character can become
    /// two: "ß" is "SS" there and "ß" in .NET. Those expansions are applied here; every other
    /// character takes the simple mapping both share.
    /// </summary>
    public static string ToUpper(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var rune in s.EnumerateRunes())
        {
            switch (rune.Value)
            {
                case 0x00DF: sb.Append("SS"); break;
                case 0x0149: sb.Append((char)0x02BC).Append('N'); break;
                case 0x01F0: sb.Append('J').Append((char)0x030C); break;
                case 0xFB00: sb.Append("FF"); break;
                case 0xFB01: sb.Append("FI"); break;
                case 0xFB02: sb.Append("FL"); break;
                case 0xFB03: sb.Append("FFI"); break;
                case 0xFB04: sb.Append("FFL"); break;
                case 0xFB05: case 0xFB06: sb.Append("ST"); break;
                default: sb.Append(Rune.ToUpperInvariant(rune).ToString()); break;
            }
        }
        return sb.ToString();
    }

    /// <summary>
    /// <c>toLowerCase()</c>: the simple mapping, plus the two cases where JavaScript's full mapping
    /// differs. "İ" becomes "i̇" (two characters), and a capital sigma ending a word becomes "ς".
    /// The word-end test approximates Unicode's Final_Sigma with letters and combining marks.
    /// </summary>
    public static string ToLower(string s)
    {
        var sb = new StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c == (char)0x0130) sb.Append('i').Append((char)0x0307);
            else if (c == (char)0x03A3) sb.Append(IsFinalSigma(s, i) ? (char)0x03C2 : (char)0x03C3);
            else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                sb.Append(Rune.ToLowerInvariant(new Rune(c, s[i + 1])).ToString());
                i++;
            }
            else sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    private static bool IsFinalSigma(string s, int at)
    {
        static bool Ignorable(char c) =>
            CharUnicodeInfo.GetUnicodeCategory(c) is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark
                or UnicodeCategory.Format or UnicodeCategory.ModifierLetter or UnicodeCategory.ModifierSymbol
            || c is (char)0x27 or '.' or ':' or (char)0x00B7 or (char)0x2019;
        var before = at - 1;
        while (before >= 0 && Ignorable(s[before])) before--;
        if (before < 0 || !char.IsLetter(s[before])) return false;
        var after = at + 1;
        while (after < s.Length && Ignorable(s[after])) after++;
        return after >= s.Length || !char.IsLetter(s[after]);
    }

    /* ------------------------------------------------------------------- dates */

    [GeneratedRegex(@"^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?\z")]
    private static partial Regex IsoDate();

    /// <summary>
    /// <c>Date.parse</c>, in epoch milliseconds or NaN. ISO 8601 as the spec defines it: a date alone
    /// is UTC, a date and time with no offset is local time. Anything else goes to .NET's parser,
    /// as JavaScript hands it to the engine's own; the two may differ there.
    /// </summary>
    public static double DateParse(string text)
    {
        var m = IsoDate().Match(text);
        if (m.Success)
        {
            var year = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            var month = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : 1;
            var day = m.Groups[3].Success ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) : 1;
            var hasTime = m.Groups[4].Success;
            var hour = hasTime ? int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture) : 0;
            var minute = hasTime ? int.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture) : 0;
            var second = m.Groups[6].Success ? int.Parse(m.Groups[6].Value, CultureInfo.InvariantCulture) : 0;
            var ms = m.Groups[7].Success ? int.Parse(m.Groups[7].Value.PadRight(3, '0')[..3], CultureInfo.InvariantCulture) : 0;
            if (year is < 1 or > 9999 || month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)
                || hour > 23 || minute > 59 || second > 59)
            {
                return double.NaN;
            }
            var local = new DateTime(year, month, day, hour, minute, second, ms, DateTimeKind.Unspecified);
            TimeSpan offset;
            if (m.Groups[8].Success)
            {
                offset = m.Groups[8].Value == "Z"
                    ? TimeSpan.Zero
                    : TimeSpan.ParseExact(m.Groups[8].Value[1..], @"hh\:mm", CultureInfo.InvariantCulture)
                        * (m.Groups[8].Value[0] == '-' ? -1 : 1);
            }
            else
            {
                offset = hasTime ? TimeZoneInfo.Local.GetUtcOffset(local) : TimeSpan.Zero;
            }
            return new DateTimeOffset(local, offset).ToUnixTimeMilliseconds();
        }
        return DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out var parsed)
            ? parsed.ToUnixTimeMilliseconds()
            : double.NaN;
    }

    /// <summary><c>Date.now()</c>.</summary>
    public static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
