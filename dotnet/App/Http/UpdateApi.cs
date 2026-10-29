using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Update;

namespace OsuLocalProfiles.Http;

/// <summary>The update check and the update itself (src/http/server.ts).</summary>
internal static partial class Server
{
    /// <summary>
    /// A GET says what the last check found and a POST runs it again; the rest change something, and
    /// only from this app's own page. False when the request was none of these, for the routes after.
    /// </summary>
    private static async Task<bool> UpdateRoute(HttpContext context, ServerOptions opts, string pathname)
    {
        var method = context.Request.Method;
        if (pathname == "/api/update")
        {
            if (method == "POST" && opts.Updater is { } checker) await checker.CheckForUpdate();
            await Json(context, StateApi.UpdateView(opts));
            return true;
        }
        if (method != "POST") return false;
        // Another website open in the browser must not be able to download or install anything.
        if (!FromOwnPage(context))
        {
            await Json(context, new { error = "only this app's own page can update it" }, 403);
            return true;
        }
        var updater = opts.Updater;
        switch (pathname)
        {
            // "When I quit": download now, install at the next deliberate quit or start; the live feed follows it.
            case "/api/update/later":
                if (updater is not null) _ = updater.PrepareUpdate("user").ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
                await Json(context, new { ok = true });
                return true;
            // What changed, after an update: seen, so it is not shown again.
            case "/api/update/seen":
                Notes.MarkSeen(opts.Db, opts.Paths.Version());
                await Json(context, new { ok = true });
                return true;
            // The notice above the page, put away for a week or an important release.
            case "/api/update/dismiss":
                if (updater?.State().LatestVersion is { } latest) Notes.DismissNudge(opts.Db, latest);
                opts.Events.Broadcast("update", StateApi.UpdateView(opts, found: false));
                await Json(context, new { ok = true });
                return true;
            // Replace this install with the newest release and restart, said before the process exits.
            case "/api/update/apply":
                ApplyResult result;
                try
                {
                    result = updater is null ? throw new InvalidOperationException("this copy cannot update itself") : await updater.ApplyUpdate();
                }
                catch (Exception e) when (e is not OutOfMemoryException)
                {
                    await Json(context, new { error = e.Message }, 400);
                    return true;
                }
                if (opts.OnUpdateExit is { } exit)
                {
                    // Long enough for the answer to reach the browser; the exit code tells a launcher
                    // that restarts the app to wait for the swap.
                    context.Response.OnCompleted(async () =>
                    {
                        await Task.Delay(750);
                        exit(result.ExitCode);
                    });
                }
                await Json(context, new { ok = true, version = result.Version, message = $"Installing {result.Version}. The app will close and reopen." });
                return true;
            default:
                return false;
        }
    }
}
