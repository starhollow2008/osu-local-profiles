using Microsoft.Data.Sqlite;

namespace OsuLocalProfiles.Db;

/// <summary>
/// One row as node:sqlite hands it to the TypeScript: columns by name, each a <c>long</c>,
/// <c>double</c>, <c>string</c>, <c>byte[]</c> or null. The accessors read a value the way the
/// TypeScript's casts and comparisons did, so a ported function answers the same.
/// </summary>
internal sealed class Row
{
    private readonly Dictionary<string, object?> values;

    private Row(Dictionary<string, object?> values) => this.values = values;

    public static Row From(SqliteDataReader reader)
    {
        var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++)
        {
            // A later column of the same name wins, as it does in a JavaScript object.
            values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        return new Row(values);
    }

    /// <summary>The value as stored, for passing straight through to JSON: <c>r['x']</c>.</summary>
    public object? this[string column] => values.TryGetValue(column, out var value) ? value : null;

    public bool Has(string column) => values.ContainsKey(column);

    /// <summary>A number, or null for NULL or text.</summary>
    public double? Num(string column) => this[column] switch
    {
        long l => l,
        double d => d,
        _ => null,
    };

    /// <summary>A whole number, or null. A REAL holding a whole number reads as one, as in JavaScript.</summary>
    public long? Long(string column) => this[column] switch
    {
        long l => l,
        double d when d == Math.Floor(d) && double.IsFinite(d) => (long)d,
        _ => null,
    };

    /// <summary>Text, or null for NULL or a number.</summary>
    public string? Str(string column) => this[column] as string;

    /// <summary><c>r[column] === 1</c>: SQLite's true, whatever affinity carried it.</summary>
    public bool Is1(string column) => Num(column) == 1;

    /// <summary><c>String(r[column])</c>.</summary>
    public string Text(string column) => this[column] switch
    {
        null => "null",
        string s => s,
        long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
        double d => Js.NumberToString(d),
        _ => this[column]!.ToString()!,
    };
}
