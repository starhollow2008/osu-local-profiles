using System.Text.Json;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Calc;

/// <summary>One medal as the page shows it, earned or locked.</summary>
internal sealed class Medal
{
    public string Slug { get; init; } = "";
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public string Icon { get; init; } = "";
    /// <summary><c>combo</c>, <c>plays</c>, <c>hits</c>, <c>pass</c>, <c>fc</c>, <c>rank</c> or <c>intro</c>.</summary>
    public string Family { get; init; } = "";
    public double Threshold { get; init; }
    public object? AchievedAt { get; set; }
    /// <summary>Whether <c>AchievedAt</c> is the real moment: false for rank medals, decided from the current total.</summary>
    public bool Dated { get; set; }
    public string? EarnedOn { get; set; }
    public string? EarnedOnOriginal { get; set; }
    public string Grouping { get; init; } = "";
    public bool FromOsu { get; set; }
}

internal sealed record MedalSummary(List<Medal> Medals, int Earned, int Total, int FcUnknown);

/// <summary>
/// The medals a profile has earned, derived from its scores every time and never stored:
/// src/calc/medals.ts. osu!'s own definitions (src/calc/medal-definitions.json, embedded) plus
/// Mod Introduction, and nothing else.
/// </summary>
internal static class Medals
{
    private sealed class Definition
    {
        public string Slug { get; init; } = "";
        public string Name { get; init; } = "";
        public string Description { get; init; } = "";
        public string Icon { get; init; } = "";
        public double Threshold { get; init; }
        public JsonElement Rule { get; init; }
    }

    private sealed class ModTypeLists
    {
        public string[] Conversion { get; init; } = [];
        public string[] Fun { get; init; } = [];
        public string[] IgnoredAlone { get; init; } = [];
        public string[] Reduction { get; init; } = [];
    }

    private sealed class Definitions
    {
        public Definition[] Rank { get; init; } = [];
        public Dictionary<string, Dictionary<string, Definition[]>> Modes { get; init; } = [];
        public Definition[] Intro { get; init; } = [];
        public Dictionary<string, ModTypeLists> ModTypes { get; init; } = [];
    }

    private static readonly Definitions Table = Load();

    private static Definitions Load()
    {
        using var stream = typeof(Medals).Assembly.GetManifestResourceStream("medal-definitions.json")
            ?? throw new InvalidOperationException("medal-definitions.json is not embedded");
        return JsonSerializer.Deserialize<Definitions>(stream, JsonText.Options)!;
    }

    private static readonly HashSet<string> AppMedals =
    [
        .. Table.Rank.Select(d => d.Slug),
        .. Table.Intro.Select(d => d.Slug),
        .. Table.Modes.Values.SelectMany(m => m.Values).SelectMany(list => list).Select(d => d.Slug),
    ];

    /// <summary>Every medal this app awards, in any mode: what an import from osu! may copy.</summary>
    public static bool IsAppMedal(string slug) => AppMedals.Contains(slug);

    /// <summary>
    /// Does this passed score earn this Mod Introduction medal? osu!'s rules: one mod and nothing
    /// else at its defaults (Classic and system mods aside), or for lazer only, any Conversion or
    /// any Fun mod.
    /// </summary>
    internal static bool EarnsIntroMedal(JsonElement rule, List<JsonElement> mods, double ruleset, string client)
    {
        if (!Table.ModTypes.TryGetValue(Js.NumberToString(ruleset), out var known)) return false;
        if (Js.IsString(Js.Get(rule, "type"), out var type))
        {
            var of = type == "Conversion" ? known.Conversion : known.Fun;
            return client == "lazer" && mods.Any(m => Mods.Acronym(m) is { } a && of.Contains(a));
        }
        if (Js.Get(rule, "ruleset") is { ValueKind: JsonValueKind.Number } only && Js.NumberOf(only) != ruleset) return false;
        var counted = mods.Where(m => !(Mods.Acronym(m) is { } a && known.IgnoredAlone.Contains(a))).ToList();
        return counted.Count == 1 && Js.IsString(Js.Get(rule, "mod"), out var mod) && Mods.Acronym(counted[0]) == mod
            && !Mods.IsCustomised(counted[0]);
    }

    /// <summary>
    /// May this play earn a star medal at all? No Difficulty Reduction or Automation mod; on
    /// mania no key mod or Dual Stages; not osu!taiko's exempt beatmap 19990.
    /// </summary>
    private static bool MayEarnStarMedal(List<JsonElement> mods, double ruleset, object? beatmapId)
    {
        var reduction = Table.ModTypes.TryGetValue(Js.NumberToString(ruleset), out var known) ? known.Reduction : [];
        if (mods.Any(m => Mods.Acronym(m) is { } a && reduction.Contains(a))) return false;
        if (ruleset == 3 && mods.Any(m => Mods.Acronym(m) is { } a && (a == "DS" || IsManiaKeyMod(a)))) return false;
        if (ruleset == 1 && beatmapId is long or double && Convert.ToDouble(beatmapId) == 19990) return false;
        return true;
    }

    /// <summary>Mania's key mods, 1K to 10K.</summary>
    private static bool IsManiaKeyMod(string acronym) =>
        acronym is "10K" || (acronym.Length == 2 && acronym[0] is >= '1' and <= '9' && acronym[1] == 'K');

    /// <summary>Counts toward pp, on a map that is not Qualified or Loved: osu! skips both for star medals.</summary>
    private static string StarMedalSql(Eligibility e) => $"""
        ({Eligibility.CountsSql(e)}
                   AND COALESCE(s.map_status, {Status.Ranked}) NOT IN ({Status.Qualified}, {Status.Loved}))
        """;

    /// <summary>The Mod Introduction medals, from every passed score in every mode, dated by the first.</summary>
    private static List<Medal> IntroMedals(Database db, long profileId)
    {
        var rows = db.Rows($"""
            SELECT s.played_at, s.mode, s.client, s.mods_json, {Metadata.NameColumns}
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.passed = 1 AND {Eligibility.VisibleSql()}
             ORDER BY s.played_at ASC
            """, profileId);

        var earned = new Dictionary<string, Row>();
        foreach (var row in rows)
        {
            if (earned.Count == Table.Intro.Length) break;
            if (Mods.Parse(row.Str("mods_json")) is not { } mods) continue;
            // A McOsu play is a stable one to osu!, which runs no lazer-only awarder on those.
            var client = Mods.ScoredAsStable(row.Str("client")) ? "stable" : "lazer";
            foreach (var definition in Table.Intro)
            {
                if (earned.ContainsKey(definition.Slug)) continue;
                if (EarnsIntroMedal(definition.Rule, mods, row.Num("mode") ?? double.NaN, client)) earned[definition.Slug] = row;
            }
        }

        return [.. Table.Intro.Select(definition =>
        {
            earned.TryGetValue(definition.Slug, out var row);
            return new Medal
            {
                Slug = definition.Slug,
                Name = definition.Name,
                Description = definition.Description,
                Icon = definition.Icon,
                Family = "intro",
                Threshold = 0,
                AchievedAt = row?["played_at"],
                Dated = true,
                EarnedOn = row is null ? null : Metadata.BeatmapNameOrNull(Metadata.Names(row)),
                EarnedOnOriginal = row is null ? null : Metadata.BeatmapNameOriginal(Metadata.Names(row)),
                Grouping = "Mod Introduction",
                FromOsu = false,
            };
        })];
    }

    /// <summary>
    /// A full combo: nothing missed, and the whole combo reached. Null when the map's maximum is
    /// unknown, so the caller reports that rather than guessing.
    /// </summary>
    private static bool? IsFullCombo(Row row)
    {
        if ((row.Num("miss") ?? 0) > 0) return false;
        if (row.Num("beatmap_max_combo") is not { } max || max <= 0) return null;
        return (row.Num("max_combo") ?? 0) >= max;
    }

    /// <summary>
    /// Every medal for one mode, in the order osu! groups them, from one chronological pass over
    /// the profile's scores.
    /// </summary>
    public static MedalSummary Compute(Database db, long profileId, double mode, Eligibility e)
    {
        var rows = db.Rows($"""
            SELECT s.played_at, s.beatmap_md5, s.max_combo, s.passed, s.count_miss AS miss,
                   s.beatmap_max_combo,
                   (s.count300 + s.count100 + s.count50 + s.count_geki + s.count_katu) AS hits,
                   {Eligibility.StarsColumn(e)} AS stars,
                   {Eligibility.PpColumn(e)} AS pp,
                   {Eligibility.CountsSql(e)} AS counts,
                   {StarMedalSql(e)} AS star_map, s.mods_json, s.beatmap_id,
                   {Metadata.NameColumns}
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
             ORDER BY s.played_at ASC
            """, profileId, mode);

        var family = Table.Modes.TryGetValue(Js.NumberToString(mode), out var f) ? f : [];
        Definition[] Of(string name) => family.TryGetValue(name, out var list) ? list : [];
        var medals = new List<Medal>();
        var fcUnknown = 0;

        var bestByMap = new Dictionary<string, double>();
        double playcount = 0, totalHits = 0, bestCombo = 0;

        // first[threshold] = when that threshold was first reached, and on what.
        var comboAt = new Dictionary<double, Row>();
        var playsAt = new Dictionary<double, Row>();
        var hitsAt = new Dictionary<double, Row>();
        var passAt = new Dictionary<double, Row>();
        var fcAt = new Dictionary<double, Row>();
        static void Remember(Dictionary<double, Row> into, double threshold, Row row) => into.TryAdd(threshold, row);

        foreach (var row in rows)
        {
            playcount++;
            totalHits += row.Num("hits") ?? 0;
            var combo = row.Num("max_combo") ?? 0;
            if (combo > bestCombo) bestCombo = combo;

            foreach (var target in Of("combo").Select(d => d.Threshold)) if (bestCombo >= target) Remember(comboAt, target, row);
            foreach (var target in Of("plays").Select(d => d.Threshold)) if (playcount >= target) Remember(playsAt, target, row);
            foreach (var target in Of("hits").Select(d => d.Threshold)) if (totalHits >= target) Remember(hitsAt, target, row);

            // Each star medal is its own band: osu! checks stars >= n && stars < n + 1.
            var mods = row.Is1("star_map") ? Mods.Parse(row.Str("mods_json")) : null;
            if (mods is not null && row.Num("stars") is { } stars && MayEarnStarMedal(mods, mode, row["beatmap_id"]))
            {
                var level = Math.Floor(stars);
                Remember(passAt, level, row);
                switch (IsFullCombo(row))
                {
                    case null: fcUnknown++; break;
                    case true: Remember(fcAt, level, row); break;
                }
            }

            // Rank needs the profile's pp: the weighted best on each distinct beatmap.
            if (row.Is1("counts") && row.Num("pp") is { } pp && row["beatmap_md5"] is string md5)
            {
                if (!bestByMap.TryGetValue(md5, out var previous) || pp > previous) bestByMap[md5] = pp;
            }
        }

        // Rank medals, decided once from the current total: they carry no date.
        var bests = bestByMap.Values.OrderDescending().ToList();
        var totalPp = Pp.WeightedTotal([.. bests.Take(100)]) + Pp.BonusPp(bests.Count);
        var currentRank = Ranks.Estimate(totalPp, mode)?.Rank;

        void Add(Definition[] definitions, string familyName, Dictionary<double, Row> earnedOn)
        {
            foreach (var definition in definitions)
            {
                earnedOn.TryGetValue(definition.Threshold, out var row);
                medals.Add(new Medal
                {
                    Slug = definition.Slug,
                    Name = definition.Name,
                    Description = definition.Description,
                    Icon = definition.Icon,
                    Family = familyName,
                    Threshold = definition.Threshold,
                    AchievedAt = row?["played_at"],
                    Dated = true,
                    EarnedOn = row is null ? null : Metadata.BeatmapNameOrNull(Metadata.Names(row)),
                    EarnedOnOriginal = row is null ? null : Metadata.BeatmapNameOriginal(Metadata.Names(row)),
                    Grouping = "Skill & Dedication",
                    FromOsu = false,
                });
            }
        }

        // Mod Introduction first, then osu!'s own ordering in Skill & Dedication.
        medals.AddRange(IntroMedals(db, profileId));
        Add(Of("combo"), "combo", comboAt);
        Add(Of("plays"), "plays", playsAt);
        foreach (var definition in Table.Rank)
        {
            // Lower is better: earned once the estimated rank is inside the threshold.
            var earned = currentRank is not null && currentRank <= definition.Threshold;
            medals.Add(new Medal
            {
                Slug = definition.Slug,
                Name = definition.Name,
                Description = definition.Description,
                Icon = definition.Icon,
                Family = "rank",
                Threshold = definition.Threshold,
                AchievedAt = earned && rows.Count > 0 ? rows[^1]["played_at"] : null,
                Dated = false,
                Grouping = "Skill & Dedication",
            });
        }
        Add(Of("hits"), "hits", hitsAt);
        Add(Of("pass"), "pass", passAt);
        Add(Of("fc"), "fc", fcAt);

        // The medals the osu! account held when imported: one earned here first keeps its play.
        var borrowed = ImportedMedals(db, profileId);
        foreach (var medal in medals)
        {
            if (!borrowed.TryGetValue(medal.Slug, out var at)) continue;
            if (medal.AchievedAt is not null && medal.Dated && Convert.ToDouble(medal.AchievedAt) <= Convert.ToDouble(at)) continue;
            medal.AchievedAt = at;
            medal.Dated = true;
            medal.EarnedOn = null;
            medal.EarnedOnOriginal = null;
            medal.FromOsu = true;
        }

        return new MedalSummary(medals, medals.Count(m => m.AchievedAt is not null), medals.Count, fcUnknown);
    }

    /// <summary>The medals an import copied from an osu! account, by slug, with osu!'s dates.</summary>
    public static Dictionary<string, object?> ImportedMedals(Database db, long profileId)
    {
        var map = new Dictionary<string, object?>();
        foreach (var row in db.Rows("SELECT slug, achieved_at FROM imported_medals WHERE profile_id = ?", profileId))
        {
            map[row.Text("slug")] = row["achieved_at"];
        }
        return map;
    }

    /// <summary>
    /// How many medals the profile holds across every mode: osu!'s header figure, counted by slug.
    /// <paramref name="known"/> is the mode already computed, so it is not computed twice.
    /// </summary>
    public static int EarnedCount(Database db, long profileId, Eligibility e, (double Mode, MedalSummary Summary)? known = null)
    {
        var earned = new HashSet<string>();
        foreach (var mode in new double[] { 0, 1, 2, 3 })
        {
            var summary = known is { } k && k.Mode == mode ? k.Summary : Compute(db, profileId, mode, e);
            foreach (var medal in summary.Medals) if (medal.AchievedAt is not null) earned.Add(medal.Slug);
        }
        return earned.Count;
    }
}
