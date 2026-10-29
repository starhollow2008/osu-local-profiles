using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tracker;

/// <summary>What one ruleset's import did, as the dialog reports it.</summary>
internal sealed class ModeImportResult
{
    public double Mode { get; init; }
    /// <summary>Best performances osu! handed over, before anything was decided about them.</summary>
    public int Found { get; init; }
    public int Added { get; set; }
    public int Updated { get; set; }
    /// <summary>Already in this profile from their own replays, and left alone.</summary>
    public int Tracked { get; set; }
    /// <summary>Deleted for good from Settings, so kept out.</summary>
    public int Skipped { get; set; }
    public int Pinned { get; set; }
    public double? BonusPp { get; set; }
    public double? OsuTotalPp { get; init; }
    public double? OsuGlobalRank { get; init; }
}

/// <summary>What became of one of osu!'s scores: added, updated, tracked (already here from its replay), or skipped.</summary>
internal sealed record ImportOutcome(string Status, long Id = 0);

/// <summary>
/// An osu! account's own record of its plays, brought into a profile: src/tracker/online-import.ts,
/// the writing half. These scores carry osu!'s own pp and no breakdown, until a replay is built
/// from them and priced here (src/score-entry.ts).
/// </summary>
internal static class OnlineImport
{
    /// <summary>Mods that leave a beatmap's star rating exactly as it is, so the play may claim the map's own.</summary>
    private static readonly HashSet<string> RatingNeutralMods = ["NF", "SD", "PF", "SO", "HD", "CL", "MR", "TD"];

    /// <summary>How an imported score names itself in <c>dedupe_key</c>, and so in <c>deleted_scores</c>.</summary>
    public static string DedupeKey(OsuWebScore score) => $"osu:{score.Id}";

    /// <summary>Whether this play was set on osu!stable, which decides the scale of its total.</summary>
    public static bool FromStable(OsuWebScore score) =>
        score.LegacyScoreId is not null || score.Mods.Any(m => Mods.Acronym(m) == "CL");

    /// <summary>The total its replay would have been stored with: osu!'s old uncapped number for a stable play.</summary>
    public static double NativeTotal(OsuWebScore score) => FromStable(score) ? score.LegacyTotalScore ?? score.TotalScore : score.TotalScore;

    private static List<double> TotalsOf(OsuWebScore score) =>
        [.. new double?[] { score.TotalScore, score.LegacyTotalScore, score.ClassicTotalScore }.Where(t => t is { } v && double.IsFinite(v)).Select(t => t!.Value)];

    public static PlayIdentity IdentityOf(OsuWebScore score) => new(
        [score.Id, .. score.LegacyScoreId is null ? Array.Empty<string>() : [score.LegacyScoreId]],
        score.BeatmapMD5, score.PlayedAt, score.MaxCombo, TotalsOf(score));

    /// <summary>lazer's judgement names to osu!stable's six counters; anything unrecognised is ignored.</summary>
    public static (double C300, double C100, double C50, double Geki, double Katu, double Miss) LegacyCounts(
        IReadOnlyDictionary<string, double> statistics, double mode)
    {
        double N(string key) => statistics.GetValueOrDefault(key);
        var miss = N("miss");
        return mode switch
        {
            0 => (N("great"), N("ok"), N("meh"), 0, 0, miss),
            1 => (N("great"), N("ok"), 0, 0, 0, miss),
            2 => (N("great"), N("large_tick_hit"), N("small_tick_hit"), 0, N("small_tick_miss"), miss),
            3 => (N("great"), N("ok"), N("meh"), N("perfect"), N("good"), miss),
            // A ruleset_id between the four (1.5) matches no case, and JavaScript then fails reading the result.
            _ => throw new InvalidOperationException("Cannot read properties of undefined (reading 'c300')"),
        };
    }

    private static double? RatingOf(OsuWebScore score) =>
        score.Mods.All(m => Mods.Acronym(m) is { } a && RatingNeutralMods.Contains(a)) ? score.BeatmapStars : null;

    /// <summary>
    /// Keep what osu! said about the beatmap, filling blanks only: what this machine read from its
    /// own copy stays. The status to use: the local one, else osu!'s.
    /// </summary>
    public static object? CacheBeatmap(Database db, BeatmapResolver resolver, OsuWebScore score)
    {
        // Resolving first creates the row if there is none, so the update below always has one.
        var local = resolver.Resolve(score.BeatmapMD5);
        db.Run("""
            UPDATE beatmaps
               SET beatmap_id    = COALESCE(beatmap_id, ?),
                   beatmapset_id = COALESCE(beatmapset_id, ?),
                   artist        = COALESCE(artist, ?),
                   title         = COALESCE(title, ?),
                   version       = COALESCE(version, ?),
                   creator       = COALESCE(creator, ?),
                   stars         = COALESCE(stars, ?),
                   status        = CASE WHEN status IS NULL OR status = ? THEN ? ELSE status END
             WHERE md5 = ?
            """, score.BeatmapId, score.BeatmapsetId, score.Artist, score.Title, score.Version, score.Creator, score.BeatmapStars,
            Status.Unresolved, score.MapStatus, score.BeatmapMD5);
        return local.Status ?? (object)(long)score.MapStatus;
    }

    /// <summary>
    /// Write one of osu!'s scores into the profile, or recognise the play as already here. One tracked
    /// from its replay is left alone; one a previous import wrote is updated, picking up pp reworks.
    /// </summary>
    public static ImportOutcome ImportScore(Database db, BeatmapResolver resolver, long profileId, OsuWebScore score) => db.Serialized(() =>
    {
        var key = DedupeKey(score);
        if (Scores.WasDeleted(db, profileId, key)) return new ImportOutcome("skipped");
        var existing = Existing.Find(db, profileId, IdentityOf(score));
        if (existing is not null && !existing.Imported) return new ImportOutcome("tracked", existing.Id);

        var status = CacheBeatmap(db, resolver, score);
        var counts = LegacyCounts(score.Statistics, score.Mode);
        var mapRanked = Status.AwardsPp(Pricing.StatusOf(status));
        var eligible = score.Ranked && mapRanked;
        object?[] values =
        [
            score.Mode, score.BeatmapMD5, score.BeatmapId, FromStable(score) ? "stable" : "lazer",
            JsonText.Stringify(score.Mods), Mods.Label(score.Mods),
            counts.C300, counts.C100, counts.C50, counts.Geki, counts.Katu, counts.Miss,
            JsonText.Stringify(score.Statistics), JsonText.Stringify(score.MaximumStatistics),
            score.Accuracy, score.MaxCombo, NativeTotal(score), score.TotalScore, score.ClassicTotalScore,
            score.Passed ? 1 : 0, score.Grade, RatingOf(score), score.Pp, score.Pp is null ? null : "osu-web",
            status ?? Status.Unresolved, score.Ranked ? 1 : 0, "osu.ppy.sh", Mods.Countable(score.Mods) ? 1 : 0, eligible ? 1 : 0,
            score.PlayedAt, score.Id, score.LegacyScoreId, Js.Now(),
        ];

        if (existing is not null)
        {
            db.Run("""
                UPDATE scores SET
                  mode = ?, beatmap_md5 = ?, beatmap_id = ?, client = ?, mods_json = ?, mods_label = ?,
                  count300 = ?, count100 = ?, count50 = ?, count_geki = ?, count_katu = ?, count_miss = ?,
                  statistics_json = ?, max_statistics_json = ?, accuracy = ?, max_combo = ?,
                  total_score = ?, score_standard = ?, score_classic = ?, passed = ?, grade = ?,
                  stars = ?, pp = ?, pp_source = ?, map_status = ?, mods_ranked = ?, mods_ranked_by = ?,
                  mods_countable = ?, ranked = ?, played_at = ?, online_score_id = ?,
                  legacy_score_id = ?, imported_at = ?
                WHERE id = ?
                """, [.. values, existing.Id]);
            return new ImportOutcome("updated", existing.Id);
        }
        db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key,
               mode, beatmap_md5, beatmap_id, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               statistics_json, max_statistics_json, accuracy, max_combo,
               total_score, score_standard, score_classic, passed, grade,
               stars, pp, pp_source, map_status, mods_ranked, mods_ranked_by,
               mods_countable, ranked, played_at, online_score_id, legacy_score_id, imported_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, [profileId, key, .. values]);
        return new ImportOutcome("added", Convert.ToInt64(db.Scalar("SELECT last_insert_rowid() AS id")));
    });

    /// <summary>
    /// The part of osu!'s total this profile cannot work out from the scores it was given: mostly
    /// bonus pp, measured against the weighted sum this app computes. Null when osu!'s standing could
    /// not be read, never negative.
    /// </summary>
    public static double? BorrowedBonusPp(IReadOnlyList<OsuWebScore> best, OsuWebStanding standing)
    {
        if (standing.TotalPp is not { } total) return null;
        double weighted = 0;
        for (var i = 0; i < Math.Min(best.Count, Pp.TopPlayLimit); i++) weighted += (best[i].Pp ?? 0) * Math.Pow(Pp.Weight, i);
        return Math.Max(0, total - weighted);
    }

    /// <summary>
    /// One ruleset's best performances and pinned scores in one pass, since they overlap. The pins are
    /// applied last, in osu!'s own order, so the pinned list reads as the osu! profile does.
    /// </summary>
    public static ModeImportResult ImportMode(Database db, BeatmapResolver resolver, long profileId, double mode,
        IReadOnlyList<OsuWebScore> best, IReadOnlyList<OsuWebScore> pinned, OsuWebStanding? standing)
    {
        var result = new ModeImportResult
        {
            Mode = mode,
            Found = best.Count,
            OsuTotalPp = standing?.TotalPp,
            OsuGlobalRank = standing?.GlobalRank,
        };
        ImportOutcome Tally(ImportOutcome outcome)
        {
            switch (outcome.Status)
            {
                case "added": result.Added++; break;
                case "updated": result.Updated++; break;
                case "tracked": result.Tracked++; break;
                default: result.Skipped++; break;
            }
            return outcome;
        }
        foreach (var score in best) Tally(ImportScore(db, resolver, profileId, score));
        // Pinned whether or not they are best performances: pinning is how a play pp does not reward is shown.
        foreach (var score in pinned)
        {
            var outcome = Tally(ImportScore(db, resolver, profileId, score));
            if (outcome.Status == "skipped") continue;
            var already = db.FirstRow("SELECT pinned_at FROM scores WHERE id = ?", outcome.Id);
            if (already is not null && already["pinned_at"] is null)
            {
                Scores.ApplyAction(db, profileId, outcome.Id, "pin");
                result.Pinned++;
            }
        }
        if (standing is not null && BorrowedBonusPp(best, standing) is { } bonus)
        {
            result.BonusPp = bonus;
            SaveStanding(db, profileId, mode, bonus, standing);
        }
        return result;
    }

    /// <summary>Remember what osu! said this account stands at, for one ruleset.</summary>
    public static void SaveStanding(Database db, long profileId, double mode, double bonusPp, OsuWebStanding standing) => db.Run("""
        INSERT INTO imported_standing
          (profile_id, mode, bonus_pp, osu_total_pp, osu_global_rank, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (profile_id, mode) DO UPDATE SET
          bonus_pp = excluded.bonus_pp,
          osu_total_pp = excluded.osu_total_pp,
          osu_global_rank = excluded.osu_global_rank,
          imported_at = excluded.imported_at
        """, profileId, mode, bonusPp, standing.TotalPp, standing.GlobalRank, Js.Now());

    /// <summary>Keep the medals osu! awarded, in place of whatever an earlier import said; how many are kept.</summary>
    public static double SaveImportedMedals(Database db, long profileId, IEnumerable<EarnedMedal> medals)
    {
        var now = Js.Now();
        db.Transaction(() =>
        {
            db.Run("DELETE FROM imported_medals WHERE profile_id = ?", profileId);
            foreach (var m in medals)
            {
                db.Run("INSERT OR REPLACE INTO imported_medals (profile_id, slug, achieved_at, imported_at) VALUES (?, ?, ?, ?)",
                    profileId, m.Slug, m.AchievedAt, now);
            }
        });
        return Convert.ToDouble(db.Scalar("SELECT COUNT(*) AS n FROM imported_medals WHERE profile_id = ?", profileId));
    }
}
