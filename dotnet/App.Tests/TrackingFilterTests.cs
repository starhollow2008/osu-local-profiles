using System.Text.Json;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tests;

/// <summary>The coercion half of test/tracking-filter.test.ts. Matching plays comes with the tracker.</summary>
public class TrackingFilterTests
{
    private static TrackingFilter Coerce(object? raw) => TrackingFilter.Coerce(JsonText.From(raw));

    private static string Json(object? value) => JsonText.Stringify(value);

    /// <summary>A filter switched on, with one change from the default.</summary>
    private static TrackingFilter On(Action<TrackingFilter> change)
    {
        var filter = TrackingFilter.Default();
        filter.Enabled = true;
        change(filter);
        return filter;
    }

    private static object Rule(params (string Field, string Test, string[] Values)[] conditions) => new
    {
        conditions = conditions.Select(c => new { field = c.Field, test = c.Test, values = c.Values }).ToArray(),
    };

    [Fact]
    public void Off_by_default_and_off_narrows_nothing()
    {
        var filter = TrackingFilter.Default();
        Assert.False(filter.Enabled);
        Assert.False(TrackingFilter.Narrows(filter));
        // Switched on and untouched, still nothing.
        Assert.False(TrackingFilter.Narrows(On(_ => { })));
    }

    [Fact]
    public void Narrows_notices_each_criterion_on_its_own()
    {
        Assert.True(TrackingFilter.Narrows(On(f => f.Rules = [new BeatmapRule { Conditions = [new RuleCondition { Field = "mapper", Test = "is", Values = ["sotarks"] }] }])));
        Assert.True(TrackingFilter.Narrows(On(f => f.Modes = [0, 1, 2])));
        Assert.True(TrackingFilter.Narrows(On(f => f.Clients = ["lazer"])));
        Assert.True(TrackingFilter.Narrows(On(f => f.Stars = new NumberRange { Min = 5 })));
        Assert.True(TrackingFilter.Narrows(On(f => f.Stars = new NumberRange { Min = 0, Max = 7 })));
        Assert.True(TrackingFilter.Narrows(On(f => f.Length = new NumberRange { Min = 0, Max = 300 })));
        Assert.True(TrackingFilter.Narrows(On(f => f.Mods["HD"] = "required")));
        Assert.True(TrackingFilter.Narrows(On(f => f.NoMod = "excluded")));
        Assert.True(TrackingFilter.Narrows(On(f => f.Categories = ["ranked"])));
        Assert.True(TrackingFilter.Narrows(On(f => f.Added = new DateRange { From = 1 })));
        Assert.True(TrackingFilter.Narrows(On(f => f.Submitted = new UnknownableDateRange { IncludeUnknown = false })));
        // Rules that say nothing are dropped when cleaned, and narrow nothing.
        Assert.True(TrackingFilter.Narrows(Coerce(new { enabled = true, rules = new[] { new { conditions = new[] { new { values = new[] { " , " } } } } } })));
        Assert.False(TrackingFilter.Narrows(Coerce(new { enabled = true, rules = new object[] { new { conditions = Array.Empty<object>() }, new { } } })));
    }

    [Fact]
    public void An_old_keywords_filter_becomes_one_rule_matching_the_same_terms()
    {
        foreach (var keywords in new[] { "sotarks", "Blue Zenith, Sotarks", "dreamin attraction", "insane, zzz" })
        {
            var carried = Coerce(new { enabled = true, keywords });
            Assert.True(carried.FromKeywords, keywords);
            var expected = keywords.Split(',').Select(k => k.Trim()).Where(k => k.Length > 0).ToArray();
            Assert.Equal(Json(new[] { Rule(("any", "contains", expected)) }), Json(carried.Rules));
        }
        // Nothing to carry over is no rule at all, and nothing to announce.
        var empty = Coerce(new { enabled = true, keywords = " , " });
        Assert.Empty(empty.Rules);
        Assert.False(empty.FromKeywords);
        // Once saved as rules, the keywords are history.
        var saved = TrackingFilter.Coerce(JsonText.From(Coerce(new { keywords = "sotarks" })));
        Assert.False(saved.FromKeywords);
        Assert.Equal(Json(new[] { Rule(("any", "contains", ["sotarks"])) }), Json(saved.Rules));
    }

    [Fact]
    public void Rules_are_cleaned_unknown_fields_and_tests_fall_back_values_are_trimmed_and_bounded()
    {
        var cleaned = Coerce(new
        {
            rules = new object[]
            {
                new { conditions = new[] { new { field = "nonsense", test = "nonsense", values = new object[] { "  Sotarks ", "sotarks", "", 42 } } } },
                new { conditions = new[] { new { field = "mapper", test = "is", values = (object)"Blue Dragon, Mismagius" } } },
                "not a rule",
            },
        });
        Assert.Equal(Json(new[]
        {
            Rule(("any", "contains", ["Sotarks"])),
            Rule(("mapper", "is", ["Blue Dragon", "Mismagius"])),
        }), Json(cleaned.Rules));

        var many = Coerce(new
        {
            rules = Enumerable.Range(0, 50).Select(_ => new { conditions = Enumerable.Range(0, 50).Select(_ => new { values = new[] { "x" } }).ToArray() }).ToArray(),
        });
        Assert.Equal(20, many.Rules.Count);
        Assert.Equal(10, many.Rules[0].Conditions.Count);

        // The longest keywords box there could have been still carries over whole.
        var longest = string.Join(",", Enumerable.Range(0, 100).Select(i => (char)(65 + i % 26) + i.ToString()))[..200];
        Assert.Equal(longest, string.Join(",", Coerce(new { keywords = longest }).Rules[0].Conditions[0].Values));
    }

    [Fact]
    public void Anything_at_all_coerces_to_a_usable_filter()
    {
        var defaults = Json(TrackingFilter.Default());
        Assert.Equal(defaults, Json(Coerce(null)));
        Assert.Equal(defaults, Json(Coerce("nonsense")));
        Assert.Equal(defaults, Json(Coerce(new[] { 1, 2, 3 })));
    }

    [Fact]
    public void A_range_typed_back_to_front_is_read_as_the_range_it_describes()
    {
        var back = Coerce(new { stars = new { min = 6.9, max = 5.1 } });
        Assert.Equal(5.1, back.Stars.Min);
        Assert.Equal(6.9, back.Stars.Max);
    }

    [Fact]
    public void Values_out_of_range_are_held_to_it_rather_than_rejected()
    {
        var wild = Coerce(new { stars = new { min = -4, max = 900 }, length = new { min = 0, max = 99999 } });
        Assert.Equal(Json(new { min = 0, max = 15 }), Json(wild.Stars));
        Assert.Equal(Json(new { min = 0, max = 3600 }), Json(wild.Length));
    }

    [Fact]
    public void Star_ratings_round_to_hundredths_with_halves_going_up_as_Math_round_does()
    {
        // 2.345 * 100 is 234.50000000000003 in binary, so 2.35 in Node too; 0.125 is exact.
        Assert.Equal(2.35, Coerce(new { stars = new { min = 2.345 } }).Stars.Min);
        Assert.Equal(0.13, Coerce(new { stars = new { min = 0.125 } }).Stars.Min);
        Assert.Equal(3.0, Coerce(new { length = new { min = "2.5" } }).Length.Min);
    }

    [Fact]
    public void Only_the_mods_that_are_not_allowed_are_written_down()
    {
        var coerced = Coerce(new Dictionary<string, object>
        {
            ["mods"] = new Dictionary<string, string> { ["DT"] = "required", ["RX"] = "excluded", ["HD"] = "allowed", ["bad name"] = "required", ["QQ"] = "rubbish" },
        });
        Assert.Equal("""{"DT":"required","RX":"excluded"}""", Json(coerced.Mods));
    }

    [Fact]
    public void A_mod_written_twice_takes_its_last_state_as_JSON_parse_keeps_it()
    {
        JsonText.TryParse("""{"mods":{"HD":"required","HD":"allowed","DT":"allowed","DT":"excluded"}}""", out var raw);
        Assert.Equal("""{"DT":"excluded"}""", Json(TrackingFilter.Coerce(raw).Mods));
    }

    [Fact]
    public void An_empty_mode_list_is_kept_because_it_is_a_real_answer()
    {
        Assert.Empty(Coerce(new { modes = Array.Empty<int>() }).Modes);
        Assert.Equal([1], Coerce(new { modes = new object[] { 9, "x", 1, 1 } }).Modes);
        // Number() as JavaScript reads it: "" and false are 0, true is 1.
        Assert.Equal([0, 1], Coerce(new { modes = new object[] { "", true } }).Modes);
    }

    [Fact]
    public void A_filter_saved_before_the_client_criterion_tracks_every_client_and_an_empty_list_is_kept()
    {
        Assert.Equal(["stable", "lazer", "mcosu"], Coerce(new { enabled = true, modes = new[] { 0 } }).Clients);
        Assert.Empty(Coerce(new { clients = Array.Empty<string>() }).Clients);
        Assert.Equal(["lazer", "mcosu"], Coerce(new { clients = new[] { "mcosu", "web", "lazer", "lazer" } }).Clients);
    }

    [Fact]
    public void A_date_before_osu_existed_is_held_to_the_day_osus_listing_begins()
    {
        Assert.Equal(TrackingFilter.OsuEpoch, Coerce(new { added = new { from = 0, to = (object?)null } }).Added.From);
        Assert.Equal(TrackingFilter.OsuEpoch, (double)DateTimeOffset.Parse("2007-10-06T00:00:00Z").ToUnixTimeMilliseconds());
    }

    [Fact]
    public void Dates_may_be_sent_as_strings_which_is_what_a_date_field_posts()
    {
        var typed = Coerce(new { ranked = new { from = "2020-01-01T00:00:00.000Z", to = "" } });
        Assert.Equal(DateTimeOffset.Parse("2020-01-01T00:00:00Z").ToUnixTimeMilliseconds(), typed.Ranked.From);
        Assert.Null(typed.Ranked.To);
        Assert.True(typed.Ranked.IncludeUnknown);
        // A date alone is UTC midnight, as the spec reads ISO dates.
        Assert.Equal(DateTimeOffset.Parse("2021-06-01T00:00:00Z").ToUnixTimeMilliseconds(), Coerce(new { added = new { from = "2021-06-01" } }).Added.From);
    }

    [Fact]
    public void The_filter_round_trips_through_the_profile_settings_store()
    {
        using var h = new TempDb();
        Assert.Equal(Json(TrackingFilter.Default()), Json(SettingsStore.Get(h.Db, h.ProfileId).TrackingFilter));

        var saved = SettingsStore.Update(h.Db, h.ProfileId, SettingsTests.Patch(("trackingFilter", new
        {
            enabled = true,
            keywords = "sotarks",
            rules = new[] { Rule(("mapper", "is", ["Sotarks"])) },
            mods = new Dictionary<string, string> { ["HD"] = "required" },
            stars = new { min = 5, max = 7 },
        }))).TrackingFilter;
        Assert.True(saved.Enabled);
        // Rules win over keywords a script might still send, and are stored cleaned.
        Assert.Equal(Json(new[] { Rule(("mapper", "is", ["Sotarks"])) }), Json(saved.Rules));
        Assert.False(saved.FromKeywords);
        Assert.Equal("""{"HD":"required"}""", Json(saved.Mods));
        Assert.Equal(Json(new { min = 5, max = 7 }), Json(saved.Stars));
        Assert.Equal([0, 1, 2, 3], saved.Modes);
        Assert.True(saved.Submitted.IncludeUnknown);

        Assert.Equal(Json(saved), Json(SettingsStore.Get(h.Db, h.ProfileId).TrackingFilter));
        var second = h.Db.GetOrCreateProfile("Second");
        Assert.False(SettingsStore.Get(h.Db, second).TrackingFilter.Enabled);
    }

    [Fact]
    public void The_filter_is_written_in_the_TypeScript_shape()
    {
        Assert.Equal(
            """{"enabled":false,"rules":[],"fromKeywords":false,"modes":[0,1,2,3],"clients":["stable","lazer","mcosu"],"stars":{"min":0,"max":null},"length":{"min":0,"max":null},"mods":{},"noMod":"allowed","categories":["ranked","qualified","loved","pending","wip","graveyard","unsubmitted"],"added":{"from":null,"to":null},"submitted":{"from":null,"to":null,"includeUnknown":true},"ranked":{"from":null,"to":null,"includeUnknown":true}}""",
            Json(TrackingFilter.Default()));
    }
}
