using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles;

/// <summary>What the pp calculator worked out for one play.</summary>
/// <param name="Counts">The judgements it was priced with: what was typed, or a perfect play's.</param>
/// <param name="Perfect">A perfect play's judgements on this beatmap, ruleset and mods; null when the calculator cannot say.</param>
/// <param name="Ranked">Whether osu! ranks the mods; null when the calculator cannot say.</param>
/// <param name="Classic">Whether it was scored as osu!stable scores it, or without Classic as lazer does.</param>
/// <param name="SliderEnds">osu! without Classic: the beatmap's slider ends, which lazer judges.</param>
/// <param name="SliderTicks">osu! without Classic: its slider ticks and repeats.</param>
/// <param name="StableScoreUsed">Whether osu!stable's score typed in was priced with; null when none was.</param>
internal sealed record CalculatedPlay(
    double Pp,
    double Stars,
    double Combo,
    double MaxCombo,
    double Accuracy,
    string Rank,
    List<PpPart> Breakdown,
    string? Version,
    bool? Ranked,
    Dictionary<string, double> Counts,
    Dictionary<string, double>? Perfect,
    bool Classic,
    double? SliderEnds,
    double? SliderTicks,
    bool? StableScoreUsed);

/// <summary>
/// Options -> pp calculator: a play described by its numbers on any beatmap here, priced by the
/// calculator the app prices with, osu!'s release or the player's own source (roadmap 5.70), and
/// nothing stored.
/// </summary>
/// <remarks>
/// The play is built into an osu!stable replay as a score entered by hand is
/// (<see cref="BuiltReplays.Manual"/>), and osu!'s mods with their settings go beside it, as McOsu's
/// custom speeds do, so it is scored as stable whatever the mods. Without Classic, an osu! or taiko
/// play is built into a lazer replay instead (<see cref="BuiltReplays.ManualLazer"/>), with lazer's
/// statistics, so osu! scores it as lazer does: in osu! that is slider head accuracy, and the
/// slider ends and ticks missed.
/// <para>
/// With Classic, osu! guesses an osu! play's slider breaks from its combo, unless it has the score
/// osu!stable gave it, as a stable score does, from which it works them out
/// (<c>OsuLegacyScoreMissCalculator</c>). That score can be typed in, and a stable score brings its own.
/// </para>
/// </remarks>
internal static partial class PpCalculation
{
    /// <summary>More than any real mod selection, and a bound all the same.</summary>
    private const int MaxMods = 32;

    private const int MaxSettings = 16;

    /// <summary>The largest .osu file taken from the page. Real ones are a few hundred KB.</summary>
    public const int MaxBeatmapBytes = 16 * 1024 * 1024;

    [GeneratedRegex(@"^[A-Z0-9]{1,4}\z")]
    private static partial Regex AcronymShape();

    [GeneratedRegex(@"^[a-z_]{1,40}\z")]
    private static partial Regex SettingShape();

    /// <summary>
    /// The mods that leave a play's pp and stars as they are, by ruleset, which the page shows dimmed
    /// and cannot choose. Measured with osu!'s calculator (<c>PpCalculationTests</c> checks every one
    /// again on each osu! release): what they change is what is seen, heard or allowed, not what osu!
    /// prices. Wind Up, Wind Down and Adaptive Speed are priced at their starting speed, which is the
    /// beatmap's own. Classic changes nothing in catch and mania.
    /// </summary>
    public static readonly IReadOnlyDictionary<int, string[]> NoPp = new Dictionary<int, string[]>
    {
        [0] = ["AC", "AD", "AL", "AS", "BM", "BR", "BU", "DF", "DP", "GR", "MU", "NS", "PF", "RP", "SD", "SG", "SI", "SY", "TR", "WD", "WG", "WU"],
        [1] = ["AC", "AS", "CS", "MU", "NF", "PF", "SD", "SG", "WD", "WU"],
        [2] = ["AC", "CL", "FF", "MF", "MU", "NS", "PF", "RX", "SD", "SY", "WD", "WU"],
        [3] = ["AC", "AS", "CL", "CO", "CS", "FI", "FL", "HD", "HR", "MU", "PF", "SD", "WD", "WU"],
    };

    /// <summary>Mods no play can be calculated with: Autoplay and Cinema have no player, ScoreV2 is a system mod.</summary>
    private static readonly HashSet<string> Refused = ["AT", "CN", "SV2"];

    /// <summary>
    /// The mods as the page sends them, <c>[{ acronym, settings? }]</c>, each once, with settings only
    /// of numbers and switches. Classic is left out: osu! adds its own to every stable play. Null with
    /// <paramref name="error"/> when something is wrong.
    /// </summary>
    public static List<JsonElement>? ParseMods(JsonElement? raw, out string? error)
    {
        error = null;
        var output = new List<JsonElement>();
        if (raw is null or { ValueKind: JsonValueKind.Null }) return output;
        if (raw.Value.ValueKind != JsonValueKind.Array || raw.Value.GetArrayLength() > MaxMods)
        {
            error = "the mods are not a list of mods";
            return null;
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var mod in raw.Value.EnumerateArray())
        {
            if (!Js.IsString(Js.Get(mod, "acronym"), out var acronym) || !AcronymShape().IsMatch(acronym))
            {
                error = "a mod has no acronym";
                return null;
            }
            if (Refused.Contains(acronym))
            {
                error = $"{acronym} cannot be calculated";
                return null;
            }
            if (acronym == "CL" || !seen.Add(acronym)) continue;

            var settings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (Js.Get(mod, "settings") is { ValueKind: not JsonValueKind.Null } given)
            {
                if (given.ValueKind != JsonValueKind.Object)
                {
                    error = $"{acronym}'s settings are not readable";
                    return null;
                }
                foreach (var (key, value) in Js.Entries(given))
                {
                    var usable = value.ValueKind is JsonValueKind.True or JsonValueKind.False
                        || (value.ValueKind == JsonValueKind.Number && double.IsFinite(Js.NumberOf(value)));
                    if (!SettingShape().IsMatch(key) || !usable || settings.Count >= MaxSettings)
                    {
                        error = $"{acronym}'s settings are not readable";
                        return null;
                    }
                    // osu!'s seeds are ints: anything else would fail in the calculator, not here.
                    if (key == "seed" && (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out _)))
                    {
                        error = $"{acronym}'s seed is a whole number";
                        return null;
                    }
                    settings[key] = value;
                }
            }
            output.Add(settings.Count == 0 ? JsonText.From(new { acronym }) : JsonText.From(new { acronym, settings }));
        }
        return output;
    }

    /// <summary>What a request is about, checked: <c>{ md5, mode, mods }</c>, a beatmap here, a ruleset it can be played in, and mods osu! can read.</summary>
    private static (EntryBeatmap Beatmap, string OsuPath, int Mode, List<JsonElement> Mods) Target(EntryDeps deps, JsonElement input)
    {
        if (!deps.CanPrice) throw new InvalidOperationException("the pp calculator is not available");
        var beatmap = Js.IsString(Js.Get(input, "md5"), out var md5) && ScoreEntry.Md5Shape().IsMatch(md5) ? ScoreEntry.Describe(deps, md5) : null;
        if (beatmap is null || deps.Resolver.Resolve(beatmap.Md5).OsuPath is not { } osuPath) throw new InvalidOperationException("choose a beatmap first");

        var asked = Js.ToNumber(Js.Get(input, "mode"));
        if (asked is not (0 or 1 or 2 or 3)) throw new InvalidOperationException("choose a ruleset");
        var mode = (int)asked;
        if (beatmap.Mode != 0 && mode != beatmap.Mode) throw new InvalidOperationException("this beatmap can only be played in its own ruleset");

        if (ParseMods(Js.Get(input, "mods"), out var modsError) is not { } mods) throw new InvalidOperationException(modsError);
        return (beatmap, osuPath, mode, mods);
    }

    /// <summary>
    /// The beatmap as osu!'s song select describes it for the ruleset and mods: <c>{ md5, mode, mods }</c>,
    /// checked as a play is. Null from a calculator that can't say: a helper built from source before it could.
    /// </summary>
    public static async Task<DifficultyInfo?> Describe(EntryDeps deps, JsonElement input)
    {
        var (_, osuPath, mode, mods) = Target(deps, input);
        return deps.Difficulty is { } difficulty ? await difficulty(osuPath, mode, mods) : null;
    }

    /// <summary>The most beatmaps one request asks the star rating of: a page of a list, in a few requests.</summary>
    public const int MaxStars = 25;

    /// <summary>
    /// Star ratings without mods, each in its beatmap's own ruleset, for a list of beatmaps to pick
    /// from: <c>{ md5s }</c>. A beatmap not here, or one the calculator can't describe, is null.
    /// </summary>
    public static async Task<Dictionary<string, double?>> Stars(EntryDeps deps, JsonElement input)
    {
        if (Js.Get(input, "md5s") is not { ValueKind: JsonValueKind.Array } list || list.GetArrayLength() > MaxStars)
        {
            throw new InvalidOperationException($"md5s is a list of at most {MaxStars} beatmaps");
        }
        var stars = new Dictionary<string, double?>(StringComparer.Ordinal);
        foreach (var item in list.EnumerateArray())
        {
            if (!Js.IsString(item, out var md5) || !ScoreEntry.Md5Shape().IsMatch(md5) || stars.ContainsKey(md5)) continue;
            var path = deps.CanPrice && deps.Stars is not null ? deps.Resolver.Resolve(md5).OsuPath : null;
            stars[md5] = path is not null && File.Exists(path) ? await deps.Stars!(path, md5, Clients.Beatmaps.Mode(path)) : null;
        }
        return stars;
    }

    /// <summary>
    /// A play described by its numbers and checked against the beatmap: what the pp calculator prices,
    /// and what Manually enter a score keeps for osu!lazer.
    /// </summary>
    /// <param name="Mods">The mods it is priced with: Classic among them for a lazer play that had it.</param>
    /// <param name="Lazer">Built as a lazer replay, scored as lazer scores it; otherwise as osu!stable's.</param>
    /// <param name="Ends">osu! as lazer scores it: the beatmap's slider ends and ticks.</param>
    internal sealed record Play(
        EntryBeatmap Beatmap, int Mode, List<JsonElement> Mods, bool Classic, bool Lazer,
        Dictionary<string, double> Counts, Dictionary<string, double>? Perfect, Dictionary<string, double>? Ends,
        double TailMiss, double TickMiss, double? Combo, double? StableScore, double? StableTotal)
    {
        public LegacyCounts Legacy => new(Counts["c300"], Counts["c100"], Counts["c50"], Counts["geki"], Counts["katu"], Counts["miss"]);

        public double Judged => ScoreEntry.Judgements[Mode].Sum(key => Counts[key]);

        /// <summary>
        /// The replay: osu!stable's, its mods priced beside it (<see cref="Pricing"/>); or lazer's, with
        /// its statistics and its mods in its own block.
        /// </summary>
        public byte[] Replay(double combo, double playedAt, string player = "") => Lazer
            ? BuiltReplays.ManualLazer(Mode, Beatmap.Md5, Legacy, LazerStatistics(Mode, Counts, Ends, TailMiss, TickMiss),
                MaximumStatistics(Mode, Judged, Ends), Mods, combo, playedAt, player)
            : BuiltReplays.Manual(Mode, Beatmap.Md5, player, Legacy, combo, 0, StableTotal, playedAt);

        public PriceOptions Pricing => new(Mods, IgnoreLegacyTotalScore: StableTotal is null);
    }

    /// <summary>
    /// A play from the page, <c>{ md5, mode, mods, client?, classic?, counts?, combo?, score? }</c>,
    /// checked against the beatmap as a score entered by hand is. With no counts it is a perfect play.
    /// <c>client: "lazer"</c> is an osu!lazer play in any ruleset, with Classic one of its mods in osu!
    /// and taiko. Otherwise an osu! or taiko play without Classic is scored as lazer scores it, and
    /// any other as osu!stable does. <c>score</c> is osu!stable's, for osu! with Classic.
    /// </summary>
    internal static async Task<Play> Read(EntryDeps deps, JsonElement input)
    {
        var (beatmap, osuPath, mode, mods) = Target(deps, input);
        var lazerClient = Js.Get(input, "client") is { ValueKind: JsonValueKind.String } client && client.GetString() == "lazer";
        // Classic is a toggle in osu! and taiko. Catch and mania give the same pp either way.
        var classic = mode is 2 or 3 || Js.Get(input, "classic") is not { ValueKind: JsonValueKind.False };
        var lazer = lazerClient || (!classic && mode is 0 or 1);
        // A lazer replay carries Classic as a mod; a stable one has it by being stable's.
        if (lazerClient && classic && mode is 0 or 1) mods = [.. mods, JsonText.From(new { acronym = "CL" })];

        var perfectPlay = await deps.PerfectJudgements(osuPath, mode, mods);
        var perfect = perfectPlay?.Counts;
        if (lazer && mode == 3)
        {
            // lazer judges a hold note's head and tail apart, so its perfect play has more judgements than stable's.
            perfect = perfectPlay?.Lazer is { } lazerMania && lazerMania.TryGetValue("perfect", out var notes)
                ? new Dictionary<string, double>(StringComparer.Ordinal) { ["geki"] = notes }
                : throw new InvalidOperationException(CountsNeedRebuild);
        }
        Dictionary<string, double>? ends = null;
        if (lazer && mode == 0)
        {
            // The release always counts them: only a helper built from source by an earlier version of
            // this app can't (SourceHelper.ProgramStamp), and a rebuild in Other settings is what fixes it.
            ends = perfectPlay?.Lazer is { } osuEnds && osuEnds.ContainsKey(SliderTails) && osuEnds.ContainsKey(SliderTicks)
                ? osuEnds
                : throw new InvalidOperationException(NeedsRebuild);
        }

        var counts = new Dictionary<string, double>(StringComparer.Ordinal) { ["c300"] = 0, ["c100"] = 0, ["c50"] = 0, ["geki"] = 0, ["katu"] = 0, ["miss"] = 0 };
        var given = Js.Get(input, "counts");
        if (given is null or { ValueKind: JsonValueKind.Null })
        {
            // As for osu! without Classic, only a source build by an earlier version of the app can't count them.
            if (perfect is null) throw new InvalidOperationException(CountsNeedRebuild);
            foreach (var (key, n) in perfect) counts[key] = n;
        }
        else
        {
            foreach (var key in ScoreEntry.Judgements[mode])
            {
                var value = Js.Get(given, key);
                counts[key] = ScoreEntry.Whole(value is null or { ValueKind: JsonValueKind.Null } ? JsonText.From(0) : value, 65535)
                    ?? throw new InvalidOperationException("each judgement is a whole number from 0");
            }
        }
        // lazer's slider ends and ticks that were missed.
        double tailMiss = 0, tickMiss = 0;
        if (ends is not null && given is { ValueKind: JsonValueKind.Object })
        {
            double Missed(string key, double most, string what)
            {
                var value = Js.Get(given.Value, key);
                var n = ScoreEntry.Whole(value is null or { ValueKind: JsonValueKind.Null } ? JsonText.From(0) : value, 65535)
                    ?? throw new InvalidOperationException("each judgement is a whole number from 0");
                return n <= most ? n : throw new InvalidOperationException($"this beatmap has {Js.NumberToString(most)} {what}");
            }
            tailMiss = Missed("tailMiss", ends[SliderTails], "slider ends");
            tickMiss = Missed("tickMiss", ends[SliderTicks], "slider ticks");
        }
        var judged = ScoreEntry.Judgements[mode].Sum(key => counts[key]);
        if (judged == 0) throw new InvalidOperationException("enter the play’s judgements");
        // Every object is judged once. Without osu!'s count, an osu! or mania play on its own beatmap is still checked.
        double? expected = perfect is not null ? perfect.Values.Sum() : mode == beatmap.Mode && mode is 0 or 3 ? beatmap.Objects : null;
        if (expected is { } total && judged != total)
        {
            throw new InvalidOperationException($"the judgements add up to {Js.NumberToString(judged)}, and this beatmap has {Js.NumberToString(total)}");
        }

        var typedCombo = Js.Get(input, "combo");
        var combo = ScoreEntry.Blank(typedCombo) ? null : ScoreEntry.Whole(typedCombo, 65535);
        if (combo is null && !ScoreEntry.Blank(typedCombo)) throw new InvalidOperationException("the combo is a whole number");

        // osu!stable's score, which osu! works out an osu! play's combo breaks from. Only for a play
        // with Classic and stable's own mods: with any other, stable could not have scored it.
        var typedScore = Js.Get(input, "score");
        var stableScore = ScoreEntry.Blank(typedScore) ? null : ScoreEntry.Whole(typedScore, 0x7fffffff);
        if (stableScore is null && !ScoreEntry.Blank(typedScore)) throw new InvalidOperationException("the score is a whole number");
        var stableTotal = !lazer && classic && mode == 0 && stableScore > 0 && Mods.EncodeLegacy(mods) is not null ? stableScore : null;

        return new Play(beatmap, mode, mods, classic, lazer, counts, perfect, ends, tailMiss, tickMiss, combo, stableScore, stableTotal);
    }

    /// <summary>
    /// Price one play, as <see cref="Read"/> takes it. With no combo it is a full one. Nothing is stored.
    /// </summary>
    public static async Task<CalculatedPlay> Calculate(EntryDeps deps, JsonElement input)
    {
        var play = await Read(deps, input);
        async Task<PpResult> Price(double withCombo)
        {
            var file = Path.Combine(Path.GetTempPath(), $"olp-calc-{Guid.NewGuid():N}.osr");
            File.WriteAllBytes(file, play.Replay(withCombo, Js.Now()));
            try
            {
                return await deps.PriceReplay(file, play.Pricing) is { MaxCombo: > 0 } priced
                    ? priced
                    : throw new InvalidOperationException("osu!’s calculator could not price this play");
            }
            finally
            {
                File.Delete(file);
            }
        }

        // The beatmap's maximum combo is osu!'s to say, so a full combo is priced once it has.
        var result = await Price(play.Combo ?? 0);
        // A missed slider end or tick is one less in the combo: a full one is what the rest make.
        var full = Math.Max(0, result.MaxCombo - play.TailMiss - play.TickMiss);
        if (play.Combo is null) result = await Price(full);
        else if (play.Combo > result.MaxCombo)
        {
            throw new InvalidOperationException($"a combo of {Js.NumberToString(play.Combo.Value)} is more than this beatmap's maximum of {Js.NumberToString(result.MaxCombo)}");
        }

        var priced = ScoreEntry.Judgements[play.Mode].ToDictionary(key => key, key => play.Counts[key], StringComparer.Ordinal);
        if (play.Ends is not null)
        {
            priced["tailMiss"] = play.TailMiss;
            priced["tickMiss"] = play.TickMiss;
        }
        return new CalculatedPlay(result.Value, result.Stars, play.Combo ?? full, result.MaxCombo, result.Accuracy, Silvered(result.Rank, play.Mods),
            result.Breakdown, result.Version, await deps.ModsRanked(play.Mode, JsonText.From(play.Mods)), priced, play.Perfect, play.Classic,
            play.Ends?[SliderTails], play.Ends?[SliderTicks], play.StableScore is > 0 ? play.StableTotal is not null : null);
    }

    /// <summary>Why osu! without Classic can't be priced: a calculator that can't count a beatmap's slider ends and ticks.</summary>
    public const string NeedsRebuild =
        "your osu! source calculator was built by an earlier version of this app; rebuild it in Other settings to price osu! without Classic";

    /// <summary>Why a beatmap's judgements aren't filled in: a calculator that can't count a perfect play.</summary>
    public const string CountsNeedRebuild =
        "your osu! source calculator was built by an earlier version of this app; rebuild it in Other settings to fill in the judgements, or enter them";

    private const string SliderTails = "slider_tail_hit";
    private const string SliderTicks = "large_tick_hit";

    /// <summary>
    /// The judgements as lazer's statistics: for osu!, its sliders' ends and ticks too, every one hit
    /// but those missed. Catch's fruits, drops and droplets are Great, LargeTickHit and SmallTickHit;
    /// mania's MAX, 300, 200, 100 and 50 are Perfect, Great, Good, Ok and Meh. Zero counts are left
    /// out, as lazer leaves them out.
    /// </summary>
    internal static Dictionary<string, double> LazerStatistics(int mode, Dictionary<string, double> counts, Dictionary<string, double>? ends,
        double tailMiss, double tickMiss)
    {
        var statistics = mode switch
        {
            2 => new Dictionary<string, double>(StringComparer.Ordinal)
            {
                ["great"] = counts["c300"],
                ["large_tick_hit"] = counts["c100"],
                ["small_tick_hit"] = counts["c50"],
                ["small_tick_miss"] = counts["katu"],
                ["miss"] = counts["miss"],
            },
            3 => new Dictionary<string, double>(StringComparer.Ordinal)
            {
                ["perfect"] = counts["geki"],
                ["great"] = counts["c300"],
                ["good"] = counts["katu"],
                ["ok"] = counts["c100"],
                ["meh"] = counts["c50"],
                ["miss"] = counts["miss"],
            },
            _ => new Dictionary<string, double>(StringComparer.Ordinal)
            {
                ["great"] = counts["c300"],
                ["ok"] = counts["c100"],
                ["meh"] = mode == 0 ? counts["c50"] : 0,
                ["miss"] = counts["miss"],
            },
        };
        if (ends is not null)
        {
            statistics[SliderTails] = ends[SliderTails] - tailMiss;
            statistics[SliderTicks] = ends[SliderTicks] - tickMiss;
            statistics["large_tick_miss"] = tickMiss;
        }
        return statistics.Where(s => s.Value > 0).ToDictionary(s => s.Key, s => s.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// A perfect play's statistics, as lazer writes them: in osu! and taiko a Great for every object,
    /// and every slider end and tick. Catch's and mania's are left to osu!'s decoder, which works them
    /// out from the play's own (LegacyScoreDecoder.PopulateMaximumStatistics) as it does for any replay
    /// that has none.
    /// </summary>
    internal static Dictionary<string, double> MaximumStatistics(int mode, double objects, Dictionary<string, double>? ends)
    {
        if (mode is 2 or 3) return [];
        var maximum = new Dictionary<string, double>(StringComparer.Ordinal) { ["great"] = objects };
        if (ends is not null)
        {
            maximum[SliderTails] = ends[SliderTails];
            maximum[SliderTicks] = ends[SliderTicks];
        }
        return maximum.Where(s => s.Value > 0).ToDictionary(s => s.Key, s => s.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// The grade with the mods' own say in it. osu! grades the replay as decoded, before these mods
    /// replace its own, so Hidden, Flashlight and Fade In turn S and SS silver here, as their
    /// <c>AdjustRank</c> does in osu!.
    /// </summary>
    private static string Silvered(string rank, List<JsonElement> mods) =>
        rank is "X" or "S" && mods.Any(m => Js.IsString(Js.Get(m, "acronym"), out var a) && a is "HD" or "FL" or "FI") ? rank + "H" : rank;

    /// <summary>
    /// A .osu file from the page: kept in <c>data/beatmaps/</c> and indexed, as a beatmap downloaded
    /// for a score link is, so it can be priced and found again.
    /// </summary>
    public static EntryBeatmap Upload(EntryDeps deps, byte[] bytes)
    {
        var text = new UTF8Encoding(false).GetString(bytes).TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (!text.StartsWith("osu file format v", StringComparison.Ordinal)) throw new InvalidOperationException("that file is not an osu! beatmap (.osu)");
        var objects = (Clients.Beatmaps.OsuSection(text, "[HitObjects]") ?? "").Split('\n').Count(line => Js.Trim(line) != "");
        if (objects == 0) throw new InvalidOperationException("that beatmap has no objects");
        var stored = StoredBeatmaps.Store(deps.Db, deps.DataDir, bytes);
        return ScoreEntry.Describe(deps, stored.Md5) ?? throw new InvalidOperationException("that file is not an osu! beatmap (.osu)");
    }
}
