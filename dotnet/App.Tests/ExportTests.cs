using System.Text;
using OsuLocalProfiles.Export;

namespace OsuLocalProfiles.Tests;

/// <summary>test/export.test.ts's rules for the writers, and JavaScript's number text they rely on.</summary>
public class ExportTests
{
    /// <summary>Each written down from Node: <c>String(x)</c>.</summary>
    [Theory]
    [InlineData(1.0, "1")]
    [InlineData(0.1, "0.1")]
    [InlineData(0.30000000000000004, "0.30000000000000004")]
    [InlineData(123.456, "123.456")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1e20, "100000000000000000000")]
    [InlineData(123456789012345680000.0, "123456789012345680000")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(1e-6, "0.000001")]
    [InlineData(0.000001234, "0.000001234")]
    [InlineData(5e-324, "5e-324")]
    [InlineData(1.7976931348623157e308, "1.7976931348623157e+308")]
    [InlineData(-0.5, "-0.5")]
    [InlineData(1234567890123456.0, "1234567890123456")]
    [InlineData(98.765, "98.765")]
    [InlineData(2.5e15, "2500000000000000")]
    [InlineData(1e-7, "1e-7")]
    [InlineData(100.0, "100")]
    [InlineData(0.001, "0.001")]
    [InlineData(-0.0, "0")]
    public void Numbers_are_written_as_JavaScript_writes_them(double value, string expected) =>
        Assert.Equal(expected, Js.NumberToString(value));

    [Fact]
    public void A_csv_guards_formulas_quotes_what_needs_it_and_opens_in_Excel()
    {
        var table = new Table("Scores", [new("Title"), new("pp")],
        [
            ["=HYPERLINK(\"x\")", 1.5],
            ["a, b", null],
            ["-5", -5.0],
            ["plain", 1e21],
        ]);
        var text = Encoding.UTF8.GetString(Csv.Write(table));
        Assert.Equal((char)0xFEFF, text[0]);
        Assert.Equal("Title,pp\r\n\"'=HYPERLINK(\"\"x\"\")\",1.5\r\n\"a, b\",\r\n'-5,-5\r\nplain,1e+21\r\n", text[1..]);
    }

    [Fact]
    public void Xml_text_is_escaped_and_loses_what_XML_cannot_carry()
    {
        var lone = ((char)0xD800).ToString();
        var pair = "" + (char)0xD83D + (char)0xDE00;
        Assert.Equal("a&amp;b&lt;c&gt;&quot;", Xlsx.XmlText("a&b<c>\""));
        Assert.Equal("ab" + pair, Xlsx.XmlText("a" + (char)0x01 + lone + "b" + (char)0xFFFE + pair));
        Assert.Equal("\t\n\r", Xlsx.XmlText("\t\n\r"));
    }

    [Fact]
    public void Columns_and_sheets_are_named_as_a_workbook_allows()
    {
        Assert.Equal(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"], new[] { 0, 25, 26, 51, 52, 701, 702 }.Select(Xlsx.ColumnName));
        Assert.Equal(["Scores", "scores 2", "a b c", "Sheet", new string('x', 31), new string('x', 29) + " 2"],
            Xlsx.SheetNames(["Scores", "scores", "a[b]c", "  ", new string('x', 40), new string('x', 31)]));
    }

    [Fact]
    public void A_workbook_is_a_zip_that_reads_back()
    {
        var bytes = Xlsx.Write([new Table("One", [new("A", 5)], [["x", 1.0, new DateCell(0)]])], new DateTime(2026, 10, 28, 12, 0, 0));
        using var zip = new System.IO.Compression.ZipArchive(new MemoryStream(bytes));
        Assert.Equal(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"],
            zip.Entries.Select(e => e.FullName));
        using var sheet = new StreamReader(zip.GetEntry("xl/worksheets/sheet1.xml")!.Open());
        var xml = sheet.ReadToEnd();
        Assert.Contains("<c r=\"A2\" t=\"inlineStr\"><is><t xml:space=\"preserve\">x</t></is></c><c r=\"B2\"><v>1</v></c>", xml);
        Assert.Contains("<col min=\"1\" max=\"1\" width=\"5\" customWidth=\"1\"/>", xml);
        Assert.Equal(0xCBF43926u, Zip.Crc32("123456789"u8));
    }
}
