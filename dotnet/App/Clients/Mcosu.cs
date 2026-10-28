using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Clients;

/// <summary>A beatmap's own CS, AR, OD and HP, before any mod.</summary>
internal sealed record BaseDifficulty(double Cs, double Ar, double Od, double Hp);

/// <summary>
/// What <see cref="Mcosu.Mods"/> makes of a play: its mods as osu! would list them (what is stored),
/// what osu!'s calculator is given (null when osu!'s mods cannot say what was played), and whether
/// the total McOsu recorded is on the footing osu! assumes.
/// </summary>
internal sealed record McosuMods(List<JsonElement> Mods, List<JsonElement>? Priced, bool IgnoreLegacyTotalScore);

/// <summary>
/// One entry in McOsu's <c>scores.db</c>, as <c>OsuDatabase::loadScores</c> reads it. <c>ImportedLegacy</c>
/// is a copy McOsu took of an osu!stable score, never tracked as McOsu's; <c>PlayedAt</c> is to the second.
/// </summary>
internal sealed record McosuScore(
    string BeatmapMD5,
    bool ImportedLegacy,
    double PlayedAt,
    string PlayerName,
    int Count300,
    int Count100,
    int Count50,
    int CountGeki,
    int CountKatu,
    int CountMiss,
    double TotalScore,
    int MaxCombo,
    int LegacyMods,
    int MaxPossibleCombo,
    McosuFacts Facts);

/// <summary>A <c>scores.db</c> from a McOsu newer than this reader, which its format may have changed in.</summary>
internal sealed class McosuVersionException(int version)
    : Exception($"McOsu's scores.db is version {version}, newer than this app can read ({Mcosu.ScoresVersion})")
{
    public int Version { get; } = version;
}

/// <summary>A <c>scores.db</c> cut short: a write still in progress, read again once it settles.</summary>
internal sealed class McosuShortReadException(string message) : Exception(message);

/// <summary>McOsu: src/clients/mcosu.ts. Its plays are built osu!stable replays, scored as stable.</summary>
internal static partial class Mcosu
{
    /// <summary>The newest <c>scores.db</c> format this reader knows (<c>osu_scores_custom_version</c>).</summary>
    public const int ScoresVersion = 20210110;

    /// <summary>Written as the built replay's version: a current osu!stable one, so the decoder treats it as such.</summary>
    public const int BuiltReplayVersion = 20260711;

    /// <summary>The bit McOsu (from 20210104) sets in the per-score "gamemode" byte for an imported stable score.</summary>
    private const int ImportedLegacyFlag = 0xa9;

    private sealed class Reader(byte[] b)
    {
        private int o;

        private ReadOnlySpan<byte> Take(int n)
        {
            if (o < 0 || o + n > b.Length) throw new McosuShortReadException("scores.db ends early");
            var span = b.AsSpan(o, n);
            o += n;
            return span;
        }

        public int Byte() => Take(1)[0];
        public int Short() => System.Buffers.Binary.BinaryPrimitives.ReadInt16LittleEndian(Take(2));
        public int Int() => System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(Take(4));
        public ulong Long() => System.Buffers.Binary.BinaryPrimitives.ReadUInt64LittleEndian(Take(8));
        public double Float() => System.Buffers.Binary.BinaryPrimitives.ReadSingleLittleEndian(Take(4));

        /// <summary>osu!'s strings: 0x0b, a ULEB128 length, then UTF-8. Anything else is empty.</summary>
        public string String()
        {
            if (Byte() != 0x0b) return "";
            int len = 0, shift = 0, octet;
            do
            {
                octet = Byte();
                len |= (octet & 0x7f) << shift;
                shift += 7;
            } while ((octet & 0x80) != 0);
            if (o + len > b.Length) throw new McosuShortReadException("string runs past the end of scores.db");
            // A length past 2^31 reads as nothing and steps back, as the TypeScript's arithmetic does.
            var s = len > 0 ? System.Text.Encoding.UTF8.GetString(b, o, len) : "";
            o += len;
            return s;
        }
    }

    /// <summary>
    /// Read McOsu's <c>scores.db</c>. A file cut short throws <see cref="McosuShortReadException"/>:
    /// McOsu rewrites it after every play, so a short read is a write in progress. A newer version
    /// throws <see cref="McosuVersionException"/>, as McOsu itself refuses one.
    /// </summary>
    public static List<McosuScore> ParseScores(byte[] buf)
    {
        var r = new Reader(buf);
        var dbVersion = r.Int();
        if (dbVersion > ScoresVersion) throw new McosuVersionException(dbVersion);
        var numBeatmaps = r.Int();

        var output = new List<McosuScore>();
        for (var m = 0; m < numBeatmaps; m++)
        {
            var md5 = r.String();
            var numScores = r.Int();
            // McOsu's own rules: a short hash is one bad entry, a long one a corrupt file.
            if (md5.Length > 32) throw new McosuShortReadException("corrupt beatmap hash in scores.db");
            var validMd5 = md5.Length == 32;

            for (var s = 0; s < numScores; s++)
            {
                var gamemode = r.Byte();
                var scoreVersion = r.Int();
                var importedLegacy = false;
                if (dbVersion == 20210103 && scoreVersion > 20190103) importedLegacy = r.Byte() != 0;
                else if (dbVersion > 20210103 && scoreVersion > 20190103) importedLegacy = (gamemode & ImportedLegacyFlag) != 0;
                var unixSeconds = r.Long();
                var playerName = r.String();
                var count300 = r.Short();
                var count100 = r.Short();
                var count50 = r.Short();
                var countGeki = r.Short();
                var countKatu = r.Short();
                var countMiss = r.Short();
                double totalScore = r.Long();
                var maxCombo = r.Short();
                var legacyMods = r.Int();
                r.Short(); // slider breaks
                for (var i = 0; i < 7; i++) r.Float(); // McOsu's own pp, unstable rate, hit errors, stars
                var speed = r.Float();
                var cs = r.Float();
                var ar = r.Float();
                var od = r.Float();
                var hp = r.Float();
                var maxPossibleCombo = -1;
                if (scoreVersion > 20180722)
                {
                    maxPossibleCombo = r.Int();
                    r.Int(); // hit objects
                    r.Int(); // circles
                }
                var experimental = r.String();

                // McOsu's own gamemode filter: osu!standard only, with the byte reused as a flag later.
                var standard = gamemode == 0 || (dbVersion > 20210103 && scoreVersion > 20190103);
                if (!validMd5 || !standard) continue;

                output.Add(new McosuScore(md5, importedLegacy, (double)unixSeconds * 1000, playerName,
                    count300, count100, count50, countGeki, countKatu, countMiss, totalScore, maxCombo, legacyMods, maxPossibleCombo,
                    new McosuFacts(speed, cs, ar, od, hp, (legacyMods & NightmareBit) != 0,
                        [.. experimental.Split(';').Where(name => name != "")])));
            }
        }
        return output;
    }

    /// <summary>Where a McOsu play's built replay is kept, named by its beatmap and when it was played.</summary>
    public static string BuiltReplayPath(string dir, string beatmapMD5, double playedAt) =>
        NodePath.Join(dir, $"{beatmapMD5}-{Js.NumberToString(Math.Floor(playedAt / 1000))}.osr");

    /// <summary>
    /// The osu!stable replay for a McOsu play, with no cursor data and this app's block after it. No
    /// replay hash, so the play is known by its beatmap and time; Cinema's bit cleared, since it is
    /// Nightmare here and osu! would read the play as Cinema.
    /// </summary>
    public static byte[] BuildReplay(McosuScore score) => Replays.ReplayWriter.Encode(
        new Replays.ReplayHeader(
            0, BuiltReplayVersion, score.BeatmapMD5, score.PlayerName, null,
            new Replays.LegacyCounts(score.Count300, score.Count100, score.Count50, score.CountGeki, score.CountKatu, score.CountMiss),
            score.TotalScore, score.MaxCombo,
            score.MaxPossibleCombo > 0 && score.MaxCombo >= score.MaxPossibleCombo,
            score.LegacyMods & ~NightmareBit,
            // McOsu keeps the second a play ended, so that is what the replay says.
            Math.Floor(score.PlayedAt / 1000) * 1000,
            0),
        [Replays.AppBlocks.Write(Replays.AppBlocks.McosuBlock, score.Facts)]);

    public const int NightmareBit = 1 << 22;

    /// <summary>The acronym everything McOsu has and osu! does not is filed under.</summary>
    public const string McosuMod = "MC";

    private const int DT = 1 << 6, HT = 1 << 8, NC = 1 << 9, HR = 1 << 4, EZ = 1 << 1;

    /// <summary>The rates osu!'s rate mods accept, and their defaults.</summary>
    private const double FasterMin = 1.01, FasterMax = 2, FasterDefault = 1.5;
    private const double SlowerMin = 0.5, SlowerMax = 0.99, SlowerDefault = 0.75;

    /// <summary>Difficulty Adjust's limits with <c>extended_limits</c> on.</summary>
    private const double DaMax = 11, DaMinAr = -10;

    /// <summary>Experimental mods that move a value while the map plays, so the stored one is no override.</summary>
    private static readonly string[] MovesCs = ["osu_mod_minimize"];
    private static readonly string[] MovesAr = ["osu_mod_artimewarp", "osu_mod_arwobble"];

    /// <summary>McOsu stores floats; two decimals is finer than any slider it offers.</summary>
    private static double Round2(double n) => Js.Round(n * 100) / 100;

    [GeneratedRegex(@"(?<=\A|[\n\r\u2028\u2029])[ \t]*(CircleSize|ApproachRate|OverallDifficulty|HPDrainRate)[ \t]*:[ \t]*([-0-9.]+)")]
    private static partial Regex DifficultyValue();

    /// <summary>
    /// The <c>[Difficulty]</c> of a <c>.osu</c>, or null when it cannot be read. A map with no
    /// <c>ApproachRate</c> uses its OD for it, as every osu! client does.
    /// </summary>
    public static BaseDifficulty? ReadBaseDifficulty(string osuPath)
    {
        string text;
        try
        {
            text = Js.ReadFileUtf8(osuPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        if (Beatmaps.OsuSection(text, "[Difficulty]") is not { } section) return null;
        double? Value(string key)
        {
            // The first line naming the key, as the regex without `g` finds it.
            var m = DifficultyValue().Matches(section).FirstOrDefault(m => m.Groups[1].Value == key);
            var n = m is null ? double.NaN : Js.StringToNumber(m.Groups[2].Value);
            return double.IsFinite(n) ? n : null;
        }
        var cs = Value("CircleSize");
        var od = Value("OverallDifficulty");
        var hp = Value("HPDrainRate");
        if (cs is null || od is null || hp is null) return null;
        return new BaseDifficulty(cs.Value, Value("ApproachRate") ?? od.Value, od.Value, hp.Value);
    }

    /// <summary>
    /// A McOsu play's mods, as osu! would write them if it could have set the play: speed as
    /// Double Time or Half Time with its rate, overrides as Difficulty Adjust after Easy or Hard
    /// Rock, and Nightmare and McOsu's experimental mods as one mod, MC. The reasons are in
    /// src/clients/mcosu.ts.
    /// </summary>
    public static McosuMods Mods(int legacyMods, McosuFacts facts, BaseDifficulty? @base)
    {
        var priceable = true;

        var speed = Round2(facts.Speed);
        var rateBit = 0;
        double? rate = null;
        if (speed > 1)
        {
            rateBit = (legacyMods & NC) != 0 ? NC | DT : DT;
            if (speed < FasterMin || speed > FasterMax) priceable = false;
            if (speed != FasterDefault) rate = speed;
        }
        else if (speed < 1)
        {
            rateBit = HT;
            if (speed < SlowerMin || speed > SlowerMax) priceable = false;
            if (speed != SlowerDefault) rate = speed;
        }
        var bits = (legacyMods & ~(DT | NC | HT | NightmareBit)) | rateBit;
        // McOsu is osu!standard only.
        var mods = Calc.Mods.DecodeLegacy(bits, 0)
            .Select(m => rate is { } r && Calc.Mods.Acronym(m) is "DT" or "NC" or "HT"
                ? Calc.Mods.With(Calc.Mods.Acronym(m)!, new Dictionary<string, object> { ["speed_change"] = r })
                : m)
            .ToList();

        if (@base is not null)
        {
            var hr = (legacyMods & HR) != 0;
            var ez = (legacyMods & EZ) != 0;
            // McOsu's getDifficultyMultiplier and getCSDifficultyMultiplier: Easy wins over Hard Rock.
            var mult = ez ? 0.5 : hr ? 1.4 : 1;
            var csMult = ez ? 0.5 : hr ? 1.3 : 1;
            (string Key, double Stored, double Expected, bool Moving, double Min)[] stats =
            [
                ("circle_size", facts.Cs, Math.Min(@base.Cs * csMult, 10), MovesCs.Any(facts.Experimental.Contains), 0),
                ("approach_rate", facts.Ar, Math.Min(@base.Ar * mult, 10), MovesAr.Any(facts.Experimental.Contains), DaMinAr),
                ("overall_difficulty", facts.Od, Math.Min(@base.Od * mult, 10), false, 0),
                ("drain_rate", facts.Hp, Math.Min(@base.Hp * mult, 10), false, 0),
            ];
            var settings = new Dictionary<string, object>();
            foreach (var (key, stored, expected, moving, min) in stats)
            {
                if (!double.IsFinite(stored) || moving) continue;
                // McOsu stores float32: compare at that precision, or every 3.3 would be an override.
                if (Math.Abs(stored - (double)(float)expected) < 0.001) continue;
                var value = Round2(stored);
                settings[key] = value;
                if (value > DaMax || value < min) priceable = false;
            }
            if (settings.Count > 0)
            {
                if (settings.Values.Any(v => v is double d && (d > 10 || d < 0))) settings["extended_limits"] = true;
                mods.Add(Calc.Mods.With("DA", settings));
            }
        }

        List<JsonElement>? priced = priceable ? [.. mods] : null;

        List<string> own = [.. facts.Nightmare ? ["nightmare"] : Array.Empty<string>(), .. facts.Experimental];
        if (own.Count > 0)
        {
            var settings = new Dictionary<string, object>();
            foreach (var name in own) settings[name] = true;
            mods.Add(Calc.Mods.With(McosuMod, settings));
        }

        return new McosuMods(mods, priced, priced is not null && !LegacyTotalComparable(legacyMods, priced));
    }

    /// <summary>
    /// Whether osu! can read McOsu's recorded total as the stable total it assumes: McOsu's
    /// multipliers for its bits against stable's for the mods being priced.
    /// </summary>
    public static bool LegacyTotalComparable(int legacyMods, IReadOnlyList<JsonElement> priced)
    {
        bool Has(int bit) => (legacyMods & bit) != 0;
        var v2 = Has(1 << 29);
        double mcosu = 1;
        if (Has(EZ) || (Has(1 << 0) && !v2)) mcosu *= 0.5;
        if (Has(HT)) mcosu *= 0.3;
        if (Has(HR)) mcosu *= v2 ? 1.1 : 1.06;
        if (Has(DT) || Has(NC)) mcosu *= v2 ? 1.2 : 1.12;
        if (Has(1 << 3)) mcosu *= 1.06;
        if (Has(1 << 12)) mcosu *= 0.9;

        var acronyms = priced.Select(Calc.Mods.Acronym).ToHashSet();
        double osu = 1;
        if (acronyms.Contains("NF") && !v2) osu *= 0.5;
        if (acronyms.Contains("EZ")) osu *= 0.5;
        if (acronyms.Contains("HT") || acronyms.Contains("DC")) osu *= 0.3;
        if (acronyms.Contains("HD")) osu *= 1.06;
        if (acronyms.Contains("HR")) osu *= v2 ? 1.1 : 1.06;
        if (acronyms.Contains("DT") || acronyms.Contains("NC")) osu *= v2 ? 1.2 : 1.12;
        if (acronyms.Contains("FL")) osu *= 1.12;
        if (acronyms.Contains("SO")) osu *= 0.9;

        return Math.Abs(mcosu - osu) < 1e-9;
    }
}
