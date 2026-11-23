using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tests;

/// <summary>test/profiles.test.ts, against the C# port (the stats half waits for phase 2).</summary>
public class ProfilesTests
{
    [Fact]
    public void The_config_name_seeds_only_an_empty_database_and_a_rename_does_not_bring_it_back()
    {
        var folder = Directory.CreateTempSubdirectory("olp-cs-").FullName;
        try
        {
            using (var db = Database.Open(Path.Combine(folder, "test.db")))
            {
                Profiles.SeedFirst(db, "Local Profile");
                var id = Profiles.ActiveId(db);
                Profiles.Rename(db, id, "Tangy");
                Profiles.SeedFirst(db, "Local Profile");
                Assert.Equal(["Tangy"], Profiles.List(db).Select(p => p.Name));
            }
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void Looking_a_profile_up_by_name_never_creates_one()
    {
        using var h = new TempDb();
        Assert.Null(Profiles.FindByName(h.Db, "Nobody"));
        Assert.Single(Profiles.List(h.Db));
        Assert.Equal(h.ProfileId, Profiles.FindByName(h.Db, "First")!.Id);
    }

    [Fact]
    public void Names_must_be_unique_and_non_empty()
    {
        using var h = new TempDb();
        Profiles.Create(h.Db, "Tablet");
        Assert.Contains("already exists", Assert.Throws<UserError>(() => Profiles.Create(h.Db, "Tablet")).Message);
        Assert.Contains("needs a name", Assert.Throws<UserError>(() => Profiles.Create(h.Db, "   ")).Message);
        Assert.Contains("needs a name", Assert.Throws<UserError>(() => Profiles.Create(h.Db, "")).Message);
        Assert.Contains("too long", Assert.Throws<UserError>(() => Profiles.Create(h.Db, new string('x', 61))).Message);
        // Surrounding whitespace is trimmed rather than making a near-duplicate.
        Assert.Contains("already exists", Assert.Throws<UserError>(() => Profiles.Create(h.Db, "  Tablet  ")).Message);
    }

    [Fact]
    public void Renaming_keeps_the_profile_and_its_scores()
    {
        using var h = new TempDb();
        var id = Profiles.ActiveId(h.Db);
        h.InsertScore(id, "a");

        var renamed = Profiles.Rename(h.Db, id, "Right hand");
        Assert.Equal("Right hand", renamed.Name);
        Assert.Equal(id, renamed.Id);
        Assert.Equal(1L, renamed.ScoreCount);
        Assert.Equal(id, Profiles.ActiveId(h.Db));
    }

    [Fact]
    public void Switching_changes_which_profile_is_live_and_survives_a_reopen()
    {
        using var h = new TempDb();
        var first = Profiles.ActiveId(h.Db);
        var second = Profiles.Create(h.Db, "Second");

        Profiles.SetActive(h.Db, second.Id);
        Assert.Equal(second.Id, Profiles.ActiveId(h.Db));
        Assert.Equal(second.Id, Profiles.List(h.Db).Single(p => p.Active).Id);
        Assert.Equal(second.Id, Profiles.ActiveId(h.Reopen()));

        Profiles.SetActive(h.Db, first);
        Assert.Equal(first, Profiles.ActiveId(h.Db));
        Assert.Contains("no profile with id", Assert.Throws<UserError>(() => Profiles.SetActive(h.Db, 9999)).Message);
    }

    [Fact]
    public void Deleting_a_profile_takes_its_scores_and_repairs_the_selection()
    {
        using var h = new TempDb();
        var first = Profiles.ActiveId(h.Db);
        var second = Profiles.Create(h.Db, "Doomed");
        h.InsertScore(second.Id, "a");
        Profiles.SetActive(h.Db, second.Id);

        var (deletedScores, nextActive) = Profiles.Delete(h.Db, second.Id);
        Assert.Equal(1L, deletedScores);
        Assert.Equal(first, nextActive);
        Assert.Equal(first, Profiles.ActiveId(h.Db));
        Assert.Equal(0L, h.Db.Scalar("SELECT COUNT(*) AS n FROM scores WHERE profile_id = ?", second.Id));
    }

    [Fact]
    public void A_deleted_profiles_id_is_never_given_to_a_new_one()
    {
        using var h = new TempDb();
        var second = Profiles.Create(h.Db, "Second");
        Profiles.Delete(h.Db, second.Id);
        var third = Profiles.Create(h.Db, "Third");
        Assert.True(third.Id > second.Id, $"{third.Id} reused {second.Id}");

        // An install from before the last id was kept: the delete itself remembers it.
        var fourth = Profiles.Create(h.Db, "Fourth");
        h.Db.Run("DELETE FROM kv WHERE key = ?", "lastProfileId");
        Profiles.Delete(h.Db, fourth.Id);
        Assert.True(Profiles.Create(h.Db, "Fifth").Id > fourth.Id);
    }

    [Fact]
    public void A_profiles_pictures_and_me_images_go_with_it_and_a_new_profile_starts_with_none()
    {
        var data = Directory.CreateTempSubdirectory("olp-cs-files-").FullName;
        try
        {
            byte[] png = [0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 0];
            Identity.SaveImage(data, 2, "avatar", png, ".png");
            Identity.SaveImage(data, 2, "cover", png, ".png");
            Identity.SaveImage(data, 3, "cover", png, ".png");
            Assert.NotNull(Identity.SaveAboutImage(data, 2, png));

            Identity.DeleteFiles(data, 2);
            Assert.Equal((false, false), Identity.ImageState(data, 2));
            Assert.False(Directory.Exists(Path.Combine(data, "about-images", "2")));
            // Another profile's are its own.
            Assert.Equal((false, true), Identity.ImageState(data, 3));

            // The pictures from before there was a second profile are the first profile's alone.
            File.WriteAllBytes(Path.Combine(data, "avatar.png"), png);
            Assert.NotNull(Identity.FindImage(data, 1, "avatar"));
            Assert.Null(Identity.FindImage(data, 4, "avatar"));
            Identity.DeleteFiles(data, 1);
            Assert.True(File.Exists(Path.Combine(data, "avatar.png")));
        }
        finally
        {
            Directory.Delete(data, recursive: true);
        }
    }

    [Fact]
    public void A_pictures_address_names_its_profile_and_changes_when_it_is_replaced()
    {
        var data = Directory.CreateTempSubdirectory("olp-cs-url-").FullName;
        try
        {
            byte[] png = [0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 0];
            Assert.Null(Identity.ImageUrl(data, 2, "cover"));
            var file = Identity.SaveImage(data, 2, "cover", png, ".png");
            File.SetLastWriteTimeUtc(file, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
            var first = Identity.ImageUrl(data, 2, "cover");
            Assert.StartsWith("/api/image/cover?profile=2&v=", first);

            Identity.SaveImage(data, 3, "cover", png, ".png");
            Assert.StartsWith("/api/image/cover?profile=3&", Identity.ImageUrl(data, 3, "cover"));

            file = Identity.SaveImage(data, 2, "cover", png, ".png");
            File.SetLastWriteTimeUtc(file, new DateTime(2026, 1, 2, 0, 0, 0, DateTimeKind.Utc));
            Assert.NotEqual(first, Identity.ImageUrl(data, 2, "cover"));
        }
        finally
        {
            Directory.Delete(data, recursive: true);
        }
    }

    [Fact]
    public void The_last_profile_cannot_be_deleted()
    {
        using var h = new TempDb();
        var only = Profiles.ActiveId(h.Db);
        Assert.Contains("only profile", Assert.Throws<UserError>(() => Profiles.Delete(h.Db, only)).Message);
        Assert.Single(Profiles.List(h.Db));
    }

    [Fact]
    public void A_dangling_active_id_falls_back_instead_of_throwing()
    {
        using var h = new TempDb();
        var first = Profiles.ActiveId(h.Db);
        h.Db.Run("UPDATE kv SET value = ? WHERE key = ?", "4242", "activeProfileId");
        Assert.Equal(first, Profiles.ActiveId(h.Db));
        // And it is repaired, not only worked around.
        Assert.Equal(first.ToString(), h.Db.Scalar("SELECT value FROM kv WHERE key = 'activeProfileId'"));
    }

    [Fact]
    public void A_read_only_database_falls_back_without_writing()
    {
        using var h = new TempDb();
        var first = Profiles.ActiveId(h.Db);
        h.Db.Run("UPDATE kv SET value = ? WHERE key = ?", "4242", "activeProfileId");
        using var readOnly = Database.Open(h.File, writable: false);
        Assert.Equal(first, Profiles.ActiveId(readOnly));
        Assert.Equal("4242", h.Db.Scalar("SELECT value FROM kv WHERE key = 'activeProfileId'"));
    }
}
