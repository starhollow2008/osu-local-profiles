using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
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

    /// <summary>
    /// Whether anything on this machine can say if a beatmap is ranked: lazer's online.db. Found by
    /// install detection, which is ported with the tracker (phase 4); until then, assumed.
    /// </summary>
    public bool StatusKnown { get; init; } = true;

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
        });
        opts.Cache ??= new ProfileCache(opts.Db);
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
                // No tracker or update check yet (phases 4 and 5).
                tracking = false,
                update = (string?)null,
                updating = false,
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

        if (pathname == "/api/profile")
        {
            await Json(context, ProfileApi.Answer(request, opts, opts.Cache!, Current()));
            return;
        }

        if (pathname == "/api/settings" && method != "POST")
        {
            await Json(context, new { settings = SettingsFor(Current()) });
            return;
        }

        if (pathname == "/api/app-config" && method != "POST")
        {
            await Json(context, new { config = opts.Config.PageView() });
            return;
        }

        if (pathname == "/api/declined" && method == "GET")
        {
            await Json(context, new { plays = Declined.List(db, Current()) });
            return;
        }

        if (pathname == "/api/data-folder" && method == "GET")
        {
            await Json(context, new { path = opts.Paths.DataDir });
            return;
        }

        // Everything else under /api/ is still the Node app's (docs/csharp-port.md).
        if (pathname.StartsWith("/api/", StringComparison.Ordinal))
        {
            await Json(context, new { error = $"{method} {pathname} is not ported yet" }, 501);
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
