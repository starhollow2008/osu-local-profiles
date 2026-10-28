using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using SharpCompress.Compressors.LZMA;

namespace OsuLocalProfiles.Replays;

/// <summary>What McOsu recorded that a stable replay cannot hold (src/clients/mcosu.ts, <c>McosuFacts</c>).</summary>
internal sealed record McosuFacts(double Speed, double Cs, double Ar, double Od, double Hp, bool Nightmare, List<string> Experimental);

/// <summary>Set on a replay this app built for a score from its osu! link or entered by hand.</summary>
internal sealed record BuiltFacts(string Origin, bool LegacyTotal);

/// <summary>A replay's score summary: src/osr.ts's <c>ReplayScore</c>. Frames are never read.</summary>
internal sealed record ReplayScore(
    string Client,
    int Mode,
    int Version,
    string BeatmapMD5,
    string Username,
    string? ReplayMD5,
    int Count300,
    int Count100,
    int Count50,
    int CountGeki,
    int CountKatu,
    int CountMiss,
    int TotalScore,
    int MaxCombo,
    bool PerfectCombo,
    int LegacyMods,
    long PlayedAtMs,
    long? OnlineScoreId,
    JsonElement? Extras,
    McosuFacts? Mcosu,
    BuiltFacts? Built);

/// <summary>
/// Reader for osu! <c>.osr</c> replays: src/osr.ts. Parsed here rather than by osu!'s decoder because
/// that needs the beatmap, and a replay has to be read before anything knows which beatmap it is.
/// lazer appends an LZMA-compressed JSON block (<c>LegacyReplaySoloScoreInfo</c>) carrying the
/// authoritative mods, statistics and rank; this app's own blocks follow for the replays it builds.
/// </summary>
internal static class Osr
{
    /// <summary>Version marker at which lazer began appending the extended score block.</summary>
    public const int LazerExtMinVersion = 30000001;

    /// <summary>From this version until 20140721, osu!stable wrote a replay's online id as 32 bits.</summary>
    private const int Int32OnlineIdMinVersion = 20121008;

    /// <summary>.NET ticks (100ns since 0001-01-01) at the unix epoch.</summary>
    private const long TicksAtEpoch = 621355968000000000;

    /// <summary>
    /// Cheap signature check: lazer's store holds files of every kind under hash names, so the
    /// watcher rejects non-replays from the first few bytes.
    /// </summary>
    public static bool LooksLikeReplay(ReadOnlySpan<byte> head)
    {
        if (head.Length < 5 || head[0] > 3) return false;
        var version = BinaryPrimitives.ReadInt32LittleEndian(head[1..]);
        // Stable versions look like 20210520; lazer uses 300000xx.
        return version is >= 20000000 and <= 40000000;
    }

    private sealed class Cursor(byte[] b)
    {
        private int o;
        public int Remaining => b.Length - o;
        public byte Byte() => b[o++];
        public int Short() { var v = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(o)); o += 2; return v; }
        public int Int() { var v = BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(o)); o += 4; return v; }
        public long Long() { var v = BinaryPrimitives.ReadInt64LittleEndian(b.AsSpan(o)); o += 8; return v; }
        public void Skip(int n) => o += n;
        public byte[] Slice(int n) { var s = b.AsSpan(o, n).ToArray(); o += n; return s; }
        public byte[] Rest() => b.AsSpan(Math.Min(o, b.Length)).ToArray();

        /// <summary>ULEB128-prefixed UTF-8; a leading 0x00 means null.</summary>
        public string? String()
        {
            if (b[o++] == 0x00) return null;
            int shift = 0, len = 0;
            byte value;
            do
            {
                value = b[o++];
                len |= (value & 0x7f) << shift;
                shift += 7;
            }
            while ((value & 0x80) != 0);
            var end = Math.Min(o + len, b.Length);
            var s = Encoding.UTF8.GetString(b, o, end - o);
            o += len;
            return s;
        }
    }

    /// <summary>
    /// An LZMA-alone stream (5 property bytes, an 8-byte size, the data) as text, the way osu!'s own
    /// <c>LegacyScoreDecoder</c> reads lazer's block.
    /// </summary>
    public static string InflateLzma(byte[] block)
    {
        if (block.Length < 13) throw new InvalidDataException("lzma block too short");
        var properties = block[..5];
        var size = BinaryPrimitives.ReadInt64LittleEndian(block.AsSpan(5));
        using var input = new MemoryStream(block, 13, block.Length - 13);
        using var lzma = LzmaStream.Create(properties, input, block.Length - 13, size);
        using var output = new MemoryStream();
        lzma.CopyTo(output);
        return Encoding.UTF8.GetString(output.ToArray());
    }

    /// <summary>A replay's ruleset, version, beatmap and stable bitmask, from its first few hundred bytes.</summary>
    public static (int Mode, int Version, string BeatmapMD5, int LegacyMods) ParseHeader(byte[] buf)
    {
        var c = new Cursor(buf);
        var mode = c.Byte();
        var version = c.Int();
        var beatmapMD5 = c.String() ?? "";
        c.String(); // player name
        c.String(); // replay MD5
        c.Skip(6 * 2 + 4 + 2 + 1); // judgement counts, total score, max combo, perfect
        return (mode, version, beatmapMD5, c.Int());
    }

    /// <summary>Parse a replay. The frames, the bulk of the file, are skipped.</summary>
    public static ReplayScore Parse(byte[] buf)
    {
        var c = new Cursor(buf);
        var mode = c.Byte();
        var version = c.Int();
        var beatmapMD5 = c.String() ?? "";
        var username = c.String() ?? "";
        var replayMD5 = c.String();

        int count300 = c.Short(), count100 = c.Short(), count50 = c.Short();
        int countGeki = c.Short(), countKatu = c.Short(), countMiss = c.Short();
        var totalScore = c.Int();
        var maxCombo = c.Short();
        var perfectCombo = c.Byte() != 0;
        var legacyMods = c.Int();

        c.String(); // life bar graph
        var ticks = c.Long();
        var frameLength = c.Int();
        c.Skip(frameLength);

        long? onlineScoreId = null;
        JsonElement? extras = null;
        McosuFacts? mcosu = null;
        BuiltFacts? built = null;

        if (c.Remaining >= 8)
        {
            onlineScoreId = c.Long();
            if (version >= LazerExtMinVersion && c.Remaining >= 4)
            {
                var len = c.Int();
                if (len > 0 && len <= c.Remaining)
                {
                    try
                    {
                        extras = JsonText.TryParse(InflateLzma(c.Slice(len)), out var parsed) ? parsed : null;
                    }
                    catch (Exception e) when (e is InvalidDataException or IOException or ArgumentException or IndexOutOfRangeException)
                    {
                        extras = null; // corrupt or unknown block: fall back to legacy fields
                    }
                    built = AppBlocks.ReadBuilt(c.Rest());
                }
            }
            else if (version < LazerExtMinVersion)
            {
                mcosu = AppBlocks.ReadMcosu(c.Rest());
                built = AppBlocks.ReadBuilt(c.Rest());
            }
        }
        else if (version >= Int32OnlineIdMinVersion && c.Remaining >= 4)
        {
            // osu!stable wrote the id in 32 bits until 2014-07-21, as lazer's decoder reads it.
            onlineScoreId = c.Int();
        }

        return new ReplayScore(
            version >= LazerExtMinVersion ? "lazer" : mcosu is not null ? "mcosu" : "stable",
            mode, version, beatmapMD5, username, replayMD5,
            count300, count100, count50, countGeki, countKatu, countMiss,
            totalScore, maxCombo, perfectCombo, legacyMods,
            // ticks / 10000n, as BigInt division truncates toward zero.
            ticks / 10_000 - TicksAtEpoch / 10_000,
            onlineScoreId == -1 ? null : onlineScoreId,
            extras, mcosu, built);
    }
}

/// <summary>
/// This app's own blocks after a replay it built: a magic string, the JSON's length, the JSON.
/// osu! never reads them (src/replay-writer.ts, <c>appBlock</c>/<c>readAppBlock</c>).
/// </summary>
internal static class AppBlocks
{
    public const string BuiltBlock = "osu-local-profiles:built";
    public const string McosuBlock = "osu-local-profiles:mcosu";

    /// <summary>The JSON of one of this app's blocks at the start of <paramref name="rest"/>, or null.</summary>
    public static JsonElement? Read(byte[] rest, string magic)
    {
        var tag = Encoding.Latin1.GetBytes(magic);
        if (rest.Length < tag.Length + 4 || !rest.AsSpan(0, tag.Length).SequenceEqual(tag)) return null;
        var len = BinaryPrimitives.ReadInt32LittleEndian(rest.AsSpan(tag.Length));
        var start = tag.Length + 4;
        if (len <= 0 || start + len > rest.Length) return null;
        return JsonText.TryParse(Encoding.UTF8.GetString(rest, start, len), out var parsed) ? parsed : null;
    }

    public static byte[] Write(string magic, object json)
    {
        var data = Encoding.UTF8.GetBytes(JsonText.Stringify(json));
        var output = new byte[magic.Length + 4 + data.Length];
        Encoding.Latin1.GetBytes(magic).CopyTo(output, 0);
        BinaryPrimitives.WriteInt32LittleEndian(output.AsSpan(magic.Length), data.Length);
        data.CopyTo(output, magic.Length + 4);
        return output;
    }

    public static BuiltFacts? ReadBuilt(byte[] rest)
    {
        var raw = Read(rest, BuiltBlock);
        if (!Js.IsString(Js.Get(raw, "origin"), out var origin) || origin is not ("link" or "manual")) return null;
        return new BuiltFacts(origin, Js.Get(raw, "legacyTotal") is { ValueKind: JsonValueKind.True });
    }

    public static McosuFacts? ReadMcosu(byte[] rest)
    {
        var raw = Read(rest, McosuBlock);
        // `typeof raw !== 'object'`: null, numbers, text and booleans are not facts; arrays are objects.
        if (raw is not { ValueKind: JsonValueKind.Object or JsonValueKind.Array } facts) return null;
        double Num(string key, double fallback) =>
            Js.Get(facts, key) is { ValueKind: JsonValueKind.Number } n && double.IsFinite(Js.NumberOf(n)) ? Js.NumberOf(n) : fallback;
        return new McosuFacts(
            Num("speed", 1), Num("cs", double.NaN), Num("ar", double.NaN), Num("od", double.NaN), Num("hp", double.NaN),
            Js.Get(facts, "nightmare") is { ValueKind: JsonValueKind.True },
            Js.Get(facts, "experimental") is { ValueKind: JsonValueKind.Array } list
                ? [.. list.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)]
                : []);
    }
}
