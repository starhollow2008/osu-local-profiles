using System.Security.Cryptography;
using System.Text;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tests;

/// <summary>test/beatmap-index.test.ts, the osuSection rule, and the replay parser's signature check.</summary>
public class BeatmapsTests
{
    private static string Osu(string title, int? beatmapId = null) =>
        $"osu file format v14\r\n\r\n[Metadata]\r\nTitle:{title}\r\n{(beatmapId is null ? "" : $"BeatmapID:{beatmapId}\r\n")}";

    private static string Md5(string text) => Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes(text)));

    private sealed class Harness : IDisposable
    {
        public TempDb H { get; } = new();

        public string File(string rel, string content)
        {
            var p = Path.GetFullPath(Path.Combine(H.Folder, rel));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            System.IO.File.WriteAllText(p, content);
            return p;
        }

        public long Count(string table) => Convert.ToInt64(H.Db.Scalar($"SELECT COUNT(*) FROM {table}"));

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public void A_section_ends_at_a_line_beginning_with_a_bracket_not_at_the_next_bracket()
    {
        var text = "osu file format v14\r\n[Metadata]\r\nTitle:x\r\nCreator:cRyo[iceeicee]\r\nTags:[CV. someone]\r\n[Difficulty]\r\nHPDrainRate:5\r\n";
        var meta = Beatmaps.ParseMetadataText(text);
        Assert.Equal("cRyo[iceeicee]", meta.Creator);
        Assert.Equal("[CV. someone]", Beatmaps.TagsAndSource(text).Tags);
        Assert.Null(Beatmaps.OsuSection(text, "[Events]"));
        // `Number(value) || null`: zero and nonsense are no id.
        Assert.Null(Beatmaps.ParseMetadataText("[Metadata]\nBeatmapID:0\n").BeatmapId);
        Assert.Null(Beatmaps.ParseMetadataText("[Metadata]\nBeatmapID:abc\n").BeatmapId);
        Assert.Equal("A - T (C) [V]", Beatmaps.DisplayName("A", "T", "C", "V"));
        Assert.Equal("", Beatmaps.DisplayName("A", "T", "", "V"));
    }

    [Fact]
    public void Lazers_store_is_sniffed_by_content_and_a_second_run_does_no_work()
    {
        using var h = new Harness();
        h.File("files/a/ab/ab12", Osu("One"));
        h.File("files/c/cd/cd34", "ID3 not a beatmap");
        var seen = new List<IndexProgress>();
        IndexRoot[] roots = [new(Path.Combine(h.H.Folder, "files"), false)];
        Assert.Equal((2L, 1L, 0L), Beatmaps.IndexFiles(h.H.Db, roots, seen.Add));
        Assert.Equal(1, h.Count("osu_files"));
        Assert.Equal(1, h.Count("not_beatmaps"));
        Assert.Equal(("indexing", 2L, 2L, true), (seen[^1].Phase, seen[^1].Scanned, seen[^1].Total, seen[^1].FirstRun));

        var again = new List<IndexProgress>();
        Assert.Equal((2L, 0L, 0L), Beatmaps.IndexFiles(h.H.Db, roots, again.Add));
        Assert.False(again[^1].FirstRun);
    }

    [Fact]
    public void Stables_Songs_opens_only_osu_files()
    {
        using var h = new Harness();
        h.File("Songs/1 Set/map.osu", Osu("Map"));
        h.File("Songs/1 Set/audio.mp3", "not read");
        Assert.Equal((1L, 1L, 0L), Beatmaps.IndexFiles(h.H.Db, [new(Path.Combine(h.H.Folder, "Songs"), true)]));
        Assert.Equal(0, h.Count("not_beatmaps"));
    }

    [Fact]
    public void Local_metadata_resolves_an_online_id_but_never_zero_or_an_ambiguous_copy()
    {
        using var h = new Harness();
        h.File("files/a/map", Osu("One", 5438074));
        h.File("files/b/map", Osu("Two", 5438074));
        h.File("files/c/map", Osu("Only", 77));
        Beatmaps.IndexFiles(h.H.Db, [new(Path.Combine(h.H.Folder, "files"), false)]);
        var resolver = new BeatmapResolver(h.H.Db, []);
        Assert.Equal(Md5(Osu("Only", 77)), resolver.Md5ForBeatmapId(77));
        Assert.Null(resolver.Md5ForBeatmapId(0));
        Assert.Null(resolver.Md5ForBeatmapId(5438074));
        // One of the two already played settles it.
        h.H.Db.Run("INSERT INTO beatmaps (md5, beatmap_id, cached_at) VALUES (?, 5438074, 0)", Md5(Osu("One", 5438074)));
        Assert.Equal(Md5(Osu("One", 5438074)), resolver.Md5ForBeatmapId(5438074));
    }

    [Fact]
    public void A_beatmap_missing_when_first_looked_up_is_found_once_indexed_and_a_miss_gets_one_chance()
    {
        using var h = new Harness();
        var content = $"{Osu("Fresh Download", 77)}Artist:Someone\r\nCreator:mapper\r\nVersion:Insane\r\n";
        var md5 = Md5(content);
        var resolver = new BeatmapResolver(h.H.Db, []);
        Assert.Null(resolver.Resolve(md5).OsuPath);

        var file = h.File("Songs/1 Someone - Fresh Download/map.osu", content);
        Beatmaps.IndexOneFile(h.H.Db, file);
        var found = resolver.Resolve(md5);
        Assert.Equal(file, found.OsuPath);
        Assert.Equal("Fresh Download", found.Title);
        Assert.Equal(77.0, found.BeatmapId);
        Assert.Equal("", found.TitleUnicode);
        Assert.Equal(file, new BeatmapResolver(h.H.Db, []).Resolve(md5).OsuPath);

        var later = Osu("Just Extracted");
        var laterFile = h.File("Songs/2 Set/map.osu", later);
        var asked = 0;
        var second = new BeatmapResolver(h.H.Db, []) { OnMiss = () => { asked++; Beatmaps.IndexOneFile(h.H.Db, laterFile); } };
        Assert.Equal(laterFile, second.Resolve(Md5(later)).OsuPath);
        second.Resolve(Md5(later));
        Assert.Equal(1, asked);
    }

    [Fact]
    public void Files_deleted_leave_the_index_but_a_root_that_yields_nothing_keeps_everything()
    {
        using var h = new Harness();
        var songs = Path.Combine(h.H.Folder, "Songs");
        var kept = h.File("Songs/1 Kept/kept.osu", Osu("Kept"));
        var doomed = h.File("Songs/2 Doomed/doomed.osu", Osu("Doomed"));
        IndexRoot[] roots = [new(songs, true)];
        Beatmaps.IndexFiles(h.H.Db, roots);
        new BeatmapResolver(h.H.Db, []).Resolve(Md5(Osu("Doomed")));

        Directory.Delete(Path.GetDirectoryName(doomed)!, recursive: true);
        Assert.Equal(1L, Beatmaps.IndexFiles(h.H.Db, roots).Removed);
        Assert.Equal([kept], h.H.Db.All("SELECT path FROM osu_files", r => r.GetString(0)));
        Assert.Null(h.H.Db.Scalar("SELECT osu_path FROM beatmaps WHERE md5 = ?", Md5(Osu("Doomed"))));

        Directory.Move(songs, Path.Combine(h.H.Folder, "Unplugged"));
        Assert.Equal(0L, Beatmaps.IndexFiles(h.H.Db, roots).Removed);
        Assert.Equal(1, h.Count("osu_files"));
    }

    [Fact]
    public void A_replay_is_told_from_any_other_file_by_its_first_bytes()
    {
        byte[] Head(byte mode, int version) => [mode, .. BitConverter.GetBytes(version)];
        Assert.True(Osr.LooksLikeReplay(Head(0, 20210520)));
        Assert.True(Osr.LooksLikeReplay(Head(3, 30000016)));
        Assert.False(Osr.LooksLikeReplay(Head(4, 20210520)));
        Assert.False(Osr.LooksLikeReplay(Head(0, 1)));
        Assert.False(Osr.LooksLikeReplay([0, 1]));
    }
}
