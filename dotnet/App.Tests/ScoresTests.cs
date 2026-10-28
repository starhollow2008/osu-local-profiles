using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Tests;

/// <summary>test/score-details.test.ts, the reading half.</summary>
public class ScoresTests
{
    private static string Json(object? value) => JsonText.Stringify(value);

    private sealed class Harness : IDisposable
    {
        public TempDb H { get; } = new();
        private int n;

        public Harness()
        {
            H.Db.Run("""
                INSERT INTO beatmaps (md5, beatmap_id, beatmapset_id, artist, title, version, creator, cached_at)
                VALUES ('map', 3770193, 1830679, 'Taylor Swift', 'Cruel Summer', 'Seolv''s Hard', 'funny', 0)
                """);
        }

        public string Replay(string name)
        {
            var file = Path.Combine(H.Folder, name);
            File.WriteAllText(file, "replay bytes");
            return file;
        }

        public long Add(string client = "lazer", string? statistics = """{"great":10}""", int count300 = 495, int maxCombo = 200,
            int? mapMax = 200, string? replay = null, string mods = "[]", double? stars = 5, long? profileId = null)
        {
            n++;
            H.Db.Run("""
                INSERT INTO scores
                  (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
                   count300, count100, count50, count_geki, count_katu, count_miss,
                   accuracy, max_combo, total_score, passed, grade, stars, pp, ranked,
                   statistics_json, beatmap_max_combo, replay_path, played_at, beatmap_id)
                 VALUES (?,?,0,'map',?,?,'',?,0,0,0,0,0,1,?,500000,1,'S',?,100,1,?,?,?,?,3770193)
                """, profileId ?? H.ProfileId, $"k{n}", client, mods, count300, maxCombo, stars, statistics, mapMax, replay, 1_700_000_000_000 + n);
            return Convert.ToInt64(H.Db.Scalar("SELECT last_insert_rowid()"));
        }

        public ScoreDetail? Detail(long id, long? profileId = null) => Scores.Detail(H.Db, profileId ?? H.ProfileId, id, Eligibility.Vanilla);

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public void A_stable_scores_counters_read_as_lazers_judgements_for_its_ruleset()
    {
        using var h = new Harness();
        h.H.Db.Run("""
            INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
              count300, count100, count50, count_geki, count_katu, count_miss, accuracy, max_combo, total_score, passed, grade, played_at)
            VALUES (?, 'c', 0, 'map', 'stable', '[]', '', 300, 100, 50, 30, 10, 5, 1, 1, 1, 1, 'S', 1)
            """, h.H.ProfileId);
        var row = h.H.Db.FirstRow("SELECT * FROM scores WHERE dedupe_key = 'c'")!;
        Assert.Equal("""{"great":300,"ok":100,"meh":50,"miss":5}""", Json(Scores.LegacyStatistics(0L, row)));
        Assert.Equal("""{"great":300,"ok":100,"miss":5}""", Json(Scores.LegacyStatistics(1L, row)));
        Assert.Equal("""{"great":300,"large_tick_hit":100,"small_tick_hit":50,"small_tick_miss":10,"miss":5}""", Json(Scores.LegacyStatistics(2L, row)));
        Assert.Equal("""{"perfect":30,"great":300,"good":10,"ok":100,"meh":50,"miss":5}""", Json(Scores.LegacyStatistics(3L, row)));
    }

    [Fact]
    public void A_scores_detail_carries_what_the_score_page_needs()
    {
        using var h = new Harness();
        var id = h.Add(client: "stable", statistics: null, replay: h.Replay("stable.osr"));
        var d = h.Detail(id)!;
        Assert.Equal("stable", d.Client);
        Assert.Equal("""{"great":495,"ok":0,"meh":0,"miss":0}""", Json(d.Statistics));
        Assert.Empty(d.MaximumStatistics);
        Assert.True(d.PerfectCombo);
        Assert.True(d.ReplayAvailable);
        Assert.Equal("Cruel Summer", d.Title);
        // A stable play is listed with Classic, which osu! scored it with.
        Assert.Contains(d.Mods, m => Mods.Acronym(m) == "CL");

        // Stored as JSON null: read from the counters, as the TypeScript falls back.
        Assert.Equal("""{"great":495,"ok":0,"meh":0,"miss":0}""", Json(h.Detail(h.Add(statistics: "null"))!.Statistics));
        Assert.Null(h.Detail(h.Add(mapMax: null))!.PerfectCombo);

        h.H.Db.Run("UPDATE scores SET hidden_at = 1 WHERE id = ?", id);
        Assert.Null(h.Detail(id));
        var other = Profiles.Create(h.H.Db, "Other").Id;
        Assert.Null(h.Detail(h.Add(), other));
    }

    [Fact]
    public void The_difficulty_badge_is_the_maps_rating_never_a_modded_scores()
    {
        using var h = new Harness();
        var dt = h.Add(mods: """[{"acronym":"DT"}]""", stars: 4.6);
        Assert.Null(h.Detail(dt)!.DifficultyStars);
        h.Add(mods: """[{"acronym":"HD"}]""", stars: 3.42);
        Assert.Equal(3.42, h.Detail(dt)!.DifficultyStars);

        h.H.Db.Run("INSERT INTO beatmapset_details (beatmapset_id, data, fetched_at) VALUES (1830679, ?, 0)",
            """{"id":1830679,"userId":99,"difficulties":[{"id":3770193,"mode":"osu","stars":3.5,"version":"Seolv's Hard"}]}""");
        var d = h.Detail(dt)!;
        Assert.Equal("3.5", Json(d.DifficultyStars));
        Assert.Equal("99", Json(d.CreatorId));
    }

    [Fact]
    public void A_downloaded_replay_is_named_the_way_lazer_names_an_exported_one()
    {
        var playedAt = new DateTimeOffset(new DateTime(2026, 9, 10, 20, 36, 0, DateTimeKind.Local)).ToUnixTimeMilliseconds();
        Assert.Equal("Tangy playing Taylor Swift - Cruel Summer (funny) [Seolv's Hard] (2026-09-10_20-36).osr",
            Scores.ReplayFileName("Tangy", "Taylor Swift", "Cruel Summer", "funny", "Seolv's Hard", playedAt));
        Assert.Equal("ab playing unknown artist - Why no (2026-09-10_20-36).osr",
            Scores.ReplayFileName("a/b", null, "Why?: \"no\"", null, null, playedAt));
        var longName = Scores.ReplayFileName("x", new string('y', 400), "t", null, null, playedAt);
        Assert.True(longName.Length <= 204 && longName.EndsWith(".osr", StringComparison.Ordinal));
    }

    [Fact]
    public void A_non_ASCII_name_survives_the_download_header()
    {
        // Built from code points: this file is written without non-ASCII text.
        var japanese = string.Concat(new[] { 0x7AF9, 0x9054, 0x5F69, 0x5948 }.Select(c => (char)c));
        var name = $"Tangy playing {japanese} - x (2026-09-10_20-36).osr";
        var header = Scores.AttachmentHeader(name);
        Assert.StartsWith("attachment; filename=\"Tangy playing ____ - x (2026-09-10_20-36).osr\"; ", header);
        var encoded = header[(header.IndexOf("UTF-8''", StringComparison.Ordinal) + 7)..];
        Assert.Equal(name, Uri.UnescapeDataString(encoded));
        Assert.DoesNotContain('(', encoded);
        Assert.DoesNotContain('\'', encoded);
    }

    [Fact]
    public void A_replay_is_served_only_for_a_score_of_this_profile_whose_file_is_on_disk()
    {
        using var h = new Harness();
        var ok = h.Add(replay: h.Replay("ok.osr"));
        var found = Scores.ReplayDownload(h.H.Db, h.H.ProfileId, ok, "Tangy");
        Assert.Null(found.Error);
        Assert.Equal("replay bytes", File.ReadAllText(found.Path!));

        Assert.Contains("no replay", Scores.ReplayDownload(h.H.Db, h.H.ProfileId, h.Add(), "Tangy").Error);
        var gone = h.Add(replay: Path.Combine(h.H.Folder, "deleted-by-osu.osr"));
        Assert.Contains("no longer", Scores.ReplayDownload(h.H.Db, h.H.ProfileId, gone, "Tangy").Error);
        var other = Profiles.Create(h.H.Db, "Other").Id;
        Assert.NotNull(Scores.ReplayDownload(h.H.Db, other, ok, "Tangy").Error);
    }
}
