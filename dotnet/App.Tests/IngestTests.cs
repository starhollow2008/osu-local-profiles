using System.Text;
using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// The tracker's judging and writing: test/accuracy, ranked mods' decoding, mcosu (mods),
/// player-identity, identity (sessions), tracking-filter (matching) and declined.
/// </summary>
public sealed class IngestTests : IDisposable
{
    private readonly TempDb h = new("Test Profile");

    public void Dispose() => h.Dispose();

    private static string Json(object value) => JsonText.Stringify(value);

    private static ReplayScore Replay(string username = "Tangy", long playedAt = 1735689600000, string? replayMd5 = null,
        long? onlineScoreId = null, string extras = "", int mode = 0, int legacyMods = 0) =>
        new("stable", mode, 20230504, new string('a', 32), username, replayMd5 ?? $"hash-{Guid.NewGuid():N}",
            100, 0, 0, 0, 0, 0, 1_000_000, 100, true, legacyMods, playedAt, onlineScoreId,
            extras.Length == 0 ? null : JsonDocument.Parse(extras).RootElement.Clone(), null, null);

    /* ------------------------------------------------------------- accuracy */

    [Fact]
    public void Lazer_accuracy_weighs_every_judgement_and_refuses_to_guess_at_one_it_does_not_know()
    {
        var perfect = Replay(extras: """{"statistics":{"great":199,"large_tick_hit":3,"ignore_hit":73,"slider_tail_hit":73},"maximum_statistics":{"great":199,"large_tick_hit":3,"ignore_hit":73,"slider_tail_hit":73}}""");
        Assert.Equal(1, Grade.LazerAccuracy(perfect));
        Assert.Null(Grade.LazerAccuracy(Replay(extras: """{"statistics":{"great":100,"some_future_judgement":5},"maximum_statistics":{"great":100}}""")));
        Assert.Null(Grade.LazerAccuracy(Replay(extras: """{"statistics":{"great":100,"constructor":1},"maximum_statistics":{"great":100}}""")));
        Assert.Null(Grade.LazerAccuracy(Replay(extras: """{"statistics":{"great":174}}""")));
        var stable = Replay() with { Count300 = 90, Count100 = 10 };
        Assert.Equal((300.0 * 90 + 100 * 10) / (300 * 100), Grade.Accuracy(stable, 0));
    }

    [Fact]
    public void A_stable_grade_is_worked_out_and_lazers_own_is_taken_as_written()
    {
        Assert.Equal("X", Grade.GradeOf(Replay(), 0, []));
        Assert.Equal("XH", Grade.GradeOf(Replay(), 0, [Mods.Of("HD")]));
        Assert.Equal("A", Grade.GradeOf(Replay() with { Count300 = 95, Count100 = 4, CountMiss = 1 }, 0, []));
        Assert.Equal("S", Grade.GradeOf(Replay(extras: """{"rank":"S"}"""), 0, []));
        // lazer's header says F for plays that ranked A; its own block is the answer.
        Assert.False(Grade.Passed(Replay(extras: """{"rank":"F"}""")));
        Assert.True(Grade.Passed(Replay(extras: """{"rank":"A"}""")));
        Assert.Equal("F", Grade.ComputeGrade(Replay(extras: """{"rank":"F"}"""), 0, []));
    }

    /* ----------------------------------------------------------------- mods */

    [Fact]
    public void A_stable_bitmask_reads_as_osu_reads_it_for_each_ruleset()
    {
        Assert.Equal("""[{"acronym":"HD"},{"acronym":"NC"}]""", Json(Mods.DecodeLegacy(8 | 64 | 512, 0)));
        Assert.Equal("""[{"acronym":"PF"}]""", Json(Mods.DecodeLegacy((1 << 5) | (1 << 14), 0)));
        // ScoreV2 and Mirror are bits 29 and 30; Mirror is mania's alone, Relax not mania's.
        Assert.Equal("""[{"acronym":"SV2"}]""", Json(Mods.DecodeLegacy((1 << 29) | (1 << 30), 0)));
        Assert.Equal("""[{"acronym":"SV2"},{"acronym":"MR"}]""", Json(Mods.DecodeLegacy((1 << 29) | (1 << 30) | 128, 3)));
        Assert.Equal(8 | 64 | 512, Mods.EncodeLegacy([Mods.Of("HD"), Mods.Of("NC"), Mods.Of("CL")]));
        Assert.Null(Mods.EncodeLegacy([Mods.With("DT", new Dictionary<string, object> { ["speed_change"] = 1.2 })]));
        Assert.Null(Mods.EncodeLegacy([Mods.Of("DA")]));
    }

    [Fact]
    public void Labels_strippable_mods_and_what_can_never_count()
    {
        Assert.Equal("None", Mods.Label([]));
        Assert.Equal("HDDT", Mods.Label([Mods.Of("HD"), Mods.Of("DT")]));
        Assert.Equal(["RX"], Mods.Strippable([Mods.Of("DT"), Mods.Of("RX")]));
        Assert.Empty(Mods.Strippable([Mods.Of("DT")]));
        Assert.False(Mods.Countable([Mods.Of("HD"), Mods.Of("AT")]));
        Assert.True(Mods.Countable([Mods.Of("RX")]));
    }

    [Fact]
    public void Lazers_numbers_are_stored_as_JavaScript_writes_them()
    {
        var mods = JsonDocument.Parse("""[{"acronym":"DA","settings":{"circle_size":4.0,"approach_rate":9.50,"1":true}}]""").RootElement.Clone();
        Assert.Equal("""[{"acronym":"DA","settings":{"1":true,"circle_size":4,"approach_rate":9.5}}]""", Json(mods));
        Assert.Equal("""{"a":1e+21,"b":1e-7}""", Json(new { a = 1e21, b = 1e-7 }));
    }

    /* ---------------------------------------------------------- McOsu's mods */

    private static McosuFacts Facts(double speed = 1, double cs = 3.3, double ar = 8, double od = 6, double hp = 4,
        bool nightmare = false, params string[] experimental) => new(speed, cs, ar, od, hp, nightmare, [.. experimental]);

    private static readonly BaseDifficulty Hard = new(3.3, 8, 6, 4);

    private static double F32(double n) => (float)n;

    [Fact]
    public void McOsu_speed_is_a_rate_mod_at_its_rate_and_one_osu_cannot_hold_gets_no_pp()
    {
        var dt = Mcosu.Mods(64, Facts(speed: 1.5), Hard);
        Assert.Equal("""[{"acronym":"DT"}]""", Json(dt.Mods));
        Assert.Equal("""[{"acronym":"DT"}]""", Json(dt.Priced!));
        Assert.False(dt.IgnoreLegacyTotalScore);

        var slider = Mcosu.Mods(0, Facts(speed: F32(1.2)), Hard);
        Assert.Equal("""[{"acronym":"DT","settings":{"speed_change":1.2}}]""", Json(slider.Mods));
        Assert.True(slider.IgnoreLegacyTotalScore);

        Assert.Equal("""[{"acronym":"NC","settings":{"speed_change":1.3}}]""", Json(Mcosu.Mods(64 | 512, Facts(speed: F32(1.3)), Hard).Mods));
        Assert.Equal("""[{"acronym":"HT"}]""", Json(Mcosu.Mods(256, Facts(speed: 0.75), Hard).Mods));
        Assert.Equal("""[{"acronym":"HT","settings":{"speed_change":0.6}}]""", Json(Mcosu.Mods(0, Facts(speed: F32(0.6)), Hard).Mods));
        Assert.Equal("""[{"acronym":"HD"}]""", Json(Mcosu.Mods(64 | 8, Facts(speed: 1), Hard).Mods));

        Assert.Null(Mcosu.Mods(0, Facts(speed: 2.5), Hard).Priced);
        Assert.Null(Mcosu.Mods(0, Facts(speed: 0.4), Hard).Priced);
    }

    [Fact]
    public void McOsu_overrides_are_Difficulty_Adjust_after_the_mods_that_change_the_same_values()
    {
        var m = Mcosu.Mods(64, Facts(speed: 1.5, ar: 7), Hard);
        Assert.Equal("""[{"acronym":"DT"},{"acronym":"DA","settings":{"approach_rate":7}}]""", Json(m.Mods));
        Assert.False(m.IgnoreLegacyTotalScore);

        Assert.Equal("""[{"acronym":"HR"}]""", Json(Mcosu.Mods(16, Facts(cs: F32(3.3 * 1.3), ar: 10, od: F32(8.4), hp: F32(5.6)), Hard).Mods));
        Assert.Equal("""[{"acronym":"HR"},{"acronym":"DA","settings":{"approach_rate":9}}]""",
            Json(Mcosu.Mods(16, Facts(cs: F32(3.3 * 1.3), ar: 9, od: F32(8.4), hp: F32(5.6)), Hard).Mods));
        Assert.Equal("""[{"acronym":"EZ"}]""", Json(Mcosu.Mods(2, Facts(cs: F32(1.65), ar: 4, od: 3, hp: 2), Hard).Mods));

        var extended = Mcosu.Mods(0, Facts(ar: 10.5), Hard);
        Assert.Equal("""[{"acronym":"DA","settings":{"approach_rate":10.5,"extended_limits":true}}]""", Json(extended.Mods));
        Assert.NotNull(extended.Priced);
        Assert.Null(Mcosu.Mods(0, Facts(cs: 12), Hard).Priced);

        // Without the map nothing can be told apart from an override.
        Assert.Equal("""[{"acronym":"DT"}]""", Json(Mcosu.Mods(64, Facts(speed: 1.5, ar: 7), null).Mods));
    }

    [Fact]
    public void Nightmare_and_McOsus_experimental_mods_are_one_MC_never_priced()
    {
        var m = Mcosu.Mods(1 << 22, Facts(nightmare: true, experimental: ["osu_mod_wobble", "osu_mod_fullalternate"]), Hard);
        Assert.Equal("""[{"acronym":"MC","settings":{"nightmare":true,"osu_mod_wobble":true,"osu_mod_fullalternate":true}}]""", Json(m.Mods));
        Assert.Empty(m.Priced!);
        // Minimize moves CS as the map plays, so the stored one is no override.
        Assert.Equal("""[{"acronym":"MC","settings":{"osu_mod_minimize":true}}]""", Json(Mcosu.Mods(0, Facts(cs: 5.9, experimental: ["osu_mod_minimize"]), Hard).Mods));

        Assert.True(Mcosu.LegacyTotalComparable(8 | 16 | 64, [Mods.Of("HD"), Mods.Of("HR"), Mods.Of("DT")]));
        Assert.False(Mcosu.LegacyTotalComparable(1 | 2, [Mods.Of("NF"), Mods.Of("EZ")]));
        Assert.True(Mcosu.LegacyTotalComparable(128, [Mods.Of("RX")]));
    }

    [Fact]
    public void A_maps_own_difficulty_is_read_from_its_section_with_OD_for_a_missing_AR()
    {
        var map = Path.Combine(h.Folder, "map.osu");
        File.WriteAllText(map, "osu file format v14\r\n\r\n[Difficulty]\r\nHPDrainRate:4\r\nCircleSize:3.3\r\nOverallDifficulty:6\r\nApproachRate:8\r\n\r\n[Events]\r\n");
        Assert.Equal(Hard, Mcosu.ReadBaseDifficulty(map));
        File.WriteAllText(map, "[Difficulty]\r\nHPDrainRate:5\r\nCircleSize:4\r\nOverallDifficulty:7\r\n");
        Assert.Equal(new BaseDifficulty(4, 7, 7, 5), Mcosu.ReadBaseDifficulty(map));
        Assert.Null(Mcosu.ReadBaseDifficulty(Path.Combine(h.Folder, "gone.osu")));
    }

    /* -------------------------------------------------------------- identity */

    private static readonly PlayerIdentity Owner = new(3119700, ["tangy", "blizzardshiver", "a wild tangy"], "Tangy", true, "linked");

    private static ReplayPlayer Submitted(string name, double? userId = null) => new(name, userId, 900_000_001);

    [Fact]
    public void A_play_is_yours_unless_there_is_positive_evidence_someone_else_set_it()
    {
        Assert.True(Players.OwnsPlay(Owner, Submitted("tAnGy")));
        Assert.True(Players.OwnsPlay(Owner, Submitted("blizzardshiver")));
        Assert.True(Players.OwnsPlay(Owner, Submitted("   ")));
        Assert.True(Players.OwnsPlay(Owner, Submitted("Guest")));
        Assert.False(Players.OwnsPlay(Owner, Submitted("mrekk")));
        Assert.True(Players.CertainlySomeoneElse(Owner, Submitted("mrekk")));
        Assert.True(Players.OwnsPlay(Owner, Submitted("whatever", 3119700)));
        Assert.False(Players.OwnsPlay(Owner, Submitted("Tangy", 3654106)));
        Assert.Null(Players.OwnsPlay(PlayerIdentity.Unknown, Submitted("mrekk")));
        // Never submitted and written as played: set here, whatever its name.
        Assert.True(Players.OwnsPlay(Owner, new ReplayPlayer("Cat", null, null)));
        Assert.False(Players.OwnsPlay(Owner, new ReplayPlayer("Cat", null, null), writtenLater: true));
        Assert.False(Players.CertainlySomeoneElse(Owner, new ReplayPlayer("Cat", null, null)));
        // Just set while tracking: yours, unless a lazer id says otherwise.
        Assert.True(Players.OwnsPlay(Owner, Submitted("NewName"), justSet: true));
        Assert.False(Players.OwnsPlay(Owner, Submitted("NewName", 1), justSet: true));
        foreach (var source in new[] { "signed-in", "tracked-plays", "unknown" })
        {
            Assert.False(Players.CertainlySomeoneElse(new PlayerIdentity(null, ["tangy"], "Tangy", false, source), Submitted("mrekk")));
        }
    }

    [Fact]
    public void Set_just_now_and_written_later_are_measured_from_the_play()
    {
        Assert.True(Players.SetJustNow(1_000_000, 1_000_000 + 60_000));
        Assert.False(Players.SetJustNow(1_000_000, 1_000_000 + Players.JustSetMs + 1));
        Assert.False(Players.SetJustNow(1_000_000 + 120_000, 1_000_000));
        var play = Replay(playedAt: 0);
        Assert.False(Players.WasWrittenLater(play, null));
        Assert.True(Players.WasWrittenLater(play, Players.WrittenAsPlayedMs + 1));
        Assert.False(Players.WasWrittenLater(play with { Built = new BuiltFacts("link", true) }, Players.WrittenAsPlayedMs + 1));
    }

    [Fact]
    public void The_score_id_is_read_from_wherever_the_replay_keeps_it()
    {
        Assert.Equal(55, Players.ReplayPlayer(Replay(onlineScoreId: 0, extras: """{"online_id":55,"user_id":7}""")).OnlineId);
        Assert.Equal(7, Players.ReplayPlayer(Replay(extras: """{"user_id":7}""")).UserId);
        Assert.Equal(1234, Players.ReplayPlayer(Replay(onlineScoreId: 1234)).OnlineId);
        Assert.Null(Players.ReplayPlayer(Replay(onlineScoreId: 0)).OnlineId);
    }

    /// <summary>An install whose own config says who is signed in, as each client writes it.</summary>
    private OsuInstall SignedIn(string kind, string? username)
    {
        var dir = Path.Combine(h.Folder, $"cfg-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        if (username is not null)
        {
            if (kind == "lazer") File.WriteAllText(Path.Combine(dir, "game.ini"), $"Username = {username}\r\nSavePassword = True\r\n");
            else File.WriteAllText(Path.Combine(dir, "osu!.someone.cfg"), $"BeatmapDirectory = Songs\r\nUsername = {username}\r\n");
        }
        return new OsuInstall(kind, dir, Path.Combine(dir, "files"), [], null);
    }

    [Fact]
    public void Whoever_either_client_says_is_signed_in_owns_the_profile()
    {
        foreach (var install in new[] { SignedIn("stable", "Tangy"), SignedIn("lazer", "Tangy") })
        {
            var identity = Players.Resolve(h.Db, h.ProfileId, [install]);
            Assert.Equal("signed-in", identity.Source);
            Assert.Equal(["tangy"], identity.Names);
        }
        Assert.Equal("unknown", Players.Resolve(h.Db, h.ProfileId, [SignedIn("lazer", null)]).Source);
        // A byte-order mark before the key is space to JavaScript's \s.
        var bom = SignedIn("lazer", null);
        File.WriteAllText(Path.Combine(bom.Root, "game.ini"), "Username = Tangy\r\n", new UTF8Encoding(true));
        Assert.Equal([new LocalSession("lazer", "Tangy")], Session.DetectLocalSessions([bom]));
    }

    [Fact]
    public void A_linked_account_counts_only_when_it_is_the_one_signed_in()
    {
        SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { linkedUserId = 7562902, linkedUsername = "mrekk", linkedPreviousNames = Array.Empty<string>(), linkedNamesKnown = true }));
        var other = Players.Resolve(h.Db, h.ProfileId, [SignedIn("lazer", "Remyria")]);
        Assert.Equal("signed-in", other.Source);
        Assert.Null(other.UserId);

        SettingsStore.Update(h.Db, h.ProfileId, JsonText.From(new { linkedUserId = 3119700, linkedUsername = "Tangy", linkedPreviousNames = new[] { "blizzardshiver", "A wild Tangy" }, linkedNamesKnown = true }));
        Assert.NotEqual("linked", Players.Resolve(h.Db, h.ProfileId, []).Source);
        var linked = Players.Resolve(h.Db, h.ProfileId, [SignedIn("lazer", "Tangy")]);
        Assert.Equal(("linked", 3119700.0, "Tangy", true), (linked.Source, linked.UserId!.Value, linked.DisplayName, linked.NamesComplete));
        Assert.Equal(["a wild tangy", "blizzardshiver", "tangy"], linked.Names.Order());
        // A second account on the other client: the id no longer settles plays.
        Assert.Null(Players.Resolve(h.Db, h.ProfileId, [SignedIn("lazer", "Tangy"), SignedIn("stable", "TangyAlt")]).UserId);
    }

    [Fact]
    public void With_nobody_signed_in_the_plays_already_tracked_say_who_owns_the_profile()
    {
        void Insert(string key, string name, long? id) => h.Db.Run("""
            INSERT INTO scores (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json,
              mods_label, count300, count100, count50, count_geki, count_katu, count_miss, accuracy,
              max_combo, total_score, passed, grade, ranked, played_at, player_name, player_id)
            VALUES (?,?,0,'x','stable','[]','None',0,0,0,0,0,0,1,0,0,1,'S',1,0,?,?)
            """, h.ProfileId, key, name, id);
        Assert.Equal("unknown", Players.Resolve(h.Db, h.ProfileId, []).Source);
        for (var i = 0; i < 20; i++) Insert($"own-{i}", "Tangy", 3119700);
        Insert("other-1", "mrekk", null);
        var identity = Players.Resolve(h.Db, h.ProfileId, []);
        Assert.Equal(("tracked-plays", 3119700.0), (identity.Source, identity.UserId!.Value));
        for (var i = 0; i < 20; i++) Insert($"other-{i + 2}", "mrekk", null);
        Assert.Null(Players.DominantTrackedName(h.Db, h.ProfileId));
    }

    /* ---------------------------------------------------------------- filter */

    private static BeatmapText Map(string title = "Dreamin Attraction!!", string titleUnicode = "", string artist = "Yooh",
        string difficulty = "Extra", string setOwner = "Sotarks", string source = "", string tags = "", List<string>? mappers = null) =>
        new(title, titleUnicode, artist, "", difficulty, setOwner, source, tags, mappers);

    private static RuleCondition Cond(string field, string test, params string[] values) =>
        new() { Field = field, Test = test, Values = [.. values.Select(Js.ToLower)] };

    private static List<BeatmapRule> Rules(params RuleCondition[][] each) => [.. each.Select(c => new BeatmapRule { Conditions = [.. c] })];

    private static readonly PlayFacts Everything = new(0, "stable", [], 5, 120, Status.Ranked, Map(), true,
        1704067200000, 1577836800000, 1590969600000);

    [Fact]
    public void Each_rule_field_reads_its_own_part_of_the_beatmap()
    {
        var b = Map(title: "Yoru ni Kakeru", titleUnicode: "夜に駆ける", source: "Touhou", tags: "anime blue_dragon");
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("title", "contains", "kakeru")]), b));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("title", "is", "夜に駆ける")]), b));
        Assert.False(TrackingFilter.RulesMatch(Rules([Cond("artist", "contains", "kakeru")]), b));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("setOwner", "is", "SOTARKS")]), b));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("tags", "is", "blue dragon")]), b));
        Assert.False(TrackingFilter.RulesMatch(Rules([Cond("tags", "is", "blue")]), b));
        Assert.False(TrackingFilter.RulesMatch(Rules([Cond("difficulty", "notContains", "easy", "extra")]), b));

        var f = new TrackingFilter { Enabled = true, Rules = Rules([Cond("title", "is", "Happy"), Cond("artist", "contains", "Justin Bieber")], [Cond("mapper", "is", "Blue Dragon")]) };
        Assert.Null(f.Rejects(Everything with { Beatmap = Map(title: "Happy", artist: "Justin Bieber") }));
        Assert.Equal("beatmap rules", f.Rejects(Everything with { Beatmap = Map(title: "Happy", artist: "Pharrell Williams") }));
        Assert.Null(f.Rejects(Everything with { Beatmap = Map(mappers: ["Blue Dragon"]) }));
        Assert.Null(f.Rejects(Everything with { Beatmap = null }));
    }

    [Fact]
    public void Without_osus_record_Mapper_is_the_owner_or_a_whole_name_written_into_the_map()
    {
        var theirNames = Rules([Cond("mapper", "is", "Blue Dragon", "Mismagius", "Froslass")]);
        Assert.True(TrackingFilter.RulesMatch(theirNames, Map(setOwner: "Froslass")));
        Assert.True(TrackingFilter.RulesMatch(theirNames, Map(setOwner: "Leader", difficulty: "Mismagius' Hard")));
        Assert.True(TrackingFilter.RulesMatch(theirNames, Map(setOwner: "Nhawak", difficulty: "Ultra", tags: "featured mismagius")));
        Assert.False(TrackingFilter.RulesMatch(theirNames, Map(setOwner: "Leader", difficulty: "Mismagiusfan's Hard")));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("mapper", "contains", "mismagius")]), Map(setOwner: "Leader", difficulty: "Mismagiusfan's Hard")));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("mapper", "is", "Blue Dragon")]), Map(tags: "blue dragon")));
        // Letters of any script are word characters: an astral one too.
        Assert.False(TrackingFilter.RulesMatch(Rules([Cond("mapper", "is", "abc")]), Map(setOwner: "x", difficulty: "abc𝐀")));
        Assert.True(TrackingFilter.RulesMatch(Rules([Cond("mapper", "is", "abc")]), Map(setOwner: "x", difficulty: "abc😀")));
    }

    [Fact]
    public void Mods_stars_and_length_are_judged_only_where_there_is_something_to_judge()
    {
        var onlyNomod = new TrackingFilter { Enabled = true, NoMod = "required" };
        Assert.Null(onlyNomod.Rejects(Everything with { Mods = [Mods.Of("SV2")] }));
        Assert.Equal("mods", onlyNomod.Rejects(Everything with { Mods = [Mods.Of("HD"), Mods.Of("SV2")] }));
        var dt = new TrackingFilter { Enabled = true, Mods = new() { ["DT"] = "required" }, NoMod = "excluded" };
        Assert.Null(dt.Rejects(Everything with { Mods = [Mods.With("DT", new Dictionary<string, object> { ["speed_change"] = 1.35 })] }));
        Assert.Null(dt.Rejects(Everything with { Mods = null }));

        var upTo = new TrackingFilter { Enabled = true, Stars = new NumberRange { Min = 0, Max = 6.9 } };
        Assert.Null(upTo.Rejects(Everything with { Stars = 6.900000123 }));
        Assert.Equal("star rating", upTo.Rejects(Everything with { Stars = 6.905 }));
        Assert.Null(upTo.Rejects(Everything with { Stars = null }));

        var threeMinutes = new TrackingFilter { Enabled = true, Length = new NumberRange { Min = 0, Max = 180 } };
        var beatmap = new BeatmapFilterFacts(Status.Ranked, null, 240_000, null, null, null);
        Assert.Equal("length", threeMinutes.Rejects(TrackingFilter.PlayFactsOf(beatmap, 0, [], "stable")));
        Assert.Null(threeMinutes.Rejects(TrackingFilter.PlayFactsOf(beatmap, 0, [Mods.Of("DT")], "stable")));
        Assert.Equal("length", threeMinutes.Rejects(TrackingFilter.PlayFactsOf(beatmap, 0, null, "lazer")));
    }

    [Fact]
    public void Modes_clients_categories_and_dates()
    {
        Assert.Null(TrackingFilter.Default().Rejects(Everything with { Mode = 3 }));
        Assert.Equal("mode", new TrackingFilter { Enabled = true, Modes = [1] }.Rejects(Everything));
        Assert.Equal("client", new TrackingFilter { Enabled = true, Clients = ["lazer"] }.Rejects(Everything));
        Assert.Equal("category", new TrackingFilter { Enabled = true, Categories = ["loved"] }.Rejects(Everything));
        var since2021 = new TrackingFilter { Enabled = true, Submitted = new UnknownableDateRange { From = 1609459200000 } };
        Assert.Equal("date submitted", since2021.Rejects(Everything));
        Assert.Null(since2021.Rejects(Everything with { SubmittedAt = null }));
        since2021.Submitted.IncludeUnknown = false;
        Assert.Equal("date submitted", since2021.Rejects(Everything with { SubmittedAt = null }));
        // A stage without dates says nothing about them.
        Assert.Null(since2021.Rejects(new PlayFacts(Stars: 5)));
    }

    /* ---------------------------------------------------------------- ingest */

    /// <summary>A stable replay as osu!stable writes one, frames left out: the parser never reads them.</summary>
    private string WriteReplay(string name, string player, long playedAt, long onlineId = 0, int mode = 0)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        void Text(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            w.Write((byte)0x0b);
            w.Write7BitEncodedInt(bytes.Length);
            w.Write(bytes);
        }
        w.Write((byte)mode);
        w.Write(20230504);
        Text(new string('b', 32));
        Text(player);
        Text(Convert.ToHexStringLower(System.Security.Cryptography.MD5.HashData(Encoding.UTF8.GetBytes(name))));
        foreach (short count in new short[] { 100, 0, 0, 0, 0, 0 }) w.Write(count);
        w.Write(1_000_000);
        w.Write((short)100);
        w.Write((byte)1);
        w.Write(0);
        Text("");
        w.Write(playedAt * 10_000 + 621355968000000000);
        w.Write(0);
        w.Write(onlineId);
        var file = Path.Combine(h.Folder, name);
        File.WriteAllBytes(file, ms.ToArray());
        return file;
    }

    private IngestContext Context(TrackingFilter? filter = null, PlayerIdentity? identity = null, string? declines = null) =>
        new(h.Db, new BeatmapResolver(h.Db, []), h.ProfileId, 0, null, filter, identity, declines);

    private long Count(string table) => Convert.ToInt64(h.Db.Scalar($"SELECT COUNT(*) FROM {table}"));

    [Fact]
    public async Task A_replay_is_added_once_and_a_deleted_one_stays_out()
    {
        var file = WriteReplay("mine.osr", "Tangy", 1735689600000);
        var added = await Ingest.ReplayFile(file, Context());
        Assert.Equal("added", added.Status);
        Assert.Equal(("None", "X", 1.0, null, false), (added.Score!.ModsLabel, added.Score.Grade, added.Score.Accuracy, added.Score.Pp, added.Score.Ranked));
        var row = h.Db.FirstRow("SELECT * FROM scores")!;
        Assert.Equal(("Tangy", -3L, "[]", 0L), (row.Str("player_name"), (long)row.Num("map_status")!, row.Str("mods_json"), (long)row.Num("mods_countable")! - 1));
        Assert.Equal("duplicate", (await Ingest.ReplayFile(file, Context())).Reason);

        h.Db.Run("DELETE FROM scores");
        h.Db.Run("INSERT INTO deleted_scores (profile_id, dedupe_key, deleted_at) VALUES (?, ?, 0)", h.ProfileId, row.Str("dedupe_key"));
        Assert.Equal("deleted", (await Ingest.ReplayFile(file, Context())).Reason);
        Assert.Equal("too-old", (await Ingest.ReplayFile(WriteReplay("old.osr", "Tangy", -5), Context() with { TrackingSince = 0 })).Reason);
    }

    [Fact]
    public async Task A_play_turned_away_is_listed_once_and_tracked_later_leaves_the_list()
    {
        var taikoOnly = new TrackingFilter { Enabled = true, Modes = [1] };
        var file = WriteReplay("mine.osr", "Tangy", 1735689600000);
        var filtered = await Ingest.ReplayFile(file, Context(taikoOnly, declines: "live"));
        Assert.Equal(("filtered", "mode"), (filtered.Status, filtered.Criterion));
        Assert.Equal(0, Count("scores"));
        await Ingest.ReplayFile(file, Context(taikoOnly, declines: "import"));
        var listed = Assert.Single(Tracker.Declined.List(h.Db, h.ProfileId));
        Assert.Equal(("filtered", "mode", "import", "score"), (listed.Reason, listed.Criterion, listed.Source, listed.Kind));
        Assert.Equal("bbbbbbbbbbbb", listed.Title);

        // Without declines, a re-ingest records nothing.
        await Ingest.ReplayFile(WriteReplay("other.osr", "Tangy", 1735689601000), Context(taikoOnly));
        Assert.Single(Tracker.Declined.List(h.Db, h.ProfileId));

        // Tracked after all: no longer listed.
        Assert.Equal("added", (await Ingest.ReplayFile(file, Context())).Status);
        Assert.Empty(Tracker.Declined.List(h.Db, h.ProfileId));
    }

    [Fact]
    public async Task Someone_elses_replay_is_never_tracked_and_says_whose_it_was()
    {
        var watched = WriteReplay("mrekk.osr", "mrekk", 1735689600000, onlineId: 900_000_001);
        var outcome = await Ingest.ReplayFile(watched, Context(identity: Owner, declines: "import"));
        Assert.Equal(("skipped", "another-player", "mrekk"), (outcome.Status, outcome.Reason, outcome.Player));
        Assert.Equal("mrekk", Assert.Single(Tracker.Declined.List(h.Db, h.ProfileId)).Player);
        // Never submitted and written as it was played: set here, whatever name it carries.
        Assert.Equal("added", (await Ingest.ReplayFile(WriteReplay("cat.osr", "Cat", Js.Now()), Context(identity: Owner))).Status);
        // The same, copied in long after its play: judged by its name.
        Assert.Equal("another-player", (await Ingest.ReplayFile(WriteReplay("old-cat.osr", "Cat", 1735689600000), Context(identity: Owner))).Reason);
        // An unreadable file is declined by its path.
        var junk = Path.Combine(h.Folder, "junk.osr");
        File.WriteAllBytes(junk, [0, 1, 2]);
        Assert.Equal("unparseable", (await Ingest.ReplayFile(junk, Context(declines: "import"))).Reason);
        Assert.Contains(Tracker.Declined.List(h.Db, h.ProfileId), d => d.FileName == "junk.osr");
    }

    [Fact]
    public async Task The_declined_list_keeps_the_newest_plays_and_deletes_for_good()
    {
        var other = h.Db.GetOrCreateProfile("Someone Else");
        Decline Play(int n) => new("score", $"play-{n}", "another-player", null, "mrekk", "import", $"Play {n}", null, 0, n, null, null);
        Tracker.Declined.Record(h.Db, other, Play(0), 0);
        for (var n = 1; n <= Tracker.Declined.MaxDeclines + 5; n++) Tracker.Declined.Record(h.Db, h.ProfileId, Play(n), n);
        var kept = Tracker.Declined.List(h.Db, h.ProfileId);
        Assert.Equal(Tracker.Declined.MaxDeclines, kept.Count);
        Assert.Equal($"Play {Tracker.Declined.MaxDeclines + 5}", kept[0].Title);
        Assert.Single(Tracker.Declined.List(h.Db, other));

        Assert.Equal(1, Tracker.Declined.Delete(h.Db, h.ProfileId, [kept[0].Id]));
        Assert.Throws<InvalidOperationException>(() => Tracker.Declined.Delete(h.Db, h.ProfileId, [kept[0].Id]));
        Tracker.Declined.Record(h.Db, h.ProfileId, Play(Tracker.Declined.MaxDeclines + 5));
        Assert.Equal(Tracker.Declined.MaxDeclines - 1, Tracker.Declined.List(h.Db, h.ProfileId).Count);
        await Task.CompletedTask;
    }
}
