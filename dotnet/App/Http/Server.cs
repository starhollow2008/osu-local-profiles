using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Http;

internal sealed class ServerOptions
{
    public required Database Db { get; init; }
    public required AppPaths Paths { get; init; }
    public required AppConfig Config { get; init; }
    public required int Port { get; init; }

    /// <summary>Stops the app, deliberately: the page's Quit. Null for a copy that cannot be stopped from the page.</summary>
    public Action? OnQuit { get; init; }

    /// <summary>Whether anything on this machine can say if a beatmap is ranked: lazer's online.db.</summary>
    public bool StatusKnown { get; init; } = true;

    /// <summary>The osu! installs found at the start.</summary>
    public IReadOnlyList<Clients.OsuInstall> Installs { get; init; } = [];

    /// <summary>What watches osu! and writes its plays; null in tests that need none, where nothing is tracked.</summary>
    public Tracker.PlayTracker? Tracker { get; init; }

    /// <summary>
    /// The calculator a copy with no tracker answers with; null when it could not be loaded. A tracker
    /// has its own, which <see cref="PpSource"/> can switch.
    /// </summary>
    public OfficialCalculator? Calculator { get; init; }

    /// <summary>What prices scores now: the tracker's calculator when there is a tracker.</summary>
    public string? CalculatorVersion => Tracker is { } t ? t.CalculatorVersion : Calculator?.Version;

    /// <summary>
    /// Settings, pp calculator: the player's osu! source or the release (roadmap 5.70). Null where the
    /// page cannot offer it at all.
    /// </summary>
    public PpSource? PpSource { get; init; }

    /// <summary>Started by the tray launcher, as <c>/api/state</c> tells the page.</summary>
    public bool FromTray { get; init; }

    /// <summary>osu!'s website, asked only because a button was pressed; replaced in tests.</summary>
    public Clients.OsuWeb Osu { get; init; } = Clients.OsuWeb.Shared;

    /// <summary>The live feed every open page listens to.</summary>
    public LiveFeed Events { get; init; } = new();

    /// <summary>Where osu! is, and how to change the answer; null in a copy that cannot change its osu! folders.</summary>
    public Clients.OsuFolders? Folders { get; init; }

    /// <summary>
    /// Stop the app for its launcher to start it again, which is how a restored backup is applied.
    /// Null when nothing would start it again, and the page then asks for a restart instead.
    /// </summary>
    public Action? OnRestart { get; init; }

    /// <summary>The update check and the update itself; null where nothing checks (the tests).</summary>
    public Update.Updater? Updater { get; init; }

    /// <summary>
    /// Exit with this code once an update is handed to its swapper, which waits for this process to
    /// end. Null where nothing may stop the process (the tests).
    /// </summary>
    public Action<int>? OnUpdateExit { get; init; }

    /// <summary>Asks osu! for the profile's rank events, made with the server when it has a tracker.</summary>
    internal RankEventWatcher? RankEvents { get; set; }

    /// <summary>The cache behind /api/profile, made with the server.</summary>
    internal ProfileCache? Cache { get; set; }
}

/// <summary>
/// The HTTP API and the page: src/http/server.ts. Requests are answered by one handler that reads
/// like the TypeScript's chain of <c>if (url.pathname === ...)</c>, so each endpoint can be
/// compared with the one it was ported from.
/// </summary>
internal static partial class Server
{
    /// <summary>What <c>/api/app</c> calls this app, so a stranger on the same port is never taken for it.</summary>
    public const string AppId = "osu-local-profiles";

    public static WebApplication Build(ServerOptions opts)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            Args = [],
            ContentRootPath = opts.Paths.InstallDir,
        });
        builder.Logging.ClearProviders();
        // Ctrl+C, signals and the launcher are the app's to handle (Program.cs), so that a deliberate
        // stop can be told from the system stopping it.
        builder.Services.AddSingleton<IHostLifetime, AppLifetime>();
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            /*
             * Every interface, dual-stack, as Node's listen(port) does, and every non-loopback
             * request refused in the handler. Not bound to 127.0.0.1: that drops IPv6 loopback,
             * and on Windows `localhost` resolves to ::1 first (docs/architecture.md).
             */
            kestrel.ListenAnyIP(opts.Port);
            // Each upload has its own ceiling, checked as it arrives (a backup's is 1 GB).
            kestrel.Limits.MaxRequestBodySize = null;
        });
        opts.Cache ??= new ProfileCache(opts.Db);
        // A newer release found while the app runs, or a download finishing: the page follows live.
        if (opts.Updater is { } updater) updater.Changed += (_, found) => opts.Events.Broadcast("update", StateApi.UpdateView(opts, found));
        // A build from the player's osu! source, or a switch: what Settings shows, as it happens.
        if (opts.PpSource is { } ppSource) ppSource.Changed += state => opts.Events.Broadcast("pp-source", state);
        if (opts.Tracker is { } tracker)
        {
            opts.Events.Follow(tracker);
            /*
             * Where the profile's plays placed on osu!'s leaderboards: asked once now, and a while after
             * each play osu! could rank. Nothing at all without a linked account of the player's own,
             * and every request waits its turn at the gate.
             */
            var db = opts.Db;
            var rank = new RankEventWatcher(db, () => Profiles.ActiveId(db), () => tracker.PlayerIdentity, opts.Osu,
                _ => opts.Events.Broadcast("scores", new { action = "rank-events" }));
            opts.RankEvents = rank;
            tracker.Score += score => rank.Played(score.Client, score.Grade);
            _ = rank.CatchUp();
        }
        var app = builder.Build();
        app.Run(context => Handle(context, opts));
        return app;
    }

    /// <summary>
    /// Is this request coming from the machine the app runs on? Both loopback families, and an
    /// IPv4 loopback reported over a dual-stack socket as <c>::ffff:127.0.0.1</c>.
    /// </summary>
    public static bool IsLocal(IPAddress? remote)
    {
        if (remote is null) return false;
        if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
        return IPAddress.IsLoopback(remote);
    }

    /// <summary>
    /// Whether a request's <c>Origin</c> is this app's own page (src/instance.ts). A request with no
    /// Origin is not a web page (the tray launcher, curl) and is let through.
    /// </summary>
    public static bool IsOwnPage(string? origin, int? port)
    {
        if (origin is null) return true;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var url)) return false;
        var host = url.Host.ToLowerInvariant();
        var local = host is "localhost" or "[::1]" || host.StartsWith("127.", StringComparison.Ordinal);
        return url.Scheme == "http" && local && url.Port == port;
    }

    private static async Task Json(HttpContext context, object? body, int status = 200)
    {
        var response = context.Response;
        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        response.Headers.CacheControl = "no-store";
        await response.WriteAsync(JsonText.Stringify(body));
    }

    private static Task Text(HttpContext context, int status, string text, string? contentType = "text/plain; charset=utf-8")
    {
        context.Response.StatusCode = status;
        if (contentType is not null) context.Response.ContentType = contentType;
        return context.Response.WriteAsync(text);
    }

    private static async Task Handle(HttpContext context, ServerOptions opts)
    {
        var request = context.Request;
        var pathname = request.Path.Value is { Length: > 0 } p ? p : "/";
        var method = request.Method;

        /*
         * Refuse anyone who is not on this machine. There is no switch: the page can reset a
         * profile, delete one and remove scores, and none of those endpoints asks who is calling.
         */
        if (!IsLocal(context.Connection.RemoteIpAddress))
        {
            await Text(context, 403, "osu! local profiles only answers the machine it runs on.\n");
            return;
        }

        var db = opts.Db;

        long Current() => Profiles.ActiveId(db);
        ProfileSettings SettingsFor(long profileId) => SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());

        // Which app this is: asked by a second start, and polled by the tray launcher.
        if (pathname == "/api/app")
        {
            await Json(context, new
            {
                app = AppId,
                version = opts.Paths.Version(),
                pid = Environment.ProcessId,
                tracking = opts.Tracker?.IsTracking ?? false,
                // The tray launcher polls this, and offers the update from its menu.
                update = opts.Updater?.OfferedVersion(),
                // Downloading and installing now, for the tray's status line.
                updating = opts.Updater?.State().Applying ?? false,
            });
            return;
        }

        /*
         * Quit, from the page. Answered first and stopped after, so the page hears that it worked.
         * Refused for another website's page: one line of script there must not stop the app.
         */
        if (pathname == "/api/quit" && method == "POST")
        {
            var origin = request.Headers.Origin is { Count: > 0 } o ? o.ToString() : null;
            if (!IsOwnPage(origin, context.Connection.LocalPort))
            {
                await Json(context, new { error = "only this app's own page can stop it" }, 403);
                return;
            }
            if (opts.OnQuit is not { } quit)
            {
                await Json(context, new { error = "this copy cannot be stopped from the page" }, 400);
                return;
            }
            context.Response.OnCompleted(async () =>
            {
                await Task.Delay(250);
                quit();
            });
            await Json(context, new { ok = true });
            return;
        }

        if (pathname == "/api/state")
        {
            await Json(context, StateApi.Answer(opts, Current(), opts.FromTray));
            return;
        }

        // The welcome, left: every way out of it ends it for good, so there is nothing to send but that.
        if (pathname == "/api/welcome" && method == "POST")
        {
            ProfileData.DismissWelcome(db);
            await Json(context, new { ok = true });
            return;
        }

        if (pathname == "/api/profile")
        {
            await Json(context, ProfileApi.Answer(request, opts, opts.Cache!, Current()));
            return;
        }

        // This profile's avatar or banner, served only if it has one. `?profile=` names another
        // profile's, for a score page showing whose score it is.
        var image = ImageRoute().Match(pathname);
        if (image.Success && method != "PUT")
        {
            var asked = Js.StringToNumber(request.Query.TryGetValue("profile", out var profileParam) && profileParam.Count > 0 ? profileParam[0] ?? "" : "");
            var imageProfile = double.IsFinite(asked) && asked == Math.Floor(asked) && Profiles.Get(db, (long)asked) is not null
                ? (long)asked
                : Current();
            var file = Identity.FindImage(opts.Paths.DataDir, imageProfile, image.Groups[1].Value);
            if (file is null || !File.Exists(file))
            {
                await Text(context, 404, "not found", "text/plain");
                return;
            }
            await SendFile(context, file);
            return;
        }

        var scoreRoute = ScoreRoute().Match(pathname);
        if (scoreRoute.Success && method is "GET" or "HEAD")
        {
            var number = Js.StringToNumber(scoreRoute.Groups[1].Value);
            var id = number >= long.MaxValue ? long.MaxValue : (long)number;
            // Answered as the profile that owns the score, so its link outlives a profile switch.
            var owner = Scores.Owner(db, id) is { } ownerId ? Profiles.Get(db, ownerId) : null;
            if (owner is null)
            {
                await Json(context, new { error = $"there is no score {Js.NumberToString(number)}" }, 404);
                return;
            }

            if (!scoreRoute.Groups[2].Success)
            {
                var ownerSettings = SettingsFor(owner.Id);
                // A score priced before breakdowns were kept is recalculated here in the Node app;
                // that waits for the pp helper (phase 3).
                if (Scores.Detail(db, owner.Id, id, Eligibility.Of(ownerSettings, opts.StatusKnown)) is not { } detail)
                {
                    await Json(context, new { error = $"there is no score {Js.NumberToString(number)}" }, 404);
                    return;
                }
                var (hasAvatar, hasCover) = Identity.ImageState(opts.Paths.DataDir, owner.Id);
                await Json(context, new
                {
                    score = detail,
                    // What prices scores now, so the card can say when this one came from another.
                    calculator = opts.CalculatorVersion,
                    owner = new
                    {
                        id = owner.Id,
                        name = owner.Name,
                        country = ownerSettings.Country,
                        avatar = hasAvatar ? $"/api/image/avatar?profile={owner.Id}" : null,
                        // None of its own: the card shows osu-web's default banner.
                        cover = hasCover ? $"/api/image/cover?profile={owner.Id}" : null,
                        active = owner.Id == Current(),
                        tracking = owner.Id == Current() && (opts.Tracker?.IsTracking ?? false),
                    },
                });
                return;
            }

            if (scoreRoute.Groups[2].Value == "/replay")
            {
                var (path, fileName, error) = Scores.ReplayDownload(db, owner.Id, id, owner.Name);
                FileInfo? info = null;
                if (error is null)
                {
                    try
                    {
                        info = new FileInfo(path!);
                        if (!info.Exists) info = null;
                    }
                    catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                    {
                        info = null;
                    }
                }
                if (error is not null || info is null)
                {
                    await Json(context, new { error = error ?? "the replay could not be read" }, 404);
                    return;
                }
                var response = context.Response;
                response.StatusCode = 200;
                // osu-web's own type for a replay download.
                response.ContentType = "application/x-osu-replay";
                response.ContentLength = info.Length;
                response.Headers.ContentDisposition = Scores.AttachmentHeader(fileName!);
                response.Headers.CacheControl = "no-store";
                if (method == "HEAD") return;
                await response.SendFileAsync(info.FullName);
                return;
            }
            /*
             * The card as a PNG: the score's own page, rendered by an installed browser at osu-web's
             * 1000px with the page's controls taken off (?export=1), queued behind any other capture.
             */
            if (scoreRoute.Groups[2].Value == "/screenshot")
            {
                var play = Scores.Detail(db, owner.Id, id, Eligibility.Vanilla);
                byte[] png;
                try
                {
                    png = await Screenshot.Queued(() => Screenshot.Capture($"http://127.0.0.1:{OwnPort(context, opts)}/scores/{id}?export=1", width: 1000, selector: "#scoreCard"));
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    await Json(context, new { error = e.Message }, 503);
                    return;
                }
                // Named as its replay would be, so the two files sort side by side.
                var name = Scores.ReplayFileName(owner.Name, play?.Artist, play?.Title, play?.Creator?.ToString(), play?.Version?.ToString(),
                    play is null ? Js.Now() : Convert.ToDouble(play.PlayedAt))[..^4] + ".png";
                var response = context.Response;
                response.StatusCode = 200;
                response.ContentType = "image/png";
                response.ContentLength = png.Length;
                response.Headers.ContentDisposition = Scores.AttachmentHeader(name);
                response.Headers.CacheControl = "no-store";
                if (method == "GET") await response.Body.WriteAsync(png);
                return;
            }
        }

        if (pathname == "/api/settings")
        {
            if (method != "POST") await Json(context, new { settings = SettingsFor(Current()) });
            else await PostSettings(context, opts, Current());
            return;
        }

        if (pathname == "/api/startup")
        {
            await StartupSwitch(context, opts);
            return;
        }

        if (pathname == "/api/app-config")
        {
            if (method != "POST") await Json(context, new { config = opts.Config.PageView() });
            else await PostAppConfig(context, opts);
            return;
        }

        if (pathname == "/api/pp-source")
        {
            await PpSourceRoute(context, opts);
            return;
        }

        if (pathname == "/api/installs")
        {
            await OsuFolderRoute(context, opts);
            return;
        }

        // Everything below that needs the tracker: a copy without one tracks and imports nothing.
        async Task<PlayTracker?> TrackerOrRefuse()
        {
            if (opts.Tracker is { } t) return t;
            await Json(context, new { error = "this copy tracks nothing" }, 503);
            return null;
        }

        if (pathname == "/api/recompute" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostRecompute(context, opts, t);
            return;
        }

        if (image.Success && method == "PUT")
        {
            await PutImage(context, opts, Current(), image.Groups[1].Value);
            return;
        }

        if (pathname == "/api/about-image" && method == "PUT")
        {
            await PutAboutImage(context, opts, Current());
            return;
        }

        if (pathname == "/api/replays" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostReplay(context, opts, t);
            return;
        }

        if (pathname == "/api/score-link/check" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await ScoreLinkCheck(context, opts, t, Current());
            return;
        }

        if (pathname == "/api/score-link" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await ScoreLink(context, opts, t, Current());
            return;
        }

        if (pathname == "/api/beatmaps/search" && method == "GET")
        {
            if (await TrackerOrRefuse() is { } t)
            {
                var q = request.Query.TryGetValue("q", out var asked) && asked.Count > 0 ? asked[0] ?? "" : "";
                await Json(context, new { beatmaps = ScoreEntry.Search(EntryFor(opts, t, Current()), q) });
            }
            return;
        }

        if (pathname == "/api/beatmaps/find" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await BeatmapFind(context, opts, t, Current());
            return;
        }

        if (pathname == "/api/manual-score" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await ManualScore(context, opts, t, Current());
            return;
        }

        if (pathname == "/api/identity" && method == "POST")
        {
            await PostIdentity(context, opts, Current());
            return;
        }

        if (pathname == "/api/scores" && method == "POST")
        {
            await PostScores(context, opts, Current());
            return;
        }

        if (pathname == "/api/declined" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostDeclined(context, opts, t);
            return;
        }

        if (pathname == "/api/favorites" && method == "POST")
        {
            await PostFavorites(context, opts, Current());
            return;
        }

        // A full-page PNG, rendered by an already-installed Chrome or Edge. Nothing is bundled.
        if (pathname == "/api/screenshot")
        {
            byte[] png;
            try
            {
                png = await Screenshot.Queued(() => Screenshot.Capture($"http://127.0.0.1:{OwnPort(context, opts)}/?export=1"));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 503);
                return;
            }
            // The day in UTC, as toISOString writes it, and the name with anything odd made a dash.
            var stamp = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var name = $"{NotWordChars().Replace(Profiles.Get(db, Current())!.Name, "-")}-{stamp}.png";
            context.Response.StatusCode = 200;
            context.Response.ContentType = "image/png";
            context.Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
            context.Response.Headers.CacheControl = "no-store";
            await context.Response.Body.WriteAsync(png);
            return;
        }

        if (pathname == "/api/profile/reset" && method == "POST")
        {
            await ResetProfile(context, opts, opts.Tracker, Current());
            return;
        }

        if (pathname is "/api/backfill" or "/api/backfill/preview" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostBackfill(context, opts, t, preview: pathname.EndsWith("/preview", StringComparison.Ordinal));
            return;
        }

        if (pathname == "/api/profiles" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostProfiles(context, opts, t);
            return;
        }

        if (pathname == "/api/data-folder/open" && method == "POST")
        {
            if (!FromOwnPage(context))
            {
                await Json(context, new { error = "only this app's own page can open the data folder" }, 403);
                return;
            }
            Browser.OpenFolder(opts.Paths.DataDir);
            await Json(context, new { ok = true });
            return;
        }

        if (pathname == "/api/tracking" && method == "POST")
        {
            if (await TrackerOrRefuse() is { } t) await PostTracking(context, opts, t);
            return;
        }

        if (pathname == "/api/events")
        {
            await opts.Events.Serve(context);
            return;
        }

        if (pathname == "/api/declined" && method == "GET")
        {
            await Json(context, new { plays = Declined.List(db, Current()) });
            return;
        }

        if (pathname == "/api/update" || pathname.StartsWith("/api/update/", StringComparison.Ordinal))
        {
            if (await UpdateRoute(context, opts, pathname)) return;
        }

        if (pathname == "/api/backup")
        {
            await BackupEverything(context, opts);
            return;
        }

        if (pathname is "/api/restore" or "/api/restore/apply" && await Restore(context, opts, pathname)) return;

        if (pathname == "/api/data-folder" && method == "GET")
        {
            await Json(context, new { path = opts.Paths.DataDir });
            return;
        }

        if (pathname is "/api/export/scores.csv" or "/api/export/profile.xlsx" && method == "GET")
        {
            await ExportApi.Spreadsheet(context, opts, Current(), csv: pathname.EndsWith(".csv", StringComparison.Ordinal));
            return;
        }

        if (pathname == "/api/export")
        {
            await ExportApi.Json(context, opts, Current());
            return;
        }

        // An image in a profile's me!, saved by the page; never anything else in data/.
        if (method is "GET" or "HEAD" && Identity.AboutImageFile(opts.Paths.DataDir, pathname) is { } aboutImage)
        {
            byte[] bytes;
            try
            {
                bytes = await File.ReadAllBytesAsync(aboutImage.File);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                await Text(context, 404, "not found", "text/plain");
                return;
            }
            context.Response.StatusCode = 200;
            context.Response.ContentType = aboutImage.Mime;
            // Named by their content's hash, so a name never comes to mean another image.
            context.Response.Headers.CacheControl = "max-age=31536000, immutable";
            await context.Response.Body.WriteAsync(bytes);
            return;
        }

        await ServeStatic(context, opts.Paths.WebRoot, pathname);
    }

    /* ----------------------------------------------------------- static files */

    private static readonly Dictionary<string, string> Mime = new(StringComparer.Ordinal)
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".ico"] = "image/x-icon",
        [".woff2"] = "font/woff2",
        // The translations in web/i18n/, fetched by the page one language at a time.
        [".json"] = "application/json; charset=utf-8",
    };

    /// <summary><c>/[^\w.-]+/g</c>, JavaScript's ASCII <c>\w</c>.</summary>
    [GeneratedRegex("[^A-Za-z0-9_.-]+")]
    private static partial Regex NotWordChars();

    /// <summary>The port this app's pages are on, for a browser to load one: the configured one, or the one asked on.</summary>
    private static int OwnPort(HttpContext context, ServerOptions opts) => opts.Port > 0 ? opts.Port : context.Connection.LocalPort;

    [GeneratedRegex(@"^/api/image/(avatar|cover)\z")]
    private static partial Regex ImageRoute();

    [GeneratedRegex(@"^/api/scores/([0-9]+)(/replay|/screenshot)?\z")]
    private static partial Regex ScoreRoute();

    /// <summary>A file from disk with the type its extension says and revalidation on every load.</summary>
    private static async Task SendFile(HttpContext context, string file)
    {
        byte[] bytes;
        try
        {
            bytes = await File.ReadAllBytesAsync(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            await Text(context, 404, "not found", "text/plain");
            return;
        }
        context.Response.StatusCode = 200;
        context.Response.ContentType = Mime.GetValueOrDefault(Path.GetExtension(file).ToLowerInvariant(), "application/octet-stream");
        context.Response.Headers.CacheControl = "no-cache";
        await context.Response.Body.WriteAsync(bytes);
    }

    /// <summary>A score's own page, <c>/scores/&lt;id&gt;</c>: ASCII digits only, as JavaScript's <c>\d</c>.</summary>
    [GeneratedRegex(@"^/scores/[0-9]+/?\z")]
    private static partial Regex ScorePage();

    private static async Task ServeStatic(HttpContext context, string webRoot, string pathname)
    {
        var rel = pathname == "/" ? "index.html"
            : ScorePage().IsMatch(pathname) ? "score.html"
            : pathname.TrimStart('/');

        // The path arrives decoded, so a %5C is a backslash by now: resolve it and check it stays
        // inside web/, separator included, so a sibling folder named web-something is outside.
        var root = Path.GetFullPath(webRoot);
        var file = Path.GetFullPath(Path.Combine(root, rel));
        if (rel.Contains(':') || !file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            await Text(context, 403, "forbidden", contentType: null);
            return;
        }
        if (!File.Exists(file))
        {
            await Text(context, 404, "not found", "text/plain");
            return;
        }

        var bytes = await File.ReadAllBytesAsync(file);
        context.Response.StatusCode = 200;
        context.Response.ContentType = Mime.GetValueOrDefault(Path.GetExtension(file).ToLowerInvariant(), "application/octet-stream");
        // Revalidated on every load, so an update swapped in underneath the app never runs last
        // week's page against this week's API.
        context.Response.Headers.CacheControl = "no-cache";
        await context.Response.Body.WriteAsync(bytes);
    }
}

/// <summary>A host lifetime that leaves Ctrl+C and signals alone: Program.cs decides what they mean.</summary>
internal sealed class AppLifetime : IHostLifetime
{
    public Task WaitForStartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
