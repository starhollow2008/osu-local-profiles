using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using OsuLocalProfiles.Http;

namespace OsuLocalProfiles.Tests;

/// <summary>Rendering a picture with an installed browser: test/screenshot.test.ts.</summary>
public class ScreenshotTests
{
    /// <summary>
    /// A debugging endpoint that lists a page and accepts its connection, then never answers a
    /// command: a browser that has stopped responding.
    /// </summary>
    private static (int Port, Action Stop) SilentBrowser()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var held = new List<TcpClient>();
        _ = Task.Run(async () =>
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync();
                }
                catch (Exception e) when (e is SocketException or ObjectDisposedException)
                {
                    return;
                }
                lock (held) held.Add(client);
                _ = Task.Run(async () =>
                {
                    var stream = client.GetStream();
                    var buffer = new byte[8192];
                    var request = "";
                    while (!request.Contains("\r\n\r\n"))
                    {
                        var read = await stream.ReadAsync(buffer);
                        if (read == 0) return;
                        request += Encoding.ASCII.GetString(buffer, 0, read);
                    }
                    var key = request.Split("\r\n").FirstOrDefault(l => l.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase));
                    string response;
                    if (key is not null)
                    {
                        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key[(key.IndexOf(':') + 1)..].Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                        response = $"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n";
                    }
                    else
                    {
                        var body = $$"""[{"type":"page","webSocketDebuggerUrl":"ws://127.0.0.1:{{port}}/devtools/page/1"}]""";
                        response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n\r\n{body}";
                    }
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(response));
                    if (key is null) client.Close();
                });
            }
        });
        return (port, () =>
        {
            listener.Stop();
            lock (held) foreach (var c in held) c.Close();
        });
    }

    [Fact]
    public async Task A_browser_that_stops_answering_fails_the_capture_at_its_time_limit()
    {
        var (port, stop) = SilentBrowser();
        try
        {
            var watch = Stopwatch.StartNew();
            // The browser started is Node, which refuses Chrome's flags and exits at once.
            var e = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                Screenshot.Capture("http://127.0.0.1:1/", port, browser: "node", limitMs: 1500));
            Assert.Equal(Screenshot.TimedOut, e.Message);
            Assert.InRange(watch.ElapsedMilliseconds, 1400, 5000);
        }
        finally
        {
            stop();
        }
    }

    [Fact]
    public async Task A_browser_that_never_opens_its_debugging_endpoint_fails_at_the_time_limit()
    {
        // A port with nothing on it: the browser never opens its debugging endpoint.
        var free = new TcpListener(IPAddress.Loopback, 0);
        free.Start();
        var port = ((IPEndPoint)free.LocalEndpoint).Port;
        free.Stop();
        var watch = Stopwatch.StartNew();
        var e = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Screenshot.Capture("http://127.0.0.1:1/", port, browser: "node", limitMs: 1500));
        Assert.Equal(Screenshot.TimedOut, e.Message);
        Assert.InRange(watch.ElapsedMilliseconds, 1400, 5000);
    }
}
