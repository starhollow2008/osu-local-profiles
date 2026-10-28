using OsuLocalProfiles.Update;

namespace OsuLocalProfiles.Tests;

/// <summary>test/update.test.ts's version order and test/update-notes.test.ts's notes.</summary>
public class NotesTests
{
    private const double Day = 86_400_000;

    private static VersionNotes V(string version, bool important = false) => new(version, null, important, [$"{version} did a thing"]);

    private static readonly List<VersionNotes> All = [V("1.27.0"), V("1.26.0"), V("1.25.0"), V("1.24.0")];

    [Fact]
    public void Versions_compare_by_number_and_a_pre_release_is_older_than_its_release()
    {
        Assert.Equal(-1, Notes.CompareVersions("1.9.0", "1.10.0"));
        Assert.Equal(0, Notes.CompareVersions("1.2.0", "1.2.0"));
        Assert.Equal(1, Notes.CompareVersions("2.0.0", "1.99.99"));
        Assert.Equal(-1, Notes.CompareVersions("1.3.0-beta.1", "1.3.0"));
        Assert.Equal(1, Notes.CompareVersions("v1.3.0", "1.3.0-rc.1"));
        Assert.Equal(-1, Notes.CompareVersions("1.3.0-beta.1", "1.3.0-beta.2"));
    }

    [Fact]
    public void What_is_new_is_every_version_after_this_one_up_to_the_newest()
    {
        Assert.Equal(["1.26.0", "1.25.0"], Notes.Between(All, "1.24.0", "1.26.0").Select(n => n.Version));
        Assert.Equal(["1.27.0"], Notes.Between(All, "1.26.0", "1.27.0").Select(n => n.Version));
        Assert.Equal(["1.26.0"], Notes.Between(All, null, "1.26.0").Select(n => n.Version));
        Assert.Empty(Notes.Between(All, "1.27.0", "1.27.0"));
    }

    [Fact]
    public void Notes_are_checked_and_trimmed_before_they_reach_the_page()
    {
        var parsed = Notes.ParseNotes(JsonText.From(new
        {
            versions = new object?[]
            {
                new { version = "1.27.0", date = "2026-09-27", important = true, highlights = new object[] { "ok", 42, "", new string('x', 500) } },
                new { version = "not a version", highlights = new[] { "dropped" } },
                new { version = "1.26.0", date = "yesterday", highlights = "not a list" },
                null,
            },
        }));
        Assert.Equal(2, parsed.Count);
        Assert.Equal("ok", parsed[0].Highlights[0]);
        Assert.Equal(2, parsed[0].Highlights.Count);
        Assert.True(parsed[0].Highlights[1].Length < 210);
        Assert.True(parsed[0].Important);
        Assert.Null(parsed[1].Date);
        Assert.Empty(parsed[1].Highlights);
        Assert.Empty(Notes.ParseNotes(JsonText.From("garbage")));
    }

    [Fact]
    public void A_dismissed_notice_stays_away_a_week_unless_something_important_comes_out()
    {
        var now = DateTimeOffset.Parse("2026-10-20T12:00:00Z").ToUnixTimeMilliseconds();
        List<VersionNotes> missing = [V("1.28.0"), V("1.27.0")];
        Assert.True(Notes.NudgeShown("behind", missing, null, now));
        Assert.False(Notes.NudgeShown(null, missing, null, now));
        Assert.False(Notes.NudgeShown("behind", missing, ("1.28.0", now - Day), now));
        Assert.True(Notes.NudgeShown("behind", missing, ("1.28.0", now - 7 * Day), now));
        List<VersionNotes> important = [V("1.29.0", important: true), .. missing];
        Assert.True(Notes.NudgeShown("important", important, ("1.28.0", now - Day), now));
        Assert.False(Notes.NudgeShown("important", important, ("1.29.0", now - Day), now));
    }

    [Fact]
    public void What_changed_is_shown_after_an_update_and_known_from_the_update_log()
    {
        using var h = new TempDb();
        var install = Path.Combine(h.Folder, "install");
        var data = Path.Combine(install, "data");
        Directory.CreateDirectory(data);
        File.WriteAllText(Path.Combine(install, "release-notes.json"),
            """{"versions":[{"version":"1.27.0","highlights":["a"]},{"version":"1.26.0","highlights":["b"]},{"version":"1.25.0","highlights":["c"]}]}""");

        // A first launch has nothing to announce.
        Assert.Null(Notes.WhatsNew(h.Db, "1.27.0", install, data));

        h.Db.Run("INSERT INTO kv (key, value) VALUES ('lastSeenVersion', '1.25.0')");
        Assert.Equal("""{"from":"1.25.0","to":"1.27.0","notes":[{"version":"1.27.0","date":null,"important":false,"highlights":["a"]},{"version":"1.26.0","date":null,"important":false,"highlights":["b"]}]}""",
            JsonText.Stringify(Notes.WhatsNew(h.Db, "1.27.0", install, data)));
        h.Db.Run("UPDATE kv SET value = '1.27.0' WHERE key = 'lastSeenVersion'");
        Assert.Null(Notes.WhatsNew(h.Db, "1.27.0", install, data));

        // The update to the first version that keeps a record is known from update.log.
        h.Db.Run("DELETE FROM kv WHERE key = 'lastSeenVersion'");
        File.WriteAllText(Path.Combine(data, "update.log"), "OK: updated to 1.27.0\n\nlog");
        Assert.Equal("1.27.0", Notes.UpdatedToFromLog(data));
        Assert.Contains("\"to\":\"1.27.0\"", JsonText.Stringify(Notes.WhatsNew(h.Db, "1.27.0", install, data)));
    }
}
