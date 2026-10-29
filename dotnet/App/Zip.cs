using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace OsuLocalProfiles;

/// <summary>
/// A zip of a few files, written as src/update/zip.ts's <c>writeZip</c> writes one: UTF-8 names,
/// deflated unless that comes out larger, local MS-DOS times, no directories and no zip64. The
/// compressed bytes differ from Node's zlib; the files inside are the same.
/// </summary>
internal static class Zip
{
    private const uint LocalSignature = 0x04034b50;
    private const uint CentralSignature = 0x02014b50;
    private const uint EndSignature = 0x06054b50;
    private const ushort Stored = 0;
    private const ushort Deflated = 8;
    private const ushort Utf8Names = 0x0800;

    private static readonly uint[] CrcTable = [.. Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    })];

    public static uint Crc32(ReadOnlySpan<byte> data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFFu;
    }

    private static byte[] DeflateRaw(byte[] data)
    {
        using var output = new MemoryStream();
        using (var deflate = new DeflateStream(output, CompressionLevel.Optimal, leaveOpen: true)) deflate.Write(data);
        return output.ToArray();
    }

    /* ------------------------------------------------------------------ reading */

    private const uint Zip64LocatorSignature = 0x07064b50;

    /// <summary>"Version made by" names the host in its high byte; 3 is Unix, where the attributes are a mode.</summary>
    private const int UnixHost = 3;

    /// <summary>
    /// One entry of an archive: its name with forward slashes, how it is stored, and the Unix
    /// permission bits when a Unix <c>zip</c> wrote it (an update's runtime only runs because of them).
    /// </summary>
    internal sealed record Entry(string Name, bool IsDirectory, int Method, long CompressedSize, long Size, long LocalHeaderOffset, int? Mode);

    private static int FindEndOfCentralDirectory(byte[] buf)
    {
        // The record is 22 bytes plus a comment of up to 64KB, so this is the whole search space.
        var earliest = Math.Max(0, buf.Length - 22 - 0xffff);
        for (var i = buf.Length - 22; i >= earliest; i--)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(i)) == EndSignature) return i;
        }
        return -1;
    }

    /// <summary>A name out of an archive, normalised, or null for anything that points outside the target.</summary>
    private static string? SafeName(string raw)
    {
        var name = raw.Replace('\\', '/').TrimStart('/');
        if (name == "") return null;
        if (name.Length >= 2 && char.IsAsciiLetter(name[0]) && name[1] == ':') return null;
        if (name.Split('/').Any(part => part == "..")) return null;
        return name;
    }

    /// <summary>The central directory: src/update/zip.ts's <c>readZipEntries</c>. Throws rather than guessing, zip64 included.</summary>
    public static List<Entry> ReadEntries(byte[] buf)
    {
        var eocd = FindEndOfCentralDirectory(buf);
        if (eocd < 0) throw new InvalidOperationException("not a zip file (no end-of-central-directory record)");
        var locator = eocd - 20;
        if (locator >= 0 && BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(locator)) == Zip64LocatorSignature)
        {
            throw new InvalidOperationException("zip64 archives are not supported");
        }
        var count = BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(eocd + 10));
        long offset = BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(eocd + 16));
        if (count == 0xffff || offset == 0xffffffff) throw new InvalidOperationException("zip64 archives are not supported");

        var entries = new List<Entry>();
        for (var i = 0; i < count; i++)
        {
            if (offset + 46 > buf.Length || BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan((int)offset)) != CentralSignature)
            {
                throw new InvalidOperationException($"corrupt central directory at entry {i + 1} of {count}");
            }
            var at = buf.AsSpan((int)offset);
            var madeBy = BinaryPrimitives.ReadUInt16LittleEndian(at[4..]) >> 8;
            var method = BinaryPrimitives.ReadUInt16LittleEndian(at[10..]);
            var compressedSize = BinaryPrimitives.ReadUInt32LittleEndian(at[20..]);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(at[24..]);
            var nameLength = BinaryPrimitives.ReadUInt16LittleEndian(at[28..]);
            var extraLength = BinaryPrimitives.ReadUInt16LittleEndian(at[30..]);
            var commentLength = BinaryPrimitives.ReadUInt16LittleEndian(at[32..]);
            var external = BinaryPrimitives.ReadUInt32LittleEndian(at[38..]);
            var localHeaderOffset = BinaryPrimitives.ReadUInt32LittleEndian(at[42..]);
            var raw = Encoding.UTF8.GetString(buf, (int)offset + 46, Math.Min(nameLength, buf.Length - (int)offset - 46));
            var name = SafeName(raw) ?? throw new InvalidOperationException($"refusing entry with an unsafe path: {raw}");
            entries.Add(new Entry(name, name.EndsWith('/'), method, compressedSize, size, localHeaderOffset,
                madeBy == UnixHost && external >> 16 != 0 ? (int)((external >> 16) & 0x1ff) : null));
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    /// <summary>The bytes of one entry, decompressed.</summary>
    public static byte[] EntryData(byte[] buf, Entry entry)
    {
        var header = (int)entry.LocalHeaderOffset;
        if (header + 30 > buf.Length || BinaryPrimitives.ReadUInt32LittleEndian(buf.AsSpan(header)) != LocalSignature)
        {
            throw new InvalidOperationException($"corrupt local header for {entry.Name}");
        }
        // The local header has its own extra field, often a different length from the central one's.
        var nameLength = BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(header + 26));
        var extraLength = BinaryPrimitives.ReadUInt16LittleEndian(buf.AsSpan(header + 28));
        var start = header + 30 + nameLength + extraLength;
        var raw = buf.AsSpan(Math.Min(start, buf.Length), (int)Math.Min(entry.CompressedSize, Math.Max(0, buf.Length - start)));
        if (entry.Method == Stored) return raw.ToArray();
        if (entry.Method == Deflated)
        {
            using var input = new MemoryStream(raw.ToArray());
            using var inflate = new DeflateStream(input, CompressionMode.Decompress);
            using var output = new MemoryStream();
            inflate.CopyTo(output);
            return output.ToArray();
        }
        throw new InvalidOperationException($"{entry.Name} uses unsupported compression method {entry.Method}");
    }

    /* ------------------------------------------------------------------ writing */

    public static byte[] Write(IReadOnlyList<(string Name, byte[] Data)> files, DateTime at)
    {
        // MS-DOS time and date, in local time, as every unzip tool shows them.
        var time = (ushort)((at.Hour << 11) | (at.Minute << 5) | (at.Second >> 1));
        var date = (ushort)(((at.Year - 1980) << 9) | (at.Month << 5) | at.Day);

        using var body = new MemoryStream();
        using var directory = new MemoryStream();
        foreach (var (fileName, data) in files)
        {
            var name = Encoding.UTF8.GetBytes(fileName.Replace('\\', '/'));
            var deflated = DeflateRaw(data);
            // A picture is already compressed and can come out larger; store it as it is then.
            var method = deflated.Length < data.Length ? Deflated : Stored;
            var stored = method == Deflated ? deflated : data;
            var crc = Crc32(data);
            var offset = (uint)body.Length;

            var local = new byte[30];
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(0), LocalSignature);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(4), 20);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(6), Utf8Names);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(8), method);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(10), time);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(12), date);
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(14), crc);
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(18), (uint)stored.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(local.AsSpan(22), (uint)data.Length);
            BinaryPrimitives.WriteUInt16LittleEndian(local.AsSpan(26), (ushort)name.Length);

            var central = new byte[46];
            BinaryPrimitives.WriteUInt32LittleEndian(central.AsSpan(0), CentralSignature);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(4), 20);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(6), 20);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(8), Utf8Names);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(10), method);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(12), time);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(14), date);
            BinaryPrimitives.WriteUInt32LittleEndian(central.AsSpan(16), crc);
            BinaryPrimitives.WriteUInt32LittleEndian(central.AsSpan(20), (uint)stored.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(central.AsSpan(24), (uint)data.Length);
            BinaryPrimitives.WriteUInt16LittleEndian(central.AsSpan(28), (ushort)name.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(central.AsSpan(42), offset);

            body.Write(local);
            body.Write(name);
            body.Write(stored);
            directory.Write(central);
            directory.Write(name);
            if (body.Length > uint.MaxValue) throw new InvalidOperationException("too large for a zip file (4GB)");
        }

        var end = new byte[22];
        BinaryPrimitives.WriteUInt32LittleEndian(end.AsSpan(0), EndSignature);
        BinaryPrimitives.WriteUInt16LittleEndian(end.AsSpan(8), (ushort)files.Count);
        BinaryPrimitives.WriteUInt16LittleEndian(end.AsSpan(10), (ushort)files.Count);
        BinaryPrimitives.WriteUInt32LittleEndian(end.AsSpan(12), (uint)directory.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(end.AsSpan(16), (uint)body.Length);
        body.Write(directory.ToArray());
        body.Write(end);
        return body.ToArray();
    }
}
