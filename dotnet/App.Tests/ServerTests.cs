using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using OsuLocalProfiles.Http;

namespace OsuLocalProfiles.Tests;

/// <summary>The server's own rules (test/instance.test.ts and the server's static file tests).</summary>
public sealed class ServerTests : IAsyncLifetime
{
    private readonly string install = Directory.CreateTempSubdirectory("olp-cs-server-").FullName;
    private TempDb? data;
    private WebApplication? app;
    private HttpClient client = new();

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(Path.Combine(install, "web"));
        File.WriteAllText(Path.Combine(install, "web", "index.html"), "<p>index</p>");
        File.WriteAllText(Path.Combine(install, "web", "score.html"), "<p>score</p>");
        File.WriteAllText(Path.Combine(install, "web", "app.js"), "export const x = 1;");
        File.WriteAllText(Path.Combine(install, "package.json"), """{"version":"9.9.9"}""");
        // A sibling whose name starts like web/'s, which a prefix check would let through.
        Directory.CreateDirectory(Path.Combine(install, "web-secret"));
        File.WriteAllText(Path.Combine(install, "web-secret", "x.txt"), "secret");

        data = new TempDb();
        var paths = new AppPaths(install);
        app = Server.Build(new ServerOptions { Db = data.Db, Paths = paths, Config = AppConfig.Load(paths.DataDir), Port = 0 });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        var port = new Uri(address.Replace("[::]", "localhost").Replace("0.0.0.0", "localhost")).Port;
        client = new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") };
    }

    public async Task DisposeAsync()
    {
        client.Dispose();
        if (app is not null) await app.DisposeAsync();
        data?.Dispose();
        Directory.Delete(install, recursive: true);
    }

    private async Task<JsonElement> GetJson(string path)
    {
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json; charset=utf-8", response.Content.Headers.ContentType!.ToString());
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    [Fact]
    public async Task Api_app_names_the_app_so_a_stranger_on_the_port_is_never_taken_for_it()
    {
        var body = await GetJson("/api/app");
        Assert.Equal("osu-local-profiles", body.GetProperty("app").GetString());
        Assert.Equal("9.9.9", body.GetProperty("version").GetString());
        Assert.Equal(Environment.ProcessId, body.GetProperty("pid").GetInt32());
    }

    [Fact]
    public async Task Settings_are_the_current_profiles_with_every_key()
    {
        var settings = (await GetJson("/api/settings")).GetProperty("settings");
        Assert.Equal(SettingsStore_Keys(), settings.EnumerateObject().Select(p => p.Name));
    }

    private static IEnumerable<string> SettingsStore_Keys() => Settings.SettingsStore.Keys;

    [Fact]
    public async Task App_config_and_declined_plays_answer()
    {
        var config = (await GetJson("/api/app-config")).GetProperty("config");
        Assert.True(config.GetProperty("openBrowser").GetBoolean());
        Assert.Equal("nunito", config.GetProperty("font").GetString());
        Assert.Equal(0, (await GetJson("/api/declined")).GetProperty("plays").GetArrayLength());
    }

    [Fact]
    public async Task What_is_not_ported_yet_says_so()
    {
        var response = await client.GetAsync("/api/update");
        Assert.Equal(HttpStatusCode.NotImplemented, response.StatusCode);
        Assert.Equal(HttpStatusCode.NotImplemented, (await client.PostAsync("/api/pp-source", new StringContent("{}"))).StatusCode);
    }

    [Fact]
    public async Task The_page_and_its_files_are_served_and_revalidated()
    {
        var index = await client.GetAsync("/");
        Assert.Equal("<p>index</p>", await index.Content.ReadAsStringAsync());
        Assert.Equal("text/html; charset=utf-8", index.Content.Headers.ContentType!.ToString());
        Assert.Equal("no-cache", index.Headers.CacheControl!.ToString());

        Assert.Equal("<p>score</p>", await client.GetStringAsync("/scores/123"));
        Assert.Equal("<p>score</p>", await client.GetStringAsync("/scores/123/"));
        Assert.Equal("text/javascript; charset=utf-8", (await client.GetAsync("/app.js")).Content.Headers.ContentType!.ToString());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/missing.js")).StatusCode);
        // JavaScript's \d is ASCII: an Arabic-Indic digit is not a score id.
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/scores/%D9%A1")).StatusCode);
    }

    [Fact]
    public async Task Nothing_outside_web_is_served()
    {
        foreach (var path in new[] { "/..%5Cpackage.json", "/..%5Cweb-secret%5Cx.txt", "/%2E%2E/package.json" })
        {
            var response = await client.GetAsync(path);
            Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
            Assert.DoesNotContain("version", await response.Content.ReadAsStringAsync());
            Assert.DoesNotContain("secret", await response.Content.ReadAsStringAsync());
        }
    }

    [Fact]
    public async Task A_me_image_is_served_from_data_by_its_address_and_nothing_else_is()
    {
        var folder = Path.Combine(install, "data", "about-images", "1");
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, "0123456789abcdef.png"), [1, 2, 3]);
        File.WriteAllText(Path.Combine(install, "data", "secret.txt"), "secret");

        var found = await client.GetAsync("/api/about-image/1/0123456789abcdef.png");
        Assert.Equal(HttpStatusCode.OK, found.StatusCode);
        Assert.Equal("image/png", found.Content.Headers.ContentType!.ToString());
        Assert.Equal("max-age=31536000, immutable", found.Headers.CacheControl!.ToString());
        Assert.Equal([1, 2, 3], await found.Content.ReadAsByteArrayAsync());

        // Gone, or not an address the page gives: a 404, as the Node app's static files answer.
        foreach (var path in new[] { "/api/about-image/1/fedcba9876543210.png", "/api/about-image/1/0123456789ABCDEF.png" })
        {
            var missing = await client.GetAsync(path);
            Assert.True(missing.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NotImplemented, path);
            Assert.DoesNotContain("secret", await missing.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/about-image/1/fedcba9876543210.png")).StatusCode);
    }

    [Fact]
    public void The_page_is_recognised_under_each_name_for_this_machine_on_this_port_only()
    {
        Assert.True(Server.IsOwnPage(null, 7272));
        Assert.True(Server.IsOwnPage("http://localhost:7272", 7272));
        Assert.True(Server.IsOwnPage("http://127.0.0.1:7272", 7272));
        Assert.True(Server.IsOwnPage("http://[::1]:7272", 7272));
        Assert.False(Server.IsOwnPage("http://localhost:8080", 7272));
        Assert.False(Server.IsOwnPage("https://localhost:7272", 7272));
        Assert.False(Server.IsOwnPage("http://example.com:7272", 7272));
        Assert.False(Server.IsOwnPage("null", 7272));
        Assert.False(Server.IsOwnPage("garbage", 7272));
    }

    [Fact]
    public void Only_this_machine_is_answered()
    {
        Assert.True(Server.IsLocal(IPAddress.Loopback));
        Assert.True(Server.IsLocal(IPAddress.IPv6Loopback));
        Assert.True(Server.IsLocal(IPAddress.Parse("::ffff:127.0.0.1")));
        Assert.True(Server.IsLocal(IPAddress.Parse("127.4.5.6")));
        Assert.False(Server.IsLocal(IPAddress.Parse("192.168.1.20")));
        Assert.False(Server.IsLocal(IPAddress.Parse("::ffff:192.168.1.20")));
        Assert.False(Server.IsLocal(IPAddress.Parse("fe80::1")));
        Assert.False(Server.IsLocal(null));
    }
}
