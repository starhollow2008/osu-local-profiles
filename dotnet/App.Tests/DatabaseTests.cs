using Microsoft.Data.Sqlite;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tests;

/// <summary>Opening, migrating and binding: src/db/index.ts.</summary>
public class DatabaseTests
{
    private static List<string> Columns(Database db, string table) =>
        db.All($"PRAGMA table_info({table})", r => r.GetString(r.GetOrdinal("name")));

    [Fact]
    public void A_new_database_gets_the_schema_and_every_added_column()
    {
        using var h = new TempDb();
        var scores = Columns(h.Db, "scores");
        Assert.Contains("hidden_at", scores);
        Assert.Contains("origin", scores);
        Assert.Contains("unsubmitted", Columns(h.Db, "incomplete_plays"));
        Assert.Equal("wal", h.Db.Scalar("PRAGMA journal_mode"));
        Assert.Equal(1L, h.Db.Scalar("PRAGMA foreign_keys"));
    }

    [Fact]
    public void An_older_database_gains_the_columns_it_lacks_and_keeps_its_rows()
    {
        using var h = new TempDb();
        h.InsertScore(h.ProfileId, "a");
        h.Db.Exec("ALTER TABLE scores DROP COLUMN origin");
        h.Db.Exec("ALTER TABLE beatmaps DROP COLUMN title_unicode");
        Assert.DoesNotContain("origin", Columns(h.Db, "scores"));

        var db = h.Reopen();
        Assert.Contains("origin", Columns(db, "scores"));
        Assert.Contains("title_unicode", Columns(db, "beatmaps"));
        Assert.Equal(1L, db.Scalar("SELECT COUNT(*) FROM scores"));
    }

    [Fact]
    public void Retired_tables_are_dropped()
    {
        using var h = new TempDb();
        h.Db.Exec("CREATE TABLE snapshots (id INTEGER)");
        var db = h.Reopen();
        Assert.Null(db.Scalar("SELECT name FROM sqlite_master WHERE name = 'snapshots'"));
    }

    [Fact]
    public void The_old_not_beatmaps_table_is_rebuilt_without_rowid_keeping_its_rows()
    {
        using var h = new TempDb();
        h.Db.Exec("""
            DROP TABLE not_beatmaps;
            CREATE TABLE not_beatmaps (path TEXT PRIMARY KEY, size INTEGER NOT NULL);
            INSERT INTO not_beatmaps (path, size) VALUES ('a', 1), ('b', 2);
            """);
        var db = h.Reopen();
        Assert.Contains("WITHOUT ROWID", (string)db.Scalar("SELECT sql FROM sqlite_master WHERE name = 'not_beatmaps'")!);
        Assert.Equal(2L, db.Scalar("SELECT COUNT(*) FROM not_beatmaps"));
    }

    [Fact]
    public void Opening_twice_changes_nothing_the_second_time()
    {
        using var h = new TempDb();
        h.Db.Run("UPDATE kv SET value = 'kept' WHERE key = 'sectionOrderPinned'");
        var db = h.Reopen();
        Assert.Equal("kept", db.Scalar("SELECT value FROM kv WHERE key = 'sectionOrderPinned'"));
    }

    [Fact]
    public void An_existing_profiles_section_order_is_written_down_as_the_page_showed_it()
    {
        using var h = new TempDb();
        var older = h.Db.GetOrCreateProfile("Older default");
        h.Db.Run("INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sectionOrder', ?)",
            older, """["me","recent","top_ranks","medals","historical"]""");
        h.Db.Run("INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sectionOrder', ?)",
            h.ProfileId, """["medals","me","nonsense"]""");
        h.Db.Run("DELETE FROM kv WHERE key = 'sectionOrderPinned'");

        var db = h.Reopen();
        string Order(long id) => (string)db.Scalar("SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'sectionOrder'", id)!;
        // A pre-1.10 default reads as never arranged: the order until 1.31.
        Assert.Equal("""["me","recent_plays","top_ranks","historical","recent","beatmaps","medals"]""", Order(older));
        // Unknown ids go, and each missing section joins after the one it followed by default.
        Assert.Equal("""["medals","me","recent_plays","top_ranks","historical","recent","beatmaps"]""", Order(h.ProfileId));
    }

    [Fact]
    public void A_read_only_database_refuses_writes_and_is_not_migrated()
    {
        using var h = new TempDb();
        h.Db.Exec("ALTER TABLE scores DROP COLUMN origin");
        using var readOnly = Database.Open(h.File, writable: false);
        Assert.False(readOnly.Writable);
        Assert.DoesNotContain("origin", Columns(readOnly, "scores"));
        Assert.Throws<SqliteException>(() => readOnly.Run("INSERT INTO kv (key, value) VALUES ('x', 'y')"));
    }

    [Fact]
    public void Question_marks_bind_in_order_but_not_inside_strings_or_comments()
    {
        Assert.Equal("SELECT $p1, '?', \"?\" -- ?\n, $p2", Database.NamePlaceholders("SELECT ?, '?', \"?\" -- ?\n, ?"));
        using var h = new TempDb();
        Assert.Equal("a?b", h.Db.Scalar("SELECT ? || '?' || ?", "a", "b"));
        Assert.Null(h.Db.Scalar("SELECT ?", (object?)null));
    }

    [Fact]
    public void A_failed_transaction_leaves_nothing_behind()
    {
        using var h = new TempDb();
        Assert.Throws<InvalidOperationException>(() => h.Db.Transaction(() =>
        {
            h.Db.Run("INSERT INTO kv (key, value) VALUES ('x', 'y')");
            throw new InvalidOperationException("stop");
        }));
        Assert.Null(h.Db.Scalar("SELECT value FROM kv WHERE key = 'x'"));
    }
}
