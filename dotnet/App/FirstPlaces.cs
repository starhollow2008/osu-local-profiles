using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles;

/// <summary>A beatmap the player holds first place on: osu!'s score there, and since when.</summary>
internal sealed record HeldFirstPlace(double BeatmapId, string? ScoreId, double Since);

/// <summary>What an import of one ruleset's first places did, as the dialog reports it.</summary>
internal sealed record FirstPlacesImport(double Mode, int Held, int Added, int Updated, int Tracked, int Skipped);

/// <summary>
/// First Place Ranks (roadmap 5.87): the beatmaps where the profile's player holds first place on
/// osu!'s leaderboard. Which ones is a status kept apart from the scores: losing first place takes a
/// beatmap off the list and leaves its score, and every figure, as they were.
/// </summary>
/// <remarks>
/// Three ways in: an import of the account's first places (each a score, as Best performances are,
/// so it counts as they do), a #1 among the rank events of a play tracked here, and the launch's
/// check of osu!'s count, which reads the list again only when the count has changed since the last
/// read. One way out: osu!'s "lost first place" event. No polling: the events are the ones Recent
/// already asks for, and the count is one request a launch for each ruleset first places were
/// imported for.
/// </remarks>
internal static class FirstPlaces
{
    /// <summary>
    /// A ruleset's first places as osu! listed them: every score imported as Best performances are,
    /// the list put in place of the old one, and osu!'s count kept to compare a launch's against.
    /// </summary>
    public static FirstPlacesImport Import(Database db, BeatmapResolver resolver, long profileId, double mode,
        IReadOnlyList<OsuWebScore> firsts, double osuCount)
    {
        int added = 0, updated = 0, tracked = 0, skipped = 0;
        foreach (var score in firsts)
        {
            switch (OnlineImport.ImportScore(db, resolver, profileId, score).Status)
            {
                case "added": added++; break;
                case "updated": updated++; break;
                case "tracked": tracked++; break;
                default: skipped++; break;
            }
        }
        var held = firsts.Select(s => new HeldFirstPlace(s.BeatmapId, s.Id, s.PlayedAt)).ToList();
        Replace(db, profileId, mode, held, osuCount);
        return new FirstPlacesImport(mode, held.Count, added, updated, tracked, skipped);
    }

    /// <summary>A ruleset's first places, all of them at once, and osu!'s count with them.</summary>
    public static void Replace(Database db, long profileId, double mode, IEnumerable<HeldFirstPlace> held, double osuCount) => db.Transaction(() =>
    {
        db.Run("DELETE FROM first_places WHERE profile_id = ? AND mode = ?", profileId, mode);
        foreach (var h in held)
        {
            db.Run("""
                INSERT INTO first_places (profile_id, mode, beatmap_id, score_id, since) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (profile_id, mode, beatmap_id) DO UPDATE SET score_id = excluded.score_id, since = MIN(since, excluded.since)
                """, profileId, mode, h.BeatmapId, h.ScoreId, h.Since);
        }
        db.Run("""
            INSERT INTO first_place_counts (profile_id, mode, count, read_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (profile_id, mode) DO UPDATE SET count = excluded.count, read_at = excluded.read_at
            """, profileId, mode, osuCount, Js.Now());
    });

    /// <summary>A #1 for a play here: the beatmap is held from then, unless it already was.</summary>
    public static void Gained(Database db, long profileId, int mode, double beatmapId, double at) => db.Run("""
        INSERT INTO first_places (profile_id, mode, beatmap_id, score_id, since) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT (profile_id, mode, beatmap_id) DO NOTHING
        """, profileId, mode, beatmapId, at);

    /// <summary>
    /// osu!'s "lost first place": the beatmap comes off the list, unless it was held again after
    /// that moment. How many came off.
    /// </summary>
    public static int Lost(Database db, long profileId, IEnumerable<FirstPlaceLost> lost)
    {
        var removed = 0;
        foreach (var l in lost)
        {
            removed += db.Run("DELETE FROM first_places WHERE profile_id = ? AND mode = ? AND beatmap_id = ? AND since <= ?",
                profileId, l.Mode, l.BeatmapId, l.At);
        }
        return removed;
    }

    /// <summary>The rulesets first places were imported for, with osu!'s count at that read.</summary>
    public static List<(double Mode, double Count)> Counts(Database db, long profileId) =>
        db.All("SELECT mode, count FROM first_place_counts WHERE profile_id = ? ORDER BY mode",
            r => (r.GetDouble(0), r.GetDouble(1)), profileId);
}
