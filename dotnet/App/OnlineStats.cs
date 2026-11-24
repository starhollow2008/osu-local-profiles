using System.Text.Json;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>
/// osu!'s Daily Challenge and Ranked Play for the profile's linked account, which Show more details
/// shows as osu! does. Read with the rank events (<see cref="RankEventWatcher"/>), so only for an
/// account of the player's own, and kept, so the page shows the last read with no network. Shown as
/// osu! gave it; no figure of the app's own reads it.
/// </summary>
internal static class OnlineStats
{
    /// <summary>The modes to ask about when nothing in particular was played: each the profile has plays in, or osu!standard.</summary>
    public static List<int> Modes(Database db, long profileId)
    {
        var modes = db.All("""
            SELECT mode FROM scores WHERE profile_id = ? AND mode BETWEEN 0 AND 3
            UNION SELECT mode FROM online_stats WHERE profile_id = ?
            ORDER BY mode
            """, r => (int)r.GetInt64(0), profileId, profileId);
        return modes.Count > 0 ? modes : [0];
    }

    /// <summary>Keep one read of a ruleset's page, replacing the last. Whether anything changed.</summary>
    public static bool Save(Database db, long profileId, int mode, OnlineStatsPage page, double at) => db.Serialized(() =>
    {
        var daily = page.DailyChallenge is { } d ? JsonText.Stringify(d) : null;
        var ranked = page.RankedPlay is { } r ? JsonText.Stringify(r) : null;
        var before = db.Get("SELECT daily_challenge, ranked_play FROM online_stats WHERE profile_id = ? AND mode = ?",
            row => (row.IsDBNull(0) ? null : row.GetString(0), row.IsDBNull(1) ? null : row.GetString(1)), profileId, mode);
        if (before == (daily, ranked)) return false;
        db.Run("""
            INSERT INTO online_stats (profile_id, mode, daily_challenge, ranked_play, read_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(profile_id, mode) DO UPDATE SET
              daily_challenge = excluded.daily_challenge, ranked_play = excluded.ranked_play, read_at = excluded.read_at
            """, profileId, mode, daily, ranked, at);
        return true;
    });

    /// <summary>
    /// What the page draws for a mode: that ruleset's Ranked Play, and the account's Daily Challenge
    /// from whichever ruleset's page was read last, since it is the same on each. Null when nothing
    /// has been read for the profile.
    /// </summary>
    public static object? View(Database db, long profileId, double mode)
    {
        var rows = db.All("SELECT mode, daily_challenge, ranked_play, read_at FROM online_stats WHERE profile_id = ? ORDER BY read_at DESC",
            r => (Mode: r.GetInt64(0), Daily: r.IsDBNull(1) ? null : r.GetString(1), Ranked: r.IsDBNull(2) ? null : r.GetString(2), At: r.GetDouble(3)),
            profileId);
        if (rows.Count == 0) return null;
        var daily = rows.FirstOrDefault(r => r.Daily is not null);
        var here = rows.FirstOrDefault(r => r.Mode == mode);
        return new
        {
            dailyChallenge = Element(daily.Daily),
            rankedPlay = Element(here.Ranked),
            readAt = here.Ranked is not null ? here.At : daily.Daily is not null ? daily.At : (double?)null,
        };
    }

    private static JsonElement? Element(string? json) => json is not null && JsonText.TryParse(json, out var value) ? value : null;
}
