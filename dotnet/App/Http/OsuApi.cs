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

    /* ---------------------------------------------------------------- identity */

    private static readonly string[] ModeLabels = ["osu!", "osu!taiko", "osu!catch", "osu!mania"];

    private static string Plural(double n, string one) => $"{Js.NumberToString(n)} {one}{(n == 1 ? "" : "s")}";

    /// <summary>One request, on an explicit press, showing what was found before using it.</summary>
    private static async Task IdentityLookup(HttpContext context, ServerOptions opts, JsonElement body)
    {
        var user = await opts.Osu.LookupUser(Str(body, "query"));
        await Json(context, new { ok = true, user });
    }

    private static object IdentityAnswer(ServerOptions opts, long id, object fields)
    {
        var answer = JsonText.From(fields);
        var (hasAvatar, hasCover) = Identity.ImageState(opts.Paths.DataDir, id);
        var output = new Dictionary<string, object?>();
        foreach (var (key, value) in Js.Entries(answer)) output[key] = value;
        output["hasAvatar"] = hasAvatar;
        output["hasCover"] = hasCover;
        return output;
    }

    /// <summary>Adopt a looked-up account: remember it and copy its pictures in. The name is not changed.</summary>
    private static async Task IdentityLink(HttpContext context, ServerOptions opts, long id, JsonElement body)
    {
        var db = opts.Db;
        var fallbacks = opts.Config.SettingsFallbacks();
        var user = await opts.Osu.LookupUser(Str(body, "query"));
        Settings.SettingsStore.Update(db, id, JsonText.From(new { linkedUserId = user.Id, linkedUsername = user.Username }), fallbacks);

        // Best effort: a linked account with an unreachable image is still linked.
        var failures = new List<string>();
        foreach (var (kind, source) in new[] { ("avatar", user.AvatarUrl), ("cover", user.CoverUrl) })
        {
            if (string.IsNullOrEmpty(source) || Js.Get(body, kind) is { ValueKind: JsonValueKind.False }) continue;
            try
            {
                var downloaded = await opts.Osu.DownloadImage(source);
                Identity.SaveImage(opts.Paths.DataDir, id, kind, downloaded.Bytes, downloaded.Extension);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                failures.Add($"{kind}: {e.Message}");
            }
        }
        opts.Events.Broadcast("identity", new { linked = user.Id });
        // Just linked: where this profile's plays placed, if the account is the player's own.
        if (opts.RankEvents is { } rank) _ = rank.CatchUp();
        await Json(context, IdentityAnswer(opts, id, new { ok = true, user, failures, settings = Settings.SettingsStore.Get(db, id, fallbacks) }));
    }

    /// <summary>
    /// Copy what was chosen from an osu! account, and link the profile to it. Each part is best effort,
    /// and the answer says what worked: one lookup, one download per image, one request per hundred
    /// favourites, and per ruleset the best performances, pins and standing.
    /// </summary>
    private static async Task IdentityImport(HttpContext context, ServerOptions opts, long id, JsonElement body)
    {
        var db = opts.Db;
        var fallbacks = opts.Config.SettingsFallbacks();
        var user = await opts.Osu.LookupUser(Str(body, "query"));
        bool Want(string key, bool fallback) => Js.Get(body, key) is { ValueKind: JsonValueKind.True or JsonValueKind.False } v ? v.ValueKind == JsonValueKind.True : fallback;
        var done = new List<string>();
        var failures = new List<string>();

        var patch = new Dictionary<string, object?>
        {
            ["linkedUserId"] = user.Id,
            ["linkedUsername"] = user.Username,
            // A stable replay carries no user id, so a play set before a rename would look like a stranger's.
            ["linkedPreviousNames"] = user.PreviousUsernames,
            // The list has now actually been asked for, which is what makes it safe to act on.
            ["linkedNamesKnown"] = true,
        };
        if (Want("country", true))
        {
            if (!string.IsNullOrEmpty(user.CountryCode))
            {
                patch["country"] = user.CountryCode;
                done.Add("flag");
            }
            else
            {
                failures.Add("flag: that account shows no country");
            }
        }
        if (Want("aboutMe", true))
        {
            // An empty me! on osu! leaves this one alone rather than wiping it.
            if (user.PageRaw is not null)
            {
                patch["aboutMe"] = user.PageRaw;
                done.Add("me!");
            }
            else
            {
                failures.Add("me!: that account's me! is empty");
            }
        }
        Settings.SettingsStore.Update(db, id, JsonText.From(patch), fallbacks);

        foreach (var (kind, source, label) in new[] { ("avatar", user.AvatarUrl, "avatar"), ("cover", user.CoverUrl, "banner") })
        {
            if (!Want(kind, true)) continue;
            if (string.IsNullOrEmpty(source))
            {
                failures.Add($"{label}: that account has none");
                continue;
            }
            try
            {
                var downloaded = await opts.Osu.DownloadImage(source);
                Identity.SaveImage(opts.Paths.DataDir, id, kind, downloaded.Bytes, downloaded.Extension);
                done.Add(label);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                failures.Add($"{label}: {e.Message}");
            }
        }

        int favouritesFound = 0, favouritesAdded = 0;
        if (Want("favorites", false))
        {
            try
            {
                // Read a hundred a second at most, so a big list says how far it has got.
                var sets = await opts.Osu.FetchFavouriteBeatmapsets(user.Id, read => opts.Events.Broadcast("osu-progress", new { step = "favourites", done = read }));
                favouritesFound = sets.Count;
                favouritesAdded = Favorites.Import(db, FavoritesOf(opts, id), sets);
                done.Add($"{favouritesFound} favourite beatmap{(favouritesFound == 1 ? "" : "s")}");
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                failures.Add($"favourite beatmaps: {e.Message}");
            }
        }

        // The medals this app awards, as osu! awarded them, in place of what an earlier import copied.
        var wantMedals = Want("medals", false);
        if (wantMedals)
        {
            var kept = Tracker.OnlineImport.SaveImportedMedals(db, id, user.Medals.Where(m => Calc.Medals.IsAppMedal(m.Slug)));
            done.Add(Plural(kept, "medal"));
        }

        // Best performances and pinned scores, every ruleset, both lists in one pass.
        var scores = new List<Tracker.ModeImportResult>();
        var wantBest = Want("bestPerformances", false);
        var wantPinned = Want("pinnedScores", false);
        if (wantBest || wantPinned)
        {
            foreach (var mode in new[] { 0, 1, 2, 3 })
            {
                opts.Events.Broadcast("osu-progress", new { step = "scores", mode });
                try
                {
                    var best = wantBest ? await opts.Osu.FetchBestPerformances(user.Id, mode) : [];
                    var pinned = wantPinned ? await opts.Osu.FetchPinnedScores(user.Id, mode) : [];
                    if (best.Count == 0 && pinned.Count == 0) continue;
                    // Only worth a request once there is something to correct the bonus of.
                    var standing = wantBest && best.Count > 0 ? await opts.Osu.FetchStanding(user.Id, mode) : null;
                    scores.Add(Tracker.OnlineImport.ImportMode(db, opts.Tracker!.Beatmaps, id, mode, best, pinned, standing));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    failures.Add($"{ModeLabels[mode]} scores: {e.Message}");
                }
            }
            var added = scores.Sum(r => r.Added);
            var pins = scores.Sum(r => r.Pinned);
            if (wantBest && added > 0) done.Add(Plural(added, "score"));
            if (wantPinned && pins > 0) done.Add($"{pins} pinned");
            if (scores.Count > 0)
            {
                // The replays osu! wrote for these plays, where this computer still has them, first.
                var attached = await opts.Tracker!.AttachLocalReplays(id);
                if (attached > 0) done.Add($"{Plural(attached, "replay")} from this computer");
                // Then each priced here, built from what osu! handed over; a missing beatmap is downloaded now.
                var conversion = await ScoreEntry.ConvertImported(EntryDeps.Of(opts.Tracker, db, opts.Paths.DataDir, id, opts.Osu), id, download: true,
                    onDownload: (doneCount, total) => opts.Events.Broadcast("osu-progress", new { step = "beatmaps", done = doneCount, total }));
                if (conversion.Converted > 0) done.Add($"{conversion.Converted} priced here");
            }
        }

        // First, so every open page takes osu!'s medals as its starting point.
        if (wantMedals) opts.Events.Broadcast("medals", new { action = "import" });
        opts.Events.Broadcast("identity", new { linked = user.Id });
        if (opts.RankEvents is { } rank) _ = rank.CatchUp();
        opts.Events.Broadcast("settings", Settings.SettingsStore.Get(db, id, fallbacks));
        if (favouritesAdded > 0) opts.Events.Broadcast("favorites", new { action = "import" });
        if (scores.Count > 0) opts.Events.Broadcast("scores", new { action = "import" });
        await Json(context, IdentityAnswer(opts, id, new
        {
            ok = true,
            user,
            done,
            failures,
            favorites = new { found = favouritesFound, added = favouritesAdded },
            scores,
            settings = Settings.SettingsStore.Get(db, id, fallbacks),
        }));
    }

    /// <summary>
    /// "It's me": a play refused as another player's that is the owner's own, under a name osu!
    /// changed. Asked of osu! on the press; on a yes, every name of the account is kept and each play
    /// refused under one is judged again.
    /// </summary>
    private static async Task ItsMe(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker, JsonElement body)
    {
        var db = opts.Db;
        var profileId = Profiles.ActiveId(db);
        var id = Num(body, "id");
        if ((IsInteger(id) ? Tracker.Declined.DeclinedPlayer(db, profileId, RowId(id)) : null) is not { } player)
        {
            await Json(context, new { error = "that play is not in the list any more" }, 400);
            return;
        }
        try
        {
            var account = await Players.ConfirmSameAccount(player, tracker.PlayerIdentity,
                async query =>
                {
                    var user = await opts.Osu.LookupUser(query);
                    return new OsuAccount(user.Id, user.Username, user.PreviousUsernames);
                },
                e => e is NoSuchUser);
            if (account is null)
            {
                var owner = tracker.PlayerIdentity.DisplayName;
                await Json(context, new
                {
                    error = owner == ""
                        ? $"osu! cannot say whether {player} is you. If this play is yours, use Track anyway."
                        : $"osu! does not list {player} as a name of {owner}, the account signed in here. If this play is yours, use Track anyway.",
                }, 400);
                return;
            }
            var fallbacks = opts.Config.SettingsFallbacks();
            // The newest first, so the list's cap never costs the account just confirmed.
            Settings.SettingsStore.Update(db, profileId, JsonText.From(new
            {
                accountNames = new[] { account.Username }.Concat(account.PreviousUsernames).Concat(Settings.SettingsStore.Get(db, profileId, fallbacks).AccountNames).ToList(),
            }), fallbacks);
            var tracked = await tracker.RetrackOwnNames();
            await Json(context, new { ok = true, account = account.Username, tracked, declinedPlays = Tracker.Declined.Count(db, profileId) });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    }

    /* ------------------------------------------------------------- score entry */

    private static EntryDeps EntryFor(ServerOptions opts, Tracker.PlayTracker tracker, long profileId) =>
        EntryDeps.Of(tracker, opts.Db, opts.Paths.DataDir, profileId, opts.Osu);

    private static object EntryAnswer(Tracker.IngestOutcome? outcome) =>
        outcome is { Status: "added", Score: { } score } ? new { status = "added", score } : new { status = "already" };

    /// <summary>A score's link, checked: whose it is and whether it is here already, before anything is written.</summary>
    private static Task ScoreLinkCheck(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker, long profileId) => WithBody(context, async body =>
    {
        LinkPreview preview;
        try
        {
            preview = await ScoreEntry.CheckLink(EntryFor(opts, tracker, profileId), Str(body, "link"));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
            return;
        }
        await Json(context, preview);
    });

    /// <summary>
    /// A score imported from its link. The replay osu! wrote for it, if this computer still has it,
    /// takes the built one's place and is priced from it, so the pp announced is read back.
    /// </summary>
    private static Task ScoreLink(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker, long profileId) => WithBody(context, async body =>
    {
        try
        {
            var outcome = await ScoreEntry.ImportLink(EntryFor(opts, tracker, profileId), Str(body, "link"));
            if (outcome?.Score is not { } score)
            {
                await Json(context, EntryAnswer(outcome));
                return;
            }
            var attached = await tracker.AttachLocalReplays(profileId, [score.Id]);
            if (attached == 0)
            {
                await Json(context, new { status = "added", score, replay = false });
                return;
            }
            var pp = opts.Db.FirstRow("SELECT pp FROM scores WHERE id = ?", score.Id)?["pp"];
            opts.Events.Broadcast("scores", new { action = "import" });
            await Json(context, new { status = "added", score = score with { Pp = pp is null ? null : Convert.ToDouble(pp) }, replay = true });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    });

    private static Task BeatmapFind(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker, long profileId) => WithBody(context, async body =>
    {
        EntryBeatmap found;
        try
        {
            found = await ScoreEntry.Find(EntryFor(opts, tracker, profileId), Js.IsString(Js.Get(body, "md5"), out var md5) ? md5 : null, Str(body, "link"));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
            return;
        }
        await Json(context, found);
    });

    /// <summary>A score typed in by hand, written under whoever this profile is, as it knows itself.</summary>
    private static Task ManualScore(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker, long profileId) => WithBody(context, async body =>
    {
        try
        {
            var player = tracker.PlayerIdentity.DisplayName is { Length: > 0 } shown ? shown : Profiles.Get(opts.Db, profileId)?.Name ?? "";
            await Json(context, EntryAnswer(await ScoreEntry.Enter(EntryFor(opts, tracker, profileId), body, player)));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    });

    /// <summary>
    /// Recalculate every score of every profile: the imported best performances first, each built
    /// into a replay priced here (a beatmap not installed is downloaded), then the same run a new
    /// calculator starts by itself. Its progress and result reach the page through the tracker's events.
    /// </summary>
    private static async Task RecomputeEveryProfile(HttpContext context, ServerOptions opts, Tracker.PlayTracker tracker)
    {
        try
        {
            var converted = 0;
            foreach (var profile in Profiles.List(opts.Db))
            {
                converted += (await ScoreEntry.ConvertImported(EntryFor(opts, tracker, profile.Id), profile.Id, download: true,
                    onDownload: (done, total) => opts.Events.Broadcast("osu-progress", new { step = "beatmaps", done, total }))).Converted;
            }
            var result = await tracker.Recalculate(false);
            Console.WriteLine($"\n  recalculated {result.Updated} score(s) in every profile from their replays"
                + (result.Skipped > 0 ? $" ({result.Skipped} skipped)" : "")
                + (converted > 0 ? $", and priced {converted} imported from osu! here" : "") + "\n");
            await Json(context, new { ok = true, result.Considered, result.Updated, result.Skipped, result.GainedPp });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 409);
        }
    }
}
