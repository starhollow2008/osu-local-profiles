using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tracker;

/// <summary>
/// How a play is recognised, whichever side it is seen from: every online id it is known by, its
/// beatmap, when, its max combo, and its total on every scale it might have been stored on.
/// </summary>
internal sealed record PlayIdentity(List<string> OnlineIds, string BeatmapMD5, double PlayedAt, double MaxCombo, List<double> Totals);

/// <summary>
/// A play already in the profile, and how good a record of it the profile holds: osu!'s own figures
/// (<c>osu</c>), a replay this app built from them (<c>built</c>), or a replay osu! wrote (<c>replay</c>).
/// </summary>
internal sealed record ExistingScore(long Id, bool Imported, string Record);

/// <summary>The same play under another record of it: src/tracker/online-import.ts, the matching half.</summary>
internal static class Existing
{
    /// <summary>The tolerance for matching a play by when it happened, when there is no id to match on.</summary>
    public const double TimeToleranceMs = 5 * 60 * 1000;

    private static int Rank(string record) => record switch { "osu" => 0, "built" => 1, _ => 2 };

    /// <summary>Whether a record of kind <paramref name="incoming"/> should take the place of the row already here.</summary>
    public static bool Replaces(ExistingScore found, string incoming) => Rank(incoming) > Rank(found.Record);

    private static ExistingScore Of(Row r) => new(
        (long)r.Num("id")!,
        r["imported_at"] is not null,
        r["imported_at"] is not null ? "osu" : r["origin"] is null ? "replay" : "built");

    /// <summary>
    /// The row this play is already on in this profile, or null: by an online id in either id column,
    /// else by the same beatmap, a total on some scale, max combo and moment within the tolerance.
    /// </summary>
    public static ExistingScore? Find(Database db, long profileId, PlayIdentity identity)
    {
        var ids = identity.OnlineIds.Where(v => v != "" && v != "0").Distinct(StringComparer.Ordinal).ToList();
        if (ids.Count > 0)
        {
            var marks = string.Join(",", ids.Select(_ => "?"));
            var byId = db.FirstRow($"""
                SELECT id, imported_at, origin FROM scores
                 WHERE profile_id = ?
                   AND (online_score_id IN ({marks}) OR legacy_score_id IN ({marks}))
                 LIMIT 1
                """, [profileId, .. ids, .. ids]);
            if (byId is not null) return Of(byId);
        }

        var totals = identity.Totals.Where(double.IsFinite).Distinct().ToList();
        if (totals.Count == 0) return null;
        var totalMarks = string.Join(",", totals.Select(_ => "?"));
        var byPlay = db.FirstRow($"""
            SELECT id, imported_at, origin FROM scores
             WHERE profile_id = ?
               AND beatmap_md5 = ?
               AND total_score IN ({totalMarks})
               AND max_combo = ?
               AND ABS(played_at - ?) <= ?
             LIMIT 1
            """, [profileId, identity.BeatmapMD5, .. totals.Cast<object?>(), identity.MaxCombo, identity.PlayedAt, TimeToleranceMs]);
        return byPlay is null ? null : Of(byPlay);
    }

    /// <summary>How a replay on this machine names the play it holds: both the header's id and lazer's own.</summary>
    public static PlayIdentity ReplayIdentity(ReplayScore score)
    {
        var lazerId = Js.Get(score.Extras, "online_id");
        List<string> ids = [];
        if (score.OnlineScoreId is { } header) ids.Add(header.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (lazerId is { ValueKind: System.Text.Json.JsonValueKind.Number } n && Js.NumberOf(n) > 0) ids.Add(Js.NumberToString(Js.NumberOf(n)));
        return new PlayIdentity(ids, score.BeatmapMD5, score.PlayedAtMs, score.MaxCombo, [score.TotalScore]);
    }
}
