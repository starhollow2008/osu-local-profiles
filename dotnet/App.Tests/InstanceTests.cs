using System.Net;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using OsuLocalProfiles.Http;

namespace OsuLocalProfiles.Tests;

/// <summary>test/instance.test.ts and the browser command from test/browser.test.ts.</summary>
public class InstanceTests
{
    /// <summary>The app's server on a free port, with <paramref name="onQuit"/> as its Quit.</summary>
    private static async Task WithServer(Action? onQuit, Func<int, Task> body)
    {
        var install = Directory.CreateTempSubdirectory("olp-cs-instance-").FullName;
        File.WriteAllText(Path.Combine(install, "package.json"), """{"version":"9.9.9"}""");
        Directory.CreateDirectory(Path.Combine(install, "web"));
        using var data = new TempDb();
        var paths = new AppPaths(install);
        var app = Server.Build(new ServerOptions { Db = data.Db, Paths = paths, Config = AppConfig.Load(paths.DataDir), Port = 0, OnQuit = onQuit });
        await app.StartAsync();
        try
        {
            var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
            await body(new Uri(address.Replace("[::]", "localhost").Replace("0.0.0.0", "localhost")).Port);
        }
        finally
        {
            await app.DisposeAsync();
            Directory.Delete(install, recursive: true);
        }
    }

    private static async Task<HttpStatusCode> PostQuit(int port, string? origin)
    {
        using var client = new HttpClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/api/quit") { Content = new StringContent("{}") };
        if (origin is not null) request.Headers.Add("Origin", origin);
        using var response = await client.SendAsync(request);
        return response.StatusCode;
    }

    /* ---------------------------------------------------------- already running */

    [Fact]
    public async Task A_second_start_finds_the_copy_already_answering_on_the_port()
    {
        await WithServer(null, async port =>
        {
            var found = await Instance.RunningInstance(port);
            Assert.True(found.Running);
            Assert.Equal("9.9.9", found.Version);
        });
    }

    [Fact]
    public async Task Nothing_on_the_port_or_something_else_on_it_is_not_the_app()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var stranger = builder.Build();
        stranger.Run(context => context.Response.WriteAsJsonAsync(new { app = "something-else" }));
        await stranger.StartAsync();
        var port = new Uri(stranger.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First()).Port;
        try
        {
            Assert.False((await Instance.RunningInstance(port)).Running);
        }
        finally
        {
            await stranger.DisposeAsync();
        }
        // The same port, now closed: refused, and answered as "not running" rather than thrown.
        Assert.False((await Instance.RunningInstance(port)).Running);
    }

    /* ------------------------------------------------------------------- quit */

    [Fact]
    public async Task Quit_stops_the_app_from_its_own_page_after_answering()
    {
        var quit = 0;
        var called = new TaskCompletionSource();
        await WithServer(() => { Interlocked.Increment(ref quit); called.TrySetResult(); }, async port =>
        {
            Assert.Equal(HttpStatusCode.OK, await PostQuit(port, $"http://localhost:{port}"));
            await called.Task.WaitAsync(TimeSpan.FromSeconds(10));
        });
        Assert.Equal(1, quit);
    }

    [Fact]
    public async Task Another_websites_page_cannot_stop_the_app()
    {
        var quit = 0;
        await WithServer(() => Interlocked.Increment(ref quit), async port =>
        {
            Assert.Equal(HttpStatusCode.Forbidden, await PostQuit(port, "https://example.com"));
            // DNS rebinding reaches this port under another name, and still names that origin.
            Assert.Equal(HttpStatusCode.Forbidden, await PostQuit(port, $"http://evil.example:{port}"));
            Assert.Equal(HttpStatusCode.Forbidden, await PostQuit(port, "null"));
            await Task.Delay(400);
        });
        Assert.Equal(0, quit);
    }

    [Fact]
    public async Task A_copy_given_no_way_to_stop_says_so_rather_than_pretending()
    {
        // No Origin: not a web page, as the tray launcher or curl ask.
        await WithServer(null, async port => Assert.Equal(HttpStatusCode.BadRequest, await PostQuit(port, null)));
    }

    /* ------------------------------------------------------------- the launcher */

    /// <summary>stdin as a pipe delivers it: in whatever pieces, then closed.</summary>
    private sealed class Pieces(params string[] pieces) : Stream
    {
        private Queue<byte[]> chunks = new(pieces.Select(p => Encoding.UTF8.GetBytes(p)));

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (chunks.Count == 0) return 0;
            var chunk = chunks.Peek();
            var n = Math.Min(chunk.Length, count);
            Array.Copy(chunk, 0, buffer, offset, n);
            // A piece larger than the read arrives over several, as through a real pipe.
            if (n == chunk.Length) chunks.Dequeue();
            else chunks = new Queue<byte[]>(new[] { chunk[n..] }.Concat(chunks.Skip(1)));
            return n;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static async Task<(int Stops, bool Deliberate, List<string> Messages)> Run(params string[] pieces)
    {
        var stops = 0;
        var deliberate = false;
        var messages = new List<string>();
        await Instance.StopWhenLauncherCloses(new Pieces(pieces), d => { stops++; deliberate = d; }, m => messages.Add(m.GetRawText()));
        return (stops, deliberate, messages);
    }

    [Fact]
    public async Task The_app_stops_once_when_the_tray_launcher_closes_its_end()
    {
        Assert.Equal(1, (await Run()).Stops);
    }

    [Fact]
    public async Task A_Quit_from_the_tray_is_told_apart_from_the_launcher_going_away()
    {
        Assert.True((await Run("{\"quit\":true}\n")).Deliberate);
        Assert.False((await Run()).Deliberate);

        // Lines arrive in whatever pieces the pipe gives them; anything unreadable is passed over.
        var metered = await Run("{\"mete", "red\":true}\nnot json\n{\"metered\":null}\n");
        Assert.Equal(["{\"metered\":true}", "{\"metered\":null}"], metered.Messages);
        Assert.False(metered.Deliberate);

        // A line still not ended past 64 KiB is thrown away, quit or not.
        var huge = await Run("{\"quit\":true,\"pad\":\"" + new string('x', 70_000), "\"}\n");
        Assert.False(huge.Deliberate);
        Assert.Empty(huge.Messages);
    }

    [Fact]
    public void The_tray_launcher_restarts_the_app_after_an_update_as_the_terminal_loop_does()
    {
        Func<string, string?> env(string? value) => name => name == Instance.LauncherEnv ? value : null;
        Assert.True(Instance.LauncherRestarts(env("tray")));
        Assert.True(Instance.LaunchedFromTray(env("tray")));
        Assert.True(Instance.LauncherRestarts(env("restarts")));
        Assert.False(Instance.LaunchedFromTray(env("restarts")));
        Assert.False(Instance.LaunchedFromTray(env(null)));
        Assert.True(Instance.StartedWithComputer(name => name == Instance.StartupEnv ? "1" : null));
        Assert.False(Instance.StartedWithComputer(_ => null));
    }

    /* ---------------------------------------------------------------- the browser */

    [Fact]
    public void Windows_opens_the_page_through_start_with_the_line_as_written()
    {
        Assert.Equal(("cmd", "/c start \"\" http://localhost:7272"), Browser.Command("win32", "http://localhost:7272"));
        // & and ^ are all cmd would act on in a URL: escaped, so a query can never be a second command.
        Assert.Equal(("cmd", "/c start \"\" http://x/?a=1^&b=^^2"), Browser.Command("win32", "http://x/?a=1&b=^2"));
        Assert.Equal(("open", "http://localhost:7272"), Browser.Command("darwin", "http://localhost:7272"));
        Assert.Equal(("xdg-open", "http://localhost:7272"), Browser.Command("linux", "http://localhost:7272"));
    }

    [Fact]
    public void Truthiness_is_JavaScripts()
    {
        foreach (var falsy in new object?[] { null, false, 0, "" })
        {
            Assert.False(Js.Truthy(JsonText.From(falsy)));
        }
        Assert.False(Js.Truthy(null));
        foreach (var truthy in new object[] { true, 1, "false", "0", Array.Empty<int>(), new { } })
        {
            Assert.True(Js.Truthy(JsonText.From(truthy)));
        }
    }
}
