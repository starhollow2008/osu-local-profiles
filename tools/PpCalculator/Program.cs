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
//
// Four kinds of request: a pp calculation (the default), `"type": "ranked"`, which asks
// osu!'s own mod classes whether a mod combination is ranked, `"type": "judgements"`, the
// judgement counts of a perfect play on a beatmap, for the app's pp calculator, and
// `"type": "difficulty"`, which describes a beatmap for the ruleset and mods as song select does.
//
// A McOsu play has no replay of its own, so the app builds an osu!stable one from McOsu's
// scores.db and hands that over like any other: the decoder still does all of the stable
// work. What a stable replay cannot hold -- a custom speed, a difficulty override -- comes
// alongside it as `mods`, applied after decoding.

using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using osu.Game.Beatmaps;
using osu.Game.Beatmaps.Formats;
using osu.Game.Beatmaps.Legacy;
using osu.Game.IO;
using osu.Game.Online.API;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Catch;
using osu.Game.Rulesets.Mania;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Scoring;
using osu.Game.Rulesets.Taiko;
using osu.Game.Scoring;
using osu.Game.Scoring.Legacy;

namespace OsuLocalProfiles.PpCalculator;

public sealed class Request
{
    /// <summary>"ranked" for a ranked-mods question; absent for a pp calculation.</summary>
    [JsonPropertyName("type")] public string? Type { get; set; }

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

    /// <summary>Ranked and judgements requests: the ruleset's legacy id (0 osu!, 1 taiko, 2 catch, 3 mania).</summary>
    [JsonPropertyName("ruleset")] public int Ruleset { get; set; }

    /// <summary>
    /// Ranked request: the mods a lazer replay recorded, with any settings the player changed.
    /// Calculation request: the mods to score with in place of the ones the replay decoded to.
    /// </summary>
    /// <remarks>
    /// For a McOsu play. McOsu writes no replay, so the app builds an osu!stable one from its
    /// scores.db, and a stable replay's mod bitmask cannot say what McOsu can: a speed that is
    /// not 1.5x or 0.75x, or a CS/AR/OD/HP override. Those arrive here as osu!'s own mods with
    /// settings (Double Time at 1.2x, Difficulty Adjust), and replace the decoded list after
    /// the decoder has done its stable work. The Classic mod it added stays.
    /// </remarks>
    [JsonPropertyName("mods")] public ModRequest[]? Mods { get; set; }

    /// <summary>
    /// Calculation request: price the play without the total score osu!stable recorded.
    /// </summary>
    /// <remarks>
    /// osu! estimates a stable play's combo breaks from its total score, assuming stable's own
    /// mod multipliers. A McOsu play at a speed its mod bits did not set, or with overridden
    /// difficulty, recorded a total on a different footing, which would misstate the breaks.
    /// Without it osu! estimates them from the combo, as it does for every lazer play. Only the
    /// pp is affected: the classic score reported is still the one recorded.
    /// </remarks>
    [JsonPropertyName("ignoreLegacyTotalScore")] public bool IgnoreLegacyTotalScore { get; set; }

    /// <summary>Ranked request: an osu!stable replay's mod bitmask, used in place of <see cref="Mods"/>.</summary>
    [JsonPropertyName("legacyMods")] public long? LegacyMods { get; set; }
}

/// <summary>One mod as lazer writes it into a replay: an acronym and its changed settings.</summary>
public sealed class ModRequest
{
    [JsonPropertyName("acronym")] public string Acronym { get; set; } = string.Empty;

    [JsonPropertyName("settings")] public Dictionary<string, JsonElement>? Settings { get; set; }
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

    /// <summary>The line that announces readiness and the osu! version.</summary>
    public static string ReadyLine() => JsonSerializer.Serialize(new { ready = true, version = OsuVersion }, JsonOptions);

    /// <summary>
    /// One request line answered with one response line: the whole protocol. Called by the loop
    /// below for the separate helper, and directly by the C# port of the app (docs/csharp-port.md,
    /// phase 3), so both answer with the same code.
    /// </summary>
    public static string Respond(string line)
    {
        try
        {
            var request = JsonSerializer.Deserialize<Request>(line, JsonOptions)
                          ?? throw new InvalidOperationException("empty request");
            object result = request.Type switch
            {
                null => Calculate(request),
                "ranked" => Ranked(request),
                "judgements" => Judgements(request),
                "difficulty" => Difficulty(request),
                _ => throw new ArgumentException($"unknown request type {request.Type}"),
            };
            return JsonSerializer.Serialize(result, JsonOptions);
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new { ok = false, error = ex.Message }, JsonOptions);
        }
    }

    public static int Main()
    {
        // Announce readiness so the caller does not race the first request.
        Console.Out.WriteLine(ReadyLine());
        Console.Out.Flush();

        string? line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            Console.Out.WriteLine(Respond(line));
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

        if (request.Mods != null)
        {
            var classic = scoreInfo.Mods.OfType<ModClassic>();
            scoreInfo.Mods = BuildMods(ruleset, request.Mods).Concat(classic).ToArray();
        }

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

        var legacyTotalScore = scoreInfo.LegacyTotalScore;
        if (request.IgnoreLegacyTotalScore) scoreInfo.LegacyTotalScore = null;
        var performance = ruleset.CreatePerformanceCalculator()?.Calculate(scoreInfo, difficulty);
        scoreInfo.LegacyTotalScore = legacyTotalScore;

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

    /// <summary>
    /// Whether osu! ranks a mod combination: osu!'s own <see cref="Mod.Ranked"/> on each mod,
    /// built the way osu! builds it from a replay.
    /// </summary>
    /// <remarks>
    /// Which mods are ranked differs by ruleset (Mirror only in mania, Hard Rock everywhere
    /// but mania) and by setting (a changed speed unranks Double Time; a changed pitch does
    /// not), and osu! changes the list between releases. Asking osu! keeps all of that in one
    /// place. Needs no beatmap, so it answers for plays whose .osu is not on disk.
    ///
    /// An osu!stable bitmask goes through osu!'s own legacy conversion. The Classic mod the
    /// replay decoder adds to stable plays is deliberately not part of this: osu! ranks stable
    /// plays, while a lazer player choosing Classic is unranked.
    /// </remarks>
    private static object Ranked(Request request)
    {
        var ruleset = RulesetFor(request.Ruleset);

        Mod[] mods = request.LegacyMods is long bits
            ? ruleset.ConvertFromLegacyMods((LegacyMods)bits).ToArray()
            : BuildMods(ruleset, request.Mods ?? Array.Empty<ModRequest>());

        var unranked = mods.Where(m => !m.Ranked).Select(m => m.Acronym).ToArray();

        return new
        {
            ok = true,
            ranked = unranked.Length == 0,
            unranked,
            version = OsuVersion,
        };
    }

    /// <summary>
    /// A beatmap as osu!'s song select describes it for the ruleset and mods: its star rating, length,
    /// BPM, circles and sliders, and the ruleset's own difficulty settings (<c>GetBeatmapAttributesForDisplay</c>: mania's
    /// key count, and AR and OD as a rate mod makes them feel), each before and after the mods.
    /// </summary>
    private static object Difficulty(Request request)
    {
        var ruleset = RulesetFor(request.Ruleset);
        var working = new ProcessorWorkingBeatmap(request.BeatmapPath);
        var mods = BuildMods(ruleset, request.Mods ?? Array.Empty<ModRequest>());
        var attributes = ruleset.CreateDifficultyCalculator(working).Calculate(mods);
        var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo, mods);
        double rate = osu.Game.Utils.ModUtils.CalculateRateWithMods(mods);

        // What osu! records of a beatmap when it imports one (BeatmapUpdater), which mania's key count
        // for a converted beatmap is worked out from.
        var info = working.BeatmapInfo;
        var source = working.Beatmap;
        info.TotalObjectCount = source.HitObjects.Count;
        info.EndTimeObjectCount = source.HitObjects.Count(h => h is osu.Game.Rulesets.Objects.Types.IHasDuration);

        // Circles and sliders as the .osu file has them, which is what osu-web counts: mania's hold
        // notes with the sliders, and the beatmap's own whatever ruleset it is played in.
        var types = source.HitObjects.OfType<osu.Game.Rulesets.Objects.Legacy.IHasLegacyHitObjectType>().Select(h => h.LegacyType).ToList();

        return new
        {
            ok = true,
            stars = attributes.StarRating,
            maxCombo = attributes.MaxCombo,
            // As osu-web's beatmapset page has it: from the start of the song to the end of its last object.
            lengthMs = BeatmapExtensions.CalculatePlayableBounds(playable.HitObjects).end / rate,
            bpm = 60000 / playable.GetMostCommonBeatLength() * rate,
            circles = types.Count(t => t.HasFlag(LegacyHitObjectType.Circle)),
            sliders = types.Count(t => (t & (LegacyHitObjectType.Slider | LegacyHitObjectType.Hold)) != 0),
#if !OSU_SOURCE_LACKS_DISPLAY_ATTRIBUTES
            settings = ruleset.GetBeatmapAttributesForDisplay(info, mods)
                .Select(a => new { acronym = a.Acronym, original = a.OriginalValue, adjusted = a.AdjustedValue, max = a.MaxValue })
                .ToList(),
#else
            // A build from osu! source older than this (SourceHelper.SourceFeatures) shows no settings.
            settings = Array.Empty<object>(),
#endif
            version = OsuVersion,
        };
    }

    /// <summary>
    /// The judgements of a perfect play, counted as osu!stable's results screen counts them, on the
    /// beatmap as osu! converts it for the ruleset and mods: the pp calculator's starting point.
    /// </summary>
    /// <remarks>
    /// osu! and mania judge each object once in stable, a hold note included, so it is the object
    /// count. taiko and catch are counted from osu!'s own judgements, nested objects included: a
    /// taiko note is Great (drumroll ticks and swells are bonus), and catch's fruits, drops and
    /// droplets are Great, LargeTickHit and SmallTickHit, stable's 300s, 100s and 50s. lazer judges a
    /// mania hold note's head and tail apart, so a lazer play's perfect judgements are counted too.
    /// </remarks>
    private static object Judgements(Request request)
    {
        var ruleset = RulesetFor(request.Ruleset);
        var working = new ProcessorWorkingBeatmap(request.BeatmapPath);
        var mods = BuildMods(ruleset, request.Mods ?? Array.Empty<ModRequest>());
        var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo, mods);

        int great = 0, largeTicks = 0, smallTicks = 0, sliderTails = 0, lazerPerfect = 0;
        if (request.Ruleset is 3)
        {
            great = playable.HitObjects.Count;
            lazerPerfect = playable.HitObjects.SelectMany(Flatten).Count(h => h.CreateJudgement().MaxResult == HitResult.Perfect);
        }
        else
        {
            foreach (var hitObject in playable.HitObjects.SelectMany(Flatten))
            {
                switch (hitObject.CreateJudgement().MaxResult)
                {
                    case HitResult.Great: great++; break;
                    case HitResult.LargeTickHit: largeTicks++; break;
                    case HitResult.SmallTickHit: smallTicks++; break;
                    case HitResult.SliderTailHit: sliderTails++; break;
                }
            }
            // osu!stable judges each object once, a slider included: the head is Great only without Classic.
            if (request.Ruleset is 0) great = playable.HitObjects.Count;
        }

        return new
        {
            ok = true,
            // By the replay counter each sits in: mania's perfect judgement is stable's MAX, its geki.
            counts = request.Ruleset switch
            {
                2 => new Dictionary<string, int> { ["c300"] = great, ["c100"] = largeTicks, ["c50"] = smallTicks },
                3 => new Dictionary<string, int> { ["geki"] = great },
                _ => new Dictionary<string, int> { ["c300"] = great },
            },
            // What lazer judges otherwise: in osu!, its sliders' ends and ticks besides each object (repeats
            // included); in mania, each note and each hold note's head and tail.
            lazer = request.Ruleset switch
            {
                0 => new Dictionary<string, int> { ["slider_tail_hit"] = sliderTails, ["large_tick_hit"] = largeTicks },
                3 => new Dictionary<string, int> { ["perfect"] = lazerPerfect },
                _ => null,
            },
            version = OsuVersion,
        };
    }

    private static IEnumerable<osu.Game.Rulesets.Objects.HitObject> Flatten(osu.Game.Rulesets.Objects.HitObject hitObject) =>
        hitObject.NestedHitObjects.SelectMany(Flatten).Prepend(hitObject);

    /// <summary>
    /// osu!'s own mod objects, built the way osu! builds them from a lazer replay. An acronym
    /// this ruleset does not have comes back as osu!'s UnknownMod, which is not ranked.
    /// </summary>
    private static Mod[] BuildMods(Ruleset ruleset, IEnumerable<ModRequest> mods) =>
        mods.Select(m => new APIMod { Acronym = m.Acronym, Settings = SettingValues(m.Settings) }.ToMod(ruleset))
            .ToArray();

    /// <summary>JSON setting values as the plain values osu!'s bindables parse.</summary>
    private static Dictionary<string, object> SettingValues(Dictionary<string, JsonElement>? settings)
    {
        var values = new Dictionary<string, object>();
        if (settings == null) return values;

        foreach (var (name, value) in settings)
        {
            values[name] = value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                // Whole numbers stay integral so an enum setting written as a number parses.
                JsonValueKind.Number => value.TryGetInt64(out long whole) ? whole : value.GetDouble(),
                JsonValueKind.String => value.GetString()!,
                _ => throw new ArgumentException($"setting {name} has an unsupported value"),
            };
        }

        return values;
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
