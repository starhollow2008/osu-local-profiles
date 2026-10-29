using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Http;

/// <summary>
/// The endpoints that write, in the order src/http/server.ts answers them, and the request bodies
/// they read. Each refusal says what the Node app's says, word for word.
/// </summary>
internal static partial class Server
{
    /// <summary>Upload ceiling for an avatar or banner; anything larger is a mistake.</summary>
    private const int MaxUploadBytes = 8 * 1024 * 1024;

    /* ------------------------------------------------------------ request bodies */

    /// <summary>A request's body as text, as the Node app collected it: UTF-8, a byte-order mark kept.</summary>
    private static async Task<string> ReadText(HttpContext context)
    {
        using var buffer = new MemoryStream();
        await context.Request.Body.CopyToAsync(buffer, context.RequestAborted);
        return new UTF8Encoding(false).GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }

    /// <summary>
    /// <c>readBody</c>: <c>JSON.parse(raw || '{}')</c>, and anything but an object refused, since every
    /// handler reads named fields. Null when it was refused, the 400 already sent.
    /// </summary>
    private static async Task<JsonElement?> ReadJsonBody(HttpContext context)
    {
        var raw = await ReadText(context);
        if (JsonText.TryParse(raw.Length == 0 ? "{}" : raw, out var body) && body.ValueKind == JsonValueKind.Object) return body;
        await Json(context, new { error = "expected a JSON body" }, 400);
        return null;
    }

    /// <summary>A JSON body handed to its handler, and whatever the handler throws answered as a 500.</summary>
    private static async Task WithBody(HttpContext context, Func<JsonElement, Task> handler)
    {
        if (await ReadJsonBody(context) is not { } body) return;
        try
        {
            await handler(body);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
        }
    }

    /// <summary>
    /// A raw upload, capped: past <paramref name="max"/> bytes the request is answered 413 with
    /// <paramref name="tooLarge"/> and null is returned.
    /// </summary>
    private static async Task<byte[]?> ReadUpload(HttpContext context, long max, string tooLarge)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
        {
            if (buffer.Length + read > max)
            {
                await Json(context, new { error = tooLarge }, 413);
                return null;
            }
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    /// <summary><c>String(body[key] ?? '')</c>.</summary>
    private static string Str(JsonElement body, string key) =>
        Js.Get(body, key) is { ValueKind: not JsonValueKind.Null } v ? Js.ToJsString(v) : "";

    /// <summary><c>Number(body[key])</c>.</summary>
    private static double Num(JsonElement body, string key) => Js.ToNumber(Js.Get(body, key));

    private static bool IsTrue(JsonElement body, string key) => Js.Get(body, key) is { ValueKind: JsonValueKind.True };

    private static bool IsInteger(double n) => double.IsFinite(n) && n == Math.Floor(n);

    /// <summary>A whole number as a row id; one past what a row id can be finds no row, as in SQLite.</summary>
    private static long RowId(double n) => n >= long.MaxValue ? long.MaxValue : n <= long.MinValue ? long.MinValue : (long)n;

    private static object ImageAnswer(ServerOptions opts, long profileId)
    {
        var (hasAvatar, hasCover) = Identity.ImageState(opts.Paths.DataDir, profileId);
        return new { ok = true, hasAvatar, hasCover };
    }

    private static string? OriginOf(HttpRequest request) => request.Headers.Origin is { Count: > 0 } o ? o.ToString() : null;

    private static bool FromOwnPage(HttpContext context) => IsOwnPage(OriginOf(context.Request), context.Connection.LocalPort);

    private static string LocalTime(double at) =>
        DateTimeOffset.FromUnixTimeMilliseconds((long)at).ToLocalTime().ToString("G", CultureInfo.CurrentCulture);

    /* ------------------------------------------------------------------ handlers */

    /// <summary>
    /// Settings the page edits directly. The whole body is the patch; keys that are not settings
    /// are ignored. Plays turned away under a name just listed as yours are judged again.
    /// </summary>
    private static Task PostSettings(HttpContext context, ServerOptions opts, long profileId) => WithBody(context, body =>
    {
        var fallbacks = opts.Config.SettingsFallbacks();
        var before = Js.ToLower(string.Join("\n", SettingsStore.Get(opts.Db, profileId, fallbacks).OwnNames));
        var settings = SettingsStore.Update(opts.Db, profileId, body, fallbacks);
        opts.Events.Broadcast("settings", settings);
        if (Js.ToLower(string.Join("\n", settings.OwnNames)) != before && opts.Tracker is { } tracker)
        {
            _ = tracker.RetrackOwnNames().ContinueWith(task =>
            {
                if (task.IsCompletedSuccessfully)
                {
                    if (task.Result > 0) opts.Events.Broadcast("settings", SettingsStore.Get(opts.Db, Profiles.ActiveId(opts.Db), opts.Config.SettingsFallbacks()));
                }
                else
                {
                    Console.Error.WriteLine($"  Could not check plays under your names again: {task.Exception?.InnerException?.Message}");
                }
            }, TaskScheduler.Default);
        }
        return Json(context, new { ok = true, settings });
    });

    /// <summary>
    /// Start with the computer: asked of the system each time, since the entry it keeps is the
    /// answer. Changed only from the app's own page.
    /// </summary>
    private static async Task StartupSwitch(HttpContext context, ServerOptions opts)
    {
        var at = StartWithComputer.Where.Of(opts.Paths.InstallDir);
        if (context.Request.Method != "POST")
        {
            try
            {
                await Json(context, await StartWithComputer.State(at));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 500);
            }
            return;
        }
        if (!FromOwnPage(context))
        {
            await Json(context, new { error = "only this app's own page can change this" }, 403);
            return;
        }
        await WithBody(context, async body =>
        {
            if (Js.Get(body, "enabled") is not { ValueKind: JsonValueKind.True or JsonValueKind.False } enabled)
            {
                await Json(context, new { error = "enabled must be true or false" }, 400);
                return;
            }
            try
            {
                var state = await StartWithComputer.Set(enabled.ValueKind == JsonValueKind.True, at);
                await Json(context, new { ok = true, state.Available, state.Enabled });
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 400);
            }
        });
    }

    private static readonly string[] AppConfigSwitches = ["openBrowser", "sharedFavorites", "originalMetadata", "autoUpdate"];

    /// <summary>
    /// The install's own options. Only these keys, each only to a value of the right type: this
    /// writes the file the app needs to boot. Written into config.json read afresh, so a hand edit
    /// made while the app runs is not overwritten.
    /// </summary>
    private static Task PostAppConfig(HttpContext context, ServerOptions opts) => WithBody(context, async body =>
    {
        var patch = new Dictionary<string, JsonElement>();
        foreach (var key in AppConfigSwitches)
        {
            if (Js.Get(body, key) is not { } value) continue;
            if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                await Json(context, new { error = $"{key} must be true or false" }, 400);
                return;
            }
            patch[key] = value;
        }
        // Checked against the list: a language that does not exist would leave every string falling back forever.
        if (Js.Get(body, "language") is { } language)
        {
            if (!I18n.IsLocale(language))
            {
                await Json(context, new { error = $"{Js.ToJsString(language)} is not a language this app has" }, 400);
                return;
            }
            patch["language"] = language;
        }
        if (Js.Get(body, "font") is { } font)
        {
            if (!Js.IsString(font, out var name) || name is not ("nunito" or "system"))
            {
                await Json(context, new { error = "font must be nunito or system" }, 400);
                return;
            }
            patch["font"] = font;
        }
        if (patch.Count == 0)
        {
            await Json(context, new { error = "openBrowser must be true or false" }, 400);
            return;
        }

        var dataDir = opts.Paths.DataDir;
        var current = AppConfig.Load(dataDir);
        void Set(string key, JsonElement value)
        {
            current[key] = value;
            opts.Config[key] = value;
        }
        foreach (var key in new[] { "openBrowser", "language", "originalMetadata", "font" })
        {
            if (patch.TryGetValue(key, out var value)) Set(key, value);
        }
        if (patch.TryGetValue("sharedFavorites", out var shared))
        {
            Set("sharedFavorites", shared);
            // Merge or copy the lists now, so the next request already reads the right one.
            Favorites.SyncSharing(opts.Db, shared.ValueKind == JsonValueKind.True);
        }
        // Auto-update needs the check it acts on, so switching it on turns checking back on too.
        if (patch.TryGetValue("autoUpdate", out var autoUpdate))
        {
            Set("autoUpdate", autoUpdate);
            if (autoUpdate.ValueKind == JsonValueKind.True) Set("checkForUpdates", autoUpdate);
        }
        current.Save(dataDir);
        if (patch.ContainsKey("autoUpdate")) opts.Updater?.AutoUpdateChanged();
        var config = opts.Config.PageView();
        opts.Events.Broadcast("app-config", config);
        await Json(context, new { ok = true, config });
    });

    /// <summary>
    /// Where osu! is. Read by anyone; changed through the three verbs, one at a time, and a folder
    /// holding no osu! install refused with the reason.
    /// </summary>
    private static async Task OsuFolderRoute(HttpContext context, ServerOptions opts)
    {
        if (opts.Folders is not { } folders)
        {
            await Json(context, new { error = "this copy cannot change its osu! folders" }, 400);
            return;
        }
        if (context.Request.Method != "POST")
        {
            await Json(context, folders.List());
            return;
        }
        await WithBody(context, async body =>
        {
            if (IsTrue(body, "rescan"))
            {
                await Json(context, await folders.Rescan());
                return;
            }
            if (Js.IsString(Js.Get(body, "add"), out var add))
            {
                if (Js.Trim(add).Length == 0)
                {
                    await Json(context, new { error = "give a folder to add" }, 400);
                    return;
                }
                object answer;
                try
                {
                    answer = await folders.Add(Js.Trim(add));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    await Json(context, new { error = e.Message }, 400);
                    return;
                }
                await Json(context, answer);
                return;
            }
            if (Js.IsString(Js.Get(body, "remove"), out var remove))
            {
                await Json(context, folders.Remove(remove));
                return;
            }
            await Json(context, new { error = "expected add, remove or rescan" }, 400);
        });
    }

    /// <summary>
    /// Recalculate stored scores from their replays, confirmed. Every profile's (<c>all</c>) waits for
    /// osu!'s web API, which prices the scores imported from it first (phase 5, step 4).
    /// </summary>
    private static Task PostRecompute(HttpContext context, ServerOptions opts, PlayTracker tracker) => WithBody(context, async body =>
    {
        if (!IsTrue(body, "confirm"))
        {
            await Json(context, new { error = "recomputing requires an explicit confirmation" }, 400);
            return;
        }
        if (IsTrue(body, "all"))
        {
            await RecomputeEveryProfile(context, opts, tracker);
            return;
        }
        RecomputeResult result;
        try
        {
            var lastReported = -1.0;
            result = await tracker.RecomputeAll(true, (done, total) =>
            {
                // One event per percent: the page cannot draw a flood of them anyway.
                var percent = total == 0 ? 100 : Math.Floor((double)done / total * 100);
                if (percent == lastReported) return;
                lastReported = percent;
                opts.Events.Broadcast("recompute-progress", new { done, total, percent });
            });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
            return;
        }
        opts.Events.Broadcast("recompute", result);
        Console.WriteLine($"\n  recomputed {result.Updated} score(s) from their replays{(result.Skipped > 0 ? $" ({result.Skipped} skipped)" : "")}\n");
        await Json(context, new { ok = true, result.Considered, result.Updated, result.Skipped, result.GainedPp });
    });

    /// <summary>An avatar or banner: a raw PUT, capped, its bytes sniffed rather than its type trusted.</summary>
    private static async Task PutImage(HttpContext context, ServerOptions opts, long profileId, string kind)
    {
        if (await ReadUpload(context, MaxUploadBytes, "that image is too large (8MB max)") is not { } bytes) return;
        if (Identity.SniffImage(bytes) is not { } extension)
        {
            await Json(context, new { error = "that file is not a PNG, JPEG, WebP or GIF" }, 400);
            return;
        }
        try
        {
            Identity.SaveImage(opts.Paths.DataDir, profileId, kind, bytes, extension);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
            return;
        }
        opts.Events.Broadcast("identity", new { kind });
        await Json(context, ImageAnswer(opts, profileId));
    }

    /// <summary>An image pasted or dropped into the me! editor, named by its content and served back by that name.</summary>
    private static async Task PutAboutImage(HttpContext context, ServerOptions opts, long profileId)
    {
        if (await ReadUpload(context, MaxUploadBytes, "that image is too large (8MB max)") is not { } bytes) return;
        string? saved;
        try
        {
            saved = Identity.SaveAboutImage(opts.Paths.DataDir, profileId, bytes);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
            return;
        }
        if (saved is null) await Json(context, new { error = "that file is not a PNG, JPEG, WebP or GIF" }, 400);
        else await Json(context, new { ok = true, url = saved });
    }

    /// <summary>
    /// What became of a replay, as the Node app answers it: each outcome with only its own fields.
    /// </summary>
    internal static object OutcomeAnswer(IngestOutcome o) => o switch
    {
        { Status: "added" } => new { status = o.Status, score = o.Score },
        { Status: "filtered" } => new { status = o.Status, criterion = o.Criterion, title = o.Title, titleOriginal = o.TitleOriginal },
        { Reason: "another-player" } => new { status = o.Status, reason = o.Reason, player = o.Player, title = o.Title, titleOriginal = o.TitleOriginal },
        _ => new { status = o.Status, reason = o.Reason },
    };

    /// <summary>
    /// A replay file chosen or dropped into Import past plays, one per request: a copy kept in
    /// data/replays and imported through the same checks as any past play, then let go of unless a
    /// score or a play not tracked points at it. <c>?applyFilter=0</c> is the dialog's box unticked.
    /// </summary>
    private static async Task PostReplay(HttpContext context, ServerOptions opts, PlayTracker tracker)
    {
        if (await ReadUpload(context, UploadedReplays.MaxReplayBytes, "that file is too large to be a replay") is not { } bytes) return;
        try
        {
            if (UploadedReplays.Store(opts.Paths.DataDir, bytes) is not { } file)
            {
                await Json(context, new { error = "that file is not an osu! replay" }, 400);
                return;
            }
            var applyFilter = !(context.Request.Query.TryGetValue("applyFilter", out var asked) && asked.Count > 0 && asked[0] == "0");
            var result = await tracker.ImportReplayFile(file, applyFilter);
            UploadedReplays.Release(opts.Db, file);
            await Json(context, OutcomeAnswer(result));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
        }
    }

    /// <summary>
    /// Identity: the actions that need no network. Looking up, linking and importing an osu!
    /// account wait for osu!'s web API (phase 5, step 4).
    /// </summary>
    private static Task PostIdentity(HttpContext context, ServerOptions opts, long id) => WithBody(context, async body =>
    {
        var action = Str(body, "action");
        var fallbacks = opts.Config.SettingsFallbacks();
        try
        {
            switch (action)
            {
                // What can be offered without touching the network.
                case "suggestions":
                {
                    var settings = SettingsStore.Get(opts.Db, id, fallbacks);
                    await Json(context, new
                    {
                        sessions = Session.DetectLocalSessions(opts.Installs),
                        linked = settings.LinkedUserId > 0 ? new { id = settings.LinkedUserId, username = settings.LinkedUsername } : null,
                    });
                    return;
                }
                case "lookup":
                    await IdentityLookup(context, opts, body);
                    return;
                case "link":
                    await IdentityLink(context, opts, id, body);
                    return;
                case "import":
                    await IdentityImport(context, opts, id, body);
                    return;
                case "unlink":
                    SettingsStore.Update(opts.Db, id, JsonText.From(new { linkedUserId = 0, linkedUsername = "" }), fallbacks);
                    opts.Events.Broadcast("identity", new { linked = 0 });
                    await Json(context, new { ok = true, settings = SettingsStore.Get(opts.Db, id, fallbacks) });
                    return;
                case "clear-image":
                {
                    var kind = Str(body, "kind");
                    if (kind is not ("avatar" or "cover"))
                    {
                        await Json(context, new { error = "kind must be \"avatar\" or \"cover\"" }, 400);
                        return;
                    }
                    Identity.ClearImage(opts.Paths.DataDir, id, kind);
                    opts.Events.Broadcast("identity", new { kind });
                    await Json(context, ImageAnswer(opts, id));
                    return;
                }
                default:
                    await Json(context, new { error = $"unknown action {JsonText.Stringify(action)}" }, 400);
                    return;
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    });

    /// <summary>
    /// Pinning, ordering pins, and removing a score from the profile: a hide, never a delete,
    /// until it is deleted for good from the removed list, its key kept so no import brings it back.
    /// </summary>
    private static Task PostScores(HttpContext context, ServerOptions opts, long profileId) => WithBody(context, async body =>
    {
        var db = opts.Db;
        var action = Str(body, "action");
        // An unfinished play is a row of incomplete_plays, and a collapsed one is several.
        var kind = Js.IsString(Js.Get(body, "kind"), out var k) && k == "incomplete" ? "incomplete" : "score";
        var listed = Js.Get(body, "ids") is { ValueKind: JsonValueKind.Array } list ? list.EnumerateArray().Select(e => Js.ToNumber(e)).ToList() : null;
        var ids = listed ?? [Num(body, "id")];
        try
        {
            if (kind == "incomplete" && action is "hide" or "restore")
            {
                Scores.SetIncompleteHidden(db, profileId, ids, action == "hide");
            }
            else if (action == "reorder")
            {
                Scores.ReorderPins(db, profileId, listed ?? []);
            }
            else if (action == "list-hidden")
            {
                await Json(context, new { hidden = Scores.Hidden(db, profileId) });
                return;
            }
            else if (action is "delete" or "delete-all-removed")
            {
                // For good: see DeleteRemoved, and why the key outlives the row.
                var deleted = Scores.DeleteRemoved(db, profileId, action == "delete" ? ids : null, Js.Now(), kind);
                opts.Events.Broadcast("scores", new { action });
                await Json(context, new { ok = true, deleted, hiddenScores = Scores.HiddenCount(db, profileId) });
                return;
            }
            else
            {
                Scores.ApplyAction(db, profileId, Num(body, "id"), action);
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
            return;
        }
        opts.Events.Broadcast("scores", new { action });
        await Json(context, new { ok = true, hiddenScores = Scores.HiddenCount(db, profileId) });
    });

    /// <summary>
    /// Plays the app turned away: deleted for good, one or all, or Track anyway for one. "It's me"
    /// asks osu! and waits for its web API (phase 5, step 4).
    /// </summary>
    private static Task PostDeclined(HttpContext context, ServerOptions opts, PlayTracker tracker) => WithBody(context, async body =>
    {
        var db = opts.Db;
        var action = Str(body, "action");
        if (action is "delete" or "delete-all")
        {
            try
            {
                var profileId = Profiles.ActiveId(db);
                var deleted = Declined.Delete(db, profileId, action == "delete" ? [Num(body, "id")] : null);
                await Json(context, new { ok = true, deleted, declinedPlays = Declined.Count(db, profileId) });
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 400);
            }
            return;
        }
        if (action == "its-me")
        {
            await ItsMe(context, opts, tracker, body);
            return;
        }
        if (action != "track")
        {
            await Json(context, new { error = $"unknown action {JsonText.Stringify(action)}" }, 400);
            return;
        }
        var id = Num(body, "id");
        if (!IsInteger(id))
        {
            await Json(context, new { error = "a play id is needed" }, 400);
            return;
        }
        try
        {
            // A play tracked this way is announced by the tracker, as a live one is.
            var result = await tracker.TrackAnyway(RowId(id));
            await Json(context, new
            {
                ok = true,
                result = result.Kind is null ? (object)new { status = result.Status } : new { status = result.Status, kind = result.Kind },
                declinedPlays = Declined.Count(db, Profiles.ActiveId(db)),
            });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    });

    /// <summary>
    /// Every play erased and tracking restarted from now, confirmed. Moving tracking_since forward is
    /// what makes it a fresh profile: the watcher would otherwise accept the old replays again.
    /// </summary>
    private static async Task ResetProfile(HttpContext context, ServerOptions opts, PlayTracker? tracker, long profileId)
    {
        var raw = await ReadText(context);
        // Anything that is not `{"confirm": true}`, unreadable included, is unconfirmed.
        if (!JsonText.TryParse(raw, out var parsed) || Js.Get(parsed, "confirm") is not { ValueKind: JsonValueKind.True })
        {
            await Json(context, new { error = "reset requires an explicit confirmation" }, 400);
            return;
        }
        double deleted, trackingSince;
        try
        {
            (deleted, trackingSince) = ProfileData.Reset(opts.Db, profileId);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
            return;
        }
        tracker?.SetTrackingSince(trackingSince);
        opts.Events.Broadcast("reset", new { deleted, trackingSince });
        Console.WriteLine($"\n  profile reset -- {Js.NumberToString(deleted)} play(s) erased, tracking from now\n");
        await Json(context, new { ok = true, deleted, trackingSince });
    }

    /// <summary>
    /// Import past plays, or count what an import would bring in. Nothing here runs by itself: the
    /// user picks a range and presses Import, and the progress goes out as <c>importing</c>.
    /// </summary>
    private static async Task PostBackfill(HttpContext context, ServerOptions opts, PlayTracker tracker, bool preview)
    {
        var raw = await ReadText(context);
        double since;
        double? until;
        bool confirmed, applyFilter;
        var sources = BackfillSources.ReplaysOnly;
        List<string>? installs = null;
        // JSON.parse, then reading fields: only a body that does not parse, or `null`, throws there.
        if (!JsonText.TryParse(raw, out var parsed) || parsed.ValueKind == JsonValueKind.Null)
        {
            await Json(context, new { error = "expected a JSON body with a \"since\" timestamp" }, 400);
            return;
        }
        since = Js.ToNumber(Js.Get(parsed, "since"));
        // The end of the range. Absent or null means now.
        until = Js.Get(parsed, "until") is { ValueKind: not JsonValueKind.Null } u ? Js.ToNumber(u) : null;
        confirmed = Js.Get(parsed, "confirm") is { ValueKind: JsonValueKind.True };
        // Absent means apply it, as an older page or a script expects.
        applyFilter = Js.Get(parsed, "applyFilter") is not { ValueKind: JsonValueKind.False };
        // Which kinds of past play: absent means replays alone, and a name not known is ignored.
        if (Js.Get(parsed, "sources") is { ValueKind: JsonValueKind.Array } named)
        {
            var names = named.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()).ToHashSet();
            sources = new BackfillSources(names.Contains("replays"), names.Contains("unfinished"), names.Contains("attempts"));
        }
        // Which osu! installs to look in, by root. Absent means every one.
        if (Js.Get(parsed, "installs") is { ValueKind: JsonValueKind.Array } roots)
        {
            installs = [.. roots.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)];
        }

        // 0 is every play on this computer, however old: the dialog's All.
        if (!double.IsFinite(since) || since < 0)
        {
            await Json(context, new { error = "\"since\" must be a millisecond timestamp" }, 400);
            return;
        }
        if (since > Js.Now())
        {
            await Json(context, new { error = "\"since\" is in the future" }, 400);
            return;
        }
        if (until is { } end)
        {
            if (!double.IsFinite(end))
            {
                await Json(context, new { error = "\"until\" must be a millisecond timestamp" }, 400);
                return;
            }
            if (end <= since)
            {
                await Json(context, new { error = "\"until\" must be after \"since\"" }, 400);
                return;
            }
            // An end still to come is the same range as one ending now.
            if (end >= Js.Now()) until = null;
        }
        if (!preview && !confirmed)
        {
            await Json(context, new { error = "importing requires an explicit confirmation" }, 400);
            return;
        }
        // One at a time: a second tab, or a press while a launch is catching up.
        if (!preview && tracker.ImportState.Active)
        {
            await Json(context, new { error = "an import is already running" }, 409);
            return;
        }
        if (installs is not null && !opts.Installs.Any(i => installs.Contains(i.Root)))
        {
            await Json(context, new { error = "choose at least one osu! install to look in" }, 400);
            return;
        }

        try
        {
            if (preview)
            {
                var (scan, log) = await tracker.PreviewBackfill(since, applyFilter, until, installs);
                // The candidate list carries absolute paths; the page only needs the counts.
                await Json(context, new
                {
                    since,
                    until,
                    scanned = scan.Scanned,
                    importable = scan.Importable,
                    duplicates = scan.Duplicates,
                    filtered = scan.Filtered,
                    starsUnchecked = scan.StarsUnchecked,
                    otherPlayers = scan.OtherPlayers,
                    earliest = scan.Earliest,
                    latest = scan.Latest,
                    log,
                });
                return;
            }
            var result = await tracker.RunBackfill(since, sources, applyFilter, "import", until, installs);
            opts.Events.Broadcast("backfill", result);
            Console.WriteLine($"\n  imported {result.Imported} past play(s) "
                + (since == 0 ? "from every play on this computer" : $"from {LocalTime(since)}")
                + (until is null ? "" : $" to {LocalTime(until.Value)}")
                + (result.Unfinished + result.Attempts > 0 ? $", and from osu!lazer's logs {result.Unfinished} unfinished and {result.Attempts} not submitted" : "")
                + (result.Filtered > 0 ? $" ({result.Filtered} declined by the tracking filter)" : "")
                + (result.OtherPlayers > 0 ? $" ({result.OtherPlayers} were set by other players)" : "") + "\n");
            await Json(context, result);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
        }
    }

    /// <summary><c>String(name ?? '')</c>, as a profile's name arrives from the page.</summary>
    private static string NameOf(JsonElement body) => Str(body, "name");

    /// <summary>
    /// Profiles: create (and switch to it at once: recording into the old one would be a trap),
    /// switch, rename, and delete, confirmed. Only one is live at a time.
    /// </summary>
    private static Task PostProfiles(HttpContext context, ServerOptions opts, PlayTracker tracker) => WithBody(context, async body =>
    {
        var db = opts.Db;
        var action = Str(body, "action");
        try
        {
            switch (action)
            {
                case "create":
                {
                    var profile = Profiles.Create(db, NameOf(body));
                    Profiles.SetActive(db, profile.Id);
                    await tracker.SwitchProfile(profile.Id, profile.TrackingSince);
                    opts.Events.Broadcast("profiles", new { active = profile.Id });
                    Console.WriteLine($"\n  new profile \"{profile.Name}\" -- tracking from now\n");
                    await Json(context, new { ok = true, profile, profiles = Profiles.List(db) });
                    return;
                }
                case "switch":
                {
                    var id = Num(body, "id");
                    Profiles.SetActive(db, id);
                    var profile = Profiles.Get(db, RowId(id))!;
                    await tracker.SwitchProfile(profile.Id, profile.TrackingSince);
                    opts.Events.Broadcast("profiles", new { active = profile.Id });
                    Console.WriteLine($"\n  now tracking \"{profile.Name}\"\n");
                    await Json(context, new { ok = true, profile, profiles = Profiles.List(db) });
                    return;
                }
                case "rename":
                {
                    var profile = Profiles.Rename(db, Num(body, "id"), NameOf(body));
                    opts.Events.Broadcast("profiles", new { active = Profiles.ActiveId(db) });
                    await Json(context, new { ok = true, profile, profiles = Profiles.List(db) });
                    return;
                }
                case "delete":
                {
                    if (!IsTrue(body, "confirm"))
                    {
                        await Json(context, new { error = "deleting a profile requires an explicit confirmation" }, 400);
                        return;
                    }
                    var id = Num(body, "id");
                    var name = IsInteger(id) && Profiles.Get(db, RowId(id)) is { } doomed ? doomed.Name : Js.NumberToString(id);
                    var (deletedScores, nextActive) = Profiles.Delete(db, id);
                    var next = Profiles.Get(db, nextActive)!;
                    await tracker.SwitchProfile(next.Id, next.TrackingSince);
                    opts.Events.Broadcast("profiles", new { active = next.Id });
                    Console.WriteLine($"\n  deleted profile \"{name}\" ({deletedScores} score(s))\n");
                    await Json(context, new { ok = true, deletedScores, nextActive, profiles = Profiles.List(db) });
                    return;
                }
                default:
                    await Json(context, new { error = $"unknown action {JsonText.Stringify(action)}" }, 400);
                    return;
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 400);
        }
    });

    /// <summary>Tracking on or off: <c>Boolean(body.enabled)</c>, and a body that cannot be read toggles it.</summary>
    private static async Task PostTracking(HttpContext context, ServerOptions opts, PlayTracker tracker)
    {
        var raw = await ReadText(context);
        var enabled = !tracker.IsTracking;
        if (JsonText.TryParse(raw, out var parsed) && parsed.ValueKind != JsonValueKind.Null) enabled = Js.Truthy(Js.Get(parsed, "enabled"));
        tracker.SetTracking(enabled);
        opts.Events.Broadcast("tracking", new { tracking = enabled });
        await Json(context, new { tracking = tracker.IsTracking });
    }
}
