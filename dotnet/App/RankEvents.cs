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
            // First place for a play here: First Place Ranks holds the beatmap from then (roadmap 5.87).
            if (e.Rank == 1) FirstPlaces.Gained(db, profileId, e.Mode, e.BeatmapId, e.At);
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
/// run of plays. A failure (offline, osu! down) is quiet: the next play or launch asks again. Each
/// time, the account's Daily Challenge and Ranked Play are read too (<see cref="OnlineStats"/>): for
/// every ruleset the profile plays at start, and after plays, the rulesets they were in.
/// </summary>
internal sealed class RankEventWatcher(Database db, Func<long> profileId, Func<PlayerIdentity> identity, OsuWeb osu, Action<int>? onNew = null,
    BeatmapResolver? beatmaps = null)
{
    private readonly object gate = new();
    private Timer? timer;
    private int asking;
    /// <summary>Whether this launch has compared osu!'s first-place counts yet: once a launch, not once a play.</summary>
    private bool countsCompared;
    /// <summary>The rulesets played since the last ask, whose Daily Challenge and Ranked Play to read.</summary>
    private readonly HashSet<int> playedModes = [];

    /// <summary>A play was just tracked. Only one osu! could rank is worth asking about.</summary>
    public void Played(string client, string grade, double mode)
    {
        if (client is "mcosu" or "neki" or "neomod" || grade == "F") return;
        if (Account() is null) return;
        lock (gate)
        {
            if (mode is 0 or 1 or 2 or 3) playedModes.Add((int)mode);
            timer?.Dispose();
            timer = new Timer(_ =>
            {
                lock (gate) timer = null;
                _ = CatchUp(afterPlay: true);
            }, null, TimeSpan.FromMilliseconds(RankEvents.AskAfterPlayMs), Timeout.InfiniteTimeSpan);
        }
    }

    /// <summary>
    /// Ask now. How many new events were kept; 0 when there was nobody to ask about. After plays,
    /// Daily Challenge and Ranked Play are read for the rulesets played; otherwise for every one
    /// the profile plays.
    /// </summary>
    public async Task<int> CatchUp(bool afterPlay = false)
    {
        if (Interlocked.Exchange(ref asking, 1) == 1) return 0;
        try
        {
            if (Account() is not { } account) return 0;
            var profile = profileId();
            List<int> modes;
            lock (gate)
            {
                modes = afterPlay ? [.. playedModes.Order()] : OnlineStats.Modes(db, profile);
                playedModes.Clear();
            }
            var activity = await osu.FetchRecentActivity(account);
            var added = RankEvents.Save(db, profile, activity.Ranks);
            var changed = added + FirstPlaces.Lost(db, profile, activity.Lost);
            if (!countsCompared && beatmaps is not null)
            {
                countsCompared = true;
                changed += await CompareFirstPlaceCounts(account, profile, beatmaps);
            }
            changed += await ReadOnlineStats(account, profile, modes);
            if (changed > 0) onNew?.Invoke(changed);
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

    /// <summary>
    /// Each ruleset's profile page, and for each Ranked Play pool with a settled rating, its chart:
    /// how many rulesets changed. One that fails keeps its last read, for the next ask.
    /// </summary>
    private async Task<int> ReadOnlineStats(double account, long profile, List<int> modes)
    {
        var changed = 0;
        foreach (var mode in modes)
        {
            try
            {
                var page = await osu.FetchOnlineStats(account, mode);
                if (page.RankedPlay is { } pools)
                {
                    for (var i = 0; i < pools.Count; i++)
                    {
                        // osu-web draws no chart for a provisional rating, or for a pool never played.
                        if (pools[i].Provisional || pools[i].RecentHistory.Count == 0) continue;
                        pools[i] = pools[i] with { RatingHistory = await osu.FetchRatingHistory(pools[i].PoolId, account) };
                    }
                }
                if (OnlineStats.Save(db, profile, mode, page, Js.Now())) changed++;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                /* osu! out of reach: the last read stays */
            }
        }
        return changed;
    }

    /// <summary>
    /// For each ruleset first places were imported for, osu!'s count now against the count at the
    /// last read: the same, nothing more is asked; different, the list is read again, and any first
    /// place this profile has no score for yet comes in as the import brought the rest. How many
    /// rulesets changed. One that fails is left for the next launch.
    /// </summary>
    private async Task<int> CompareFirstPlaceCounts(double account, long profile, BeatmapResolver resolver)
    {
        var changed = 0;
        foreach (var (mode, stored) in FirstPlaces.Counts(db, profile))
        {
            try
            {
                if (await osu.FetchFirstPlaceCount(account, mode) is not { } count || count == stored) continue;
                var firsts = count > 0 ? await osu.FetchFirstPlaces(account, mode) : [];
                FirstPlaces.Import(db, resolver, profile, mode, firsts, count);
                changed++;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                /* osu! out of reach: the next launch asks again */
            }
        }
        return changed;
    }
}
