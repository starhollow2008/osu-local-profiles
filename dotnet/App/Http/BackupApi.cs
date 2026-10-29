using Microsoft.AspNetCore.Http;

namespace OsuLocalProfiles.Http;

/// <summary>Share and back up: Back up everything, and restoring a backup (src/http/server.ts, src/backup.ts).</summary>
internal static partial class Server
{
    /// <summary>Upload ceiling for a backup to restore. A big library's database is tens of MB.</summary>
    private const long MaxBackupBytes = 1024L * 1024 * 1024;

    /// <summary>Every profile, with the files kept beside the database, as one zip laid out as <c>data/</c> is.</summary>
    private static async Task BackupEverything(HttpContext context, ServerOptions opts)
    {
        var at = DateTimeOffset.Now;
        byte[] zip;
        try
        {
            zip = Backup.Create(opts.Db, opts.Paths.DataDir, at);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            await Json(context, new { error = e.Message }, 500);
            return;
        }
        var response = context.Response;
        response.StatusCode = 200;
        response.ContentType = "application/zip";
        response.Headers.ContentDisposition = $"attachment; filename=\"{Backup.FileName(at.LocalDateTime)}\"";
        response.Headers.CacheControl = "no-store";
        await response.Body.WriteAsync(zip);
    }

    /// <summary>
    /// Restore, in two steps so the page can say what it is about to replace everything with: a PUT
    /// checks and stages the file and answers with its profiles, then a POST applies it by restarting
    /// (or a DELETE drops it). Only this app's own page may do any of it. False when the request was
    /// none of these, for the routes after to answer.
    /// </summary>
    private static async Task<bool> Restore(HttpContext context, ServerOptions opts, string pathname)
    {
        var method = context.Request.Method;
        if (!FromOwnPage(context))
        {
            await Json(context, new { error = "only this app's own page can restore a backup" }, 403);
            return true;
        }
        var dataDir = opts.Paths.DataDir;
        if (pathname == "/api/restore" && method == "PUT")
        {
            if (await ReadUpload(context, MaxBackupBytes, "that file is too large to be a backup (1GB max)") is not { } upload) return true;
            BackupSummary summary;
            try
            {
                summary = Backup.StageRestore(dataDir, upload);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 400);
                return true;
            }
            await Json(context, new { ok = true, summary.Profiles, summary.Images });
            return true;
        }
        if (pathname == "/api/restore" && method == "DELETE")
        {
            Backup.DiscardRestore(dataDir);
            await Json(context, new { ok = true });
            return true;
        }
        if (pathname == "/api/restore/apply" && method == "POST")
        {
            try
            {
                Backup.MarkRestoreReady(dataDir);
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await Json(context, new { error = e.Message }, 400);
                return true;
            }
            if (opts.OnRestart is { } restart)
            {
                context.Response.OnCompleted(async () =>
                {
                    await Task.Delay(250);
                    restart();
                });
            }
            await Json(context, new { ok = true, restarting = opts.OnRestart is not null });
            return true;
        }
        return false;
    }
}
