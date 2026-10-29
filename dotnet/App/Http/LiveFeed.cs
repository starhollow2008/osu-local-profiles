using System.Threading.Channels;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Http;

/// <summary>
/// The live feed, <c>/api/events</c>: server-sent events to every open page, with the Node app's
/// event names and payloads (src/http/server.ts, <c>broadcast</c> and the tracker's events).
/// </summary>
/// <remarks>
/// Each page has a queue of its own, written in the order events are broadcast, so a slow page
/// never holds up the others and never sees two events out of order. The page keeps the stream
/// open only while its tab is visible (web/js/main.js): a browser allows six connections per origin.
/// </remarks>
internal sealed class LiveFeed
{
    private readonly object gate = new();
    private readonly List<Channel<string>> clients = [];

    /// <summary>How often a comment is sent to an idle stream, so nothing between gives up on it.</summary>
    public static readonly TimeSpan PingEvery = TimeSpan.FromSeconds(20);

    /// <summary>How many pages are listening, for the tests.</summary>
    public int Listeners
    {
        get
        {
            lock (gate) return clients.Count;
        }
    }

    /// <summary>One event to every open page, its data written as <c>JSON.stringify</c> writes it.</summary>
    public void Broadcast(string name, object? data)
    {
        var payload = $"event: {name}\ndata: {JsonText.Stringify(data)}\n\n";
        lock (gate)
        {
            foreach (var client in clients) client.Writer.TryWrite(payload);
        }
    }

    /// <summary>Hold a page's stream open until it goes, writing it every event broadcast meanwhile.</summary>
    public async Task Serve(HttpContext context)
    {
        var response = context.Response;
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        response.StatusCode = 200;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-store";
        response.Headers.Connection = "keep-alive";

        var channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
        lock (gate) clients.Add(channel);
        var gone = context.RequestAborted;
        using var ping = new Timer(_ => channel.Writer.TryWrite(": ping\n\n"), null, PingEvery, PingEvery);
        try
        {
            await response.WriteAsync("retry: 2000\n\n", gone);
            await response.Body.FlushAsync(gone);
            await foreach (var payload in channel.Reader.ReadAllAsync(gone))
            {
                await response.WriteAsync(payload, gone);
                await response.Body.FlushAsync(gone);
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException)
        {
            /* the page closed, or its tab was hidden */
        }
        finally
        {
            lock (gate) clients.Remove(channel);
        }
    }

    /// <summary>
    /// Every tracker event, sent on as <c>startServer</c> sends it. Recalculation progress goes out
    /// once per percent, which is all a toast can show.
    /// </summary>
    public void Follow(PlayTracker tracker)
    {
        tracker.Score += score => Broadcast("score", score);
        // A play with no score still moves the play count and the charts.
        tracker.IncompletePlay += play => Broadcast("incomplete", play);
        tracker.Filtered += play => Broadcast("filtered", play);
        tracker.Refused += play => Broadcast("refused", RefusedPayload(play));
        tracker.CaughtUp += result => Broadcast("caught-up", result);
        var lastPercent = -1.0;
        var percentGate = new object();
        tracker.Recalculating += (done, total) =>
        {
            var percent = total == 0 ? 100 : Math.Floor((double)done / total * 100);
            lock (percentGate)
            {
                if (percent == lastPercent && done != 0) return;
                lastPercent = percent;
            }
            Broadcast("recompute-progress", new { done, total, percent });
        };
        tracker.Recalculated += result =>
        {
            lock (percentGate) lastPercent = -1;
            Broadcast("recompute", new { result.Considered, result.Updated, result.Skipped, result.GainedPp, everyProfile = true });
        };
        tracker.Error += e => Broadcast("tracker-error", new { message = e.Message });
        // The beatmap index runs beside the page; it shows the progress while plays wait on it.
        tracker.Indexing += state => Broadcast("indexing", state);
        // An import of past plays, so every open page can show how far it has got.
        tracker.Importing += state => Broadcast("importing", state);
    }

    /// <summary>
    /// A replay turned away: who set it and which map for another player's, nothing more for one
    /// that could not be read, as the Node app leaves those keys out.
    /// </summary>
    public static object RefusedPayload(RefusedPlay play) => play.Reason == "another-player"
        ? new { reason = play.Reason, player = play.Player, title = play.Title, titleOriginal = play.TitleOriginal, at = play.At }
        : new { reason = play.Reason, at = play.At };
}
