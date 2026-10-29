using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace OsuLocalProfiles.Db;

/// <summary>
/// The profile database: src/db/index.ts. Same file, same schema (src/db/schema.sql, embedded),
/// same migrations, so either app can open what the other wrote.
/// </summary>
/// <remarks>
/// SQL is written as in the TypeScript, with <c>?</c> placeholders, so a query can be compared
/// with the one it was ported from. Microsoft.Data.Sqlite binds by name, so each <c>?</c> is
/// renamed <c>$p1</c>, <c>$p2</c>, ... once per statement text.
/// </remarks>
internal sealed partial class Database : IDisposable
{
    private readonly SqliteConnection connection;

    /// <summary>
    /// False while the port is unfinished, unless started with <c>--writable</c>: an app that is
    /// not done yet must not be able to damage real data (docs/csharp-port.md, rule 2). A
    /// read-only database is never migrated; the Node app has already done that.
    /// </summary>
    public bool Writable { get; }

    private Database(SqliteConnection connection, bool writable)
    {
        this.connection = connection;
        Writable = writable;
    }

    public static Database Open(string file, bool writable = true)
    {
        if (writable) Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))!);
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = file,
            Mode = writable ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadOnly,
            // Closed means closed: a backup, a restore and the tests all need the file let go.
            Pooling = false,
        };
        var connection = new SqliteConnection(builder.ToString());
        connection.Open();
        var db = new Database(connection, writable);
        if (writable)
        {
            db.Exec(Schema.Value);
            db.Migrate();
        }
        return db;
    }

    /// <summary>A database owned by an osu! client: read-only, and null when it cannot be opened.</summary>
    public static Database? OpenReadOnly(string file)
    {
        try
        {
            return File.Exists(file) ? Open(file, writable: false) : null;
        }
        catch (SqliteException)
        {
            return null;
        }
    }

    private static readonly Lazy<string> Schema = new(() =>
    {
        using var stream = typeof(Database).Assembly.GetManifestResourceStream("schema.sql")
            ?? throw new InvalidOperationException("schema.sql is not embedded");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    });

    public void Dispose() => connection.Dispose();

    /* ------------------------------------------------------------ statements */

    private static readonly ConcurrentDictionary<string, string> Named = new();

    /// <summary>Each <c>?</c> outside a quoted string or a comment becomes <c>$pN</c>.</summary>
    internal static string NamePlaceholders(string sql) => Named.GetOrAdd(sql, static text =>
    {
        var sb = new StringBuilder(text.Length + 16);
        var n = 0;
        char quote = '\0';
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quote != '\0')
            {
                sb.Append(c);
                if (c == quote) quote = '\0';
            }
            else if (c is '\'' or '"')
            {
                quote = c;
                sb.Append(c);
            }
            else if (c == '-' && i + 1 < text.Length && text[i + 1] == '-')
            {
                var end = text.IndexOf('\n', i);
                if (end < 0) end = text.Length;
                sb.Append(text, i, end - i);
                i = end - 1;
            }
            else if (c == '?')
            {
                sb.Append("$p").Append(++n);
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    });

    private SqliteCommand Command(string sql, object?[] args)
    {
        var command = connection.CreateCommand();
        command.CommandText = NamePlaceholders(sql);
        for (var i = 0; i < args.Length; i++)
        {
            // NaN is bound as NULL, which is what SQLite makes of it and so what node:sqlite binds:
            // `WHERE id = ?` with Number('x') finds nothing rather than failing.
            command.Parameters.AddWithValue($"$p{i + 1}", args[i] is null or double.NaN ? DBNull.Value : args[i]);
        }
        return command;
    }

    /*
     * One user of the connection at a time. The Node app had one thread, so its database never saw
     * two statements at once; here requests, the tracker and the beatmap index run on different
     * threads, and a SQLite connection must not be used by two of them together. Every method takes
     * this lock, a transaction holds it for its whole body, and `Serialized` holds it across several
     * statements that must not have another's between them -- what one synchronous TypeScript
     * function got for free. It is re-entrant, so a method may call another.
     */
    private readonly object gate = new();

    /// <summary>Several statements with nobody else's between them.</summary>
    public T Serialized<T>(Func<T> body)
    {
        lock (gate) return body();
    }

    public void Serialized(Action body)
    {
        lock (gate) body();
    }

    /// <summary>
    /// The connection held until disposed, for work done in slices: everything between one pause
    /// and the next, an open transaction included, with nobody else's statements in it.
    /// </summary>
    public IDisposable Hold()
    {
        Monitor.Enter(gate);
        return new Held(gate);
    }

    private sealed class Held(object gate) : IDisposable
    {
        private bool released;

        public void Dispose()
        {
            if (released) return;
            released = true;
            Monitor.Exit(gate);
        }
    }

    /// <summary><c>db.exec</c>: one or more statements, no parameters.</summary>
    public void Exec(string sql)
    {
        lock (gate)
        {
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.ExecuteNonQuery();
        }
    }

    /// <summary><c>prepare(sql).run(...)</c>: the number of rows changed.</summary>
    public int Run(string sql, params object?[] args)
    {
        lock (gate)
        {
            using var command = Command(sql, args);
            return command.ExecuteNonQuery();
        }
    }

    /// <summary><c>prepare(sql).get(...)</c>, mapped; default when there is no row.</summary>
    public T? Get<T>(string sql, Func<SqliteDataReader, T> map, params object?[] args)
    {
        lock (gate)
        {
            using var command = Command(sql, args);
            using var reader = command.ExecuteReader();
            return reader.Read() ? map(reader) : default;
        }
    }

    /// <summary>Whether <c>prepare(sql).get(...)</c> finds a row.</summary>
    public bool Exists(string sql, params object?[] args)
    {
        lock (gate)
        {
            using var command = Command(sql, args);
            using var reader = command.ExecuteReader();
            return reader.Read();
        }
    }

    /// <summary><c>prepare(sql).all(...)</c>, mapped.</summary>
    public List<T> All<T>(string sql, Func<SqliteDataReader, T> map, params object?[] args)
    {
        lock (gate)
        {
            using var command = Command(sql, args);
            using var reader = command.ExecuteReader();
            var rows = new List<T>();
            while (reader.Read()) rows.Add(map(reader));
            return rows;
        }
    }

    /// <summary>
    /// <c>prepare(sql).all(...)</c> as node:sqlite returns it: each row's columns by name, as
    /// <c>long</c>, <c>double</c>, <c>string</c>, <c>byte[]</c> or null. For code ported from
    /// TypeScript that reads columns loosely, so it reads them the same way.
    /// </summary>
    public List<Row> Rows(string sql, params object?[] args) => All(sql, Row.From, args);

    /// <summary><c>prepare(sql).get(...)</c> in the same shape, or null when there is no row.</summary>
    public Row? FirstRow(string sql, params object?[] args) => Get(sql, Row.From, args);

    /// <summary>The first column of the first row, or null.</summary>
    public object? Scalar(string sql, params object?[] args)
    {
        lock (gate)
        {
            using var command = Command(sql, args);
            var value = command.ExecuteScalar();
            return value is DBNull ? null : value;
        }
    }

    /// <summary><c>BEGIN</c> ... <c>COMMIT</c>, rolled back if anything throws, as the TypeScript writes it out.</summary>
    public void Transaction(Action body)
    {
        lock (gate)
        {
            Exec("BEGIN");
            try
            {
                body();
                Exec("COMMIT");
            }
            catch
            {
                Exec("ROLLBACK");
                throw;
            }
        }
    }

    /* ------------------------------------------------------------- migrations */

    /// <summary>
    /// schema.sql only uses CREATE TABLE IF NOT EXISTS, so columns added later never reach an
    /// existing database. Each entry is applied once if its column is missing. The reasons for
    /// each are beside ADDED_COLUMNS in src/db/index.ts; this list must match it exactly.
    /// </summary>
    private static readonly (string Table, string Column, string Definition)[] AddedColumns =
    [
        ("scores", "max_statistics_json", "TEXT"),
        ("scores", "replay_path", "TEXT"),
        ("scores", "pp_nomod", "REAL"),
        ("scores", "stars_nomod", "REAL"),
        ("scores", "beatmap_max_combo", "INTEGER"),
        ("scores", "map_status", "INTEGER"),
        ("scores", "mods_ranked", "INTEGER"),
        ("scores", "mods_countable", "INTEGER"),
        ("scores", "hidden_at", "INTEGER"),
        ("scores", "pinned_at", "INTEGER"),
        ("scores", "pin_order", "INTEGER"),
        ("beatmaps", "length_ms", "INTEGER"),
        ("incomplete_plays", "started_at", "INTEGER"),
        ("osu_files", "beatmap_id", "INTEGER"),
        ("scores", "score_standard", "INTEGER"),
        ("scores", "score_classic", "INTEGER"),
        ("scores", "pp_parts", "TEXT"),
        ("scores", "pp_nomod_parts", "TEXT"),
        ("scores", "pp_version", "TEXT"),
        ("beatmaps", "added_at", "INTEGER"),
        ("beatmaps", "submitted_at", "INTEGER"),
        ("beatmaps", "ranked_at", "INTEGER"),
        ("beatmaps", "tags", "TEXT"),
        ("beatmaps", "source", "TEXT"),
        ("osu_files", "name", "TEXT"),
        ("incomplete_plays", "unsubmitted", "INTEGER NOT NULL DEFAULT 0"),
        ("scores", "mods_ranked_by", "TEXT"),
        ("scores", "legacy_score_id", "TEXT"),
        ("scores", "imported_at", "INTEGER"),
        ("scores", "player_name", "TEXT"),
        ("scores", "player_id", "INTEGER"),
        ("beatmaps", "artist_unicode", "TEXT"),
        ("beatmaps", "title_unicode", "TEXT"),
        ("scores", "origin", "TEXT"),
    ];

    /// <summary>Tables earlier versions created and nothing reads (see RETIRED_TABLES).</summary>
    private static readonly string[] RetiredTables = ["snapshots"];

    private void Migrate()
    {
        foreach (var table in RetiredTables) Exec($"DROP TABLE IF EXISTS {table}");
        foreach (var (table, column, definition) in AddedColumns)
        {
            var columns = All($"PRAGMA table_info({table})", r => r.GetString(r.GetOrdinal("name")));
            if (columns.Count == 0) continue; // table not created yet
            if (columns.Contains(column)) continue;
            Exec($"ALTER TABLE {table} ADD COLUMN {column} {definition}");
        }
        Exec("CREATE INDEX IF NOT EXISTS osu_files_beatmap_id ON osu_files (beatmap_id)");
        // Here rather than in schema.sql: on an existing database the column does not exist until
        // the loop above has added it, and schema.sql runs first.
        Exec("CREATE INDEX IF NOT EXISTS osu_files_name ON osu_files (name)");
        RebuildNotBeatmaps();
        PinCountingDefaults();
        PinRelaxPricing();
        PinSectionOrder();
    }

    /// <summary>Past this much free space inside the file, a rebuild gives it back to the disk.</summary>
    private const long ReclaimBytes = 32 * 1024 * 1024;

    [GeneratedRegex(@"WITHOUT\s+ROWID", RegexOptions.IgnoreCase)]
    private static partial Regex WithoutRowid();

    /// <summary>
    /// <c>not_beatmaps</c> as a WITHOUT ROWID table, rebuilt once from the ordinary one earlier
    /// versions made: it halves the index for a large lazer library (rebuildNotBeatmaps).
    /// </summary>
    private void RebuildNotBeatmaps()
    {
        var sql = Get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'not_beatmaps'", r => r.GetString(0));
        if (sql is null || WithoutRowid().IsMatch(sql)) return;

        Transaction(() => Exec("""
            CREATE TABLE not_beatmaps_rebuilt (path TEXT PRIMARY KEY, size INTEGER NOT NULL) WITHOUT ROWID;
            INSERT INTO not_beatmaps_rebuilt (path, size) SELECT path, size FROM not_beatmaps ORDER BY path;
            DROP TABLE not_beatmaps;
            ALTER TABLE not_beatmaps_rebuilt RENAME TO not_beatmaps;
            """));

        // Once, and only when worth rewriting the file for. Another process holding the database
        // makes VACUUM fail, which is harmless: the space is reused as the index grows.
        var free = Convert.ToInt64(Scalar("PRAGMA freelist_count"));
        var page = Convert.ToInt64(Scalar("PRAGMA page_size"));
        if (free * page < ReclaimBytes) return;
        try
        {
            Exec("VACUUM");
        }
        catch (SqliteException)
        {
            /* see above */
        }
    }

    private const string CountingPinned = "countingDefaultsPinned";

    /// <summary>
    /// Existing profiles keep counting what they counted when unranked mods and every beatmap
    /// status became the default (roadmap 5.59): their old defaults are written down once.
    /// </summary>
    private void PinCountingDefaults()
    {
        if (Exists("SELECT 1 AS hit FROM kv WHERE key = ?", CountingPinned)) return;
        Transaction(() =>
        {
            const string pin = "INSERT OR IGNORE INTO profile_settings (profile_id, key, value) SELECT id, ?, ? FROM profiles";
            Run(pin, "includeUnrankedMods", "false");
            Run(pin, "includeUnrankedMaps", "[]");
            Run("INSERT INTO kv (key, value) VALUES (?, ?)", CountingPinned, Js.Now().ToString());
        });
    }

    private const string RelaxPricingPinned = "relaxPricingPinned";

    /// <summary>Existing profiles keep pricing Relax and Autopilot "as if the mod were off".</summary>
    private void PinRelaxPricing()
    {
        if (Exists("SELECT 1 AS hit FROM kv WHERE key = ?", RelaxPricingPinned)) return;
        Transaction(() =>
        {
            Run("INSERT OR IGNORE INTO profile_settings (profile_id, key, value) SELECT id, ?, ? FROM profiles",
                "unrankedModPp", JsonText.Stringify("without-the-mod"));
            Run("INSERT INTO kv (key, value) VALUES (?, ?)", RelaxPricingPinned, Js.Now().ToString());
        });
    }

    private const string SectionOrderPinned = "sectionOrderPinned";

    /// <summary>The profile page's default order from 1.10.0 until 1.31.0 moved Recent up (roadmap 5.80).</summary>
    private static readonly string[] OrderUntil131 = ["me", "recent_plays", "top_ranks", "historical", "recent", "beatmaps", "medals"];

    /// <summary>Earlier defaults, which the page read as never arranged.</summary>
    private static readonly string[][] DefaultsBefore110 =
    [
        ["me", "recent", "top_ranks", "medals", "historical"],
        ["me", "recent", "top_ranks", "historical", "beatmaps", "medals"],
    ];

    /// <summary>A saved order as the page showed it before 1.31.0 (orderAsShownUntil131).</summary>
    internal static List<string> OrderAsShownUntil131(JsonElement? saved)
    {
        var list = Js.IsArray(saved)
            ? saved!.Value.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList()
            : [];
        if (DefaultsBefore110.Any(old => old.SequenceEqual(list))) return [.. OrderUntil131];
        var output = new List<string>();
        foreach (var id in list)
        {
            if (OrderUntil131.Contains(id) && !output.Contains(id)) output.Add(id);
        }
        for (var index = 0; index < OrderUntil131.Length; index++)
        {
            var id = OrderUntil131[index];
            if (output.Contains(id)) continue;
            var before = OrderUntil131.Take(index).Reverse().FirstOrDefault(output.Contains);
            output.Insert(before is null ? 0 : output.IndexOf(before) + 1, id);
        }
        return output;
    }

    /// <summary>
    /// Existing profiles keep their page as it was when 1.31.0 changed the default order: the
    /// order as the page showed it is written down whole, once.
    /// </summary>
    private void PinSectionOrder()
    {
        if (Exists("SELECT 1 AS hit FROM kv WHERE key = ?", SectionOrderPinned)) return;
        Transaction(() =>
        {
            foreach (var id in All("SELECT id FROM profiles", r => r.GetInt64(0)))
            {
                var stored = Get("SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'sectionOrder'",
                    r => r.GetString(0), id);
                JsonElement? saved = null;
                if (stored is not null && JsonText.TryParse(stored, out var parsed)) saved = parsed;
                // Unreadable reads as nothing saved, as the settings themselves read it.
                Run("""
                    INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sectionOrder', ?)
                      ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value
                    """, id, JsonText.Stringify(OrderAsShownUntil131(saved)));
            }
            Run("INSERT INTO kv (key, value) VALUES (?, ?)", SectionOrderPinned, Js.Now().ToString());
        });
    }

    /* --------------------------------------------------------------- profiles */

    /// <summary>getOrCreateProfile: the profile with this exact name, made now if there is none.</summary>
    public long GetOrCreateProfile(string name)
    {
        var existing = Get("SELECT id FROM profiles WHERE name = ?", r => (long?)r.GetInt64(0), name);
        if (existing is not null) return existing.Value;

        var now = Js.Now();
        Run("INSERT INTO profiles (name, created_at, tracking_since, default_mode) VALUES (?, ?, ?, 0)", name, now, now);
        return Get("SELECT id FROM profiles WHERE name = ?", r => r.GetInt64(0), name);
    }

    /// <summary><c>SELECT total_changes()</c> and <c>PRAGMA data_version</c>: what the page cache is stamped with.</summary>
    public string DataVersion()
    {
        var changes = Convert.ToInt64(Scalar("SELECT total_changes() AS n"));
        var version = Convert.ToInt64(Scalar("PRAGMA data_version"));
        return $"{changes}:{version}";
    }
}

/// <summary>Reading columns by name, null where the row has NULL.</summary>
internal static class RowExtensions
{
    public static long Long(this SqliteDataReader r, string column) => r.GetInt64(r.GetOrdinal(column));

    public static long? LongOrNull(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetInt64(i);
    }

    public static string Text(this SqliteDataReader r, string column) => r.GetString(r.GetOrdinal(column));

    public static string? TextOrNull(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetString(i);
    }

    public static double? RealOrNull(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetDouble(i);
    }
}
