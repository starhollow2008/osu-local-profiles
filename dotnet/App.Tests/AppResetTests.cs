using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tests;

/// <summary>Settings -> System -> Reset (issue #48): what each reset clears, and what it keeps.</summary>
public sealed class AppResetTests : IDisposable
{
    private readonly string dir = Directory.CreateTempSubdirectory("olp-cs-reset-").FullName;
    private Database? db;

    public void Dispose()
    {
        db?.Dispose();
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
            /* still open: the temp folder is the system's to clear */
        }
    }

    private string At(params string[] parts) => Path.Combine([dir, .. parts]);

    private static void Write(string file, string text = "x")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }

    /// <summary>An install in use: two profiles with scores, settings and pictures, an index, and config.json.</summary>
    private (long First, long Second) Install()
    {
        Write(At("config.json"), """
            {"port": 7300, "profileName": "Mine", "discoveredRoots": ["C:\\osu"], "searchedForInstalls": true,
             "installRoots": ["D:\\osu"], "font": "system", "ppDecimals": 2, "autoUpdate": true, "country": "NL", "handEdited": 1}
            """);
        db = Database.Open(At("profiles.db"));
        var first = db.GetOrCreateProfile("First");
        var second = db.GetOrCreateProfile("Second");
        foreach (var id in new[] { first, second })
        {
            db.Run("""
                INSERT INTO scores
                  (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
                   count300, count100, count50, count_geki, count_katu, count_miss,
                   accuracy, max_combo, total_score, passed, grade, pp, ranked, played_at)
                VALUES (?, 'k', 0, 'm1', 'lazer', '[]', 'None', 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 'X', 1, 1, 1)
                """, id);
            db.Run("INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'tagline', '\"hi\"')", id);
            db.Run("INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'scoring', '\"classic\"')", id);
            Write(At($"profile-{id}-avatar.png"));
            Write(At("about-images", id.ToString(System.Globalization.CultureInfo.InvariantCulture), "a.png"));
        }
        db.Run("INSERT INTO shared_favorite_beatmapsets (beatmapset_id, favorited_at) VALUES (7, 1)");
        db.Run("INSERT INTO beatmaps (md5, artist, title, osu_path, cached_at) VALUES ('m1', 'Artist', 'Title', 'C:\\osu\\a.osu', 0)");
        db.Run("INSERT INTO osu_files (path, md5, size, indexed_at) VALUES ('C:\\osu\\a.osu', 'm1', 1, 0)");
        db.Run("INSERT INTO not_beatmaps (path, size) VALUES ('C:\\osu\\a.png', 1)");
        Write(At("replays", "0123456789abcdef0123456789abcdef.osr"));
        Write(At("beatmaps", "0123456789abcdef0123456789abcdef.osu"));
        Write(At("mcosu", "built.osr"));
        Write(At("logs", "app.log"));
        return (first, second);
    }

    /// <summary>A start: the files half, then the database half on the reopened database.</summary>
    private void Start()
    {
        db?.Dispose();
        var parts = AppReset.ApplyToFiles(dir);
        db = Database.Open(At("profiles.db"));
        var name = AppConfig.Load(dir).ProfileName;
        AppReset.ApplyToDatabase(db, parts, name);
        Profiles.SeedFirst(db, name);
    }

    private long Count(string sql) => Convert.ToInt64(db!.Scalar(sql));

    [Fact]
    public void Reset_settings_puts_every_setting_back_and_keeps_the_profiles_and_who_they_are()
    {
        var (first, _) = Install();
        AppReset.Stage(dir, [AppReset.Settings]);
        Start();

        var config = AppConfig.Load(dir);
        Assert.Equal("nunito", config["font"]!.Value.GetString());
        Assert.Equal(0, config["ppDecimals"]!.Value.GetInt32());
        Assert.False(config["autoUpdate"]!.Value.GetBoolean());
        Assert.Empty(config.Strings("installRoots"));
        Assert.Null(config["handEdited"]);
        // What is not a setting on the page stays.
        Assert.Equal(7300, config.Port);
        Assert.Equal("Mine", config.ProfileName);
        Assert.Equal(new[] { "C:\\osu" }, config.Strings("discoveredRoots"));
        Assert.True(config["searchedForInstalls"]!.Value.GetBoolean());
        Assert.Equal("NL", config["country"]!.Value.GetString());

        Assert.Equal(2, Count("SELECT COUNT(*) FROM profiles"));
        Assert.Equal(2, Count("SELECT COUNT(*) FROM scores"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM profile_settings WHERE key = 'scoring'"));
        Assert.Equal("\"hi\"", db!.Scalar("SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'tagline'", first));
        Assert.True(File.Exists(At($"profile-{first}-avatar.png")));
    }

    [Fact]
    public void Reset_profiles_starts_again_with_one_new_profile_and_keeps_the_settings_and_the_index()
    {
        var (first, second) = Install();
        AppReset.Stage(dir, [AppReset.Profiles]);
        Start();

        var profile = Assert.Single(Profiles.List(db!));
        Assert.Equal("Mine", profile.Name);
        // An id no profile has had, so the page never takes it for one of those deleted.
        Assert.True(profile.Id > second);
        Assert.Equal(profile.Id, Profiles.ActiveId(db!));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM scores"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM profile_settings"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM shared_favorite_beatmapsets"));
        Assert.Equal(1, Count("SELECT COUNT(*) FROM kv WHERE key = 'welcomePending'"));
        Assert.False(File.Exists(At($"profile-{first}-avatar.png")));
        Assert.False(Directory.Exists(At("about-images")));
        Assert.False(Directory.Exists(At("replays")));

        Assert.Equal(1, Count("SELECT COUNT(*) FROM osu_files"));
        Assert.Equal("C:\\osu\\a.osu", db!.Scalar("SELECT osu_path FROM beatmaps"));
        Assert.True(File.Exists(At("beatmaps", "0123456789abcdef0123456789abcdef.osu")));
        Assert.Equal("system", AppConfig.Load(dir)["font"]!.Value.GetString());
    }

    [Fact]
    public void Reset_beatmap_index_clears_the_index_and_keeps_what_each_beatmap_is()
    {
        Install();
        AppReset.Stage(dir, [AppReset.Index]);
        Start();

        Assert.Equal(0, Count("SELECT COUNT(*) FROM osu_files"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM not_beatmaps"));
        // Scores still have their beatmap's name; its file is found again by the next scan.
        Assert.Equal("Title", db!.Scalar("SELECT title FROM beatmaps WHERE md5 = 'm1'"));
        Assert.Null(db.Scalar("SELECT osu_path FROM beatmaps WHERE md5 = 'm1'"));
        Assert.Equal(2, Count("SELECT COUNT(*) FROM scores"));
        Assert.Equal(2, Count("SELECT COUNT(*) FROM profile_settings WHERE key = 'scoring'"));
    }

    [Fact]
    public void Reset_app_leaves_the_data_folder_as_a_new_install_has_it()
    {
        Install();
        AppReset.Stage(dir, [AppReset.Index, AppReset.App]);
        db!.Dispose();
        db = null;

        Assert.Equal(new[] { AppReset.App }, AppReset.ApplyToFiles(dir).ToArray());
        // The launcher's log is open while the app runs, and a port set by hand is where the page waits.
        Assert.Equal(new[] { "config.json", "logs" }, Directory.EnumerateFileSystemEntries(dir).Select(e => Path.GetFileName(e)).Order().ToArray());
        Assert.True(File.Exists(At("logs", "app.log")));
        var config = AppConfig.Load(dir);
        Assert.Equal(7300, config.Port);
        Assert.Equal("nunito", config["font"]!.Value.GetString());
        Assert.False(config["searchedForInstalls"]!.Value.GetBoolean());
    }

    [Fact]
    public void Reset_app_writes_no_config_when_the_port_is_the_default()
    {
        Write(At("config.json"), """{"port": 7272, "font": "system"}""");
        Write(At("profiles.db"));
        AppReset.Stage(dir, [AppReset.App]);
        AppReset.ApplyToFiles(dir);
        Assert.Empty(Directory.EnumerateFileSystemEntries(dir));
    }

    [Fact]
    public void A_reset_is_asked_for_until_the_next_start_and_applied_only_once()
    {
        Install();
        AppReset.Stage(dir, [AppReset.Index]);
        AppReset.Stage(dir, [AppReset.Settings, AppReset.Index]);
        Assert.Equal(new[] { AppReset.Index, AppReset.Settings }, AppReset.Pending(dir).Order().ToArray());
        Assert.Throws<ArgumentException>(() => AppReset.Stage(dir, ["everything"]));

        Start();
        Assert.Empty(AppReset.Pending(dir));
        db!.Run("INSERT INTO osu_files (path, md5, size, indexed_at) VALUES ('C:\\osu\\b.osu', 'm2', 1, 0)");
        Start();
        Assert.Equal(1, Count("SELECT COUNT(*) FROM osu_files"));
    }
}
