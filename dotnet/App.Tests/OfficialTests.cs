using OsuLocalProfiles.Calc;

namespace OsuLocalProfiles.Tests;

/// <summary>
/// osu!'s calculators in-process (test/official.test.ts's questions that need no replay). That
/// the answers match the separate helper's is by construction, both being <c>Program.Respond</c>,
/// and scripts/pp-parity.mjs checks that method across a whole corpus.
/// </summary>
public class OfficialTests
{
    private static OfficialCalculator Calculator()
    {
        var (calculator, problem) = OfficialCalculator.Create();
        Assert.True(calculator is not null, problem);
        return calculator;
    }

    [Fact]
    public void The_calculator_loads_and_names_the_osu_release_it_comes_from()
    {
        Assert.Matches(@"^\d{4}\.\d+\.\d+", Calculator().Version);
    }

    [Fact]
    public async Task Osu_says_which_mods_it_ranks_for_each_ruleset()
    {
        var calculator = Calculator();
        var mod = (string acronym) => JsonText.From(new { acronym });
        Assert.Equal((true, Array.Empty<string>()), await calculator.Ranked(0, JsonText.From(new[] { mod("HD"), mod("DT") }), null));
        var relax = await calculator.Ranked(0, JsonText.From(new[] { mod("RX") }), null);
        Assert.False(relax!.Value.Ranked);
        Assert.Equal(["RX"], relax.Value.Unranked);
        // A changed speed unranks Double Time.
        Assert.False((await calculator.Ranked(0, JsonText.From(new[] { new { acronym = "DT", settings = new { speed_change = 1.3 } } }), null))!.Value.Ranked);
        // osu!stable's bitmask, through osu!'s own conversion: bit 7 is Relax.
        Assert.False((await calculator.Ranked(0, null, 128))!.Value.Ranked);
        Assert.True((await calculator.Ranked(0, null, 8))!.Value.Ranked);
    }

    [Fact]
    public async Task A_play_osu_cannot_read_has_no_pp_and_says_why()
    {
        var calculator = Calculator();
        Assert.Null(await calculator.Calculate("missing.osr", "missing.osu"));
        Assert.False(string.IsNullOrEmpty(calculator.LastError));
    }
}
