// A thin wrapper around osu!'s own difficulty and performance calculators.
//
// Every reimplementation of osu!'s pp algorithm lags its reworks, so this references the
// official ppy.osu.Game.Rulesets.* packages instead. Keeping current with a rework is a
// version bump in PpCalculator.csproj and nothing else.
//
// The replay is decoded by osu!'s own LegacyScoreDecoder rather than by us. That matters:
// it sets IsLegacyScore from the replay version, populates MaximumStatistics from the
// beatmap, fills LegacyTotalScore, and reads lazer's extended block (mods with their
// settings). osu!stable and osu!lazer replays therefore both come out exactly as osu!
// itself would interpret them, with no branching on our side.
//
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
// Staying resident avoids paying ~150ms of runtime startup for every score. The first line
// out announces readiness and the osu! version whose calculators these are.

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using osu.Game.Beatmaps;
using osu.Game.Beatmaps.Formats;
using osu.Game.IO;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Catch;
using osu.Game.Rulesets.Mania;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Scoring;
using osu.Game.Rulesets.Taiko;
using osu.Game.Scoring;
using osu.Game.Scoring.Legacy;

namespace OsuLocalProfiles.PpCalculator;

public sealed class Request
{
    /// <summary>The .osr replay to score. lazer stores these without a file extension.</summary>
    [JsonPropertyName("replayPath")] public string ReplayPath { get; set; } = string.Empty;

    /// <summary>The .osu file the replay was set on, located by its MD5.</summary>
    [JsonPropertyName("beatmapPath")] public string BeatmapPath { get; set; } = string.Empty;

    /// <summary>
    /// Acronyms to remove from the decoded score before calculating, so the play is scored
    /// as if those mods had not been on.
    /// </summary>
    /// <remarks>
    /// Used for Relax and Autopilot, which osu! never awards pp for. Removing the mod and
    /// letting osu!'s own calculators score what is left produces a real osu! pp value for
    /// a mod set the play did not literally use -- which the app labels as such. It is not
    /// a second pp implementation: everything below this line is still osu!'s code.
    ///
    /// Only the mod list changes. The hit statistics, the beatmap, and the legacy handling
    /// the decoder applied (including the Classic mod added to osu!stable replays) are all
    /// left exactly as decoded.
    /// </remarks>
    [JsonPropertyName("stripMods")] public string[]? StripMods { get; set; }
}

public static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// The osu! release these calculators come from -- the ppy.osu.Game package version, e.g.
    /// 2026.730.0 -- so a stored pp value can say which algorithm produced it. The build
    /// metadata after a '+' is a commit hash, not something a person reads.
    /// </summary>
    private static readonly string OsuVersion =
        typeof(Beatmap).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0]
        ?? typeof(Beatmap).Assembly.GetName().Version?.ToString()
        ?? "unknown";

    public static int Main()
    {
        // Announce readiness so the caller does not race the first request.
        Console.Out.WriteLine(JsonSerializer.Serialize(new { ready = true, version = OsuVersion }, JsonOptions));
        Console.Out.Flush();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length == 0) continue;

            string response;
            try
            {
                var request = JsonSerializer.Deserialize<Request>(line, JsonOptions)
                              ?? throw new InvalidOperationException("empty request");
                response = JsonSerializer.Serialize(Calculate(request), JsonOptions);
            }
            catch (Exception ex)
            {
                response = JsonSerializer.Serialize(new { ok = false, error = ex.Message }, JsonOptions);
            }

            Console.Out.WriteLine(response);
            Console.Out.Flush();
        }

        return 0;
    }

    private static object Calculate(Request request)
    {
        var working = new ProcessorWorkingBeatmap(request.BeatmapPath);

        Score score;
        using (var stream = File.OpenRead(request.ReplayPath))
            score = new HelperScoreDecoder(working).Parse(stream);

        var scoreInfo = score.ScoreInfo;
        var ruleset = RulesetFor(scoreInfo.Ruleset.OnlineID);

        var stripped = false;
        if (request.StripMods is { Length: > 0 })
        {
            var strip = new HashSet<string>(request.StripMods, StringComparer.OrdinalIgnoreCase);
            var kept = scoreInfo.Mods.Where(m => !strip.Contains(m.Acronym)).ToArray();
            stripped = kept.Length != scoreInfo.Mods.Length;
            // Assigning always would rewrite the mod list even when nothing was removed,
            // which is a needless round trip through APIMods.
            if (stripped) scoreInfo.Mods = kept;
        }

        var difficulty = ruleset.CreateDifficultyCalculator(working).Calculate(scoreInfo.Mods);
        var performance = ruleset.CreatePerformanceCalculator()?.Calculate(scoreInfo, difficulty);

        return new
        {
            ok = true,
            stripped,
            stars = difficulty.StarRating,
            maxCombo = difficulty.MaxCombo,
            // osu!'s own values, so they can be cross-checked against ours.
            accuracy = scoreInfo.Accuracy,
            combo = scoreInfo.MaxCombo,
            rank = scoreInfo.Rank.ToString(),
            // The same play on osu!'s two scales, both as osu! itself computes them.
            standardisedScore = scoreInfo.GetDisplayScore(ScoringMode.Standardised),
            classicScore = scoreInfo.GetDisplayScore(ScoringMode.Classic),
            // Set by the decoder for a stable replay: the number stable itself recorded.
            legacyTotalScore = scoreInfo.LegacyTotalScore,
            isLegacy = scoreInfo.IsLegacyScore,
            mods = scoreInfo.Mods.Select(m => m.Acronym).ToArray(),
            pp = performance?.Total,
            // The pp's own parts -- aim, speed, accuracy, flashlight and reading in
            // osu!standard -- under the names osu! displays them by. Total is left out: it is
            // `pp` above. The parts are not a plain sum of it; osu! combines them its own way.
            breakdown = performance?.GetAttributesForDisplay()
                .Where(a => a.PropertyName != nameof(performance.Total))
                .Select(a => new { key = a.PropertyName, name = a.DisplayName, pp = a.Value })
                .ToArray(),
            version = OsuVersion,
        };
    }

    private static Ruleset RulesetFor(int legacyId) => legacyId switch
    {
        0 => new OsuRuleset(),
        1 => new TaikoRuleset(),
        2 => new CatchRuleset(),
        3 => new ManiaRuleset(),
        _ => throw new ArgumentException($"unsupported ruleset id {legacyId}"),
    };
}

/// <summary>
/// A <see cref="LegacyScoreDecoder"/> pinned to one already-loaded beatmap, so decoding
/// never needs a beatmap database to look the map up by hash.
/// </summary>
public sealed class HelperScoreDecoder : LegacyScoreDecoder
{
    private readonly WorkingBeatmap beatmap;

    public HelperScoreDecoder(WorkingBeatmap beatmap)
    {
        this.beatmap = beatmap;
    }

    protected override Ruleset GetRuleset(int rulesetId) => rulesetId switch
    {
        0 => new OsuRuleset(),
        1 => new TaikoRuleset(),
        2 => new CatchRuleset(),
        3 => new ManiaRuleset(),
        _ => throw new ArgumentException($"unsupported ruleset id {rulesetId}"),
    };

    protected override WorkingBeatmap GetBeatmap(string md5Hash) => beatmap;
}

/// <summary>A <see cref="WorkingBeatmap"/> backed by a .osu file on disk.</summary>
public sealed class ProcessorWorkingBeatmap : WorkingBeatmap
{
    private readonly Beatmap beatmap;

    public ProcessorWorkingBeatmap(string file)
        : this(ReadFromFile(file))
    {
    }

    private ProcessorWorkingBeatmap(Beatmap beatmap)
        : base(beatmap.BeatmapInfo, null)
    {
        this.beatmap = beatmap;
    }

    private static Beatmap ReadFromFile(string filename)
    {
        using var stream = File.OpenRead(filename);
        using var reader = new LineBufferedReader(stream);
        return Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    }

    protected override osu.Game.Skinning.ISkin GetSkin() => null!;
    public override Stream GetStream(string storagePath) => null!;
    protected override IBeatmap GetBeatmap() => beatmap;
    public override osu.Framework.Graphics.Textures.Texture GetBackground() => null!;
    protected override osu.Framework.Audio.Track.Track GetBeatmapTrack() => null!;
}
