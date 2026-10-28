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
