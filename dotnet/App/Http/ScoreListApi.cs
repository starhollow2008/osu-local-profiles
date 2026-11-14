using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Export;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Http;

/// <summary>
/// The Scores view (roadmap 5.86): <c>/api/score-list</c> answers one page of it, and
/// <c>/api/score-list/export</c> writes all of it as CSV, a workbook or JSON. Both take the view as
/// the page has it set up (<c>view</c>, JSON), the profile's saved one when absent.
/// </summary>
internal static partial class ExportApi
{
    /// <summary>The view a request asks for: its <c>view</c>, else what the profile last saved.</summary>
    private static ScoreListView ViewOf(HttpRequest request, ProfileSettings settings)
    {
        if (!request.Query.TryGetValue("view", out var values) || values.Count == 0 || string.IsNullOrEmpty(values[0])) return settings.ScoreList;
        try
        {
            using var doc = JsonDocument.Parse(values[0]!);
            return ScoreListView.Coerce(doc.RootElement);
        }
        catch (JsonException)
        {
            return settings.ScoreList;
        }
    }

    /// <summary>A whole number of rows to skip, 0 when it is not one.</summary>
    private static int Offset(HttpRequest request)
    {
        var raw = request.Query.TryGetValue("offset", out var values) && values.Count > 0 ? values[0] ?? "" : "";
        var n = Js.StringToNumber(raw);
        return double.IsFinite(n) && n > 0 ? (int)Math.Min(Math.Floor(n), int.MaxValue / 2) : 0;
    }

    private static Func<string, List<double>>? MappedBy(ServerOptions opts) =>
        opts.Tracker?.Beatmaps is { } beatmaps ? beatmaps.BeatmapsMappedBy : null;

    /// <summary>One page of the list, and on the first page what the filters can offer.</summary>
    public static object ScoreList(HttpRequest request, ServerOptions opts, long profileId)
    {
        var db = opts.Db;
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var e = Eligibility.Of(settings, opts.StatusKnown);
        var mode = ProfileApi.Mode(request);
        var view = ViewOf(request, settings);
        var offset = Offset(request);
        var page = Stats.ScoreList(db, profileId, mode, view, e, offset, ProfileApi.Page(request, "limit", 50), MappedBy(opts));
        return new
        {
            mode,
            offset,
            page.Total,
            page.Rows,
            choices = offset == 0 ? Stats.ScoreListChoices(db, profileId, mode) : null,
        };
    }

    /// <summary>
    /// The whole list, as it is sorted and narrowed, in the columns Share &amp; back up's scores export
    /// has, with each beatmap's playcount. JSON is the same rows as objects, keyed by the English
    /// column names so a script reading it works whatever language the page is in.
    /// </summary>
    public static async Task ScoreListExport(HttpContext context, ServerOptions opts, long profileId)
    {
        var request = context.Request;
        var format = request.Query.TryGetValue("format", out var f) && f.Count > 0 ? f[0] : "csv";
        if (format is not ("csv" or "xlsx" or "json"))
        {
            context.Response.StatusCode = 400;
            context.Response.ContentType = "application/json; charset=utf-8";
            await context.Response.WriteAsync(JsonText.Stringify(new { error = "format must be csv, xlsx or json" }));
            return;
        }
        var db = opts.Db;
        var profile = Profiles.Get(db, profileId)!;
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var e = Eligibility.Of(settings, opts.StatusKnown);
        var mode = ProfileApi.Mode(request);
        var view = ViewOf(request, settings);
        var listed = Stats.ScoreListAll(db, profileId, mode, view, e, MappedBy(opts));

        var now = DateTime.Now;
        var cleaned = Js.Trim(UnsafeInFileName().Replace(profile.Name, "-"));
        var modeName = mode switch { 1 => "taiko", 2 => "catch", 3 => "mania", _ => "osu" };
        var stem = $"{(cleaned.Length > 0 ? cleaned : "profile")}-{modeName}-scores-{LocalDay(now)}";
        var t = new Translator(opts.Paths.WebRoot, format == "json" ? "en" : Locale(request, opts.Config));
        var table = Tables.Scores(db, profileId, e, mode, t, listed: listed);

        byte[] body;
        string type;
        if (format == "csv")
        {
            body = Csv.Write(table);
            type = "text/csv; charset=utf-8";
        }
        else if (format == "xlsx")
        {
            body = Xlsx.Write([table], now);
            type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        }
        else
        {
            var scores = table.Rows.Select(row =>
            {
                var item = new Dictionary<string, object?>();
                for (var i = 0; i < table.Columns.Count; i++)
                {
                    item[table.Columns[i].Header] = row[i] is DateCell date && double.IsFinite(date.Ms)
                        ? DateTimeOffset.FromUnixTimeMilliseconds((long)date.Ms).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
                        : row[i] is DateCell ? null : row[i];
                }
                return item;
            }).ToList();
            var payload = new
            {
                exportedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                app = "osu! local profiles",
                profile = profile.Name,
                mode,
                view,
                scores,
            };
            body = JsonSerializer.SerializeToUtf8Bytes(payload, new JsonSerializerOptions(JsonText.Options) { WriteIndented = true });
            type = "application/json; charset=utf-8";
        }
        var response = context.Response;
        response.StatusCode = 200;
        response.ContentType = type;
        response.Headers.ContentDisposition = Scores.AttachmentHeader($"{stem}.{format}");
        response.Headers.CacheControl = "no-store";
        response.ContentLength = body.Length;
        await response.Body.WriteAsync(body);
    }
}
