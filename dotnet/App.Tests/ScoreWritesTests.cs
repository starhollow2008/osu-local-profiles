using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Tests;

/// <summary>test/scores.test.ts, the writing half: pinning, removing, and deleting for good.</summary>
public sealed class ScoreWritesTests : IDisposable
{
    private readonly TempDb h = new();
    private int n;

    public void Dispose() => h.Dispose();

    private long Add(int mode = 0, int mapStatus = 1)
    {
        n++;
        h.Db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               accuracy, max_combo, total_score, passed, grade, stars, pp,
               map_status, mods_ranked, mods_countable, ranked, played_at)
             VALUES (?,?,?,?,'lazer','[]','None',100,0,0,0,0,0,0.99,100,500000,1,'S',5.0,100,?,1,1,?,?)
            """, h.ProfileId, $"key-{n}", mode, $"md5-{n}", mapStatus, mapStatus is 1 or 2 ? 1 : 0, Js.Now() + n * 1000);
        return Convert.ToInt64(h.Db.Scalar("SELECT last_insert_rowid() AS id"));
    }

    private List<long> Pinned(int mode = 0) => [.. Stats.PinnedPlays(h.Db, h.ProfileId, mode, Eligibility.Vanilla).Select(p => Convert.ToInt64(p.Id))];

    [Fact]
    public void Pinning_keeps_the_order_things_were_pinned_in()
    {
        var (a, b, c) = (Add(), Add(), Add());
        foreach (var id in new[] { c, a, b }) Scores.ApplyAction(h.Db, h.ProfileId, id, "pin");
        Assert.Equal([c, a, b], Pinned());
    }

    [Fact]
    public void A_pin_does_not_have_to_be_a_score_that_counts()
    {
        var loved = Add(mapStatus: 4);
        Scores.ApplyAction(h.Db, h.ProfileId, loved, "pin");
        Assert.Equal([loved], Pinned());
        Assert.Equal(0, Stats.Compute(h.Db, h.ProfileId, 0, Eligibility.Vanilla).DistinctRankedBeatmaps);
    }

    [Fact]
    public void Reordering_follows_the_list_it_is_given_and_a_partial_one_keeps_the_rest()
    {
        long[] ids = [Add(), Add(), Add()];
        foreach (var id in ids) Scores.ApplyAction(h.Db, h.ProfileId, id, "pin");
        Scores.ReorderPins(h.Db, h.ProfileId, [ids[2], ids[0], ids[1]]);
        Assert.Equal([ids[2], ids[0], ids[1]], Pinned());

        // A page that has not seen a newly pinned score must not unpin it by leaving it out.
        Scores.ReorderPins(h.Db, h.ProfileId, [ids[1]]);
        var after = Pinned();
        Assert.Equal(3, after.Count);
        Assert.Equal(ids[1], after[0]);
        Assert.Equal(new[] { ids[0], ids[2] }.Order(), after.Skip(1).Order());
    }

    [Fact]
    public void Removing_a_pinned_score_unpins_it_and_putting_it_back_does_not_pin_it_again()
    {
        var id = Add();
        Scores.ApplyAction(h.Db, h.ProfileId, id, "pin");
        Scores.ApplyAction(h.Db, h.ProfileId, id, "hide");
        Assert.Empty(Pinned());
        Assert.Equal(1, Scores.HiddenCount(h.Db, h.ProfileId));
        Scores.ApplyAction(h.Db, h.ProfileId, id, "restore");
        Assert.Empty(Pinned());
        Assert.Equal(0, Scores.HiddenCount(h.Db, h.ProfileId));
    }

    [Fact]
    public void Pins_are_per_mode()
    {
        var (std, taiko) = (Add(0), Add(1));
        Scores.ApplyAction(h.Db, h.ProfileId, std, "pin");
        Scores.ApplyAction(h.Db, h.ProfileId, taiko, "pin");
        Assert.Equal([std], Pinned(0));
        Assert.Equal([taiko], Pinned(1));
    }

    [Fact]
    public void Another_profiles_score_cannot_be_touched_and_an_unknown_action_is_refused()
    {
        var id = Add();
        var other = Profiles.Create(h.Db, "Left hand");
        Assert.Contains("no score", Assert.Throws<InvalidOperationException>(() => Scores.ApplyAction(h.Db, other.Id, id, "hide")).Message);
        Assert.Equal(0, Scores.HiddenCount(h.Db, h.ProfileId));
        // Reordering is filtered by profile rather than throwing, so the pin is simply not moved.
        Scores.ApplyAction(h.Db, h.ProfileId, id, "pin");
        Scores.ReorderPins(h.Db, other.Id, [id]);
        Assert.Equal([id], Pinned());
        Assert.Equal("unknown action \"destroy\"", Assert.Throws<InvalidOperationException>(() => Scores.ApplyAction(h.Db, h.ProfileId, id, "destroy")).Message);
        Assert.Equal("no score NaN on this profile", Assert.Throws<InvalidOperationException>(() => Scores.ApplyAction(h.Db, h.ProfileId, double.NaN, "pin")).Message);
    }

    [Fact]
    public void Only_a_removed_score_is_deleted_for_good_and_its_key_is_remembered()
    {
        var id = Add();
        Assert.Contains("only a removed score", Assert.Throws<InvalidOperationException>(() => Scores.DeleteRemoved(h.Db, h.ProfileId, [id], Js.Now())).Message);
        var key = h.Db.Scalar("SELECT dedupe_key FROM scores WHERE id = ?", id);
        Scores.ApplyAction(h.Db, h.ProfileId, id, "hide");
        Assert.Equal(1, Scores.DeleteRemoved(h.Db, h.ProfileId, [id], Js.Now()));
        Assert.False(h.Db.Exists("SELECT 1 FROM scores WHERE id = ?", id));
        Assert.True(h.Db.Exists("SELECT 1 FROM deleted_scores WHERE profile_id = ? AND dedupe_key = ?", h.ProfileId, key));
    }

    [Fact]
    public void Deleting_all_takes_every_removed_row_and_nothing_else_and_not_another_profiles()
    {
        var kept = Add();
        var (a, b) = (Add(), Add());
        Scores.ApplyAction(h.Db, h.ProfileId, a, "hide");
        Scores.ApplyAction(h.Db, h.ProfileId, b, "hide");
        var other = Profiles.Create(h.Db, "Second");
        Assert.Contains("no such score", Assert.Throws<InvalidOperationException>(() => Scores.DeleteRemoved(h.Db, other.Id, [a], Js.Now())).Message);
        Assert.Equal(0, Scores.DeleteRemoved(h.Db, other.Id, null, Js.Now()));

        Assert.Equal(2, Scores.DeleteRemoved(h.Db, h.ProfileId, null, Js.Now()));
        Assert.Equal([kept], h.Db.All("SELECT id FROM scores", r => r.GetInt64(0)));
    }

    [Fact]
    public void An_unfinished_play_is_removed_as_a_whole_row_and_remembered_by_its_own_key()
    {
        long Incomplete(string key)
        {
            h.Db.Run("""
                INSERT INTO incomplete_plays (profile_id, dedupe_key, mode, beatmap_md5, beatmap_name, played_at, unsubmitted)
                VALUES (?, ?, 0, NULL, 'Some map', ?, 0)
                """, h.ProfileId, key, Js.Now());
            return Convert.ToInt64(h.Db.Scalar("SELECT last_insert_rowid()"));
        }
        long[] ids = [Incomplete("x"), Incomplete("y")];
        Assert.Contains("no such play", Assert.Throws<InvalidOperationException>(() => Scores.SetIncompleteHidden(h.Db, h.ProfileId, [ids[0], 9999], true)).Message);
        Assert.Equal(2, Scores.SetIncompleteHidden(h.Db, h.ProfileId, [ids[0], ids[1], ids[0]], true));
        Assert.Equal(2, Scores.HiddenCount(h.Db, h.ProfileId));

        // One row of the removed list, both attempts.
        var row = Assert.Single(Scores.Hidden(h.Db, h.ProfileId));
        Assert.Equal("incomplete", row["kind"]);
        Assert.Equal(2L, row["attempts"]);
        Assert.Equal("Some map", row["title"]);

        Assert.Equal(2, Scores.DeleteRemoved(h.Db, h.ProfileId, [ids[0], ids[1]], Js.Now(), "incomplete"));
        Assert.Equal(["incomplete:x", "incomplete:y"], h.Db.All("SELECT dedupe_key FROM deleted_scores ORDER BY dedupe_key", r => r.GetString(0)));
    }

    [Fact]
    public void A_stable_play_in_the_removed_list_carries_Classic_as_osu_names_it()
    {
        Assert.Equal("CL", Scores.ClassicLabel("None", true));
        Assert.Equal("HDCL", Scores.ClassicLabel("HD", true));
        Assert.Equal("HD,CL", Scores.ClassicLabel("HD,CL", true));
        Assert.Equal("HD", Scores.ClassicLabel("HD", false));
        // \b: CL inside another name is not Classic.
        Assert.Equal("XCLXCL", Scores.ClassicLabel("XCLX", true));
    }
}
