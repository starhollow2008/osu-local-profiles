using System.Text.Json;
using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Http;

/// <summary>
/// The endpoints that ask osu!'s website, each only because a button was pressed: src/http/server.ts.
/// </summary>
internal static partial class Server
{
    /// <summary>How many favourites still missing osu!'s details any favourite action retries.</summary>
    private const int FavoriteRetries = 3;

    /// <summary>The Favorite Beatmaps list requests are about: shared by every profile, or the current one's.</summary>
    private static FavoriteScope FavoritesOf(ServerOptions opts, long profileId) =>
        new(profileId, opts.Config["sharedFavorites"] is { ValueKind: JsonValueKind.True });

    /// <summary>
    /// Favorite Beatmaps: add or remove a set. The favourite is saved first and regardless; adding
    /// asks osu! for the set's details, and any action retries a few still missing theirs, so an
    /// offline favourite fills in the next time one is pressed with a connection.
    /// </summary>
    private static Task PostFavorites(HttpContext context, ServerOptions opts, long profileId) => WithBody(context, async body =>
    {
        var db = opts.Db;
        var action = Str(body, "action");
        var id = Num(body, "beatmapsetId");
        if (!IsInteger(id) || id <= 0)
        {
            await Json(context, new { error = "a beatmapset id is needed" }, 400);
            return;
        }
        if (action is not ("add" or "remove"))
        {
            await Json(context, new { error = "action must be add or remove" }, 400);
            return;
        }

        var scope = FavoritesOf(opts, profileId);
        if (action == "remove") Favorites.Remove(db, scope, id);
        else Favorites.Add(db, scope, id);

        string? detailsError = null;
        var wanted = action == "add" && Favorites.DetailsFor(db, id) is null ? new List<double> { id } : [];
        foreach (var missing in Favorites.MissingDetails(db, scope, FavoriteRetries))
        {
            if (!wanted.Contains(missing)) wanted.Add(missing);
        }
        foreach (var setId in wanted)
        {
            try
            {
                Favorites.SaveDetails(db, await opts.Osu.FetchBeatmapset(setId));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                if (setId == id) detailsError = e.Message;
                // Offline is offline for every set, and so is osu! asking to slow down.
                if (e is SlowDown || e.Message == "could not reach osu.ppy.sh") break;
            }
        }

        opts.Events.Broadcast("favorites", new { action, beatmapsetId = id });
        await Json(context, new { ok = true, favorites = Favorites.Ids(db, scope), detailsError });
    });
}
