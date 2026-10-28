using System.Globalization;
using System.Text.Json;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles;

/// <summary>
/// Who a profile's plays belong to: osu!'s numeric id when known, every name that counts as the
/// profile's (lowercased), the owner's name as written, whether that list is osu!'s complete one,
/// and where the answer came from (<c>linked</c>, <c>signed-in</c>, <c>tracked-plays</c>, <c>unknown</c>).
/// </summary>
internal sealed record PlayerIdentity(double? UserId, HashSet<string> Names, string DisplayName, bool NamesComplete, string Source)
{
    public static readonly PlayerIdentity Unknown = new(null, [], "", false, "unknown");

    /// <summary>Whether this identity can actually turn a replay away.</summary>
    public bool Known => UserId is not null || Names.Count > 0;
}

/// <summary>What a replay says about who set it: the name in it, lazer's user id, and osu!'s id for the score.</summary>
internal sealed record ReplayPlayer(string Name, double? UserId, double? OnlineId)
{
    /// <summary>Whether osu! ever accepted this play, which is what a downloaded replay always proves.</summary>
    public bool Submitted => OnlineId is not null;
}

/// <summary>An osu! account as <see cref="Players.ConfirmSameAccount"/> needs it.</summary>
internal sealed record OsuAccount(double Id, string Username, List<string> PreviousUsernames);

/// <summary>What a sweep of a profile's existing scores found.</summary>
internal sealed record ForeignScoreSweep(int Checked, int Hidden, List<(string Name, int Count)> ByPlayer, int Unattributable);

/// <summary>
/// Whose play a replay is: src/player-identity.ts. Everything here fails towards <em>yours</em>,
/// since a play refused is a play lost; the reasons are in the TypeScript.
/// </summary>
internal static class Players
{
    /// <summary>lazer's name for the local user when nobody is signed in. Never a downloaded replay.</summary>
    private const string GuestName = "guest";

    /// <summary>How long before it turns up a replay may have been set and still count as set just now.</summary>
    public const double JustSetMs = 5 * 60_000;

    /// <summary>A replay's timestamp may run this far ahead of the clock it arrives by.</summary>
    private const double ClockSlackMs = 60_000;

    /// <summary>How long after its play a replay's file may have been written and still count as written as played.</summary>
    public const double WrittenAsPlayedMs = 24 * 3_600_000;

    /// <summary>How many of the profile's own names are looked up the other way round, at most.</summary>
    private const int MaxReverseLookups = 3;

    /// <summary>
    /// The name behind at least four fifths of this profile's own tracked plays (McOsu's left out),
    /// when there are at least ten; otherwise no clear owner.
    /// </summary>
    public static (string Name, double? UserId)? DominantTrackedName(Database db, long profileId)
    {
        var rows = db.Rows("""
            SELECT player_name AS name, player_id AS id, COUNT(*) AS n
              FROM scores
             WHERE profile_id = ? AND player_name IS NOT NULL AND player_name <> '' AND client <> 'mcosu'
             GROUP BY LOWER(player_name)
             ORDER BY n DESC
            """, profileId);
        if (rows.Count == 0) return null;
        var total = rows.Sum(r => r.Num("n") ?? 0);
        var top = rows[0];
        if (total < 10 || (top.Num("n") ?? 0) / total < 0.8) return null;
        return (top.Str("name")!, top.Num("id"));
    }

    /// <summary>
    /// Who this profile's plays belong to: whoever osu! says is signed in here (a linked account
    /// counts only when it is that account), else the name behind its own tracked plays, else
    /// nobody in particular. Names listed as the player's own join an owner already known.
    /// </summary>
    public static PlayerIdentity Resolve(Database db, long profileId, IReadOnlyList<OsuInstall> installs)
    {
        var settings = SettingsStore.Get(db, profileId);
        var known = KnownIdentity(db, profileId, installs, settings);
        if (known.Source == "unknown" || settings.OwnNames.Count == 0) return known;
        return known with { Names = [.. known.Names, .. settings.OwnNames.Select(Js.ToLower)] };
    }

    private static PlayerIdentity KnownIdentity(Database db, long profileId, IReadOnlyList<OsuInstall> installs, ProfileSettings settings)
    {
        var signedIn = Session.DetectLocalSessions(installs).Select(s => s.Username).ToList();
        if (signedIn.Count > 0)
        {
            var names = WithAccountNames([.. signedIn.Select(Js.ToLower)], settings.AccountNames);
            var linkedNames = new[] { settings.LinkedUsername }.Concat(settings.LinkedPreviousNames)
                .Where(n => n != "").Select(Js.ToLower).ToList();
            if (linkedNames.Any(names.Contains))
            {
                var allTheLinkedAccount = names.All(linkedNames.Contains);
                return new PlayerIdentity(
                    allTheLinkedAccount && settings.LinkedUserId > 0 ? settings.LinkedUserId : null,
                    [.. names, .. linkedNames],
                    settings.LinkedUsername,
                    settings.LinkedNamesKnown,
                    "linked");
            }
            return new PlayerIdentity(null, names, signedIn[0], false, "signed-in");
        }

        if (DominantTrackedName(db, profileId) is { } tracked)
        {
            return new PlayerIdentity(tracked.UserId, WithAccountNames([Js.ToLower(tracked.Name)], settings.AccountNames),
                tracked.Name, false, "tracked-plays");
        }
        return PlayerIdentity.Unknown;
    }

    /// <summary>The names osu! confirmed are one account, added when one of them is already the profile's.</summary>
    private static HashSet<string> WithAccountNames(HashSet<string> names, IEnumerable<string> accountNames)
    {
        var account = accountNames.Select(Js.ToLower).ToList();
        return account.Any(names.Contains) ? [.. names, .. account] : names;
    }

    private static IEnumerable<string> AccountNamesOf(OsuAccount account) =>
        new[] { account.Username }.Concat(account.PreviousUsernames).Select(Js.ToLower);

    /// <summary>
    /// Ask osu! whether <paramref name="name"/> is an account this profile already is, under a name
    /// it had before or has since: that account, or null when osu! lists no such thing. Anything but
    /// "no such user" is thrown, so it reads as "could not ask" rather than "not you".
    /// </summary>
    public static async Task<OsuAccount?> ConfirmSameAccount(string name, PlayerIdentity identity,
        Func<string, Task<OsuAccount>> lookup, Func<Exception, bool> isNoSuchUser)
    {
        var wanted = Js.ToLower(Js.Trim(name));
        if (wanted == "" || !identity.Known) return null;

        async Task<OsuAccount?> Find(string query)
        {
            try
            {
                return await lookup(query);
            }
            catch (Exception e) when (isNoSuchUser(e))
            {
                return null;
            }
        }

        var account = await Find(wanted);
        if (account is not null)
        {
            if (identity.UserId is not null && account.Id == identity.UserId) return account;
            if (AccountNamesOf(account).Any(identity.Names.Contains)) return account;
        }
        foreach (var own in identity.Names.Where(n => n != wanted).Take(MaxReverseLookups))
        {
            var other = await Find(own);
            if (other is not null && AccountNamesOf(other).Contains(wanted)) return other;
        }
        return null;
    }

    /// <summary>
    /// Player names in alphabetical order, ignoring case, the same on every machine: <c>compareNames</c>,
    /// lowercased as JavaScript lowercases and then compared code unit by code unit.
    /// </summary>
    public static int CompareNames(string a, string b)
    {
        var (x, y) = (Js.ToLower(a), Js.ToLower(b));
        if (x != y) return Math.Sign(string.CompareOrdinal(x, y));
        return Math.Sign(string.CompareOrdinal(a, b));
    }

    /// <summary>A positive JSON number, or null.</summary>
    private static double? Positive(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) > 0 ? Js.NumberOf(n) : null;

    /// <summary>The id osu! gave the score: lazer's block first, since lazer writes the header's as 0.</summary>
    private static double? OnlineIdOf(ReplayScore score)
    {
        if (Positive(Js.Get(score.Extras, "online_id")) is { } lazer) return lazer;
        double legacy = score.OnlineScoreId ?? 0;
        return legacy > 0 ? legacy : null;
    }

    public static ReplayPlayer ReplayPlayer(ReplayScore score) =>
        new(score.Username, Positive(Js.Get(score.Extras, "user_id")), OnlineIdOf(score));

    /// <summary>Whether a replay that turned up at <paramref name="arrivedAt"/> was set moments before.</summary>
    public static bool SetJustNow(double playedAt, double arrivedAt) =>
        playedAt <= arrivedAt + ClockSlackMs && arrivedAt - playedAt <= JustSetMs;

    /// <summary>
    /// Whether osu! wrote this replay's file long after its play, so it was copied in. Not knowing is
    /// never later, and the replays this app builds say nothing by their file's time.
    /// </summary>
    public static bool WasWrittenLater(ReplayScore score, double? writtenAt)
    {
        if (writtenAt is null || score.Mcosu is not null || score.Built is not null) return false;
        return writtenAt.Value - score.PlayedAtMs > WrittenAsPlayedMs;
    }

    /// <summary>
    /// Is this play the profile's own? Null is not enough to say, which every caller takes as yours;
    /// only false is a refusal, on positive evidence that someone else set it.
    /// </summary>
    public static bool? OwnsPlay(PlayerIdentity identity, ReplayPlayer player, bool justSet = false, bool writtenLater = false)
    {
        if (!identity.Known) return null;
        var name = Js.Trim(player.Name);
        if (name == "" || Js.ToLower(name) == GuestName) return true;
        if (!player.Submitted && !writtenLater) return true;
        if (identity.UserId is not null && player.UserId is not null) return identity.UserId == player.UserId;
        if (justSet) return true;
        if (identity.Names.Count == 0) return null;
        return identity.Names.Contains(Js.ToLower(name));
    }

    /// <summary>
    /// Whether a stored score is certainly someone else's, for the one-off clean-up: only on a linked
    /// identity with osu!'s complete list of names, and never for a play osu! never accepted.
    /// </summary>
    public static bool CertainlySomeoneElse(PlayerIdentity identity, ReplayPlayer player)
    {
        if (identity.Source != "linked" || !identity.NamesComplete) return false;
        if (!player.Submitted) return false;
        if (identity.UserId is not null && player.UserId is not null) return identity.UserId != player.UserId;
        return OwnsPlay(identity, player) == false;
    }

    /// <summary>
    /// Take the plays somebody else set out of a profile that already has them, once, as hides that
    /// can be undone. Only ever against a linked identity; rows from before names were recorded are
    /// read from their replay, and the name written back.
    /// </summary>
    public static async Task<ForeignScoreSweep> SweepForeignScores(Database db, long profileId, PlayerIdentity identity,
        Func<string, Task<ReplayPlayer?>> parseReplayFile)
    {
        if (identity.Source != "linked") return new ForeignScoreSweep(0, 0, [], 0);
        var rows = db.Rows("""
            SELECT id, player_name, player_id, online_score_id, replay_path
              FROM scores
             WHERE profile_id = ? AND hidden_at IS NULL AND imported_at IS NULL
            """, profileId);
        int checkedRows = 0, hidden = 0, unattributable = 0;
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        var order = new List<string>();
        var now = Js.Now();

        foreach (var row in rows)
        {
            checkedRows++;
            // `Number(row.online_score_id ?? 0)`: written as text, though an old row may hold a number.
            var storedId = row["online_score_id"] switch
            {
                null => 0,
                string s => Js.StringToNumber(s),
                long l => l,
                double d => d,
                _ => double.NaN,
            };
            ReplayPlayer? player = row.Str("player_name") is not { } storedName
                ? null
                : new ReplayPlayer(storedName, row.Num("player_id"), double.IsFinite(storedId) && storedId > 0 ? storedId : null);
            if (player is null && row.Str("replay_path") is { } replayPath)
            {
                player = await parseReplayFile(replayPath);
                if (player is not null) db.Run("UPDATE scores SET player_name = ?, player_id = ? WHERE id = ?", player.Name, player.UserId, row["id"]);
            }
            if (player is null)
            {
                unattributable++;
                continue;
            }
            if (!CertainlySomeoneElse(identity, player)) continue;
            db.Run("UPDATE scores SET hidden_at = ?, pinned_at = NULL, pin_order = NULL WHERE id = ?", now, row["id"]);
            hidden++;
            var name = Js.Trim(player.Name) is { Length: > 0 } n ? n : "(no name)";
            if (!counts.ContainsKey(name)) order.Add(name);
            counts[name] = counts.GetValueOrDefault(name) + 1;
        }

        var byPlayer = order.Select(n => (n, counts[n]))
            .OrderByDescending(p => p.Item2)
            .ThenBy(p => p.n, Comparer<string>.Create(CompareNames))
            .ToList();
        return new ForeignScoreSweep(checkedRows, hidden, byPlayer, unattributable);
    }
}
