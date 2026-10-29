using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace OsuLocalProfiles.Calc;

/// <summary>One part of a pp value, as osu! displays it: Aim, Speed, Accuracy and so on.</summary>
internal sealed record PpPart(string Key, string Name, double Pp);

/// <summary>What osu!'s calculators say about one play (src/calc/official.ts, <c>OfficialResult</c>).</summary>
internal sealed record OfficialResult(
    double Stars,
    double? StandardisedScore,
    double? ClassicScore,
    double? LegacyTotalScore,
    double MaxCombo,
    double Accuracy,
    double Combo,
    string Rank,
    bool IsLegacy,
    string[] Mods,
    double? Pp,
    bool Stripped,
    List<PpPart> Breakdown);

/// <summary>
/// osu!'s own difficulty and performance calculators, in-process (docs/csharp-port.md, phase 3).
/// The same code the separate helper runs (tools/PpCalculator, <c>Program.Respond</c>), asked with
/// the same JSON requests and read back from the same JSON answers, so the two can never disagree.
/// </summary>
/// <remarks>
/// There is no fallback calculator. When osu!'s code cannot be loaded, there is no calculator,
/// no pp is stored, and the app says so. Requests are answered one at a time, as the helper's pipe
/// answered them.
///
/// The one calculator that is not in-process is the helper built from the player's own osu! source
/// (roadmap 5.70, <see cref="SourceHelper"/>): it runs code nobody has checked, so it stays a
/// separate process, asked over the same JSON lines as src/calc/official.ts (<see cref="Start"/>).
/// </remarks>
internal sealed class OfficialCalculator : IDisposable
{
    private static readonly JsonSerializerOptions RequestOptions = new(JsonText.Options)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    private readonly SemaphoreSlim one = new(1, 1);

    /// <summary>The separate helper answering in place of the in-process code; null for osu!'s release.</summary>
    private readonly HelperProcess? helper;

    /// <summary>The osu! release whose calculators these are: the ppy.osu.Game package version.</summary>
    public string? Version { get; }

    /// <summary>The last failure, kept so it is reported rather than silently producing no pp.</summary>
    public string? LastError { get; private set; }

    private OfficialCalculator(string? version, HelperProcess? helper = null)
    {
        Version = version;
        this.helper = helper;
    }

    /// <summary>The calculator, or null with the reason when osu!'s code cannot be loaded.</summary>
    public static (OfficialCalculator? Calculator, string? Problem) Create()
    {
        try
        {
            var ready = OsuLocalProfiles.PpCalculator.Program.ReadyLine();
            if (!JsonText.TryParse(ready, out var hello) || Js.Get(hello, "ready") is not { ValueKind: JsonValueKind.True })
            {
                return (null, "osu!'s calculator did not say it was ready");
            }
            return (new OfficialCalculator(Js.IsString(Js.Get(hello, "version"), out var v) ? v : null), null);
        }
        catch (Exception e)
        {
            return (null, $"osu!'s calculator could not be loaded: {e.Message}");
        }
    }

    /// <summary>
    /// A helper started as its own process, and only that one: a helper built from the player's osu!
    /// source must never fall through to the release, which would price the profile with a formula
    /// nobody chose. <paramref name="version"/> names it in place of the one it reports, which for a
    /// build from source is osu!'s placeholder <c>0.0.0</c>. Null when it cannot start, or does not say
    /// it is ready within 30 seconds.
    /// </summary>
    public static async Task<OfficialCalculator?> Start(HelperCandidate candidate, string? version = null)
    {
        var process = await HelperProcess.Start(candidate, StartupTimeout);
        return process is null ? null : new OfficialCalculator(version ?? process.Version, process);
    }

    /// <summary>Stops a separate helper; nothing to stop in-process.</summary>
    public void Dispose() => helper?.Dispose();

    /// <summary>One request answered, as the helper's pipe answered it: <c>{ ok: false }</c> on any failure.</summary>
    private async Task<JsonElement> Send(object request)
    {
        await one.WaitAsync();
        try
        {
            var line = JsonSerializer.Serialize(request, RequestOptions);
            if (helper is not null) return await helper.Ask(line, RequestTimeout);
            var answer = Task.Run(() => OsuLocalProfiles.PpCalculator.Program.Respond(line));
            if (await Task.WhenAny(answer, Task.Delay(RequestTimeout)) != answer)
            {
                return JsonText.From(new { ok = false, error = "calculator timed out" });
            }
            return JsonText.TryParse(answer.Result, out var parsed)
                ? parsed
                : JsonText.From(new { ok = false, error = $"unparseable response: {Js.Slice(answer.Result, 120)}" });
        }
        finally
        {
            one.Release();
        }
    }

    private static double? NumberOrNull(JsonElement response, string key) =>
        Js.Get(response, key) is { ValueKind: JsonValueKind.Number } n ? Js.NumberOf(n) : null;

    /// <summary>
    /// A play's pp, stars, accuracy, grade and both scores, from its replay and beatmap. Null when
    /// osu! could not price it, with the reason in <see cref="LastError"/>.
    /// </summary>
    public async Task<OfficialResult?> Calculate(string replayPath, string beatmapPath, string[]? stripMods = null,
        IReadOnlyList<JsonElement>? mods = null, bool ignoreLegacyTotalScore = false)
    {
        var response = await Send(new
        {
            replayPath,
            beatmapPath,
            stripMods = stripMods is { Length: > 0 } ? stripMods : null,
            mods,
            ignoreLegacyTotalScore = ignoreLegacyTotalScore ? (bool?)true : null,
        });
        if (Js.Get(response, "ok") is not { ValueKind: JsonValueKind.True } || NumberOrNull(response, "stars") is not { } stars)
        {
            if (Js.IsString(Js.Get(response, "error"), out var error)) LastError = error;
            return null;
        }
        var breakdown = Js.Get(response, "breakdown") is { ValueKind: JsonValueKind.Array } parts
            ? [.. parts.EnumerateArray().Select(p => new PpPart(
                Js.IsString(Js.Get(p, "key"), out var k) ? k : "",
                Js.IsString(Js.Get(p, "name"), out var n) ? n : "",
                NumberOrNull(p, "pp") ?? 0))]
            : new List<PpPart>();
        return new OfficialResult(
            stars,
            NumberOrNull(response, "standardisedScore"),
            NumberOrNull(response, "classicScore"),
            NumberOrNull(response, "legacyTotalScore"),
            NumberOrNull(response, "maxCombo") ?? 0,
            NumberOrNull(response, "accuracy") ?? 0,
            NumberOrNull(response, "combo") ?? 0,
            Js.IsString(Js.Get(response, "rank"), out var rank) ? rank : "",
            Js.Get(response, "isLegacy") is { ValueKind: JsonValueKind.True },
            Js.Get(response, "mods") is { ValueKind: JsonValueKind.Array } list ? [.. list.EnumerateArray().Select(m => m.GetString() ?? "")] : [],
            NumberOrNull(response, "pp"),
            Js.Get(response, "stripped") is { ValueKind: JsonValueKind.True },
            breakdown);
    }

    /// <summary>
    /// Whether osu! ranks a mod combination, from osu!'s own mod classes: lazer's mods, or a stable
    /// bitmask. Null when it cannot answer.
    /// </summary>
    public async Task<(bool Ranked, string[] Unranked)?> Ranked(int ruleset, JsonElement? mods, long? legacyMods)
    {
        var response = await Send(new { type = "ranked", ruleset, mods, legacyMods });
        if (Js.Get(response, "ok") is not { ValueKind: JsonValueKind.True } || Js.Get(response, "ranked") is not { ValueKind: JsonValueKind.True or JsonValueKind.False } ranked)
        {
            if (Js.IsString(Js.Get(response, "error"), out var error)) LastError = error;
            return null;
        }
        var unranked = Js.Get(response, "unranked") is { ValueKind: JsonValueKind.Array } list
            ? list.EnumerateArray().Select(m => m.GetString() ?? "").ToArray()
            : [];
        return (ranked.ValueKind == JsonValueKind.True, unranked);
    }
}

/// <summary>How to start a helper: a program and its arguments (src/calc/official.ts).</summary>
internal sealed record HelperCandidate(string Command, IReadOnlyList<string> Args);

/// <summary>
/// A pp helper running as its own process: a ready line first, then one JSON request per line and
/// one answer line for each (src/calc/official.ts, <c>OfficialCalculator</c>). Asked one request at a
/// time by <see cref="OfficialCalculator"/>, since the line protocol has no request ids.
/// </summary>
internal sealed class HelperProcess : IDisposable
{
    private readonly Process process;
    private readonly ChannelReader<string> lines;
    private volatile bool dead;

    /// <summary>The osu! release it reported in its ready line, if any.</summary>
    public string? Version { get; private set; }

    private HelperProcess(Process process, ChannelReader<string> lines)
    {
        this.process = process;
        this.lines = lines;
    }

    public static async Task<HelperProcess?> Start(HelperCandidate candidate, TimeSpan timeout)
    {
        var start = new ProcessStartInfo(candidate.Command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new System.Text.UTF8Encoding(false),
            // UTF-8 without a byte-order mark, as Node writes to a pipe.
            StandardInputEncoding = new System.Text.UTF8Encoding(false),
        };
        foreach (var arg in candidate.Args) start.ArgumentList.Add(arg);
        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InvalidOperationException("the helper did not start");
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
        process.StandardInput.AutoFlush = true;

        // Every line it prints, in order; the channel completes when it exits.
        var channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
        _ = Task.Run(async () =>
        {
            try
            {
                while (await process.StandardOutput.ReadLineAsync() is { } line) channel.Writer.TryWrite(line);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
            {
                /* gone */
            }
            channel.Writer.TryComplete();
        });
        // Read and dropped, as Node never reads it, so a chatty helper never fills the pipe and stalls.
        _ = Task.Run(async () =>
        {
            try
            {
                await process.StandardError.BaseStream.CopyToAsync(Stream.Null);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
            {
                /* gone */
            }
        });

        var helper = new HelperProcess(process, channel.Reader);
        if (await helper.NextLine(timeout) is { } hello && JsonText.TryParse(hello, out var ready)
            && Js.Get(ready, "ready") is { ValueKind: JsonValueKind.True })
        {
            helper.Version = Js.IsString(Js.Get(ready, "version"), out var v) ? v : null;
            return helper;
        }
        helper.Dispose();
        return null;
    }

    /// <summary>The next line, or null when it exited first or the wait ran out.</summary>
    private async Task<string?> NextLine(TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        try
        {
            return await lines.ReadAsync(cancel.Token);
        }
        catch (Exception e) when (e is OperationCanceledException or ChannelClosedException)
        {
            return null;
        }
    }

    /// <summary>One request and its answer, or <c>{ ok: false }</c> with why.</summary>
    public async Task<JsonElement> Ask(string request, TimeSpan timeout)
    {
        if (dead) return JsonText.From(new { ok = false });
        try
        {
            await process.StandardInput.WriteAsync(request + (char)10);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
            dead = true;
            return JsonText.From(new { ok = false, error = "calculator exited" });
        }
        using var cancel = new CancellationTokenSource(timeout);
        try
        {
            var line = await lines.ReadAsync(cancel.Token);
            return JsonText.TryParse(line, out var parsed)
                ? parsed
                : JsonText.From(new { ok = false, error = $"unparseable response: {Js.Slice(line, 120)}" });
        }
        catch (OperationCanceledException)
        {
            return JsonText.From(new { ok = false, error = "calculator timed out" });
        }
        catch (ChannelClosedException)
        {
            dead = true;
            return JsonText.From(new { ok = false, error = "calculator exited" });
        }
    }

    public void Dispose()
    {
        dead = true;
        try
        {
            process.StandardInput.Close();
            process.Kill(true);
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            /* already gone */
        }
        process.Dispose();
    }
}
