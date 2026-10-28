using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Export;

/// <summary>
/// One table as a <c>.csv</c> a spreadsheet opens with a double-click: src/export/csv.ts. A UTF-8
/// byte order mark for Excel, CRLF between rows, dates as local <c>2026-09-27 14:37:05</c>, and text
/// a spreadsheet would run as a formula written with a leading apostrophe.
/// </summary>
internal static partial class Csv
{
    [GeneratedRegex("^[=+\\-@\\t\\r]")]
    private static partial Regex Formula();

    [GeneratedRegex("[\",\\r\\n]")]
    private static partial Regex NeedsQuotes();

    /// <summary>A moment as local time, the way a spreadsheet parses a date and time.</summary>
    public static string LocalDateTime(double ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds((long)ms).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);

    private static string Field(object? cell)
    {
        if (cell is null) return "";
        if (cell is double number) return Js.NumberToString(number);
        var text = cell is string s ? s : LocalDateTime(((DateCell)cell).Ms);
        if (cell is string && Formula().IsMatch(text)) text = "'" + text;
        return NeedsQuotes().IsMatch(text) ? $"\"{text.Replace("\"", "\"\"")}\"" : text;
    }

    public static byte[] Write(Table table)
    {
        var lines = new List<string> { string.Join(",", table.Columns.Select(c => Field(c.Header))) };
        lines.AddRange(table.Rows.Select(row => string.Join(",", row.Select(Field))));
        return Encoding.UTF8.GetBytes((char)0xFEFF + string.Join("\r\n", lines) + "\r\n");
    }
}

/// <summary>
/// Tables as an <c>.xlsx</c> workbook, one sheet each, written by hand: src/export/xlsx.ts. Header
/// row bold and frozen, a filter on every column, widths, dates as dates, and text always as
/// text (<c>inlineStr</c>), never something a spreadsheet evaluates.
/// </summary>
internal static partial class Xlsx
{
    private const string Main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private const string Rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private const string PackageRel = "http://schemas.openxmlformats.org/package/2006/relationships";
    private const string Head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
    private const int PlainStyle = 0, HeaderStyle = 1, DateStyle = 2;

    /// <summary>Excel's own limit on one cell's text.</summary>
    private const int MaxCellText = 32_767;

    /// <summary>Text as XML may carry it: escaped, without the control characters and lone surrogates XML 1.0 forbids.</summary>
    public static string XmlText(string s)
    {
        var sb = new StringBuilder(s.Length);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (c is <= (char)0x08 or (char)0x0B or (char)0x0C || (c >= (char)0x0E && c <= (char)0x1F) || c is (char)0xFFFE or (char)0xFFFF) continue;
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                {
                    sb.Append(c).Append(s[++i]);
                }
                continue;
            }
            if (char.IsLowSurrogate(c)) continue;
            sb.Append(c switch { '&' => "&amp;", '<' => "&lt;", '>' => "&gt;", '"' => "&quot;", _ => c.ToString() });
        }
        return sb.ToString();
    }

    /// <summary>A column's letters: 0 is A, 25 is Z, 26 is AA.</summary>
    public static string ColumnName(int index)
    {
        var name = "";
        for (var n = index + 1; n > 0; n = (n - 1) / 26) name = (char)('A' + (n - 1) % 26) + name;
        return name;
    }

    /// <summary>A moment as a spreadsheet date: days since 1899-12-30, in local time.</summary>
    public static double SerialDate(double ms)
    {
        var offset = TimeZoneInfo.Local.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds((long)ms)).TotalMinutes;
        // getTimezoneOffset is whole minutes, west positive.
        var local = ms + Math.Round(offset) * 60_000;
        return local / 86_400_000 + 25_569;
    }

    [GeneratedRegex("[\\[\\]:*?/\\\\]")]
    private static partial Regex BadSheetChars();

    /// <summary>Sheet names as a workbook allows: at most 31 characters, none of <c>[]:*?/\</c>, none the same.</summary>
    public static List<string> SheetNames(IEnumerable<string> names)
    {
        var used = new HashSet<string>();
        var output = new List<string>();
        foreach (var raw in names)
        {
            var trimmed = Js.Slice(Js.Trim(BadSheetChars().Replace(raw, " ")), 31);
            var baseName = trimmed.Length > 0 ? trimmed : "Sheet";
            var name = baseName;
            for (var n = 2; used.Contains(Js.ToLower(name)); n++)
            {
                var suffix = n.ToString(CultureInfo.InvariantCulture);
                name = $"{Js.Slice(baseName, Math.Max(0, 31 - suffix.Length - 1))} {suffix}";
            }
            used.Add(Js.ToLower(name));
            output.Add(name);
        }
        return output;
    }

    private static string Cell(string reference, object? value, int style = PlainStyle) => value switch
    {
        null => "",
        double n => double.IsFinite(n) ? $"<c r=\"{reference}\"{(style != 0 ? $" s=\"{style}\"" : "")}><v>{Js.NumberToString(n)}</v></c>" : "",
        DateCell d => $"<c r=\"{reference}\" s=\"{DateStyle}\"><v>{Js.NumberToString(SerialDate(d.Ms))}</v></c>",
        string text => $"<c r=\"{reference}\" t=\"inlineStr\"{(style != 0 ? $" s=\"{style}\"" : "")}><is><t xml:space=\"preserve\">{XmlText(Js.Slice(text, MaxCellText))}</t></is></c>",
        _ => "",
    };

    private static string Worksheet(Table table, bool first)
    {
        var last = ColumnName(Math.Max(table.Columns.Count, 1) - 1);
        var sb = new StringBuilder();
        sb.Append("<row r=\"1\">");
        for (var i = 0; i < table.Columns.Count; i++) sb.Append(Cell($"{ColumnName(i)}1", table.Columns[i].Header, HeaderStyle));
        sb.Append("</row>");
        for (var r = 0; r < table.Rows.Count; r++)
        {
            sb.Append($"<row r=\"{r + 2}\">");
            for (var i = 0; i < table.Rows[r].Length; i++) sb.Append(Cell($"{ColumnName(i)}{r + 2}", table.Rows[r][i]));
            sb.Append("</row>");
        }
        var cols = string.Concat(table.Columns.Select((c, i) =>
            $"<col min=\"{i + 1}\" max=\"{i + 1}\" width=\"{Js.NumberToString(c.Width ?? 12)}\" customWidth=\"1\"/>"));
        var extent = $"A1:{last}{table.Rows.Count + 1}";
        return $"{Head}<worksheet xmlns=\"{Main}\" xmlns:r=\"{Rel}\">"
            + $"<dimension ref=\"{extent}\"/>"
            + $"<sheetViews><sheetView workbookViewId=\"0\"{(first ? " tabSelected=\"1\"" : "")}>"
            + "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>"
            + "<selection pane=\"bottomLeft\" activeCell=\"A2\" sqref=\"A2\"/></sheetView></sheetViews>"
            + "<sheetFormatPr defaultRowHeight=\"15\"/>"
            + (cols.Length > 0 ? $"<cols>{cols}</cols>" : "")
            + $"<sheetData>{sb}</sheetData>"
            + $"<autoFilter ref=\"{extent}\"/>"
            + "</worksheet>";
    }

    private const string Styles =
        Head + "<styleSheet xmlns=\"" + Main + "\">"
        + "<numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd hh:mm\"/></numFmts>"
        + "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>"
        + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>"
        + "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
        + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
        + "<cellXfs count=\"3\">"
        + "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
        + "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>"
        + "<xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>"
        + "</cellXfs>"
        + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>"
        + "</styleSheet>";

    public static byte[] Write(IReadOnlyList<Table> tables, DateTime at)
    {
        var names = SheetNames(tables.Select(t => t.Name));
        var sheets = tables.Select((t, i) => ($"xl/worksheets/sheet{i + 1}.xml", Encoding.UTF8.GetBytes(Worksheet(t, i == 0)))).ToList();

        var contentTypes = Head + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
            + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
            + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
            + string.Concat(sheets.Select((_, i) => $"<Override PartName=\"/xl/worksheets/sheet{i + 1}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"))
            + "</Types>";

        var rootRels = Head + $"<Relationships xmlns=\"{PackageRel}\">"
            + $"<Relationship Id=\"rId1\" Type=\"{Rel}/officeDocument\" Target=\"xl/workbook.xml\"/>"
            + "</Relationships>";

        // The filter each sheet has, named as Excel names it, so Excel treats it as the sheet's own.
        var filters = string.Concat(tables.Select((t, i) =>
        {
            var range = $"$A$1:${ColumnName(Math.Max(t.Columns.Count, 1) - 1)}${t.Rows.Count + 1}";
            return $"<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"{i}\" hidden=\"1\">'{XmlText(names[i].Replace("'", "''"))}'!{range}</definedName>";
        }));
        var workbook = Head + $"<workbook xmlns=\"{Main}\" xmlns:r=\"{Rel}\">"
            + "<bookViews><workbookView activeTab=\"0\"/></bookViews>"
            + $"<sheets>{string.Concat(names.Select((n, i) => $"<sheet name=\"{XmlText(n)}\" sheetId=\"{i + 1}\" r:id=\"rId{i + 1}\"/>"))}</sheets>"
            + $"<definedNames>{filters}</definedNames>"
            + "</workbook>";

        var workbookRels = Head + $"<Relationships xmlns=\"{PackageRel}\">"
            + string.Concat(sheets.Select((_, i) => $"<Relationship Id=\"rId{i + 1}\" Type=\"{Rel}/worksheet\" Target=\"worksheets/sheet{i + 1}.xml\"/>"))
            + $"<Relationship Id=\"rId{sheets.Count + 1}\" Type=\"{Rel}/styles\" Target=\"styles.xml\"/>"
            + "</Relationships>";

        var files = new List<(string, byte[])>
        {
            ("[Content_Types].xml", Encoding.UTF8.GetBytes(contentTypes)),
            ("_rels/.rels", Encoding.UTF8.GetBytes(rootRels)),
            ("xl/workbook.xml", Encoding.UTF8.GetBytes(workbook)),
            ("xl/_rels/workbook.xml.rels", Encoding.UTF8.GetBytes(workbookRels)),
            ("xl/styles.xml", Encoding.UTF8.GetBytes(Styles)),
        };
        files.AddRange(sheets);
        return Zip.Write(files, at);
    }
}
