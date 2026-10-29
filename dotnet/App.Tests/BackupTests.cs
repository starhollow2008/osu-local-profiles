using System.Text;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tests;

/// <summary>test/backup.test.ts: Back up everything, and restoring what it saved.</summary>
public sealed class BackupTests : IDisposable
{
    private readonly List<string> made = [];
    private readonly List<Database> open = [];

    public void Dispose()
    {
        foreach (var db in open) db.Dispose();
        foreach (var dir in made)
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
                /* still open: the temp folder is the system's to clear */
            }
        }
    }

    private string TempDir()
    {
        var dir = Directory.CreateTempSubdirectory("olp-cs-backup-").FullName;
        made.Add(dir);
        return dir;
    }

    private static readonly byte[] Png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

    /// <summary>A data folder as an install has it: a database, pictures, me! images, and install files.</summary>
    private (string Dir, Database Db) Install(params (string Name, int Scores)[] profiles)
    {
        var dir = TempDir();
        var db = Database.Open(Path.Combine(dir, "profiles.db"));
        open.Add(db);
        db.Run("""
            INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator, status, cached_at)
            VALUES ('m1', 11, 7, 'Artist', 'Title', 'Hard', 'Someone', 1, 0)
            """);
        foreach (var (name, scores) in profiles)
        {
            var id = db.GetOrCreateProfile(name);
            for (var i = 0; i < scores; i++)
            {
                db.Run("""
                    INSERT INTO scores
                      (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
                       count300, count100, count50, count_geki, count_katu, count_miss,
                       accuracy, max_combo, total_score, passed, grade, stars, played_at)
                    VALUES (?, ?, 0, 'm1', 'lazer', '[]', '', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'S', 1, 1)
                    """, id, $"{name}-{i}");
            }
        }
        File.WriteAllBytes(Path.Combine(dir, "profile-1-avatar.png"), Png);
        Directory.CreateDirectory(Path.Combine(dir, "about-images", "1"));
        File.WriteAllBytes(Path.Combine(dir, "about-images", "1", "0123456789abcdef.png"), Png);
        File.WriteAllText(Path.Combine(dir, "config.json"), """{"port":7272}""");
        Directory.CreateDirectory(Path.Combine(dir, "logs"));
        File.WriteAllText(Path.Combine(dir, "logs", "app.log"), "hello");
        return (dir, db);
    }

    private void Close(Database db)
    {
        db.Dispose();
        open.Remove(db);
    }

    [Fact]
    public void A_written_zip_reads_back_byte_for_byte_compressed_or_stored()
    {
        var text = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("the same line again\n", 200)));
        var zip = Zip.Write([("profiles.db", text), ("about-images/1/a.png", Png), ("夜に駆ける.txt", Encoding.UTF8.GetBytes("名前"))], DateTime.Now);
        var entries = Zip.ReadEntries(zip);
        Assert.Equal(["profiles.db", "about-images/1/a.png", "夜に駆ける.txt"], entries.Select(e => e.Name));
        Assert.Equal(8, entries[0].Method);
        Assert.Equal(0, entries[1].Method);
        Assert.Equal(text, Zip.EntryData(zip, entries[0]));
        Assert.Equal(Png, Zip.EntryData(zip, entries[1]));
        Assert.Equal("名前", Encoding.UTF8.GetString(Zip.EntryData(zip, entries[2])));
    }

    [Fact]
    public void Profile_data_is_the_database_the_pictures_the_me_images_and_what_was_uploaded_or_downloaded()
    {
        foreach (var name in new[] { "profiles.db", "profile-1-avatar.png", "profile-12-cover.jpeg", "avatar.png", "cover.jpg",
            "about-images/3/0123456789abcdef.webp", $"replays/{new string('a', 32)}.osr", $"beatmaps/{new string('b', 32)}.osu" })
        {
            Assert.True(Backup.IsProfileFile(name), name);
        }
        foreach (var name in new[] { "config.json", "logs/app.log", "profiles.db-wal", "update/swapper.pid", "profile-1-avatar.exe",
            "about-images/../../config.json", "about-images/x/a.png", "../profiles.db", "beatmaps/x.osu" })
        {
            Assert.False(Backup.IsProfileFile(name), name);
        }
    }

    [Fact]
    public void A_backup_holds_every_profile_and_its_images_laid_out_as_data_is_without_the_install_files()
    {
        var (dir, db) = Install(("Left", 2), ("Mouse", 1));
        var zip = Backup.Create(db, dir, DateTimeOffset.Now);
        Assert.Equal(["about-images/1/0123456789abcdef.png", "profile-1-avatar.png", "profiles.db"], Zip.ReadEntries(zip).Select(e => e.Name).Order(StringComparer.Ordinal));
        // The snapshot is written beside the database and must not be left there.
        Assert.Empty(Directory.EnumerateFiles(dir, "backup-*"));
        Assert.Equal("osu-local-profiles-backup-2026-09-03.zip", Backup.FileName(new DateTime(2026, 9, 3, 23, 59, 0)));
    }

    [Fact]
    public void An_uploaded_backup_is_checked_and_described_before_anything_is_replaced()
    {
        var from = Install(("Left", 2), ("Mouse", 1));
        var to = Install(("Other", 5));
        var summary = Backup.StageRestore(to.Dir, Backup.Create(from.Db, from.Dir, DateTimeOffset.Now));
        Assert.Equal("""{"profiles":[{"name":"Left","plays":2},{"name":"Mouse","plays":1}],"images":2}""", JsonText.Stringify(summary));
        Assert.True(Backup.HasStagedRestore(to.Dir));
        Assert.Equal("Other", to.Db.Scalar("SELECT name FROM profiles"));
        Backup.DiscardRestore(to.Dir);
        Assert.False(Backup.HasStagedRestore(to.Dir));

        // A bare .db from before backups were zips can still be restored.
        var snapshot = Path.Combine(from.Dir, "old-backup.db");
        from.Db.Exec($"VACUUM INTO '{snapshot.Replace("'", "''")}'");
        Assert.Equal("""{"profiles":[{"name":"Left","plays":2},{"name":"Mouse","plays":1}],"images":0}""",
            JsonText.Stringify(Backup.StageRestore(TempDir(), File.ReadAllBytes(snapshot))));
    }

    [Fact]
    public void Anything_that_is_not_one_of_this_apps_backups_is_refused_and_nothing_is_left_staged()
    {
        var to = TempDir();
        var other = Path.Combine(TempDir(), "other.db");
        // Another program's database: SQLite, with none of this app's tables.
        using (var foreign = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={other};Pooling=False"))
        {
            foreign.Open();
            using var create = foreign.CreateCommand();
            create.CommandText = "CREATE TABLE notes (text TEXT)";
            create.ExecuteNonQuery();
        }
        var cases = new (string What, byte[] Upload, string Error)[]
        {
            ("random bytes", Encoding.ASCII.GetBytes("hello, this is not a backup"), "not a backup"),
            ("another program's database", File.ReadAllBytes(other), "not an osu! local profiles backup"),
            ("a zip with no database", Zip.Write([("profile-1-avatar.png", Png)], DateTime.Now), "no profiles.db"),
            ("a damaged zip", [0x50, 0x4b, 0x03, 0x04, .. new byte[40]], "could not be read"),
        };
        foreach (var (what, upload, error) in cases)
        {
            Assert.Contains(error, Assert.Throws<InvalidOperationException>(() => Backup.StageRestore(to, upload)).Message);
            Assert.False(Backup.HasStagedRestore(to), what);
        }
    }

    [Fact]
    public void Only_profile_data_comes_out_of_a_backup_and_one_nobody_confirmed_is_dropped()
    {
        var from = Install(("Left", 1));
        var zip = Backup.Create(from.Db, from.Dir, DateTimeOffset.Now);
        var entries = Zip.ReadEntries(zip).Select(e => (e.Name, Zip.EntryData(zip, e))).ToList();
        var tampered = Zip.Write([.. entries, ("config.json", Encoding.UTF8.GetBytes("""{"port":1}"""))], DateTime.Now);
        var to = TempDir();
        Backup.StageRestore(to, tampered);
        Backup.MarkRestoreReady(to);
        Assert.True(Backup.ApplyPendingRestore(to, DateTime.Now).Applied);
        Assert.False(File.Exists(Path.Combine(to, "config.json")));

        var unconfirmed = Install(("Other", 1));
        Backup.StageRestore(unconfirmed.Dir, zip);
        Close(unconfirmed.Db);
        Assert.Equal(new RestoreResult(false), Backup.ApplyPendingRestore(unconfirmed.Dir, DateTime.Now));
        Assert.False(Backup.HasStagedRestore(unconfirmed.Dir));
        using var db = Database.Open(Path.Combine(unconfirmed.Dir, "profiles.db"));
        Assert.Equal("Other", db.Scalar("SELECT name FROM profiles"));
        Assert.Equal("no backup has been uploaded to restore", Assert.Throws<InvalidOperationException>(() => Backup.MarkRestoreReady(unconfirmed.Dir)).Message);
    }

    [Fact]
    public void A_confirmed_restore_swaps_the_profiles_in_and_moves_what_was_there_aside_deleting_nothing()
    {
        var from = Install(("Left", 2));
        File.Delete(Path.Combine(from.Dir, "profile-1-avatar.png"));
        var to = Install(("Other", 4));
        File.WriteAllBytes(Path.Combine(to.Dir, "profile-1-cover.png"), Png);
        Backup.StageRestore(to.Dir, Backup.Create(from.Db, from.Dir, DateTimeOffset.Now));
        Backup.MarkRestoreReady(to.Dir);
        Close(to.Db);

        var result = Backup.ApplyPendingRestore(to.Dir, new DateTime(2026, 9, 23, 20, 5, 9));
        Assert.True(result.Applied);
        Assert.Equal("before-restore-2026-09-23-200509", Path.GetFileName(result.Aside));
        using (var db = Database.Open(Path.Combine(to.Dir, "profiles.db")))
        {
            Assert.Equal(["Left"], db.All("SELECT name FROM profiles", r => r.GetString(0)));
        }
        Assert.True(File.Exists(Path.Combine(to.Dir, "about-images", "1", "0123456789abcdef.png")));
        Assert.False(File.Exists(Path.Combine(to.Dir, "profile-1-avatar.png")));
        Assert.False(File.Exists(Path.Combine(to.Dir, "profile-1-cover.png")));
        Assert.Equal(["about-images", "profile-1-avatar.png", "profile-1-cover.png", "profiles.db"],
            Directory.EnumerateFileSystemEntries(result.Aside!).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        using (var old = Database.Open(Path.Combine(result.Aside!, "profiles.db")))
        {
            Assert.Equal(4L, old.Scalar("SELECT COUNT(*) FROM scores"));
        }
        Assert.Equal("""{"port":7272}""", File.ReadAllText(Path.Combine(to.Dir, "config.json")));
        Assert.True(File.Exists(Path.Combine(to.Dir, "logs", "app.log")));
        Assert.False(Backup.HasStagedRestore(to.Dir));
    }
}
