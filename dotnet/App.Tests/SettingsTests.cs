using System.Text.Json;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tests;

/// <summary>test/settings.test.ts, against the C# port.</summary>
public class SettingsTests
{
    /// <summary>A patch as the page would post it.</summary>
    internal static JsonElement Patch(params (string Key, object? Value)[] entries) =>
        JsonText.From(entries.ToDictionary(e => e.Key, e => e.Value));

    private static string Json(object value) => JsonText.Stringify(value);

    [Fact]
    public void A_profile_with_nothing_stored_reads_back_the_defaults()
    {
        using var h = new TempDb();
        Assert.Equal(Json(SettingsStore.Defaults()), Json(SettingsStore.Get(h.Db, h.ProfileId)));
    }

    [Fact]
    public void Values_round_trip()
    {
        using var h = new TempDb();
        var saved = SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", "us"), ("tagline", "  left hand  ")));
        Assert.Equal("US", saved.Country);
        Assert.Equal("left hand", saved.Tagline);
        Assert.Equal(Json(saved), Json(SettingsStore.Get(h.Db, h.ProfileId)));
    }

    [Fact]
    public void A_patch_only_touches_the_keys_it_names()
    {
        using var h = new TempDb();
        SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", "GB"), ("tagline", "mouse only")));
        var after = SettingsStore.Update(h.Db, h.ProfileId, Patch(("tagline", "tablet")));
        Assert.Equal("GB", after.Country);
        Assert.Equal("tablet", after.Tagline);
    }

    [Fact]
    public void Unknown_keys_are_ignored_rather_than_stored()
    {
        using var h = new TempDb();
        var after = SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", "JP"), ("nonsense", 42)));
        Assert.Equal("JP", after.Country);
        Assert.DoesNotContain("nonsense", Json(after));
        var keys = h.Db.All("SELECT key FROM profile_settings WHERE profile_id = ?", r => r.GetString(0), h.ProfileId);
        Assert.Equal(["country"], keys);
    }

    [Fact]
    public void A_country_that_is_not_a_two_letter_code_is_rejected_not_stored_as_is()
    {
        using var h = new TempDb();
        foreach (var bad in new object?[] { "USA", "u", "", "12", "  ", null, 7 })
        {
            Assert.Equal("", SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", bad))).Country);
        }
    }

    /// <summary>JavaScript upper-cases "ß" to "SS", which is two letters; .NET leaves it alone.</summary>
    [Fact]
    public void A_country_is_upper_cased_as_JavaScript_does()
    {
        using var h = new TempDb();
        Assert.Equal("SS", SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", ((char)0xDF).ToString()))).Country);
        Assert.Equal("FI", SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", ((char)0xFB01).ToString()))).Country);
    }

    [Fact]
    public void Text_is_flattened_to_one_line_and_truncated()
    {
        using var h = new TempDb();
        var saved = SettingsStore.Update(h.Db, h.ProfileId, Patch(("tagline", "left\nhand" + new string('x', 200))));
        Assert.DoesNotContain("\n", saved.Tagline);
        Assert.Equal(120, saved.Tagline.Length);
        Assert.StartsWith("left hand", saved.Tagline);
    }

    [Fact]
    public void Settings_are_per_profile_not_shared()
    {
        using var h = new TempDb();
        var second = Profiles.Create(h.Db, "Left hand");
        SettingsStore.Update(h.Db, h.ProfileId, Patch(("tagline", "tablet")));
        SettingsStore.Update(h.Db, second.Id, Patch(("tagline", "mouse")));
        Assert.Equal("tablet", SettingsStore.Get(h.Db, h.ProfileId).Tagline);
        Assert.Equal("mouse", SettingsStore.Get(h.Db, second.Id).Tagline);
    }

    [Fact]
    public void Config_fallbacks_apply_until_the_profile_stores_its_own_value()
    {
        using var h = new TempDb();
        var fallbacks = new Dictionary<string, JsonElement>
        {
            ["country"] = JsonText.From("AU"),
            ["tagline"] = JsonText.From("from config"),
        };
        Assert.Equal("AU", SettingsStore.Get(h.Db, h.ProfileId, fallbacks).Country);

        SettingsStore.Update(h.Db, h.ProfileId, Patch(("country", "")), fallbacks);
        Assert.Equal("", SettingsStore.Get(h.Db, h.ProfileId, fallbacks).Country);
        // The key that was never touched still falls back.
        Assert.Equal("from config", SettingsStore.Get(h.Db, h.ProfileId, fallbacks).Tagline);
    }

    [Fact]
    public void Deleting_a_profile_takes_its_settings_with_it()
    {
        using var h = new TempDb();
        var second = Profiles.Create(h.Db, "Left hand");
        SettingsStore.Update(h.Db, second.Id, Patch(("tagline", "mouse")));
        Profiles.Delete(h.Db, second.Id);
        Assert.Equal(0L, h.Db.Scalar("SELECT COUNT(*) AS n FROM profile_settings WHERE profile_id = ?", second.Id));
    }

    [Fact]
    public void A_corrupt_stored_value_falls_back_to_the_default_instead_of_throwing()
    {
        using var h = new TempDb();
        h.Db.Run("INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)", h.ProfileId, "tagline", "not json");
        Assert.Equal("", SettingsStore.Get(h.Db, h.ProfileId).Tagline);
    }

    [Fact]
    public void The_description_keeps_paragraphs_but_not_stray_control_characters()
    {
        using var h = new TempDb();
        var saved = SettingsStore.Update(h.Db, h.ProfileId, Patch(("aboutMe", "Left hand.\r\n\nGoing\tslowly."))).AboutMe;
        Assert.Equal("Left hand.\n\nGoing slowly.", saved);
    }

    [Fact]
    public void Runs_of_blank_lines_collapse_so_pasted_text_cannot_stretch_the_page()
    {
        using var h = new TempDb();
        var saved = SettingsStore.Update(h.Db, h.ProfileId, Patch(("aboutMe", "a" + new string('\n', 9) + "b"))).AboutMe;
        Assert.Equal("a\n\nb", saved);
    }

    [Fact]
    public void The_description_is_capped()
    {
        using var h = new TempDb();
        var saved = SettingsStore.Update(h.Db, h.ProfileId, Patch(("aboutMe", new string('x', 70000)))).AboutMe;
        Assert.Equal(60000, saved.Length);
    }

    [Fact]
    public void Markup_typed_into_the_description_is_stored_as_the_text_it_is()
    {
        using var h = new TempDb();
        const string hostile = "<script>alert(1)</script> & <b>bold</b>";
        Assert.Equal(hostile, SettingsStore.Update(h.Db, h.ProfileId, Patch(("aboutMe", hostile))).AboutMe);
        Assert.Equal(hostile, SettingsStore.Get(h.Db, h.ProfileId).AboutMe);
        // Stored as JSON.stringify writes it: not escaped for HTML.
        Assert.Equal(JsonText.Stringify(hostile),
            h.Db.Scalar("SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'aboutMe'", h.ProfileId));
        Assert.Contains("<script>", (string)h.Db.Scalar("SELECT value FROM profile_settings WHERE key = 'aboutMe'")!);
    }

    [Fact]
    public void The_stable_note_is_offered_until_a_profile_turns_it_off()
    {
        using var h = new TempDb();
        Assert.True(SettingsStore.Get(h.Db, h.ProfileId).ShowStableNote);
        Assert.False(SettingsStore.Update(h.Db, h.ProfileId, Patch(("showStableNote", false))).ShowStableNote);
        Assert.False(SettingsStore.Get(h.Db, h.ProfileId).ShowStableNote);
    }

    [Fact]
    public void A_new_profile_counts_every_unranked_mod_and_beatmap_status_by_default()
    {
        using var h = new TempDb();
        var settings = SettingsStore.Get(h.Db, h.ProfileId);
        Assert.True(settings.IncludeUnrankedMods);
        Assert.Equal(["graveyard", "loved", "pending", "qualified", "unsubmitted", "wip"], settings.IncludeUnrankedMaps.Order(StringComparer.Ordinal));
        Assert.True(settings.ShowCountingNote);
        // Only real states are kept, never a name every JavaScript object inherits.
        Assert.Equal(["loved"], SettingsStore.Update(h.Db, h.ProfileId,
            Patch(("includeUnrankedMaps", new[] { "constructor", "loved", "toString" }))).IncludeUnrankedMaps);
    }

    [Fact]
    public void A_profile_from_before_those_defaults_keeps_counting_what_it_counted()
    {
        using var h = new TempDb("Never opened Other settings");
        var untouched = h.ProfileId;
        var chose = h.Db.GetOrCreateProfile("Turned unranked mods on");
        SettingsStore.Update(h.Db, chose, Patch(("includeUnrankedMods", true)));
        h.Db.Run("DELETE FROM kv WHERE key = 'countingDefaultsPinned'");

        var db = h.Reopen();
        Assert.False(SettingsStore.Get(db, untouched).IncludeUnrankedMods);
        Assert.Empty(SettingsStore.Get(db, untouched).IncludeUnrankedMaps);
        Assert.True(SettingsStore.Get(db, chose).IncludeUnrankedMods);
        Assert.Empty(SettingsStore.Get(db, chose).IncludeUnrankedMaps);

        var fresh = db.GetOrCreateProfile("Made after the update");
        db = h.Reopen();
        Assert.True(SettingsStore.Get(db, fresh).IncludeUnrankedMods);
        Assert.Equal(6, SettingsStore.Get(db, fresh).IncludeUnrankedMaps.Count);
    }

    [Fact]
    public void Relax_is_priced_as_osu_prices_it_by_default_and_older_profiles_keep_their_pricing()
    {
        using var h = new TempDb("Never chose");
        var untouched = h.ProfileId;
        var chose = h.Db.GetOrCreateProfile("Chose osu! pricing");
        SettingsStore.Update(h.Db, chose, Patch(("unrankedModPp", "as-played")));
        h.Db.Run("DELETE FROM kv WHERE key = 'relaxPricingPinned'");
        h.Db.Run("DELETE FROM profile_settings WHERE profile_id = ? AND key = 'unrankedModPp'", untouched);

        var db = h.Reopen();
        Assert.Equal("without-the-mod", SettingsStore.Get(db, untouched).UnrankedModPp);
        Assert.Equal("as-played", SettingsStore.Get(db, chose).UnrankedModPp);

        var fresh = db.GetOrCreateProfile("Made after the update");
        db = h.Reopen();
        Assert.Equal("as-played", SettingsStore.Get(db, fresh).UnrankedModPp);
    }

    [Fact]
    public void Show_more_adds_a_whole_number_of_rows_or_the_whole_list()
    {
        using var h = new TempDb();
        Assert.Equal(25, SettingsStore.Get(h.Db, h.ProfileId).ShowMoreRows);
        Assert.False(SettingsStore.Get(h.Db, h.ProfileId).ShowMoreAll);
        var cases = new (object? Raw, int Want)[]
        {
            (100, 100), ("50", 50), (7.9, 7), (0, 25), (-5, 25), ("", 25), ("lots", 25), (null, 25),
            (SettingsStore.MaxPageRows * 10, SettingsStore.MaxPageRows),
            // Number() as JavaScript reads it.
            (" 0x10 ", 16), (new[] { 12 }, 12), (true, 25),
        };
        foreach (var (raw, want) in cases)
        {
            Assert.Equal(want, SettingsStore.Update(h.Db, h.ProfileId, Patch(("showMoreRows", raw))).ShowMoreRows);
        }
        var all = SettingsStore.Update(h.Db, h.ProfileId, Patch(("showMoreRows", 40), ("showMoreAll", true)));
        Assert.True(all.ShowMoreAll);
        Assert.Equal(40, all.ShowMoreRows);
    }

    [Fact]
    public void Every_section_shows_until_a_profile_hides_it_and_only_section_ids_are_kept()
    {
        using var h = new TempDb();
        Assert.Empty(SettingsStore.Get(h.Db, h.ProfileId).HiddenSections);
        var hidden = SettingsStore.Update(h.Db, h.ProfileId,
            Patch(("hiddenSections", new object[] { "medals", "me", "medals", "Not An Id", 7, "<b>", "me\n" }))).HiddenSections;
        Assert.Equal(["medals", "me"], hidden);
        Assert.Equal(["medals", "me"], SettingsStore.Get(h.Db, h.ProfileId).HiddenSections);
        Assert.Empty(SettingsStore.Update(h.Db, h.ProfileId, Patch(("hiddenSections", "medals"))).HiddenSections);
    }

    [Fact]
    public void Own_names_come_from_a_list_or_the_box_as_typed_each_once_whatever_its_case()
    {
        using var h = new TempDb();
        Assert.Equal(["Tangy", "other"], SettingsStore.Update(h.Db, h.ProfileId, Patch(("ownNames", " Tangy, tangy ,other,"))).OwnNames);
        Assert.Equal(["a", "b"], SettingsStore.Update(h.Db, h.ProfileId, Patch(("ownNames", new object?[] { "a", null, "A", "b" }))).OwnNames);
    }

    [Fact]
    public void Linked_ids_are_whole_and_positive()
    {
        using var h = new TempDb();
        Assert.Equal(123L, SettingsStore.Update(h.Db, h.ProfileId, Patch(("linkedUserId", "123.9"))).LinkedUserId);
        Assert.Equal(0L, SettingsStore.Update(h.Db, h.ProfileId, Patch(("linkedUserId", -4))).LinkedUserId);
        Assert.Equal(0L, SettingsStore.Update(h.Db, h.ProfileId, Patch(("linkedUserId", "abc"))).LinkedUserId);
        // linkedNamesKnown is only ever set by the app, so only a real true counts.
        Assert.False(SettingsStore.Update(h.Db, h.ProfileId, Patch(("linkedNamesKnown", "true"))).LinkedNamesKnown);
        Assert.True(SettingsStore.Update(h.Db, h.ProfileId, Patch(("linkedNamesKnown", true))).LinkedNamesKnown);
    }

    [Fact]
    public void Settings_are_written_in_the_order_the_TypeScript_lists_them()
    {
        var keys = JsonText.From(SettingsStore.Defaults()).EnumerateObject().Select(p => p.Name);
        Assert.Equal(SettingsStore.Keys, keys);
    }
}
