using System.Text.Json;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// Replays built from a score's numbers (test/score-entry.test.ts): byte for byte what the Node app
/// builds, lzma-js's compression of lazer's block included. The bytes were made by src/built-replays.ts.
/// </summary>
public class BuiltReplayTests
{
    private const string Base = """
        {"id":1716608692,"legacy_score_id":4430944113,"ruleset_id":0,"beatmap_id":2403946,"rank":"S","pp":378.504,
         "accuracy":0.993169,"max_combo":1298,"total_score":1051812,"legacy_total_score":40966260,"classic_total_score":32738070,
         "mods":[{"acronym":"HR"},{"acronym":"CL"}],"statistics":{"ok":10,"great":966},"maximum_statistics":{"great":976,"legacy_combo_increase":323},
         "ended_at":"2023-05-04T10:10:36Z","passed":true,"ranked":true,"legacy_perfect":true,
         "beatmap":{"id":2403946,"beatmapset_id":1140099,"checksum":"d4e23a5746b9a780f9faa10189521498","version":"Kowari's Confession","status":"ranked","difficulty_rating":5.76727},
         "beatmapset":{"id":1140099,"artist":"CHiCO with HoneyWorks","title":"Heart no Shuchou","creator":"Nathan"}}
        """;

    private static OsuWebScore Score(string json) => OsuWeb.ScoreFromJson(JsonDocument.Parse(json).RootElement.Clone())!;

    private static OsuWebScore Lazer() => Score(Base
        .Replace("\"legacy_score_id\":4430944113", "\"legacy_score_id\":null")
        .Replace("\"ruleset_id\":0", "\"ruleset_id\":3")
        .Replace("""[{"acronym":"HR"},{"acronym":"CL"}]""", """[{"acronym":"DT","settings":{"speed_change":1.35,"adjust_pitch":true}},{"acronym":"HD"}]""")
        .Replace("""{"ok":10,"great":966}""", """{"perfect":900,"great":50,"good":3,"ok":2,"meh":1,"miss":4}""")
        .Replace("""{"great":976,"legacy_combo_increase":323}""", """{"perfect":960}"""));

    [Fact]
    public void A_score_from_its_link_is_built_as_the_Node_app_builds_it()
    {
        Assert.Equal("00672735010b2064346532336135373436623961373830663966616131303138393532313439380b0554616e677900c6030a0000000000000000007418710212050110000000000036cbcd874cdb080000000071d71a08010000006f73752d6c6f63616c2d70726f66696c65733a6275696c74240000007b226f726967696e223a226c696e6b222c226c6567616379546f74616c223a747275657d",
            Convert.ToHexStringLower(BuiltReplays.Linked(Score(Base), new LinkedPlayer(3119700, "Tangy"))!));
        Assert.Equal("0391c3c9010b2064346532336135373436623961373830663966616131303138393532313439380b0554616e677900320002000100840303000400a40c100012050100000000000036cbcd874cdb0800000000b45e516600000000d40000005d000001000301000000000000003d8889e723f66c59f4260b7a52fba4822e132d68b71096e1c3f9d704e67e4ea1c3a35b9457bc6fd838bedc805eec549491f554f655b35b3ddb6d9522835e530d941d356ffcdc64a4e65260e9b5ab8eb300fc6bfd6080c62cf99481aa0bc5ed647ef8918a794ad0dbaf01feb2ca8927fb4a4bc2fc2814d8fd64255f0c4ad216805bf6aee329178c9da3a4d0b6ab647b1eae83625ca40a29e647e447c9ea239aab9a3f1e584bb49e4db6cf8bfccf61cbd5841424dc912a1d1927369f46cc2b7c7797fff96af60b6f73752d6c6f63616c2d70726f66696c65733a6275696c74250000007b226f726967696e223a226c696e6b222c226c6567616379546f74616c223a66616c73657d",
            Convert.ToHexStringLower(BuiltReplays.Linked(Lazer(), new LinkedPlayer(3119700, "Tangy"))!));
        Assert.Equal("0391c3c9010b2064346532336135373436623961373830663966616131303138393532313439380b0be697a5e69cac20f09f988000320002000100840303000400a40c100012050100000000000036cbcd874cdb0800000000b45e516600000000c80000005d00000100f100000000000000003d8889e723f66c59f4260b7a52fba4822e132d68b71096e1c3f9d704e67e4ea1c3a35b9457bc6fd838bedc805eec549491f554f655b35b3ddb6d9522835e530d941d356ffcdc64a4e65260e9b5ab8eb300fc6bfd6080c62cf99481aa0bc5ed647ef8918a794ad0dbaf01feb2ca8927fb4a4bc2fc2814d8fd64255f0c4ad216805bf6aee329178c9da3a4d0b6ab647b1eae83625ca40a29e647e447c9ea239aab9a3f1e584bb49e4db6cf8bfccf61cbd04f13eda98c6bfdf316626f73752d6c6f63616c2d70726f66696c65733a6275696c74250000007b226f726967696e223a226c696e6b222c226c6567616379546f74616c223a66616c73657d",
            Convert.ToHexStringLower(BuiltReplays.Linked(Lazer(), new LinkedPlayer(null, "日本 " + char.ConvertFromUtf32(0x1F600)))!));
    }

    [Fact]
    public void A_score_entered_by_hand_is_built_as_the_Node_app_builds_it()
    {
        Assert.Equal("01672735010b2064346532336135373436623961373830663966616131303138393532313439380b0554616e677900f40114000000000000000300000000009001004800000000b0c4f6e85ee5db080000000000000000000000006f73752d6c6f63616c2d70726f66696c65733a6275696c74270000007b226f726967696e223a226d616e75616c222c226c6567616379546f74616c223a66616c73657d",
            Convert.ToHexStringLower(BuiltReplays.Manual(1, "d4e23a5746b9a780f9faa10189521498", "Tangy", new LegacyCounts(500, 20, 0, 0, 0, 3), 400, 72, null, 1700000000123)));
        Assert.Equal("00672735010b2064346532336135373436623961373830663966616131303138393532313439380b0554616e677900f4011400010000000000030087d612009001000000000000b0c4f6e85ee5db080000000000000000000000006f73752d6c6f63616c2d70726f66696c65733a6275696c74260000007b226f726967696e223a226d616e75616c222c226c6567616379546f74616c223a747275657d",
            Convert.ToHexStringLower(BuiltReplays.Manual(0, "d4e23a5746b9a780f9faa10189521498", "Tangy", new LegacyCounts(500, 20, 1, 0, 0, 3), 400, 0, 1234567, 1700000000123)));
    }

    [Fact]
    public void What_was_built_reads_back_as_the_score_it_was_built_from()
    {
        var replay = Osr.Parse(BuiltReplays.Linked(Lazer(), new LinkedPlayer(3119700, "Tangy"))!);
        Assert.Equal("link", replay.Built!.Origin);
        Assert.Equal(1716608692, Js.NumberOf(Js.Get(replay.Extras, "online_id")!.Value));
        Assert.Equal("""{"perfect":900,"great":50,"good":3,"ok":2,"meh":1,"miss":4}""", JsonText.Stringify(Js.Get(replay.Extras, "statistics")));
        // A stable score whose mods have no stable bits cannot be built.
        Assert.Null(BuiltReplays.Linked(Score(Base.Replace("""{"acronym":"HR"}""", """{"acronym":"DA","settings":{"circle_size":3}}""")), new LinkedPlayer(null, "x")));
    }
}
