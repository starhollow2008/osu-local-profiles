using System.Text.Json;
using System.Text.Json.Serialization;

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
/// </remarks>
internal sealed class OfficialCalculator
{
    private static readonly JsonSerializerOptions RequestOptions = new(JsonText.Options)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    private readonly SemaphoreSlim one = new(1, 1);

    /// <summary>The osu! release whose calculators these are: the ppy.osu.Game package version.</summary>
    public string? Version { get; }

    /// <summary>The last failure, kept so it is reported rather than silently producing no pp.</summary>
    public string? LastError { get; private set; }

    private OfficialCalculator(string? version) => Version = version;

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

    /// <summary>One request answered, as the helper's pipe answered it: <c>{ ok: false }</c> on any failure.</summary>
    private async Task<JsonElement> Send(object request)
    {
        await one.WaitAsync();
        try
        {
            var line = JsonSerializer.Serialize(request, RequestOptions);
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
