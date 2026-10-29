using System.Net;
using System.Text;
using OsuLocalProfiles.Clients;

namespace OsuLocalProfiles.Tests;

/// <summary>osu!, answering from a function: the real client and gate, with no time between turns.</summary>
internal sealed class FakeOsu(Func<string, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<string> Asked { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Asked) Asked.Add(request.RequestUri!.ToString());
        return Task.FromResult(answer(request.RequestUri!.ToString()));
    }

    public OsuWeb Client() => new(this, new RequestGate(0));

    public static HttpResponseMessage Answer(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8) };

    /// <summary>A beatmapset's page, as osu! serves it.</summary>
    public static string BeatmapsetPage(string json) =>
        $"<html><script id=\"json-beatmapset\" type=\"application/json\">\n  {json}\n</script></html>";
}
