using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Http;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// The endpoints that write, over HTTP: test/reset.test.ts, test/welcome.test.ts,
/// test/request-body.test.ts and test/import-range.test.ts's server half, and the live feed.
/// </summary>
public sealed class WriteApiTests : IAsyncLifetime
{
    private readonly string install = Directory.CreateTempSubdirectory("olp-cs-writes-").FullName;
    private readonly TempDb data = new();
    private readonly List<WebApplication> apps = [];
    private ServerOptions opts = null!;
    private HttpClient client = new();

    private string DataDir => Path.Combine(install, "data");

    /// <summary>What osu! answers, by URL; offline unless a test says otherwise.</summary>
    private Func<string, HttpResponseMessage> osuAnswers = _ => throw new HttpRequestException("offline");
    private FakeOsu? osu;

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(Path.Combine(install, "web"));
        File.WriteAllText(Path.Combine(install, "package.json"), """{"version":"9.9.9"}""");
        Directory.CreateDirectory(DataDir);
        // A hand edit the page knows nothing of, which a write must keep; and the search of every
        // drive already done, so adding a folder never starts one.
        File.WriteAllText(Path.Combine(DataDir, "config.json"), """{"port": 7272, "handEdited": "yes", "searchedForInstalls": true}""");
        (opts, client) = await Start(data.Db);
    }

    private async Task<(ServerOptions, HttpClient)> Start(Database db)
    {
        var paths = new AppPaths(install);
        var config = AppConfig.Load(paths.DataDir);
        var tracker = new PlayTracker(db, new BeatmapResolver(db, []), [], Profiles.ActiveId(db), 0, null);
        var options = new ServerOptions
        {
            Db = db,
            Paths = paths,
            Config = config,
            Port = 0,
            Tracker = tracker,
            Osu = (osu ??= new FakeOsu(url => osuAnswers(url))).Client(),
            Folders = new OsuFolders(config, OsuFolders.SaveInto(paths.DataDir), [], new DiscoveryResult([], [], false), Path.Combine(paths.DataDir, "mcosu")),
        };
        var app = Server.Build(options);
        await app.StartAsync();
        apps.Add(app);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        var port = new Uri(address.Replace("[::]", "localhost").Replace("0.0.0.0", "localhost")).Port;
        return (options, new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") });
    }

    public async Task DisposeAsync()
    {
        client.Dispose();
        foreach (var app in apps) await app.DisposeAsync();
        data.Dispose();
        Directory.Delete(install, recursive: true);
    }

    private async Task<(HttpStatusCode Status, JsonElement Body)> Post(string path, string? raw)
    {
        var response = await client.PostAsync(path, raw is null ? null : new StringContent(raw, Encoding.UTF8, "application/json"));
        return (response.StatusCode, JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone());
    }

    private Task<(HttpStatusCode Status, JsonElement Body)> Post(string path, object body) => Post(path, JsonText.Stringify(body));

    private async Task<(HttpStatusCode Status, JsonElement Body)> Put(string path, byte[] bytes)
    {
        var response = await client.PutAsync(path, new ByteArrayContent(bytes));
        return (response.StatusCode, JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone());
    }

    private static string? Error(JsonElement body) => body.TryGetProperty("error", out var e) ? e.GetString() : null;

    [Fact]
    public async Task A_body_that_is_not_a_JSON_object_is_refused_and_never_stops_the_app()
    {
        foreach (var raw in new[] { "null", "5", "\"text\"", "true", "[1,2]", "{", "not json" })
        {
            foreach (var path in new[] { "/api/settings", "/api/app-config", "/api/scores", "/api/profiles" })
            {
                var (status, body) = await Post(path, raw);
                Assert.Equal(HttpStatusCode.BadRequest, status);
                Assert.Equal("expected a JSON body", Error(body));
            }
        }
        // An empty body is an empty object, as it always was.
        var (emptyStatus, empty) = await Post("/api/app-config", (string?)null);
        Assert.Equal(HttpStatusCode.BadRequest, emptyStatus);
        Assert.Equal("openBrowser must be true or false", Error(empty));
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/app")).StatusCode);
    }

    [Fact]
    public async Task A_path_the_app_does_not_know_is_not_found_as_in_node()
    {
        foreach (var path in new[] { "/api/no-such-thing", "/api/about-image/1/0123456789abcdef.png" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("not found", await response.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/no-such-thing", null)).StatusCode);
    }

    [Fact]
    public async Task The_pp_source_is_read_and_a_folder_that_is_not_one_changes_nothing()
    {
        // No service: the page cannot offer a source at all.
        var view = await client.GetAsync("/api/pp-source");
        Assert.Equal(HttpStatusCode.NotFound, view.StatusCode);

        var service = new PpSource(PpSourceTracker.Of(opts.Tracker!), DataDir, "Program.cs",
            () => opts.Config["ppSource"] is { } s ? s.GetString()! : "", _ => throw new InvalidOperationException("must not save"));
        var (other, otherClient) = await StartWith(service);
        using (otherClient)
        {
            var state = JsonDocument.Parse(await otherClient.GetStringAsync("/api/pp-source")).RootElement;
            Assert.Equal("", state.GetProperty("source").GetString());
            Assert.Equal(JsonValueKind.Null, state.GetProperty("now").ValueKind);
            Assert.Equal(JsonValueKind.Null, state.GetProperty("building").ValueKind);

            var notString = await otherClient.PostAsync("/api/pp-source", new StringContent("""{"source":5}"""));
            Assert.Equal(HttpStatusCode.BadRequest, notString.StatusCode);

            var refused = await otherClient.PostAsync("/api/pp-source", new StringContent(JsonText.Stringify(new { source = $"  {Path.Combine(install, "nowhere")}  " })));
            Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
            var answer = JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal("that folder does not exist", answer.GetProperty("error").GetString());
            Assert.Equal("", answer.GetProperty("source").GetString());
            // Kept for Settings, until the next try.
            var settings = JsonDocument.Parse(await otherClient.GetStringAsync("/api/state")).RootElement;
            Assert.Equal("that folder does not exist", settings.GetProperty("ppCalculator").GetProperty("source").GetProperty("error").GetString());
        }
    }

    private async Task<(ServerOptions, HttpClient)> StartWith(PpSource service)
    {
        var options = new ServerOptions
        {
            Db = opts.Db,
            Paths = opts.Paths,
            Config = opts.Config,
            Port = 0,
            Tracker = opts.Tracker,
            PpSource = service,
            Osu = opts.Osu,
        };
        var app = Server.Build(options);
        await app.StartAsync();
        apps.Add(app);
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        var port = new Uri(address.Replace("[::]", "localhost").Replace("0.0.0.0", "localhost")).Port;
        return (options, new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") });
    }

    [Fact]
    public async Task App_config_takes_each_option_only_with_a_value_of_its_type_and_keeps_hand_edits()
    {
        var (status, body) = await Post("/api/app-config", new { openBrowser = false });
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False(body.GetProperty("config").GetProperty("openBrowser").GetBoolean());

        Assert.Equal("openBrowser must be true or false", Error((await Post("/api/app-config", new { openBrowser = "no" })).Body));
        Assert.Equal("openBrowser must be true or false", Error((await Post("/api/app-config", new { port = 80 })).Body));
        Assert.Equal("font must be nunito or system", Error((await Post("/api/app-config", new { font = "comic sans" })).Body));
        Assert.Equal("font must be nunito or system", Error((await Post("/api/app-config", new { font = true })).Body));
        Assert.Equal("xx is not a language this app has", Error((await Post("/api/app-config", new { language = "xx" })).Body));
        Assert.Equal("[object Object] is not a language this app has", Error((await Post("/api/app-config", """{"language":{}}""")).Body));

        Assert.Equal("system", (await Post("/api/app-config", new { font = "system", language = "de" })).Body.GetProperty("config").GetProperty("font").GetString());
        // Auto-update needs the check it acts on.
        File.WriteAllText(Path.Combine(DataDir, "config.json"), """{"port": 7272, "handEdited": "yes", "checkForUpdates": false}""");
        await Post("/api/app-config", new { autoUpdate = true });

        using var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(DataDir, "config.json")));
        var root = saved.RootElement;
        Assert.Equal("yes", root.GetProperty("handEdited").GetString());
        Assert.True(root.GetProperty("autoUpdate").GetBoolean());
        Assert.True(root.GetProperty("checkForUpdates").GetBoolean());
        // Each write goes into the file as it is now, so the earlier ones went with the file replaced
        // above, while the running app keeps what it was told.
        Assert.True(root.GetProperty("openBrowser").GetBoolean());
        Assert.Equal("nunito", root.GetProperty("font").GetString());
        Assert.Equal("system", (await client.GetFromJson("/api/app-config")).GetProperty("config").GetProperty("font").GetString());
    }

    [Fact]
    public async Task Sharing_favourites_switched_off_copies_the_shared_list_to_every_profile()
    {
        data.Db.Run("INSERT INTO shared_favorite_beatmapsets (beatmapset_id, favorited_at) VALUES (1830679, 5)");
        Favorites.SyncSharing(data.Db, true);
        await Post("/api/app-config", new { sharedFavorites = false });
        Assert.Equal(1L, data.Db.Scalar("SELECT COUNT(*) FROM favorite_beatmapsets WHERE profile_id = ? AND beatmapset_id = 1830679", data.ProfileId));
        Assert.Null(Favorites.SyncSharing(data.Db, false));
    }

    [Fact]
    public async Task Reset_refuses_without_confirmation_and_erases_the_profile_with_it()
    {
        data.InsertScore(data.ProfileId, "a");
        data.InsertScore(data.ProfileId, "b");
        foreach (var raw in new[] { "{}", """{"confirm":false}""", """{"confirm":"yes"}""", "", "null", "nonsense" })
        {
            var (status, body) = await Post("/api/profile/reset", raw);
            Assert.Equal(HttpStatusCode.BadRequest, status);
            Assert.Equal("reset requires an explicit confirmation", Error(body));
        }
        Assert.Equal(2L, data.Db.Scalar("SELECT COUNT(*) FROM scores"));

        var started = Js.Now();
        var (ok, reset) = await Post("/api/profile/reset", new { confirm = true });
        Assert.Equal(HttpStatusCode.OK, ok);
        Assert.Equal(2, reset.GetProperty("deleted").GetDouble());
        Assert.Equal(0L, data.Db.Scalar("SELECT COUNT(*) FROM scores"));
        var since = Convert.ToDouble(data.Db.Scalar("SELECT tracking_since FROM profiles WHERE id = ?", data.ProfileId));
        Assert.True(since >= started);
        Assert.Equal(since, reset.GetProperty("trackingSince").GetDouble());
        // On an empty profile it is harmless.
        Assert.Equal(0, (await Post("/api/profile/reset", new { confirm = true })).Body.GetProperty("deleted").GetDouble());
    }

    private void Decline(string key) => Declined.Record(data.Db, data.ProfileId, new Decline(
        "score", key, "another-player", null, "mrekk", "live", "Reji - Shoujo wa Yoru to Azayaka ni [Vivid Collab]", null, 0, Js.Now(),
        Path.Combine(install, "nowhere", $"{key}.osr"), null));

    [Fact]
    public async Task Plays_not_tracked_are_tracked_anyway_or_deleted_for_good_and_a_reset_forgets_them()
    {
        Decline("a");
        Decline("b");
        var listed = (await client.GetFromJson("/api/declined")).GetProperty("plays");
        Assert.Equal(2, listed.GetArrayLength());

        Assert.Equal("unknown action \"nonsense\"", Error((await Post("/api/declined", new { action = "nonsense" })).Body));
        Assert.Equal("a play id is needed", Error((await Post("/api/declined", new { action = "track", id = "x" })).Body));
        // The replay is not on this machine, so there is nothing to track it from, and it stays.
        var (_, missing) = await Post("/api/declined", new { action = "track", id = listed[0].GetProperty("id").GetInt64() });
        Assert.Equal("""{"status":"missing"}""", missing.GetProperty("result").GetRawText());
        Assert.Equal(2, missing.GetProperty("declinedPlays").GetDouble());

        await Post("/api/profile/reset", new { confirm = true });
        Assert.Empty(Declined.List(data.Db, data.ProfileId));

        Decline("c");
        Decline("d");
        Decline("e");
        var newest = Declined.List(data.Db, data.ProfileId)[0].Id;
        var (_, one) = await Post("/api/declined", new { action = "delete", id = newest });
        Assert.Equal(1, one.GetProperty("deleted").GetInt32());
        Assert.Equal(2, one.GetProperty("declinedPlays").GetDouble());
        Assert.Equal(HttpStatusCode.BadRequest, (await Post("/api/declined", new { action = "delete", id = newest })).Status);
        var (_, all) = await Post("/api/declined", new { action = "delete-all" });
        Assert.Equal(2, all.GetProperty("deleted").GetInt32());
        Assert.Equal(0, all.GetProperty("declinedPlays").GetDouble());
    }

    [Fact]
    public async Task Scores_are_pinned_removed_listed_and_deleted_for_good_over_the_api()
    {
        data.InsertScore(data.ProfileId, "a");
        var id = Convert.ToInt64(data.Db.Scalar("SELECT id FROM scores"));
        Assert.Equal(0, (await Post("/api/scores", new { action = "pin", id })).Body.GetProperty("hiddenScores").GetDouble());
        Assert.Equal(1, (await Post("/api/scores", new { action = "hide", id })).Body.GetProperty("hiddenScores").GetDouble());
        var hidden = (await Post("/api/scores", new { action = "list-hidden" })).Body.GetProperty("hidden");
        Assert.Equal(id, hidden[0].GetProperty("id").GetInt64());
        Assert.Equal("no score 999 on this profile", Error((await Post("/api/scores", new { action = "pin", id = 999 })).Body));
        Assert.Equal("no score NaN on this profile", Error((await Post("/api/scores", new { action = "pin" })).Body));

        var (_, deleted) = await Post("/api/scores", new { action = "delete", ids = new[] { id } });
        Assert.Equal(1, deleted.GetProperty("deleted").GetInt32());
        Assert.Equal(0, deleted.GetProperty("hiddenScores").GetDouble());
        Assert.True(data.Db.Exists("SELECT 1 FROM deleted_scores WHERE dedupe_key = 'a'"));
    }

    [Fact]
    public async Task Profiles_are_created_switched_renamed_and_deleted_as_the_Node_app_answers()
    {
        var (_, created) = await Post("/api/profiles", new { action = "create", name = "  Left hand  " });
        var profile = created.GetProperty("profile");
        Assert.Equal("Left hand", profile.GetProperty("name").GetString());
        // The profile as it was made, before the switch to it.
        Assert.False(profile.GetProperty("active").GetBoolean());
        var id = profile.GetProperty("id").GetInt64();
        Assert.Equal(id, Profiles.ActiveId(data.Db));
        Assert.Equal(id, opts.Tracker!.ProfileId);

        Assert.Equal("a profile called \"Left hand\" already exists", Error((await Post("/api/profiles", new { action = "create", name = "Left hand" })).Body));
        Assert.Equal("a profile needs a name", Error((await Post("/api/profiles", new { action = "create" })).Body));
        Assert.Equal("no profile with id NaN", Error((await Post("/api/profiles", new { action = "switch", id = "x" })).Body));
        Assert.Equal("no profile with id 1.5", Error((await Post("/api/profiles", new { action = "switch", id = 1.5 })).Body));
        Assert.Equal("unknown action \"\"", Error((await Post("/api/profiles", new { })).Body));

        var (_, switched) = await Post("/api/profiles", new { action = "switch", id = data.ProfileId });
        Assert.True(switched.GetProperty("profile").GetProperty("active").GetBoolean());
        Assert.Equal(data.ProfileId, opts.Tracker!.ProfileId);

        Assert.Equal("Right hand", (await Post("/api/profiles", new { action = "rename", id, name = "Right hand" })).Body.GetProperty("profile").GetProperty("name").GetString());
        Assert.Equal("123", (await Post("/api/profiles", new { action = "rename", id, name = 123 })).Body.GetProperty("profile").GetProperty("name").GetString());

        Assert.Equal("deleting a profile requires an explicit confirmation", Error((await Post("/api/profiles", new { action = "delete", id })).Body));
        var (_, deleted) = await Post("/api/profiles", new { action = "delete", id, confirm = true });
        Assert.Equal(data.ProfileId, deleted.GetProperty("nextActive").GetInt64());
        Assert.Equal(1, deleted.GetProperty("profiles").GetArrayLength());
    }

    [Fact]
    public async Task A_favourite_is_saved_first_and_described_by_osu_when_it_answers()
    {
        Assert.Equal("a beatmapset id is needed", Error((await Post("/api/favorites", new { action = "add", beatmapsetId = 1.5 })).Body));
        Assert.Equal("action must be add or remove", Error((await Post("/api/favorites", new { action = "toggle", beatmapsetId = 1 })).Body));

        // Offline: kept regardless, with why osu! could not describe it.
        var (_, offline) = await Post("/api/favorites", new { action = "add", beatmapsetId = 8495 });
        Assert.Equal("[8495]", offline.GetProperty("favorites").GetRawText());
        Assert.Equal("could not reach osu.ppy.sh", offline.GetProperty("detailsError").GetString());

        // Back online, the next press fills in what is missing.
        osuAnswers = url => FakeOsu.Answer(FakeOsu.BeatmapsetPage(
            $$"""{"id":{{url.Split('/')[^1]}},"title":"t","artist":"a","status":"ranked","video":false,"beatmaps":[]}"""));
        var (_, online) = await Post("/api/favorites", new { action = "add", beatmapsetId = 100 });
        Assert.Equal(JsonValueKind.Null, online.GetProperty("detailsError").ValueKind);
        // The one just added first, then those still missing.
        Assert.Equal(["https://osu.ppy.sh/beatmapsets/100", "https://osu.ppy.sh/beatmapsets/8495"], osu!.Asked.Skip(1));
        Assert.Equal(2L, data.Db.Scalar("SELECT COUNT(*) FROM beatmapset_details"));

        var (_, removed) = await Post("/api/favorites", new { action = "remove", beatmapsetId = 100 });
        Assert.Equal("[8495]", removed.GetProperty("favorites").GetRawText());
    }

    [Fact]
    public async Task A_backup_is_downloaded_and_staged_back_only_from_the_apps_own_page()
    {
        data.InsertScore(data.ProfileId, "a");
        // The app's own database lives in data/ beside the pictures; this test's is elsewhere.
        var response = await client.GetAsync("/api/backup");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/zip", response.Content.Headers.ContentType!.ToString());
        Assert.Equal($"attachment; filename=\"{Backup.FileName(DateTime.Now)}\"", response.Content.Headers.ContentDisposition!.ToString());
        var zip = await response.Content.ReadAsByteArrayAsync();
        Assert.Contains("profiles.db", Zip.ReadEntries(zip).Select(e => e.Name));

        var foreign = new HttpRequestMessage(HttpMethod.Put, "/api/restore") { Content = new ByteArrayContent(zip) };
        foreign.Headers.TryAddWithoutValidation("origin", "https://example.com");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(foreign)).StatusCode);

        var (status, staged) = await Put("/api/restore", zip);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(1, staged.GetProperty("profiles")[0].GetProperty("plays").GetInt32());
        // Nothing would start the app again here, so the page is told to ask for a restart.
        var (_, applied) = await Post("/api/restore/apply", new { });
        Assert.False(applied.GetProperty("restarting").GetBoolean());
        Assert.True(Backup.HasStagedRestore(DataDir));
        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync("/api/restore")).StatusCode);
        Assert.Equal("no backup has been uploaded to restore", Error((await Post("/api/restore/apply", new { })).Body));
    }

    [Fact]
    public async Task The_welcome_ends_for_good_however_it_is_left()
    {
        ProfileData.OfferWelcome(data.Db);
        Assert.True((await client.GetFromJson("/api/state")).GetProperty("welcome").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await Post("/api/welcome", (string?)null)).Status);
        Assert.False((await client.GetFromJson("/api/state")).GetProperty("welcome").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await Post("/api/welcome", (string?)null)).Status);
    }

    /// <summary>The smallest bytes that sniff as a PNG.</summary>
    private static byte[] Png() => [0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3];

    [Fact]
    public async Task Pictures_are_sniffed_capped_saved_and_cleared()
    {
        var (status, saved) = await Put("/api/image/avatar", Png());
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True(saved.GetProperty("hasAvatar").GetBoolean());
        Assert.False(saved.GetProperty("hasCover").GetBoolean());
        Assert.Equal(Png(), File.ReadAllBytes(Path.Combine(DataDir, $"profile-{data.ProfileId}-avatar.png")));

        Assert.Equal("that file is not a PNG, JPEG, WebP or GIF", Error((await Put("/api/image/cover", Encoding.ASCII.GetBytes("not an image at all"))).Body));
        var (tooLarge, large) = await Put("/api/image/cover", new byte[8 * 1024 * 1024 + 1]);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge);
        Assert.Equal("that image is too large (8MB max)", Error(large));

        Assert.Equal("kind must be \"avatar\" or \"cover\"", Error((await Post("/api/identity", new { action = "clear-image", kind = "banner" })).Body));
        var (_, cleared) = await Post("/api/identity", new { action = "clear-image", kind = "avatar" });
        Assert.False(cleared.GetProperty("hasAvatar").GetBoolean());
        Assert.Equal("unknown action \"nope\"", Error((await Post("/api/identity", new { action = "nope" })).Body));

        var (_, about) = await Put("/api/about-image", Png());
        var url = about.GetProperty("url").GetString()!;
        Assert.Matches($"^/api/about-image/{data.ProfileId}/[0-9a-f]{{16}}\\.png$", url);
        Assert.Equal(Png(), await client.GetByteArrayAsync(url));
    }

    [Fact]
    public async Task An_import_takes_a_range_and_All_and_refuses_one_that_ends_before_it_starts()
    {
        var since = Js.Now() - 86_400_000;
        var (all, allBody) = await Post("/api/backfill/preview", new { since = 0 });
        Assert.Equal(HttpStatusCode.OK, all);
        Assert.Equal(0, allBody.GetProperty("importable").GetInt32());
        Assert.Equal(JsonValueKind.Null, allBody.GetProperty("until").ValueKind);
        // An end still to come is the same range as one ending now.
        Assert.Equal(JsonValueKind.Null, (await Post("/api/backfill/preview", new { since, until = Js.Now() + 3_600_000 })).Body.GetProperty("until").ValueKind);

        Assert.Equal("\"until\" must be after \"since\"", Error((await Post("/api/backfill/preview", new { since, until = since })).Body));
        Assert.Equal("\"until\" must be a millisecond timestamp", Error((await Post("/api/backfill/preview", new { since, until = "soon" })).Body));
        Assert.Equal("\"since\" must be a millisecond timestamp", Error((await Post("/api/backfill/preview", new { since = -1 })).Body));
        Assert.Equal("\"since\" must be a millisecond timestamp", Error((await Post("/api/backfill/preview", new { })).Body));
        Assert.Equal("\"since\" is in the future", Error((await Post("/api/backfill/preview", new { since = Js.Now() + 3_600_000 })).Body));
        Assert.Equal("expected a JSON body with a \"since\" timestamp", Error((await Post("/api/backfill/preview", "null")).Body));
        Assert.Equal("importing requires an explicit confirmation", Error((await Post("/api/backfill", new { since })).Body));
        Assert.Equal("choose at least one osu! install to look in", Error((await Post("/api/backfill", new { since, confirm = true, installs = new[] { "C:/osu!" } })).Body));

        var (_, imported) = await Post("/api/backfill", new { since, confirm = true });
        Assert.Equal(0, imported.GetProperty("imported").GetInt32());
        Assert.Equal(since, imported.GetProperty("since").GetDouble());
    }

    [Fact]
    public async Task Tracking_is_switched_by_the_body_and_toggled_by_one_that_cannot_be_read()
    {
        Assert.False(opts.Tracker!.IsTracking);
        Assert.True((await Post("/api/tracking", "nonsense")).Body.GetProperty("tracking").GetBoolean());
        Assert.False((await Post("/api/tracking", "{}")).Body.GetProperty("tracking").GetBoolean());
        Assert.True((await Post("/api/tracking", new { enabled = 1 })).Body.GetProperty("tracking").GetBoolean());
        Assert.False((await Post("/api/tracking", "null")).Body.GetProperty("tracking").GetBoolean());
        opts.Tracker.Stop();
    }

    [Fact]
    public async Task The_installs_endpoint_refuses_a_folder_that_is_not_an_osu_install_with_the_reason()
    {
        var folder = Directory.CreateDirectory(Path.Combine(install, "games")).FullName;
        Assert.Equal("give a folder to add", Error((await Post("/api/installs", new { add = "  " })).Body));
        Assert.Equal("expected add, remove or rescan", Error((await Post("/api/installs", new { })).Body));
        Assert.Equal($"There is no folder at {Path.Combine(folder, "missing")}.", Error((await Post("/api/installs", new { add = Path.Combine(folder, "missing") })).Body));
        Assert.Contains("does not look like an osu! install", Error((await Post("/api/installs", new { add = $"\"{folder}\"" })).Body));

        // The folder above the install: say which one to pick.
        var stable = Directory.CreateDirectory(Path.Combine(folder, "osu!")).FullName;
        File.WriteAllText(Path.Combine(stable, "osu!.exe"), "");
        Assert.Equal($"{folder} is not an osu! folder itself, but it contains one: {stable}", Error((await Post("/api/installs", new { add = folder })).Body));

        var (_, added) = await Post("/api/installs", new { add = stable });
        var candidate = Assert.Single(added.GetProperty("candidates").EnumerateArray(), c => c.GetProperty("root").GetString() == stable);
        Assert.True(candidate.GetProperty("configured").GetBoolean());
        Assert.False(candidate.GetProperty("active").GetBoolean());
        Assert.True(added.GetProperty("needsRestart").GetBoolean());
        using (var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(DataDir, "config.json"))))
        {
            Assert.Equal(stable, saved.RootElement.GetProperty("installRoots")[0].GetString());
            Assert.Equal("yes", saved.RootElement.GetProperty("handEdited").GetString());
        }

        var (_, removed) = await Post("/api/installs", new { remove = stable });
        Assert.DoesNotContain(removed.GetProperty("candidates").EnumerateArray(), c => c.GetProperty("root").GetString() == stable);
    }

    [Fact]
    public async Task The_live_feed_sends_what_the_page_is_told_with_the_Node_apps_framing()
    {
        using var stream = await client.GetStreamAsync("/api/events");
        using var reader = new StreamReader(stream);
        Assert.Equal("retry: 2000", await reader.ReadLineAsync());
        Assert.Equal("", await reader.ReadLineAsync());
        while (opts.Events.Listeners == 0) await Task.Delay(10);

        await Post("/api/settings", new { tagline = "hello" });
        Assert.Equal("event: settings", await reader.ReadLineAsync());
        var line = await reader.ReadLineAsync();
        Assert.StartsWith("data: {", line);
        Assert.Equal("hello", JsonDocument.Parse(line!["data: ".Length..]).RootElement.GetProperty("tagline").GetString());
        Assert.Equal("", await reader.ReadLineAsync());

        // An unreadable replay names nothing; another player's names who and which map.
        Assert.Equal("""{"reason":"unparseable","at":5}""", JsonText.Stringify(LiveFeed.RefusedPayload(new RefusedPlay("unparseable", 5))));
        Assert.Equal("""{"reason":"another-player","player":"mrekk","title":"t","titleOriginal":null,"at":5}""",
            JsonText.Stringify(LiveFeed.RefusedPayload(new RefusedPlay("another-player", 5, "mrekk", "t"))));
    }

    [Fact]
    public async Task An_upload_that_is_not_a_replay_is_refused_and_nothing_is_kept()
    {
        var (status, body) = await client.PostAsync("/api/replays", new ByteArrayContent(Encoding.ASCII.GetBytes("definitely not a replay")))
            .ContinueWith(async t => (t.Result.StatusCode, JsonDocument.Parse(await t.Result.Content.ReadAsStringAsync()).RootElement.Clone())).Unwrap();
        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Equal("that file is not an osu! replay", Error(body));
        Assert.False(Directory.Exists(Path.Combine(DataDir, "replays")) && Directory.EnumerateFiles(Path.Combine(DataDir, "replays")).Any());
    }
}

internal static class HttpClientJson
{
    public static async Task<JsonElement> GetFromJson(this HttpClient client, string path) =>
        JsonDocument.Parse(await client.GetStringAsync(path)).RootElement.Clone();
}
