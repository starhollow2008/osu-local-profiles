using System.Text;

namespace OsuLocalProfiles.Replays;

/// <summary>osu!stable's six counters, as a replay's header holds them.</summary>
internal sealed record LegacyCounts(double C300, double C100, double C50, double Geki, double Katu, double Miss);

/// <summary>
/// A replay's header: an osu!stable version (2xxxxxxx) or a lazer one (300000xx), osu!'s hash of it
/// (null for a built one), and when the play ended in unix ms; <c>OnlineId</c> 0 for none.
/// </summary>
internal sealed record ReplayHeader(
    int Mode,
    int Version,
    string BeatmapMD5,
    string Player,
    string? ReplayMD5,
    LegacyCounts Counts,
    double TotalScore,
    double MaxCombo,
    bool Perfect,
    int LegacyMods,
    double PlayedAt,
    long OnlineId);

/// <summary>
/// Writing <c>.osr</c> files for the replays this app builds: src/replay-writer.ts. Every one has no
/// frames, only what osu! prices from, and the layout <see cref="Osr"/> reads, field for field.
/// </summary>
internal static class ReplayWriter
{
    /// <summary>.NET ticks at the unix epoch, which is how a replay dates itself.</summary>
    private const long TicksAtEpoch = 621355968000000000;

    private sealed class Writer
    {
        private readonly MemoryStream output = new();

        public void Byte(int v) => output.WriteByte((byte)v);

        /// <summary>Unsigned and clamped, as <c>writeUInt16LE(Math.max(0, Math.min(v, 0xffff)))</c> writes it; NaN is 0.</summary>
        public void Short(double v)
        {
            var clamped = double.IsNaN(v) ? 0 : Math.Max(0, Math.Min(v, 0xffff));
            var n = (ushort)Math.Truncate(clamped);
            output.Write([(byte)n, (byte)(n >> 8)]);
        }

        public void Int(int v) => output.Write(BitConverter.GetBytes(v));

        public void Long(long v) => output.Write(BitConverter.GetBytes(v));

        /// <summary>ULEB128-prefixed UTF-8, or a single 0x00 for null.</summary>
        public void String(string? s)
        {
            if (s is null)
            {
                Byte(0);
                return;
            }
            var data = Encoding.UTF8.GetBytes(s);
            Byte(0x0b);
            var n = (uint)data.Length;
            do
            {
                var x = (byte)(n & 0x7f);
                n >>= 7;
                if (n != 0) x |= 0x80;
                Byte(x);
            } while (n != 0);
            output.Write(data);
        }

        public void Bytes(byte[] b) => output.Write(b);

        public byte[] Done() => output.ToArray();
    }

    /// <summary>A replay with no frames, followed by <paramref name="tail"/>: lazer's block, then any of this app's.</summary>
    public static byte[] Encode(ReplayHeader h, IEnumerable<byte[]>? tail = null)
    {
        var w = new Writer();
        w.Byte(h.Mode);
        w.Int(h.Version);
        w.String(h.BeatmapMD5);
        w.String(h.Player);
        w.String(h.ReplayMD5);
        w.Short(h.Counts.C300);
        w.Short(h.Counts.C100);
        w.Short(h.Counts.C50);
        w.Short(h.Counts.Geki);
        w.Short(h.Counts.Katu);
        w.Short(h.Counts.Miss);
        // stable's field is 32 bits; a total beyond it would be a marathon well past any stable one.
        w.Int((int)Math.Min(Math.Max(0, Js.Round(h.TotalScore)), 0x7fffffff));
        w.Short(h.MaxCombo);
        w.Byte(h.Perfect ? 1 : 0);
        w.Int(h.LegacyMods);
        w.String(null); // life bar
        w.Long((long)Js.Round(h.PlayedAt) * 10_000 + TicksAtEpoch);
        w.Int(0); // no frames
        w.Long(h.OnlineId);
        foreach (var part in tail ?? []) w.Bytes(part);
        return w.Done();
    }
}
