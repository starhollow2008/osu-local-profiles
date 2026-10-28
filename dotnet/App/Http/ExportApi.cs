using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Export;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Http;

/// <summary>Share &amp; back up's downloads: the scores as CSV, the profile as a workbook, and as JSON.</summary>
internal static partial class ExportApi
{
    [GeneratedRegex("[\\\\/:*?\"<>|]+")]
    private static partial Regex UnsafeInFileName();

    [GeneratedRegex("[^A-Za-z0-9_.-]+")]
    private static partial Regex NotWordDotDash();

    /// <summary>A local date, <c>2026-09-23</c> (<c>localDay</c>).</summary>
    public static string LocalDay(DateTime local) => local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>
    /// The page's language for the words in an export: the one it says, else the saved one, else English.
    /// </summary>
    private static string Locale(HttpRequest request, AppConfig config)
    {
        var lang = request.Query.TryGetValue("lang", out var values) && values.Count > 0 ? values[0] : null;
        if (I18n.IsLocale(lang)) return lang!;
        var saved = config["language"];
        return Js.Truthy(saved) ? Js.ToJsString(saved!.Value) : I18n.DefaultLocale;
    }

    public static async Task Spreadsheet(HttpContext context, ServerOptions opts, long profileId, bool csv)
    {
        var db = opts.Db;
        var profile = Profiles.Get(db, profileId)!;
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var e = Eligibility.Of(settings, opts.StatusKnown);
        var now = DateTime.Now;
        // Whatever the profile is called, bar what a file name cannot hold on some system.
        var cleaned = Js.Trim(UnsafeInFileName().Replace(profile.Name, "-"));
        var stem = $"{(cleaned.Length > 0 ? cleaned : "profile")}-{LocalDay(now)}";
        var t = new Translator(opts.Paths.WebRoot, Locale(context.Request, opts.Config));
        var favorites = new FavoriteScope(profileId, opts.Config["sharedFavorites"] is { ValueKind: JsonValueKind.True });

        var body = csv
            ? Csv.Write(Tables.Scores(db, profileId, e, null, t))
            : Xlsx.Write(Tables.Workbook(db, profileId, profile.Name, e, favorites, t), now);
        var response = context.Response;
        response.StatusCode = 200;
        response.ContentType = csv ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        response.Headers.ContentDisposition = Scores.AttachmentHeader(csv ? $"{stem}-scores.csv" : $"{stem}.xlsx");
        response.ContentLength = body.Length;
        await response.Body.WriteAsync(body);
    }

    /// <summary>The profile as one JSON file: its settings, and each played mode's figures and scores.</summary>
    public static async Task Json(HttpContext context, ServerOptions opts, long profileId)
    {
        var db = opts.Db;
        var profile = Profiles.Get(db, profileId)!;
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var e = Eligibility.Of(settings, opts.StatusKnown);
        var modes = new double[] { 0, 1, 2, 3 }.Select(mode =>
        {
            var stats = Stats.Compute(db, profileId, mode, e);
            return new
            {
                mode,
                stats,
                rank = Ranks.Estimate(stats.TotalPp, mode),
                scores = db.Rows($"""
                    SELECT s.*, b.artist, b.title, b.version, b.creator, b.beatmapset_id
                      FROM scores s
                      LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
                     -- A score removed from the profile is not one of its scores, here as anywhere.
                     WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
                     ORDER BY s.played_at ASC
                    """, profileId, mode).Select(r => r.Columns).ToList(),
            };
        }).Where(m => m.stats.Playcount > 0).ToList();

        var payload = new
        {
            exportedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            app = "osu! local profiles",
            profile = new { name = profile.Name, createdAt = profile.CreatedAt, trackingSince = profile.TrackingSince, country = settings.Country, tagline = settings.Tagline },
            settings,
            modes,
        };

        var filename = $"{NotWordDotDash().Replace(profile.Name, "-")}-{DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}.json";
        var response = context.Response;
        response.StatusCode = 200;
        response.ContentType = "application/json; charset=utf-8";
        response.Headers.ContentDisposition = $"attachment; filename=\"{filename}\"";
        response.Headers.CacheControl = "no-store";
        await response.WriteAsync(JsonSerializer.Serialize(payload, new JsonSerializerOptions(JsonText.Options) { WriteIndented = true }));
    }
}
