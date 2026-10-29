namespace OsuLocalProfiles.Tests;

/// <summary>
/// The JavaScript conversions the port depends on, each checked against what Node answers
/// (values written down from <c>node -e</c>).
/// </summary>
public class JsTests
{
    private static double N(object? value) => Js.ToNumber(value is Undefined ? null : JsonText.From(value));

    private sealed class Undefined;

    [Fact]
    public void Number_reads_text_as_JavaScript_does()
    {
        Assert.Equal(0, N(""));
        Assert.Equal(0, N("   "));
        Assert.Equal(12, N(" 12 "));
        Assert.Equal(16, N("0x10"));
        Assert.Equal(8, N("0o10"));
        Assert.Equal(2, N("0b10"));
        Assert.Equal(1000, N("1e3"));
        Assert.Equal(0.5, N(".5"));
        Assert.Equal(1, N("1."));
        Assert.Equal(double.PositiveInfinity, N("Infinity"));
        Assert.Equal(double.NegativeInfinity, N("-Infinity"));
        Assert.True(double.IsNaN(N("-0x10")));
        Assert.True(double.IsNaN(N("12px")));
        Assert.True(double.IsNaN(N("infinity")));
        Assert.True(double.IsNaN(N("1_000")));
    }

    [Fact]
    public void Number_reads_other_values_as_JavaScript_does()
    {
        Assert.True(double.IsNaN(N(new Undefined())));
        Assert.Equal(0, N(null));
        Assert.Equal(1, N(true));
        Assert.Equal(0, N(false));
        Assert.Equal(0, N(Array.Empty<int>()));
        Assert.Equal(5, N(new[] { 5 }));
        Assert.Equal(7, N(new[] { "7" }));
        Assert.True(double.IsNaN(N(new[] { 1, 2 })));
        Assert.True(double.IsNaN(N(new { a = 1 })));
    }

    [Fact]
    public void Math_round_takes_halves_up()
    {
        Assert.Equal(3, Js.Round(2.5));
        Assert.Equal(-2, Js.Round(-2.5));
        Assert.Equal(1, Js.Round(0.5));
        Assert.Equal(0, Js.Round(0.49999999999999994));
        Assert.Equal(2, Js.Round(1.5));
    }

    [Fact]
    public void Trim_strips_what_JavaScript_strips()
    {
        var bom = ((char)0xFEFF).ToString();
        var nbsp = ((char)0x00A0).ToString();
        var nel = ((char)0x0085).ToString();
        Assert.Equal("a", Js.Trim(bom + " \t\na" + nbsp));
        // U+0085 is whitespace to .NET but not to JavaScript.
        Assert.Equal(nel + "a", Js.Trim(nel + "a"));
    }

    [Fact]
    public void Case_follows_JavaScripts_full_mapping_where_it_differs()
    {
        Assert.Equal("SS", Js.ToUpper(((char)0xDF).ToString()));
        Assert.Equal("ABC", Js.ToUpper("abc"));
        var capitalI = ((char)0x0130).ToString();
        Assert.Equal("i" + (char)0x0307, Js.ToLower(capitalI));
        var sigma = (char)0x03A3;
        // A capital sigma ending a word lowers to the final form, elsewhere to the medial one.
        Assert.Equal("" + (char)0x03B1 + (char)0x03C2, Js.ToLower("" + (char)0x0391 + sigma));
        Assert.Equal("" + (char)0x03C3 + (char)0x03B1, Js.ToLower("" + sigma + (char)0x0391));
        Assert.Equal("" + (char)0x03C3, Js.ToLower("" + sigma));
    }

    [Fact]
    public void Date_parse_reads_ISO_dates_as_the_spec_does()
    {
        Assert.Equal(1577836800000, Js.DateParse("2020-01-01T00:00:00.000Z"));
        Assert.Equal(1577836800000, Js.DateParse("2020-01-01"));
        Assert.Equal(1577836800000, Js.DateParse("2020-01"));
        Assert.Equal(1577836800000 - 3600000, Js.DateParse("2020-01-01T00:00+01:00"));
        Assert.Equal(1577836800123, Js.DateParse("2020-01-01T00:00:00.1239Z"));
        // A date and time with no offset is local time.
        var local = new DateTimeOffset(new DateTime(2020, 6, 1, 12, 0, 0), TimeZoneInfo.Local.GetUtcOffset(new DateTime(2020, 6, 1, 12, 0, 0)));
        Assert.Equal(local.ToUnixTimeMilliseconds(), Js.DateParse("2020-06-01T12:00"));
        Assert.True(double.IsNaN(Js.DateParse("2020-13-01")));
        Assert.True(double.IsNaN(Js.DateParse("not a date")));
    }

    [Fact]
    public void A_file_time_reads_as_Nodes_mtimeMs_to_the_last_digit()
    {
        // osu!'s development online.db on the owner's machine: dividing the ticks at once gives .8003.
        Assert.Equal("1790501699477.8005", Js.NumberToString(Js.MtimeMs(DateTime.UnixEpoch.AddTicks(17905016994778005))));
        Assert.Equal("1791161260162.3623", Js.NumberToString(Js.MtimeMs(DateTime.UnixEpoch.AddTicks(17911612601623623))));
        Assert.Equal("0", Js.NumberToString(Js.MtimeMs(DateTime.UnixEpoch)));
    }
}
