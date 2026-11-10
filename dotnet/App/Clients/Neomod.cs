using System.Text.Json;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// The mods record neomod writes after a replay's online id (<c>Replay::Mods::pack_and_write</c>):
/// its 64 mod flags, the exact speed, the note lock type, and the CS/AR/OD/HP overrides, -1 when
/// unset, with AR and CS below zero in their own fields.
/// </summary>
internal sealed record NeomodFacts(
    ulong Flags,
    double Speed,
    int NoteLock,
    double ArOverride,
    double ArNegative,
    double CsOverride,
    double CsNegative,
    double HpOverride,
    double OdOverride);

/// <summary>What <see cref="Neomod.Mods"/> makes of a play: as McOsu's, <see cref="McosuMods"/>.</summary>
internal sealed record NeomodMods(List<JsonElement> Mods, List<JsonElement>? Priced, bool IgnoreLegacyTotalScore);

/// <summary>
/// neomod, an open-source fork of McOsu (roadmap 5.85). A portable folder: its replays, scores and
/// config beside <c>neomod.exe</c>. Its replays are osu!stable's layout under version 40000000, with
/// its own mods record after the online id; its plays are scored as stable.
/// </summary>
internal static class Neomod
{
    /// <summary>The replay version neomod writes: "30m+ is lazer-specific, 40m+ is neomod-specific".</summary>
    public const int MinReplayVersion = 40000000;

    /// <summary>The acronym everything neomod has and osu! does not is filed under, as McOsu's MC.</summary>
    public const string OwnMod = "NEO";

    private static bool Exists(string p) => File.Exists(p) || Directory.Exists(p);

    /* ------------------------------------------------------------- finding it */

    private static readonly string[] Executables = ["neomod.exe", "neomod"];

    public static bool IsNeomodRoot(string root) => Executables.Any(exe => File.Exists(NodePath.Join(root, exe)));

    /// <summary>
    /// A neomod install: its replays folder, and the beatmaps it plays, osu!stable's Songs (its
    /// <c>osu_folder</c> and <c>songs_folder</c>) and the sets it downloaded itself.
    /// </summary>
    public static OsuInstall? Install(string root)
    {
        if (!IsNeomodRoot(root)) return null;
        var roots = new List<string>();
        if (Songs(root) is { } songs) roots.Add(songs);
        var maps = NodePath.Join(root, "maps");
        if (Directory.Exists(maps)) roots.Add(maps);
        return new OsuInstall("neomod", root, NodePath.Join(root, "replays"), roots, null);
    }

    private static readonly System.Text.RegularExpressions.Regex SongsFolderLine = new(@"^[ \t]*songs_folder[ \t]+(.+?)[ \t]*\z");

    /// <summary>
    /// The Songs folder neomod plays from (<c>Database::getOsuSongsFolder</c>): its <c>songs_folder</c>,
    /// copied from stable's <c>BeatmapDirectory</c> on its first run, where absolute, and otherwise
    /// under its <c>osu_folder</c>.
    /// </summary>
    public static string? Songs(string root)
    {
        string cfg;
        try
        {
            cfg = Js.ReadFileUtf8(NodePath.Join(root, "cfg", "osu.cfg"));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        var songs = NodePath.FirstMatch(cfg, SongsFolderLine) is { } raw ? raw.Trim('"') : "";
        if (songs.Length == 0) songs = "Songs";
        if (!NodePath.IsAbsolute(songs))
        {
            if (Detect.CfgOsuFolder(root) is not { } osuFolder) return null;
            songs = NodePath.Join(osuFolder, songs);
        }
        songs = songs.TrimEnd('/', '\\');
        return Exists(songs) ? songs : null;
    }

    /// <summary>neomod is a folder unzipped anywhere: where people usually unzip one, each one existence test.</summary>
    public static List<string> Candidates(DetectEnvironment e, IReadOnlyList<string>? drives = null)
    {
        var output = new List<string>();
        if (e["LOCALAPPDATA"] is { Length: > 0 } local)
        {
            output.Add(NodePath.Join(local, "neomod"));
            output.Add(NodePath.Join(local, "Programs", "neomod"));
        }
        foreach (var parent in new[] { "", "Desktop", "Downloads", "Documents", "Games" })
        {
            var under = parent.Length == 0 ? e.Home : NodePath.Join(e.Home, parent);
            output.Add(NodePath.Join(under, "neomod"));
            // Windows' "Extract all" makes a folder named after the zip, with the release's own folder inside.
            output.Add(NodePath.Join(under, "neomod-win64", "neomod"));
        }
        if (e.Platform == "win32")
        {
            foreach (var drive in drives ?? ["C:\\", "D:\\", "E:\\"])
            {
                foreach (var parent in new[] { "", "Games", "Game", "games", "Program Files", "Programs" }) output.Add(NodePath.Join(drive, parent, "neomod"));
            }
        }
        return output;
    }

    /* ------------------------------------------------------------ its replays */

    private const int ARWobbleBit = 25, WobbleBits = 23, StrictBits = 21;

    private static bool Has(ulong flags, int bit) => (flags & (1UL << bit)) != 0;

    /// <summary>
    /// neomod's mods record, as <c>Replay::Mods::unpack</c> reads it. The experimental mods'
    /// settings after it are not read. Null when it is cut short.
    /// </summary>
    public static NeomodFacts? ReadFacts(byte[] rest)
    {
        if (rest.Length < 8 + 4 * 8) return null;
        var flags = BitConverter.ToUInt64(rest, 0);
        double F(int at) => BitConverter.ToSingle(rest, at);
        var speed = F(8);
        // neomod's own rule: a speed it could not play is 1.
        if (!(speed >= 0.05 && speed <= 50)) speed = 1;
        return new NeomodFacts(flags, speed, BitConverter.ToInt32(rest, 12), F(16), F(20), F(24), F(28), F(32), F(36));
    }

    /* --------------------------------------------------------------- its mods */

    /// <summary>neomod's flags for osu!'s own mods, in the order osu! lists them.</summary>
    private static readonly (int Bit, string Acronym)[] Before =
    [
        (0, "NF"), (1, "EZ"), (11, "TD"), (4, "HD"), (5, "HR"),
    ];

    private static readonly (int Bit, string Acronym)[] After =
    [
        (3, "RX"), (6, "FL"), (63, "AT"), (12, "SO"), (2, "AP"), (15, "TP"), (13, "SV2"),
    ];

    /// <summary>Its experimental mods that are osu!lazer's under another name.</summary>
    private static readonly (int Bit, string Acronym)[] Lazer =
    [
        (26, "AL"), (43, "SG"), (49, "TC"), (41, "ST"), (50, "FR"), (42, "AD"),
    ];

    /// <summary>Everything else neomod has, under NEO, by the names its page gives them.</summary>
    public static readonly (int Bit, string Key)[] OwnMods =
    [
        (9, "nightmare"), (14, "fposu"), (36, "fposu_strafing"), (18, "timewarp"), (19, "ar_timewarp"),
        (20, "minimize"), (21, "strict_clicks"), (22, "precise_sliders"), (23, "wobble"), (24, "wobble2"),
        (25, "ar_wobble"), (27, "shirone"), (28, "mafham"), (29, "half_timing_window"),
        // Bit 30, late 300s under Half Timing Window, is on by default and means nothing alone.
        (31, "ming3012"), (32, "no_100s"), (33, "no_50s"),
        (37, "fading_cursor"), (38, "first_person"), (39, "reverse_sliders"), (40, "millhioref"),
        (44, "no_keylock"), (45, "no_pausing"), (48, "dks"), (62, "no_hp"),
    ];

    /// <summary>AR or OD held where they were as the speed changes, which osu!'s mods cannot say.</summary>
    private const int ArLockBit = 16, OdLockBit = 17;

    private const int SuddenDeathBit = 7, PerfectBit = 8, NoPitchBit = 10, FlipUpDownBit = 34, FlipLeftRightBit = 35;

    /// <summary>The rates osu!'s rate mods accept, and their defaults; Difficulty Adjust's extended limits.</summary>
    private const double FasterMin = 1.01, FasterMax = 2, FasterDefault = 1.5;
    private const double SlowerMin = 0.5, SlowerMax = 0.99, SlowerDefault = 0.75;
    private const double DaMax = 11, DaMinAr = -10;

    /// <summary>neomod stores floats; two decimals is as fine as its sliders go.</summary>
    private static double Round2(double n) => Js.Round(n * 100) / 100;

    /// <summary>Its note lock settings other than stable's (2, the default), under NEO.</summary>
    private static readonly Dictionary<int, string> NoteLocks = new() { [0] = "no_note_lock", [1] = "neomod_note_lock", [3] = "lazer_note_lock" };

    /// <summary>AR to approach time and back (<c>GameRules::arToMilliseconds</c>): 1800, 1200 and 450 ms at AR 0, 5 and 10.</summary>
    private static double ApproachMs(double ar) => ar > 5 ? 1200 - 150 * (ar - 5) : 1200 + 120 * (5 - ar);

    private static double ArOf(double ms) => ms < 1200 ? 5 + (1200 - ms) / 150 : 5 - (ms - 1200) / 120;

    /// <summary>
    /// The AR or OD osu!'s DA takes before the speed change for one neomod held at the speed
    /// (<c>GameRules::arWithSpeed</c>, <c>odWithSpeed</c>): its approach time or 300 window, longer by the speed.
    /// </summary>
    public static double UnlockedAr(double ar, double speed) => ArOf(ApproachMs(ar) * speed);

    public static double UnlockedOd(double od, double speed) => (80 - (80 - 6 * od) * speed) / 6;

    /// <summary>
    /// A neomod play's mods as osu! would write them: speed as DT, NC, HT or DC at its rate, the
    /// overrides as Difficulty Adjust after EZ and HR, the experimental mods lazer has under their
    /// names, and the rest as one NEO, never shown to osu!'s calculator.
    /// </summary>
    public static NeomodMods Mods(NeomodFacts facts)
    {
        var f = facts.Flags;
        var priceable = true;
        var mods = new List<JsonElement>();
        void Add(string acronym) => mods.Add(Calc.Mods.Of(acronym));

        foreach (var (bit, acronym) in Before) if (Has(f, bit)) Add(acronym);
        if (Has(f, PerfectBit)) Add("PF");
        else if (Has(f, SuddenDeathBit)) Add("SD");

        var speed = Round2(facts.Speed);
        var noPitch = Has(f, NoPitchBit);
        if (speed > 1)
        {
            if (speed < FasterMin || speed > FasterMax) priceable = false;
            var acronym = noPitch ? "NC" : "DT";
            mods.Add(speed == FasterDefault ? Calc.Mods.Of(acronym) : Calc.Mods.With(acronym, new Dictionary<string, object> { ["speed_change"] = speed }));
        }
        else if (speed < 1)
        {
            if (speed < SlowerMin || speed > SlowerMax) priceable = false;
            var acronym = noPitch ? "DC" : "HT";
            mods.Add(speed == SlowerDefault ? Calc.Mods.Of(acronym) : Calc.Mods.With(acronym, new Dictionary<string, object> { ["speed_change"] = speed }));
        }

        foreach (var (bit, acronym) in After) if (Has(f, bit)) Add(acronym);

        // neomod's Flip Up/Down is lazer's vertical reflection, and Flip Left/Right its horizontal one.
        var upDown = Has(f, FlipUpDownBit);
        var leftRight = Has(f, FlipLeftRightBit);
        if (upDown && leftRight) mods.Add(Calc.Mods.With("MR", new Dictionary<string, object> { ["reflection"] = 2 }));
        else if (upDown) mods.Add(Calc.Mods.With("MR", new Dictionary<string, object> { ["reflection"] = 1 }));
        else if (leftRight) Add("MR");

        foreach (var (bit, acronym) in Lazer) if (Has(f, bit)) Add(acronym);

        // The overrides replace what EZ and HR made of the map's values, so DA comes after both.
        var settings = new Dictionary<string, object>();
        void Override(string key, double value, double min)
        {
            var v = Round2(value);
            settings[key] = v;
            if (v > DaMax || v < min) priceable = false;
        }
        // AR or OD locked to the speed is what DA's would be before it. Locking the map's own
        // value would need the map, so only an override's is priced.
        var own = new Dictionary<string, object>();
        var arLock = speed != 1 && Has(f, ArLockBit);
        var odLock = speed != 1 && Has(f, OdLockBit);
        double? ar = facts.ArOverride >= 0 ? facts.ArOverride : facts.ArNegative < 0 ? facts.ArNegative : null;
        double? od = facts.OdOverride >= 0 ? facts.OdOverride : null;
        if (facts.CsOverride >= 0) Override("circle_size", facts.CsOverride, 0);
        else if (facts.CsNegative < 0) Override("circle_size", facts.CsNegative, 0);
        if (ar is { } a) Override("approach_rate", arLock ? UnlockedAr(a, speed) : a, DaMinAr);
        if (od is { } o) Override("overall_difficulty", odLock ? UnlockedOd(o, speed) : o, 0);
        if (facts.HpOverride >= 0) Override("drain_rate", facts.HpOverride, 0);
        if (arLock && ar is null) own["ar_lock"] = true;
        if (odLock && od is null) own["od_lock"] = true;
        if (own.Count > 0) priceable = false;
        if (settings.Count > 0)
        {
            if (settings.Values.Any(v => v is double d && (d > 10 || d < 0))) settings["extended_limits"] = true;
            mods.Add(Calc.Mods.With("DA", settings));
        }

        List<JsonElement>? priced = null;
        foreach (var (bit, key) in OwnMods) if (Has(f, bit)) own[key] = true;
        if (NoteLocks.TryGetValue(facts.NoteLock, out var noteLock)) own[noteLock] = true;
        if (priceable) priced = [.. mods];
        if (own.Count > 0) mods.Add(Calc.Mods.With(OwnMod, own));

        return new NeomodMods(mods, priced, priced is not null && !LegacyTotalComparable(facts, priced));
    }

    /// <summary>
    /// Whether osu! can read neomod's recorded total as the stable total it assumes: every priced mod
    /// one stable has, and neomod's multiplier for them stable's (<c>getScoreV1ScoreMultiplier</c>).
    /// </summary>
    public static bool LegacyTotalComparable(NeomodFacts facts, IReadOnlyList<JsonElement> priced)
    {
        if (Calc.Mods.EncodeLegacy(priced) is null) return false;
        var f = facts.Flags;
        var v2 = Has(f, 13);
        double neomod = 1;
        if (facts.Speed > 1) neomod *= 0.24 * facts.Speed + 0.76;
        else if (facts.Speed < 1) neomod *= 0.008 * Math.Exp(4.81588 * facts.Speed);
        if (Has(f, 1) || (Has(f, 0) && !v2)) neomod *= 0.5;
        if (Has(f, 5)) neomod *= v2 ? (double)1.1f : 1.06;
        if (Has(f, 6)) neomod *= 1.12;
        if (Has(f, 4)) neomod *= 1.06;
        if (Has(f, 12)) neomod *= 0.90;
        return Math.Abs(neomod - Mcosu.StableMultiplier(priced, v2)) < 1e-9;
    }

    /* ------------------------------------------------------------- its fails */

    public static string ScoresFile(string root) => NodePath.Join(root, "neomod_scores.db");

    private const int GradeF = 8;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, (DateTime Written, long Length, HashSet<string> Failed)> FailedCache = new(StringComparer.Ordinal);

    private static string FailKey(string md5, double unixSeconds, string name) => $"{Js.ToLower(md5)}:{Js.NumberToString(unixSeconds)}:{name}";

    /// <summary>
    /// Whether neomod kept this play as a fail (grade F), which it does only with its hidden
    /// <c>save_failed_scores</c> on. Read from the <c>neomod_scores.db</c> beside the replays.
    /// </summary>
    public static bool Failed(ReplayScore score, string replayPath)
    {
        if (score.Client != "neomod") return false;
        var dir = NodePath.Dirname(replayPath);
        for (var up = 0; up < 3; up++, dir = NodePath.Dirname(dir))
        {
            var file = ScoresFile(dir);
            if (!File.Exists(file)) continue;
            return FailedIn(file).Contains(FailKey(score.BeatmapMD5, Math.Floor(score.PlayedAtMs / 1000.0), score.Username));
        }
        return false;
    }

    private static HashSet<string> FailedIn(string file)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return [];
        }
        lock (Gate)
        {
            if (FailedCache.TryGetValue(file, out var hit) && hit.Written == info.LastWriteTimeUtc && hit.Length == info.Length) return hit.Failed;
        }
        byte[] bytes;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream();
            stream.CopyTo(copy);
            bytes = copy.ToArray();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
        var failed = FailedScores(bytes);
        lock (Gate) FailedCache[file] = (info.LastWriteTimeUtc, info.Length, failed);
        return failed;
    }

    /// <summary>
    /// The fails in a <c>neomod_scores.db</c> (<c>Database::loadScores</c>), by beatmap, unix second
    /// and player name. A file cut short, or not neomod's, gives what was read before it.
    /// </summary>
    public static HashSet<string> FailedScores(byte[] buf)
    {
        var output = new HashSet<string>(StringComparer.Ordinal);
        var o = 0;
        bool Take(int n)
        {
            if (n < 0 || o + n > buf.Length) return false;
            o += n;
            return true;
        }
        bool String(out string s)
        {
            s = "";
            if (o >= buf.Length) return false;
            if (buf[o++] != 0x0b) return true;
            int len = 0, shift = 0;
            while (true)
            {
                if (o >= buf.Length || shift > 28) return false;
                var octet = buf[o++];
                len |= (octet & 0x7f) << shift;
                shift += 7;
                if ((octet & 0x80) == 0) break;
            }
            if (len < 0 || o + len > buf.Length) return false;
            s = System.Text.Encoding.UTF8.GetString(buf, o, len);
            o += len;
            return true;
        }

        if (buf.Length < 17 || System.Text.Encoding.ASCII.GetString(buf, 0, 5) != "NEOSC") return output;
        o = 9; // magic, version
        var beatmaps = BitConverter.ToUInt32(buf, o);
        o += 8; // beatmaps, scores
        for (uint m = 0; m < beatmaps; m++)
        {
            if (!String(out var md5) || o + 4 > buf.Length) return output;
            var scores = BitConverter.ToUInt32(buf, o);
            o += 4;
            for (uint s = 0; s < scores; s++)
            {
                if (o + 8 > buf.Length) return output;
                var flags = BitConverter.ToUInt64(buf, o);
                // The mods record: fixed fields, then each experimental mod's settings.
                var modsLength = 8 + 4 * 8
                    + (Has(flags, 2) ? 4 : 0) + (Has(flags, 18) ? 4 : 0) + (Has(flags, 20) ? 4 : 0) + (Has(flags, 19) ? 4 : 0)
                    + (Has(flags, ARWobbleBit) ? 8 : 0) + (Has(flags, WobbleBits) || Has(flags, WobbleBits + 1) ? 12 : 0)
                    + (Has(flags, StrictBits) || Has(flags, StrictBits + 1) ? 4 : 0) + (Has(flags, 27) ? 4 : 0);
                if (!Take(modsLength) || o + 8 + 8 + 8 + 4 > buf.Length) return output;
                o += 8 + 8; // score, spinner bonus
                var unix = BitConverter.ToInt64(buf, o);
                o += 8 + 4; // timestamp, player id
                if (!String(out var name) || o + 1 > buf.Length) return output;
                var grade = buf[o++];
                if (!String(out _) || !String(out _)) return output; // client, server
                // Ids, judgements and combo, neomod's own pp, slider breaks and hit errors, object counts.
                if (!Take(8 + 8 + 2 * 7 + 4 + 4 * 4 + 2 + 4 * 3 + 4 * 3)) return output;
                if (grade == GradeF) output.Add(FailKey(md5, unix, name));
            }
        }
        return output;
    }
}
