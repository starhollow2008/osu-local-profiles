using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Tests;

/// <summary>test/favorites.test.ts, the writing half.</summary>
public sealed class FavoriteWritesTests : IDisposable
{
    private readonly TempDb h = new();

    public void Dispose() => h.Dispose();

    private FavoriteScope Own(long profileId) => new(profileId, false);

    internal static BeatmapsetDetails Details(double id, bool video = false) => new(
        id, $"Title {id}", "Artist", null, null, "Mapper", 42, "ranked", false, false, false, video, true, 10, 1000, "2020-01-01T00:00:00Z",
        [new BeatmapsetDifficulty(id * 10 + 2, "osu", 5.2, "Insane"), new BeatmapsetDifficulty(id * 10 + 1, "osu", 2.1, "Normal")]);

    private List<long> Ids(FavoriteScope scope) => [.. Favorites.Ids(h.Db, scope).Select(Convert.ToInt64)];

    [Fact]
    public void Favouriting_is_per_profile_idempotent_and_undone_by_unfavouriting()
    {
        var other = Profiles.Create(h.Db, "Second").Id;
        Assert.True(Favorites.Add(h.Db, Own(h.ProfileId), 100));
        Assert.False(Favorites.Add(h.Db, Own(h.ProfileId), 100));
        Favorites.Add(h.Db, Own(other), 200);
        Assert.Equal([100], Ids(Own(h.ProfileId)));
        Assert.Equal([200], Ids(Own(other)));
        Assert.True(Favorites.Remove(h.Db, Own(h.ProfileId), 100));
        Assert.Equal(0, Favorites.Count(h.Db, Own(h.ProfileId)));
    }

    [Fact]
    public void Details_cached_without_the_video_flag_are_listed_as_missing_until_saved_again()
    {
        h.Db.Run("INSERT INTO beatmapset_details (beatmapset_id, data, fetched_at) VALUES (4, ?, 0)", """{"id":4,"title":"t","artist":"a"}""");
        Favorites.Add(h.Db, Own(h.ProfileId), 4, 1000);
        Favorites.Add(h.Db, Own(h.ProfileId), 5, 2000);
        Assert.Equal([5, 4], Favorites.MissingDetails(h.Db, Own(h.ProfileId), 5));
        Favorites.SaveDetails(h.Db, Details(4));
        Assert.Equal([5], Favorites.MissingDetails(h.Db, Own(h.ProfileId), 5));
        // Kept exactly as JSON.stringify wrote it.
        Assert.StartsWith("""{"id":4,"title":"Title 4","artist":"Artist","titleUnicode":null""", (string)h.Db.Scalar("SELECT data FROM beatmapset_details WHERE beatmapset_id = 4")!);
    }

    [Fact]
    public void Unfavouriting_while_shared_takes_it_from_every_profile()
    {
        var other = Profiles.Create(h.Db, "Second").Id;
        Favorites.Add(h.Db, Own(other), 100);
        Favorites.SyncSharing(h.Db, true);
        Favorites.Remove(h.Db, new FavoriteScope(h.ProfileId, true), 100);
        Favorites.SyncSharing(h.Db, false);
        Assert.Empty(Ids(Own(other)));
    }

    [Fact]
    public void An_import_keeps_osus_order_caches_every_card_and_counts_only_what_is_new()
    {
        Favorites.Add(h.Db, Own(h.ProfileId), 2, 1);
        Assert.Equal(2, Favorites.Import(h.Db, Own(h.ProfileId), [Details(1), Details(2), Details(3)], 10_000));
        var cards = Favorites.List(h.Db, Own(h.ProfileId), 10);
        Assert.Equal([("1", "osu"), ("3", "osu"), ("2", "osu")], cards.Select(c => (JsonText.Stringify(c["id"]), (string)c["source"]!)));
    }
}
