using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace OsuLocalProfiles.Http;

/// <summary>
/// A PNG of a page of this app, rendered by a browser already installed: src/http/screenshot.ts.
/// Nothing is bundled: Chrome or Edge is driven over the DevTools protocol, started with an empty
/// profile of its own and killed afterwards, so the user's own browser is never touched. The page
/// is loaded with <c>?export=1</c>, which hides what only makes sense while it is being used.
/// </summary>
internal static class Screenshot
{
    /// <summary>A minimal DevTools client: one connection, one page, a handful of commands.</summary>
    private sealed class Devtools(ClientWebSocket socket, CancellationToken limit) : IDisposable
    {
        private int nextId = 1;

        public static async Task<Devtools> Connect(string url, CancellationToken limit)
        {
            var socket = new ClientWebSocket();
            try
            {
                await socket.ConnectAsync(new Uri(url), limit);
            }
            catch (Exception e) when (e is WebSocketException or IOException or HttpRequestException)
            {
                socket.Dispose();
                throw new InvalidOperationException("could not talk to the browser");
            }
            return new Devtools(socket, limit);
        }

        /// <summary>One command, and its answer: the message with its id, events before it passed over.</summary>
        public async Task<JsonElement> Send(string method, object? parameters = null)
        {
            var id = nextId++;
            var text = JsonText.Stringify(new { id, method, @params = parameters ?? new { } });
            await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, limit);
            var buffer = new byte[1 << 16];
            while (true)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, limit);
                    if (result.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("the browser closed the connection");
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                if (JsonText.TryParse(Encoding.UTF8.GetString(message.ToArray()), out var answer)
                    && Js.Get(answer, "id") is { ValueKind: JsonValueKind.Number } got && Js.NumberOf(got) == id)
                {
                    return answer;
                }
            }
        }

        public void Dispose()
        {
            try
            {
                socket.Abort();
            }
            catch (Exception e) when (e is WebSocketException or ObjectDisposedException)
            {
                /* already gone */
            }
            socket.Dispose();
        }
    }

    private static readonly HttpClient Local = new() { Timeout = TimeSpan.FromSeconds(2) };

    /// <summary>A value out of a <c>Runtime.evaluate</c> answer.</summary>
    private static JsonElement? Value(JsonElement answer) => Js.Get(Js.Get(Js.Get(answer, "result"), "result"), "value");

    /// <summary>How long a picture may take, from starting the browser to the PNG.</summary>
    public const int LimitMs = 60_000;
    public const string TimedOut = "the browser took too long to render the image";

    /// <summary>
    /// Render <paramref name="url"/> and return the PNG. <paramref name="selector"/> crops to one
    /// element and sets the viewport to exactly <paramref name="width"/> CSS pixels: a score card is
    /// laid out for osu!'s 1000px and is captured at 1000px. A browser that stops answering is
    /// killed at <see cref="LimitMs"/>, and the capture fails. <paramref name="browser"/> and
    /// <paramref name="limitMs"/> are for tests.
    /// </summary>
    public static async Task<byte[]> Capture(string url, int port = 9455, int width = 1280, string? selector = null, string? browser = null, int limitMs = LimitMs)
    {
        var binary = browser ?? StateApi.Browsers.Find() ?? throw new InvalidOperationException(
            "no Chrome, Edge or Chromium found to render the image. Save the page as HTML instead -- that needs nothing installed.");
        var userDataDir = Directory.CreateTempSubdirectory("olp-shot-").FullName;
        Process? started = null;
        Devtools? devtools = null;
        // Every wait on the browser shares one deadline for the whole capture.
        using var deadline = new CancellationTokenSource(limitMs);
        var limit = deadline.Token;
        try
        {
            var start = new ProcessStartInfo(binary) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var arg in new[]
            {
                "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
                $"--remote-debugging-port={port}", $"--user-data-dir={userDataDir}", $"--window-size={width},1000", url,
            })
            {
                start.ArgumentList.Add(arg);
            }
            started = Process.Start(start);

            // Wait for the debugging endpoint, then for the page to have drawn itself. The endpoint
            // gets as long as the capture has: a browser's first start on a slow machine took over 12s.
            string? target = null;
            while (target is null)
            {
                try
                {
                    if (JsonText.TryParse(await Local.GetStringAsync($"http://127.0.0.1:{port}/json", limit), out var list) && list.ValueKind == JsonValueKind.Array)
                    {
                        target = list.EnumerateArray()
                            .Where(t => Js.IsString(Js.Get(t, "type"), out var type) && type == "page")
                            .Select(t => Js.IsString(Js.Get(t, "webSocketDebuggerUrl"), out var ws) ? ws : null)
                            .FirstOrDefault(ws => !string.IsNullOrEmpty(ws));
                    }
                }
                catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !limit.IsCancellationRequested)
                {
                    /* not up yet */
                }
                if (target is null) await Task.Delay(200, limit);
            }
            if (target is null) throw new InvalidOperationException("the browser did not start in time");

            devtools = await Devtools.Connect(target, limit);
            if (selector is not null)
            {
                await devtools.Send("Emulation.setDeviceMetricsOverride", new { width, height = 1000, deviceScaleFactor = 1, mobile = false });
            }

            // No single event means "done": poll for the marker the page sets once it has painted.
            for (var attempt = 0; attempt < 50; attempt++)
            {
                var rendered = await devtools.Send("Runtime.evaluate", new { expression = "document.body.dataset.rendered === 'true'", returnByValue = true });
                if (Value(rendered) is { ValueKind: JsonValueKind.True }) break;
                await Task.Delay(200, limit);
            }
            // Cover art and medal icons are remote and load after the markup does.
            await Task.Delay(1200, limit);

            double x, y, w, h;
            if (selector is not null)
            {
                var box = await devtools.Send("Runtime.evaluate", new
                {
                    expression = $$"""
                        (() => {
                          const r = document.querySelector({{JsonText.Stringify(selector)}})?.getBoundingClientRect();
                          return r ? { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } : null;
                        })()
                        """,
                    returnByValue = true,
                });
                var value = Value(box);
                if (value is not { ValueKind: JsonValueKind.Object } v || Js.ToNumber(Js.Get(v, "width")) == 0)
                {
                    throw new InvalidOperationException("the page drew nothing to capture");
                }
                (x, y, w, h) = (Js.ToNumber(Js.Get(v, "x")), Js.ToNumber(Js.Get(v, "y")), Js.ToNumber(Js.Get(v, "width")), Js.ToNumber(Js.Get(v, "height")));
            }
            else
            {
                var metrics = await devtools.Send("Page.getLayoutMetrics");
                var size = Js.Get(Js.Get(metrics, "result"), "cssContentSize");
                (x, y, w, h) = size is { ValueKind: JsonValueKind.Object } s
                    ? (0, 0, Js.ToNumber(Js.Get(s, "width")), Js.ToNumber(Js.Get(s, "height")))
                    : (0, 0, width, 2000);
            }

            var shot = await devtools.Send("Page.captureScreenshot", new
            {
                format = "png",
                captureBeyondViewport = true,
                // Chrome refuses very tall captures; 20,000px is far beyond any real profile.
                clip = new { x = Math.Floor(x), y = Math.Floor(y), width = Math.Ceiling(w), height = Math.Min(20_000, Math.Ceiling(h)), scale = 1 },
            });
            return Js.IsString(Js.Get(Js.Get(shot, "result"), "data"), out var data) && data.Length > 0
                ? Convert.FromBase64String(data)
                : throw new InvalidOperationException("the browser rendered nothing");
        }
        catch (Exception) when (limit.IsCancellationRequested)
        {
            throw new InvalidOperationException(TimedOut);
        }
        finally
        {
            devtools?.Dispose();
            try
            {
                if (started is { HasExited: false }) started.Kill(entireProcessTree: true);
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                /* already gone */
            }
            started?.Dispose();
            // Not awaited, and never allowed to fail the capture: on Windows the browser holds its
            // profile folder a moment after it is killed.
            _ = RemoveWhenUnlocked(userDataDir);
        }
    }

    private static async Task RemoveWhenUnlocked(string dir)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Directory.Delete(dir, recursive: true);
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                await Task.Delay(400);
            }
        }
    }

    /// <summary>
    /// One capture at a time: each starts a throwaway browser on the same debugging port, so two at
    /// once would have the second connect to the first's, or fail to start at all.
    /// </summary>
    private static readonly SemaphoreSlim Queue = new(1, 1);

    public static async Task<byte[]> Queued(Func<Task<byte[]>> job)
    {
        await Queue.WaitAsync();
        try
        {
            return await job();
        }
        finally
        {
            Queue.Release();
        }
    }
}
