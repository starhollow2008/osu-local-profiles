using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles;

/// <summary>
/// Where the profile's plays placed on osu!'s leaderboards, as the linked account's Recent lists
/// them: src/rank-events.ts, the asking and keeping half. Nothing at all without a linked account
/// of the player's own; asked once a launch and a while after each play osu! could rank.
/// </summary>
internal static class RankEvents
{
    /// <summary>How far apart a play and osu!'s event for it may be: the event is made as osu! takes the score.</summary>
    public const double MatchWindowMs = 15 * 60_000;

    /// <summary>How long after a play to ask, so osu! has processed it, and so a run of plays asks once.</summary>
    public const double AskAfterPlayMs = 90_000;

    /// <summary>The osu! account whose rank events this profile shows, or null for none.</summary>
    public static double? Account(Database db, long profileId, PlayerIdentity identity)
    {
        var settings = SettingsStore.Get(db, profileId);
        if (settings.LinkedUserId <= 0) return null;
        // The linked account is the one osu! says is signed in here.
        if (identity.Source == "linked") return settings.LinkedUserId;
        var names = new[] { settings.LinkedUsername }.Concat(settings.LinkedPreviousNames).Where(n => n != "").Select(Js.ToLower).ToList();
        if (names.Count == 0) return null;
        // Or the profile's own plays were set under it.
        var played = db.Exists($"""
            SELECT 1 AS hit FROM scores
             WHERE profile_id = ? AND LOWER(player_name) IN ({string.Join(", ", names.Select(_ => "?"))}) LIMIT 1
            """, [profileId, .. names]);
        return played ? settings.LinkedUserId : null;
    }

    /// <summary>Keep the events that belong to a play of this profile, matched by beatmap, ruleset and moment; how many were new.</summary>
    public static int Save(Database db, long profileId, IEnumerable<Clients.RankEvent> events) => db.Serialized(() =>
    {
        var added = 0;
        foreach (var e in events)
        {
            var play = db.Get($"""
                SELECT s.dedupe_key FROM scores s
                 WHERE s.profile_id = ? AND s.beatmap_id = ? AND s.mode = ? AND s.client <> 'mcosu'
                   AND s.played_at BETWEEN ? AND ? AND {Eligibility.VisibleSql()}
                 ORDER BY ABS(s.played_at - ?) ASC, s.id DESC LIMIT 1
                """, r => r.GetString(0), profileId, e.BeatmapId, e.Mode, e.At - MatchWindowMs, e.At + MatchWindowMs, e.At);
            if (play is null) continue;
            added += db.Run("""
                INSERT OR IGNORE INTO rank_events (profile_id, event_id, dedupe_key, rank, grade, achieved_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """, profileId, e.Id, play, e.Rank, e.Grade, e.At);
        }
        return added;
    });
}

/// <summary>
/// When to ask osu!: once at start, and <see cref="RankEvents.AskAfterPlayMs"/> after the last of a
/// run of plays. A failure (offline, osu! down) is quiet: the next play or launch asks again.
/// </summary>
internal sealed class RankEventWatcher(Database db, Func<long> profileId, Func<PlayerIdentity> identity, OsuWeb osu, Action<int>? onNew = null)
{
    private readonly object gate = new();
    private Timer? timer;
    private int asking;

    /// <summary>A play was just tracked. Only one osu! could rank is worth asking about.</summary>
    public void Played(string client, string grade)
    {
        if (client == "mcosu" || grade == "F") return;
        if (Account() is null) return;
        lock (gate)
        {
            timer?.Dispose();
            timer = new Timer(_ =>
            {
                lock (gate) timer = null;
                _ = CatchUp();
            }, null, TimeSpan.FromMilliseconds(RankEvents.AskAfterPlayMs), Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>Ask now. How many new events were kept; 0 when there was nobody to ask about.</summary>
    public async Task<int> CatchUp()
    {
        if (Interlocked.Exchange(ref asking, 1) == 1) return 0;
        try
        {
            if (Account() is not { } account) return 0;
            var events = await osu.FetchRankEvents(account);
            var added = RankEvents.Save(db, profileId(), events);
            if (added > 0) onNew?.Invoke(added);
            return added;
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return 0;
        }
        finally
        {
            Interlocked.Exchange(ref asking, 0);
        }
    }

    private double? Account() => RankEvents.Account(db, profileId(), identity());
}
