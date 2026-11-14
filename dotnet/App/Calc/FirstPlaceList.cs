using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Calc;

/// <summary>First Place Ranks (roadmap 5.87): the scores on the beatmaps the player holds first place on.</summary>
internal static partial class Stats
{
    /// <summary>
    /// Each held beatmap's score, as a row id: the one osu! named for it where the profile has it,
    /// else the profile's highest score on the beatmap, which is the one a leaderboard ranks. A
    /// beatmap with no score here yet has none and is not listed.
    /// </summary>
    private static string HeldScoresSql(Eligibility e) => $"""
        SELECT fp.since, (
                 SELECT s.id FROM scores s
                   LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
                  WHERE s.profile_id = fp.profile_id AND s.mode = fp.mode
                    AND COALESCE(s.beatmap_id, b.beatmap_id) = fp.beatmap_id AND {Eligibility.VisibleSql()}
                  ORDER BY COALESCE(s.online_score_id = fp.score_id OR s.legacy_score_id = fp.score_id, 0) DESC,
                           {Eligibility.ScoreColumn(e)} DESC, s.played_at DESC
                  LIMIT 1) AS score_row
          FROM first_places fp
         WHERE fp.profile_id = ? AND fp.mode = ?
        """;

    /// <summary>The newest first places first, as osu!'s profile lists them.</summary>
    public static List<Play> FirstPlaceList(Database db, long profileId, double mode, int limit, Eligibility e) =>
        [.. db.Rows($"""
            SELECT {PlayColumns(e)}, {Eligibility.PpColumn(e)} AS pp
              FROM ({HeldScoresSql(e)}) held
              JOIN scores s ON s.id = held.score_row
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             ORDER BY held.since DESC, s.id DESC
             LIMIT ?
            """, profileId, mode, limit).Select(r => ToPlay(r, e))];

    /// <summary>How many the list has: the held beatmaps the profile has a score on.</summary>
    public static double FirstPlaceTotal(Database db, long profileId, double mode, Eligibility e) =>
        Convert.ToDouble(db.Scalar($"SELECT COUNT(*) AS n FROM ({HeldScoresSql(e)}) WHERE score_row IS NOT NULL", profileId, mode));
}
